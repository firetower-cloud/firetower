/**
 * The shell.
 *
 * Dark, always — `web/app/globals.css` sets `color-scheme: dark` and the token
 * set has no light values, so respecting the system theme would render half a
 * design system. The splash is held until the faces are loaded: Archivo is
 * distinctive enough that a frame of the system face and a reflow is the first
 * thing that reads as a web page.
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
import { color } from "~/design/tokens.generated";

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
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.ground }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Fleet />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const SCREENS = {
  headerShown: false,
  contentStyle: { backgroundColor: color.ground },
  animation: "slide_from_right",
} as const;

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

  const screens = (
    <Stack screenOptions={SCREENS}>
      <Stack.Screen name="new" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
    </Stack>
  );

  /* No server, no provider: there is nothing to be a client of, and the only
     route that means anything is connecting. `(tabs)/_layout` is what sends
     you there. */
  if (!here) return screens;

  return (
    <BackendProvider id={here.serverId} key={here.serverId}>
      {screens}
    </BackendProvider>
  );
}
