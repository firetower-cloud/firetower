/**
 * An artifact, full screen, as the page it is.
 *
 * The one place the live bytes are mounted. Everywhere else — the card in the
 * transcript, the tiles in the library — is a poster, for the reason
 * `ArtifactCard` gives.
 *
 * **Loaded with `?ft-shot`.** That flag asks the control plane not to inject
 * the annotation picker, and the phone is not an annotation surface yet. It
 * saves a 21 KB runtime and the HTML rewrite that produces it on every open,
 * and it caches correctly: the server puts the flag in the `ETag` precisely
 * because it selects between two different bodies.
 *
 * Annotation is reachable from here and deliberately not taken. The picker
 * wakes up if the page is embedded in a frame whose parent speaks for a
 * panel — the desktop's trick — and selections do reach native code that way.
 * What is missing is the save: `KeepAnnotation` wants an `ElementSnapshot`
 * and a `port`, and an artifact carries a version id rather than a port, so
 * the mapping is a design question rather than a wiring one. A composer that
 * collects a note and drops it is worse than no composer, so there is none.
 */
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { WebView as Untyped } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, MoreHorizontal } from "lucide-react-native";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { ArtifactMenu } from "~/ui/ArtifactMenu";
import { Waiting } from "~/ui/Waiting";
import { useTheme } from "~/design/theme";

/**
 * `react-native-webview` 14 is a class component written before React 19
 * tightened what may be a JSX element type, so its props resolve to `never`
 * and every one of them is an error. This names only what this screen passes
 * and should come out whole when the library is published against React 19.
 */
type Webish = {
  source: { uri: string };
  javaScriptEnabled?: boolean;
  originWhitelist?: string[];
  style?: { flex: number; backgroundColor: string };
  startInLoadingState?: boolean;
  renderLoading?: () => React.ReactElement;
};
const WebView = Untyped as unknown as React.ComponentType<Webish>;

export default function ArtifactScreen() {
  const { color } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState(false);
  const { data: artifacts, isPending } = useListArtifacts();

  const artifact = useMemo(() => (artifacts ?? []).find((a) => a.id === id) ?? null, [artifacts, id]);

  /* One source, built once. A `WebView` reloads on any `source` change, so a
     fresh object every render is a page that never finishes loading. */
  const source = useMemo(() => {
    if (!artifact?.url) return null;
    const url = artifact.url.includes("?") ? `${artifact.url}&ft-shot` : `${artifact.url}?ft-shot`;
    return { uri: url };
  }, [artifact?.url]);

  return (
    <View
      className="flex-1 bg-ground"
      style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}
    >
      <View className="flex-row items-center gap-1 border-b border-line-soft pb-2 pl-1">
        <Pressable onPress={() => router.back()} className="h-10 w-10 items-center justify-center" hitSlop={8}>
          <ChevronLeft color={color.bone} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="font-medium text-title text-bone">
            {artifact?.title ?? "Artifact"}
          </Text>
          {artifact ? (
            <Text numberOfLines={1} className="mt-0.5 font-mono text-meta text-mute">
              {artifact.path}
            </Text>
          ) : null}
        </View>
        {artifact ? (
          <View className="mr-1 rounded-sm bg-raise px-2 py-1">
            <Text className="font-mono text-micro text-dim">v{artifact.version}</Text>
          </View>
        ) : null}
        {artifact ? (
          <Pressable
            testID="artifact-menu"
            accessibilityLabel="More"
            onPress={() => setMenu(true)}
            className="h-11 w-11 items-center justify-center"
            hitSlop={8}
          >
            <MoreHorizontal color={color.dim} size={21} />
          </Pressable>
        ) : null}
      </View>

      {isPending ? (
        <View className="flex-1 items-center justify-center">
          <Waiting say="Finding this artifact" />
        </View>
      ) : !source ? (
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-center font-sans text-ui text-mute">That artifact is not here any more.</Text>
        </View>
      ) : (
        <WebView
          source={source}
          /* Somebody's published HTML, not ours. It gets no bridge and nothing
             injected. */
          javaScriptEnabled
          originWhitelist={["*"]}
          style={{ flex: 1, backgroundColor: color.ground }}
          startInLoadingState
          renderLoading={() => (
            <View className="flex-1 items-center justify-center bg-ground">
              <ActivityIndicator color={color.mute} />
            </View>
          )}
        />
      )}
      {menu && artifact ? (
        <ArtifactMenu
          title={artifact.title}
          path={artifact.path}
          version={artifact.version}
          address={artifact.url}
          onClose={() => setMenu(false)}
          onWorkspace={
            artifact.fromSessionId
              ? () => {
                  setMenu(false);
                  router.push(`/workspace/${artifact.fromSessionId}`);
                }
              : undefined
          }
        />
      ) : null}
    </View>
  );
}
