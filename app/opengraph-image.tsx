import { ImageResponse } from 'next/og';

export const alt = 'Trendly Support Assistant — grounded agentic support';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#1c1917',
          padding: 72,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div
            style={{
              width: 56,
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#e7c8a0',
              color: '#1c1917',
              fontSize: 36,
              fontWeight: 700,
              borderRadius: 12,
            }}
          >
            T
          </div>
          <div style={{ color: '#a8a29e', fontSize: 28, letterSpacing: '0.18em' }}>
            TRENDLY
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ color: '#fafaf9', fontSize: 76, fontWeight: 700, lineHeight: 1.05 }}>
            Support Assistant
          </div>
          <div style={{ color: '#a8a29e', fontSize: 32, lineHeight: 1.35, maxWidth: 900 }}>
            Deterministic policy engine, real tool-calling, and a live reasoning
            trace — so every answer is grounded, not guessed.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 14 }}>
          {['Per-item eligibility', 'Cited policy clauses', 'Escalates cleanly'].map((tag) => (
            <div
              key={tag}
              style={{
                display: 'flex',
                border: '1px solid #44403c',
                color: '#d6d3d1',
                fontSize: 24,
                padding: '10px 22px',
                borderRadius: 999,
              }}
            >
              {tag}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
