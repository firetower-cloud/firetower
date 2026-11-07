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
import { forget, servers } from "~/servers";
import { usePathname } from "~/shims/next-navigation";
import { askedFor } from "~/ui/opened";
import { paneAt } from "~/ui/config/panes";
import { Facts, Section } from "~/ui/config/bits";
import { Machines } from "~/ui/config/Machines";
import { Repos } from "~/ui/config/Repos";
import { GitHosts } from "~/ui/config/GitHosts";
import { Trackers } from "~/ui/config/Trackers";
import { Agents } from "~/ui/config/Agents";
import { Skills } from "~/ui/config/Skills";
import { Roles } from "~/ui/config/Roles";
import { Secrets } from "~/ui/config/Secrets";
import { People } from "~/ui/config/People";
import { Teams } from "~/ui/config/Teams";
import { Directories } from "~/ui/config/Directories";
import { useConfirm } from "~/ui/Confirm";
import { useMe } from "~/api/generated/auth/auth";
import { useBootstrap } from "~/api/generated/meta/meta";
import { Button } from "~/components/ui";

export function Configuration({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const path = usePathname();

  return (
    /* No wrapper. Every pane is a `.pg` and brings its own width and its own
       padding — which is what `data-wide` was an escape hatch from, once two
       panes had been rebuilt and the 48rem column was drawing a 770px page
       inside a 1120px one. */
    <div className="scroll-slim flex h-full min-h-0 flex-col overflow-y-auto">
      <Pane at={paneAt(path)} open={askedFor(path, 2)} backend={backend} onForgot={onForgot} />
    </div>
  );
}

/* `open` is the id after the pane's own segment — `/configuration/skills/sk_1`.
   The panes keep their own "which is open" state because most of the time it
   is opened by clicking a row; this is how an address gets a word in. */
function Pane({ at, open, backend, onForgot }: { at: string; open: string | null; backend: Backend; onForgot: () => void }) {
  switch (at) {
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
  /* Both already answered for every screen in the window — the gate reads one
     and the rail reads the other — so saying what is running and who you are
     here costs nothing extra. */
  const me = useMe({ query: { staleTime: 60_000 } });
  const boot = useBootstrap({ query: { staleTime: 60_000 } });
  const added = servers().find((v) => v.serverId === backend.id)?.addedAt;
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
    <Section
      title="This Firetower"
      note="The deployment this window is connected to, and the account you hold on it."
    >
      {/* Read rather than changed, so it is a facts pane and not a list. */}
      <Facts
        of={[
          ["Address", backend.url, true],
          [
            "Signed in as",
            `${backend.user}${me.data?.user?.role ? ` — ${me.data.user.role}` : ""}`,
          ],
          ["Running", boot.data?.version ?? "—", true],
          ["Your things live at", `u/${backend.user}`, true],
          ...(added
            ? ([["Connected since", new Date(added).toLocaleDateString(undefined, { day: "numeric", month: "long" })]] as [string, React.ReactNode][])
            : []),
        ]}
      />
      <div className="whereto mt-6">
        <span className="g">
          <Unplug className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <p>
          <b>Forget this Firetower on this Mac.</b> The connection and its token are dropped here and
          the server is not told — the sessions keep running, and you can connect again with the
          address and a password.
        </p>
        <Button variant="default" size="sm" onClick={disconnect}>
          Disconnect
        </Button>
      </div>
      <p className="mt-4 text-ui text-dim">
        This account exists on this server only. Switching Firetowers is under your avatar.
      </p>
    </Section>
  );
}
