"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Foot, Go, Quiet, Command } from "./Modal";
import {
  useConnectHost,
  useListHosts,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import type { Host, Cause } from "@/src/api/generated/model";

/**
 * A machine we got onto that isn't ready yet.
 *
 * ssh worked — the address, the account and the key are all confirmed — and
 * something on the far side is missing. That is a different thing from a
 * machine that never answered, and it has a fix that fits on two lines, so it
 * gets a panel instead of a sentence.
 */

/** The three that mean "reached it, and it isn't set up". */
const FIXABLE: Cause[] = ["WorkerMissing", "DockerMissing", "DockerDenied"];

export function canBeSetUp(host: Host): boolean {
  return !!host.diagnosis && FIXABLE.includes(host.diagnosis.cause);
}

/** What to run over there, per cause. */
function instructions(host: Host): { said: string; run: string[] } {
  const cause = host.diagnosis?.cause;
  const container = host.compute.type === "Container";

  if (cause === "DockerMissing") {
    return {
      said: "Docker isn't running on that machine, and the worker runs in it.",
      run: ["sudo systemctl start docker"],
    };
  }

  if (cause === "DockerDenied") {
    return {
      said:
        "That account can't talk to Docker. Firetower connects as it, so it needs " +
        "to be in the docker group — and the change only takes effect on a new login.",
      run: ["sudo usermod -aG docker $USER", "# then log out and back in"],
    };
  }

  // A running container that isn't a worker is a wrong image, not a missing
  // install, and pulling is the fix rather than installing anything.
  if (container) {
    return {
      said: "That container is running, and it isn't a Firetower worker.",
      run: ["docker compose pull", "docker compose up -d"],
    };
  }

  return {
    said: "It answered, and has no Firetower worker on it.",
    run: ["npm i -g @firetower/cli", "firetower worker install"],
  };
}

export function SetUpHost({ host, onClose }: { host: Host; onClose: () => void }) {
  const { said, run } = instructions(host);
  const queryClient = useQueryClient();
  const connect = useConnectHost();

  /** Watching for the worker to appear after the button is pressed. */
  const [looking, setLooking] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);

  // Re-read the fleet while we're looking. `connect` returns 202 and nothing
  // else — the attempt runs on the supervisor's own task and its result
  // arrives as the host's state changing — so the answer has to be watched
  // for rather than awaited.
  const { data: hosts = [] } = useListHosts({
    query: { refetchInterval: looking ? 1500 : false },
  });

  const now = hosts.find((h) => h.id === host.id) ?? host;
  const ready = now.state === "Online" && !!now.workerVersion;

  // Closing on success, and giving up on silence. Both are reactions to the
  // fleet changing under us rather than to anything rendered here, which is
  // what an effect is for — and neither sets state synchronously in its body,
  // which would cascade renders.
  useEffect(() => {
    if (!looking || !ready) return;
    // The parent unmounts this on close, so there is no local state to unwind.
    onClose();
  }, [looking, ready, onClose]);

  useEffect(() => {
    if (!looking) return;

    // A ceiling, because "still trying" forever is a spinner that lies. An
    // install plus a first handshake is seconds; twenty is generous.
    const stop = setTimeout(() => {
      setLooking(false);
      setGaveUp(true);
    }, 20_000);

    return () => clearTimeout(stop);
  }, [looking]);

  const detect = () => {
    setGaveUp(false);
    setLooking(true);
    connect.mutate(
      { id: host.id },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListHostsQueryKey() }) },
    );
  };

  return (
    <Modal title={`Set up ${host.name}`} onClose={onClose}>
      <p className="text-[12.5px] leading-[1.55] text-bone">{said}</p>

      <p className="mt-2 text-[12px] leading-[1.55] text-mute">
        ssh works — the address, the account and the key are all right. What is left is
        on that machine.
      </p>

      <div className="mt-3 flex flex-col gap-1.5">
        {run.map((line) => (
          <Command key={line} text={line} />
        ))}
      </div>

      <p className="mt-3 text-[12px] leading-[1.55] text-mute">
        Whichever account you ssh as has to be able to reach Docker.
      </p>

      <a
        href="https://usefiretower.com/docs"
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block text-[12px] text-slate transition-colors hover:text-bone"
      >
        See documentation ↗
      </a>

      {gaveUp && (
        <p className="mt-3 text-[12px] leading-[1.55] text-ember">
          Still nothing there. {now.diagnosis?.summary ?? ""} The commands above run on
          that machine, not this one.
        </p>
      )}

      <Foot>
        <Go onClick={detect} disabled={looking}>
          {looking ? "Looking…" : "Detect worker"}
        </Go>
        <Quiet onClick={onClose}>Close</Quiet>
      </Foot>
    </Modal>
  );
}
