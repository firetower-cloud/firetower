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
import type { Backend } from "~/mock/backends";
import { usePathname } from "~/shims/next-navigation";

export function Routes({ backend }: { backend: Backend }) {
  const path = usePathname();

  if (path.startsWith("/tasks")) return <TasksPage backend={backend} />;
  if (path.startsWith("/configuration") || path.startsWith("/updates"))
    return <Configuration backend={backend} />;

  if (path.startsWith("/sessions/")) {
    const id = decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "");
    return <Workbench backend={backend} workspace={id} />;
  }

  return <Dashboard backend={backend} />;
}
