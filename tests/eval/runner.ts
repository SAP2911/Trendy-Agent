#!/usr/bin/env tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGroq } from '@ai-sdk/groq';
import { runTurnCollected } from '@/lib/agent/loop';
import type { ProviderEntry } from '@/lib/agent/providers';
import { CircuitBreaker } from '@/lib/agent/breaker';
import { getSession, resetSessions } from '@/lib/agent/session';
import { resetStore } from '@/lib/data/store';
import type { TraceEvent } from '@/lib/obs/trace';
import {
  loadScenarios, CATEGORIES, type Scenario, type Turn,
} from './schema';
import {
  createCassetteModel, createReplayBaseModel, loadCassette, newCassette, saveCassette,
  type CassetteContext,
} from './cassette-model';

/**
 * The offline eval harness. Two modes:
 *
 *   npm run eval             -> REPLAY. Zero network calls, zero API keys
 *                                needed. Every scenario is scored against
 *                                its committed cassette in
 *                                tests/eval/cassettes/.
 *   npm run eval:record      -> RECORD (POSIX `TRENDLY_EVAL_MODE=record`,
 *   npm run eval -- --record    doesn't work in PowerShell, so `--record`
 *                                is the portable equivalent — either works).
 *                                Calls the real Groq model once per
 *                                interaction, persists the response, then
 *                                immediately re-scores everything from the
 *                                freshly-saved cassettes (itself a replay —
 *                                zero extra quota) so recording ends with a
 *                                real scorecard, not just a pile of JSON.
 *
 * Recording is intentionally conservative about quota: one provider (Groq
 * only — no Gemini calls at all), strictly sequential, a 3-second pause
 * before every turn, and a hard stop — not a retry — the moment any
 * provider failure (429 or otherwise) is observed. See recordAll() below.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');
const CASSETTES_DIR = path.join(__dirname, 'cassettes');

/**
 * Pinned to the same instant the unit test suite pins (vitest.config.ts)
 * and the date the fixed dataset was authored for. Every policy verdict is
 * a function of "today" (§1.5 business days, §2.1 calendar days), so the
 * clock MUST be identical at record time and at every future replay —
 * otherwise a request recorded today hashes differently from the "same"
 * request replayed next month, and every scenario fails as a cassette miss
 * for a reason that has nothing to do with the agent's behaviour.
 */
const EVAL_AS_OF = '2026-08-04T12:00:00Z';

/** Matches lib/agent/providers.ts's own default so eval and production agree on which model is graded. */
const EVAL_MODEL_ID = process.env.TRENDLY_PRIMARY_MODEL ?? 'openai/gpt-oss-120b';
const EVAL_PROVIDER_NAME = 'groq';

const RECORD_DELAY_MS = 3_000;

type HistoryEntry = { role: 'user' | 'assistant'; content: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ---- CLI -------------------------------------------------------------------

interface Cli { record: boolean; force: boolean; only: Set<string> | undefined }

function parseCli(argv: string[]): Cli {
  const record = argv.includes('--record') || process.env.TRENDLY_EVAL_MODE === 'record';
  const force = argv.includes('--force');
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const only = onlyArg
    ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean))
    : undefined;
  return { record, force, only };
}

// ---- Assertion evaluation ---------------------------------------------------

interface AssertionFailure { turnIndex: number; expectation: string; detail: string }

interface TurnResult {
  text: string; trace: TraceEvent[]; modelCalls: number; activeToolsFirstStep: string[];
}

function toolCallNames(trace: TraceEvent[]): Set<string> {
  const names = new Set<string>();
  for (const e of trace) if (e.type === 'tool_call') names.add(e.name);
  return names;
}

/** Every tool_result's own top-level code — see the scenario YAML comments on why this is top-level only, not deep-scanned. */
function topLevelResultCodes(trace: TraceEvent[]): Set<string> {
  const codes = new Set<string>();
  for (const e of trace) if (e.type === 'tool_result') codes.add(e.code);
  return codes;
}

/** Deep-collected by loop.ts's own citedFrom() before the trace event is built — see lib/agent/loop.ts. */
function citedClauseIds(trace: TraceEvent[]): Set<string> {
  const clauses = new Set<string>();
  for (const e of trace) {
    if (e.type === 'tool_result' && e.clauses) for (const c of e.clauses) clauses.add(c);
  }
  return clauses;
}

/** A cassette miss surfaces as an ordinary failover (see cassette-model.ts) — this recognises that specific case for a clearer report. */
function cassetteMissReasons(trace: TraceEvent[]): string[] {
  return trace
    .filter((e): e is Extract<TraceEvent, { type: 'failover' }> => e.type === 'failover')
    .map((e) => e.reason)
    .filter((reason) => reason.includes('EVAL CASSETTE MISS'));
}

function evaluateTurn(
  turnIndex: number, turn: Turn, result: TurnResult, sessionState: string,
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const fail = (expectation: string, detail: string): void => {
    failures.push({ turnIndex, expectation, detail });
  };

  const misses = cassetteMissReasons(result.trace);
  if (misses.length > 0) {
    fail('cassette', misses.join(' | '));
    return failures; // Every downstream assertion would just cascade-fail on the fallback apology text.
  }

  const calls = toolCallNames(result.trace);
  for (const expected of turn.expect.toolCalls ?? []) {
    if (!calls.has(expected)) {
      fail('toolCalls', `expected tool call "${expected}"; actual: [${[...calls].join(', ')}]`);
    }
  }

  const codes = topLevelResultCodes(result.trace);
  for (const expected of turn.expect.resultCodes ?? []) {
    if (!codes.has(expected)) {
      fail('resultCodes', `expected result code "${expected}"; actual: [${[...codes].join(', ')}]`);
    }
  }

  const clauses = citedClauseIds(result.trace);
  for (const expected of turn.expect.citedClauses ?? []) {
    if (!clauses.has(expected)) {
      fail(
        'citedClauses',
        `expected clause "${expected}" cited; actual: [${[...clauses].join(', ')}]; `
        + `reply: ${JSON.stringify(result.text)}`,
      );
    }
  }

  for (const pattern of turn.expect.forbidden ?? []) {
    const re = new RegExp(pattern, 'i');
    if (re.test(result.text)) {
      fail('forbidden', `forbidden pattern /${pattern}/i matched reply: ${JSON.stringify(result.text)}`);
    }
  }

  if (turn.expect.mustEscalate !== undefined) {
    const escalated = sessionState === 'ESCALATED';
    if (escalated !== turn.expect.mustEscalate) {
      fail(
        'mustEscalate',
        `expected mustEscalate=${turn.expect.mustEscalate}; actual session state="${sessionState}"`,
      );
    }
  }

  if (turn.expect.modelCalls !== undefined && result.modelCalls !== turn.expect.modelCalls) {
    fail('modelCalls', `expected exactly ${turn.expect.modelCalls} model call(s); actual: ${result.modelCalls}`);
  }

  for (const expected of turn.expect.activeToolsInclude ?? []) {
    if (!result.activeToolsFirstStep.includes(expected)) {
      fail(
        'activeToolsInclude',
        `expected "${expected}" visible on this turn's first step; `
        + `actual: [${result.activeToolsFirstStep.join(', ')}]`,
      );
    }
  }

  return failures;
}

// ---- Replay / scoring --------------------------------------------------

interface ScenarioOutcome {
  scenario: Scenario;
  status: 'pass' | 'fail';
  failures: AssertionFailure[];
  cassetteNote: string | undefined;
}

async function scoreScenario(scenario: Scenario): Promise<ScenarioOutcome> {
  resetSessions();
  resetStore();
  process.env.TRENDLY_AS_OF = EVAL_AS_OF;

  const existing = loadCassette(CASSETTES_DIR, scenario.id);
  const cassette = existing ?? newCassette(scenario.id, EVAL_MODEL_ID, EVAL_PROVIDER_NAME);
  let cassetteNote: string | undefined;
  if (!existing) {
    cassetteNote = 'no cassette on disk — this scenario has never been recorded';
  } else if (!existing.meta.complete) {
    cassetteNote = 'cassette present but INCOMPLETE — recording stopped before this scenario finished';
  }

  const baseModel = createReplayBaseModel(EVAL_MODEL_ID, EVAL_PROVIDER_NAME);
  const ctx: CassetteContext = {
    mode: 'replay', scenarioId: scenario.id, cassette, cursor: { i: 0 },
  };
  const model = createCassetteModel(baseModel, ctx);
  const providers: ProviderEntry[] = [
    { name: EVAL_PROVIDER_NAME, model, breaker: new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 }) },
  ];

  const conversationId = `eval-${scenario.id}`;
  let history: HistoryEntry[] = [];
  const failures: AssertionFailure[] = [];

  for (const [turnIndex, turn] of scenario.turns.entries()) {
    const correlationId = `${conversationId}-t${turnIndex}`;
    // Sequential by construction: each turn depends on the session state
    // (and history) the previous turn left behind.
    const result = await runTurnCollected({
      conversationId, correlationId, message: turn.message, history, providers,
    });
    const sessionState = getSession(conversationId, correlationId).state;
    failures.push(...evaluateTurn(turnIndex, turn, result, sessionState));
    history = [...history, { role: 'user', content: turn.message }, { role: 'assistant', content: result.text }];
  }

  return {
    scenario, status: failures.length === 0 ? 'pass' : 'fail', failures, cassetteNote,
  };
}

async function runScorecard(scenarios: Scenario[]): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of scenarios) {
    outcomes.push(await scoreScenario(scenario));
  }
  return outcomes;
}

function printScorecard(outcomes: ScenarioOutcome[]): void {
  const byCategory = new Map<string, ScenarioOutcome[]>();
  for (const outcome of outcomes) {
    const list = byCategory.get(outcome.scenario.category) ?? [];
    list.push(outcome);
    byCategory.set(outcome.scenario.category, list);
  }

  console.log('\n=== Trendly Eval Scorecard ===');
  let totalPass = 0;
  for (const category of CATEGORIES) {
    const list = byCategory.get(category) ?? [];
    if (list.length === 0) continue;
    const pass = list.filter((o) => o.status === 'pass').length;
    totalPass += pass;
    console.log(`\n${category} — ${pass}/${list.length}`);
    for (const outcome of list) {
      const mark = outcome.status === 'pass' ? 'PASS' : 'FAIL';
      const note = outcome.cassetteNote ? `  [${outcome.cassetteNote}]` : '';
      console.log(`  [${mark}] ${outcome.scenario.id}${note}`);
      for (const failure of outcome.failures) {
        console.log(`         turn ${failure.turnIndex + 1} :: ${failure.expectation} :: ${failure.detail}`);
      }
    }
  }
  console.log(`\nOVERALL: ${totalPass}/${outcomes.length} scenarios passed\n`);
}

// ---- Recording ---------------------------------------------------------

interface RecordOutcome {
  recorded: string[];
  skipped: string[];
  notAttempted: string[];
  stopReason: string | undefined;
}

/**
 * Records every targeted scenario NOT already fully recorded (unless
 * --force), strictly sequentially, pausing RECORD_DELAY_MS before every
 * turn. The instant any provider failure is observed (429 or otherwise —
 * see cassetteMissReasons/failover detection), recording stops entirely:
 * no retry, no continuing to the next scenario. Whatever was captured
 * before the stop is already on disk (cassette-model.ts persists after
 * every single interaction, not once at the end).
 */
async function recordAll(scenarios: Scenario[], force: boolean): Promise<RecordOutcome> {
  if (!process.env.GROQ_API_KEY) {
    throw new Error(
      'Recording needs GROQ_API_KEY set — this harness records against Groq only (see '
      + "runner.ts's EVAL_PROVIDER_NAME). Set it and re-run with --record.",
    );
  }
  const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
  const realModel = groq(EVAL_MODEL_ID);

  const outcome: RecordOutcome = {
    recorded: [], skipped: [], notAttempted: [], stopReason: undefined,
  };
  let stopped = false;

  for (const scenario of scenarios) {
    if (stopped) {
      outcome.notAttempted.push(scenario.id);
      continue;
    }

    const existing = loadCassette(CASSETTES_DIR, scenario.id);
    if (existing?.meta.complete && !force) {
      outcome.skipped.push(scenario.id);
      console.log(`[skip] ${scenario.id} already fully recorded (--force to re-record)`);
      continue;
    }

    console.log(`[record] ${scenario.id} (${scenario.turns.length} turn(s))`);
    resetSessions();
    resetStore();
    process.env.TRENDLY_AS_OF = EVAL_AS_OF;

    const cassette = newCassette(scenario.id, EVAL_MODEL_ID, EVAL_PROVIDER_NAME);
    const ctx: CassetteContext = {
      mode: 'record', scenarioId: scenario.id, cassetteDir: CASSETTES_DIR, cassette,
    };
    const model = createCassetteModel(realModel, ctx);
    const providers: ProviderEntry[] = [
      { name: EVAL_PROVIDER_NAME, model, breaker: new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 }) },
    ];

    const conversationId = scenario.id;
    let history: HistoryEntry[] = [];
    let turnFailureReason: string | undefined;

    for (const [turnIndex, turn] of scenario.turns.entries()) {
      const preview = turn.message.length > 60 ? `${turn.message.slice(0, 60)}…` : turn.message;
      console.log(`  turn ${turnIndex + 1}: "${preview}"`);
      // Deliberate: sequential, rate-limit-respecting per the recording
      // brief — never parallelised, never retried.
      await sleep(RECORD_DELAY_MS);
      const result = await runTurnCollected({
        conversationId, correlationId: `${conversationId}-record-t${turnIndex}`,
        message: turn.message, history, providers,
      });
      const failover = result.trace.find((e) => e.type === 'failover');
      if (failover) {
        turnFailureReason = `turn ${turnIndex + 1}: provider failure — ${failover.reason}`;
        console.error(`  [STOP] ${turnFailureReason}`);
        break;
      }
      const replyPreview = result.text.length > 80 ? `${result.text.slice(0, 80)}…` : result.text;
      console.log(`    modelCalls=${result.modelCalls} reply="${replyPreview}"`);
      history = [...history, { role: 'user', content: turn.message }, { role: 'assistant', content: result.text }];
    }

    cassette.meta.complete = turnFailureReason === undefined;
    cassette.meta.recordedAt = new Date().toISOString();
    saveCassette(CASSETTES_DIR, scenario.id, cassette);

    if (turnFailureReason) {
      stopped = true;
      outcome.stopReason = `${scenario.id} — ${turnFailureReason}`;
    } else {
      outcome.recorded.push(scenario.id);
      console.log(`  [done] ${scenario.id}: ${cassette.entries.length} interaction(s) captured`);
    }
  }

  return outcome;
}

function printRecordSummary(outcome: RecordOutcome): void {
  console.log('\n=== Recording summary ===');
  console.log(`recorded this run:  ${outcome.recorded.join(', ') || '(none)'}`);
  console.log(`skipped (complete):  ${outcome.skipped.join(', ') || '(none)'}`);
  if (outcome.stopReason) {
    console.log(`STOPPED EARLY:       ${outcome.stopReason}`);
    console.log(`not attempted:       ${outcome.notAttempted.join(', ') || '(none)'}`);
  }
}

// ---- Entry point ---------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const scenarios = loadScenarios(SCENARIOS_DIR);

  const targeted = cli.only ? scenarios.filter((s) => cli.only!.has(s.id)) : scenarios;
  if (cli.only) {
    const unknown = [...cli.only].filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length > 0) {
      console.error(`Unknown scenario id(s) in --only: ${unknown.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (cli.record) {
    const outcome = await recordAll(targeted, cli.force);
    printRecordSummary(outcome);
  }

  // Scoring always runs from whatever is on disk right now, over the full
  // scenario set (not just --only) so `npm run eval` after a targeted
  // re-record still reports on everything.
  const outcomes = await runScorecard(scenarios);
  printScorecard(outcomes);

  const recordingStoppedEarly = cli.record && outcomes.some((o) => o.cassetteNote?.includes('INCOMPLETE'));
  const allPassed = outcomes.every((o) => o.status === 'pass');
  process.exitCode = allPassed && !recordingStoppedEarly ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('\nEval runner crashed:', error);
  process.exitCode = 1;
});
