/**
 * The screens, behind the hash router.
 *
 * Native rather than the web components: a window is not a page, and the two
 * want different density, different chrome and different navigation. What is
 * shared is the part that should be — `group()`, `doing()`, `Signal`,
 * `AgentMark`, the tokens — so the two clients say the same things about the
 * same fleet without one of them being a smaller copy of the other.
 */
import { Dashboard } from "~/ui/Dashboard";
import { TasksPage } from "~/ui/TasksPage";
import { Workbench } from "~/ui/Workbench";
import { Configuration } from "~/ui/Configuration";
import { Updates } from "~/ui/Updates";
import { Account } from "~/ui/Account";
import { Setup } from "~/ui/Setup";
import { navigate } from "~/shims/next-navigation";
import type { Backend } from "~/mock/backends";
import { usePathname } from "~/shims/next-navigation";

export function Routes({ backend, onForgot }: { backend: Backend; onForgot: () => void }) {
  const path = usePathname();

  if (path.startsWith("/tasks")) return <TasksPage backend={backend} />;
  if (path.startsWith("/configuration")) return <Configuration backend={backend} />;
  if (path.startsWith("/updates")) return <Updates />;
  if (path.startsWith("/account")) return <Account backend={backend} onForgot={onForgot} />;
  if (path.startsWith("/setup")) return <Setup onDone={() => navigate("/")} />;

  if (path.startsWith("/sessions/")) {
    const id = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    return <Workbench backend={backend} workspace={id} />;
  }

  return <Dashboard backend={backend} />;
}
