/**
 * A bottom sheet that keeps the promise its grabber makes.
 *
 * **A grabber is a promise.** A bar drawn at the top of a sheet says *pull me*
 * on iOS, and drawing one over a sheet that only closes by tapping the scrim
 * is worse than drawing nothing — it teaches the gesture and then refuses it.
 *
 * This file exists because that rule was stated twice in this codebase, in
 * `Servers.tsx` and in `e2e/answer.yaml`, and then broken three times:
 * `WorkspaceMenu`, `Servers` and `ArtifactMenu` each drew a grabber with **no
 * pan gesture at all**. Dragging one down 170pt moved nothing and closed
 * nothing. Only `Picker` ever had the gesture, and it is the template here.
 *
 * So the two are not separable any more. There is no prop for "draw a grabber"
 * — the sheet draws one because it *is* draggable, and a component that cannot
 * be dragged cannot accidentally claim it can.
 *
 * ## The gesture
 *
 * The whole sheet follows the finger, 1:1 from where it was grabbed, and it
 * goes past a third of the way or with any real speed — so a flick dismisses
 * without having to travel. Below that it springs back, which is what tells
 * you the gesture was understood and declined rather than missed.
 *
 * `activeOffsetY(8)` so a press that drifts a pixel is still a press, and so a
 * sheet with a scrolling list inside it does not steal the list's own scroll
 * on the first few points of travel.
 */
import { useEffect, type ReactNode } from "react";
import { Modal, Pressable, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "~/design/theme";

export function Sheet({
  open,
  onClose,
  children,
  /** A sheet holding a long list wants a ceiling; a short menu does not. */
  maxHeight,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  maxHeight?: `${number}%`;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();

  const down = useSharedValue(0);
  useEffect(() => {
    if (open) down.value = 0;
  }, [open, down]);

  const leave = () => {
    down.value = withTiming(900, { duration: 180, easing: Easing.in(Easing.quad) });
    onClose();
  };

  const drag = Gesture.Pan()
    .activeOffsetY(8)
    .onChange((e) => {
      /* Never upward: a sheet that can be dragged *open* past its own top
         edge reads as broken rather than as generous. */
      down.value = Math.max(0, down.value + e.changeY);
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 700) {
        down.value = withTiming(900, { duration: 160 });
        /* The callback is a worklet on the UI thread; `onClose` is React's.
           See `Peek.tsx` on what happens when that crossing is left
           unmarshalled — it is an uncaught C++ exception, not a red screen. */
        runOnJS(onClose)();
      } else {
        down.value = withTiming(0, { duration: 180 });
      }
    });

  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: down.value }] }));

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      {/* Tapping away closes it too. A panel with only one way out is one
          people get stuck in — and this is a *scrim* rather than a catcher
          because a sheet is the task: what is behind it is not what it is
          about. `--color-scrim` is its own token precisely because a surface
          at an alpha is a pale wash on a pale ground. */}
      <Pressable
        testID="sheet-dismiss"
        accessibilityLabel="Dismiss"
        className="flex-1"
        style={{ backgroundColor: color.scrim }}
        onPress={leave}
      />

      <GestureDetector gesture={drag}>
        <Animated.View
          className="rounded-t-sheet bg-float"
          style={[
            {
              paddingBottom: insets.bottom + 14,
              marginLeft: insets.left,
              marginRight: insets.right,
              ...(maxHeight ? { maxHeight } : {}),
            },
            slide,
          ]}
        >
          {/* A generous target: the bar is 5pt tall and the grab is the whole
              28pt band around it. */}
          <View className="items-center pb-0.5 pt-2.5">
            <View className="h-[5px] w-[38px] rounded-full bg-settling" />
          </View>
          {children}
        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}
