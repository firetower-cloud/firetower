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
import { Check, Plus } from "lucide-react-native";
import { forget, onServers, servers, type Connected } from "~/native/servers";
import { choose, useServer } from "~/native/current";
import { color } from "~/design/tokens.generated";

export default function You() {
  const insets = useSafeAreaInsets();
  /* The registry, not a fixture: this list is the one piece of state that is
     genuinely the phone's rather than any server's. */
  const known = useSyncExternalStore(onServers, servers, servers);
  const current = useServer()?.serverId;

  return (
    <ScrollView
      className="flex-1 bg-ground"
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}
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

      <Text className="mb-2 mt-8 px-4 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        Account
      </Text>
      <View className="px-2">
        <View className="rounded-lg px-3 py-3">
          <Text className="font-sans text-ui text-text">
            {current ? `Signed in as ${known.find((s) => s.serverId === current)?.user}` : "Not signed in anywhere"}
          </Text>
          {current ? (
            <Text className="mt-0.5 font-sans text-meta text-mute">
              {known.find((s) => s.serverId === current)?.org}
            </Text>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}
