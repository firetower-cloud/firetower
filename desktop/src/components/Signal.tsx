import type { SessionStatus } from "~/api/generated/model";
import { BEAT, BEAT_TONE } from "~/api/view";

/* One loud colour in the whole system: ember, and only for "an agent is
   blocked on you". Everything else recedes.

   Derived rather than written out, from the one table that says what a status
   means (`BEAT` in `view.ts`). It used to be a list of its own, and it was
   right — but being right separately from everything else is how the island
   came to paint a finished agent ember while this painted it sage. */
export const TONE: Record<SessionStatus, string> = Object.fromEntries(
  (Object.keys(BEAT) as SessionStatus[]).map((status) => [status, BEAT_TONE[BEAT[status]]]),
) as Record<SessionStatus, string>;

export function Signal({ status, size = 8 }: { status: SessionStatus; size?: number }) {
  const tone = TONE[status];
  const hollow = status === "Ended" || status === "Starting" || status === "Ready";

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${tone}`}
      style={{ width: size * 2.4, height: size * 2.4 }}
      aria-hidden
    >
      {status === "NeedsYou" && (
        <span
          className="ember-pulse absolute rounded-full bg-current"
          style={{ width: size, height: size }}
        />
      )}
      {status === "Failed" ? (
        <svg width={size + 2} height={size + 2} viewBox="0 0 10 10" fill="none">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      ) : status === "HandedBack" ? (
        <svg width={size + 3} height={size + 3} viewBox="0 0 11 11" fill="none">
          <path d="M1.5 5.8l2.6 2.6L9.5 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span
          className={`relative rounded-full ${hollow ? "border border-current" : "bg-current"} ${
            status === "Working" ? "breathe" : ""
          }`}
          style={{ width: size, height: size }}
        />
      )}
    </span>
  );
}

/* ⚿ has no glyph in most UI faces — draw the key. */
export function KeyGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      className="inline-block shrink-0 align-[-0.1em]"
      aria-hidden
    >
      <circle cx="4" cy="4" r="2.6" strokeWidth="1.3" />
      <path d="M5.9 5.9L10.4 10.4M8.6 8.6l-1.2 1.2M10.4 10.4l-1 1" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** The lookout tower: legs, cabin, and the light that's lit. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden>
      <path d="M4.4 19L7 9.6M15.6 19L13 9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.1 14.4h7.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity=".55" />
      <path d="M6.4 9.4h7.2v-3H6.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M4.8 6.4L10 2.2l5.2 4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="10" cy="7.9" r="1.15" className="fill-ember" />
    </svg>
  );
}

/** A small filled dot, used to head a line in the mock screens. */
export const Bullet = () => (
  <span className="mr-[3px] inline-block h-[6px] w-[6px] rounded-full bg-ember-soft align-[0.15em]" />
);
