import { useEffect, useState } from "react";
import { ServerStrip, type Scope } from "~/ui/ServerStrip";
import { Titlebar } from "~/ui/Titlebar";
import { Palette } from "~/ui/Palette";
import { Rail } from "~/ui/Rail";
import { Routes } from "~/Routes";
import { Fleet, waitingAcross } from "~/ui/Fleet";
import { StylePage } from "~/ui/StylePage";
import { runTimeline, useFixtures } from "~/mock/socket";
import { backend as backendFor, type BackendId } from "~/mock/backends";
import { bridge } from "~/bridge";
import { StartProvider } from "~/start";
import { NewWorkspace } from "~/ui/NewWorkspace";
import { navigate, usePathname } from "~/shims/next-navigation";

export function App() {
  const [scope, setScope] = useState<Scope>("e1");
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
  const all = scope === "all" || path.startsWith("/fleet");
  const here = scope === "all" ? null : backendFor(scope as BackendId);

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

          {style ? (
            <StylePage />
          ) : all || !here ? (
            <Fleet />
          ) : (
            <>
              <Rail backend={here} />
              <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <Routes backend={here} />
              </div>
            </>
          )}
        </div>

        <Palette open={palette} onClose={() => setPalette(false)} />
      </div>
    </StartProvider>
  );
}
