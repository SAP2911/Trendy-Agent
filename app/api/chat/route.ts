import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { runTurn } from '@/lib/agent/loop';
import { getProviderChain, type ProviderEntry } from '@/lib/agent/providers';
import { appendTraceEvent } from '@/lib/obs/trace-store';

// The loop reads trendly_policy.md / orders.json from disk and holds long-lived
// in-memory session/breaker state, so it cannot run on the Edge runtime.
export const runtime = 'nodejs';
// Verified Vercel Hobby ceiling for a Node.js function's execution time. A turn
// can involve several tool calls plus one repair pass, so this is generous
// headroom, not an expectation the loop will ever run that long.
export const maxDuration = 300;

const HistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const ChatRequestSchema = z.object({
  conversationId: z.string().min(1).max(200),
  message: z.string().min(1).max(4000),
  history: z.array(HistoryTurnSchema).max(50).optional(),
});

const encoder = new TextEncoder();

function sseLine(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json({ error: { code, message, ...extra } }, { status });
}

/**
 * Structured, non-PII server log line. Never includes the raw request body
 * (which may carry a customer email) — only ids and an error message.
 */
function logTurnFailure(correlationId: string, conversationId: string, error: unknown): void {
  console.error(JSON.stringify({
    msg: 'chat turn failed',
    correlationId,
    conversationId,
    error: error instanceof Error ? error.message : String(error),
  }));
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'INVALID_REQUEST', 'Request body failed validation.', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }

  const { conversationId, message, history } = parsed.data;
  const correlationId = randomUUID();

  // Resolved once, up front, outside the stream: a missing API key is a
  // configuration error the operator needs to see as a normal JSON response
  // with a real HTTP status — not buried inside an SSE stream that has
  // already committed to a 200 and text/event-stream headers.
  let chain: ProviderEntry[];
  try {
    chain = getProviderChain();
  } catch (error) {
    logTurnFailure(correlationId, conversationId, error);
    return jsonError(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'No LLM provider is configured on this server. Set GOOGLE_GENERATIVE_AI_API_KEY or '
        + 'GROQ_API_KEY in the environment and restart the server.',
      { correlationId },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const closeOnce = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the consumer disconnecting; nothing to do.
        }
      };
      request.signal.addEventListener('abort', closeOnce);

      // First event on the wire, always — so a user can quote correlationId
      // in a bug report even if the turn fails before any trace event fires.
      controller.enqueue(sseLine({ type: 'meta', correlationId, conversationId }));

      try {
        const turn = runTurn({
          conversationId,
          correlationId,
          message,
          ...(history !== undefined ? { history } : {}),
          providers: chain,
        });

        let step = await turn.next();
        while (!step.done) {
          const item = step.value;
          if (item.type !== 'text') {
            appendTraceEvent(conversationId, correlationId, item);
          }
          controller.enqueue(sseLine(item));
          step = await turn.next();
        }

        controller.enqueue(sseLine({ type: 'done', correlationId }));
      } catch (error) {
        logTurnFailure(correlationId, conversationId, error);
        controller.enqueue(sseLine({
          type: 'error',
          correlationId,
          message: 'The assistant hit an unexpected error and could not finish this reply. '
            + `Please try again — quote correlation id ${correlationId} if you report this.`,
        }));
      } finally {
        closeOnce();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disables response buffering on nginx-style proxies in front of Node,
      // which would otherwise hold the whole stream until it ends.
      'X-Accel-Buffering': 'no',
      'X-Correlation-Id': correlationId,
    },
  });
}
