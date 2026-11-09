/**
 * The account cannot do anything here until its password is replaced.
 *
 * A route rather than a panel inside the tabs, for the same reason `/connect`
 * is one: the tab layout is a navigator, and returning something that is not a
 * navigator from it leaves the router with a child route and nowhere to put
 * it. `(tabs)/_layout` sends you here, exactly as it sends you to `/connect`
 * when there is no server.
 *
 * Replacing the password is not offered. It is done on the control plane's own
 * interface, in a browser, which is the one surface that is always the same
 * version as the server behind it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { View } from "react-native";
import { LEDE_GUTTER, useEdges } from "~/ui/edges";
import { useServer } from "~/native/current";
import { ReplacePassword } from "~/ui/ReplacePassword";
import { useTheme } from "~/design/theme";

export default function Locked() {
  const { color } = useTheme();
  const edges = useEdges({ gutter: LEDE_GUTTER, top: 24, bottom: 24 });
  const cache = useQueryClient();
  const here = useServer();
  if (!here) return null;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: color.ground,
        justifyContent: "center",
        ...edges,
      }}
    >
      <ReplacePassword
        url={here.url}
        username={here.user}
        retryLabel="I've replaced it"
        onRetry={() => {
          // Everything, not the one key this screen reads: being let in changes
          // the answer to every question the app has already cached as a
          // refusal.
          void cache.invalidateQueries();
          router.replace("/");
        }}
      />
    </View>
  );
}
