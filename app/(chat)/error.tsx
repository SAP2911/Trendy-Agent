'use client';

import { useEffect } from 'react';

/**
 * Next.js route-segment error boundary for the chat route. This is a
 * second, outer safety net alongside components/ErrorBoundary.tsx (see its
 * file header for the division of labour): this one also recovers from a
 * failure during the segment's own render/hydration, not only from errors
 * inside the Chat widget's subtree.
 */
export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(JSON.stringify({ msg: 'chat route error', error: error.message, digest: error.digest }));
  }, [error]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        height: '100dvh',
        textAlign: 'center',
        padding: 24,
        background: 'var(--bg)',
        color: 'var(--text)',
      }}
    >
      <h1 style={{ fontSize: '1.4rem' }}>Trendly Support Assistant hit a snag</h1>
      <p style={{ color: 'var(--text-muted)', maxWidth: '42ch' }}>
        Something went wrong loading the chat. This has been logged — try again.
      </p>
      <button
        type="button"
        onClick={reset}
        style={{
          marginTop: 8,
          padding: '10px 20px',
          borderRadius: 8,
          border: '1px solid var(--border-strong)',
          background: 'var(--surface-raised)',
          color: 'var(--text)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}
