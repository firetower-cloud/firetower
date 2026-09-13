/**
 * Everything you set up once: the machines, the repositories, what Firetower
 * may reach, the agents and their accounts, the vault — and, at the bottom,
 * the way to let go of this server on this Mac.
 *
 * One page with sections rather than five destinations — you touch these on the
 * first day and then not again until something breaks.
 */
import { Unplug } from "lucide-react";
import { useBackendKey, dropCache } from "~/backend";
import { dropFleet, type Backend } from "~/fleet";
import { forget } from "~/servers";
import { Section } from "~/ui/config/bits";
import { Machines } from "~/ui/config/Machines";
import { Repos } from "~/ui/config/Repos";
import { Connections } from "~/ui/config/Connections";
import { Agents } from "~/ui/config/Agents";
import { Secrets } from "~/ui/config/Secrets";

export function Configuration({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const key = useBackendKey();
  /* Forgets the server on this Mac only: the token is dropped here, the
     server is not told, and nothing on it changes. Sessions carry on. */
  const disconnect = () => {
    if (!window.confirm(`Disconnect ${backend.org} from this Mac?\n\nThe connection and its token are forgotten here. Nothing on the server changes — the sessions keep running, and you can connect again with the address and a password.`)) return;
    forget(key);
    dropCache(key);
    dropFleet(key);
    onForgot();
  };

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-6 py-6 pb-16">
        <h1 className="text-display text-bone">{backend.org}</h1>
        <p className="mt-2 text-read text-dim">
          Signed in as <span className="text-text">{backend.user}</span>. This account exists on this server only.
        </p>
        <Machines live />
        <Repos live />
        <Connections live />
        <Agents live />
        <Secrets />

        <Section title="This Firetower" note={`${backend.url} — connected as ${backend.user}.`}>
          <div className="flex items-center gap-3 px-3.5 py-3">
            <span className="min-w-0 flex-1 text-meta text-mute">Forget this server on this Mac. Nothing on the server changes; you can connect again any time.</span>
            <button onClick={disconnect} className="control shrink-0 border border-line bg-raise text-ui text-text hover:border-brick-deep hover:text-brick">
              <Unplug className="h-3.5 w-3.5" strokeWidth={1.75} />Disconnect this Firetower
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}
