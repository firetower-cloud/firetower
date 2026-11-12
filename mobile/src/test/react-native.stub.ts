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
 * Nothing under test presses a button, so this only has to exist.
 */
export const Alert = { alert: () => {} };
