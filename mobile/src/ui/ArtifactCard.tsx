/**
 * An artifact in the transcript: a picture of it, not a running copy.
 *
 * Ported from the desktop's `ArtifactShot`, and the lesson it carries is the
 * whole reason this is an `<Image>`. That component used to be an iframe, so a
 * library of six was six page loads of six separate origins, six copies of the
 * injected picker runtime, and six documents whose timers kept running behind
 * a grid nobody was looking at. A poster is rendered once per version and is
 * cacheable forever, because a version's bytes cannot change. The live page
 * belongs in one place — the viewer, where somebody is actually reading it.
 *
 * **No poster is an ordinary state.** A version is published before anything
 * has photographed it, so `hasPoster: false` draws a plate with the glyph on
 * it rather than an error. The same plate covers a poster that 404s — an old
 * row whose bytes went with a deleted version — because the two are the same
 * thing to look at.
 *
 * The border goes around the thumbnail and not around the tile and its label,
 * which is the choice `WorkspaceImage` already makes for a picture in prose.
 *
 * **No vertical margin of its own.** It carried `mt-4` and nothing below,
 * which was fine while the only place it went was the end of a transcript and
 * butted straight into the next message once it could be drawn inline. Whoever
 * places it says what room it gets — three positions in `Transcript`, a grid
 * in the library — because the three do not want the same rhythm and one of
 * them wants it on both sides.
 */
import { useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { Shapes } from "lucide-react-native";
import type { Artifact } from "~/api/generated/model";
import { apiBase, token } from "~/client/http";
import { elapsed, minutesSince } from "~/api/view";
import { useTheme } from "~/design/theme";

/** Width over height. The crop keeps this shape at every size. */
const RATIO = 16 / 10;

export function ArtifactCard({ artifact, onOpen }: { artifact: Artifact; onOpen: () => void }) {
  const { color } = useTheme();
  /* A poster the server says exists can still fail to load, and the
     placeholder is the same either way — so this collapses into one flag. */
  const [broken, setBroken] = useState(false);
  const showing = artifact.hasPoster && !broken;

  return (
    <Pressable testID="artifact-card" onPress={onOpen} android_ripple={{ color: color.overlay }}>
      <View className="w-full overflow-hidden rounded-card border border-line bg-float" style={{ aspectRatio: RATIO }}>
        {showing ? (
          <Image
            /* The bytes are fetched by `Image` rather than carried through
               JavaScript, for the reason `WorkspaceImage` gives. The token
               rides on the request because the poster is behind the API. */
            source={{ uri: `${apiBase()}${artifact.posterUrl}`, headers: { Authorization: `Bearer ${token()}` } }}
            resizeMode="cover"
            onError={() => setBroken(true)}
            className="h-full w-full"
          />
        ) : (
          <View className="h-full w-full items-center justify-center gap-[7px]">
            <Shapes color={color.settling} size={22} />
            {/* **It is a state, not a failure.** A version is published before
                anything has photographed it, so a fresh library hits this on
                every tile at once — and a plate with no words on it reads as
                a broken image. The same plate covers a poster that 404s,
                because the two are the same thing to look at. */}
            <Text className="font-sans text-micro text-mute">no picture yet</Text>
          </View>
        )}
      </View>

      <View className="mt-1.5 flex-row items-baseline gap-2">
        <Text numberOfLines={1} className="min-w-0 flex-1 font-medium text-ui text-bone">
          {artifact.title}
        </Text>
        <Text className="font-mono text-micro text-mute">v{artifact.version}</Text>
        <Text className="font-sans text-micro text-mute">{elapsed(minutesSince(artifact.updatedAt))}</Text>
      </View>
    </Pressable>
  );
}
