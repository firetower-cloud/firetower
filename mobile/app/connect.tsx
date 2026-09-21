/**
 * Connecting this phone to a Firetower.
 *
 * Two questions, asked in order and never at the same time: **where** it is,
 * and **who you are there**. They are separate because only the first has an
 * answer that is the same for everybody at a company, and because knowing the
 * answer to the first is what lets the client tell you *whose* Firetower you
 * are about to hand a password to.
 *
 * One field takes the address. Not a code: a code carries no address, and a
 * fleet of self-hosted servers has nowhere to look one up that would not be a
 * hosted service holding every install's whereabouts — which is the thing this
 * architecture exists to avoid.
 *
 * ## What a phone adds
 *
 * **It says when an address is not encrypted.** A great many installs are
 * `http://192.168.1.40:4400` or a Tailscale name, and both platforms block
 * cleartext by default; the app allows it deliberately, so it owes you the
 * fact. Said in `--color-dim` and never as an error — an unencrypted address
 * on a mesh VPN is a normal way to run this, not a mistake.
 *
 * **The keyboard is part of the layout.** The field, the button and the notice
 * ride above it rather than being covered by it.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { ArrowRight, CircleSlash2, Lock, ShieldOff } from "lucide-react-native";
import { cleartext, reach, signIn, type Bootstrap } from "~/api/probe";
import { remember } from "~/native/servers";
import { Mark } from "~/ui/Mark";
import { color, size } from "~/design/tokens.generated";

type Stage =
  | { at: "where" }
  | { at: "reaching" }
  | { at: "unreachable"; typed: string; detail: string }
  | { at: "wrong"; typed: string; detail: string }
  | { at: "who"; url: string; boot: Bootstrap };

export default function Connect() {
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState("");
  const [stage, setStage] = useState<Stage>({ at: "where" });

  const find = async (address: string) => {
    setStage({ at: "reaching" });
    const found = await reach(address);
    if (!found.ok) {
      setStage({
        at: found.why === "unreachable" ? "unreachable" : "wrong",
        typed: address,
        detail: found.detail,
      });
      return;
    }
    setStage({ at: "who", url: found.url, boot: found.at });
  };

  return (
    <KeyboardAwareScrollView
      /* Enough for the button *under* the field, not just the field. The
         library lifts whatever has focus; the primary action is below it, and
         a Connect button hidden behind the keyboard is a dead end on a screen
         whose entire job is one action.
         
         iOS needed more than Android did: the same 104 left the button sitting
         exactly on the keyboard's top edge, which is reachable and looks like
         a mistake. Sized to clear the button and leave a gap under it. */
      bottomOffset={132}
      style={{ flex: 1, backgroundColor: color.ground }}
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingTop: insets.top + 24,
        paddingBottom: insets.bottom + 24,
      }}
      keyboardShouldPersistTaps="handled"
    >
      {stage.at === "where" ? (
        <Where typed={typed} onTyped={setTyped} onGo={() => find(typed)} />
      ) : stage.at === "reaching" ? (
        <View className="items-center">
          <ActivityIndicator color={color.mute} />
          <Text className="mt-4 text-center font-sans text-read text-dim">
            Looking for a Firetower at {typed}…
          </Text>
        </View>
      ) : stage.at === "unreachable" ? (
        <NoRoute
          typed={stage.typed}
          detail={stage.detail}
          onRetry={() => find(stage.typed)}
          onBack={() => setStage({ at: "where" })}
        />
      ) : stage.at === "wrong" ? (
        <NotOne
          typed={stage.typed}
          detail={stage.detail}
          onBack={() => setStage({ at: "where" })}
        />
      ) : (
        <Who
          url={stage.url}
          boot={stage.boot}
          onBack={() => setStage({ at: "where" })}
          onIn={(token, user) => {
            const serverId = stage.boot.serverId ?? stage.url;
            remember(
              {
                url: stage.url,
                serverId,
                org: stage.boot.organization ?? stage.url.replace(/^https?:\/\//, ""),
                user,
                addedAt: new Date().toISOString(),
              },
              token,
            );
            router.replace("/");
          }}
        />
      )}
    </KeyboardAwareScrollView>
  );
}

function Field(props: React.ComponentProps<typeof TextInput>) {
  const [on, setOn] = useState(false);
  return (
    <TextInput
      {...props}
      onFocus={() => setOn(true)}
      onBlur={() => setOn(false)}
      placeholderTextColor={color.mute}
      selectionColor={color.ember}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        {
          borderWidth: 1,
          borderColor: on ? color["slate-deep"] : color.line,
          backgroundColor: color.panel,
          borderRadius: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          color: color.bone,
          fontSize: size.read,
        },
        props.style,
      ]}
    />
  );
}

function Primary({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      className={`mt-3 h-13 flex-row items-center justify-center gap-2 rounded-xl ${
        disabled ? "bg-raise" : "bg-bone"
      }`}
      style={{ height: 52 }}
    >
      {busy ? (
        <ActivityIndicator color={color.ground} />
      ) : (
        <>
          <Text className={`font-semibold text-title ${disabled ? "text-mute" : "text-ground"}`}>
            {label}
          </Text>
          <ArrowRight color={disabled ? color.mute : color.ground} size={17} />
        </>
      )}
    </Pressable>
  );
}

function Where({
  typed,
  onTyped,
  onGo,
}: {
  typed: string;
  onTyped: (v: string) => void;
  onGo: () => void;
}) {
  const plain = typed.trim().length > 0 && cleartext(`http://${typed}`) && !/^https:/i.test(typed);

  return (
    <View>
      <View className="mb-8 items-center">
        <View className="h-14 w-14 items-center justify-center rounded-2xl border border-line bg-raise">
          <Mark size={30} />
        </View>
        <Text className="mt-5 font-semibold text-display text-bone">Connect to a Firetower</Text>
        <Text className="mt-2 text-center font-sans text-read text-dim">
          The address of the control plane your team runs. It is never on the public internet, so
          this is usually a name on your mesh VPN.
        </Text>
      </View>

      <Field
        testID="address"
        autoFocus
        value={typed}
        onChangeText={onTyped}
        onSubmitEditing={() => typed.trim() && onGo()}
        returnKeyType="go"
        keyboardType="url"
        placeholder="ft-e1.tail9c2b.ts.net"
        style={{ textAlign: "center", fontFamily: "JetBrainsMono_400Regular" }}
      />

      <Primary label="Connect" onPress={onGo} disabled={!typed.trim()} />

      <Text className="mt-4 text-center font-sans text-meta text-mute">
        Nothing is sent until this reaches a server you named.
      </Text>

      {plain ? (
        <View className="mt-4 flex-row items-start gap-2 rounded-xl border border-line bg-panel px-4 py-3">
          <View className="pt-0.5">
            <ShieldOff color={color.dim} size={14} />
          </View>
          <Text className="flex-1 font-sans text-meta text-dim">
            If this answers over <Text className="font-mono text-meta text-text">http</Text>, the
            connection is not encrypted. That is normal on a mesh VPN and on your own network,
            and the app allows it — it is worth knowing rather than being stopped for.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** The state the design predicts is the common one, written as what to do
    rather than what went wrong. */
function NoRoute({
  typed,
  detail,
  onRetry,
  onBack,
}: {
  typed: string;
  detail: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <View>
      <View className="items-center">
        <CircleSlash2 color={color.mute} size={26} />
        <Text className="mt-4 text-center font-medium text-title text-bone">
          No route to {typed}
        </Text>
        <Text className="mt-2 text-center font-sans text-read text-dim">
          A Firetower is never on the public internet, so this phone reaches one over your mesh
          VPN.
        </Text>
      </View>

      <View className="mt-5 gap-2 rounded-xl border border-line bg-panel px-4 py-4">
        <Text className="font-sans text-meta text-dim">Is Tailscale on, and signed in?</Text>
        <Text className="font-sans text-meta text-dim">Has this phone been shared the node?</Text>
        <Text className="font-sans text-meta text-dim">
          Is the address right — a name, not an IP behind a firewall?
        </Text>
      </View>

      <Text className="mt-3 text-center font-mono text-micro text-mute">{detail}</Text>

      <View className="mt-5 flex-row gap-2">
        <Pressable
          onPress={onBack}
          style={{ height: 52 }}
          className="flex-1 items-center justify-center rounded-xl border border-line bg-raise"
        >
          <Text className="font-medium text-ui text-text">Change it</Text>
        </Pressable>
        <Pressable
          onPress={onRetry}
          style={{ height: 52 }}
          className="flex-1 items-center justify-center rounded-xl bg-bone"
        >
          <Text className="font-semibold text-ui text-ground">Try again</Text>
        </Pressable>
      </View>
    </View>
  );
}

function NotOne({ typed, detail, onBack }: { typed: string; detail: string; onBack: () => void }) {
  return (
    <View className="items-center">
      <CircleSlash2 color={color.mute} size={26} />
      <Text className="mt-4 text-center font-medium text-title text-bone">
        {typed} is not a Firetower
      </Text>
      <Text className="mt-2 text-center font-sans text-read text-dim">
        Something answered at that address, but it is not a control plane this app can talk to.
      </Text>
      <Text className="mt-3 text-center font-mono text-micro text-mute">{detail}</Text>
      <Pressable
        onPress={onBack}
        style={{ height: 52 }}
        className="mt-6 w-full items-center justify-center rounded-xl border border-line bg-raise"
      >
        <Text className="font-medium text-ui text-text">Change the address</Text>
      </Pressable>
    </View>
  );
}

/**
 * Who you are, and it is the server that decides how.
 *
 * `authModes` comes from `/bootstrap`, so the client never guesses: a password
 * form shown to an SSO deployment is a dead end, and asking a one-person laptop
 * install for a browser round trip is rude.
 */
function Who({
  url,
  boot,
  onIn,
  onBack,
}: {
  url: string;
  boot: Bootstrap;
  onIn: (token: string, user: string) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);

  const open = boot.authModes.includes("open");
  const proxyOnly = !boot.authModes.includes("password") && boot.authModes.includes("proxy");

  useEffect(() => {
    // Nothing stands in front of this one; there is nobody to be.
    if (open) onIn("", "everyone");
  }, [open, onIn]);

  const go = async () => {
    setBusy(true);
    setWrong(null);
    const out = await signIn(url, username.trim(), password);
    setBusy(false);
    if (!out.ok) return setWrong(out.why);
    onIn(out.token, out.user);
  };

  const ready = username.trim().length > 0 && password.length > 0;

  return (
    <View>
      <View className="mb-7 items-center">
        <View className="h-12 w-12 items-center justify-center rounded-2xl border border-sage-deep bg-sage-tint">
          <Lock color={color.sage} size={21} />
        </View>
        {/* The organisation, named before anybody types a password. This is the
            whole reason `/bootstrap` is asked first. */}
        <Text className="mt-5 font-semibold text-display text-bone">
          {boot.organization ?? "A Firetower"}
        </Text>
        <View className="mt-1.5 flex-row items-center gap-2">
          <Text className="font-mono text-meta text-mute">
            {url.replace(/^https?:\/\//, "")}
          </Text>
          <Text className="font-sans text-meta text-mute">·</Text>
          <Text className="font-sans text-meta text-mute">Firetower {boot.version}</Text>
        </View>
        {cleartext(url) ? (
          <View className="mt-3 flex-row items-center gap-1.5">
            <ShieldOff color={color.mute} size={12} />
            <Text className="font-sans text-meta text-mute">Not encrypted</Text>
          </View>
        ) : null}
      </View>

      {proxyOnly ? (
        <View className="rounded-xl border border-line bg-panel px-4 py-4">
          <Text className="text-center font-sans text-read text-dim">
            This server signs people in through something in front of it. That needs a browser,
            and the app cannot do it yet.
          </Text>
          <Text className="mt-2 text-center font-sans text-meta text-mute">
            The device flow is the next thing to build.
          </Text>
        </View>
      ) : (
        <>
          <Field
            testID="username"
            autoFocus
            value={username}
            onChangeText={setUsername}
            placeholder="Username"
            textContentType="username"
            returnKeyType="next"
          />
          <View className="h-2" />
          <Field
            testID="password"
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            secureTextEntry
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => ready && go()}
          />

          {wrong ? (
            <Text className="mt-3 text-center font-sans text-meta text-brick">{wrong}</Text>
          ) : null}

          <Primary label="Sign in" onPress={go} disabled={!ready} busy={busy} />
        </>
      )}

      <Pressable onPress={onBack} className="mt-6 items-center py-2">
        <Text className="font-sans text-meta text-mute">Not this server</Text>
      </Pressable>
    </View>
  );
}
