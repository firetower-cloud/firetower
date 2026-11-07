/**
 * Connecting this Mac to a Firetower.
 *
 * Two questions, asked in order and never at the same time: **where** it is,
 * and **who you are there**. They are separate because only the first one has
 * an answer that is the same for everybody at a company, and because knowing
 * the answer to the first is what lets the client tell you whose Firetower you
 * are about to hand a password to.
 *
 * One field takes the address. Not a code: a code carries no address, and a
 * fleet of self-hosted servers has nowhere to look one up that would not be a
 * hosted service holding every install's whereabouts — which is the thing this
 * architecture exists to avoid.
 */
import { useEffect, useState } from "react";
import { ArrowRight, CircleSlash2, Loader2, Lock, Server, UserRound, X } from "lucide-react";
import { Icon, IconButton } from "~/components/ui";
import { markOf } from "~/fleet";
import { Mark } from "~/ui/Mark";
import { MIN_SERVER, packaged, reach, signIn, type Bootstrap } from "~/probe";
import { remember } from "~/servers";
import { ReplacePassword } from "~/ui/ReplacePassword";

type Stage =
  | { at: "where" }
  | { at: "reaching" }
  | { at: "unreachable"; typed: string; detail: string }
  | { at: "refused"; typed: string; detail: string }
  | { at: "who"; url: string; boot: Bootstrap }
  // The password was right and is temporary. A third question, after where and
  // who: nothing is stored, because a server this Mac cannot yet use is not a
  // server this Mac has been connected to.
  | { at: "locked"; url: string; boot: Bootstrap; user: string }
  | { at: "joining" };

export function Connect({
  onDone,
  onCancel,
  at,
}: {
  /** Handed the new server's id, so the app can switch to it. */
  onDone: (serverId: string) => void;
  onCancel?: () => void;
  /**
   * An address already known to be a Firetower: signing in again to a server
   * this Mac is still connected to, whose token has stopped working.
   *
   * The first question is skipped rather than pre-filled. Asking somebody to
   * confirm an address they got right months ago, because a password changed
   * in a browser, is asking them to re-answer a question nothing has
   * invalidated.
   */
  at?: string;
}) {
  const [typed, setTyped] = useState(at ?? "");
  const [stage, setStage] = useState<Stage>(at ? { at: "reaching" } : { at: "where" });

  const find = async (address: string) => {
    setStage({ at: "reaching" });
    const found = await reach(address);
    if (!found.ok) {
      const at = found.why === "refused" || found.why === "too-old" ? "refused" : "unreachable";
      setStage({ at, typed: address, detail: found.detail });
      return;
    }
    setStage({ at: "who", url: found.url, boot: found.at });
  };

  // Only for the address handed in, and only once. `find` is redefined every
  // render, so depending on it would reach the server again on each one.
  useEffect(() => {
    if (at) void find(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);

  return (
    /* On the sheet, with the window's own corners. It was centred on the bare
       desk, so the first thing anybody sees was the one screen in the product
       with no body under it. */
    <div className="first">
      <div className="card">
        {stage.at === "where" && (
          <Where typed={typed} onTyped={setTyped} onGo={() => find(typed)} onCancel={onCancel} />
        )}

        {stage.at === "reaching" && (
          /* **Typing dots, not a spinner.** A spinner is the shape this
             system uses for a page that has not arrived; this is a question
             being asked of a machine, which is the same thing an agent at
             work is doing, and it already has a mark. */
          <>
            <span className="mk">
              <Mark size={24} />
            </span>
            <h1>Looking for it…</h1>
            <p>Trying https, then http. Only the scheme that answers is kept.</p>
            <div className="found">
              <span className="typing shrink-0">
                <i />
                <i />
                <i />
              </span>
              <span className="tx">
                <b>{typed}</b>
                <s>asking what is there</s>
              </span>
            </div>
          </>
        )}

        {stage.at === "unreachable" && (
          <NoRoute
            typed={stage.typed}
            detail={stage.detail}
            onRetry={() => find(stage.typed)}
            onBack={() => setStage({ at: "where" })}
          />
        )}

        {stage.at === "refused" && (
          <Refused
            typed={stage.typed}
            detail={stage.detail}
            onRetry={() => find(stage.typed)}
            onBack={() => setStage({ at: "where" })}
          />
        )}

        {stage.at === "locked" && (
          <ReplacePassword
            url={stage.url}
            username={stage.user}
            retryLabel="Sign in again"
            onRetry={() => setStage({ at: "who", url: stage.url, boot: stage.boot })}
            onBack={() => setStage({ at: "where" })}
            backLabel="Use a different address"
          />
        )}

        {stage.at === "who" && (
          <Who
            url={stage.url}
            boot={stage.boot}
            onBack={() => setStage({ at: "where" })}
            onLocked={(user) => setStage({ at: "locked", url: stage.url, boot: stage.boot, user })}
            onIn={(token, user) => {
              const serverId = stage.boot.serverId ?? stage.url;
              remember({
                url: stage.url,
                serverId,
                org: stage.boot.organization ?? stage.url.replace(/^https?:\/\//, ""),
                user,
                token,
                addedAt: new Date().toISOString(),
              });
              setStage({ at: "joining" });
              onDone(serverId);
            }}
          />
        )}
      </div>
    </div>
  );
}

function Where({
  typed,
  onTyped,
  onGo,
  onCancel,
}: {
  typed: string;
  onTyped: (v: string) => void;
  onGo: () => void;
  onCancel?: () => void;
}) {
  return (
    <>
      <span className="mk">
        <Mark size={24} />
      </span>
      <h1>Where is your Firetower?</h1>
      <p>
        The address somebody at your company gave you. Not a code — a code carries no address,
        and there is nowhere to look one up that would not be a service holding every
        install&rsquo;s whereabouts.
      </p>

      <label className="in">
        <Icon of={Server} size={16} className="shrink-0 text-mute" />
        <input
          autoFocus
          value={typed}
          onChange={(e) => onTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && typed.trim() && onGo()}
          placeholder="ft-e1.tail9c2b.ts.net"
          aria-label="The address of your Firetower"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="bg-transparent placeholder:text-mute focus:outline-none"
        />
      </label>

      <button disabled={!typed.trim()} onClick={onGo} className="btn primary go">
        Continue
        <ArrowRight className="h-4 w-4" strokeWidth={2} />
      </button>

      <p className="alt">
        Running one yourself? Use <code className="font-mono text-meta text-text">localhost:8080</code>.
      </p>

      {onCancel && (
        <button
          onClick={onCancel}
          className="mx-auto mt-5 block text-meta text-mute transition-colors hover:text-dim"
        >
          Cancel
        </button>
      )}
    </>
  );
}

/**
 * The state the memo predicts is the common one, written as what to do rather
 * than what went wrong.
 */
function NoRoute({
  typed,
  detail,
  onRetry,
  onBack,
}: {
  typed: string;
  detail: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <span className="mk">
        <CircleSlash2 className="h-6 w-6" strokeWidth={1.5} />
      </span>
      <h1>Nothing answered there</h1>
      <p>The address reached nothing on https or http.</p>

      {/* **A brick rule, not a bordered box.** A refusal that fills a panel
          with colour reads as the app having broken; the common case here is
          that the address is wrong. The three questions stay — they are the
          remedy, and the drawing's own panel is where a remedy goes. */}
      <div className="bad">
        <b>Could not reach {typed}</b>
        <span className="block">
          A Firetower is never on the public internet, so this Mac reaches one over your mesh VPN.
        </span>
        <ul className="mt-2 space-y-1">
          <li>Is Tailscale running and signed in?</li>
          <li>Has this machine been shared the node?</li>
          <li>Is the address right — a name, not an IP behind a firewall?</li>
        </ul>
        <span className="mt-2 block font-mono text-micro text-mute">{detail}</span>
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={onBack} className="btn plain flex-1 justify-center">
          Try another address
        </button>
        <button onClick={onRetry} className="btn primary flex-1 justify-center">
          Try again
        </button>
      </div>
    </>
  );
}

/**
 * Something answered and would not talk to the app.
 *
 * Told apart from no route by `probe.ts`, and drawn differently because the
 * remedy is different: the VPN is fine, so this is about which origins that
 * server answers.
 *
 * Two reasons, and they are not the same remedy, so this does not guess. A
 * shipped client's pages come from an origin every control plane from
 * `MIN_SERVER` on allows, so being refused means the server is behind. A
 * development build's pages come from vite, on an origin no production server
 * allows — and stating the first reason there sent somebody to check the
 * version of a server that was already current.
 */
function Refused({
  typed,
  detail,
  onRetry,
  onBack,
}: {
  typed: string;
  detail: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <span className="mk">
        <CircleSlash2 className="h-6 w-6" strokeWidth={1.5} />
      </span>
      <h1>That is not a Firetower</h1>
      <div className="bad">
        <b>{typed} answered, and refused the app</b>
        {packaged() ? (
          <span className="block">
            It is running a Firetower older than {MIN_SERVER}, which only talks to its own web
            page. Upgrade it from its Updates screen, or with <span className="font-mono">firetower upgrade</span> on
            the machine, then try again.
          </span>
        ) : (
          <span className="block">
            This is a development build, and its pages come from{" "}
            <span className="font-mono">{globalThis.location?.origin}</span> — an address no
            control plane answers. Point it at a server you are running with{" "}
            <span className="font-mono">--dev</span>, or use an installed Firetower to reach
            this one.
          </span>
        )}
        <span className="mt-2 block font-mono text-micro text-mute">{detail}</span>
      </div>

      <div className="mt-5 flex gap-2">
        <button onClick={onBack} className="btn plain flex-1 justify-center">
          Try another address
        </button>
        <button onClick={onRetry} className="btn primary flex-1 justify-center">
          Try again
        </button>
      </div>
    </>
  );
}

/**
 * Who you are, and it is the server that decides how.
 *
 * `authModes` comes from `/bootstrap`, so the client never guesses: a password
 * form shown to an SSO deployment is a dead end, and asking a one-person laptop
 * install for a browser round trip is rude.
 */
function Who({
  url,
  boot,
  onIn,
  onLocked,
  onBack,
}: {
  url: string;
  boot: Bootstrap;
  onIn: (token: string, user: string) => void;
  /** The password was correct and has to be replaced before anything else. */
  onLocked: (user: string) => void;
  onBack: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState<string | null>(null);

  const open = boot.authModes.includes("open");
  const proxyOnly = !boot.authModes.includes("password") && boot.authModes.includes("proxy");

  useEffect(() => {
    // Nothing stands in front of this one; there is nobody to be.
    if (open) onIn("", "everyone");
  }, [open, onIn]);

  const go = async () => {
    setBusy(true);
    setWrong(null);
    const out = await signIn(url, username.trim(), password);
    setBusy(false);
    if (!out.ok) {
      setWrong(out.why);
      return;
    }
    // Not `setWrong`: the password was right. Saying so under the field they
    // just filled in would send them to look for a typo that is not there.
    if (out.mustChangePassword) {
      onLocked(out.user);
      return;
    }
    onIn(out.token, out.user);
  };

  return (
    <>
      {/* **What was found, before you say who you are.** It was a sage-ringed
          lock over the organisation's name — a signal colour on a screen where
          nothing has gone right or wrong yet. This is the drawing's: the mark
          the rail will use, the name, the address and the version, and a way
          back out of it. */}
      <div className="found">
        <span className="face">{markOf(boot.organization ?? url)}</span>
        <span className="tx">
          <b>{boot.organization ?? "A Firetower"}</b>
          <s>
            {url.replace(/^https?:\/\//, "")} · {boot.version}
          </s>
        </span>
        <IconButton of={X} onClick={onBack} label="Use a different address" />
      </div>

      <h1 className="mt-6">Who are you here?</h1>
      <p>An account on this Firetower. It exists on this server only — it is not an account with us.</p>

      {proxyOnly ? (
        <div className="rounded-xl border border-line bg-panel px-4 py-4 text-center">
          <p className="text-read text-dim">
            This server signs people in through something in front of it. That needs a browser,
            and the app cannot do it yet.
          </p>
          <p className="mt-2 text-meta text-mute">The device flow is the next thing to build.</p>
        </div>
      ) : (
        <>
          <label className="in">
            <Icon of={UserRound} size={16} className="shrink-0 text-mute" />
            <input
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && password && go()}
              placeholder="Username"
              spellCheck={false}
              autoCapitalize="off"
              className="bg-transparent placeholder:text-mute focus:outline-none"
            />
          </label>
          <label className="in !mt-2.5">
            <Icon of={Lock} size={16} className="shrink-0 text-mute" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && username && go()}
              placeholder="Password"
              className="bg-transparent placeholder:text-mute focus:outline-none"
            />
          </label>

          {wrong && <p className="mt-2.5 text-center text-meta text-brick">{wrong}</p>}

          <button
            disabled={busy || !username.trim() || !password}
            onClick={go}
            className="btn primary go"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              "Sign in"
            )}
          </button>
        </>
      )}

      {/* The way out of this server is the × on the panel above; what belongs
          here is the answer to the question somebody stuck on this screen is
          actually asking. */}
      <p className="alt">
        Forgotten it? An administrator resets it, or{" "}
        <code className="font-mono text-meta text-text">firetower passwd</code> on the server.
      </p>
    </>
  );
}
