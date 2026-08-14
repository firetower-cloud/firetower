"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Choice, Foot, Go, Quiet } from "./Modal";
import { useCreateHost, getListHostsQueryKey } from "@/src/api/generated/hosts/hosts";
import type { Compute } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

type Kind = "Container" | "Server";

/** The image a worker container runs. Built by `just build-worker`. */
const WORKER_IMAGE = "firetower/worker:dev";

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
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");

  const queryClient = useQueryClient();
  const create = useCreateHost();

  const compute = (): Compute => {
    switch (kind) {
      case "Container":
        return {
          type: "Container",
          image: WORKER_IMAGE,
          name: name.trim() || "firetower-worker",
        };
      case "Server":
        return { type: "Server", target: target.trim() };
    }
  };

  const ready = kind !== "Server" || target.trim().length > 0;

  const add = () =>
    create.mutate(
      { data: { compute: compute(), name: name.trim() || undefined } },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: getListHostsQueryKey() });
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
        <div className="mt-4">
          <label className="eyebrow">Where to ssh</label>
          <input
            autoFocus
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="root@203.0.113.44"
            spellCheck={false}
            className="mt-2 w-full rounded-[6px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone outline-none placeholder:text-mute focus:border-ember/40"
          />
          <p className="mt-2 text-[12px] leading-[1.5] text-mute">
            Whatever <code className="font-mono text-slate">ssh</code> already accepts — a
            host from your config works. Firetower needs the worker installed there at a
            matching version; if it isn&apos;t, this will say so.
          </p>
        </div>
      )}

      {kind === "Container" && (
        <div className="mt-4">
          <label className="eyebrow">Container name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="firetower-worker"
            spellCheck={false}
            className="mt-2 w-full rounded-[6px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone outline-none placeholder:text-mute focus:border-ember/40"
          />
          <p className="mt-2 text-[12px] leading-[1.5] text-mute">
            Started from{" "}
            <code className="font-mono text-slate">{WORKER_IMAGE}</code> and reached with{" "}
            <code className="font-mono text-slate">docker exec</code> — no ssh, no keys.
            Firetower stops and removes it with the host.
          </p>
        </div>
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

      <Foot>
        <Go onClick={add} disabled={!ready || create.isPending}>
          {create.isPending ? "Connecting…" : "Add it"}
        </Go>
        <Quiet onClick={onClose}>Cancel</Quiet>
      </Foot>
    </Modal>
  );
}
