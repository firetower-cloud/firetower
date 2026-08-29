"use client";

import { Check, LoaderCircle } from "lucide-react";
import { Icon } from "@/components/ui";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Foot, Go, Quiet } from "./Modal";
import { ClientIdForm } from "./SetupAccount";
import {
  useListProviders,
  useAuthorizeProvider,
  useListProviderRepos,
} from "@/src/api/generated/providers/providers";
import {
  useCreateRepo,
  useProbeRepo,
  getListReposQueryKey,
} from "@/src/api/generated/repos/repos";
import type { ProviderStatus, RemoteRepo } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * Authorize once, pick from what comes back.
 *
 * Pasting a URL still works and is one click away, but it isn't the front door:
 * you already told a git host which repositories are yours, and re-typing that
 * is work the product should be doing.
 */
export function ConnectRepo({ onClose }: { onClose: () => void }) {
  const [manual, setManual] = useState(false);

  const [started, setStarted] = useState(false);

  const { data: providers = [] } = useListProviders({
    // Polling is derived, not stored: the render that first sees `connected`
    // is the same one that stops asking.
    query: { refetchInterval: (query) => (isAwaiting(query.state.data, started) ? 2000 : false) },
  });

  const provider = providers[0];
  const connected = provider?.connected ?? false;

  return (
    <Modal title="Connect a repository" onClose={onClose} wide>
      {manual ? (
        <PasteRemote onBack={() => setManual(false)} onClose={onClose} />
      ) : !provider ? (
        <p className="py-6 text-center text-ui text-mute">Looking…</p>
      ) : !provider.configured ? (
        <NotConfigured provider={provider} onManual={() => setManual(true)} />
      ) : !connected ? (
        <Authorize
          provider={provider}
          onStart={() => setStarted(true)}
          onManual={() => setManual(true)}
        />
      ) : (
        <Pick provider={provider} onManual={() => setManual(true)} onClose={onClose} />
      )}
    </Modal>
  );
}

/* ── authorize ─────────────────────────────────────────────────────── */

/** Keep asking only while something is actually waiting to be approved. */
function isAwaiting(providers: ProviderStatus[] | undefined, started: boolean) {
  const provider = providers?.[0];
  if (!provider || provider.connected) return false;
  return started || provider.pending != null;
}

function Authorize({
  provider,
  onStart,
  onManual,
}: {
  provider: ProviderStatus;
  onStart: () => void;
  onManual: () => void;
}) {
  const authorize = useAuthorizeProvider();
  const pending = provider.pending ?? authorize.data;

  const start = () => {
    onStart();
    authorize.mutate(
      { id: provider.id },
      {
        // Opening it here rather than on render keeps the popup tied to the
        // click that asked for it, which is the only way browsers allow.
        onSuccess: (auth) => window.open(auth.verificationUri, "_blank", "noopener"),
      },
    );
  };

  if (!pending) {
    return (
      <>
        <p className="max-w-[52ch] text-ui leading-[1.6] text-dim">
          Firetower needs access to clone your repositories and push the branch a
          session works on. You choose which ones on {provider.label}.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {[
            "No password or token is typed here.",
            "The token is encrypted before it is stored, and every read of it is logged.",
            "Servers running your sessions never store it.",
          ].map((line) => (
            <li key={line} className="flex gap-2.5 text-meta text-slate">
              <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-mute" />
              {line}
            </li>
          ))}
        </ul>

        {authorize.isError && <Failure error={authorize.error} />}

        <Foot>
          <Go onClick={start} disabled={authorize.isPending}>
            {authorize.isPending ? "Starting…" : `Authorize ${provider.label}`}
          </Go>
          <Quiet onClick={onManual}>Paste a URL instead</Quiet>
        </Foot>
      </>
    );
  }

  return (
    <>
      <p className="text-ui text-dim">
        A tab opened at{" "}
        <a
          href={pending.verificationUri}
          target="_blank"
          rel="noopener"
          className="text-dim underline underline-offset-2 transition-colors hover:text-bone"
        >
          {pending.verificationUri.replace(/^https?:\/\//, "")}
        </a>
        . Enter this code:
      </p>

      <CodeToType code={pending.userCode} />

      <p className="mt-4 flex items-center gap-2 text-meta text-mute">
        <Spinner />
        Waiting for you to approve it…
      </p>

      <Foot>
        <Quiet onClick={onManual}>Paste a URL instead</Quiet>
      </Foot>
    </>
  );
}

/** Shown, not clicked — so it needs to be readable and copyable. */
export function CodeToType({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 flex items-center gap-3">
      <code className="rounded-md border border-line bg-raise px-4 py-2.5 font-mono text-display tracking-[0.18em] text-bone">
        {code}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="text-meta text-mute transition-colors hover:text-text"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/* ── the picker ────────────────────────────────────────────────────── */

function Pick({
  provider,
  onManual,
  onClose,
}: {
  provider: ProviderStatus;
  onManual: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const queryClient = useQueryClient();
  const { data: repos = [], isLoading, isError, error } = useListProviderRepos(provider.id);
  const create = useCreateRepo();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? repos.filter((r) => r.slug.toLowerCase().includes(needle)) : repos;
  }, [repos, q]);

  const connect = async () => {
    setFailure(null);
    const chosen = repos.filter((r) => picked.includes(r.slug));

    for (const [i, repo] of chosen.entries()) {
      setProgress(chosen.length > 1 ? `Connecting ${i + 1} of ${chosen.length}…` : "Connecting…");
      try {
        // Each one is verified against the host before it's saved, so an
        // authorization that doesn't actually cover a repository is caught
        // here rather than when a session tries to clone it.
        await create.mutateAsync({ data: { slug: repo.slug, remote: repo.remote } });
      } catch (e) {
        setFailure(e);
        setProgress(null);
        return;
      }
    }

    await queryClient.invalidateQueries({ queryKey: getListReposQueryKey() });
    onClose();
  };

  if (isLoading) return <p className="py-8 text-center text-ui text-mute">Loading your repositories…</p>;
  if (isError) return <Failure error={error} />;

  return (
    <>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${repos.length} repositories`}
        className="w-full rounded-sm border border-line bg-ground px-3 py-2 text-ui text-bone outline-none placeholder:text-mute focus:border-dim/40"
      />

      <div className="mt-3 flex max-h-[280px] flex-col gap-px overflow-y-auto">
        {shown.map((r) => (
          <RepoRow
            key={r.slug}
            repo={r}
            on={picked.includes(r.slug)}
            onToggle={() =>
              setPicked((p) =>
                p.includes(r.slug) ? p.filter((s) => s !== r.slug) : [...p, r.slug],
              )
            }
          />
        ))}
        {shown.length === 0 && (
          <p className="py-6 text-center text-meta text-mute">
            Nothing matches “{q}”.
          </p>
        )}
      </div>

      {failure != null && <Failure error={failure} />}

      <Foot>
        <Go onClick={connect} disabled={picked.length === 0 || progress !== null}>
          {progress ??
            (picked.length > 1 ? `Connect ${picked.length} repositories` : "Connect")}
        </Go>
        <Quiet onClick={onManual}>Paste a URL instead</Quiet>
      </Foot>
    </>
  );
}

function RepoRow({
  repo,
  on,
  onToggle,
}: {
  repo: RemoteRepo;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-3 rounded-sm px-2.5 py-2 text-left transition-colors ${
        on ? "bg-raise" : "hover:bg-raise/60"
      }`}
    >
      <span
        className={`flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-sm border ${
          on ? "border-bone bg-bone" : "border-line"
        }`}
      >
        {on && (
          <Icon of={Check} size={12} className="text-ground" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-bone">
        {repo.slug}
      </span>
      {repo.private && (
        <span className="font-narrow text-micro font-semibold tracking-[0.12em] text-mute uppercase">
          Private
        </span>
      )}
      <span className="font-mono text-micro text-mute">{repo.defaultBranch}</span>
    </button>
  );
}

/* ── pasting a remote ──────────────────────────────────────────────── */

function PasteRemote({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const [remote, setRemote] = useState("");
  const queryClient = useQueryClient();
  const probe = useProbeRepo();
  const create = useCreateRepo();

  // Checked on a pause rather than a keystroke: this reaches across the network
  // from whichever host would do the cloning.
  useEffect(() => {
    const value = remote.trim();
    if (!value) return;
    const t = setTimeout(() => probe.mutate({ data: { remote: value } }), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  const found = probe.data;

  const save = async () => {
    await create.mutateAsync({ data: { slug: found?.slug ?? "", remote: remote.trim() } });
    await queryClient.invalidateQueries({ queryKey: getListReposQueryKey() });
    onClose();
  };

  return (
    <>
      <label className="eyebrow">Repository URL or path</label>
      <input
        autoFocus
        value={remote}
        onChange={(e) => setRemote(e.target.value)}
        placeholder="https://host/acme/backend.git"
        spellCheck={false}
        className="mt-2 w-full rounded-sm border border-line bg-ground px-3 py-2 font-mono text-meta text-bone outline-none placeholder:text-mute focus:border-dim/40"
      />
      <p className="mt-2 text-meta text-mute">
        An https or ssh URL, or a path to a checkout already on the host.
      </p>

      <div className="mt-4 min-h-[52px]">
        {probe.isPending && (
          <p className="flex items-center gap-2 text-meta text-mute">
            <Spinner />
            Checking…
          </p>
        )}

        {probe.isError && <Failure error={probe.error} />}

        {found && !probe.isPending && (
          <div className="rounded-sm border border-sage/25 bg-sage/[0.04] px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <Icon of={Check} size={12} className="text-sage" />
              <span className="font-mono text-meta text-bone">{found.slug}</span>
              <span className="ml-auto font-mono text-meta text-slate">
                branches from {found.defaultBranch}
              </span>
            </div>
          </div>
        )}
      </div>

      <Foot>
        <Go onClick={save} disabled={!found || create.isPending}>
          {create.isPending ? "Connecting…" : "Connect"}
        </Go>
        <Quiet onClick={onBack}>Back</Quiet>
      </Foot>
    </>
  );
}

/* ── this build has no application registered ──────────────────────── */

function NotConfigured({
  provider,
  onManual,
}: {
  provider: ProviderStatus;
  onManual: () => void;
}) {
  const providers = useListProviders();

  return (
    <>
      <p className="max-w-[54ch] text-ui leading-[1.6] text-dim">
        No application is registered for {provider.label} yet, so there is nothing to
        authorize against. It takes about five minutes, once, and this is the whole of
        it — a device-flow application needs no secret and no callback URL.
      </p>

      <div className="mt-4">
        {/* Asked here rather than sent somewhere else to be asked: this is the
            moment somebody wants the thing it enables, and a link to the README
            is where that intention goes to die. Saved to the database, so it
            works immediately and survives a restart. */}
        <ClientIdForm onDone={() => void providers.refetch()} />
      </div>

      <Foot>
        <Go onClick={onManual}>Paste a URL instead</Go>
      </Foot>
    </>
  );
}

/* ── shared ────────────────────────────────────────────────────────── */

/**
 * The server writes these messages because only it knows which of several
 * things went wrong. Repeating them verbatim beats a generic line here.
 */
function Failure({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError ? error.message : "Something went wrong. Try again.";

  return (
    <div className="mt-4 rounded-md border border-line bg-raise px-3.5 py-2.5">
      <p className="text-meta leading-[1.55] text-bone">{message}</p>
    </div>
  );
}

export function Spinner() {
  return (
    <Icon of={LoaderCircle} size={12} className="animate-spin" />
  );
}
