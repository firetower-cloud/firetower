/**
 * Enough of `expo-router` for a node test runner: **which screen is in
 * front.**
 *
 * `ui/end.ts` has to know that, and not only whether it is mounted. A screen
 * that pushed another is still mounted on the same backend, so an unmount
 * check and a destination check both pass while the thing in front of the
 * reader is somebody else's — and the teardown's continuation is a global
 * `router.back()`. That was the second finding of the fourth review round.
 *
 * Focus is not a fact about a pure function; it is a fact about what the
 * navigator did between a press and an answer, which is the same kind of thing
 * `test/hooks.ts` exists to model. So this models it the same way and at the
 * same grain: a boolean the navigator owns, and a commit-and-flush when it
 * changes, which is what the real one does through a context.
 *
 * The real module would parse, but `useIsFocused` reads a context only
 * expo-router's own route tree provides. Nothing under test touches anything
 * else it exports; this is the same bargain `test/react-native.stub.ts`
 * already took.
 */
import { flush, mounted, render } from "~/test/hooks";

/** Whether the screen under test is the one in front. */
let inFront = true;

/**
 * The real one reads `IsFocusedContext`, so it changes only when focus really
 * changes — never on an unrelated re-render. That property is the reason
 * `ui/end.ts` counts visits off this rather than off `useFocusEffect`'s
 * cleanup, which React may run again at any time, so the stub has it too.
 */
export const useIsFocused = () => inFront;

/** The navigator, as far as a test needs one. */
export const screen = {
  /** Push something over what is on screen. */
  blur: () => move(false),
  /** Come back to it. A continuation abandoned on blur must stay abandoned. */
  focus: () => move(true),
  /** A fresh navigator, for the next test. */
  reset: () => {
    inFront = true;
  },
};

/* A focus change is a re-render and the effects that go with it, which is
   where the generation advances. Nothing to redraw once the screen has been
   unmounted, and `render()` would have nothing to call. */
function move(to: boolean) {
  inFront = to;
  if (!mounted()) return;
  render();
  flush();
}
