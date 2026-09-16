"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Foot, Go, Quiet } from "./Modal";
import {
  useCreateHost,
  useInstallWorker,
  useProbeHost,
  useSshKey,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import { getListAgentsQueryKey, useInstallAgent, useListAgents } from "@/src/api/generated/agents/agents";
import type { AgentView, Compute, Diagnosis, Host } from "@/src/api/generated/model";
import { parseDestination, waitForOnline } from "@/src/api/environments";

/**
 * Adding a machine.
 *
 * ## What it asks
 *
 * Two fields about the machine — where it is and who to connect as — and the
 * key the machine has to be given. The key is shown, not a command: people
 * know where their keys go, and a command is wrong on Google Cloud, wrong
 * behind an SSH CA, and wrong wherever `~/.ssh` is not the place.
 *
 * The address and the account were briefly one box taking `editor@10.0.4.7`.
 * They are two things: an address is where, an account is who, and a form is
 * clearer when it says so. Pasting a whole destination into the address still
 * works — `parseDestination` splits it and the server prefers a field somebody
 * filled in over one it parsed.
 *
 * What it does not ask: **container or directly on host** — agents run on the
 * machine, as the account above; **this server or a remote one** — that was
 * only ever about ssh-ing to the machine Firetower is already on; and **which
 * key** — Firetower's own is the one way in, and a private key on the control
 * plane's filesystem was a path nobody could see from a container.
 *
 * Nothing on this dialog installs anything. Once the key is in, the machine's
 * own panel does that.
 */
export function AddCompute({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [label, setLabel] = useState("");
  const [told, setTold] = useState<Diagnosis | null>(null);
  // The machine, once it is saved and ssh got in but found no worker: the
  // dialog turns into that next step rather than closing onto a row that
  // looks broken.
  const [made, setMade] = useState<{ host: Host; remedy?: string } | null>(null);
  const [settling, setSettling] = useState(false);
  // Once the worker answers, one more step: which agents the machine should
  // run, so it is launchable when this closes.
  const [stage, setStage] = useState<"worker" | "agents">("worker");
  const agents = useListAgents();
  const installAgent = useInstallAgent();
  const [fetched, setFetched] = useState<Record<string, "fetching" | "done" | string>>({});
  const cache = useQueryClient();
  const create = useCreateHost();
  const probe = useProbeHost();
  const installWorker = useInstallWorker();
  const busy = create.isPending || probe.isPending || installWorker.isPending || settling;
  // Only so the form can show what it made of a pasted destination. The server
  // parses the address itself and prefers the account field when it has one.
  const typed = parseDestination(address);
  const ready = !!typed.host;

  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setTold(null);
      setter(value);
    };

  const body = () => ({
    name: label.trim() || undefined,
    compute: {
      type: "Server",
      host: address.trim(),
      user: user.trim() || undefined,
      key: { type: "Managed" },
    } as Compute,
  });

  const save = async (needsWorker: Diagnosis | null) => {
    const host = await create.mutateAsync({ data: body() });
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    if (needsWorker) setMade({ host, remedy: needsWorker.remedy ?? undefined });
    else onClose();
  };

  const add = () =>
    probe.mutate(
      { data: body() },
      {
        onSuccess: (result) => {
          if (!result.reached) return setTold(result.diagnosis ?? null);
          save(result.diagnosis?.cause === "WorkerMissing" ? result.diagnosis : null);
        },
      },
    );

  const install = async () => {
    if (!made) return;
    await installWorker.mutateAsync({ id: made.host.id });
    setSettling(true);
    const online = await waitForOnline(made.host.id);
    setSettling(false);
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    if (online) setStage("agents");
    else onClose();
  };

  const fetchAgent = async (a: AgentView) => {
    if (!made) return;
    setFetched((f) => ({ ...f, [a.kind]: "fetching" }));
    try {
      await installAgent.mutateAsync({ kind: a.kind, data: { hostId: made.host.id } });
      setFetched((f) => ({ ...f, [a.kind]: "done" }));
    } catch (e) {
      setFetched((f) => ({ ...f, [a.kind]: (e as Error).message }));
    }
    await cache.invalidateQueries({ queryKey: getListAgentsQueryKey() });
  };

  if (made && stage === "agents") {
    const offered = (agents.data ?? []).filter((a) => a.enabled && a.supported);
    const fetching = Object.values(fetched).includes("fetching");
    return (
      <Modal title="Add a machine" onClose={onClose} wide>
        <p className="mt-2 text-meta text-bone">
          <span aria-hidden className="mr-2 font-mono text-sage">✓</span>
          Connected to {made.host.name}. The worker is installed.
        </p>
        <p className="mt-3 text-meta leading-[1.5] text-mute">
          Which agents should this machine run? Each is fetched onto the machine as the standalone
          binary its publisher ships; nothing else is needed for it.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {offered.map((a) => (
            <button
              key={a.kind}
              type="button"
              disabled={fetched[a.kind] === "fetching" || fetched[a.kind] === "done"}
              onClick={() => fetchAgent(a)}
              className="rounded-sm border border-line px-3 py-2 text-meta text-bone hover:border-dim disabled:opacity-60"
            >
              {fetched[a.kind] === "done" ? `✓ ${a.label}` : fetched[a.kind] === "fetching" ? `Fetching ${a.label}…` : `Install ${a.label}`}
            </button>
          ))}
        </div>
        {Object.entries(fetched)
          .filter(([, v]) => v !== "fetching" && v !== "done")
          .map(([k, v]) => (
            <p key={k} role="alert" className="mt-2 text-meta text-brick">
              {v}
            </p>
          ))}
        <Foot>
          <Go onClick={onClose} disabled={fetching}>
            Done
          </Go>
        </Foot>
      </Modal>
    );
  }

  if (made) {
    const account = (made.host.compute.type === "Server" && made.host.compute.user) || "the ssh account";
    return (
      <Modal title="Add a machine" onClose={onClose} wide>
        <p className="mt-2 text-meta text-bone">
          <span aria-hidden className="mr-2 font-mono text-sage">✓</span>
          Connected to {made.host.name} as {account}.
        </p>
        <p className="mt-2 text-meta text-bone">
          <span aria-hidden className="mr-2 font-mono text-brick">✕</span>
          There is no worker on it yet.
        </p>
        <p className="mt-3 text-meta leading-[1.5] text-mute">
          Firetower puts the worker built for that machine into{" "}
          <code className="font-mono">~/.firetower/worker/bin</code> over the connection it just
          made. No sudo, nothing outside that account&apos;s home. Anything else the machine is
          missing is shown afterwards, with the command that installs it.
        </p>
        {made.remedy && (
          <details className="mt-3 text-meta text-mute">
            <summary className="cursor-pointer hover:text-bone">Or do it on the machine yourself</summary>
            <code className="mt-1.5 block break-all rounded-sm bg-black/25 px-3 py-2 font-mono text-meta text-bone">
              {made.remedy}
            </code>
          </details>
        )}
        {installWorker.error && (
          <p role="alert" className="mt-3 text-meta text-brick">
            {installWorker.error.message}
          </p>
        )}
        <Foot>
          <Go onClick={install} disabled={busy}>
            {installWorker.isPending ? "Installing…" : settling ? "Reconnecting…" : "Install the worker"}
          </Go>
          <Quiet onClick={onClose} disabled={busy}>
            Later
          </Quiet>
        </Foot>
      </Modal>
    );
  }

  return (
    <Modal title="Add a machine" onClose={onClose} wide>
      <Field
        label="IP address or hostname"
        autoFocus
        value={address}
        onChange={edit(setAddress)}
        placeholder="192.0.2.10"
      >
        Reachable from Firetower. Add <code className="font-mono">:2222</code> for a port that is
        not 22. A whole <code className="font-mono">user@host</code> destination can be pasted here
        and it comes apart on its own.
      </Field>

      <Field
        label="SSH account"
        optional
        value={user}
        onChange={edit(setUser)}
        placeholder={typed.user || "editor"}
      >
        Who to connect as. The worker and its agents run as this account, with its permissions.
        Left blank, it is whatever your ssh config says.
      </Field>

      <Field
        label="Name"
        optional
        value={label}
        onChange={edit(setLabel)}
        placeholder={typed.host || "video-vm"}
      >
        What you call it, in every list. Left blank it is called {typed.host || "where it is"}.
      </Field>

      <HowWeGetIn />

      <p className="mt-3 text-meta leading-[1.5] text-mute">
        Firetower then connects and says what the machine has and what it is missing — the worker
        first, which it installs from there.
      </p>

      {(create.error || probe.error) && (
        <p role="alert" className="mt-3 text-meta text-brick">
          {(create.error || probe.error)?.message}
        </p>
      )}
      {told && <NotAnswering told={told} />}
      <Foot>
        <Go onClick={add} disabled={!ready || busy}>
          {busy ? "Checking…" : told ? "Check again" : "Add"}
        </Go>
        {told && (
          <Quiet onClick={() => save(null)} disabled={!ready || busy}>
            Save for later
          </Quiet>
        )}
        <Quiet onClick={onClose}>Cancel</Quiet>
      </Foot>
    </Modal>
  );
}

/**
 * The host was added, and it didn't answer.
 *
 * Not styled as an error: nothing was wrong with what was typed. The command is
 * the point of the panel, so it carries the weight.
 */
function NotAnswering({ told }: { told: Diagnosis }) {
  const { data: identity } = useSshKey();
  const refused = told.cause === "AuthRefused";

  return (
    <div className="mt-4 rounded-sm border border-slate/30 bg-slate/[0.05] px-3.5 py-3">
      <p className="text-meta leading-[1.55] text-brick">{told.summary}</p>

      {/* By far the likeliest first failure now: the machine has never been
          told about Firetower's key. The fix is a copy-paste, so it goes here
          rather than behind a link to somewhere else. */}
      {refused && identity && (
        <>
          <p className="mt-2 text-meta leading-[1.55] text-dim">
            Firetower authenticates with its own key, and that machine has not accepted it. Check
            the username in the address is the account you gave it to — and if that machine manages
            keys elsewhere, Google Cloud metadata or an SSH CA, it belongs there rather than in{" "}
            <code className="font-mono">authorized_keys</code>.
          </p>
          <code className="mt-2 block overflow-x-auto rounded-sm bg-black/25 px-3 py-2 font-mono text-meta break-all text-bone">
            {identity.publicKey}
          </code>
        </>
      )}

      {told.remedy && (
        <pre className="mt-2.5 overflow-x-auto rounded-sm bg-black/25 px-3 py-2 font-mono text-meta leading-[1.6] text-bone">
          {told.remedy}
        </pre>
      )}

      {/* What the machine said, folded away: always available, never in the way. */}
      {told.detail && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-meta text-mute">What it said</summary>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-meta leading-[1.6] text-mute">
            {told.detail}
          </pre>
        </details>
      )}

      {/* Hosts connect at start-up and when added; nothing retries in between. */}
      <p className="mt-2.5 text-meta leading-[1.5] text-mute">
        Save the machine to keep its connection settings. Firetower will retry the connection
        automatically.
      </p>
    </div>
  );
}

/**
 * The lines for whoever adds the key on the machine itself, run as the
 * account Firetower will connect as — `~` is that account's home, wherever
 * the machine keeps it (`/home` on Linux, `/Users` on a Mac, somewhere else
 * entirely under LDAP). Guessing the path was wrong on every Mac.
 *
 * `mkdir` and both `chmod`s are not padding: sshd ignores an `authorized_keys`
 * it considers too permissive, without saying so, and a fresh machine often
 * has no `~/.ssh` at all.
 */
function authorizedKeys(key: string) {
  return [
    "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
    `printf '%s\\n' '${key}' >> ~/.ssh/authorized_keys`,
    "chmod 600 ~/.ssh/authorized_keys",
  ].join("\n");
}

/**
 * The step that happens on the *other* machine.
 *
 * Firetower dials out with a key it made for itself, so the machine has to be
 * given the public half before it will let us in. Nothing here can do that —
 * it is a change on a machine we cannot reach yet, which is the whole reason
 * this sits beside the address rather than below it.
 *
 * The key is what is offered, not a command. Where it goes depends on the
 * machine: a provider's web form when the VM is being made now, instance
 * metadata or OS Login on Google Cloud, an SSH CA where there is one, and
 * `authorized_keys` on a machine you already own. A command assumes the last of
 * those, and on Google Cloud the guest agent will quietly undo it.
 */
function HowWeGetIn() {
  const { data: identity, isLoading } = useSshKey();
  const [copied, setCopied] = useState(false);
  const [showing, setShowing] = useState(false);

  const copy = async () => {
    if (!identity) return;
    await navigator.clipboard.writeText(identity.publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-5 rounded-sm border border-line bg-ground/40 p-3">
      <p className="eyebrow">Firetower gets in with this key</p>

      <div className="mt-2 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm border border-line bg-ground px-3 py-2 font-mono text-meta leading-[1.5] text-bone">
          {isLoading ? "…" : (identity?.publicKey ?? "no key yet")}
        </code>
        <button
          type="button"
          onClick={copy}
          disabled={!identity}
          className="shrink-0 rounded-sm border border-line px-3 py-2 text-meta text-slate hover:text-bone disabled:opacity-40"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-1.5 font-mono text-meta text-mute">{identity?.fingerprint ?? ""}</p>

      <p className="mt-2 text-meta leading-[1.5] text-mute">
        Give it to the machine the way that machine takes keys:{" "}
        <code className="font-mono text-slate">~/.ssh/authorized_keys</code> of the account above on
        a machine you own; the provider&apos;s console, instance metadata or OS Login on Google
        Cloud; the CA where there is one. It is public — safe anywhere.
      </p>

      <button
        type="button"
        onClick={() => setShowing(!showing)}
        className="mt-3 text-meta text-slate hover:text-bone"
      >
        {showing ? "▾" : "▸"} Adding it to authorized_keys by hand, logged in as that account
      </button>

      {showing && (
        <pre className="mt-2 overflow-x-auto rounded-sm bg-black/25 px-3 py-2 font-mono text-meta leading-[1.7] text-bone">
          {authorizedKeys(identity?.publicKey ?? "…")}
        </pre>
      )}
    </div>
  );
}

/**
 * One labelled input and the sentence explaining it.
 *
 * Written out separately they drift — one loses its hint, another its
 * spell-checking — and a form that looks assembled from parts reads as one you
 * can't trust with a key path.
 */
function Field({
  label,
  value,
  onChange,
  placeholder,
  children,
  autoFocus,
  optional,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** What this is for, in a sentence. */
  children: React.ReactNode;
  autoFocus?: boolean;
  /** Said out loud, so nobody fills in a guess to get past it. */
  optional?: boolean;
}) {
  return (
    <div className="mt-4">
      <label className="eyebrow">
        {label}
        {optional && " · optional"}
      </label>
      <input
        aria-label={label}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="mt-2 w-full rounded-sm border border-line bg-ground px-3 py-2 font-mono text-meta text-bone outline-none placeholder:text-mute focus:border-dim/40"
      />
      <p className="mt-2 text-meta leading-[1.5] text-mute">{children}</p>
    </div>
  );
}
