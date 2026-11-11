/**
 * Five tabs and a stack. No drawer.
 *
 * **Dashboard, Workspaces, Tasks, Artifacts, You** — and four of the five are
 * the desk's own words for the same objects: `Dashboard`, `Tasks` and
 * `Artifacts` are its ⌘1, ⌘2 and ⌘3, same object, same word, same glyph. A
 * phone does not get a different name for a thing the desk already named.
 *
 * ## Why the fifth does not break that rule
 *
 * It was four, and the argument for four was this one — so the fifth was
 * checked against it rather than waved through. **The desk already has this
 * list and already calls it Workspaces**: `desktop/src/ui/RailPanel.tsx:265`
 * draws `<Head name="Workspaces">`, and the component behind it is
 * `function Workspaces()`. It is the Dashboard destination's *rail panel* —
 * the 252pt column beside ⌘1, opened with ⌘\.
 *
 * So the honest statement of the change is narrower than "a fifth tab": **the
 * desk's Dashboard panel becomes the phone's second destination.** No desk
 * concept is renamed and none is invented. A phone has no rail to hang a panel
 * off, and at 390, 466 and 669 there is no width to dock one into either —
 * which is the band rule in `measure.ts`, not a preference — so the thing the
 * desk keeps as a panel needs a *place* here.
 *
 * **Nothing is renamed to make room.** Dashboard stays Dashboard; calling it
 * *Home* now that a second tab holds the list is exactly the move this file
 * forbids, because the desk does not say Home. Its job is unchanged anyway:
 * start work, and say what is waiting.
 *
 * **What it costs, which is real.** Five is the ceiling. iOS shows at most
 * five before it replaces the last with *More…* and buries everything past it
 * in a list; Material's bottom navigation is specified for three to five. The
 * **sixth destination is now impossible**, and the next thing the phone wants
 * a place for has to displace something rather than join it.
 *
 * ## The two the redesign deleted
 *
 * Both are the redesign catching up with what the desk deleted:
 *
 * - **Not `Inbox`.** The desk retired `Fleet.tsx`, which its own delta table
 *   calls *the unified inbox as a screen*. A phone still calling it the Inbox
 *   would be the only client naming a concept the product removed.
 * - **Not `Config`.** The desk's Configuration *screen* is gone too — its
 *   panes moved into the destinations they belong to. A Config tab mirrors a
 *   screen the redesign deleted, which is the same failure one word over. Its
 *   single phone-relevant pane, Repositories, is now reachable from the two
 *   places it is actually wanted: the composer's shelf on the home, and a
 *   section of **You** named for the current server.
 *
 * That last one reverses an argument this file used to make — that Config and
 * You must be two tabs, because a server's repositories under the list of
 * servers reads as a thing and the things inside it at the same level. The
 * observation was right and the fix was wrong: what says which is which is the
 * *heading*, and the heading is now the server's own name, which changes the
 * moment you switch above it. `mobile/STYLE.md` still describes the old four
 * and is stale on this; see the note there.
 *
 * The last slot is the person, because a phone has no foot of a rail to put
 * them at.
 *
 * The tab bar gets no ember. It is furniture, and ember answers one question.
 */
import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { useServer } from "~/native/current";
import { useGate } from "~/data";
import { useTheme } from "~/design/theme";

export default function TabLayout() {
  /**
   * With no Firetower there is nothing to be the client of.
   *
   * The guard lives here rather than in the root layout because declaring a
   * `Stack.Screen` configures a route, it does not gate one — the router still
   * rendered the tabs, the inbox called `useQueryClient`, and there was no
   * provider above it. `Redirect` returns before any child renders, which is
   * the only place this can be done without that one frame.
   */
  const here = useServer();
  if (!here) return <Redirect href="/connect" />;
  return <Signed />;
}

/**
 * Inside the provider, so it can ask the server about the account.
 *
 * A second component rather than two more lines above: `useGate` needs the
 * `QueryClient` that only exists once there is a server, and calling it before
 * the `!here` return would be a hook behind a condition.
 */
function Signed() {
  const { color } = useTheme();
  const { locked, ready } = useGate();

  /* Signed in with a password the server will not accept any work under. Not
     rendered here: this layout is a navigator, and returning a panel from it
     leaves the router with a child route and nowhere to put it. */
  if (ready && locked) return <Redirect href="/locked" />;

  /**
   * `NativeTabs`, not `Tabs`, and that is the whole point.
   *
   * On iPhone Duo the system lifts navigation and tab bars out of the bottom
   * and lays them vertically down the trailing edge — but it can only move a
   * bar it owns. A JavaScript tab bar stays where it was drawn, which on a
   * folded Duo is a row of furniture across the narrow end of the screen.
   *
   * The cost is the hand-styled `tabBarStyle` that used to be here. A system
   * bar takes the system's colours, and that is the trade: the tab bar was
   * never carrying meaning — it is furniture, and ember answers one question.
   *
   * Every trigger has an icon as well as a label on purpose. Apple's rule for
   * a vertical bar is that an item with a title and no icon is not presented
   * vertically at all, so a label-only tab would silently fall out of the rail.
   *
   * Two icons per trigger, because a system bar takes the system's glyphs:
   * `sf` is an SF Symbol and `md` a Material Symbol, each the platform's own
   * word for the same thing. On iOS `sf` wins outright — `src` and `md` are
   * never consulted — so the two never argue.
   *
   * **`md` is why `expo-symbols` is a dependency, and nothing imports it.**
   * `md` is not something expo-router carries: it hands the name to
   * `expo-symbols`' `unstable_getMaterialSymbolSourceAsync`, which renders
   * the glyph out of the Material Symbols font, and it reaches that package
   * through a `require` in a `try`. Absent, every `md` name throws while the
   * bar is being built and React takes this whole tree down with it — a blank
   * Android app, which is how it shipped once. So it is a real dependency
   * held by a string no tool can see: `pnpm why` does not know, a type error
   * cannot say so (`md: AndroidSymbol` is declared in the missing package,
   * and `skipLibCheck` makes that silence), and anything tidying up unused
   * dependencies will take it. `e2e/launch.yaml` is what notices.
   */
  return (
    /* The system owns the shape and the material — `backgroundColor` is a no-op
       from iOS 26 on, because the bar is drawn by the OS. What it does hand over
       is the ink, so the rail takes bone-on-mute like the rest of the app
       instead of the stock accent blue. */
    <NativeTabs
      tintColor={color.bone}
      iconColor={{ default: color.mute, selected: color.bone }}
      labelStyle={{ default: { color: color.mute }, selected: { color: color.bone } }}
      /* Android only, and iOS ignores it. The default is `auto`, which is
         `BottomNavigationView`'s old rule: at four destinations it draws the
         selected label and leaves the other three as bare glyphs. That is a
         different tab bar from the one above this comment — "every trigger
         has an icon as well as a label" — and a different one from iOS, where
         all four are always named. Material 3 asks for persistent labels
         between three and five destinations, so `labeled` is both the
         platform's current advice and what the rest of the app already does. */
      labelVisibilityMode="labeled"
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="house" md="home" />
        <NativeTabs.Trigger.Label>Dashboard</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* The second slot, between the Dashboard and Tasks, because it is the
          Dashboard's own panel on the desk and it reads as belonging beside
          it. `square.stack` because the thing is a stack of places: the three
          glyphs already spoken for are a house, a checklist and a square on a
          circle, and nothing in that set reads as a list. `list.bullet` was
          the alternative and it names the shape of the screen rather than
          what is on it. */}
      <NativeTabs.Trigger name="workspaces">
        <NativeTabs.Trigger.Icon sf="square.stack" md="layers" />
        <NativeTabs.Trigger.Label>Workspaces</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon sf="checklist" md="checklist" />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      {/* ⌘3 on the desk, the fourth slot here. A destination rather than a
          pushed route: artifacts outlive the workspace that made them —
          `artifacts` has foreign keys to `users` and `organizations` and to
          nothing else — so the library is yours, not a workspace's. */}
      <NativeTabs.Trigger name="artifacts">
        <NativeTabs.Trigger.Icon sf="square.on.circle" md="category" />
        <NativeTabs.Trigger.Label>Artifacts</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Icon sf="person" md="person" />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
