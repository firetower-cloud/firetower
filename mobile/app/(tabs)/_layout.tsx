/**
 * Four tabs and a stack. No drawer.
 *
 * **Dashboard, Tasks, Artifacts, You** — and three of the four are the desk's
 * own words for the same objects: `Dashboard`, `Tasks` and `Artifacts` are its
 * ⌘1, ⌘2 and ⌘3, same object, same word, same glyph. A phone does not get a
 * different name for a thing the desk already named.
 *
 * Two of those are changes, and both are the redesign catching up with what
 * the desk deleted:
 *
 * - **Not `Inbox`.** The desk retired `Fleet.tsx`, which its own delta table
 *   calls *the unified inbox as a screen*. A phone still calling it the Inbox
 *   would be the only client naming a concept the product removed.
 * - **Not `Config`.** The desk's Configuration *screen* is gone too — its
 *   panes moved into the destinations they belong to. A Config tab mirrors a
 *   screen the redesign deleted, which is the same failure one word over. Its
 *   single phone-relevant pane, Repositories, is now reachable from the two
 *   places it is actually wanted: the composer's shelf on the home, and a
 *   section of **You** named for the current server.
 *
 * That last one reverses an argument this file used to make — that Config and
 * You must be two tabs, because a server's repositories under the list of
 * servers reads as a thing and the things inside it at the same level. The
 * observation was right and the fix was wrong: what says which is which is the
 * *heading*, and the heading is now the server's own name, which changes the
 * moment you switch above it. `mobile/STYLE.md` still describes the old four
 * and is stale on this; see the note there.
 *
 * The fourth slot is the person, because a phone has no foot of a rail to put
 * them at.
 *
 * The tab bar gets no ember. It is furniture, and ember answers one question.
 */
import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useServer } from "~/native/current";
import { useGate } from "~/data";
import { useTheme } from "~/design/theme";

export default function TabLayout() {
  /**
   * With no Firetower there is nothing to be the client of.
   *
   * The guard lives here rather than in the root layout because declaring a
   * `Stack.Screen` configures a route, it does not gate one — the router still
   * rendered the tabs, the inbox called `useQueryClient`, and there was no
   * provider above it. `Redirect` returns before any child renders, which is
   * the only place this can be done without that one frame.
   */
  const here = useServer();
  if (!here) return <Redirect href="/connect" />;
  return <Signed />;
}

/**
 * Inside the provider, so it can ask the server about the account.
 *
 * A second component rather than two more lines above: `useGate` needs the
 * `QueryClient` that only exists once there is a server, and calling it before
 * the `!here` return would be a hook behind a condition.
 */
function Signed() {
  const { color } = useTheme();
  const { locked, ready } = useGate();

  /* Signed in with a password the server will not accept any work under. Not
     rendered here: this layout is a navigator, and returning a panel from it
     leaves the router with a child route and nowhere to put it. */
  if (ready && locked) return <Redirect href="/locked" />;

  /**
   * `NativeTabs`, not `Tabs`, and that is the whole point.
   *
   * On iPhone Duo the system lifts navigation and tab bars out of the bottom
   * and lays them vertically down the trailing edge — but it can only move a
   * bar it owns. A JavaScript tab bar stays where it was drawn, which on a
   * folded Duo is a row of furniture across the narrow end of the screen.
   *
   * The cost is the hand-styled `tabBarStyle` that used to be here. A system
   * bar takes the system's colours, and that is the trade: the tab bar was
   * never carrying meaning — it is furniture, and ember answers one question.
   *
   * Every trigger has an icon as well as a label on purpose. Apple's rule for
   * a vertical bar is that an item with a title and no icon is not presented
   * vertically at all, so a label-only tab would silently fall out of the rail.
   */
  return (
    /* The system owns the shape and the material — `backgroundColor` is a no-op
       from iOS 26 on, because the bar is drawn by the OS. What it does hand over
       is the ink, so the rail takes bone-on-mute like the rest of the app
       instead of the stock accent blue. */
    <NativeTabs
      tintColor={color.bone}
      iconColor={{ default: color.mute, selected: color.bone }}
      labelStyle={{ default: { color: color.mute }, selected: { color: color.bone } }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="house" md="home" />
        <NativeTabs.Trigger.Label>Dashboard</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* ⌘3 on the desk, the third slot here. A destination rather than a
          pushed route: artifacts outlive the workspace that made them —
          `artifacts` has foreign keys to `users` and `organizations` and to
          nothing else — so the library is yours, not a workspace's. */}
      <NativeTabs.Trigger name="artifacts">
        <NativeTabs.Trigger.Icon sf="square.on.circle" md="category" />
        <NativeTabs.Trigger.Label>Artifacts</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Icon sf="person" md="person" />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
