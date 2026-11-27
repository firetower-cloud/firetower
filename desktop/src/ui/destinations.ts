/**
 * The eight places you can be.
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
 * **Schedules sits at `⌘5`, after Customize**, and Repositories and Machines
 * moved down one to make room. The rail reads top to bottom as *what is
 * happening* and then *what is set up*, and a schedule is the most
 * set-up-and-leave object in the product — so it belongs with Customize
 * rather than after the machines.
 *
 * This was first shipped appended at `⌘7`, on the argument that the numbers
 * here are written down so they do not move: a remap is paid by everybody,
 * every day, while the grouping cost is paid once by somebody reading the
 * rail for the first time. Both halves of that are still true, and the
 * decision went the other way once both arrangements had been seen — the
 * insertion here renumbers two destinations rather than the four that
 * inserting after Tasks would have. **The cost is real and it is paid once:**
 * anybody's muscle memory for `⌘5` and `⌘6` now lands one place further
 * down.
 *
 * It is a destination rather than a pane under Customize, which was asked for
 * twice and declined twice. What was refused was Schedules living *inside*
 * Customize, not Schedules living beside it. The merge above stays available,
 * and taking it here would spend the escape hatch on the seventh rather than
 * the eighth.
 *
 * ## Organisation is the eighth, and it is **appended**
 *
 * People, Teams and Directories are the only place accounts, teams and filing
 * exist once the administration site goes, and a surface that is the only home
 * of a thing is a place rather than a mirror of one. The reasoning that put
 * Settings in the profile menu — *nobody goes to Settings to do their work*,
 * and *it was drawn twice* — does not survive that: nothing here is drawn
 * twice, and inviting a colleague is work. It is also not administrator-only,
 * which is what removes the objection that would otherwise sink it: People is
 * every member's, read-only for a member, and Directories already answers with
 * whatever the asker can reach.
 *
 * **Appended, so nothing renumbers.** Everything the Schedules insertion above
 * says about the cost of a remap is still true, and that insertion is on the
 * record as a cost paid once — paying it a second time, two releases later,
 * would make the numbers something people stop learning. So Organisation takes
 * `⌘8` at the bottom and `⌘1`–`⌘7` are exactly where they were.
 *
 * The honest cost is an eighth icon in a rail whose own notes call seven near
 * the limit. The remedy those notes nominate — Repositories and Machines into
 * one — is still sitting there unspent, and is deliberately *not* taken here:
 * it is a separate argument, and taking it in the same change would hide this
 * one.
 *
 * It is `organisation` here and `organization` on the wire. The prose in this
 * client is British — *organisation*, *colleague*, *filed* — and the generated
 * client is the contract's spelling; the two meet at the import and nowhere
 * else, which is cheaper than either side pretending.
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
 *
 * That division is what Organisation leaving Settings sharpens rather than
 * contradicts: the menu keeps what is true of *you and this window*, and what
 * is true of *the organisation* is a destination. What `⌘,` means afterwards
 * is decided in `config/panes.ts`, at `SETTINGS_OPENS_ON`, because it is that
 * file's list which used to decide it by accident.
 */
import { type LucideIcon, Building2, Clock, FolderGit2, House, ListTodo, Puzzle, Server, Shapes } from "lucide-react";
import { paneAt } from "~/ui/config/panes";

export type DestinationId =
  | "home"
  | "tasks"
  | "artifacts"
  | "customize"
  | "repos"
  | "machines"
  | "schedules"
  | "organisation";

export type Destination = {
  id: DestinationId;
  label: string;
  icon: LucideIcon;
  /** Where pressing it lands. The panel beside it offers the rest. */
  href: string;
  /** `⌘1`–`⌘8`. Required, now that the two keyless doors have gone: a place
   *  in the rail with no number was the thing that made them read as doors. */
  key: string;
};

/** The eight. Order is the keyboard's order, so ⌘3 is always Artifacts. */
export const DESTINATIONS: Destination[] = [
  { id: "home", label: "Dashboard", icon: House, href: "/", key: "1" },
  { id: "tasks", label: "Tasks", icon: ListTodo, href: "/tasks", key: "2" },
  { id: "artifacts", label: "Artifacts", icon: Shapes, href: "/artifacts", key: "3" },
  { id: "customize", label: "Customize", icon: Puzzle, href: "/configuration/skills", key: "4" },
  { id: "schedules", label: "Schedules", icon: Clock, href: "/schedules", key: "5" },
  { id: "repos", label: "Repositories", icon: FolderGit2, href: "/configuration/repositories", key: "6" },
  { id: "machines", label: "Machines", icon: Server, href: "/configuration/machines", key: "7" },
  /* Opens on People, which is the pane anybody has a reason to be on: Teams is
     read until the next change lands and Directories is a thing you set up
     once. A building rather than a person, because the two panes under it are
     already a person and a group of them — the rail icon has to say *the
     organisation* and not *the first row of its first pane*. */
  { id: "organisation", label: "Organisation", icon: Building2, href: "/configuration/people", key: "8" },
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
 * **The Vault is deliberately absent.** It has no destination to light, and
 * inventing one would mark a work surface you are not in. They are listed in `config/panes.ts`'s `SETTINGS` instead, and that
 * is what the page's own index is built from — the two are checked against each
 * other in `destinations.test.ts`, because a pane that falls out of both tables
 * is a pane nothing can reach.
 *
 * **People, Teams and Directories moved out of that list into Organisation.**
 * They kept their addresses and they are still drawn by `Configuration.tsx`;
 * what changed is which table names them, which is the whole of what decides
 * whether the rail lights and which index the pane carries. They were in
 * `SETTINGS` because they had no destination to belong to, and now they have
 * one.
 */
const PANE_HOME: Record<string, DestinationId> = {
  skills: "customize",
  roles: "customize",
  "agent-teams": "customize",
  agents: "customize",
  repositories: "repos",
  "git-hosts": "repos",
  machines: "machines",
  trackers: "tasks",
  people: "organisation",
  teams: "organisation",
  directories: "organisation",
  /* What the organisation's agents spent. It is the organisation's ledger
     rather than anybody's work surface, and it is everybody's — consumption
     has no role gate on the server, so `panesFor` lists it for every member
     and this table has no condition on it either. */
  usage: "organisation",
  /* **The deployment pane, which was Settings' until it had somewhere better
     to be.** It is the organisation's installation — what it is called,
     whether it reports telemetry, what is running and how it lets people in —
     so it belongs beside the organisation's people. Whether it is *listed* is
     a separate question with a separate answer, in `config/organisation.ts`'s
     `panesFor`: this table says which destination owns a pane, and the rail
     has to light the same one whether or not the panel offered a row to get
     there. A member who typed the address still gets a destination that makes
     sense; what they get drawn is `Configuration.tsx`'s business. */
  server: "organisation",
};

/**
 * Which destination a path is in.
 *
 * A workspace keeps the Dashboard's: you are still in Dashboard when you are
 * reading one, the way you are still in Customize when you are reading one
 * skill. `null` is for the screens that are nobody's — the account, the style
 * page, and the Vault and Updates — where the rail shows nothing
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
