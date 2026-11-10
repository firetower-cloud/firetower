/**
 * How wide a column of content is allowed to get, and where a panel goes.
 *
 * A phone never needed either: at 390 pt the screen *is* the measure and
 * there is no room for a panel at any width. The Duo's inner display is 669
 * portrait and 951 landscape, and a list row stretched across all of it puts
 * the name at one end and the elapsed time at the other with nothing in
 * between — while a line of prose runs to about 110 characters against the 45
 * to 75 that reads comfortably.
 *
 * One set of numbers rather than a per-screen judgement, and the two
 * maximums are *maximums*: below them nothing changes, so the phone and the
 * front panel are untouched by either.
 */
import type { ViewStyle } from "react-native";

/** Rows, lists, controls — things you scan. */
export const COLUMN: ViewStyle = { width: "100%", maxWidth: 640, alignSelf: "center" };

/** Prose — things you read. Tighter, for the reason the type scale gives. */
export const READING: ViewStyle = { width: "100%", maxWidth: 560, alignSelf: "center" };

/** The same two as numbers, for the arithmetic below. */
export const COLUMN_MAX = 640;
export const READING_MAX = 560;

/**
 * Under this a column is a strip rather than a panel.
 *
 * 280 is the narrowest thing that can hold the overview's rows — a status
 * mark, a name, an agent mark and an age — without the name giving way. A
 * panel that cannot show its own content is worse than no panel, because it
 * takes width from the conversation to do it.
 */
export const DOCK_MIN = 280;

/** What a panel takes when it has the room, docked or floated. */
export const PANEL_MAX = 340;

/**
 * Which of the three behaviours a width gets.
 *
 * - **push**, under 600 — the panel gets its own screen.
 * - **float**, from 600 — over the top, conversation full width underneath,
 *   and the scrim dismisses it.
 * - **dock**, from 840 of *laid-out* width — beside.
 */
export type Band = "push" | "float" | "dock";

/**
 * The two thresholds are not asking the same question, and that is the whole
 * reason a single number gets this wrong.
 *
 * **Whether a panel is worth offering at all** is a question about the
 * *device*. A phone has no room for one at any width and the Duo's front
 * panel is a phone — narrower than one, at 466. That is the window, and 600
 * is the right number for it.
 *
 * **Whether a panel may dock** is a question about *the box the conversation
 * is laid out in*, which is not the window: on the inner display the system
 * reserves room for its tab bar at the trailing edge and insets the content.
 * **Measured at 84 pt on the Duo's front panel** — `right: 84`, as the system
 * itself reports it — against the 74 the documents call `RAIL`. A
 * panel may dock only if the conversation keeps `READING_MAX` and the column
 * still clears `DOCK_MIN` — **840 of laid-out width**, which is a **914 pt
 * window** on the inner display once the rail is taken off it.
 *
 * ## The three numbers, each of which is a trap
 *
 * **914, not 820.** The `820` in the older documents is this question
 * answered against the window instead of the box, and it is ~90 pt early.
 * And 914 itself is 840 plus an *assumed* 74; the system reported 84 on the
 * one pose that could be measured, which is the whole argument for deriving
 * the window figure from a measurement rather than writing it down.
 * Docking at an 820 window leaves the conversation 466 — the front panel's
 * width, on the inner display. Nothing ships between 820 and 914 today, so it
 * is wrong rather than harmful; it is also the number somebody will reach for.
 *
 * And **914 is the Duo's figure, not a universal one.** It is 840 plus that
 * display's rail. A surface nothing insets docks at 840 — which is why
 * a plain iPhone in landscape, at 844, docks. Reading 914 as a window
 * threshold everywhere puts that pose in the wrong band.
 *
 * **669 must not dock.** It is wider than a phone, so it invites a docked
 * panel, and docking there leaves the conversation 329 pt — narrower than the
 * 390 pt phone this design came from, and 245 once the rail is counted. The
 * entire band rule exists to stop that one move. 669 lays out in **585**,
 * which is 255 short of the dock line, so it floats.
 *
 * Those two figures were 595 and 255, which is 669 − 74 — the older `RAIL`
 * this same docblock calls wrong two paragraphs up. At the measured 84 they
 * are 585 and 245. **Nothing moves either way**: both float, both clear
 * `posterColumns`' 573 for three posters and both clear `dottedChips`' 577
 * for two chips, so this was a stale comment rather than a bug. The three
 * figures further down this file — 595 under `posterColumns`, 468 and 220
 * under `dottedChips` — are the same derivation and are left alone; at 84
 * they are 585, 458 and 210, and no threshold moves there either.
 *
 * **Push is measured on the window and dock on the content, deliberately.**
 * Putting both on the laid-out width flips 669 into `push` by fifteen points —
 * 585 against 600 — which contradicts the rule the band exists to serve.
 * Putting both on the window is the 820 mistake. They are two questions.
 *
 * @param window  the window's width — the device question
 * @param content the width the app is actually laid out in; defaults to the
 *                window, which is correct on everything without a system rail
 */
export function band(window: number, content: number = window): Band {
  if (window < 600) return "push";
  return content >= READING_MAX + DOCK_MIN ? "dock" : "float";
}

/**
 * What a docked column may take: whatever is left once the conversation has
 * its measure, and never less than a panel's worth.
 *
 * Returns 0 when there is not enough, which is the floor test. The shipped
 * code wrote `Math.min(340, Math.max(280, width - 400))` — the same idea with
 * 400 standing in for `READING_MAX` and no floor test, so it returned 280 at
 * widths where 280 does not fit.
 */
export function panelWidth(content: number): number {
  const left = content - READING_MAX;
  if (left < DOCK_MIN) return 0;
  return Math.min(PANEL_MAX, left);
}

/** Does this width genuinely dock? Both tests have to pass. */
export function docks(window: number, content: number = window): boolean {
  return band(window, content) === "dock" && panelWidth(content) > 0;
}

/**
 * What a floated panel takes. It costs the conversation no width — it is over
 * the top — so it only has to leave enough of the page showing to be read
 * against and tapped away from.
 */
export function floatWidth(content: number): number {
  return Math.min(PANEL_MAX, Math.max(0, content - 80));
}

/**
 * What the conversation is left with. **Never below 390 on any pose**, which
 * is the assertion the band rule exists to satisfy.
 */
export function conversationWidth(window: number, content: number = window): number {
  return docks(window, content) ? content - panelWidth(content) : content;
}

/**
 * How many artifact posters a row shows — one full row, never a ragged
 * second one.
 *
 * Three earn their place once each is at least as big as the two-up on a
 * phone. The grid is 16 of gap in 20 of padding, so two at 390 are 167 each
 * and three at W are (W − 72) / 3, which reaches 167 at 573. The inner
 * portrait display lays out in 595 and gets 174 pt posters; every narrower
 * pose keeps two.
 *
 * A docked pose keeps two regardless: the side column is 340 at most, and
 * three in 340 would be 89 — and the whole reason a grid of pictures exists
 * is that you can tell them apart.
 */
export function posterColumns(content: number, isDocked: boolean): number {
  if (isDocked) return 2;
  return content >= 573 ? 3 : 2;
}

/** The library's own grid, which has a page to itself rather than a section. */
export const libraryColumns = (content: number): number => (content >= 620 ? 3 : 2);

/**
 * How many waiting chips carry a dot before the rest become a count.
 *
 * Two is the budget. The desk's is three ember marks with the rail's avatar
 * taking the third; **a phone has no rail avatar**, so on screen it is two —
 * the third mark is the app icon badge, which is not on this screen and is the
 * stronger surface for it anyway.
 *
 * What *fits* is what shows, and the threshold is measured rather than
 * guessed. A chip carrying a name and a time is 240 to 287 pt laid out. The
 * strip is the container less 40 of padding and 87 for the pinned count, so
 * it is 263 at 390, 339 at 466 and 468 at 595. Two chips want 535. The second
 * is worth drawing when most of its name lands: at 466 it gets 91 pt of 287
 * and reads as an ember dot with two letters after it, which is the orphan
 * this rule prevents; at 595 it gets 220 and reads. Hence 577, which is 450 of
 * strip. The count absorbs the difference and stays exact either way, because
 * it counts dots rather than pixels.
 */
export const DOTTED = 2;
export const dottedChips = (content: number): number => (content >= 577 ? DOTTED : 1);
