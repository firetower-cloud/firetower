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
import { Redirect, Tabs } from "expo-router";
import { useServer } from "~/native/current";
import { useGate } from "~/data";
import { Inbox, ListTodo, Settings2, User } from "lucide-react-native";
import { color, size } from "~/design/tokens.generated";

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
  const { locked, ready } = useGate();

  /* Signed in with a password the server will not accept any work under. Not
     rendered here: this layout is a navigator, and returning a panel from it
     leaves the router with a child route and nowhere to put it. */
  if (ready && locked) return <Redirect href="/locked" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: color.bone,
        tabBarInactiveTintColor: color.mute,
        tabBarStyle: {
          backgroundColor: color.panel,
          borderTopColor: color["line-soft"],
          borderTopWidth: 1,
        },
        tabBarLabelStyle: {
          fontFamily: "Archivo_500Medium",
          fontSize: size.micro,
          letterSpacing: 0.2,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Inbox", tabBarIcon: ({ color: c, size: s }) => <Inbox color={c} size={s - 2} /> }}
      />
      <Tabs.Screen
        name="tasks"
        options={{ title: "Tasks", tabBarIcon: ({ color: c, size: s }) => <ListTodo color={c} size={s - 2} /> }}
      />
      {/* Named and drawn the way the desk names and draws it — `Settings2` is
          what its rail carries for Configuration. Three clients, one word for
          the same place. */}
      <Tabs.Screen
        name="config"
        options={{ title: "Config", tabBarIcon: ({ color: c, size: s }) => <Settings2 color={c} size={s - 2} /> }}
      />
      <Tabs.Screen
        name="you"
        options={{ title: "You", tabBarIcon: ({ color: c, size: s }) => <User color={c} size={s - 2} /> }}
      />
    </Tabs>
  );
}
