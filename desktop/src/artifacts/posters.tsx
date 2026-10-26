/**
 * Filling in the pictures the library draws.
 *
 * A version with no poster is photographed once, in the background, and never
 * again — `set_artifact_poster` writes only where there is nothing, and a
 * republish mints a new version rather than editing this one. So the work here
 * trends to zero: a library that has been looked at is a library of `<img>`.
 *
 * **One at a time, and that is the whole design.** Photographing opens a real
 * webview and renders the page in it. Six at once is the bug this replaced —
 * six documents competing for the main thread — just moved somewhere less
 * visible. A queue of one keeps the cost to whichever single page is being
 * rendered right now.
 *
 * **Driven by whoever is looking.** No server-side job and no worker: the app
 * already polls the list, so the gaps are in front of it. An artifact nobody
 * ever opens the library on is never rendered and never costs anything.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListArtifactsQueryKey,
  useListArtifacts,
} from "~/api/generated/artifacts/artifacts";
import type { Artifact } from "~/api/generated/model";
import { bridge } from "~/bridge";
import { apiBase, token } from "~/client/http";

/**
 * How long to leave a version alone after failing to photograph it.
 *
 * Without this a page that cannot be rendered — one that never finishes
 * loading, or a platform with no capture built — is retried on every poll of
 * the list, which is every few seconds, forever. Keyed on the version id
 * because that is what the attempt was about.
 */
const SULK = 10 * 60_000;

/** A stable identity, so a poll that has not answered is not a new array. */
const NOTHING: Artifact[] = [];

/**
 * How many captures must fail in a row before the library stops expecting one.
 *
 * Two rather than one: a single failure is an artifact that would not render —
 * a page stuck loading, something enormous — and giving up on the whole
 * mechanism because of one bad document would be wrong. Two in a row is the
 * platform, not the page.
 */
const GIVE_UP_AFTER = 2;

/**
 * Whether a poster is worth waiting for on this machine.
 *
 * **This is what the iframe fallback hangs off, and why it exists.** Capture is
 * native, and on Windows it is code that compiles and has never been run — so
 * "it does not work here" has to be something the interface can discover at
 * runtime rather than something decided at build time. When it does, tiles go
 * back to rendering the artifact live, which is what shipped before any of
 * this: worse, but not blank.
 *
 * `unsure` until something has either worked or failed twice, because the
 * honest state on first launch is that nobody has tried yet.
 */
type Shooting = "unsure" | "works" | "broken";
let shooting: Shooting = "unsure";
const watchers = new Set<() => void>();

function decide(next: Shooting) {
  if (next === shooting) return;
  shooting = next;
  for (const watcher of watchers) watcher();
}

function watch(cb: () => void) {
  watchers.add(cb);
  return () => void watchers.delete(cb);
}

/**
 * Whether a tile should wait for a picture or draw the page itself.
 *
 * A browser has no capture at all — it cannot read the pixels of a frame on
 * another origin — so it never waits.
 */
export function useExpectPoster(): boolean {
  const state = useSyncExternalStore(
    watch,
    () => shooting,
    () => "unsure" as Shooting,
  );
  return bridge.native && state !== "broken";
}

/**
 * Where the artifact list is kept fresh, and where its pictures get taken.
 *
 * Draws nothing. It exists to own the poll in exactly one place, which matters
 * for two reasons that pull the same way.
 *
 * **`Routes` renders one screen at a time.** The library and a workspace are
 * different routes, so a queue living in either of them stops the moment you
 * go to the other — and the library is precisely where somebody is waiting for
 * a thumbnail to appear. Mounted beside `Rail`, this runs on every screen.
 *
 * **One interval, named once.** `Workbench` and `ArtifactsPage` both read this
 * list; with a `refetchInterval` on each, which one polls depends on the screen
 * you are on, and a third reader would quietly add a third timer. They now ask
 * for the list without an interval and read what this keeps warm.
 */
export function Posters() {
  const { data } = useListArtifacts({ query: { refetchInterval: 4000 } });
  usePosters(data ?? NOTHING);
  return null;
}

export function usePosters(artifacts: Artifact[]) {
  const cache = useQueryClient();
  /* Refs rather than state throughout: none of this draws anything, and a
     re-render per attempt would be a re-render of the whole window. */
  const busy = useRef(false);
  const failed = useRef(new Map<string, number>());
  const missed = useRef(0);
  /* The latest list, so the work below reads what is true now rather than what
     was true when the effect that started it ran. */
  const latest = useRef<Artifact[]>(artifacts);
  latest.current = artifacts;

  useEffect(() => {
    if (!bridge.native || busy.current) return;

    const now = Date.now();
    const wanted = latest.current.find((a) => {
      if (a.hasPoster || !a.versionId) return false;
      const sulked = failed.current.get(a.versionId);
      return sulked === undefined || now - sulked > SULK;
    });
    if (!wanted?.versionId) return;

    busy.current = true;
    const version = wanted.versionId;

    void (async () => {
      try {
        /* `?ft-shot` asks the server not to inject the annotation picker. The
           runtime disables itself in a top-level window anyway, so this is for
           the 21 KB and the rewrite rather than for what the photo shows. */
        const png = await bridge.shoot(`${wanted.url}?ft-shot`);
        if (!png || png.byteLength === 0) throw new Error("nothing came back");

        const answer = await fetch(
          `${apiBase()}/api/v1/artifact-versions/${version}/poster`,
          {
            method: "PUT",
            headers: {
              "content-type": "image/png",
              authorization: `Bearer ${token()}`,
            },
            body: png,
          },
        );
        if (!answer.ok) throw new Error(`Firetower answered ${answer.status}`);

        /* Only now does anything redraw, and it redraws because `hasPoster`
           moved — the tile swaps its placeholder for the picture. */
        missed.current = 0;
        decide("works");
        await cache.invalidateQueries({ queryKey: getListArtifactsQueryKey() });
      } catch {
        /* Quiet on purpose. A missing thumbnail is a placeholder, which is a
           legible state; a toast about a background render is not something
           anybody asked for or can act on. */
        failed.current.set(version, Date.now());
        missed.current += 1;
        if (missed.current >= GIVE_UP_AFTER) decide("broken");
      } finally {
        busy.current = false;
      }
    })();

    /* **No cleanup, deliberately.** The list polls every few seconds, so this
       effect re-runs while a capture is still in flight — and a cleanup that
       cancelled it would abandon the render a moment before it finished, on
       every poll, and never complete a single poster. `busy` is what makes the
       re-run a no-op; the work itself is left alone to finish. Nothing here
       touches React state and the upload is idempotent server-side, so one
       that lands after an unmount is harmless.

       `artifacts` is the trigger: each poll re-runs this, which is how the
       next gap is picked up once the current one is done. */
  }, [artifacts, cache]);
}
