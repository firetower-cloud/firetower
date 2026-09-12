import { useEffect, useState } from "react";
import { ServerStrip, type Scope } from "~/ui/ServerStrip";
import { Titlebar } from "~/ui/Titlebar";
import { Palette } from "~/ui/Palette";
import { Rail } from "~/ui/Rail";
import { Routes } from "~/Routes";
import { Fleet, waitingAcross } from "~/ui/Fleet";
import { StylePage } from "~/ui/StylePage";
import { runTimeline, useFixtures } from "~/mock/socket";
import { BACKENDS, type Backend, type BackendId } from "~/mock/backends";
import { BackendProvider } from "~/backend";
import { bridge } from "~/bridge";
import { StartProvider } from "~/start";
import { Connect } from "~/ui/Connect";
import { servers, onServers } from "~/servers";
import { NewWorkspace } from "~/ui/NewWorkspace";
import { navigate, usePathname } from "~/shims/next-navigation";

export function App() {
  const [scope, setScope] = useState<Scope>("e1");
  /* Real servers this Mac has connected to, alongside the three fixtures.
     The prototype keeps working with no server at all — that is what makes the
     design reviewable — and shows the real one the moment there is one. */
  const [real$, setReal] = useState(servers);
  useEffect(() => onServers(() => setReal(servers())), []);
  const [palette, setPalette] = useState(false);
  const path = usePathname();
  useFixtures();

  useEffect(() => runTimeline(), []);

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
  const waiting = waitingAcross();
  useEffect(() => bridge.setBadge(waiting || null), [waiting]);

  const pick = (next: Scope) => {
    setScope(next);
    // A session id from one server means nothing on another, so switching lands
    // on that server's dashboard rather than on wherever the last one was.
    navigate(next === "all" ? "/fleet" : "/");
  };

  const style = path.startsWith("/style");
  const connecting = path.startsWith("/connect");

  /* A connected server wears the same clothes as a fixture: the screens take a
     `Backend` and do not care which kind it is, which is what let the real
     wiring land without rewriting any of them. */
  const asBackend = (id: string): Backend | null => {
    const fixture = BACKENDS.find((b) => b.id === id);
    if (fixture) return fixture;
    const real = real$.find((s) => s.serverId === id);
    if (!real) return null;
    return {
      id: real.serverId as BackendId,
      org: real.org,
      user: real.user,
      mark: real.org.slice(0, 1).toUpperCase(),
      url: real.url,
      latency: [0, 0],
      reach: "live",
    };
  };
  const all = scope === "all" || path.startsWith("/fleet");
  const here = scope === "all" ? null : asBackend(scope);

  return (
    <StartProvider
      render={(seed, close) =>
        here ? <NewWorkspace backend={here} seed={seed} onClose={close} /> : null
      }
    >
      <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-text">
        <Titlebar scope={scope} waiting={waiting} onPalette={() => setPalette(true)} />

        <div className="flex min-h-0 flex-1">
          <ServerStrip scope={scope} onScope={pick} />

          {connecting ? (
            <Connect
              onDone={(serverId) => {
                setScope(serverId as Scope);
                navigate("/");
              }}
              onCancel={() => navigate("/")}
            />
          ) : style ? (
            <StylePage />
          ) : all || !here ? (
            <Fleet />
          ) : (
            <BackendProvider id={here.id} key={here.id}>
              <Rail backend={here} />
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <Routes backend={here} />
              </div>
            </BackendProvider>
          )}
        </div>

        <Palette open={palette} onClose={() => setPalette(false)} />
      </div>
    </StartProvider>
  );
}
