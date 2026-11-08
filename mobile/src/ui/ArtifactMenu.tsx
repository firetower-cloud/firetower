/**
 * What the ⋯ offers on an artifact, **and what it will not**.
 *
 * Three things you can do while looking at the thing: take its address, go
 * back through its versions, and open the workspace that made it. All three
 * are decisions you take *about what is on screen*, which is why this is a
 * sheet over a viewer that stays rendered rather than a screen you leave for.
 *
 * ## The absence is the design
 *
 * There is no **Share**, no directory and no grant, and the note at the foot
 * says where those are done instead. `STYLE.md`'s rule is that mobile reads
 * and starts work and **writes no access of any kind** — so the honest move is
 * to say so once, in words, rather than draw a greyed-out *Share* row. A
 * disabled control is the clearest possible way to tell somebody they are
 * being withheld from; a sentence tells them where to go.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { History, Link2, SquareArrowOutUpRight } from "lucide-react-native";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function ArtifactMenu({
  title,
  path,
  version,
  address,
  onClose,
  onWorkspace,
}: {
  title: string;
  path: string;
  version: number;
  address: string;
  onClose: () => void;
  /** Absent when the workspace that made it has already been reclaimed. */
  onWorkspace?: () => void;
}) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();

  const items = [
    {
      id: "address",
      label: "Copy the address",
      icon: Link2,
      run: () => Clipboard.setStringAsync(address),
    },
    { id: "versions", label: "Earlier versions", icon: History, run: undefined },
    onWorkspace
      ? {
          id: "workspace",
          label: "The workspace that made it",
          icon: SquareArrowOutUpRight,
          run: onWorkspace,
        }
      : null,
  ].filter(Boolean) as { id: string; label: string; icon: typeof Link2; run?: () => void }[];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        accessibilityLabel="Dismiss"
        className="flex-1"
        style={{ backgroundColor: color.scrim }}
        onPress={onClose}
      />
      <View
        className="rounded-t-sheet bg-float"
        style={{ paddingBottom: insets.bottom + 14, marginLeft: insets.left, marginRight: insets.right }}
      >
        <View className="items-center pb-0.5 pt-2.5">
          <View className="h-[5px] w-[38px] rounded-full bg-settling" />
        </View>

        <View className="px-5 pb-3.5 pt-3">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            {title}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 font-mono text-meta text-mute">
            {path} · v{version}
          </Text>
        </View>

        {items.map(({ id, label, icon: Icon, run }) => (
          <Pressable
            key={id}
            testID={`artifact-${id}`}
            disabled={!run}
            onPress={() => {
              run?.();
              onClose();
            }}
            className="min-h-[54px] flex-row items-center gap-3.5 px-5 active:bg-raise"
            android_ripple={{ color: color.raise }}
          >
            <Icon color={run ? color.text : color.mute} size={20} />
            <Text className={`font-sans ${run ? "text-text" : "text-mute"}`} style={{ fontSize: size.title }}>
              {label}
            </Text>
          </Pressable>
        ))}

        <View className="my-2 h-px bg-line-soft" />

        {/* Said in words rather than drawn as a disabled *Share*. */}
        <Text className="px-5 pb-1 font-sans text-micro text-mute" style={{ lineHeight: size.micro * 1.5 }}>
          Who else can reach this, and the directory it is filed in, are set from the desktop app. A
          phone reads artifacts; it grants nothing.
        </Text>
      </View>
    </Modal>
  );
}
