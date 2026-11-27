/**
 * Everything you set up once, as an index and one pane at a time.
 *
 * **One page became too many things.** It was five sections on one scroll —
 * fine at five, and this is nine now. What makes it survivable is that each
 * pane has an index: eleven of them belong to a rail destination and are
 * indexed by that destination's panel, and the Vault — the one Settings has
 * left — is reached from the profile menu, which is the whole of what Settings
 * is now. Neither index is a second *column*: two rails side by side was a
 * busy screen where one of them was always irrelevant, and that is still the
 * thing being avoided.
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
import { usePathname } from "~/shims/next-navigation";
import { askedFor } from "~/ui/opened";
import { paneAt } from "~/ui/config/panes";
import { Machines } from "~/ui/config/Machines";
import { Repos } from "~/ui/config/Repos";
import { GitHosts } from "~/ui/config/GitHosts";
import { Trackers } from "~/ui/config/Trackers";
import { Agents } from "~/ui/config/Agents";
import { Skills } from "~/ui/config/Skills";
import { Roles } from "~/ui/config/Roles";
import { AgentTeams } from "~/ui/config/AgentTeams";
import { Secrets } from "~/ui/config/Secrets";
import { Deployment } from "~/ui/config/Deployment";
import { People } from "~/ui/config/People";
import { Teams } from "~/ui/config/Teams";
import { Directories } from "~/ui/config/Directories";
import { Usage } from "~/ui/config/Usage";
import { useMe } from "~/api/generated/auth/auth";
import { deploymentMode, mayOperateDeployment, opensOn } from "~/ui/config/organisation";

export function Configuration() {
  const path = usePathname();

  return (
    /* No wrapper. Every pane is a `.pg` and brings its own width and its own
       padding — which is what `data-wide` was an escape hatch from, once two
       panes had been rebuilt and the 48rem column was drawing a 770px page
       inside a 1120px one. */
    <div className="scroll-slim flex h-full min-h-0 flex-col overflow-y-auto">
      <Pane at={paneAt(path)} open={askedFor(path, 2)} />
    </div>
  );
}

/* `open` is the id after the pane's own segment — `/configuration/skills/sk_1`.
   The panes keep their own "which is open" state because most of the time it
   is opened by clicking a row; this is how an address gets a word in. */
function Pane({ at, open }: { at: string; open: string | null }) {
  /* Already answered for every screen in this window — the gate reads it —
     so asking costs nothing. */
  const me = useMe({ query: { staleTime: 60_000 } });

  /**
   * **A pane that is not this person's falls back to the one the destination
   * opens on**, rather than drawing a refusal.
   *
   * The deployment pane is listed for a self-hosted administrator and nobody
   * else, and *not listed* is not *not reachable*: `/configuration/server` was
   * Settings' and everybody's until this change, so it is in somebody's
   * history and somebody's bookmark. Drawing *you cannot see this* for them
   * would turn a moved pane into a forbidden one, which is precisely what the
   * destination is not allowed to contain.
   *
   * Falling back is what `paneAt` already does for an address nobody
   * recognises — "falls back to a real pane rather than drawing an empty
   * screen" — and the rail agrees either way, because `destinationAt` says
   * Organisation for this path whoever is asking.
   */
  const refused = at === "server" && !mayOperateDeployment(deploymentMode(), me.data?.user);

  switch (refused ? opensOn() : at) {
    case "repositories":
      return <Repos live open={open} />;
    case "git-hosts":
      return <GitHosts live />;
    case "trackers":
      return <Trackers live />;
    case "machines":
      return <Machines live open={open} />;
    case "agents":
      return <Agents live />;
    case "skills":
      return <Skills open={open} />;
    case "roles":
      return <Roles />;
    case "agent-teams":
      return <AgentTeams open={open} />;
    case "people":
      return <People />;
    case "teams":
      return <Teams />;
    case "directories":
      return <Directories />;
    case "usage":
      return <Usage />;
    case "vault":
      return <Secrets />;
    case "server":
      return <Deployment />;
    default:
      return <Repos live open={open} />;
  }
}
