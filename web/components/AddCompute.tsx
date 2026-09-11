"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Choice, Foot, Go, Quiet } from "./Modal";
import {
  useCreateHost,
  useProbeHost,
  useSshKey,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import type { Compute, Diagnosis, Host, Execution } from "@/src/api/generated/model";
import { HostReadiness } from "./HostReadiness";

export function AddCompute({
  onClose,
  initial,
}: {
  onClose: () => void;
  initial?: { sameMachine: boolean; address?: string; execution?: Execution };
}) {
  const [sameMachine, setSameMachine] = useState(initial?.sameMachine ?? false);
  const [execution, setExecution] = useState<Execution>(initial?.execution ?? "container");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [user, setUser] = useState("");
  const [label, setLabel] = useState("");
  const [container, setContainer] = useState("firetower-worker");
  const [keyPath, setKeyPath] = useState("");
  const [ownKey, setOwnKey] = useState(false);
  const [told, setTold] = useState<Diagnosis | null>(null);
  const [added, setAdded] = useState<Host | null>(null);
  const cache = useQueryClient();
  const create = useCreateHost();
  const probe = useProbeHost();
  const busy = create.isPending || probe.isPending;
  const ready = !!address.trim() && !!label.trim() && (execution === "host" || !!container.trim());
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setTold(null);
      setter(value);
    };
  const body = () => ({
    name: label.trim(),
    sameMachine,
    compute: {
      type: "Server",
      host: address.trim(),
      user: user.trim() || undefined,
      key: ownKey && keyPath.trim() ? { type: "File", path: keyPath.trim() } : { type: "Managed" },
      container: execution === "container" ? container.trim() : undefined,
    } as Compute,
  });
  const save = () =>
    create.mutate(
      { data: body() },
      {
        onSuccess: async (host) => {
          await cache.invalidateQueries({ queryKey: getListHostsQueryKey() });
          setAdded(host);
        },
      },
    );
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

  if (added)
    return (
      <Modal title={`Set up ${added.name}`} onClose={onClose} wide>
        <HostReadiness host={added} />
        <Foot>
          <Go onClick={onClose}>Done</Go>
        </Foot>
      </Modal>
    );

  return (
    <Modal title="Add execution environment" onClose={onClose} wide>
      <div className="flex flex-col gap-2">
        <Choice
          on={sameMachine}
          title="This server — alongside Firetower"
          body="Connect to the underlying machine hosting the control plane."
          onClick={() => edit(setSameMachine)(true)}
        />
        <Choice
          on={!sameMachine}
          title="A remote machine"
          body="Connect to another machine over SSH."
          onClick={() => edit(setSameMachine)(false)}
        />
      </div>
      <Field
        label="Environment name"
        autoFocus
        value={label}
        onChange={edit(setLabel)}
        placeholder="Video VM — host"
      >
        A name for this worker environment. You can configure both execution options on the same
        machine.
      </Field>
      <fieldset className="mt-4 space-y-2">
        <legend className="mb-2 text-meta text-dim">Run in</legend>
        <Choice
          on={execution === "container"}
          title="Container"
          body="Uses the tools and resources available inside your worker container."
          onClick={() => edit(setExecution)("container")}
        />
        <Choice
          on={execution === "host"}
          title="Directly on host"
          body="Uses the machine’s installed tools and services as the SSH account."
          onClick={() => edit(setExecution)("host")}
        />
      </fieldset>
      <Field
        label="SSH address"
        value={address}
        onChange={edit(setAddress)}
        placeholder="192.0.2.10"
      >
        {sameMachine
          ? "Use the underlying VM’s address reachable from Firetower. When Firetower runs in Docker, localhost points inside its container."
          : "A hostname or IP address reachable from Firetower. Add :2222 for a custom SSH port."}
      </Field>
      <Field
        label="SSH account"
        value={user}
        onChange={edit(setUser)}
        optional
        placeholder="editor"
      >
        {execution === "host"
          ? "The worker and its agents run as this account, with its existing permissions."
          : "This account connects to the machine and must be able to run docker exec in the selected container."}
      </Field>
      <HowWeGetIn
        ownKey={ownKey}
        onOwnKey={setOwnKey}
        keyPath={keyPath}
        onKeyPath={edit(setKeyPath)}
        user={user}
      />
      {execution === "container" && (
        <Field
          label="Container name"
          value={container}
          onChange={edit(setContainer)}
          placeholder="firetower-worker"
        >
          An existing worker container on this machine. Set it up and start it yourself before
          checking the connection.
        </Field>
      )}
      <p className="mt-3 text-meta text-mute">
        Firetower checks what is missing and shows setup instructions. You install the requirements
        on the selected machine.
      </p>
      {(create.error || probe.error) && (
        <p role="alert" className="mt-3 text-meta text-brick">
          {(create.error || probe.error)?.message}
        </p>
      )}
      {told && <NotAnswering told={told} />}
      <Foot>
        <Go onClick={add} disabled={!ready || busy}>
          {busy ? "Checking…" : told ? "Check again" : "Check and add"}
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
            the username above is the account you gave it to — and if that machine manages keys
            elsewhere, Google Cloud metadata or an SSH CA, it belongs there rather than in{" "}
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
        Save the environment to keep its connection settings. Firetower will retry the connection
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
 * this sits above the address fields rather than below them.
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
      <p className="eyebrow">How Firetower gets in</p>

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
 * A server takes three of these. Written out three times they drift — one loses
 * its hint, another its spell-checking — and a form that looks assembled from
 * parts reads as one you can't trust with a key path.
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
