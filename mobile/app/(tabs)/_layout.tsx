/**
 * Three tabs and a stack. No drawer.
 *
 * The desk splits this between a rail and a dashboard because it has room for
 * both. A phone has room for one, so the inbox *is* the workspace list with the
 * dashboard's own filter on it.
 *
 * The tab bar gets no ember. It is furniture, and ember answers one question.
 */
import { Redirect, Tabs } from "expo-router";
import { useServer } from "~/native/current";
import { Inbox, ListTodo, User } from "lucide-react-native";
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
      <Tabs.Screen
        name="you"
        options={{ title: "You", tabBarIcon: ({ color: c, size: s }) => <User color={c} size={s - 2} /> }}
      />
    </Tabs>
  );
}
