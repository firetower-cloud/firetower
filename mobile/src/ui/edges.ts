/**
 * Screen padding, and the one rule the screens kept getting wrong.
 *
 * **A safe-area inset is a minimum, never a replacement.** It says where the
 * hardware intrudes; it says nothing about what the design wants. Treating it
 * as the padding itself means a device that happens to intrude nothing gets no
 * padding at all — which is what shipped:
 *
 * ```js
 * paddingHorizontal: 24,     // the gutter
 * paddingLeft: insets.left,  // 0 on the Duo's front panel
 * paddingRight: insets.right // 84
 * ```
 *
 * On a phone `insets.left` is 0, so the left gutter collapsed to nothing and
 * the text sat against the frame while the right edge took 84. A user found it
 * on *Replace this password first.* — `locked.tsx` and `connect.tsx` were the
 * two screens that carried their gutter on the root, and so the two that could
 * lose it.
 *
 * I have not verified *which* rule collapses it — whether the later key wins
 * in style flattening, or Yoga resolves `Edge::Left` ahead of
 * `Edge::Horizontal` regardless of order. The screenshot settles that it
 * collapses; the mechanism is unproven. So this does not depend on it: there is
 * no shorthand left to interact with, because the resolved number is computed
 * here and emitted as `paddingLeft`/`paddingRight` only.
 *
 * ## Horizontal takes the larger, vertical adds
 *
 * Not an inconsistency — the two insets are different things.
 *
 * Left and right, on the one device that has them, are an opaque **rail** the
 * system reserves for its own chrome. Content starts at its inner edge, and
 * 84pt of reserved width already holds the content well clear of the frame, so
 * the gutter is a floor that 84 satisfies. `Math.max`, which is what
 * `Composer.tsx` and `repos.tsx` already do for the home indicator.
 *
 * Top and bottom are the status bar and the home indicator — *transparent*
 * overlays over the content area, and the drawing puts its own air below them
 * (`.p-air` is `16px 20px 22px` under a status bar it draws separately). So
 * those add: clear the hardware, **then** the design's air. `Math.max` there
 * would put a title under the clock on a notched phone.
 *
 * The drawing is silent on the 84 — its `front` panel is `regular:false` and
 * draws no rail — so this is the conventional reading rather than a measured
 * one, and additive is the defensible alternative. It differs only on the two
 * lede screens: 84 against 110.
 *
 * ## The gutter is not one number
 *
 * Read off `../.firetower/attachments/firetower-mobile-v54.html` rather than
 * assumed. Three, and the screens genuinely want different ones — the `24` in
 * the shipped code was not any of them. It is `.p-springboard`'s, which draws
 * the *iOS home screen*, and `.d-stage`'s, which is the document's own chrome.
 */
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ViewStyle } from "react-native";

/**
 * The screen gutter, and the drawing is emphatic about it: `.p-item`,
 * `.p-grid`, `.p-tree`, `.p-sechead`, `.p-quiet`, `.p-all-row`, `.p-chipwrap`,
 * `.p-facts`, `.p-texttabs`, `.p-planstep`, `.p-member` and `.p-difffile` all
 * take 20. Nothing in the app takes 24.
 */
export const GUTTER = 20;

/**
 * The connect family's own, wider: `wrap()` in the drawing is
 * `padding:0 26px`. Five screens — looking for it, who are you, replace the
 * password, not a Firetower, not authorised — all one centred prose column
 * with no rows in it, which is why it can afford more than a list can.
 */
export const LEDE_GUTTER = 26;

/**
 * **The children carry it.** A named zero, because a bare `0` in a call site
 * reads as an oversight and this is a decision: a list whose rows have their
 * own `px-5`, under a header whose back chevron is optically aligned at `pl-1`
 * so the 22pt glyph inside a 44pt target lands on the gutter. Adding the
 * gutter at the root as well would double it.
 *
 * The default is {@link GUTTER} precisely so that forgetting gives a screen
 * too much air rather than none — the failure that is visible in review
 * instead of the one that ships.
 */
export const BLEED = 0;

/** What the hardware reserves on each edge. `react-native-safe-area-context`. */
export type Insets = { top: number; bottom: number; left: number; right: number };

export type Edges = {
  /** Air below the status bar, *added* to whatever it occupies. */
  top?: number;
  /** Air above the home indicator, likewise. */
  bottom?: number;
  /** The design gutter as a floor. Defaults to {@link GUTTER}. */
  gutter?: number;
};

/**
 * The padding a screen root should take.
 *
 * Pure, so it can be pinned without a renderer; {@link useEdges} is the hook
 * around it. Returns the four longhand properties and **no shorthand**, so
 * there is nothing for a later key to defeat.
 */
export function screenEdges(insets: Insets, want: Edges = {}): ViewStyle {
  const gutter = want.gutter ?? GUTTER;
  return {
    paddingTop: insets.top + (want.top ?? 0),
    paddingBottom: insets.bottom + (want.bottom ?? 0),
    paddingLeft: Math.max(insets.left, gutter),
    paddingRight: Math.max(insets.right, gutter),
  };
}

/**
 * The only place in the app that reads `insets.left` or `insets.right` for a
 * screen's padding.
 *
 * One hook rather than `Math.max` at fifteen call sites, for the reason three
 * sheets ended up drawing a grabber none of them honoured and two composers
 * drifted: a rule written down in fifteen places is fifteen chances to write
 * it down differently.
 *
 * Two deliberate exceptions, both margins on a floating surface rather than a
 * screen's padding: `Sheet.tsx` and `Picker.tsx` set `marginLeft/Right` so a
 * sheet does not slide under the rail. A sheet spans the full width and its
 * own content carries 22, so there is no gutter there to lose — and sweeping
 * them in would change five verified surfaces to fix nothing measured.
 *
 * `pose.ts` reads the insets too, and must keep doing so: it subtracts the
 * **system** inset from a measured frame to get the band's laid-out width, and
 * the design gutter is not a system inset. Every screen that uses `usePose`
 * takes {@link BLEED}, so the two never meet today.
 */
export function useEdges(want: Edges = {}): ViewStyle {
  const real = useSafeAreaInsets();
  /* `supplied()` is `null` everywhere except a dev web bundle with the query
     parameter set — see the note at the foot of this file. */
  return screenEdges(supplied() ?? real, want);
}

/**
 * ## Supplying the insets in a browser, for a sweep no simulator here can run
 *
 * **The bug this file fixes cannot be reproduced on `react-native-web`.**
 * `env(safe-area-inset-*)` reports `0px` in a browser, so `insets.left` was 0,
 * the gutter it was overwriting *also* resolved against 0, and the pre-fix
 * connect screen measures a healthy 26/26 at every width. The defect only
 * exists when an inset is **non-zero**, which on this hardware is one pose on
 * one device.
 *
 * That is a fact about the browser, not about the app — so the insets can be
 * supplied instead of detected, and then the rule is checkable at 390, 412,
 * 669 and 951, which is every width the drawing has and four more than any
 * simulator here can boot.
 *
 * ### Why not `initialMetrics`
 *
 * It was the obvious route and it does not work. `SafeAreaProvider` seeds
 * `useState` from `initialMetrics.insets`, but `NativeSafeAreaProvider.web`
 * appends a hidden `div` whose padding *is* `env(safe-area-inset-*)`, reads
 * its computed padding, and calls `onInsetsChange` — **immediately on mount**,
 * then on every resize and `ResizeObserver` tick. The provider's handler is
 * `setInsets(pickInsets(cur, next))`, which takes the new value whenever it
 * differs. So a seeded 84 is replaced by the browser's 0 on the first effect
 * pass. Not "too late to be useful": overwritten by design, every time.
 *
 * Read in `node_modules/react-native-safe-area-context/lib/commonjs/`
 * (`SafeAreaContext.js`, `NativeSafeAreaProvider.web.js`) at 5.11.1 rather
 * than inferred from the docs.
 *
 * ### So it goes here instead
 *
 * This file is already the one place that reads the insets for a screen's
 * padding, which makes it the one place an override has to exist. Nothing is
 * patched, nothing is monkeyed, and the provider keeps doing exactly what it
 * does.
 *
 * ```
 * http://localhost:8081/connect?insets=0,84,34,0
 * ```
 *
 * `top,right,bottom,left` — CSS shorthand order, because that is the order
 * anybody typing four numbers into a URL will assume. Those four are the
 * Duo front panel's own, as the system reported them: `top 0 · right 84 ·
 * bottom 34 · left 0`. Zero on every edge is the browser's own answer, so
 * sweeping a width twice means running it with and without the parameter.
 *
 * **Web and dev only.** `Platform.OS === "web" && __DEV__`. Checked both
 * ways rather than asserted: the branch is present and reachable in a dev web
 * bundle, and in `expo export --platform web` its console warning appears in
 * no chunk — so `__DEV__` resolved at build time and the branch was stripped.
 * On native, `Platform.OS !== "web"` returns before anything else runs.
 *
 * It is test scaffolding and must never become a way to configure the real
 * app: there is no persistence, no setting, and no code path that writes it.
 */
const SUPPLIED = "insets";

/**
 * Parse `top,right,bottom,left` out of a query string. `null` for anything it
 * cannot read, which the caller reports rather than swallows.
 *
 * Pure and exported for the tests, because the thing most worth pinning about
 * a debug hook is that it **refuses** malformed input instead of half-reading
 * it.
 */
export function parseInsets(search: string): Insets | null {
  const raw = new URLSearchParams(search).get(SUPPLIED);
  if (raw === null) return null;

  const parts = raw.split(",").map((n) => n.trim());
  if (parts.length !== 4) return null;

  const numbers = parts.map(Number);
  /* `Number("")` is 0 and `Number("12px")` is NaN, so both have to be caught:
     an empty field is a typo rather than a zero somebody meant. */
  if (parts.some((n) => n === "") || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
    return null;
  }

  const [top, right, bottom, left] = numbers as [number, number, number, number];
  return { top, right, bottom, left };
}

/** Remembered per query string, so changing the URL is picked up and typing
 *  a screen's worth of renders does not re-parse it each time. */
let cached: { search: string; insets: Insets | null } | null = null;

function supplied(): Insets | null {
  if (Platform.OS !== "web" || !__DEV__) return null;
  if (typeof window === "undefined") return null; // static rendering

  const search = window.location.search;
  if (cached?.search !== search) {
    const insets = parseInsets(search);
    /* **Loudly, when it cannot be read.** A mistyped parameter that silently
       fell through to detection would make a sweep report the gutter holding —
       or not holding — about an injection that never happened. Four separate
       wrong conclusions in this review came from trusting a derived signal; a
       debug hook that fails quietly is one more of them waiting to happen. */
    if (insets === null && new URLSearchParams(search).has(SUPPLIED)) {
      console.warn(
        `[firetower] ?${SUPPLIED}= could not be read — wanted four non-negative ` +
          `numbers as top,right,bottom,left, e.g. ?${SUPPLIED}=0,84,34,0. ` +
          "Falling back to what the browser reports, which is zero on every edge.",
      );
    }
    cached = { search, insets };
  }
  return cached.insets;
}
