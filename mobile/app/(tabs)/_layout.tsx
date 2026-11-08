/**
 * Four tabs and a stack. No drawer.
 *
 * The desk splits this between a rail and a dashboard because it has room for
 * both. A phone has room for one, so the inbox *is* the workspace list with the
 * dashboard's own filter on it.
 *
 * **Config and You are two tabs on purpose.** They were one for an afternoon,
 * and a server's repositories sitting under the list of servers reads as a
 * thing and the things inside it at the same level. `You` is this phone's —
 * which Firetowers it knows, which is current, who you are on it. `Config` is
 * one server's, it is the same for everybody signed into that server, and it
 * changes the moment you switch on the tab next door. A section legend is not
 * enough to say which is which; a tab is.
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
        <NativeTabs.Trigger.Icon sf="tray" md="inbox" />
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* Named and drawn the way the desk names it — Configuration, one word. */}
      <NativeTabs.Trigger name="config">
        <NativeTabs.Trigger.Icon sf="slider.horizontal.3" md="tune" />
        <NativeTabs.Trigger.Label>Config</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Icon sf="person" md="person" />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
