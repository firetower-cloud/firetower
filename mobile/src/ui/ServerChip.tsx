/**
 * Which Firetower you are looking at.
 *
 * A monogram, in `--color-dim` on `--color-raise`. Not a colour: with N servers
 * the temptation to colour-code them is constant, and taking it would put a
 * second loud thing next to ember — which on a phone is worse, because you can
 * only ever see one server at a time and a colour code would be a legend you
 * can never read.
 */
import { Pressable, Text, View } from "react-native";

export function ServerChip({
  org,
  reach,
  onPress,
}: {
  org: string;
  reach: "live" | "unreachable";
  onPress?: () => void;
}) {
  const dark = reach === "unreachable";
  return (
    <Pressable onPress={onPress} className="flex-row items-center gap-2" hitSlop={8}>
      <View
        className={`h-8 w-8 items-center justify-center rounded-md bg-raise ${dark ? "border border-dashed border-mute" : ""}`}
      >
        <Text className={`font-semibold text-ui ${dark ? "text-mute" : "text-bone"}`}>
          {org.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <Text className={`font-medium text-ui ${dark ? "text-mute" : "text-text"}`}>{org}</Text>
    </Pressable>
  );
}
