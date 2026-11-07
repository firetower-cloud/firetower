/**
 * The screens, behind the hash router.
 *
 * Native rather than the web components: a window is not a page, and the two
 * want different density, different chrome and different navigation. What is
 * shared is the part that should be — `group()`, `doing()`, `Signal`,
 * `AgentMark`, the tokens — so the two clients say the same things about the
 * same fleet without one of them being a smaller copy of the other.
 */
import { Home } from "~/ui/Home";
import { TasksPage } from "~/ui/TasksPage";
import { ArtifactsPage } from "~/ui/ArtifactsPage";
import { Workbench } from "~/ui/Workbench";
import { Configuration } from "~/ui/Configuration";
import { Updates } from "~/ui/Updates";
import { Account } from "~/ui/Account";
import { Setup } from "~/ui/Setup";
import { navigate } from "~/shims/next-navigation";
import type { Backend } from "~/fleet";
import { usePathname } from "~/shims/next-navigation";
import { askedFor } from "~/ui/opened";

export function Routes({ backend, onSwitch, onForgot }: { backend: Backend; onSwitch: (serverId: string) => void; onForgot: () => void }) {
  const path = usePathname();

  /* `/new` was a page of its own; the composer is on the home now. The
     address still works, because it is in people's history and in links the
     app itself has handed out — it just lands on the screen that took the
     job over. */
  if (path.startsWith("/new")) return <Home backend={backend} onSwitch={onSwitch} />;
  if (path.startsWith("/tasks")) return <TasksPage backend={backend} />;
  /* `startsWith` matched `/artifacts/a_1` and rendered the library, so a
     link that named an artifact opened the list of them. The id is read
     here and the page opens it. */
  if (path.startsWith("/artifacts")) return <ArtifactsPage open={askedFor(path, 1)} />;
  if (path.startsWith("/configuration")) return <Configuration backend={backend} onForgot={onForgot} />;
  if (path.startsWith("/updates")) return <Updates />;
  if (path.startsWith("/account")) return <Account backend={backend} onForgot={onForgot} />;
  if (path.startsWith("/setup")) return <Setup onDone={() => navigate("/")} />;

  if (path.startsWith("/sessions/")) {
    const id = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    return <Workbench backend={backend} workspace={id} />;
  }

  return <Home backend={backend} onSwitch={onSwitch} />;
}
