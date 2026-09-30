/**
 * Everything you set up once, as an index and one pane at a time.
 *
 * **One page became too many things.** It was five sections on one scroll —
 * fine at five, and this is now nine with People, Teams and Directories to
 * come. The index is what makes that survivable: the group heading carries the
 * meaning, so `Directories` sits under **Access** beside People and Teams and
 * needs no sentence explaining what it is.
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
import { navigate, usePathname } from "~/shims/next-navigation";
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

/**
 * The index, and the only place the order is decided.
 *
 * Grouped by what a thing *is*, not by what it produces. An earlier draft put
 * Integrations and Repositories under "Sources", which reads as a promise that
 * both feed the same pipe — and Linear yields no repositories. Services divide
 * badly by output: GitHub gives code *and* work, a tracker gives only work, and
 * the next git host will give only code.
 */
const INDEX: { group: string; items: { at: string; label: string }[] }[] = [
  {
    group: "Setup",
    items: [
      { at: "integrations", label: "Integrations" },
      { at: "repositories", label: "Repositories" },
    ],
  },
  {
    group: "Compute",
    items: [
      { at: "machines", label: "Machines" },
      { at: "agents", label: "Agents" },
    ],
  },
  {
    group: "Access",
    items: [
      { at: "people", label: "People" },
      { at: "teams", label: "Teams" },
      { at: "directories", label: "Directories" },
    ],
  },
  { group: "Credentials", items: [{ at: "vault", label: "Vault" }] },
  { group: "Server", items: [{ at: "server", label: "This Firetower" }] },
];

const FIRST = "integrations";

export function Configuration({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const path = usePathname();
  const at = path.split("/").filter(Boolean)[1] ?? FIRST;
  const known = INDEX.some((g) => g.items.some((i) => i.at === at)) ? at : FIRST;

  return (
    <div className="flex h-full min-h-0">
      <nav className="scroll-slim w-[13.5rem] shrink-0 overflow-y-auto border-r border-line bg-panel/40 px-2.5 py-4">
        {INDEX.map((g) => (
          <div key={g.group} className="mt-5 first:mt-0">
            <p className="px-2.5 pb-1.5 text-micro tracking-[0.09em] text-mute uppercase">{g.group}</p>
            {g.items.map((i) => (
              <button
                key={i.at}
                onClick={() => navigate(`/configuration/${i.at}`)}
                className={`block w-full rounded-md px-2.5 py-1.5 text-left text-ui transition-colors ${
                  i.at === known ? "bg-overlay text-bone" : "text-dim hover:bg-raise hover:text-text"
                }`}
              >
                {i.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="scroll-slim min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[48rem] px-6 py-6 pb-16">
          <Pane at={known} backend={backend} onForgot={onForgot} />
        </div>
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
      return <People />;
    case "teams":
      return <Teams />;
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
