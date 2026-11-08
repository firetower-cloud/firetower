/**
 * Which pose a screen is in, measured rather than assumed.
 *
 * The band rule asks two different questions — see `measure.ts` — and one of
 * them is about **the box the screen is actually laid out in**, which is not
 * the window. On the Duo's inner display the system lifts the tab bar out of
 * the bottom and lays it down the trailing edge, and a sidebar-shaped tab bar
 * *insets* its content. So the view the conversation lives in is narrower than
 * the window by the rail.
 *
 * `docs/mobile-redesign-coverage.md` §8 settles that it insets and says one log
 * line on a device would confirm it. **This measures instead of assuming**,
 * which makes the question moot: whatever the system does with the rail — inset
 * or overlay — the number this returns is the width the screen got. If a
 * device turns out to overlay, the column becomes 340 rather than 317 with no
 * code change, because 340 is what `panelWidth` returns from a wider box.
 *
 * Spread `onLayout` on the screen's own root view. Until the first layout the
 * window is used, which is correct on every surface without a rail and one
 * frame early on the two that have one.
 */
import { useCallback, useState } from "react";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { band, docks, floatWidth, panelWidth, type Band } from "~/ui/measure";

export type Pose = {
  /** The window's width. The *device* question: is a panel worth offering. */
  window: number;
  /** The width this screen was laid out in. The *panel* question. */
  content: number;
  band: Band;
  /** What a docked column takes, or 0 when there is not room for one. */
  panel: number;
  /** What a floated panel takes. It costs the conversation no width. */
  floating: number;
  /** Both tests passed: it may genuinely sit beside. */
  docked: boolean;
  /** Put this on the screen's root view. */
  onLayout: (e: LayoutChangeEvent) => void;
};

export function usePose(): Pose {
  const { width: window } = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    /* Only on a real change. `onLayout` fires on every re-layout and setting
       state unconditionally from it is a render loop with a rounding error in
       it. */
    setMeasured((was) => (was === w ? was : w));
  }, []);

  const content = measured ?? window;

  return {
    window,
    content,
    band: band(window, content),
    panel: panelWidth(content),
    floating: floatWidth(content),
    docked: docks(window, content),
    onLayout,
  };
}
