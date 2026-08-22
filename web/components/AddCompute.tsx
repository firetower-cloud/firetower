"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Choice, Foot, Go, Quiet } from "./Modal";
import {
  useCreateHost,
  useSshKey,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import type { Compute, Diagnosis, SshKey } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

type Kind = "Container" | "Server";

/** The image a worker container runs here. Built by `just worker-image`. */
const WORKER_IMAGE = "firetower/worker:dev";

/** What the compose file in the instructions calls it. */
const DEFAULT_CONTAINER = "firetower-worker";

/**
 * Adding somewhere for agents to run.
 *
 * This machine isn't offered: it is registered at start-up and always there.
 * Two kinds are worth adding — a container here, or a server you own.
 *
 * Connecting happens as part of adding, so a wrong address is a message here
 * rather than a host that silently never works.
 */
export function AddCompute({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("Container");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  /**
   * A path to a key on the machine running the control plane.
   *
   * Empty means Firetower's own key, which is what almost everyone wants and
   * the only thing that works when the control plane is in a container: a path
   * is read inside that container, so one naming a file on your machine names
   * nothing.
   */
  const [keyPath, setKeyPath] = useState("");
  /** Whether the path field is even on screen. */
  const [ownKey, setOwnKey] = useState(false);
  /**
   * What you call it — the name shown on every screen.
   *
   * Separate from the container below, which is a machine's business rather
   * than yours. They used to be one variable, which is why adding a server
   * could not name it: the field was only ever rendered for a container.
   */
  const [label, setLabel] = useState("");
  /** Which container the worker runs in. Empty runs the binary on the host. */
  const [container, setContainer] = useState(DEFAULT_CONTAINER);
  /**
   * Added, and not answering.
   *
   * Not an error: the host exists either way. Kept on screen because the fix is
   * usually on that machine, and closing would hide what it said.
   */
  const [notAnswering, setNotAnswering] = useState<Diagnosis | null>(null);

  const queryClient = useQueryClient();
  const create = useCreateHost();

  /**
   * Firetower's own key unless a path was given.
   *
   * Not `Default`: that leaves the choice to ssh, which in a container means
   * an agent that is not running and a `~/.ssh` that is empty. It stays
   * reachable for a host added before this existed, and is not worth offering
   * to somebody adding one now.
   */
  const sshKey = (): SshKey =>
    ownKey && keyPath.trim() ? { type: "File", path: keyPath.trim() } : { type: "Managed" };

  const compute = (): Compute => {
    switch (kind) {
      case "Container":
        return {
          type: "Container",
          image: WORKER_IMAGE,
          name: label.trim() || "firetower-worker",
        };
      case "Server":
        return {
          type: "Server",
          host: address.trim(),
          // Left empty means ssh decides, which is what lets a name from your
          // config bring its own. A blank string would mean something else.
          user: user.trim() || undefined,
          key: sshKey(),
          // And empty here means the binary runs on the machine itself.
          container: container.trim() || undefined,
        };
    }
  };

  // A server needs both. Disabled until then rather than refused afterwards:
  // the fix is right there, and an error would be telling somebody something
  // the form could have shown.
  const ready =
    kind === "Server"
      ? address.trim().length > 0 && label.trim().length > 0
      : label.trim().length > 0;

  const add = () =>
    create.mutate(
      { data: { compute: compute(), name: label.trim() || undefined } },
      {
        onSuccess: async (host) => {
          await queryClient.invalidateQueries({ queryKey: getListHostsQueryKey() });
          if (host.diagnosis) {
            setNotAnswering(host.diagnosis);
            return;
          }
          onClose();
        },
      },
    );

  return (
    <Modal title="Add compute" onClose={onClose} wide>
      <div className="flex flex-col gap-2">
        <Choice
          on={kind === "Container"}
          title="A container here"
          tag="linux"
          body="Runs on this machine but behaves like a server, and can't reach your files. Nothing to install."
          onClick={() => setKind("Container")}
        />
        <Choice
          on={kind === "Server"}
          title="A server"
          tag="ssh"
          body="Your own machine, over ssh. Work carries on with your laptop shut."
          onClick={() => setKind("Server")}
        />
      </div>

      {kind === "Server" && (
        <>
          <Field label="Name" autoFocus value={label} onChange={setLabel} placeholder="fire-02">
            What you call this machine. It is what every screen shows — the
            session picker, the fleet, the sidebar — so make it the thing you
            say out loud rather than where it happens to live.
          </Field>

          <Field
            label="Where to ssh"
            value={address}
            onChange={setAddress}
            placeholder="203.0.113.44"
          >
            A hostname, an address, or a name from your ssh config. Add{" "}
            <code className="font-mono text-slate">:2222</code> for a port other than the
            usual one.
          </Field>

          <Field
            label="Username"
            optional
            value={user}
            onChange={setUser}
            placeholder="root"
          >
            Who to connect as. Left empty, ssh decides — which is the point of a name from
            your config, since that file may already say.
          </Field>

          <HowWeGetIn
            ownKey={ownKey}
            onOwnKey={setOwnKey}
            keyPath={keyPath}
            onKeyPath={setKeyPath}
          />

          <Field
            label="Container"
            optional
            value={container}
            onChange={setContainer}
            placeholder={DEFAULT_CONTAINER}
          >
            What the worker runs in over there, reached with{" "}
            <code className="font-mono text-slate">docker exec</code> once ssh has got us
            onto the machine. Empty for a machine with Firetower in its own image, which
            runs it directly.
          </Field>

          <p className="mt-4 text-[12px] leading-[1.5] text-mute">
            The worker has to be running there already. If it isn&apos;t, the host is still
            added and says what to do about it.
          </p>
        </>
      )}

      {kind === "Container" && (
        <Field
          label="Container name"
          autoFocus
          value={label}
          onChange={setLabel}
          placeholder="firetower-worker"
        >
          Started from <code className="font-mono text-slate">{WORKER_IMAGE}</code> and
          reached with <code className="font-mono text-slate">docker exec</code> — no ssh,
          no keys. Firetower stops and removes it with the host.
        </Field>
      )}

      {create.isError && (
        <div className="mt-4 rounded-[6px] border border-ember/30 bg-ember/[0.05] px-3.5 py-2.5">
          <p className="text-[12.5px] leading-[1.55] text-bone">
            {create.error instanceof ApiError
              ? create.error.message
              : "Couldn't add that."}
          </p>
        </div>
      )}

      {notAnswering && <NotAnswering told={notAnswering} />}

      <Foot>
        {/* No retry: the host exists, so adding it again is a name conflict. */}
        {notAnswering ? (
          <Go onClick={onClose}>Done</Go>
        ) : (
          <>
            <Go onClick={add} disabled={!ready || create.isPending}>
              {create.isPending ? "Connecting…" : "Add it"}
            </Go>
            <Quiet onClick={onClose}>Cancel</Quiet>
          </>
        )}
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
  return (
    <div className="mt-4 rounded-[6px] border border-slate/30 bg-slate/[0.05] px-3.5 py-3">
      <p className="text-[12.5px] leading-[1.55] text-bone">{told.summary}</p>

      {told.remedy && (
        <pre className="mt-2.5 overflow-x-auto rounded-[4px] bg-black/25 px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-bone">
          {told.remedy}
        </pre>
      )}

      {/* What the machine said, folded away: always available, never in the way. */}
      {told.detail && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-[11.5px] text-mute">
            What it said
          </summary>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-[1.6] text-mute">
            {told.detail}
          </pre>
        </details>
      )}

      {/* Hosts connect at start-up and when added; nothing retries in between. */}
      <p className="mt-2.5 text-[11.5px] leading-[1.5] text-mute">
        It&apos;s on the Compute screen either way. Firetower tries it again next
        time it starts.
      </p>
    </div>
  );
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
}: {
  ownKey: boolean;
  onOwnKey: (on: boolean) => void;
  keyPath: string;
  onKeyPath: (path: string) => void;
}) {
  const { data: identity, isLoading } = useSshKey();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!identity) return;
    await navigator.clipboard.writeText(identity.publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-5 rounded-[6px] border border-line bg-ground/40 p-3">
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
            A path on the machine running Firetower — which, if that is a container, is
            inside the container rather than on yours. A key you can see is not
            necessarily one it can.
          </Field>
          <button
            type="button"
            onClick={() => onOwnKey(false)}
            className="mt-3 text-[12px] text-slate hover:text-bone"
          >
            ← Use Firetower&apos;s key
          </button>
        </>
      ) : (
        <>
          <p className="mt-2 text-[12px] leading-[1.5] text-mute">
            Give this public key to the machine you are about to name. It is public —
            safe to paste into a provider&apos;s web form, a cloud-init file, or
            <code className="mx-1 font-mono text-slate">authorized_keys</code> on a
            machine you own.
          </p>

          <div className="mt-2 flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-[6px] border border-line bg-ground px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-bone">
              {isLoading ? "…" : (identity?.publicKey ?? "no key yet")}
            </code>
            <button
              type="button"
              onClick={copy}
              disabled={!identity}
              className="shrink-0 rounded-[6px] border border-line px-3 py-2 text-[12px] text-slate hover:text-bone disabled:opacity-40"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>

          <p className="mt-2 text-[12px] leading-[1.5] text-mute">
            Most providers take it when you create the machine, or in its settings
            afterwards. Some manage keys their own way — Google Cloud through instance
            metadata or OS Login, and an SSH CA through the CA.
          </p>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-mute">
              {identity?.fingerprint ?? ""}
            </span>
            <button
              type="button"
              onClick={() => onOwnKey(true)}
              className="shrink-0 text-[12px] text-slate hover:text-bone"
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
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="mt-2 w-full rounded-[6px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone outline-none placeholder:text-mute focus:border-ember/40"
      />
      <p className="mt-2 text-[12px] leading-[1.5] text-mute">{children}</p>
    </div>
  );
}
