/**
 * The six places you can be.
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
 *
 * ## Settings and Updates are not in here, and there is no rule under the six
 *
 * They were two doors below a hairline, on the argument that nobody *goes* to
 * Settings to do their work and that Updates is somewhere you are sent rather
 * than somewhere you go. This finishes that argument: a door drawn beside the
 * destinations, in the same 34px square with the same selected pill, is read
 * as one — and both were drawn **twice**, once in the rail and once as a row
 * in the profile menu, which is how a screenshot showed Settings in two
 * places at once.
 *
 * The profile menu is the single home. It already holds the account, the
 * Firetower switcher and the appearance control, which are the same category
 * of thing: what is true of *you and this window* rather than where the work
 * is. So Settings carries its own index now — `config/panes.ts`'s `SETTINGS`,
 * drawn inside the page by `config/SettingsIndex.tsx` — and the update signal
 * is a mark on the avatar, which `ProfileMenu.tsx` explains.
 */
import { type LucideIcon, FolderGit2, House, ListTodo, Puzzle, Server, Shapes } from "lucide-react";
import { paneAt } from "~/ui/config/panes";

export type DestinationId = "home" | "tasks" | "artifacts" | "customize" | "repos" | "machines";

export type Destination = {
  id: DestinationId;
  label: string;
  icon: LucideIcon;
  /** Where pressing it lands. The panel beside it offers the rest. */
  href: string;
  /** `⌘1`–`⌘6`. Required, now that the two keyless doors have gone: a place
   *  in the rail with no number was the thing that made them read as doors. */
  key: string;
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
 * Which configuration pane belongs to which destination.
 *
 * The panes themselves are untouched — they are still `/configuration/<pane>`
 * and still rendered by `Configuration.tsx`. What has changed is that the
 * index is no longer a screen: a pane listed here has a destination that owns
 * it, so the rail stays lit on the right icon and the panel beside it offers
 * that destination's other panes.
 *
 * **Settings' five panes are deliberately absent.** They had no destination
 * left to light once the Settings door went, and inventing one would mark a
 * work surface you are not in. They are listed in `config/panes.ts`'s
 * `SETTINGS` instead, and that is what the page's own index is built from —
 * the two are checked against each other in `destinations.test.ts`, because a
 * pane that falls out of both tables is a pane nothing can reach.
 */
const PANE_HOME: Record<string, DestinationId> = {
  skills: "customize",
  roles: "customize",
  agents: "customize",
  repositories: "repos",
  "git-hosts": "repos",
  machines: "machines",
  trackers: "tasks",
};

/**
 * Which destination a path is in.
 *
 * A workspace keeps the Dashboard's: you are still in Dashboard when you are
 * reading one, the way you are still in Customize when you are reading one
 * skill. `null` is for the screens that are nobody's — the account, the style
 * page, and now Settings' own panes and Updates — where the rail shows nothing
 * as current rather than guessing. Nothing as current is the honest answer
 * there: you are not in a work surface, and the place you *are* in is a row in
 * the profile menu, which the rail cannot point at.
 */
export function destinationAt(path: string): DestinationId | null {
  if (path.startsWith("/configuration")) {
    /* Through `paneAt`, so this agrees with the pane the screen actually
       draws. An address from an older build, or one somebody typed, falls back
       to a real pane — and the rail has to light whoever owns *that* one. It
       used to read the raw segment and answer "settings" for `/configuration`
       and for any nonsense after it, while `Configuration.tsx` drew
       Repositories: the mark and the page disagreed. */
    return PANE_HOME[paneAt(path)] ?? null;
  }
  const found = DESTINATIONS.find((d) => d.id !== "home" && d.href !== "/" && path.startsWith(d.href));
  if (found) return found.id;
  if (path === "/" || path.startsWith("/sessions") || path.startsWith("/new")) return "home";
  return null;
}
