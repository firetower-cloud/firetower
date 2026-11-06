import { useEffect, useMemo, useState } from "react";
import { Titlebar } from "~/ui/Titlebar";
import { Rail } from "~/ui/Rail";
import { Routes } from "~/Routes";
import { Posters } from "~/artifacts/posters";
import { useFleet, waitingIn, asBackend as liveBackend } from "~/fleet";
import { lazy, Suspense } from "react";
import type { Backend } from "~/fleet";
import { BackendProvider, dropCache } from "~/backend";
import { bridge } from "~/bridge";
import { StartProvider } from "~/start";
import { Connect } from "~/ui/Connect";
import { servers, onServers } from "~/servers";
import { Boundary } from "~/ui/Boundary";
import { Gate } from "~/ui/Gate";
import { navigate, usePathname } from "~/shims/next-navigation";
import { offerUpdate, useBuild } from "~/update";
import { startCourier } from "~/telemetry";
import { islandState } from "~/island/state";
import { useConfirm } from "~/ui/Confirm";

const StylePage = import.meta.env.DEV ? lazy(() => import("~/ui/StylePage").then((m) => ({ default: m.StylePage }))) : () => null;

const WHICH = "firetower.current";
/** What this used to be called, when it could also hold `"all"`. */
const WAS = "firetower.scope";

export function App() {
  /**
   * Which Firetower the window is in. One at a time.
   *
   * There used to be an "all" scope and a `/fleet` screen behind it, and this
   * key used to be `firetower.scope` because it could hold either. It holds a
   * server id now and nothing else — the unified inbox is a menu under the
   * avatar, and **the dock badge and `islandState` below are unchanged and
   * still span every connected Firetower**, which is what carries the product
   * across them.
   */
  const [which, setWhichState] = useState<string | null>(() => {
    try {
      /* Carried over once, so an upgrade does not land somebody on a
         Firetower they were not in. `"all"` is the one value that no longer
         means anything, and it falls through to the first connected one. */
      const was = window.localStorage.getItem(WAS);
      window.localStorage.removeItem(WAS);
      const held = window.localStorage.getItem(WHICH) || (was && was !== "all" ? was : null);
      return held || servers()[0]?.serverId || null;
    } catch {
      return servers()[0]?.serverId ?? null;
    }
  });
  const setWhich = (next: string | null) => {
    setWhichState(next);
    try {
      if (next) window.localStorage.setItem(WHICH, next);
      else window.localStorage.removeItem(WHICH);
    } catch {
      /* private window; the choice just does not survive a reload */
    }
  };
  /* The servers this Mac has connected to. */
  const [real$, setReal] = useState(servers);
  useEffect(() => onServers(() => setReal(servers())), []);
  const path = usePathname();
  /* Is there a newer build: now, and every ten minutes after, so a window left
     open for a fortnight does not learn about a release by being restarted.
     Reading it here is what starts the watch for the whole app — the rail and
     the Updates screen read the same answer. */
  const build = useBuild();
  const confirm = useConfirm();
  /* The first find of a run is offered, once, four seconds in: late enough not
     to be the first thing that happens, early enough that nothing is in
     flight. Every find after that is the rail's to say. */
  useEffect(() => {
    if (!build.newer) return;
    const t = setTimeout(() => void offerUpdate(build, confirm), 4000);
    return () => clearTimeout(t);
  }, [build, confirm]);

  /* Empty each server's telemetry outbox, in the background, forever. Nothing
     on screen waits for it and nothing here decides what is in a digest — see
     `~/telemetry`. */
  useEffect(() => startCourier(), []);

  /* Ember, on the dock: summed across every server, because the person glancing
     at it does not care whose machine stopped. */
  const fleet = useFleet();
  const waiting = fleet.reduce((n, f) => n + waitingIn(f.sessions), 0);
  useEffect(() => bridge.setBadge(waiting || null), [waiting]);

  /* And ember on the island, from the same poll.
     This window is the island's only source. It already holds every backend
     and already pays for the connections, so the pill is *told*; a second
     webview asking the same servers the same question is the thing
     `src/api/events.ts` exists to remember. Sent as a string first so a poll
     that changed nothing costs nothing. */
  const forIsland = useMemo(() => JSON.stringify(islandState(fleet)), [fleet]);
  useEffect(() => bridge.island?.push(JSON.parse(forIsland)), [forIsland]);

  /* A row on the island is a way into the app, and the only thing it does.
     Whichever server it came from, because the island spans all of them. */
  useEffect(
    () =>
      bridge.island?.onOpen(({ serverId, workspaceId }) => {
        setWhich(serverId);
        navigate(`/sessions/${workspaceId}`);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const pick = (next: string) => {
    setWhich(next);
    // A session id from one server means nothing on another, so switching lands
    // on that server's dashboard rather than on wherever the last one was.
    navigate("/");
  };

  /* The style guide is for developing the app: it is not in a production build. */
  const style = import.meta.env.DEV && path.startsWith("/style");
  const connecting = path.startsWith("/connect");

  const asBackend = (id: string | null): Backend | null => {
    const real = id ? real$.find((s) => s.serverId === id) : undefined;
    return real ? liveBackend(real, real$) : null;
  };
  const here = asBackend(which);
  /* A choice naming a server this Mac no longer has falls back to the next
     one; with no server at all there is only connecting. */
  useEffect(() => {
    if (!here) setWhich(real$[0]?.serverId ?? null);
  }, [which, here, real$]);
  const none = real$.length === 0;
  /* A server this Mac is still connected to whose token has stopped working:
     a password replaced in a browser ends every other session, and so does an
     administrator resetting one. The address is still right, so what is owed
     is a password field for *that* server, not the whole app drawn around a
     refusal repeated in every pane. */
  const adrift = real$.find((s) => s.serverId === which && !s.token) ?? null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-text">
      <Titlebar serverId={which} onSwitch={pick} />

      <div className="relative flex min-h-0 flex-1">
        {connecting || none ? (
          <Connect
            onDone={(serverId) => {
              setWhich(serverId);
              navigate("/");
            }}
            onCancel={none ? undefined : () => navigate("/")}
          />
        ) : adrift ? (
          /* No way to cancel: there is nothing behind this to go back to. The
             switcher is still in the title bar, so another Firetower is one
             click away — this is one server's door, not the app's. */
          <Connect
            at={adrift.url}
            onDone={(serverId) => {
              // The cache for this server is full of the refusals that
              // arrived while the token was dead; keeping it would render
              // them once more under a session that now works.
              dropCache(serverId);
              setWhich(serverId);
              navigate("/");
            }}
          />
        ) : style ? (
          <Suspense fallback={null}>
            <StylePage />
          </Suspense>
        ) : !here ? null : (
          <BackendProvider id={here.id} key={here.id}>
            {/* Inside the provider, not around it: the new-workspace form
                reads this server's repositories, so it needs the same
                QueryClient as the screen that opened it. */}
            <StartProvider>
              <Rail
                backend={here}
                onSwitch={pick}
                onForgot={() => {
                  const left = servers();
                  setReal(left);
                  setWhich(left[0]?.serverId ?? null);
                  navigate(left.length ? "/" : "/connect");
                }}
              />
              {/* Draws nothing: it keeps the artifact list warm and fills in
                  the pictures the tiles use, on whichever screen is up. */}
              <Posters />
              {/* Keyed on the path so leaving a broken screen clears the
                  error rather than sticking on it. */}
              <Boundary key={path} onReset={() => navigate("/")}>
                {/* The sheet. One radius on one object: rounded on the side
                    that faces the chrome and flush to the window's own
                    corners on the other, because an app does not draw a
                    second set of corners inside the ones it has. */}
                <div className="ml-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-l-sheet bg-panel shadow-(--shadow-raise)">
                  <Gate backend={here}>
                    <Routes
                      backend={here}
                      onForgot={() => {
                        const left = servers();
                        setReal(left);
                        setWhich(left[0]?.serverId ?? null);
                        navigate(left.length ? "/" : "/connect");
                      }}
                    />
                  </Gate>
                </div>
              </Boundary>
            </StartProvider>
          </BackendProvider>
        )}
      </div>
    </div>
  );
}
