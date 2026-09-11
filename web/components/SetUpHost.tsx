"use client";

import { Modal, Foot, Go } from "./Modal";
import { HostReadiness } from "./HostReadiness";
import { environmentLabel } from "@/src/api/environments";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import type { Host } from "@/src/api/generated/model";

export function canBeSetUp(host: Host): boolean {
  return (
    !!host.diagnosis &&
    ["WorkerMissing", "DockerMissing", "DockerDenied"].includes(host.diagnosis.cause)
  );
}

export function SetUpHost({ host, onClose }: { host: Host; onClose: () => void }) {
  const { data: hosts = [] } = useListHosts({
    query: { refetchInterval: 3000 },
  });
  const current = hosts.find((h) => h.id === host.id) ?? host;
  return (
    <Modal title={`Set up ${environmentLabel(current)}`} onClose={onClose} wide>
      <HostReadiness host={current} />
      <Foot>
        <Go onClick={onClose}>Done</Go>
      </Foot>
    </Modal>
  );
}
