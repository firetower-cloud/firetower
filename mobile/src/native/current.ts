/**
 * Which Firetower the app is pointed at.
 *
 * One at a time, switched explicitly — Slack's model, and the desktop's
 * `scope` with the fleet view taken away. Only the current server holds a
 * socket: four self-hosted control planes streaming at once is four radio
 * wakeups on cellular, for a question push notifications answer better.
 */
import { useSyncExternalStore } from "react";
import { MMKV } from "react-native-mmkv";
import { createMMKV } from "react-native-mmkv";
import { onServers, servers, type Connected } from "~/native/servers";

const store = createMMKV({ id: "firetower.current" });
const KEY = "serverId";

const watchers = new Set<() => void>();
const changed = () => watchers.forEach((w) => w());

function subscribe(fn: () => void) {
  watchers.add(fn);
  const off = onServers(fn);
  return () => {
    watchers.delete(fn);
    off();
  };
}

/** The chosen server, or the first one this phone knows about. */
function snapshot(): Connected | null {
  const all = servers();
  if (all.length === 0) return null;
  const want = store.getString(KEY);
  return all.find((s) => s.serverId === want) ?? all[0];
}

export function useServer(): Connected | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function choose(serverId: string) {
  store.set(KEY, serverId);
  changed();
}

export const currentServer = snapshot;
