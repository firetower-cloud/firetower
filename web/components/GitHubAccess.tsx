"use client";

import { useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/ui";
import { Modal, Foot, Go, Quiet, DeviceCode, Failure } from "./Modal";
import {
  listProviders,
  listProviderRepos,
  useListProviders,
  useAuthorizeProvider,
  useListProviderRepos,
  getListProviderReposQueryKey,
} from "@/src/api/generated/providers/providers";
import type { PendingAuth, ProviderStatus, RemoteRepo } from "@/src/api/generated/model";

/**
 * Widening what Firetower can see on a git host.
 *
 * A token covers the organizations you granted on the host's approval screen,
 * and that screen is shown once — when you first authorize. Skip an
 * organization there, or join one afterwards, and there has never been a way
 * back to it from here: the picker simply doesn't list those repositories and
 * nothing says why.
 *
 * Authorizing again is the way back, because the approval screen is shown
 * every time and lists every organization with Grant or Request beside it.
 * Nothing is risked by trying — the control plane only replaces a token when a
 * new authorization is approved.
 */

/* ── the facts, as functions ───────────────────────────────────────── */

/** `acme` out of `acme/backend`, each one once, in the order first seen. */
export function ownersOf(repos: RemoteRepo[]): string[] {
  const seen: string[] = [];
  for (const repo of repos) {
    const owner = repo.slug.split("/")[0];
    if (owner && !seen.includes(owner)) seen.push(owner);
  }
  return seen;
}

/**
 * Where this application's access is reviewed on the host.
 *
 * The second half of the answer, and the one authorizing again cannot give:
 * an organization that restricts third-party applications stays dark until an
 * owner approves the request, and this is the page the request is made and
 * tracked on.
 */
export function accessUrl(clientId: string | null | undefined): string | null {
  const id = clientId?.trim();
  return id ? `https://github.com/settings/connections/applications/${id}` : null;
}

/** What a re-authorization actually bought, in a sentence. */
export function whatChanged(before: RemoteRepo[], after: RemoteRepo[]): string {
  const had = new Set(before.map((r) => r.slug));
  const gained = after.filter((r) => !had.has(r.slug));
  const owners = ownersOf(gained).filter((o) => !ownersOf(before).includes(o));

  if (gained.length === 0) {
    // Said plainly rather than dressed up as success. This is the common end
    // of the road for a restricted organization: the request is in, and
    // somebody with admin rights has to say yes before anything changes.
    return (
      "Nothing new is visible. An organization that restricts third-party " +
      "applications stays hidden until an owner approves the request."
    );
  }

  const one = gained.length === 1;
  const repos = `${gained.length} more ${one ? "repository is" : "repositories are"}`;
  if (owners.length === 0) return `${repos} visible now.`;
  const named =
    owners.length === 1 ? owners[0] : `${owners.slice(0, -1).join(", ")} and ${owners.at(-1)}`;
  return `${repos} visible now, from ${named}.`;
}

/** How much a token can see, for the line on the settings page. */
export function reach(repos: RemoteRepo[]): string {
  const owners = ownersOf(repos).length;
  const r = `${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`;
  const o = `${owners} ${owners === 1 ? "account or organization" : "accounts and organizations"}`;
  return `${r} across ${o}`;
}

/**
 * Wait until the authorization we started is no longer in flight.
 *
 * Watched through `pending` rather than through `connected`, which never
 * changes here — the token being replaced is one that already works. The
 * control plane records the authorization before it answers the request that
 * started it, so the first look either sees it or sees an attempt that is
 * already over, and either way its disappearance is the end.
 *
 * Approved, declined and expired all end the same way on purpose. Which one it
 * was is answered by what can be seen afterwards, which is the only answer
 * worth showing anybody.
 */
async function settled(id: string): Promise<void> {
  // A device code lasts about a quarter of an hour and the control plane drops
  // the attempt when it expires, so this ends on its own. The cap is there for
  // the case where nothing ever answers, not as the normal way out.
  for (let asked = 0; asked < 600; asked++) {
    await new Promise((wake) => setTimeout(wake, 2000));
    const still = await listProviders()
      .then((all) => all.find((p) => p.id === id)?.pending != null)
      .catch(() => true); // A blip is not an answer. Keep waiting.
    if (!still) return;
  }
}

/* ── the panel on the repositories page ────────────────────────────── */

/**
 * On the repositories page because that is where somebody notices the gap —
 * they came to connect a repository and it isn't in the list.
 */
export function GitHubAccess({ provider: id, label }: { provider: string; label: string }) {
  const [managing, setManaging] = useState(false);
  const { data: providers = [] } = useListProviders();
  const provider = providers.find((p) => p.id === id);

  // Nothing to widen before there is something to widen: the connect flow
  // covers the first authorization, and saying this twice would be noise.
  const connected = provider?.connected ?? false;
  const { data: repos = [] } = useListProviderRepos(id, { query: { enabled: connected } });

  if (!provider || !connected) return null;

  return (
    <div className="panel mt-2.5 px-4 py-3.5">
      <div className="flex items-baseline gap-3">
        <span className="eyebrow">{label} access</span>
        <span className="font-mono text-meta text-mute">connected</span>
        <button
          onClick={() => setManaging(true)}
          className="ml-auto text-meta text-mute transition-colors hover:text-bone"
        >
          Manage
        </button>
      </div>

      <p className="mt-1.5 text-meta text-dim">
        Firetower can see {reach(repos)}
        {repos.length > 0 && (
          <span className="text-mute"> — {ownersOf(repos).join(" · ")}</span>
        )}
        .
      </p>
      <p className="mt-1 text-meta text-mute">
        Missing an organization? {label} asks which ones to share when you authorize,
        and owners can restrict theirs.
      </p>

      {managing && <ManageAccess provider={provider} onClose={() => setManaging(false)} />}
    </div>
  );
}

/** The same thing as its own window, for the settings page. */
function ManageAccess({ provider, onClose }: { provider: ProviderStatus; onClose: () => void }) {
  return (
    <Modal title={`${provider.label} access`} onClose={onClose} wide>
      <Access provider={provider} onDone={onClose} />
    </Modal>
  );
}

/* ── the step itself, shared with the connect flow ─────────────────── */

/**
 * Explain, re-authorize, then say what changed.
 *
 * A step rather than a window so the connect flow can show it in the one it
 * already has: somebody who came to pick a repository and could not find it
 * should not lose the picker to fix that.
 */
export function Access({
  provider,
  onDone,
  backLabel,
}: {
  provider: ProviderStatus;
  onDone: () => void;
  backLabel?: string;
}) {
  const cache = useQueryClient();
  const { data: repos = [] } = useListProviderRepos(provider.id);
  const authorize = useAuthorizeProvider();

  /** The wait, once one is under way, and what it ended up buying. */
  const [waiting, setWaiting] = useState<PendingAuth | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  const start = () => {
    // Compared against once it is over: a grant that went through changes
    // this, and a request still waiting on an owner does not.
    const had = repos;
    setOutcome(null);
    authorize.mutate(
      { id: provider.id },
      {
        onSuccess: async (auth) => {
          // Opened from the click that asked for it, which is the only way
          // browsers allow.
          window.open(auth.verificationUri, "_blank", "noopener");
          setWaiting(auth);
          await settled(provider.id);
          setWaiting(null);
          // The panel behind this window counts the same repositories, so the
          // cached list has to go whether or not anything changed.
          await cache.invalidateQueries({ queryKey: getListProviderReposQueryKey(provider.id) });
          setOutcome(whatChanged(had, await listProviderRepos(provider.id).catch(() => had)));
        },
      },
    );
  };

  if (waiting) {
    return (
      <DeviceCode
        pending={waiting}
        note={`On that screen, grant every organization you want Firetower to clone from. Ones you skip stay hidden, and one an owner has to approve stays hidden until they do.`}
      />
    );
  }

  if (outcome) {
    return (
      <>
        <p className="flex items-start gap-2.5 text-ui leading-[1.6] text-dim">
          <span className="mt-[5px]">
            <Icon of={Check} size={12} className="text-sage" />
          </span>
          {outcome}
        </p>
        <p className="mt-3 text-meta text-mute">Firetower can now see {reach(repos)}.</p>
        <Foot>
          <Go onClick={onDone}>{backLabel ?? "Done"}</Go>
          <Quiet onClick={start}>Try again</Quiet>
        </Foot>
      </>
    );
  }

  const settings = accessUrl(provider.clientId);

  return (
    <>
      <p className="max-w-[56ch] text-ui leading-[1.6] text-dim">
        Firetower sees what your {provider.label} account shares with it. Two things
        can keep a repository out of the list.
      </p>

      <Path
        n="1"
        title="Its organization wasn't granted"
        body={`Authorize again — ${provider.label} lists every organization with Grant or Request beside it. What you have now is kept until a new authorization is approved, so nothing is lost by trying.`}
      >
        <button
          onClick={start}
          disabled={authorize.isPending}
          className="rounded-md border border-line bg-raise px-3 py-1.5 text-meta text-bone transition-colors hover:border-dim disabled:text-mute"
        >
          {authorize.isPending ? "Starting…" : "Authorize again"}
        </button>
      </Path>

      <Path
        n="2"
        title="An owner has to approve it"
        body={`Organizations that restrict third-party applications stay hidden until somebody with admin rights says yes. Request it there, then ask them.`}
      >
        {settings ? (
          <a
            href={settings}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1.5 text-meta text-dim underline underline-offset-2 transition-colors hover:text-bone"
          >
            Your {provider.label} application settings
            <Icon of={ArrowUpRight} size={12} />
          </a>
        ) : (
          <p className="text-meta text-mute">
            No application is registered, so there is no page to send you to.
          </p>
        )}
      </Path>

      {authorize.isError && <Failure error={authorize.error} />}

      <Foot>
        <Quiet onClick={onDone}>{backLabel ?? "Done"}</Quiet>
      </Foot>
    </>
  );
}

function Path({
  n,
  title,
  body,
  children,
}: {
  n: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4 flex gap-3">
      <span className="mt-[2px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-line font-mono text-micro text-mute">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ui text-bone">{title}</p>
        <p className="mt-0.5 max-w-[54ch] text-meta leading-[1.55] text-dim">{body}</p>
        <div className="mt-2.5">{children}</div>
      </div>
    </div>
  );
}
