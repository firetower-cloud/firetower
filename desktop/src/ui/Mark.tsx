/**
 * The product's own glyph: the lookout tower — legs, cabin, roof, and the
 * light that is lit. The one place ember is a fill rather than a signal.
 */
export function Mark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M4.4 19L7 9.6M15.6 19L13 9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.1 14.4h7.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity=".55" />
      <path d="M6.4 9.4h7.2v-3H6.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M4.8 6.4L10 2.2l5.2 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="7.9" r="1.15" fill="var(--color-ember)" />
    </svg>
  );
}
