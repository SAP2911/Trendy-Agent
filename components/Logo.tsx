/**
 * A small monogram mark — a rounded tag with a serif "T" — used in the
 * chat header and reused as the basis for the generated favicon/OG imagery
 * (see app/icon.png's generator script and app/opengraph-image.tsx) so the
 * mark is consistent everywhere it appears, not just here.
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="Trendly"
    >
      <rect x="1" y="1" width="30" height="30" rx="9" style={{ fill: 'var(--accent)' }} />
      <path
        d="M9.5 11.5h13M16 11.5v10.5"
        style={{ stroke: 'var(--accent-contrast)' }}
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
