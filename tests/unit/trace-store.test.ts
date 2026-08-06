import {
  describe, it, expect, beforeEach,
} from 'vitest';
import type { TraceEvent } from '@/lib/obs/trace';
import {
  appendTraceEvent, getTraceByCorrelationId, getTraceByConversationId, resetTraceStore,
} from '@/lib/obs/trace-store';

function guardEvent(correlationId: string, seq: number): TraceEvent {
  return {
    type: 'guard', name: 'input', verdict: 'pass', correlationId, seq,
  };
}

beforeEach(() => {
  resetTraceStore();
});

describe('trace-store', () => {
  it('returns undefined for an unknown correlationId', () => {
    expect(getTraceByCorrelationId('nope')).toBeUndefined();
  });

  it('returns an empty array for an unknown conversationId', () => {
    expect(getTraceByConversationId('nope')).toEqual([]);
  });

  it('accumulates events for one correlationId in append order', () => {
    appendTraceEvent('conv-1', 'corr-1', guardEvent('corr-1', 0));
    appendTraceEvent('conv-1', 'corr-1', guardEvent('corr-1', 1));
    const events = getTraceByCorrelationId('corr-1');
    expect(events).toHaveLength(2);
    expect(events?.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('concatenates every turn for a conversation, grouped oldest-turn-first', () => {
    appendTraceEvent('conv-2', 'corr-a', guardEvent('corr-a', 0));
    appendTraceEvent('conv-2', 'corr-b', guardEvent('corr-b', 0));
    appendTraceEvent('conv-2', 'corr-a', guardEvent('corr-a', 1));
    const all = getTraceByConversationId('conv-2');
    // corr-a was the first turn seen for this conversation, so ALL of its
    // events come first, even though corr-b's single event was appended
    // in between them chronologically.
    expect(all.map((e) => e.correlationId)).toEqual(['corr-a', 'corr-a', 'corr-b']);
  });

  it('does not duplicate a correlationId in the conversation index across repeated turns', () => {
    appendTraceEvent('conv-3', 'corr-x', guardEvent('corr-x', 0));
    appendTraceEvent('conv-3', 'corr-x', guardEvent('corr-x', 1));
    appendTraceEvent('conv-3', 'corr-x', guardEvent('corr-x', 2));
    expect(getTraceByConversationId('conv-3')).toHaveLength(3);
  });

  it('keeps conversations independent', () => {
    appendTraceEvent('conv-4', 'corr-4', guardEvent('corr-4', 0));
    appendTraceEvent('conv-5', 'corr-5', guardEvent('corr-5', 0));
    expect(getTraceByConversationId('conv-4')).toHaveLength(1);
    expect(getTraceByConversationId('conv-5')).toHaveLength(1);
  });

  it('resetTraceStore clears both indices', () => {
    appendTraceEvent('conv-6', 'corr-6', guardEvent('corr-6', 0));
    resetTraceStore();
    expect(getTraceByCorrelationId('corr-6')).toBeUndefined();
    expect(getTraceByConversationId('conv-6')).toEqual([]);
  });
});
