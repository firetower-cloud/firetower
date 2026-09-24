/**
 * A picture the agent pointed at, drawn where it pointed.
 *
 * `![the failing state](docs/shot.png)` is how an agent shows you what it did,
 * and until this existed the phone drew the six characters of markdown syntax
 * instead — the one client where a screenshot matters most, showing the least.
 *
 * The bytes are not read here. `useFileText` answers a picture with an address
 * and the header to ask for it with, and `Image` fetches it itself: a
 * screenshot is megabytes, and carrying it through JavaScript to hand back a
 * data URI costs the memory twice for no gain.
 *
 * The src is resolved the way a path in prose is — by asking the workspace,
 * by the last segment — because an agent writes the path it was working with,
 * not one relative to wherever the markdown ended up.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
import { ImageOff } from "lucide-react-native";
import { useFileText } from "~/api/text";
import { resolvePath, resolvedPath } from "~/api/paths";
import { color } from "~/design/tokens.generated";

/**
 * Which session the pictures in some markdown belong to.
 *
 * Prose is rendered in places with no session at all, so the default is "no
 * session", and without one a picture reading from a workspace is not offered.
 */
export const ImagesFrom = createContext<{ session: string | null }>({ session: null });

/** Whether a markdown `src` is something to fetch out of the workspace. */
export function isWorkspaceSrc(src: string | undefined): src is string {
  if (!src) return false;
  return !/^(https?:|data:|blob:|\/\/)/i.test(src);
}

export function WorkspaceImage({ src, alt }: { src: string; alt?: string }) {
  const { session } = useContext(ImagesFrom);
  /* Seeded from what is already known rather than starting undecided: this
     remounts on every delta of a streaming turn, and a remount that begins
     undecided draws a caption before drawing the image again. */
  const [path, setPath] = useState<string | null | undefined>(() =>
    session ? resolvedPath(session, src) : undefined,
  );

  useEffect(() => {
    if (!session) return;
    const cached = resolvedPath(session, src);
    if (cached !== undefined) {
      setPath(cached);
      return;
    }
    let live = true;
    resolvePath(session, src).then((found) => live && setPath(found));
    return () => {
      live = false;
    };
  }, [session, src]);

  if (!session) return <Caption alt={alt} src={src} why="no workspace to read it from" />;
  if (path === undefined) return <Caption alt={alt} src={src} why="looking for it…" />;
  if (path === null) return <Caption alt={alt} src={src} why="not in this workspace" />;
  return <Drawn session={session} path={path} alt={alt} />;
}

/** Split out so the hooks below only run once there is a path to run them on. */
function Drawn({ session, path, alt }: { session: string; path: string; alt?: string }) {
  const remote = useFileText(session, path);
  /* Reserved rather than measured-then-grown. A picture whose height arrives
     with its bytes pushes the rest of the turn down as it lands; starting at
     the shape most screenshots are and correcting on load keeps the movement
     to whatever the correction is. */
  const [ratio, setRatio] = useState(16 / 10);

  if (remote.isPending) return <Caption alt={alt} src={path} why="reading it off the worker…" />;
  if (remote.error) return <Caption alt={alt} src={path} why="couldn't read it" />;
  if (remote.data?.kind !== "image") return <Caption alt={alt} src={path} why="not a picture" />;

  return (
    <View className="my-2">
      <Image
        source={{ uri: remote.data.url, headers: remote.data.headers }}
        onLoad={(e) => {
          const { width, height } = e.nativeEvent.source ?? {};
          if (width && height) setRatio(width / height);
        }}
        resizeMode="contain"
        className="w-full rounded-md border border-line"
        style={{ aspectRatio: ratio }}
      />
      {alt ? <Text className="mt-1 font-sans text-meta text-mute">{alt}</Text> : null}
    </View>
  );
}

/**
 * A picture that is not there, said in one line.
 *
 * Inline rather than a box: this sits in the middle of a sentence the agent
 * was writing, and a missing screenshot is worth a line, not a panel.
 */
function Caption({ alt, src, why }: { alt?: string; src: string; why: string }) {
  return (
    <View className="my-1 flex-row items-center gap-1.5">
      <ImageOff color={color.mute} size={13} />
      <Text numberOfLines={1} className="flex-1 font-mono text-meta text-mute">
        {alt || src} — {why}
      </Text>
    </View>
  );
}
