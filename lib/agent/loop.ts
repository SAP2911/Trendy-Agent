import { streamText, isStepCount } from 'ai';
import { buildTools, TOOL_NAMES_ANONYMOUS } from '@/lib/tools';
import { escalateToHumanImpl } from '@/lib/tools/mutating';
import { screenInput } from '@/lib/guards/input';
import { validateOutput, type Violation } from '@/lib/guards/output';
import { createTicket } from '@/lib/data/store';
import { TraceCollector, type TraceEvent } from '@/lib/obs/trace';
import { buildInstructions } from './prompts';
import {
  getSession, escalateSession, type TrendlyContext,
} from './session';
import { getProviderChain, type ProviderEntry } from './providers';

/** One chunk of the final, guard-passed reply. Streamed only once it is safe to show. */
export interface TextChunk { type: 'text'; text: string }

export interface RunTurnInput {
  conversationId: string;
  correlationId: string;
  message: string;
  /** Prior turns in this conversation. Defaults to none (first turn). */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /**
   * Injection point for tests: defaults to getProviderChain() (the real
   * Google/Groq clients). Unit tests pass a stub chain built on
   * MockLanguageModelV4 so the whole loop — failover included — runs with
   * zero network calls.
   */
  providers?: ProviderEntry[];
}

/**
 * Bookkeeping returned as the generator's final value (not a yielded item —
 * see runTurnCollected below for why). Lets tests assert on internals
 * (how many times the model was actually called, what the very first step's
 * tool visibility was) without parsing the trace stream by hand.
 */
export interface RunTurnMeta {
  modelCalls: number;
  activeToolsFirstStep: string[];
}

const MAX_STEPS = 8;

const ALL_PROVIDERS_DOWN_MESSAGE =
  "I'm having trouble reaching our systems right now, so I don't want to guess at an "
  + "answer. I've flagged this conversation for a human agent, who will follow up "
  + 'shortly. Trendly support hours are 9:00 AM – 9:00 PM IST, seven days a week.';

const REPAIR_FAILED_MESSAGE =
  "I want to make sure I give you accurate information, and I'm not confident my last "
  + "answer was right. I've flagged this conversation for a human agent, who will follow "
  + 'up with the correct details. Trendly support hours are 9:00 AM – 9:00 PM IST, seven '
  + 'days a week.';

/**
 * Turns an input-guard refusal reason into the fixed customer-facing message.
 * These are the only two reasons screenInput() ever refuses on (see
 * lib/guards/input.ts) — PII and out-of-scope advice both have no legitimate
 * continuation, so the reply is a template, never model output.
 */
export function refusalFor(reasonCode: 'PII_IN_CHAT' | 'OUT_OF_SCOPE_ADVICE'): string {
  if (reasonCode === 'PII_IN_CHAT') {
    return "I can't collect card numbers, CVV, or bank account details in chat (§3.3) — "
      + "please don't share them here. A human agent will send you a secure link for "
      + "that. Is there anything else I can help with?";
  }
  return "I'm not able to give medical, legal, or financial advice (§7), but I can "
    + 'connect you with a human agent who can help. Is there anything else I can help '
    + 'with?';
}

/** Reads a `code` field off an unknown tool result; 'UNKNOWN' if there isn't one. */
export function codeOf(toolOutput: unknown): string {
  if (toolOutput !== null && typeof toolOutput === 'object' && 'code' in toolOutput) {
    const { code } = toolOutput as { code: unknown };
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

/**
 * Deep-collects every `clauses` array found anywhere in a set of tool
 * results, deduped. Tool results nest `clauses` at different depths
 * depending on which tool produced them — e.g. computeRefundTimelineImpl
 * puts it at the top level, checkReturnEligibilityImpl buries it inside
 * `eligibility.items[].clauses` — so this walks the whole structure rather
 * than reading one fixed path.
 */
export function citedFrom(toolResults: unknown[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (key === 'clauses' && Array.isArray(v)) {
        for (const c of v) if (typeof c === 'string') found.add(c);
      } else {
        visit(v);
      }
    }
  };
  for (const result of toolResults) visit(result);
  return [...found];
}

/**
 * The single point where a session's mutable identity fields are
 * resynchronised from the authoritative session store mid-turn.
 *
 * Why mutate in place instead of reassigning: buildTools(ctx) — built once,
 * below, before the model is ever called — closes over this exact `ctx`
 * object reference in every tool's `execute` function (see
 * lib/tools/impl.ts's authoriseOrder, which reads `ctx.verifiedCustomerId`
 * on every call). getSession() itself returns a fresh COPY on every call
 * (see lib/agent/session.ts), so if a tool call verifies the customer
 * mid-turn (verify_customer succeeds in step 1, and the model wants to call
 * lookup_order in step 2 of the SAME streamText call), the persisted session
 * store updates but a plain `ctx = getSession(...)` reassignment would not
 * — the tool closures built in step 1 would keep reading the pre-turn
 * snapshot forever. Copying the fresh values ONTO the existing object
 * (same reference, mutated fields) means every closure that already
 * captured `ctx` sees the update on its next property read, because JS
 * closures capture the object reference, not a value snapshot.
 */
function refreshCtx(ctx: TrendlyContext): TrendlyContext {
  const fresh = getSession(ctx.conversationId, ctx.correlationId);
  ctx.state = fresh.state;
  ctx.verifiedCustomerId = fresh.verifiedCustomerId;
  return ctx;
}

/**
 * Trusted, non-model-facing escalation for a system-level failure (every
 * provider in the chain failed or was breaker-open). This calls
 * createTicket/escalateSession directly rather than going through the
 * escalate_to_human TOOL (lib/tools/mutating.ts's escalateToHumanImpl),
 * because that tool's reasonCode allowlist exists specifically to stop the
 * MODEL from inventing a reason — it was never meant to constrain the
 * loop's own fallback path, which has a perfectly honest reason that just
 * isn't one of the codes a model should ever supply ("the LLM providers are
 * down" is not a thing the assistant should be able to claim about itself
 * mid-conversation).
 */
function escalateSystemFailure(ctx: TrendlyContext, situation: string): string {
  const { ticketId } = createTicket({
    reasonCode: 'PROVIDER_UNAVAILABLE',
    conversationId: ctx.conversationId,
    correlationId: ctx.correlationId,
    customerId: ctx.verifiedCustomerId,
    orderIds: [],
    situation,
    attempted: [],
    policyRefs: [],
    suggestedResolution: 'Retry once a provider recovers, or have a human agent take the '
      + 'conversation over directly.',
  });
  escalateSession(ctx.conversationId);
  return ticketId;
}

/** Every real Trendly order id looks like TR-4530; used to find ids worth citing on a ticket. */
function orderIdsMentioned(toolResults: unknown[]): string[] {
  return [...new Set(JSON.stringify(toolResults).match(/\bTR-\d{4}\b/g) ?? [])];
}

/**
 * The repair loop: ONE constrained regeneration, then a safe template.
 *
 * `text` and `violations` are the just-rejected reply and why it was
 * rejected. The retry gets those violations appended to its instructions
 * and the already-gathered tool results as its only grounding — it is not
 * given tools, so it cannot go fetch new information, only rephrase
 * honestly from what this turn already has.
 *
 * If the retry ALSO fails validation (or every provider fails during the
 * retry itself), this returns the deterministic REPAIR_FAILED_MESSAGE and
 * hands off to a human via the escalate_to_human tool with reasonCode
 * VALIDATOR_REPAIR_FAILED — a known-defective message must never reach the
 * customer, so there is no third attempt, only a safe fallback.
 */
export async function repairOnce(
  text: string,
  violations: Violation[],
  ctx: TrendlyContext,
  toolResults: unknown[],
  trace: TraceCollector,
  chain: ProviderEntry[] = getProviderChain(),
  userMessage?: string,
): Promise<string> {
  const violationList = violations.map((v) => `- ${v.kind}: ${v.detail}`).join('\n');
  const repairInstructions = `${buildInstructions(ctx)}

REPAIR REQUIRED
Your previous reply was rejected for these violations and MUST NOT repeat them:
${violationList}

Rewrite the reply so every violation above is fixed. Use ONLY the tool results listed
below — do not invent any fact, number, date, or clause id that is not in them. Do not
call any tools; just produce the corrected reply text.

PREVIOUS (REJECTED) REPLY:
"""
${text}
"""

TOOL RESULTS AVAILABLE THIS TURN:
${JSON.stringify(toolResults)}`;

  let repaired = '';
  for (const provider of chain) {
    if (!provider.breaker.canAttempt()) continue;
    try {
      // Providers are tried in strict failover order (not parallel), so an
      // await inside this loop is intentional, not an accidental serialisation.
      const result = streamText({
        model: provider.model,
        instructions: repairInstructions,
        messages: [{ role: 'user', content: 'Provide the corrected reply now.' }],
        stopWhen: isStepCount(1),
      });
      // Manual accumulation (not result.text) so a provider-level error part
      // on the stream — see the identical comment in the main loop above —
      // surfaces with its real message instead of a generic "no output"
      // error once the failed stream is fully drained.
      let attempt = '';
      for await (const chunk of result.stream) {
        if (chunk.type === 'text-delta') attempt += chunk.text;
        if (chunk.type === 'error') {
          throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
        }
      }
      repaired = attempt;
      provider.breaker.recordSuccess();
      break;
    } catch (error) {
      provider.breaker.recordFailure();
      trace.emit({
        type: 'failover', from: provider.name, to: 'next',
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  const evidence = {
    toolResults,
    citedClauses: citedFrom(toolResults),
    verifiedCustomerId: ctx.verifiedCustomerId,
    // Spread conditionally: `exactOptionalPropertyTypes` distinguishes an
    // absent optional property from one explicitly set to undefined.
    ...(userMessage === undefined ? {} : { userMessage }),
  };
  const revalidation = repaired
    ? validateOutput(repaired, evidence)
    : { verdict: 'violation' as const, violations: [] as Violation[] };

  trace.emit({
    type: 'validator', name: 'output-repair',
    verdict: revalidation.verdict === 'pass' ? 'pass' : 'fail',
  });

  if (revalidation.verdict === 'pass') return repaired;

  const attempted = trace.events()
    .filter((e): e is Extract<TraceEvent, { type: 'tool_call' }> => e.type === 'tool_call')
    .map((e) => e.name);

  const escalation = escalateToHumanImpl({
    reasonCode: 'VALIDATOR_REPAIR_FAILED',
    situation: 'The assistant\'s reply failed output validation twice in a row '
      + `(first: ${violations.map((v) => v.kind).join(', ') || 'none'}; `
      + `retry: ${revalidation.violations.map((v) => v.kind).join(', ') || 'no reply produced'}). `
      + 'The defective reply was withheld from the customer.',
    suggestedResolution: 'Review the conversation and the tool results already gathered '
      + 'this turn, then answer the customer directly.',
    orderIds: orderIdsMentioned(toolResults),
    attempted,
    policyRefs: [],
  }, ctx);

  if (escalation.code === 'ESCALATED') {
    trace.emit({
      type: 'escalation', reasonCode: 'VALIDATOR_REPAIR_FAILED', ticketId: escalation.ticketId,
    });
  }

  return REPAIR_FAILED_MESSAGE;
}

/**
 * Runs one conversational turn end to end. Each numbered stage below is a
 * literal section of this function, in order, matching the six-stage design
 * (input guards -> plan -> authorize -> execute -> output guards -> repair)
 * — nothing here is spread across helper files where it can't be read in
 * one pass.
 *
 * Yields TraceEvents as they happen (so a live UI can show orchestration in
 * progress) and exactly one TextChunk at the very end, once the reply has
 * passed the output guard (or been replaced by a safe template). The
 * generator's own RETURN value (distinct from what it yields — see
 * runTurnCollected) carries bookkeeping that only tests need: how many
 * times a model was actually called, and what tools were visible on the
 * very first step.
 */
export async function* runTurn(
  input: RunTurnInput,
): AsyncGenerator<TraceEvent | TextChunk, RunTurnMeta, void> {
  const trace = new TraceCollector(input.correlationId);
  const history = input.history ?? [];
  let modelCalls = 0;
  let activeToolsFirstStep: string[] | undefined;

  // ---- 1. INPUT GUARDS — may short-circuit before any model call at all. ----
  const screen = screenInput(input.message);
  trace.emit({
    type: 'guard',
    name: 'input',
    verdict: screen.action === 'refuse' ? 'block' : 'pass',
    ...(screen.reasonCode ? { detail: screen.reasonCode } : {}),
  });
  if (screen.action === 'refuse') {
    yield* trace.drain();
    // screenInput() sets reasonCode on every 'refuse' branch and only on those
    // branches (lib/guards/input.ts) — structurally guaranteed non-null here.
    yield { type: 'text', text: refusalFor(screen.reasonCode!) };
    return { modelCalls: 0, activeToolsFirstStep: [] };
  }

  const ctx = getSession(input.conversationId, input.correlationId);
  // Built once per turn; tool closures read `ctx` live on every call (see
  // refreshCtx above), so this single ToolSet instance stays correct across
  // every step of every provider attempt below.
  const tools = buildTools(ctx);
  const chain = input.providers ?? getProviderChain();

  const toolResults: unknown[] = [];
  let text = '';
  let succeeded = false;

  // ---- 2-4. PLAN / AUTHORIZE / EXECUTE, trying each provider in order. ----
  for (let i = 0; i < chain.length; i += 1) {
    const provider = chain[i]!;
    const nextName = chain[i + 1]?.name ?? 'none (chain exhausted)';

    if (!provider.breaker.canAttempt()) {
      trace.emit({ type: 'failover', from: provider.name, to: nextName, reason: 'breaker-open' });
      yield* trace.drain();
      continue;
    }

    const startedAt = Date.now();
    try {
      modelCalls += 1;
      const result = streamText({
        model: provider.model,
        instructions: buildInstructions(ctx),
        messages: [...history, { role: 'user' as const, content: screen.redacted }],
        tools,
        stopWhen: isStepCount(MAX_STEPS),
        // A snapshot copy, not the live `ctx` reference: this is exposed to
        // SDK-level hooks (telemetry, prepareStep's own `runtimeContext`
        // param) as read-only situational context. It is NOT how identity
        // authorization actually happens — the tools in lib/tools/index.ts
        // don't read the AI SDK's runtimeContext at all; they close over
        // `ctx` directly (see refreshCtx's comment above for how that stays
        // live across steps). Passing a copy here keeps that one real
        // mechanism honest: nothing downstream can mistake this field for
        // a second, competing source of truth.
        runtimeContext: { ...ctx },
        // Identity gating, layer 1: while the session is not VERIFIED, the
        // model cannot even see the order tools in its schema. Re-reads the
        // session on every step (not a value closed over once) because a
        // tool called earlier in this same turn may have just verified the
        // customer — see refreshCtx's comment for how that propagates to
        // the tools themselves too.
        prepareStep: () => {
          const live = refreshCtx(ctx);
          const restricted = live.state !== 'VERIFIED';
          if (activeToolsFirstStep === undefined) {
            activeToolsFirstStep = restricted
              ? [...TOOL_NAMES_ANONYMOUS]
              : Object.keys(tools);
          }
          return restricted ? { activeTools: [...TOOL_NAMES_ANONYMOUS] } : {};
        },
        onToolExecutionEnd: (event) => {
          const output = event.toolOutput.type === 'tool-result'
            ? event.toolOutput.output
            : { error: String(event.toolOutput.error) };
          toolResults.push(output);
          const clauses = citedFrom([output]);
          trace.emit({
            type: 'tool_result',
            name: event.toolCall.toolName,
            code: codeOf(output),
            ...(clauses.length ? { clauses } : {}),
          });
        },
      });

      for await (const chunk of result.stream) {
        if (chunk.type === 'tool-call') {
          trace.emit({ type: 'tool_call', name: chunk.toolName, args: chunk.input });
        }
        // By default the AI SDK does NOT throw on a provider-level failure
        // (a rejected doStream, a 429, a network error) — it reports it as
        // an 'error' part on the stream instead, so a Server Action doesn't
        // crash mid-response. Re-throwing here funnels it into the same
        // catch block below as any other failure, so a dead provider always
        // gets a failover trace event with the REAL reason, not a generic
        // "no output generated" message from the empty stream that follows.
        if (chunk.type === 'error') {
          throw chunk.error instanceof Error ? chunk.error : new Error(String(chunk.error));
        }
        yield* trace.drain();
      }

      text = await result.text;
      provider.breaker.recordSuccess();
      trace.emit({
        type: 'plan', model: provider.name, provider: provider.name,
        latencyMs: Date.now() - startedAt,
      });
      yield* trace.drain();
      succeeded = true;
      break;
    } catch (error) {
      provider.breaker.recordFailure();
      trace.emit({
        type: 'failover',
        from: provider.name,
        to: nextName,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
      yield* trace.drain();
    }
  }

  const meta: RunTurnMeta = { modelCalls, activeToolsFirstStep: activeToolsFirstStep ?? [] };

  if (!succeeded || text.trim() === '') {
    const ticketId = escalateSystemFailure(
      ctx,
      'All configured LLM providers failed or were unavailable this turn; the customer '
        + 'received a deterministic apology instead of a model-generated reply.',
    );
    trace.emit({ type: 'escalation', reasonCode: 'PROVIDER_UNAVAILABLE', ticketId });
    yield* trace.drain();
    yield { type: 'text', text: ALL_PROVIDERS_DOWN_MESSAGE };
    return meta;
  }

  // ---- 5. OUTPUT GUARDS — the last gate before a reply reaches the customer. ----
  const evidence = {
    toolResults,
    citedClauses: citedFrom(toolResults),
    verifiedCustomerId: ctx.verifiedCustomerId,
    userMessage: screen.redacted,
  };
  const validation = validateOutput(text, evidence);
  trace.emit({
    type: 'validator', name: 'output',
    verdict: validation.verdict === 'pass' ? 'pass' : 'repair',
  });
  yield* trace.drain();

  // ---- 6. REPAIR — one constrained retry; a defective reply is never emitted. ----
  if (validation.verdict === 'violation') {
    text = await repairOnce(
      text, validation.violations, ctx, toolResults, trace, chain, screen.redacted,
    );
    yield* trace.drain();
  }

  yield { type: 'text', text };
  return meta;
}

/**
 * Drains runTurn's async generator to completion for callers (mainly
 * tests) that want one Promise instead of a stream: the concatenated final
 * text, every trace event in order, and the two pieces of internal
 * bookkeeping (modelCalls, activeToolsFirstStep) carried on the
 * generator's own return value rather than yielded as items — see
 * RunTurnMeta's doc comment for why.
 */
export async function runTurnCollected(input: RunTurnInput): Promise<{
  text: string;
  trace: TraceEvent[];
  modelCalls: number;
  activeToolsFirstStep: string[];
}> {
  const gen = runTurn(input);
  const trace: TraceEvent[] = [];
  let text = '';

  let step = await gen.next();
  while (!step.done) {
    const item = step.value;
    if (item.type === 'text') text += item.text;
    else trace.push(item);
    step = await gen.next();
  }

  return {
    text, trace, modelCalls: step.value.modelCalls, activeToolsFirstStep: step.value.activeToolsFirstStep,
  };
}
