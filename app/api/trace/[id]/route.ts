import { NextResponse } from 'next/server';
import { getTraceByCorrelationId, getTraceByConversationId } from '@/lib/obs/trace-store';

export const runtime = 'nodejs';

/**
 * `id` is accepted as either a correlationId (one turn — what a user quotes
 * from a bug report) or a conversationId (every turn recorded so far for
 * that conversation, oldest first — what the chat UI already holds). The
 * two id spaces never collide in practice (correlationId is a UUID,
 * conversationId is UI-generated) so trying correlationId first and falling
 * back to conversationId is unambiguous.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  const byTurn = getTraceByCorrelationId(id);
  if (byTurn !== undefined) {
    return NextResponse.json({ id, events: byTurn });
  }

  const byConversation = getTraceByConversationId(id);
  if (byConversation.length > 0) {
    return NextResponse.json({ id, events: byConversation });
  }

  return NextResponse.json(
    { error: { code: 'TRACE_NOT_FOUND', message: `No trace found for id "${id}".` } },
    { status: 404 },
  );
}
