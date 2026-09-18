/**
 * A picture the agent pointed at, drawn where it pointed.
 *
 * `![the failing state](docs/shot.png)` used to render an `<img>` at the app's
 * own origin, which is a broken image on a good day — and on the desktop shell
 * not even that, because the CSP allows `blob:` and `data:` for images and not
 * `http:`. The bytes have to come through the API client, with the session's
 * bearer token, and be handed to the browser as a blob.
 *
 * The src is resolved the same way a path in prose is: by asking the workspace
 * whether it is real, by the last segment. An agent writes the path it was
 * working with, not the path relative to wherever the markdown ended up, and
 * `resolvePath` is what already absorbs that difference everywhere else.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { ImageOff } from "lucide-react";
import { useFileText } from "~/api/text";
import { resolvePath } from "~/paths";
import { why } from "~/data";

/**
 * Which session the pictures in some markdown belong to.
 *
 * Markdown is rendered in places that have no session at all — the changelog,
 * the setup pages — so the default is "no session", and without one a picture
 * reading from a workspace is simply not offered.
 */
export const ImagesFrom = createContext<{
  session: string | null;
  /** Offered on the picture, when the surrounding view has tabs to open it in. */
  onOpen?: (path: string, keep?: boolean) => void;
}>({ session: null });

/** Whether a markdown `src` is something to fetch out of the workspace. */
export function isWorkspaceSrc(src: string | undefined): src is string {
  if (!src) return false;
  return !/^(https?:|data:|blob:|\/\/)/i.test(src);
}

export function WorkspaceImage({ src, alt }: { src: string; alt?: string }) {
  const { session } = useContext(ImagesFrom);
  /* `undefined` while it is being looked for, `null` once it is known not to
     be there — the two need different words on screen. */
  const [path, setPath] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!session) return;
    let live = true;
    resolvePath(session, src).then((found) => live && setPath(found));
    return () => {
      live = false;
    };
  }, [session, src]);

  if (!session) return <Caption alt={alt} src={src}>no workspace to read it from</Caption>;
  if (path === undefined) return <Caption alt={alt} src={src}>looking for it…</Caption>;
  if (path === null) return <Caption alt={alt} src={src}>not in this workspace</Caption>;
  return <Drawn session={session} path={path} alt={alt} />;
}

/** Split out so the hooks below only ever run once there is a path to run them on. */
function Drawn({ session, path, alt }: { session: string; path: string; alt?: string }) {
  const { onOpen } = useContext(ImagesFrom);
  const remote = useFileText(session, path);

  if (remote.isPending) return <Caption alt={alt} src={path}>reading it off the worker…</Caption>;
  if (remote.error) return <Caption alt={alt} src={path}>{why(remote.error)}</Caption>;
  if (remote.data?.kind !== "image") return <Caption alt={alt} src={path}>not a picture</Caption>;

  return (
    <span className="my-3 block">
      <img
        src={remote.data.url}
        alt={alt ?? path}
        onClick={() => onOpen?.(path, true)}
        title={onOpen ? `${path} — click to open it in a tab` : path}
        className={`max-h-[420px] max-w-full rounded-md border border-line object-contain ${onOpen ? "cursor-zoom-in" : ""}`}
      />
      {alt && <span className="mt-1 block text-meta text-mute">{alt}</span>}
    </span>
  );
}

/**
 * A picture that is not there, said in one line.
 *
 * Inline rather than a box: this sits in the middle of a sentence the agent
 * was writing, and a missing screenshot is worth a line, not a panel.
 */
function Caption({ alt, src, children }: { alt?: string; src: string; children: React.ReactNode }) {
  return (
    <span className="my-1 inline-flex max-w-full items-center gap-1.5 align-middle text-meta text-mute">
      <ImageOff className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 truncate font-mono">{alt || src}</span>
      <span className="shrink-0">— {children}</span>
    </span>
  );
}
