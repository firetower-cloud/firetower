/**
 * Enough of React Native for a node test runner.
 *
 * The conversation fold is a pure function over the contract, but it lives in
 * the same module as the hook that follows the socket — and that reaches
 * `react-native`, which ships Flow-typed source that vitest cannot parse. The
 * alternative was splitting the fold out of its own file to suit the test
 * runner, which would make the mobile copy diverge from the desktop's for no
 * reason anybody reading it could work out.
 *
 * Nothing under test touches any of this; it exists so the import resolves.
 */
export const AppState = {
  currentState: "active" as const,
  addEventListener: () => ({ remove: () => {} }),
};
export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => false,
  addEventListener: () => ({ remove: () => {} }),
};
export const Platform = { OS: "ios" as const, select: (o: Record<string, unknown>) => o.ios };
/**
 * `ui/end.ts` asks the one irreversible question through this, and the
 * sentence it asks is a pure function worth pinning — the whole reason that
 * file exists is that the sentence and the call it was attached to disagreed.
 *
 * **It records, and it can be answered.** The sentence alone was enough while
 * the only thing worth pinning was the wording; the teardown's *target* is a
 * fact about what happens between the question going up and a button coming
 * back, which cannot be tested without pressing one. So every question is
 * kept and `answer()` presses a button by its label, the way a thumb does —
 * the promise in `ask()` settles from the handler and nowhere else.
 */
type Button = { text?: string; onPress?: () => void };
type Asked = { title: string; body?: string; buttons?: Button[]; options?: { onDismiss?: () => void } };

export const Alert = {
  /** Every question asked, oldest first. A test clears this itself. */
  asked: [] as Asked[],
  alert: (title: string, body?: string, buttons?: Button[], options?: { onDismiss?: () => void }) => {
    Alert.asked.push({ title, body, buttons, options });
  },
  /** The question on screen. */
  up: () => Alert.asked.at(-1),
  /** Press a button on the question on screen, by what it says. */
  answer: (text: string) => {
    const button = Alert.up()?.buttons?.find((b) => b.text === text);
    if (!button) throw new Error(`no "${text}" on ${Alert.up()?.title ?? "nothing"}`);
    button.onPress?.();
  },
};
