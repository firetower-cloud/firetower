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
 * ## Where `onLayout` goes, and why the insets are subtracted
 *
 * On the screen's own **root** view — the one that applies
 * `paddingLeft/Right: insets.left/right`. That view measures the *window*,
 * because a view's `onLayout` reports its own frame and not its content box,
 * so the horizontal insets have to come off afterwards. Getting this wrong is
 * not theoretical: it shipped, and it reported the Duo's front panel as 466
 * laid out in 466 — "the rail overlays, nothing inset" — when the system was
 * reporting `right: 84` the whole time and every child was 382.
 *
 * **The measured inset is 84, not the 74 the documents call `RAIL`.** Which
 * is the other half of the argument for measuring: a constant would have been
 * ten points wrong even after somebody checked it on a device.
 *
 * Until the first layout the window is used, which is correct on every
 * surface the system does not inset and one frame early on the ones it does.
 */
import { useCallback, useState } from "react";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useInsets } from "~/ui/edges";
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

/** Once per distinct message, so a re-render does not fill the log. */
const saidAlready = new Set<string>();
function said(line: string) {
  if (saidAlready.has(line)) return;
  saidAlready.add(line);
  console.log(`[firetower] ${line}`);
}

export function usePose(): Pose {
  const { width: window, height: windowHeight } = useWindowDimensions();
  /* Through `edges.ts` rather than the provider directly, so a dev web
     build can supply the rail this hardware cannot show. Identical to the
     real insets everywhere else. */
  const insets = useInsets();
  const [measured, setMeasured] = useState<number | null>(null);
  const [tall, setTall] = useState<number | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    const h = Math.round(e.nativeEvent.layout.height);
    /* Only on a real change. `onLayout` fires on every re-layout and setting
       state unconditionally from it is a render loop with a rounding error in
       it. */
    setMeasured((was) => (was === w ? was : w));
    setTall((was) => (was === h ? was : h));
  }, []);

  /* The box the screen is laid out in: the measured frame less what the
     system reserves at the sides. `Math.max` because a transient zero-width
     layout would otherwise make the band briefly negative. */
  const sides = insets.left + insets.right;
  const content = Math.max(0, (measured ?? window) - sides);

  /* The one log line coverage §8 asks for. Whether the system's trailing tab
     bar *insets* the content or *overlays* it decides whether the dock
     threshold is a 914pt window or an 840pt one. It could not be answered
     from a browser until the insets could be supplied to one; with
     `?insets=0,84,34,0` at a 951pt window this is the line that reports the
     docked column, which is 307 and has been estimated three times.
     Dev only, and it prints once per distinct pose. */
  if (__DEV__ && measured !== null) {
    said(
      `pose: window ${window}x${windowHeight}, laid out ${content}x${tall}` +
        (sides > 0 ? ` — the system insets ${sides} at the sides` : " — nothing inset at the sides") +
        ` — band ${band(window, content)}, panel ${panelWidth(content)}`,
    );
  }

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
