'use client';

import {
  useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent,
} from 'react';
import type { TraceEvent } from '@/lib/obs/trace';
import styles from './Chat.module.css';
import { TracePanel } from './TracePanel';
import { ThemeToggle } from './ThemeToggle';
import { StarterPrompts } from './StarterPrompts';
import { Logo } from './Logo';
import { describeEvent } from './trace-format';
import {
  ActivityIcon, CloseIcon, SendIcon, AlertIcon, PlusIcon,
} from './icons';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

/** The shapes app/api/chat/route.ts can put on the wire, one per SSE `data:` line. */
type ChatSseEvent =
  | { type: 'meta'; correlationId: string; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'done'; correlationId: string }
  | { type: 'error'; correlationId: string; message: string }
  | TraceEvent;

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={styles.messageRow} data-role={message.role}>
      <div className={styles.bubble} data-role={message.role}>
        {message.content}
      </div>
    </div>
  );
}

function ThinkingBubble({ label }: { label: string }) {
  return (
    <div className={styles.messageRow} data-role="assistant">
      <div className={styles.bubble} data-role="assistant" data-thinking="true">
        <span className={styles.thinkingDots} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className={styles.thinkingLabel}>{label}</span>
      </div>
    </div>
  );
}

/** Splits a buffered SSE byte stream on blank lines, yielding parsed `data:` payloads. */
function extractSseEvents(buffer: string): { events: ChatSseEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events: ChatSseEvent[] = [];
  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith('data: ')) continue;
    events.push(JSON.parse(line.slice('data: '.length)) as ChatSseEvent);
  }
  return { events, rest };
}

export function Chat() {
  // Lazily initialised (not read from a prop, not derived from anything
  // server-rendered) so it is safe to compute during the very first render
  // wherever that happens to run — it is never displayed, so a value that
  // differs between an SSR pass and the client's hydration render (both
  // legitimately call this initialiser once) cannot cause a hydration
  // mismatch; only rendered output can do that.
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceDrawerOpen, setTraceDrawerOpen] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /**
   * Start a fresh conversation without reloading the page.
   *
   * A new `conversationId` is essential, not cosmetic: the server keys session
   * state — including the VERIFIED customer identity — on that id. Reusing it
   * would leave the previous customer verified, so the next person to type
   * would inherit their access. Minting a new id drops the session back to
   * ANONYMOUS, which is exactly what "new chat" has to mean here.
   */
  const startNewChat = useCallback(() => {
    if (busy) return;
    setConversationId(crypto.randomUUID());
    setMessages([]);
    setTrace([]);
    setCorrelationId(null);
    setError(null);
    setInput('');
    setTraceDrawerOpen(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    textareaRef.current?.focus();
  }, [busy]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || busy) return;

    setError(null);
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: text }]);
    setTrace([]);
    setBusy(true);

    let assistantId: string | null = null;
    let assistantText = '';

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, message: text, history }),
      });

      if (!res.ok || !res.body) {
        const payload = await res.json().catch(() => null) as
          { error?: { message?: string } } | null;
        throw new Error(payload?.error?.message ?? `Request failed with status ${res.status}.`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = extractSseEvents(buffer);
        buffer = rest;

        for (const evt of events) {
          switch (evt.type) {
            case 'meta':
              setCorrelationId(evt.correlationId);
              break;
            case 'text': {
              assistantText += evt.text;
              const content = assistantText;
              if (assistantId === null) {
                assistantId = crypto.randomUUID();
                const id = assistantId;
                setMessages((prev) => [...prev, { id, role: 'assistant', content }]);
              } else {
                const id = assistantId;
                setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)));
              }
              break;
            }
            case 'error':
              setError(evt.message);
              break;
            case 'done':
              break;
            default:
              setTrace((prev) => [...prev, evt]);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, conversationId, messages]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void send(input);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const autoGrow = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const showThinking = busy && messages[messages.length - 1]?.role !== 'assistant';
  const lastTraceEvent = trace[trace.length - 1];
  const thinkingLabel = lastTraceEvent ? describeEvent(lastTraceEvent) : 'Thinking…';

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        {/*
          The brand lock-up doubles as "start over" — the affordance people
          reach for first. It is a real <button>, not a clickable <div>, so it
          is keyboard-reachable and announced correctly by screen readers.
        */}
        <button
          type="button"
          className={styles.brand}
          onClick={startNewChat}
          disabled={busy}
          title="Start a new conversation"
          aria-label="Trendly Support Assistant — start a new conversation"
        >
          <Logo />
          <div className={styles.brandText}>
            <h1>Trendly</h1>
            <p>Support Assistant</p>
          </div>
        </button>
        <div className={styles.headerActions}>
          {messages.length > 0 && (
            <button
              type="button"
              className={styles.newChat}
              onClick={startNewChat}
              disabled={busy}
              aria-label="Start a new conversation"
            >
              <PlusIcon width={16} height={16} />
              New chat
            </button>
          )}
          <button
            type="button"
            className={styles.traceToggle}
            onClick={() => setTraceDrawerOpen(true)}
            aria-label="Open live reasoning trace"
          >
            <ActivityIcon width={16} height={16} />
            Trace
            {trace.length > 0 && <span className={styles.traceBadge}>{trace.length}</span>}
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.conversation}>
          <div className={styles.messageList} ref={listRef}>
            {messages.length === 0 && (
              <div className={styles.intro}>
                <h2>How can we help today?</h2>
                <p>
                  Ask about an order, a return, an exchange, or Trendly&rsquo;s shipping and
                  refund policy. I&rsquo;ll verify your identity first — have the email or
                  phone number on your order handy.
                </p>
                <StarterPrompts onPick={(p) => void send(p)} />
              </div>
            )}
            {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
            {showThinking && <ThinkingBubble label={thinkingLabel} />}
          </div>

          {error && (
            <div className={styles.errorBanner} role="alert">
              <AlertIcon width={16} height={16} />
              <span>{error}</span>
            </div>
          )}

          <form className={styles.composer} onSubmit={handleSubmit}>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              value={input}
              placeholder="Message Trendly support…"
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                autoGrow(e.target);
              }}
              onKeyDown={handleKeyDown}
            />
            <button
              type="submit"
              className={styles.sendButton}
              disabled={busy || !input.trim()}
              aria-label="Send message"
            >
              <SendIcon width={16} height={16} />
            </button>
          </form>
        </section>

        <aside className={styles.desktopTrace}>
          <TracePanel events={trace} streaming={busy} correlationId={correlationId} />
        </aside>
      </main>

      <div
        className={styles.drawerBackdrop}
        data-open={traceDrawerOpen ? 'true' : 'false'}
        onClick={() => setTraceDrawerOpen(false)}
        aria-hidden="true"
      />
      <div className={styles.drawer} data-open={traceDrawerOpen ? 'true' : 'false'}>
        <button
          type="button"
          className={styles.drawerClose}
          onClick={() => setTraceDrawerOpen(false)}
          aria-label="Close live reasoning trace"
        >
          <CloseIcon width={18} height={18} />
        </button>
        <TracePanel events={trace} streaming={busy} correlationId={correlationId} />
      </div>
    </div>
  );
}
