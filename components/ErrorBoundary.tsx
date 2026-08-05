'use client';

import { Component, type ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';
import { AlertIcon } from './icons';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * A plain React error boundary, nested INSIDE app/(chat)/error.tsx's
 * route-segment boundary rather than replacing it. The two catch different
 * things: Next's error.tsx recovers a whole route segment (including
 * failures during the initial server render), while this one scopes the
 * blast radius to the chat widget itself, so a render-time bug in, say, a
 * malformed trace event does not take out the header or theme toggle
 * alongside it. Neither one catches errors thrown inside event handlers or
 * async work (fetch, the SSE reader) — those are caught locally in
 * Chat.tsx and shown as an inline banner instead, per React's own rules
 * for what error boundaries can and cannot see.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // Structured, correlation-free (there is no turn in progress at this
    // point) — a render crash, not a business-logic failure.
    console.error(JSON.stringify({ msg: 'chat UI render error', error: error.message }));
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={styles.wrap} role="alert">
        <AlertIcon width={28} height={28} />
        <h2>Something went wrong</h2>
        <p>
          The chat interface hit an unexpected error and could not continue.
          Reloading the page usually fixes this.
        </p>
        <button type="button" className={styles.retry} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
