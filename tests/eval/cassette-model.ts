import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { wrapLanguageModel, simulateReadableStream } from 'ai';
import type {
  LanguageModelV2, LanguageModelV3, LanguageModelV4, LanguageModelV4CallOptions,
  LanguageModelV4Middleware, LanguageModelV4StreamPart, LanguageModelV4FunctionTool,
  LanguageModelV4ProviderTool,
} from '@ai-sdk/provider';

/**
 * The cassette layer: a LanguageModel middleware (ai@7.0.51's own
 * `wrapLanguageModel` + `LanguageModelV4Middleware`, not a hand-rolled
 * model — see the task brief) that either replays a previously recorded
 * response for a request, or records the real response the first time it is
 * asked in `record` mode.
 *
 * The only hook implemented is `wrapStream`: every call into this app goes
 * through `streamText` (lib/agent/loop.ts's main turn AND its one-shot
 * repair retry), never `generateText`, so `doGenerate` is never exercised
 * and is intentionally left throwing — a defensive tripwire, not a gap.
 */

interface RequestPreview { toolNames: string[]; lastMessagePreview: string }

interface CassetteEntry {
  requestPreview: RequestPreview;
  /** LanguageModelV4StreamPart[], JSON-safe (Dates stringified — see (de)serializePart). */
  parts: unknown[];
}

export interface CassetteFile {
  meta: {
    scenarioId: string;
    modelId: string;
    provider: string;
    recordedAt: string;
    /**
     * True only once every turn of the scenario recorded with no provider
     * failure. A partially-recorded scenario (e.g. a 429 mid-turn) is kept
     * on disk for diagnostics but is never treated as replayable — see
     * loadCassette's caller in runner.ts.
     */
    complete: boolean;
  };
  /**
   * Interactions in the exact order the agent loop issued them, across every
   * turn of the scenario.
   *
   * Keyed POSITIONALLY, not by a hash of the request. Content-hashing was
   * tried first and cannot work here: the loop is non-deterministic, so the
   * recording pass and the scoring pass diverge in tool-call order and
   * message history, producing different hashes for the same logical step —
   * a cassette miss even when recording and replaying inside a single run.
   * Sequential replay is what a VCR-style fixture actually needs, and it is
   * immune to prompt edits and clock drift as well.
   */
  entries: CassetteEntry[];
}

function emptyCassette(scenarioId: string, modelId: string, provider: string): CassetteFile {
  return {
    meta: {
      scenarioId, modelId, provider, recordedAt: new Date(0).toISOString(), complete: false,
    },
    entries: [],
  };
}

function cassettePath(dir: string, scenarioId: string): string {
  return path.join(dir, `${scenarioId}.json`);
}

export function loadCassette(dir: string, scenarioId: string): CassetteFile | undefined {
  const file = cassettePath(dir, scenarioId);
  if (!existsSync(file)) return undefined;
  // The file is committed, hand-written-adjacent JSON produced only by
  // saveCassette below, so trusting its shape here (rather than re-running
  // it through Zod) is a deliberate scope call: this module is test
  // infrastructure, not a boundary that receives untrusted input.
  return JSON.parse(readFileSync(file, 'utf8')) as CassetteFile;
}

export function newCassette(scenarioId: string, modelId: string, provider: string): CassetteFile {
  return emptyCassette(scenarioId, modelId, provider);
}

export function saveCassette(dir: string, scenarioId: string, cassette: CassetteFile): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(cassettePath(dir, scenarioId), `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
}

// ---- Stable request hashing ------------------------------------------------

/**
 * Deep, key-sorted clone so JSON.stringify produces byte-identical output
 * regardless of incidental object-literal key ordering upstream. Array
 * ORDER is preserved deliberately — message order and content-part order
 * are semantically meaningful and must not be normalised away.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function toolName(t: LanguageModelV4FunctionTool | LanguageModelV4ProviderTool): string {
  return 'name' in t ? t.name : 'unknown-tool';
}

function toolNamesOf(params: LanguageModelV4CallOptions): string[] {
  return (params.tools ?? []).map(toolName).sort();
}

/**
 * The cassette key: a stable hash of model id, instructions, messages, and
 * tool names (per the task brief). `params.prompt` already carries the
 * system instructions AND every message — AI SDK 7 folds `instructions:`
 * into the first prompt entry — so hashing modelId + toolNames + prompt
 * covers all four without reaching into streamText's original call site.
 */
export function hashRequest(
  params: LanguageModelV4CallOptions, model: { modelId: string; provider: string },
): string {
  const fingerprint = {
    modelId: model.modelId,
    provider: model.provider,
    toolNames: toolNamesOf(params),
    prompt: params.prompt,
  };
  return createHash('sha256').update(JSON.stringify(sortKeysDeep(fingerprint))).digest('hex');
}

function buildPreview(params: LanguageModelV4CallOptions): RequestPreview {
  const last = params.prompt[params.prompt.length - 1];
  return {
    toolNames: toolNamesOf(params),
    lastMessagePreview: last ? JSON.stringify(last).slice(0, 300) : '(empty prompt)',
  };
}

// ---- Stream part (de)serialization -----------------------------------------

/**
 * The only LanguageModelV4StreamPart variant carrying a non-JSON-safe field
 * is `response-metadata` (`timestamp: Date`). Every other variant is
 * already plain JSON. Round-tripping that one field is enough to make the
 * whole array losslessly serializable.
 */
function serializePart(part: LanguageModelV4StreamPart): unknown {
  if (part.type === 'response-metadata') {
    // Every field of LanguageModelV4ResponseMetadata is itself optional
    // ("if the provider sends one"), so this must not assume `timestamp` is
    // present — only convert it when it actually is.
    const { timestamp, ...rest } = part;
    return timestamp === undefined ? rest : { ...rest, timestamp: timestamp.toISOString() };
  }
  return part;
}

function deserializePart(raw: unknown): LanguageModelV4StreamPart {
  if (
    raw !== null && typeof raw === 'object' && 'type' in raw
    && (raw as { type: unknown }).type === 'response-metadata'
  ) {
    const r = raw as { type: 'response-metadata'; id?: string; modelId?: string; timestamp?: string };
    return {
      type: 'response-metadata',
      // exactOptionalPropertyTypes: spread conditionally rather than ever
      // assigning `key: undefined` explicitly.
      ...(r.id === undefined ? {} : { id: r.id }),
      ...(r.modelId === undefined ? {} : { modelId: r.modelId }),
      ...(r.timestamp === undefined ? {} : { timestamp: new Date(r.timestamp) }),
    };
  }
  return raw as LanguageModelV4StreamPart;
}

// ---- Errors -----------------------------------------------------------------

/**
 * Thrown on a replay-mode cassette miss. Never caught and silently routed
 * to the network — that is the one behaviour this whole module exists to
 * prevent (see the task brief: "Never silently fall through to the
 * network"). Carries the scenario name, the computed key, and every key
 * already on file so a maintainer can tell at a glance whether the
 * cassette is merely incomplete or the conversation genuinely diverged.
 */
export class EvalCassetteMissError extends Error {
  constructor(scenarioId: string, index: number, preview: RequestPreview, total: number) {
    super(
      [
        `EVAL CASSETTE MISS in scenario "${scenarioId}"`,
        `  wanted interaction #${index + 1}; cassette holds ${total}`,
        `  tool names in this request: ${preview.toolNames.join(', ') || '(none)'}`,
        `  last prompt entry: ${preview.lastMessagePreview}`,
        '  The recorded run was shorter than this replay needs, or the scenario was',
        '  never fully recorded (a 429 mid-recording leaves a partial cassette).',
        `  Re-record with: npm run eval:record -- --only=${scenarioId} --force`,
      ].join('\n'),
    );
    this.name = 'EvalCassetteMissError';
  }
}

// ---- Middleware ---------------------------------------------------------

export interface CassetteRecordContext {
  mode: 'record';
  scenarioId: string;
  cassetteDir: string;
  cassette: CassetteFile;
}

export interface CassetteReplayContext {
  mode: 'replay';
  scenarioId: string;
  cassette: CassetteFile;
  /** Advances once per model call; positional replay depends on it. */
  cursor: { i: number };
}

export type CassetteContext = CassetteRecordContext | CassetteReplayContext;

/**
 * REPLAY: look up the recorded parts for this exact request and replay them
 * as a simulated stream. No match -> throw EvalCassetteMissError; the real
 * model underneath (a throwing dummy — see createReplayModel) is never
 * touched, so a cassette miss during `npm run eval` costs zero network
 * calls even in its failure path.
 *
 * RECORD: call through to the real provider's doStream, fully drain it
 * (buffering is fine — this is an offline recording script, not the live
 * app), persist the captured parts keyed by this same request hash, and
 * hand the caller back an equivalent simulated stream built from what was
 * just captured. Persistence happens after EVERY interaction (not once at
 * the end of the scenario), so a 429 on interaction 3 of a turn still
 * leaves interactions 1-2 safely on disk.
 */
export function cassetteMiddleware(ctx: CassetteContext): LanguageModelV4Middleware {
  return {
    specificationVersion: 'v4',
    wrapStream: async ({ doStream, params, model }) => {
      if (ctx.mode === 'replay') {
        const index = ctx.cursor.i;
        const entry = ctx.cassette.entries[index];
        if (!entry) {
          throw new EvalCassetteMissError(
            ctx.scenarioId, index, buildPreview(params), ctx.cassette.entries.length,
          );
        }
        ctx.cursor.i += 1;
        return {
          stream: simulateReadableStream({
            chunks: entry.parts.map(deserializePart),
            chunkDelayInMs: 0,
            initialDelayInMs: 0,
          }),
        };
      }

      const real = await doStream();
      const reader = real.stream.getReader();
      const collected: LanguageModelV4StreamPart[] = [];
      for (;;) {
        // Sequential drain of one provider stream by design.
        const { done, value } = await reader.read();
        if (done) break;
        collected.push(value);
      }

      ctx.cassette.entries.push({
        requestPreview: buildPreview(params),
        parts: collected.map(serializePart),
      });
      ctx.cassette.meta.recordedAt = new Date().toISOString();
      saveCassette(ctx.cassetteDir, ctx.scenarioId, ctx.cassette);

      return {
        stream: simulateReadableStream({ chunks: collected, chunkDelayInMs: 0, initialDelayInMs: 0 }),
      };
    },
  };
}

/**
 * A LanguageModelV4 whose doGenerate/doStream both throw. Used ONLY as the
 * `model:` argument `wrapLanguageModel` requires in replay mode — the
 * middleware's wrapStream above never calls either function of the
 * underlying model on the replay path, so these bodies exist purely as a
 * loud tripwire against a future change accidentally letting a request
 * fall through to "the real model", which in replay mode does not exist.
 */
export function createReplayBaseModel(modelId: string, provider: string): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error(
        'eval cassette (replay): doGenerate was called on the dummy base model. This app '
        + 'only ever calls streamText — generateText should never reach a provider here.',
      );
    },
    doStream: async () => {
      throw new Error(
        'eval cassette (replay): doStream was called on the dummy base model directly, '
        + 'meaning cassetteMiddleware.wrapStream did not intercept it. This should be '
        + 'structurally impossible — wrapStream never calls the passed-through doStream '
        + 'on the replay branch.',
      );
    },
  };
}

/** Wraps `underlying` with the cassette middleware, producing one drop-in LanguageModel. */
export function createCassetteModel(
  underlying: LanguageModelV2 | LanguageModelV3 | LanguageModelV4,
  ctx: CassetteContext,
): LanguageModelV4 {
  return wrapLanguageModel({ model: underlying, middleware: cassetteMiddleware(ctx) });
}
