/**
 * Connecting a git host — the one flow, wherever it is started from.
 *
 * Three screens start it: the empty state on Repositories, the host picker in
 * its header, and the Git hosts pane. They draw entirely different rows around
 * it, so this is a hook returning a node rather than a component.
 *
 * **The browser code is a modal, and that is the whole point of it.** It was
 * drawn inline, which was wrong in four ways at once: a code built for a wide
 * sheet wrapped in half inside a 20rem column; it sat three borders deep; it
 * pushed the host under it off the bottom; and the list went on re-flowing
 * underneath while the person was looking at a different device entirely.
 * A device code takes you off this screen — so it should take over the screen.
 *
 * A pasted token is the other way in and stays inline: nothing leaves, it is
 * one field, and a modal for it would be ceremony.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { HostMark } from "~/components/ui";
import type { ProviderStatus } from "~/api/generated/model";
import {
  getListProvidersQueryKey,
  listProviders,
  useAuthorizeProvider,
  useListKinds,
  useSetProviderToken,
} from "~/api/generated/providers/providers";
import { getListReposQueryKey } from "~/api/generated/repos/repos";
import { why } from "~/data";
import { openExternal } from "~/open";
import { bold, sleep } from "~/ui/config/bits";

export function useConnect(host: ProviderStatus) {
  const cache = useQueryClient();
  const authorize = useAuthorizeProvider();
  const setToken = useSetProviderToken();
  const [code, setCode] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [token, setTokenValue] = useState("");
  const [asking, setAsking] = useState(false);

  const done = () =>
    Promise.all([
      cache.invalidateQueries({ queryKey: getListProvidersQueryKey() }),
      cache.invalidateQueries({ queryKey: getListReposQueryKey() }),
    ]);

  const start = () => {
    if (host.auth === "token") {
      setAsking(true);
      return;
    }
    authorize.mutate(
      { id: host.id },
      {
        onSuccess: async (auth) => {
          void openExternal(auth.verificationUri);
          setCode(auth);
          /* Poll until this host's pending authorization clears. The code
             expires on its own — five minutes on GitLab, fifteen on GitHub —
             and the control plane drops it, so the wait ends whether or not
             anybody cancels. */
          for (let asked = 0; asked < 600; asked++) {
            await sleep(2000);
            const still = await listProviders()
              .then((all) => all.find((x) => x.id === host.id)?.pending != null)
              .catch(() => true);
            if (!still) break;
          }
          setCode(null);
          await done();
        },
      },
    );
  };

  const node = (
    <>
      {authorize.error && <p className="px-3 pb-2 text-meta text-brick">{why(authorize.error)}</p>}
      {code && <CodeModal host={host} code={code} onClose={() => setCode(null)} />}
      {asking && (
        <PasteToken
          host={host}
          value={token}
          onChange={setTokenValue}
          busy={setToken.isPending}
          error={setToken.error ? why(setToken.error) : null}
          onCancel={() => setAsking(false)}
          onSubmit={() =>
            setToken.mutate(
              { id: host.id, data: { token: token.trim() } },
              { onSuccess: () => { setTokenValue(""); setAsking(false); void done(); } },
            )
          }
        />
      )}
    </>
  );

  return { start, node, busy: authorize.isPending };
}

/* ── The code, as the only thing on screen ─────────────────────────────── */

function CodeModal({
  host,
  code,
  onClose,
}: {
  host: ProviderStatus;
  code: { userCode: string; verificationUri: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ground/80 pt-[14vh] backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[23rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <HostMark kind={host.kind} size={14} brand />
          <span className="text-ui text-bone">Connect {host.label}</span>
          <button
            onClick={onClose}
            className="ml-auto grid h-6 w-6 place-items-center rounded-md text-mute hover:bg-raise hover:text-bone"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="px-6 py-6 text-center">
          <p className="text-title text-bone">Enter this code on {host.gitHost}</p>
          <p className="mt-1 text-meta text-dim">
            A tab is open at{" "}
            <button
              onClick={() => void openExternal(code.verificationUri)}
              className="text-bone underline decoration-line underline-offset-2"
            >
              {code.verificationUri.replace(/^https?:\/\//, "").split("?")[0]}
            </button>
          </p>

          {/* The code has the whole width here, which is the fix: inline, in a
              20rem column, it wrapped across two lines mid-code. */}
          <div className="mx-auto mt-4 flex max-w-[17rem] items-center gap-3 rounded-xl border border-line bg-ground px-4 py-3.5">
            <span className="flex-1 font-mono text-display tracking-[0.14em] whitespace-nowrap text-bone">
              {code.userCode}
            </span>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(code.userCode);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
              className="control shrink-0 border border-line bg-raise text-micro text-dim hover:bg-overlay hover:text-bone"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>

          <p className="mt-4 flex items-center justify-center gap-2 text-meta text-mute">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
            Waiting for you to approve it…
          </p>
          <p className="mt-3 text-micro leading-relaxed text-mute">
            Grant every organisation you want Firetower to clone from. Ones you skip stay hidden.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── A token, inline, because nothing leaves the screen ────────────────── */

function PasteToken({
  host,
  value,
  onChange,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  host: ProviderStatus;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const kinds = useListKinds();
  const steps = (kinds.data ?? []).find((k) => k.id === host.kind)?.tokenSteps ?? [];

  return (
    <div className="border-t border-line-soft bg-ground/40 px-3 py-2.5 text-left">
      <p className="text-meta text-dim">
        An access token of your own, with permission to clone and push.{" "}
        <button
          onClick={() => void openExternal(host.tokenPage)}
          className="text-bone underline decoration-line underline-offset-2"
        >
          Make one on {host.gitHost}
        </button>
      </p>
      {/* **Only where the link cannot do it.** GitHub and GitLab take the
          scopes as query parameters, so their page opens with the right boxes
          already ticked and a list of steps would be describing what is
          already on screen. Gitea has no such parameter and its scopes are not
          guessable from what Firetower does — a token with full repository
          access and no `user` scope connects, and then shows an empty
          repository picker. So the steps are per kind, and come from the
          server beside the scopes themselves. */}
      {steps.length > 0 && (
        <ol className="mt-1.5 space-y-1 text-meta text-mute">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="shrink-0 text-dim">{i + 1}.</span>
              <span>{bold(step)}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && onSubmit()}
          type="password"
          placeholder="Paste the token"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-line bg-ground px-2 py-1 font-mono text-ui text-bone focus:outline-none"
        />
        <button onClick={onCancel} className="control text-mute hover:text-bone">
          Cancel
        </button>
        <button
          disabled={!value.trim() || busy}
          onClick={onSubmit}
          className="control border border-line bg-raise text-bone hover:bg-overlay disabled:text-mute"
        >
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
      {error && <p className="mt-1.5 text-meta text-brick">{error}</p>}
    </div>
  );
}
