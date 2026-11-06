/**
 * The six places you can be, and the two doors under them.
 *
 * The index used to live in `config/panes.ts` as twelve panes in seven groups
 * behind a Configuration screen, and in `Rail.tsx` as three nav links. Both
 * are this now: a destination is a *place*, it has an icon, a number key and a
 * panel, and the panes that used to be configuration live inside the
 * destination they belong to.
 *
 * **Repositories and Machines are two destinations rather than one.** Merging
 * them reads cleanly and is one fewer icon, but there is no honest name for
 * the pair that is not a category word, and it buries reachability a level
 * down. If six ever feels like too many, that is the first merge to make.
 *
 * Labels do not rest under the icons. They double the rail's width to say what
 * hover, focus and the tooltip already say, and six destinations are few
 * enough to learn.
 */
import {
  type LucideIcon,
  Download,
  FolderGit2,
  House,
  ListTodo,
  Puzzle,
  Server,
  Settings,
  Shapes,
} from "lucide-react";

export type DestinationId = "home" | "tasks" | "artifacts" | "customize" | "repos" | "machines" | "settings" | "updates";

export type Destination = {
  id: DestinationId;
  label: string;
  icon: LucideIcon;
  /** Where pressing it lands. The panel beside it offers the rest. */
  href: string;
  /** `⌘1`–`⌘6`. The two doors below the rule have their own keys. */
  key?: string;
};

/** The six. Order is the keyboard's order, so ⌘3 is always Artifacts. */
export const DESTINATIONS: Destination[] = [
  { id: "home", label: "Dashboard", icon: House, href: "/", key: "1" },
  { id: "tasks", label: "Tasks", icon: ListTodo, href: "/tasks", key: "2" },
  { id: "artifacts", label: "Artifacts", icon: Shapes, href: "/artifacts", key: "3" },
  { id: "customize", label: "Customize", icon: Puzzle, href: "/configuration/skills", key: "4" },
  { id: "repos", label: "Repositories", icon: FolderGit2, href: "/configuration/repositories", key: "5" },
  { id: "machines", label: "Machines", icon: Server, href: "/configuration/machines", key: "6" },
];

/**
 * The two below the rule.
 *
 * They are doors rather than destinations: nobody goes to Settings to do their
 * work, and Updates is somewhere you are sent rather than somewhere you go. The
 * rule is what says so, and it is why they are not ⌘7 and ⌘8.
 */
export const DOORS: Destination[] = [
  { id: "settings", label: "Settings", icon: Settings, href: "/configuration/people" },
  { id: "updates", label: "Updates", icon: Download, href: "/updates" },
];

export const EVERY = [...DESTINATIONS, ...DOORS];

/**
 * Which configuration pane belongs to which destination.
 *
 * The panes themselves are untouched in this pass — they are still
 * `/configuration/<pane>` and still rendered by `Configuration.tsx`. What has
 * changed is that the index is no longer a screen: each pane now has a
 * destination that owns it, so the rail stays lit on the right icon and the
 * panel beside it offers that destination's other panes.
 */
const PANE_HOME: Record<string, DestinationId> = {
  skills: "customize",
  roles: "customize",
  agents: "customize",
  repositories: "repos",
  "git-hosts": "repos",
  machines: "machines",
  trackers: "tasks",
  people: "settings",
  teams: "settings",
  directories: "settings",
  vault: "settings",
  server: "settings",
};

/**
 * Which destination a path is in.
 *
 * A workspace keeps the Dashboard's: you are still in Dashboard when you are
 * reading one, the way you are still in Customize when you are reading one
 * skill. `null` is for the screens that are nobody's — the account, the style
 * page — where the rail shows nothing as current rather than guessing.
 */
export function destinationAt(path: string): DestinationId | null {
  if (path.startsWith("/configuration")) {
    const pane = path.split("/").filter(Boolean)[1] ?? "";
    return PANE_HOME[pane] ?? "settings";
  }
  const found = EVERY.find((d) => d.id !== "home" && d.href !== "/" && path.startsWith(d.href));
  if (found) return found.id;
  if (path === "/" || path.startsWith("/sessions") || path.startsWith("/new")) return "home";
  return null;
}
