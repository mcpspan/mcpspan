/**
 * The mark: a model (the sparkle) and the calls it makes, measured (the spans).
 * Drawn inline, so it costs no request and is there before anything loads. The
 * same drawing is `app/icon.svg`, the browser tab's icon, and `docs/logo.svg`.
 */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className="shrink-0">
      <rect width="64" height="64" rx="14" fill="#23262b" />
      <path
        d="M17 23.5Q19.5 29.5 25.5 32Q19.5 34.5 17 40.5Q14.5 34.5 8.5 32Q14.5 29.5 17 23.5Z"
        fill="#fff"
        stroke="#fff"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <rect x="30" y="16" width="22" height="7" rx="3.5" fill="#8a9099" />
      <rect x="30" y="28.5" width="16" height="7" rx="3.5" fill="#2a78d6" />
      <rect x="30" y="41" width="26" height="7" rx="3.5" fill="#8a9099" />
    </svg>
  );
}
