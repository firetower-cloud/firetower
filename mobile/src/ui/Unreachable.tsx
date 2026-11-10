/**
 * *N is not answering.* — the one panel a screen draws instead of its content
 * when the server cannot be reached.
 *
 * **Said as its own screen rather than as an empty list.** Reading "nothing is
 * running" when the server is unreachable is the lie `STYLE.md` says costs the
 * most trust: a list that empties itself reads as work having been lost.
 *
 * The guidance is the phone's own. A Firetower is never on the public
 * internet, so a phone reaches one over a mesh VPN, and *is Tailscale on* is
 * the question that actually fixes it — not *check your connection*, which is
 * true of every app and useful in none of them.
 *
 * One component rather than one copy per screen, for the reason `edges.ts`
 * gives about its own rule: the home and the Workspaces destination both have
 * to say this, and two copies are two chances to word it differently. The home
 * had the only copy until Workspaces became a destination and landing on it
 * with no server became something that happens rather than something you
 * chose.
 */
import { Pressable, Text, View } from "react-native";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

export function Unreachable({ org, onRetry }: { org: string; onRetry: () => void }) {
  const { color } = useTheme();

  return (
    <View className="flex-1 items-center justify-center gap-2.5 px-9">
      <Text
        className="text-center font-medium text-bone"
        style={{ fontSize: size.display, lineHeight: size.display * 1.18 }}
      >
        {org} is not answering.
      </Text>
      <Text
        className="max-w-[30ch] text-center font-sans text-dim"
        style={{ fontSize: size.read, lineHeight: size.read * 1.6 }}
      >
        A Firetower is never on the public internet, so this phone reaches one over your mesh VPN.
        Is Tailscale on?
      </Text>
      <Pressable
        testID="retry"
        onPress={onRetry}
        className="mt-2.5 rounded-full bg-raise px-5 py-2.5"
        android_ripple={{ color: color.overlay }}
      >
        <Text className="font-sans text-dim" style={{ fontSize: size.body }}>
          Try again
        </Text>
      </Pressable>
    </View>
  );
}
