import { ImageResponse } from 'next/og';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
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
          fontSize: 112,
          fontWeight: 700,
          letterSpacing: '-0.05em',
        }}
      >
        T
      </div>
    ),
    size,
  );
}
