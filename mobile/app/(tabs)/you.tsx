/**
 * The servers this phone knows about.
 *
 * Slack's model: one is current, and switching is explicit. Only the current
 * one holds a socket — four self-hosted control planes streaming at once is
 * four radio wakeups on cellular, for a question push notifications answer
 * better and for free.
 *
 * A server behind a VPN that is off has not failed. It is dimmed and dashed,
 * never red, and its rows stay visible: a list that empties itself when the
 * network drops reads as work being lost.
 */
import { useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, ChevronRight, Plus, Shapes } from "lucide-react-native";
import { forget, onServers, servers, type Connected } from "~/native/servers";
import { choose, useServer } from "~/native/current";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";
import { ThemeControl } from "~/ui/ThemeControl";
import { useRepos } from "~/data";

export default function You() {
  const { color } = useTheme();
  const insets = useSafeAreaInsets();
  /* The registry, not a fixture: this list is the one piece of state that is
     genuinely the phone's rather than any server's. */
  const known = useSyncExternalStore(onServers, servers, servers);
  const current = useServer()?.serverId;
  /* Only for the count beside the row. The list itself is read on the
     screen it belongs to. */
  const { data: shelf = [] } = useListArtifacts();
  const { data: repos } = useRepos();
  const org = known.find((s) => s.serverId === current)?.org;

  return (
    <ScrollView
      className="flex-1 bg-ground"
      contentContainerStyle={{
        paddingTop: insets.top + 8,
        paddingBottom: insets.bottom + 24,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <Text className="px-4 font-semibold text-display text-bone">You</Text>

      <Text className="mb-2 mt-6 px-4 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        Firetowers
      </Text>

      <View className="px-2">
        {known.map((s: Connected) => {
          const on = s.serverId === current;
          /* Reachability is not known until something is asked; nothing has been
             asked yet, so nothing claims it. */
          const dark = false;
          return (
            <Pressable
              key={s.serverId}
              onPress={() => choose(s.serverId)}
              onLongPress={() => forget(s.serverId)}
              className={`flex-row items-center gap-3 rounded-lg px-3 py-3 ${on ? "bg-overlay" : ""}`}
              android_ripple={{ color: color.overlay }}
            >
              <View
                className={`h-10 w-10 items-center justify-center rounded-md bg-raise ${dark ? "border border-dashed border-mute" : ""}`}
              >
                <Text className={`font-semibold text-title ${dark ? "text-mute" : "text-bone"}`}>
                  {s.org.slice(0, 1).toUpperCase()}
                </Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text className={`font-medium text-title ${dark ? "text-mute" : "text-bone"}`}>{s.org}</Text>
                <Text numberOfLines={1} className="font-mono text-meta text-mute">
                  {s.url}
                </Text>
              </View>
              {dark ? (
                <Text className="font-sans text-meta text-mute">not reachable</Text>
              ) : on ? (
                <Check color={color.sage} size={18} />
              ) : null}
            </Pressable>
          );
        })}

        <Pressable
          onPress={() => router.push("/connect")}
          className="mt-1 flex-row items-center gap-3 rounded-lg px-3 py-3"
          android_ripple={{ color: color.overlay }}
        >
          <View className="h-10 w-10 items-center justify-center rounded-md border border-dashed border-line">
            <Plus color={color.dim} size={18} />
          </View>
          <Text className="font-medium text-title text-dim">Connect a Firetower</Text>
        </Pressable>
      </View>

      {/* **Named for the server**, because that is the answer to "whose
          configuration is this" and it changes the moment you switch above.
          This is what the retired Config tab's subtitle was doing — said in
          the heading rather than in a legend. */}
      <Text className="mb-2 mt-8 px-4 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        {org ?? "This server"}
      </Text>
      <View className="px-2">
        <Pressable
          testID="repositories"
          onPress={() => router.push("/config")}
          className="min-h-[58px] flex-row items-center gap-3 rounded-lg px-3 py-3"
          android_ripple={{ color: color.overlay }}
        >
          <View className="min-w-0 flex-1">
            <Text className="font-medium text-title text-bone">Repositories</Text>
            <Text className="mt-0.5 font-sans text-meta text-mute">
              What a workspace can be cut from
            </Text>
          </View>
          {repos.length ? <Text className="font-sans text-meta text-mute">{repos.length}</Text> : null}
          <ChevronRight color={color.mute} size={16} />
        </Pressable>
      </View>

      {/* **This phone's**, and it survives every server in the list going
          away. The theme is here for exactly that reason. */}
      <Text className="mb-2 mt-8 px-4 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        This phone
      </Text>
      <ThemeControl />

      <View className="mt-2 px-2">
        <View className="min-h-[58px] justify-center rounded-lg px-3 py-3">
          <Text className="font-sans text-ui text-text">
            {current ? `Signed in as ${known.find((s) => s.serverId === current)?.user}` : "Not signed in anywhere"}
          </Text>
          {current ? <Text className="mt-0.5 font-sans text-meta text-mute">{org}</Text> : null}
        </View>
      </View>

      <Text className="px-5 pt-6 font-sans text-mute" style={{ fontSize: size.body, lineHeight: size.body * 1.6 }}>
        Who else is here, what they may do, and who may reach a workspace are set on the control
        plane’s own site. This phone reads and starts work.
      </Text>
    </ScrollView>
  );
}
