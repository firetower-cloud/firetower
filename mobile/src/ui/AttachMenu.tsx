/**
 * What the `+` opens.
 *
 * A menu, not a row of buttons crammed into the composer's width. Three
 * destinations that read top to bottom at a size your thumb can hit without
 * aiming, each with the icon on the left where a list's icons go.
 *
 * **It grows out of the `+`.** `transformOrigin` pins the scale to the bottom
 * left corner, so the panel expands from the button you pressed rather than
 * appearing centred on nothing. That single detail is most of the difference
 * between a native-feeling menu and a div that faded in.
 *
 * **Tapping anywhere else closes it.** The scrim reaches up over the
 * conversation, because a panel you can only dismiss by pressing the same
 * small button again is a panel people get stuck in.
 */
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut, withSpring, withTiming } from "react-native-reanimated";
import { Camera, FileText, Image as ImageIcon } from "lucide-react-native";
import { pickFiles, pickImages, takePhoto, type Picked } from "~/ui/attach";
import { size } from "~/design/tokens.generated";
import { useTheme } from "~/design/theme";

const Scrim = Animated.createAnimatedComponent(Pressable);

/** Firm and short. A menu that wobbles reads as a toy. */
const SETTLE = { damping: 20, stiffness: 260, mass: 0.7 };

const WAYS: { id: string; label: string; hint?: string; icon: typeof Camera; run: () => Promise<Picked[]> }[] = [
  {
    id: "camera",
    label: "Camera",
    icon: Camera,
    run: takePhoto,
  },
  {
    id: "photos",
    label: "Photos",
    icon: ImageIcon,
    run: pickImages,
  },
  {
    id: "files",
    label: "Files",
    /* The one hint worth printing, because it is the one thing here that is
       not obvious: a file does not ride along with what you type, it lands in
       the workspace the agent is working in. A picture goes where you would
       expect and says nothing. */
    hint: "Into the workspace",
    icon: FileText,
    run: pickFiles,
  },
];

function open() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.8 }, { translateY: 16 }] },
    animations: {
      opacity: withTiming(1, { duration: 120 }),
      transform: [{ scale: withSpring(1, SETTLE) }, { translateY: withSpring(0, SETTLE) }],
    },
  };
}

function shut() {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }, { translateY: 0 }] },
    animations: {
      opacity: withTiming(0, { duration: 110 }),
      transform: [
        { scale: withTiming(0.86, { duration: 130 }) },
        { translateY: withTiming(10, { duration: 130 }) },
      ],
    },
  };
}

export function AttachMenu({
  onPick,
  onClose,
}: {
  /**
   * Handed the picker itself, not its result.
   *
   * `onPick(await run())` reads the same and is not the same: this `onPress`
   * is `async`, so a picker that threw became an unhandled rejection and the
   * menu simply closed. Nothing appeared, nothing was said, and a broken
   * attachment looked exactly like a cancelled one. Awaited where the error
   * handling already is instead.
   */
  onPick: (run: () => Promise<Picked[]>) => void;
  onClose: () => void;
}) {
  const { color } = useTheme();
  return (
    <>
      <Scrim
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(120)}
        onPress={onClose}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          /* Far enough up to catch a press anywhere on the conversation. */
          top: -900,
          /* The drawing's own stacking order: a catcher at 45, the popover it
             belongs to at 46. Both have to clear the composer's 20 or the
             panel opens behind the control that opened it. */
          zIndex: 45,
          /* **A catcher, not a scrim**, and it was a scrim — a hand-written
             `rgba(0,0,0,0.5)`, the one colour in `mobile/src` that came from
             nowhere. The test that picks between the two is whether the thing
             the overlay is *about* stays on screen behind it. Here it does:
             you are mid-sentence and the composer behind this is the subject,
             so dimming it is dimming what you are reading. A popover gets an
             invisible dismiss target and nothing else. */
        }}
      />

      <Animated.View
        entering={open}
        exiting={shut}
        style={{ transformOrigin: "bottom left", zIndex: 46 }}
        className="mb-2 ml-3 w-64 overflow-hidden rounded-pop border border-line bg-float py-2"
      >
        {WAYS.map(({ id, label, hint, icon: Icon, run }) => (
          <Pressable
            key={id}
            testID={`attach-${id}`}
            onPress={() => {
              onClose();
              onPick(run);
            }}
            className="flex-row items-center gap-3 px-3 py-2.5 active:bg-overlay"
            android_ripple={{ color: color.overlay }}
          >
            <View className="h-9 w-9 items-center justify-center rounded-full bg-overlay">
              <Icon color={color.text} size={18} />
            </View>
            <View>
              <Text className="font-sans text-bone" style={{ fontSize: size.read }}>
                {label}
              </Text>
              {hint ? <Text className="font-sans text-meta text-mute">{hint}</Text> : null}
            </View>
          </Pressable>
        ))}
      </Animated.View>
    </>
  );
}
