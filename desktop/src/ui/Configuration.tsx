/**
 * Everything you set up once: the machines, the repositories, what Firetower
 * may reach, the agents and their accounts, the vault.
 *
 * One page with sections rather than five destinations — you touch these on the
 * first day and then not again until something breaks. Every section reads and
 * writes the real server when there is one, and says so when there is not.
 */
import { isLive } from "~/mock/http";
import { useBackendKey } from "~/backend";
import type { Backend } from "~/mock/backends";
import { Machines } from "~/ui/config/Machines";
import { Repos } from "~/ui/config/Repos";
import { Connections } from "~/ui/config/Connections";
import { Agents } from "~/ui/config/Agents";
import { Secrets } from "~/ui/config/Secrets";

export function Configuration({ backend }: { backend: Backend }) {
  const live = isLive(useBackendKey());

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-6 py-6 pb-16">
        <h1 className="text-display text-bone">{backend.org}</h1>
        <p className="mt-2 text-read text-dim">
          Signed in as <span className="text-text">{backend.user}</span>. This account exists on this server only.
        </p>
        {!live && <p className="mt-2 text-meta text-mute">Showing fixtures — this is one of the demo servers, not a real one. Nothing here can be changed.</p>}

        <Machines live={live} />
        <Repos live={live} />
        <Connections live={live} />
        <Agents live={live} />
        <Secrets />
      </div>
    </div>
  );
}
