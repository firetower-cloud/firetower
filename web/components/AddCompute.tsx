"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Foot, Go, Quiet } from "./Modal";
import {
  useCreateHost,
  useProbeHost,
  useSshKey,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import type { Compute, Diagnosis } from "@/src/api/generated/model";
import { parseDestination } from "@/src/api/environments";

/**
 * Adding a machine.
 *
 * ## What it asks, and what it stopped asking
 *
 * Three fields about the machine — where it is, who to connect as, and what to
 * call the container when one is used — plus the key it has to be given.
 *
 * The address and the account were briefly one box taking `editor@10.0.4.7`.
 * They are two things: an address is where, an account is who, and a form is
 * clearer when it says so. The single box also quietly dropped the container
 * name, which left no way to point Firetower at a container called anything
 * other than `firetower-worker`. Pasting a whole destination into the address
 * still works — `parseDestination` splits it and the server prefers a field
 * somebody filled in over one it parsed.
 *
 * Two questions did go, and stay gone:
 *
 * * **Container or directly on host** is a mode, chosen per workspace, on the
 *   machine. Both are available on everything Firetower can reach, so asking
 *   here meant adding the same machine twice to get both.
 * * **This server or a remote one** was only ever about ssh-ing to the machine
 *   Firetower is already on. It does not.
 */
/** The container to look for, and the only one anybody has to type. */
const DEFAULT_CONTAINER = "firetower-worker";

export function AddCompute({ onClose }: { onClose: () => void }) {
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [container, setContainer] = useState(DEFAULT_CONTAINER);
  const [label, setLabel] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  const [told, setTold] = useState<Diagnosis | null>(null);
  const cache = useQueryClient();
  const create = useCreateHost();
  const probe = useProbeHost();
  const busy = create.isPending || probe.isPending;
  // Only so the form can show what it made of a pasted destination. The server
  // parses the address itself and prefers the account field when it has one.
  const typed = parseDestination(address);
  const account = user.trim() || typed.user || "";
  const ready = !!typed.host;

  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setTold(null);
      setter(value);
    };

  // The environment made here is the one reached directly on the machine. The
  // container on it is the same connection with `docker exec` in front, and is
  // made when somebody picks that mode — but the *name* to use has to be
  // collected now, because nothing later asks for it.
  const body = () => ({
    name: label.trim() || undefined,
    compute: {
      type: "Server",
      host: address.trim(),
      user: user.trim() || undefined,
      key: ownKey && keyPath.trim() ? { type: "File", path: keyPath.trim() } : { type: "Managed" },
    } as Compute,
  });

  // Both environments, in one go.
  //
  // A machine is a place and the two ways of running on it are modes, so a
  // machine that has just been added should have both — otherwise picking
  // Container in New workspace has to invent one, and the name typed above
  // would have nowhere to live. The container is created rather than probed:
  // whether it is running is a question for the moment somebody picks it, and
  // it is the one HostReadiness already answers.
  const save = async () => {
    await create.mutateAsync({ data: body() });
    const named = container.trim();
    if (named) {
      const base = label.trim() || typed.host;
      await create
        .mutateAsync({
          data: {
            name: `${base} · container`,
            compute: { ...body().compute, container: named } as Compute,
          },
        })
        // A machine that is added and a second environment that is not is
        // still a machine that is added. Picking Container makes one.
        .catch(() => {});
    }
    await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
    onClose();
  };

  const add = () =>
    probe.mutate(
      { data: body() },
      {
        onSuccess: (result) => {
          if (result.reached) save();
          else setTold(result.diagnosis ?? null);
        },
      },
    );

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
        Who to connect as. Directly on the host, the worker and its agents run as this account with
        its permissions; for a container, it is the account that runs{" "}
        <code className="font-mono">docker exec</code>. Left blank, it is whatever your ssh config
        says.
      </Field>

      <Field
        label="Container name"
        optional
        value={container}
        onChange={edit(setContainer)}
        placeholder={DEFAULT_CONTAINER}
      >
        Which container to run agents in, when this machine is used in Container mode. Leave it as{" "}
        <code className="font-mono">{DEFAULT_CONTAINER}</code> unless yours is called something
        else.
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

      <HowWeGetIn
        ownKey={ownKey}
        onOwnKey={setOwnKey}
        keyPath={keyPath}
        onKeyPath={edit(setKeyPath)}
        user={account}
      />

      <p className="mt-3 text-meta leading-[1.5] text-mute">
        Both ways of running are then available on it — in the worker container named above, or on
        the machine itself. Firetower checks whichever you pick, when you pick it, and says what is
        missing.
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
          <Quiet onClick={save} disabled={!ready || busy}>
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
 * The command, for whoever adds keys on the machine itself.
 *
 * The path follows the username rather than saying `~/.ssh`, because the
 * account you paste this as is often not the account Firetower will be. Pasting
 * `~/.ssh/authorized_keys` while logged in as root puts the key in root's file
 * and leaves `deploy` still refusing.
 *
 * `mkdir` and both `chmod`s are not padding: sshd ignores an `authorized_keys`
 * it considers too permissive, without saying so, and a fresh cloud image often
 * has no `~/.ssh` at all. Either fails in a way indistinguishable from a wrong
 * key.
 */
function authorizedKeys(user: string, key: string) {
  const who = user.trim();
  const home = !who || who === "root" ? "/root" : `/home/${who}`;
  const owner = who || "root";

  return [
    `mkdir -p ${home}/.ssh && chmod 700 ${home}/.ssh`,
    `echo '${key}' >> ${home}/.ssh/authorized_keys`,
    `chmod 600 ${home}/.ssh/authorized_keys`,
    `chown -R ${owner} ${home}/.ssh`,
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
 * metadata on Google Cloud, an SSH CA where there is one, and
 * `authorized_keys` on a machine you already own. A command assumes the last of
 * those, and on Google Cloud the guest agent will quietly undo it.
 */
function HowWeGetIn({
  ownKey,
  onOwnKey,
  keyPath,
  onKeyPath,
  user,
}: {
  ownKey: boolean;
  onOwnKey: (on: boolean) => void;
  keyPath: string;
  onKeyPath: (path: string) => void;
  /** Whose authorized_keys the command should write to. */
  user: string;
}) {
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

      {ownKey ? (
        <>
          <Field
            label="Private key"
            optional
            value={keyPath}
            onChange={onKeyPath}
            placeholder="~/.ssh/id_ed25519"
          >
            A path on the machine running Firetower — which, if that is a container, is inside the
            container rather than on yours. A key you can see is not necessarily one it can.
          </Field>
          <button
            type="button"
            onClick={() => onOwnKey(false)}
            className="mt-3 text-meta text-slate hover:text-bone"
          >
            ← Use Firetower&apos;s key
          </button>
        </>
      ) : (
        <>
          <p className="mt-2 text-meta leading-[1.5] text-mute">
            Give this public key to the machine you are about to name. It is public — safe to paste
            into a provider&apos;s web form, a cloud-init file, or
            <code className="mx-1 font-mono text-slate">authorized_keys</code> on a machine you own.
          </p>

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

          <p className="mt-2 text-meta leading-[1.5] text-mute">
            Most providers take it when you create the machine, or in its settings afterwards. Some
            manage keys their own way — Google Cloud through instance metadata or OS Login, and an
            SSH CA through the CA.
          </p>

          <button
            type="button"
            onClick={() => setShowing(!showing)}
            className="mt-3 text-meta text-slate hover:text-bone"
          >
            {showing ? "▾" : "▸"} Adding it on the machine yourself
          </button>

          {showing && (
            <pre className="mt-2 overflow-x-auto rounded-sm bg-black/25 px-3 py-2 font-mono text-meta leading-[1.7] text-bone">
              {authorizedKeys(user, identity?.publicKey ?? "…")}
            </pre>
          )}

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="font-mono text-meta text-mute">{identity?.fingerprint ?? ""}</span>
            <button
              type="button"
              onClick={() => onOwnKey(true)}
              className="shrink-0 text-meta text-slate hover:text-bone"
            >
              Use my own key instead →
            </button>
          </div>
        </>
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
