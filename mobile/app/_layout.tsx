/**
 * The shell.
 *
 * **Light and dark, following the system by default.** It was dark always,
 * because `globals.css` had no light values to fall back to and a phone that
 * respected the system theme would have rendered half a design system. PR #261
 * added the light branch to that shared sheet; this is the opt-in criterion 6
 * was holding the phone still for. The control is on **You** — three settings,
 * System first — and `ThemeProvider` is above everything so a redraw reaches
 * every screen at once.
 *
 * The splash is held until the faces are loaded: Archivo is distinctive enough
 * that a frame of the system face and a reflow is the first thing that reads
 * as a web page.
 */
import "../global.css";
import { useEffect, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useFonts, Archivo_400Regular, Archivo_500Medium, Archivo_600SemiBold } from "@expo-google-fonts/archivo";
import { ArchivoNarrow_500Medium } from "@expo-google-fonts/archivo-narrow";
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";
import { BackendProvider } from "~/api/backend";
import { hydrate } from "~/native/servers";
import { useServer } from "~/native/current";
import { ThemeProvider, useTheme } from "~/design/theme";

SplashScreen.preventAutoHideAsync();

export default function Root() {
  /* The keychain is read once, before anything draws. The registry is read
     synchronously everywhere; a keychain is not, so the tokens are lifted into
     memory here rather than awaited at each call site. */
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    hydrate().finally(() => setKeys(true));
  }, []);

  const [ready] = useFonts({
    Archivo_400Regular,
    Archivo_500Medium,
    Archivo_600SemiBold,
    ArchivoNarrow_500Medium,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready || !keys) return null;

  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

/**
 * Inside the provider, because it reads the theme it is drawn in.
 *
 * A second component rather than four more lines above: `Root` is what
 * *provides* the theme, so it cannot also consume it — and the status bar is
 * the one piece of chrome that has to be told, since the system draws it and
 * dark glyphs on a near-black page are invisible either way round.
 */
function Shell() {
  const { color, scheme } = useTheme();
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.ground }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          {/* The ink, not the background: `light` means light *glyphs*. */}
          <StatusBar style={scheme === "dark" ? "light" : "dark"} />
          <Fleet />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

/* A function of the palette rather than a constant. It was a module-scope
   object reading `color.ground`, which froze whichever branch loaded first
   into every pushed screen's background — invisible in dark and a black
   flash behind every push in light. */
const screens = (ground: string) =>
  ({
    headerShown: false,
    contentStyle: { backgroundColor: ground },
    animation: "slide_from_right",
  }) as const;

/**
 * Everything below here belongs to one server.
 *
 * Keyed on it, so switching throws away the tree rather than letting a screen
 * render one server's ids against another's cache — which is the bug the
 * per-server `QueryClient` exists to make impossible, and this is the other
 * half of it.
 *
 * With no server at all there is no provider: there is nothing to be a client
 * of, and the only route that means anything is connecting.
 */
function Fleet() {
  const here = useServer();
  const { color } = useTheme();

  const stack = (
    <Stack screenOptions={screens(color.ground)}>
      <Stack.Screen name="new" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
    </Stack>
  );

  /* No server, no provider: there is nothing to be a client of, and the only
     route that means anything is connecting. `(tabs)/_layout` is what sends
     you there. */
  if (!here) return stack;

  return (
    <BackendProvider id={here.serverId} key={here.serverId}>
      {stack}
    </BackendProvider>
  );
}
