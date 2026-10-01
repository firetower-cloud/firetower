/**
 * Everything you set up once, as an index and one pane at a time.
 *
 * **One page became too many things.** It was five sections on one scroll —
 * fine at five, and this is nine now. The index that makes it survivable lives
 * in the rail (`ui/config/panes.ts`), because configuration *replaces* the
 * workspaces rather than standing a second column beside them: two rails side
 * by side was a busy screen where one of them was always irrelevant.
 *
 * **A pane at a time is also a pane's worth of requests.** The old page asked
 * for machines, repositories, providers, trackers, agents, accounts and secrets
 * on every open, because all of it was on screen. Now opening Machines asks for
 * machines. That is the practical reason for the split, and it is the reason
 * there are no counts in the index: a number beside every item would fetch all
 * nine lists to render nine numbers, which is the thing this stopped doing.
 *
 * The pane is a path segment rather than state, so a pane can be linked to and
 * the back button works.
 */
import { Unplug } from "lucide-react";
import { useBackendKey, dropCache } from "~/backend";
import { dropFleet, type Backend } from "~/fleet";
import { forget } from "~/servers";
import { usePathname } from "~/shims/next-navigation";
import { paneAt } from "~/ui/config/panes";
import { Section } from "~/ui/config/bits";
import { Machines } from "~/ui/config/Machines";
import { Repos } from "~/ui/config/Repos";
import { Integrations } from "~/ui/config/Integrations";
import { Agents } from "~/ui/config/Agents";
import { Secrets } from "~/ui/config/Secrets";
import { People } from "~/ui/config/People";
import { Teams } from "~/ui/config/Teams";
import { Directories } from "~/ui/config/Directories";
import { useConfirm } from "~/ui/Confirm";

export function Configuration({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const path = usePathname();

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[48rem] px-6 py-6 pb-16">
        <Pane at={paneAt(path)} backend={backend} onForgot={onForgot} />
      </div>
    </div>
  );
}

function Pane({ at, backend, onForgot }: { at: string; backend: Backend; onForgot: () => void }) {
  switch (at) {
    case "integrations":
      return <Integrations live />;
    case "repositories":
      return <Repos live />;
    case "machines":
      return <Machines live />;
    case "agents":
      return <Agents live />;
    case "people":
      return <People backend={backend} />;
    case "teams":
      return <Teams backend={backend} />;
    case "directories":
      return <Directories />;
    case "vault":
      return <Secrets />;
    default:
      return <ThisFiretower backend={backend} onForgot={onForgot} />;
  }
}

function ThisFiretower({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const confirm = useConfirm();
  const key = useBackendKey();
  /* Forgets the server on this Mac only: the token is dropped here, the
     server is not told, and nothing on it changes. Sessions carry on. */
  const disconnect = async () => {
    const ok = await confirm({
      title: `Disconnect ${backend.org} from this Mac?`,
      body: "The connection and its token are forgotten here. Nothing on the server changes — the sessions keep running, and you can connect again with the address and a password.",
      action: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    forget(key);
    dropCache(key);
    dropFleet(key);
    onForgot();
  };

  return (
    <Section title="This Firetower" note={`${backend.url} — signed in as ${backend.user}. This account exists on this server only.`}>
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="min-w-0 flex-1 text-meta text-mute">
          Forget this server on this Mac. Nothing on the server changes; you can connect again any time.
        </span>
        <button
          onClick={disconnect}
          className="control shrink-0 border border-line bg-raise text-ui text-text hover:border-brick-deep hover:text-brick"
        >
          <Unplug className="h-3.5 w-3.5" strokeWidth={1.75} />
          Disconnect this Firetower
        </button>
      </div>
    </Section>
  );
}
