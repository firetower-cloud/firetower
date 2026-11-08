/**
 * Switching Firetower, from the monogram in the header.
 *
 * Slack's model, and the monogram is **never a colour**. With N servers the
 * temptation to colour-code them is constant, and on a phone taking it would
 * be a legend you can never read — only one server is ever on screen, so the
 * colour has nothing to be compared against.
 *
 * The sheet carries each server's reachability **and its waiting count**,
 * which is what `docs/mobile.md` specifies it for. That count is where the
 * desk's *one more waiting in Ledger* line goes: the home has no room for it
 * at 390, and this is where you would act on it anyway.
 *
 * **Only the current one holds a socket.** Four self-hosted control planes
 * streaming at once is four radio wakeups on cellular, for a question push
 * notifications answer better — so the counts for the others are whatever was
 * last known, and the sheet says so rather than implying they are live.
 */
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Check, Plus } from "lucide-react-native";
import { choose, useServer } from "~/native/current";
import { servers } from "~/native/servers";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function Servers({ onClose }: { onClose: () => void }) {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  const here = useServer();
  const all = servers();

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {/* A sheet is the task and the home is not what it is about, so this is
          a scrim rather than a catcher. */}
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
        {/* **A grabber is a promise.** Drawn because the sheet follows the
            finger down, not only because it looks like a sheet. */}
        <View className="items-center pb-0.5 pt-2.5">
          <View className="h-[5px] w-[38px] rounded-full bg-settling" />
        </View>

        <View className="px-5 pb-3.5 pt-3">
          <Text className="font-medium text-title text-bone">Firetowers</Text>
          <Text className="mt-0.5 font-sans text-meta text-dim">
            Only the current one holds a socket.
          </Text>
        </View>

        {all.map((s) => {
          const current = s.serverId === here?.serverId;
          return (
            <Pressable
              key={s.serverId}
              testID={`server-${s.serverId}`}
              onPress={() => {
                if (!current) choose(s.serverId);
                onClose();
              }}
              className="min-h-[54px] flex-row items-center gap-3.5 px-5 active:bg-raise"
              android_ripple={{ color: color.raise }}
            >
              <View className="h-[26px] w-[26px] items-center justify-center rounded-md bg-raise">
                <Text className="font-semibold text-meta text-dim">
                  {s.org.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-text" style={{ fontSize: size.title }}>
                {s.org}
              </Text>
              {current ? <Check color={color.mute} size={18} /> : null}
            </Pressable>
          );
        })}

        <View className="my-2 h-px bg-line-soft" />

        <Pressable
          testID="connect-another"
          onPress={() => {
            onClose();
            router.push("/connect");
          }}
          className="min-h-[54px] flex-row items-center gap-3.5 px-5 active:bg-raise"
          android_ripple={{ color: color.raise }}
        >
          <Plus color={color.text} size={20} />
          <Text className="font-sans text-text" style={{ fontSize: size.title }}>
            Connect a Firetower
          </Text>
        </Pressable>
      </View>
    </Modal>
  );
}
