/**
 * How wide a column of content is allowed to get.
 *
 * A phone never needed this: at 390 pt the screen *is* the measure. The Duo's
 * inner panel is 951, and a list row stretched across all of it puts the name
 * at one end and the elapsed time at the other with nothing in between — and
 * a line of prose runs to about 110 characters, against the 45 to 75 that
 * reads comfortably.
 *
 * One number rather than a per-screen judgement, and it is a *maximum*: below
 * it nothing changes, so the phone and the front panel are untouched.
 */
import type { ViewStyle } from "react-native";

/** Rows, lists, controls — things you scan. */
export const COLUMN: ViewStyle = { width: "100%", maxWidth: 640, alignSelf: "center" };

/** Prose — things you read. Tighter, for the reason the type scale gives. */
export const READING: ViewStyle = { width: "100%", maxWidth: 560, alignSelf: "center" };
