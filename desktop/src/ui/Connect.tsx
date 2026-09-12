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
import { ArrowRight, CircleSlash2, Loader2, Lock, ServerIcon } from "lucide-react";
import { reach, signIn, type Bootstrap } from "~/probe";
import { remember } from "~/servers";

type Stage =
  | { at: "where" }
  | { at: "reaching" }
  | { at: "unreachable"; typed: string; detail: string }
  | { at: "who"; url: string; boot: Bootstrap }
  | { at: "joining" };

export function Connect({
  onDone,
  onCancel,
}: {
  /** Handed the new server's id, so the app can switch to it. */
  onDone: (serverId: string) => void;
  onCancel?: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [stage, setStage] = useState<Stage>({ at: "where" });

  const find = async (address: string) => {
    setStage({ at: "reaching" });
    const found = await reach(address);
    if (!found.ok) {
      setStage({ at: "unreachable", typed: address, detail: found.detail });
      return;
    }
    setStage({ at: "who", url: found.url, boot: found.at });
  };

  return (
    <div className="grid h-full min-w-0 flex-1 place-items-center bg-ground px-6">
      <div className="w-full max-w-[26rem]">
        {stage.at === "where" && (
          <Where typed={typed} onTyped={setTyped} onGo={() => find(typed)} onCancel={onCancel} />
        )}

        {stage.at === "reaching" && (
          <Middle>
            <Loader2 className="mx-auto h-5 w-5 animate-spin text-mute" strokeWidth={1.75} />
            <p className="mt-4 text-read text-dim">Looking for a Firetower at {typed}…</p>
          </Middle>
        )}

        {stage.at === "unreachable" && (
          <NoRoute
            typed={stage.typed}
            detail={stage.detail}
            onRetry={() => find(stage.typed)}
            onBack={() => setStage({ at: "where" })}
          />
        )}

        {stage.at === "who" && (
          <Who
            url={stage.url}
            boot={stage.boot}
            onBack={() => setStage({ at: "where" })}
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

function Middle({ children }: { children: React.ReactNode }) {
  return <div className="text-center">{children}</div>;
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
      <div className="mb-7 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-line bg-raise text-ember shadow-(--shadow-raise)">
          <ServerIcon className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <h1 className="mt-4 text-display text-bone">Connect to a Firetower</h1>
        <p className="mt-2 text-read text-dim">
          The address of the control plane your team runs. It is never on the public internet,
          so this is usually a name on your mesh VPN.
        </p>
      </div>

      <input
        autoFocus
        value={typed}
        onChange={(e) => onTyped(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && typed.trim() && onGo()}
        placeholder="ft-e1.tail9c2b.ts.net"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className="w-full rounded-xl border border-line bg-panel px-4 py-3 text-center font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
      />

      <button
        disabled={!typed.trim()}
        onClick={onGo}
        className="control mt-3 w-full justify-center bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute"
      >
        Connect
        <ArrowRight className="h-4 w-4" strokeWidth={2} />
      </button>

      <p className="mt-4 text-center text-meta text-mute">
        Nothing is sent until this reaches a server you named.
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
      <div className="text-center">
        <CircleSlash2 className="mx-auto h-6 w-6 text-mute" strokeWidth={1.5} />
        <h1 className="mt-4 text-title text-bone">No route to {typed}</h1>
        <p className="mt-2 text-read text-dim">
          A Firetower is never on the public internet, so this Mac reaches one over your mesh
          VPN.
        </p>
      </div>

      <ul className="mt-5 space-y-2 rounded-xl border border-line bg-panel px-4 py-3.5 text-meta text-dim">
        <li>Is Tailscale running and signed in?</li>
        <li>Has this machine been shared the node?</li>
        <li>Is the address right — a name, not an IP behind a firewall?</li>
      </ul>

      <p className="mt-2.5 text-center font-mono text-micro text-mute">{detail}</p>

      <div className="mt-5 flex gap-2">
        <button
          onClick={onBack}
          className="control flex-1 justify-center border border-line bg-raise text-text hover:bg-overlay"
        >
          Change the address
        </button>
        <button
          onClick={onRetry}
          className="control flex-1 justify-center bg-bone font-medium text-ground hover:opacity-90"
        >
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
  onBack,
}: {
  url: string;
  boot: Bootstrap;
  onIn: (token: string, user: string) => void;
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
    onIn(out.token, out.user);
  };

  return (
    <>
      <div className="mb-6 text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-sage-deep bg-sage-tint text-sage">
          <Lock className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <h1 className="mt-4 text-display text-bone">{boot.organization ?? "A Firetower"}</h1>
        <p className="mt-1.5 font-mono text-meta text-mute">
          {url.replace(/^https?:\/\//, "")} · Firetower {boot.version}
        </p>
      </div>

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
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && password && go()}
            placeholder="Username"
            spellCheck={false}
            autoCapitalize="off"
            className="w-full rounded-xl border border-line bg-panel px-4 py-2.5 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && username && go()}
            placeholder="Password"
            className="mt-2 w-full rounded-xl border border-line bg-panel px-4 py-2.5 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
          />

          {wrong && <p className="mt-2.5 text-center text-meta text-brick">{wrong}</p>}

          <button
            disabled={busy || !username.trim() || !password}
            onClick={go}
            className="control mt-3 w-full justify-center bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <>
                Sign in
                <ArrowRight className="h-4 w-4" strokeWidth={2} />
              </>
            )}
          </button>
        </>
      )}

      <button
        onClick={onBack}
        className="mx-auto mt-5 block text-meta text-mute transition-colors hover:text-dim"
      >
        Not this server
      </button>
    </>
  );
}
