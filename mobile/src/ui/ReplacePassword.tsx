/**
 * A password that has to be replaced, which this app deliberately cannot do.
 *
 * Replacing a password happens once, under duress, and it happens on the
 * control plane's own interface. The app does not carry a second copy of that
 * form: two implementations of the screen that decides whether somebody can
 * get in at all is one more than anybody can keep correct, and a browser is
 * always the same version as the server behind it.
 *
 * Reached two ways, which is why this is a component rather than part of the
 * sign-in screen. At the door, when the password just typed turns out to be a
 * temporary one. And mid-session, when an administrator resets a password
 * under a running app — every request then starts coming back refused, and
 * without this the phone would be a wall of "could not reach the control
 * plane" for a server that is answering perfectly.
 *
 * It does not say "first sign-in". The same flag is raised by an administrator
 * resetting somebody's password years in.
 *
 * **The address is the one that was typed to find this server.** That is the
 * address proven to work from this phone, which is the only property a link
 * somebody is about to tap needs to have.
 */
import { Linking, Pressable, Text, View } from "react-native";
import { KeyRound } from "lucide-react-native";
import { color } from "~/design/tokens.generated";

export function ReplacePassword({
  url,
  username,
  retryLabel,
  onRetry,
  onBack,
  backLabel,
}: {
  url: string;
  username?: string;
  retryLabel: string;
  onRetry: () => void;
  onBack?: () => void;
  backLabel?: string;
}) {
  const origin = url.replace(/\/+$/, "");
  const host = origin.replace(/^https?:\/\//, "");

  return (
    <View>
      <View className="mb-7 items-center">
        <View className="h-12 w-12 items-center justify-center rounded-2xl border border-ember-deep bg-ember-tint">
          <KeyRound color={color.ember} size={21} />
        </View>
        <Text className="mt-5 text-center font-semibold text-display text-bone">
          Replace your password first
        </Text>
        <Text className="mt-2 text-center font-sans text-read text-dim">
          {username ? `${username}'s password` : "Your password"} was set by an administrator, who
          has seen it. Choose your own in a browser, then come back here.
        </Text>
      </View>

      <Pressable
        onPress={() => void Linking.openURL(origin).catch(() => {})}
        className="h-13 flex-row items-center justify-center rounded-xl bg-bone"
      >
        <Text className="font-sans font-medium text-ui text-ground">Open {host}</Text>
      </Pressable>

      <Pressable
        onPress={onRetry}
        className="mt-2 h-13 flex-row items-center justify-center rounded-xl border border-line bg-raise"
      >
        <Text className="font-sans font-medium text-ui text-text">{retryLabel}</Text>
      </Pressable>

      <Text className="mt-4 text-center font-sans text-meta text-mute">
        Signing in there is also how you reach the rest of your organisation&apos;s settings.
      </Text>

      {onBack ? (
        <Pressable onPress={onBack} className="mt-5 items-center py-2">
          <Text className="font-sans text-meta text-mute">{backLabel ?? "Back"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
