/**
 * Which theme this phone is in, and the choice behind it.
 *
 * Three settings, because two is not enough: **System, Light and Dark**.
 * "Follow the system" is a different answer from "always light" even on a
 * phone that is currently light, and a two-way switch cannot express it —
 * which is why every platform ships three and why defaulting to System is
 * what makes the app feel like it belongs to the phone rather than to us.
 *
 * It lives on the **You** tab. The desk puts its theme control in a profile
 * menu; a phone has no profile menu, and You is this phone's own settings —
 * which Firetowers it knows, whether notifications are on, and now this. The
 * thing they have in common is that they survive every server in the list
 * going away, which is exactly what a theme does.
 *
 * ## Why this file has no React in it
 *
 * `resolve` is the whole of the logic and it is a pure function of two
 * arguments, so it is tested in `pnpm test` with the other folds rather than
 * mounted in a renderer. `theme.tsx` beside this holds the provider and the
 * hook; everything that could be got wrong is here.
 *
 * MMKV rather than AsyncStorage for the same reason the server registry uses
 * it: the first paint needs to know the answer, and a promise that resolves a
 * frame later is a frame of the wrong theme — which on this palette is a
 * white flash on a phone the person set to dark.
 */
import { createMMKV } from "react-native-mmkv";

/** What the person chose. Not what is being drawn — see `resolve`. */
export type Choice = "system" | "light" | "dark";

/** What is being drawn. The two branches `tokens.generated.ts` carries. */
export type Scheme = "light" | "dark";

/** In the order the control offers them, which is the order iOS uses. */
export const CHOICES: readonly { id: Choice; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/**
 * The theme to draw, from the choice and what the OS currently says.
 *
 * `system` is `null` when the platform has not told us yet. Light is the
 * design — it is what `S.theme` defaults to in the drawing — so an unknown
 * system reads as light rather than as dark. The alternative is that the one
 * frame before the OS answers is drawn in the branch the design is not.
 */
export function resolve(choice: Choice, system: Scheme | null | undefined): Scheme {
  if (choice === "light" || choice === "dark") return choice;
  return system ?? "light";
}

const store = createMMKV({ id: "firetower.theme" });
const KEY = "choice";

const valid = (v: string | undefined): v is Choice => v === "system" || v === "light" || v === "dark";

/**
 * What was chosen last time, which is what makes it survive a restart.
 *
 * Anything unrecognised reads as `system`. A stored value from a build that
 * spelled these differently is not worth keeping, and defaulting to the
 * platform's own answer is never wrong.
 */
export function readChoice(): Choice {
  try {
    const raw = store.getString(KEY);
    return valid(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

export function writeChoice(choice: Choice): void {
  store.set(KEY, choice);
}
