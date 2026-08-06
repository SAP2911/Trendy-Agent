import { ImageResponse } from 'next/og';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

/**
 * Favicon, generated at build time. Drawn programmatically rather than
 * committed as a binary so it stays in version control as readable source and
 * needs no network at build time — the deploy target has none.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#1c1917',
          color: '#e7c8a0',
          fontSize: 40,
          fontWeight: 700,
          letterSpacing: '-0.05em',
          borderRadius: 12,
        }}
      >
        T
      </div>
    ),
    size,
  );
}
