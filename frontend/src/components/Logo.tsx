/** Shield + pulse line: protection + live monitoring. */
export function Logo({ size = 42, title = "SANJEEVNI" }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <path
        d="M32 4 8 13v17c0 15 10.3 26.6 24 30 13.7-3.4 24-15 24-30V13L32 4z"
        fill="rgba(255,255,255,.15)"
        stroke="#fff"
        strokeWidth="3"
      />
      <path
        d="M15 34h9l4-9 6 17 4-11 3 3h8"
        fill="none"
        stroke="#b9f6ca"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
