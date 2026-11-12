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
 * page's fault no longer.
 *
 * This is the *runtime* answer, and it is now the second one asked. A platform
 * with no capture built says so outright — see [`askTheShell`] — so what is
 * left for this to catch is capture that exists and does not work, which is
 * every Windows machine until somebody runs one.
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
 * `unsure` until the shell has answered or something has failed twice, because
 * the honest state on first launch is that nobody has asked yet.
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
 * Ask the shell whether this machine can photograph a page at all.
 *
 * **The library used to work this out by counting failures, and on Linux it
 * never finished counting.** `useExpectPoster` only goes false at
 * `GIVE_UP_AFTER` consecutive refusals; the effect below re-runs off the
 * polled list, and React Query hands back the *same array reference* when a
 * poll changes nothing. So on a platform where every capture fails, nothing
 * ever changed, the effect never ran again, exactly one failure was ever
 * recorded, and the library drew a grid of seven identical grey plates with no
 * sentence under it — for eight and a half minutes, measured, which is to say
 * forever. Which is the precise state the list view exists to prevent.
 *
 * So it is asked instead of inferred. `capture.rs` compiles to
 * `SUPPORTED = false` off macOS and Windows and the answer comes back in a
 * tick, before anybody has opened the library.
 *
 * Exported for the test, and called once by [`Posters`].
 */
export async function askTheShell() {
  if (!bridge.native) return;
  /* A shell too old to answer the question is not evidence that it cannot
     photograph anything, so a refusal to answer leaves this `unsure` and the
     runtime count below is what decides — which is what happened before this
     was asked at all. */
  const can = await bridge.canShoot().catch(() => true);
  if (!can) decide("broken");
}

/**
 * Whether a tile should wait for a picture or draw the page itself.
 *
 * A browser has no capture at all — it cannot read the pixels of a frame on
 * another origin — so it never waits.
 */
export function expectPoster(): boolean {
  return bridge.native && shooting !== "broken";
}

export function useExpectPoster(): boolean {
  return useSyncExternalStore(watch, expectPoster, () => expectPoster());
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
  /* Once, as early as there is a shell to ask. Mounted beside `Rail`, this is
     up before any screen that draws a tile — and the library reads the answer
     live rather than freezing it, so even a cold launch straight into the
     library settles on the right view before the list has arrived. */
  useEffect(() => void askTheShell(), []);
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
    /** The next gap, photographed — then the one after it. */
    const attempt = () => {
      /* Nothing to try on a machine that has already said it cannot: two
         refusals, or the shell answering outright. Asking anyway is an
         offscreen webview per artifact for a picture that is not coming. */
      if (!bridge.native || busy.current || shooting === "broken") return;

      const now = Date.now();
      const wanted = latest.current.find((a) => {
        if (a.hasPoster || !a.versionId) return false;
        const sulked = failed.current.get(a.versionId);
        return sulked === undefined || now - sulked > SULK;
      });
      if (!wanted?.versionId) return;

      busy.current = true;
      const version = wanted.versionId;

      /* Whether to go straight on to the next gap, which only a failure
         wants. Read in the `finally`, so `busy` is already down by then. */
      let again = false;

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
             moved — the tile swaps its placeholder for the picture. And that
             moved list is a new array, which re-runs this effect and picks up
             the next gap. */
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
          again = true;
        } finally {
          busy.current = false;
          /* **On to the next one, here rather than on the next poll.** A
             failure changes nothing about the list, React Query hands back the
             same array reference when nothing changed, and this effect's deps
             are that array — so waiting for the poll meant that a platform
             where every capture fails recorded exactly *one* failure and never
             reached `GIVE_UP_AFTER`. `SULK` is what keeps this from spinning:
             each version is tried once and then left alone for ten minutes,
             and two failures in a row stop it entirely. */
          if (again) attempt();
        }
      })();
    };

    attempt();

    /* **No cleanup, deliberately.** The list polls every few seconds, so this
       effect re-runs while a capture is still in flight — and a cleanup that
       cancelled it would abandon the render a moment before it finished, on
       every poll, and never complete a single poster. `busy` is what makes the
       re-run a no-op; the work itself is left alone to finish. Nothing here
       touches React state and the upload is idempotent server-side, so one
       that lands after an unmount is harmless.

       `artifacts` is the trigger: each poll re-runs this, which is how the
       next gap is picked up once a picture has actually landed. */
  }, [artifacts, cache]);
}
