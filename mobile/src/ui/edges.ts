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
  return screenEdges(useSafeAreaInsets(), want);
}
