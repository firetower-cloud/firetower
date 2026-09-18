import { useEffect, useMemo, useState } from "react";
import { ServerStrip, type Scope } from "~/ui/ServerStrip";
import { Titlebar } from "~/ui/Titlebar";
import { Palette } from "~/ui/Palette";
import { Rail } from "~/ui/Rail";
import { Routes } from "~/Routes";
import { Fleet } from "~/ui/Fleet";
import { useFleet, waitingIn, asBackend as liveBackend } from "~/fleet";
import { lazy, Suspense } from "react";
import type { Backend } from "~/fleet";
import { BackendProvider } from "~/backend";
import { bridge } from "~/bridge";
import { StartProvider } from "~/start";
import { Connect } from "~/ui/Connect";
import { servers, onServers } from "~/servers";
import { NewWorkspace } from "~/ui/NewWorkspace";
import { Boundary } from "~/ui/Boundary";
import { Gate } from "~/ui/Gate";
import { navigate, usePathname } from "~/shims/next-navigation";
import { offerUpdate } from "~/update";
import { islandState } from "~/island/state";
import { useConfirm } from "~/ui/Confirm";

const StylePage = import.meta.env.DEV ? lazy(() => import("~/ui/StylePage").then((m) => ({ default: m.StylePage }))) : () => null;

export function App() {
  /* Remembered, so a reload lands where you were. */
  const [scope, setScopeState] = useState<Scope>(() => {
    try {
      return (window.localStorage.getItem("firetower.scope") as Scope) || servers()[0]?.serverId || "all";
    } catch {
      return "all";
    }
  });
  const setScope = (next: Scope) => {
    setScopeState(next);
    try {
      window.localStorage.setItem("firetower.scope", next);
    } catch {
      /* private window; the choice just does not survive a reload */
    }
  };
  /* The servers this Mac has connected to. */
  const [real$, setReal] = useState(servers);
  useEffect(() => onServers(() => setReal(servers())), []);
  const [palette, setPalette] = useState(false);
  const path = usePathname();
  /* Once, after the window is up: is there a newer build. */
  const confirm = useConfirm();
  useEffect(() => {
    const t = setTimeout(() => void offerUpdate(confirm), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        setScope(serverId as Scope);
        navigate(`/sessions/${workspaceId}`);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const pick = (next: Scope) => {
    setScope(next);
    // A session id from one server means nothing on another, so switching lands
    // on that server's dashboard rather than on wherever the last one was.
    navigate(next === "all" ? "/fleet" : "/");
  };

  /* The style guide is for developing the app: it is not in a production build. */
  const style = import.meta.env.DEV && path.startsWith("/style");
  const connecting = path.startsWith("/connect");

  const asBackend = (id: string): Backend | null => {
    const real = real$.find((s) => s.serverId === id);
    return real ? liveBackend(real) : null;
  };
  const all = scope === "all" || path.startsWith("/fleet");
  const here = scope === "all" ? null : asBackend(scope);
  /* A scope naming a server this Mac no longer has falls back to the next
     one, or to everything; with no server at all there is only connecting. */
  useEffect(() => {
    if (scope !== "all" && !here) setScope(real$[0]?.serverId ?? "all");
  }, [scope, here, real$]);
  const none = real$.length === 0;

  return (
    <>
      <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-text">
        <Titlebar scope={scope} waiting={waiting} onPalette={() => setPalette(true)} />

        <div className="flex min-h-0 flex-1">
          <ServerStrip scope={scope} onScope={pick} />

          {connecting || none ? (
            <Connect
              onDone={(serverId) => {
                setScope(serverId as Scope);
                navigate("/");
              }}
              onCancel={none ? undefined : () => navigate("/")}
            />
          ) : style ? (
            <Suspense fallback={null}>
              <StylePage />
            </Suspense>
          ) : all || !here ? (
            <Fleet />
          ) : (
            <BackendProvider id={here.id} key={here.id}>
              {/* Inside the provider, not around it: the new-workspace form
                  reads this server's repositories, so it needs the same
                  QueryClient as the screen that opened it. */}
              <StartProvider
                render={(seed, close) => (
                  <Boundary onReset={close}>
                    <NewWorkspace backend={here} seed={seed} onClose={close} />
                  </Boundary>
                )}
              >
                <Rail backend={here} />
                {/* Keyed on the path so leaving a broken screen clears the
                    error rather than sticking on it. */}
                <Boundary key={path} onReset={() => navigate("/")}>
                  <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                    <Gate>
                      <Routes
                        backend={here}
                        onForgot={() => {
                          const left = servers();
                          setReal(left);
                          setScope(left[0]?.serverId ?? "all");
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

        <Palette open={palette} onClose={() => setPalette(false)} />
      </div>
    </>
  );
}
