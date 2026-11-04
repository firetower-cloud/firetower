/**
 * An artifact, full screen, and annotatable.
 *
 * The one place the live bytes are mounted — everywhere else is a poster, for
 * the reason `ArtifactCard` gives.
 *
 * **The page is embedded rather than loaded directly.** Firetower injects its
 * picker into every artifact it serves, and that runtime refuses to switch on
 * in a top-level document. A webview is top-level, so loading the URL straight
 * gets a page with a sleeping picker in it. `wrapper()` puts the artifact in a
 * frame and speaks for the panel, which is the same move the desktop makes —
 * and once the embedder says hello the runtime hides its own toolbar and its
 * own 380px sidebar, leaving the chrome to whoever is hosting it. On a phone
 * that is the right trade: a sidebar built for a desk is most of a 466pt
 * screen, and a sheet is not.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View, useWindowDimensions, type ViewStyle } from "react-native";
import { WebView as Untyped, type WebViewMessageEvent } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, MessageSquarePlus, X } from "lucide-react-native";
import { useListArtifacts } from "~/api/generated/artifacts/artifacts";
import { apiBase } from "~/client/http";
import { wrapper, type FromPicker, type ToPicker } from "~/ui/annotate";
import { Waiting } from "~/ui/Waiting";
import { color } from "~/design/tokens.generated";

/**
 * `react-native-webview` 14 is a class component written before React 19
 * tightened what may be a JSX element type, so its props resolve to `never`
 * and every one of them is an error. The runtime is unaffected — this names
 * only the handful of props this screen passes, and should come out whole
 * when the library is published against React 19.
 */
type Webish = {
  ref?: React.Ref<{ injectJavaScript(js: string): void }>;
  source: { html: string; baseUrl: string };
  onMessage: (event: WebViewMessageEvent) => void;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  originWhitelist?: string[];
  style?: ViewStyle;
  startInLoadingState?: boolean;
  renderLoading?: () => React.ReactElement;
};
const WebView = Untyped as unknown as React.ComponentType<Webish>;

/**
 * Where the composer goes.
 *
 * Beside the page when there is room for both and underneath it when there is
 * not — the Duo's inner display is the first phone screen wide enough for the
 * first, and the fold collapses it back to the second without a second layout
 * to maintain.
 */
const BESIDE = 700;

export default function ArtifactScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const web = useRef<{ injectJavaScript(js: string): void }>(null);

  const { data: artifacts, isPending } = useListArtifacts();
  const artifact = useMemo(() => (artifacts ?? []).find((a) => a.id === id) ?? null, [artifacts, id]);

  const [annotating, setAnnotating] = useState(false);
  const [picked, setPicked] = useState<FromPicker & { type: "selection" } | null>(null);
  const [note, setNote] = useState("");

  const beside = width >= BESIDE;

  /* Built once. A `WebView` reloads on any `source` change, so a fresh object
     every render is a page that never finishes loading. */
  const source = useMemo(() => {
    if (!artifact?.url) return null;
    /* No `Authorization` here: an artifact is served from a hostname that is
       itself the capability, which is why it answers an unauthenticated GET
       and why each one is a separate origin. */
    return { html: wrapper(artifact.url, apiBase()), baseUrl: apiBase() };
  }, [artifact?.url]);

  const tell = useCallback((message: ToPicker) => {
    web.current?.injectJavaScript(`window.__ft && window.__ft(${JSON.stringify(message)}); true;`);
  }, []);

  const heard = useCallback((event: WebViewMessageEvent) => {
    let data: FromPicker;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    /* Only the three the phone has a use for. `located`, `focus-note`,
       `found` and `find-bar` belong to a find bar and a pin list the phone
       does not draw, and answering them with nothing is correct. */
    if (data.type === "mode") setAnnotating(data.enabled);
    if (data.type === "selection") setPicked(data);
    if (data.type === "navigated") setPicked(null);
  }, []);

  const stop = () => {
    setPicked(null);
    setNote("");
    setAnnotating(false);
    tell({ type: "mode", enabled: false });
    tell({ type: "clear" });
  };

  const composer = picked ? (
    <View
      className={beside ? "w-[340px] border-l border-line-soft bg-panel" : "border-t border-line-soft bg-panel"}
      style={beside ? undefined : { paddingBottom: Math.max(insets.bottom, 10) }}
    >
      <View className="flex-row items-start gap-2 px-4 pb-2 pt-3">
        <View className="min-w-0 flex-1">
          <Text className="font-narrow text-micro uppercase tracking-[0.18em] text-mute">On this element</Text>
          <Text numberOfLines={1} className="mt-1 font-mono text-meta text-dim">
            {picked.label || picked.path || "element"}
          </Text>
          {picked.text ? (
            <Text numberOfLines={2} className="mt-1 font-sans text-meta text-text">
              {picked.text}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={stop} className="h-9 w-9 items-center justify-center" hitSlop={8}>
          <X color={color.dim} size={18} />
        </Pressable>
      </View>

      <View className="px-3 pb-3">
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="What about it?"
          placeholderTextColor={color.mute}
          multiline
          className="min-h-[72px] rounded-lg bg-raise px-3.5 py-3 font-sans text-read text-bone"
          style={{ textAlignVertical: "top" }}
        />
        <Pressable
          onPress={stop}
          className={`mt-2 h-12 items-center justify-center rounded-md ${note.trim() ? "bg-ember" : "bg-raise"}`}
        >
          <Text className={`font-semibold text-ui ${note.trim() ? "text-ground" : "text-mute"}`}>Leave the note</Text>
        </Pressable>
      </View>
    </View>
  ) : null;

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
        {/* The one control the picker hands over. Ember only while it is on:
            annotating is a mode, and a mode you cannot see is a trap. */}
        <Pressable
          testID="annotate"
          onPress={() => {
            const next = !annotating;
            setAnnotating(next);
            if (!next) setPicked(null);
            tell({ type: "mode", enabled: next });
          }}
          className={`mr-2 h-9 w-9 items-center justify-center rounded-md ${annotating ? "bg-ember" : "bg-raise"}`}
          hitSlop={6}
        >
          <MessageSquarePlus color={annotating ? color.ground : color.dim} size={18} />
        </Pressable>
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
        <View className={beside ? "min-h-0 flex-1 flex-row" : "min-h-0 flex-1"}>
          <WebView
            ref={web}
            source={source}
            onMessage={heard}
            javaScriptEnabled
            domStorageEnabled
            originWhitelist={["*"]}
            style={{ flex: 1, backgroundColor: color.ground }}
            startInLoadingState
            renderLoading={() => (
              <View className="flex-1 items-center justify-center bg-ground">
                <ActivityIndicator color={color.mute} />
              </View>
            )}
          />
          {composer}
        </View>
      )}
    </View>
  );
}
