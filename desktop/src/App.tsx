import { useEffect, useState } from "react";
import { Titlebar } from "~/ui/Titlebar";
import { Resize } from "~/ui/Resize";
import { KeychainRefused } from "~/ui/KeychainRefused";
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
import { servers, onServers, tokensKnown } from "~/servers";
import { Boundary } from "~/ui/Boundary";
import { Gate } from "~/ui/Gate";
import { navigate, usePathname } from "~/shims/next-navigation";
import { offerUpdate, useBuild } from "~/update";
import { startCourier } from "~/telemetry";
import { useConfirm } from "~/ui/Confirm";

const StylePage = import.meta.env.DEV ? lazy(() => import("~/ui/StylePage").then((m) => ({ default: m.StylePage }))) : () => null;

const WHICH = "firetower.current";
/** What this used to be called, when it could also hold `"all"`. */
const WAS = "firetower.scope";

/**
 * Which server this window is on, given what it last heard.
 *
 * The asked-for one where it is still here, and otherwise the first there is.
 * **Pure, exported and tested, because the answer `null` while servers exist
 * is a window with nothing in it** — `Window` draws no body for a server it
 * cannot find, which is right when there are none and a bug every other time.
 * It was reachable: the registry announces a new row before anything names
 * it, so every sign-in passed through a render where the choice was stale.
 */
export function serverOn(real: { serverId: string }[], asked: string | null): string | null {
  if (asked && real.some((s) => s.serverId === asked)) return asked;
  return real[0]?.serverId ?? null;
}

/**
 * What the window draws under its title bar.
 *
 * Here rather than inline so that the one answer that must never happen —
 * `nothing` with servers in the registry — is something a test can ask for
 * directly. `style` is a dev-build screen and is decided by the caller.
 */
export function bodyFor(
  real: { serverId: string; token: string }[],
  on: string | null,
  path: string,
): "connect" | "door" | "app" | "nothing" {
  if (path.startsWith("/connect") || real.length === 0) return "connect";
  if (real.some((s) => s.serverId === on && !s.token)) return "door";
  return real.some((s) => s.serverId === on) ? "app" : "nothing";
}

/**
 * The window, before the keychain has said anything.
 *
 * **The chrome, and nothing under it.** `hydrate` runs behind the first frame
 * now, so for the first moments of a launch a registry row's token has not
 * arrived yet — and a row with no token is indistinguishable from a row whose
 * sign-in has died, which `Window` below draws as that server's door. Drawing
 * it for the half-second a keychain read takes would be a password field
 * flashing up on every launch; drawing the app instead would be a window full
 * of panes asking an unauthenticated question each.
 *
 * So: the title bar, which moves and closes the window, and the edges, which
 * resize it. Painted and styled, which is the whole of the fix — this used to
 * be a window with nothing in it at all, because nothing rendered until the
 * keychain answered, and a locked keyring means it never does. `servers.ts`
 * stops waiting after a moment either way, so this is never what anybody is
 * left looking at.
 */
function Starting() {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-text">
      <Titlebar serverId={null} onSwitch={() => {}} />
      <Resize />
      <div className="relative flex min-h-0 flex-1" />
    </div>
  );
}

export function App() {
  /* Whether the keychain has answered, or been waited out. The registry is
     read synchronously everywhere and the keychain is not, so this is the one
     thing the window has to wait for — and it waits with its chrome up. */
  const [known, setKnown] = useState(tokensKnown);
  useEffect(() => {
    /* Read again here, and not only on the next notification. `hydrate` is
       started right after `render`, so it can finish before this effect has
       subscribed — and a window that missed that one notification would stay
       on `Starting` for the rest of the launch. */
    setKnown(tokensKnown());
    return onServers(() => setKnown(tokensKnown()));
  }, []);
  return known ? <Window /> : <Starting />;
}

function Window() {
  /**
   * Which Firetower the window is in. One at a time.
   *
   * There used to be an "all" scope and a `/fleet` screen behind it, and this
   * key used to be `firetower.scope` because it could hold either. It holds a
   * server id now and nothing else — the unified inbox is a menu under the
   * avatar, and **the dock badge below is unchanged and still spans every
   * connected Firetower**, which is what carries the product across them.
   * `islandState` went with the island.
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
  /* The servers this Mac has connected to. Re-read on subscribing for the
     same reason as above: a token can land between the render and this. */
  const [real$, setReal] = useState(servers);
  useEffect(() => {
    setReal(servers());
    return onServers(() => setReal(servers()));
  }, []);
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

  const pick = (next: string) => {
    setWhich(next);
    // A session id from one server means nothing on another, so switching lands
    // on that server's dashboard rather than on wherever the last one was.
    navigate("/");
  };

  /* The style guide is for developing the app: it is not in a production build. */
  const style = import.meta.env.DEV && path.startsWith("/style");
  const connecting = path.startsWith("/connect");

  /* **Resolved during the render that needs it, not by an effect afterwards.**
     A choice naming a server this Mac no longer has — or no choice yet,
     which is every sign-in, because the row is announced before `onDone`
     names it — used to leave `here` null for a render, and the branch for
     that draws *nothing*: a window with a title bar and an empty body. An
     effect then corrected it, which made the blank a flicker rather than a
     state, and only while the effect actually ran. Falling back here means
     there is no such render: with any server at all, one of them is the one
     this window is on. */
  const on = serverOn(real$, which);
  const asBackend = (id: string | null): Backend | null => {
    const real = id ? real$.find((s) => s.serverId === id) : undefined;
    return real ? liveBackend(real) : null;
  };
  const here = asBackend(on);
  /* Written down so the correction survives a relaunch. */
  useEffect(() => {
    if (on !== which) setWhich(on);
  }, [on, which]);
  const none = real$.length === 0;
  /* A server this Mac is still connected to whose token has stopped working:
     a password replaced in a browser ends every other session, and so does an
     administrator resetting one. The address is still right, so what is owed
     is a password field for *that* server, not the whole app drawn around a
     refusal repeated in every pane. */
  const adrift = real$.find((s) => s.serverId === on && !s.token) ?? null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-ground text-text">
      <Titlebar serverId={on} onSwitch={pick} />
      {/* The window's own edges, where there is no frame to grab. Beside the
          title bar and not inside it: nested, one mousedown would start a
          move and a resize at once. */}
      <Resize />
      {/* Draws nothing until the OS keychain refuses a token, which can happen
          on any of the three platforms and on Linux happens most. Above the
          door as well as the app, because the sign-in it is about can be the
          one that just happened on either. */}
      <KeychainRefused />

      <div className="relative flex min-h-0 flex-1">
        {/* The style page first, and before the door. It is a dev build's
            own screen and it needs no Firetower to draw — checked after
            `none`, as it used to be, it was unreachable on exactly the
            machine that has not connected to one yet. */}
        {style ? (
          <Suspense fallback={null}>
            <StylePage />
          </Suspense>
        ) : connecting || none ? (
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
        ) : !here ? null : (
          <BackendProvider id={here.id} key={here.id}>
            {/* Inside the provider, not around it: the new-workspace form
                reads this server's repositories, so it needs the same
                QueryClient as the screen that opened it. */}
            <StartProvider>
              {/* **The gate replaces the body**, rail and all. A password that
                  must be replaced and a server mid-setup are both doors, not
                  destinations: drawing a rail of six places beside them offers
                  six ways to go nowhere. The title bar stays — switching
                  Firetower is the one thing still worth doing from here. */}
              <Gate backend={here}>
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
                  <Routes
                    backend={here}
                    onSwitch={pick}
                    onForgot={() => {
                      const left = servers();
                      setReal(left);
                      setWhich(left[0]?.serverId ?? null);
                      navigate(left.length ? "/" : "/connect");
                    }}
                  />
                </div>
              </Boundary>
              </Gate>
            </StartProvider>
          </BackendProvider>
        )}
      </div>
    </div>
  );
}
