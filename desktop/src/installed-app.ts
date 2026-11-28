/**
 * Whether this is an app somebody installed, or a page a control plane served.
 *
 * Two clients are built from this source and they differ in one way that is
 * not cosmetic. **An installed app has a window of its own and was pointed at
 * a Firetower by somebody** — so it can be pointed at another one, it can be
 * pointed at none, it updates itself, it draws its own traffic lights, and it
 * can put a number on the dock. **A served page is a guest in somebody else's
 * window and can only ever reach the control plane that sent it** — the origin
 * it was loaded from is the whole answer to *which Firetower*, which is what
 * `probe.ts` establishes, and the window belongs to Chrome or Safari.
 *
 * Everything this gates falls out of those two sentences, and the title bar
 * is the row that was slowest to follow from them: the gutter is the traffic
 * lights', the buttons at the other end are the frameless platforms', the
 * whole strip is a drag region, and the mark and the press behind it are the
 * switcher's. Take those away and what is left is `org / user` as text, which
 * named a Firetower nobody could have arrived at by mistake and could not
 * leave — so the row went too, and with it 40px of grey across the top of
 * every screen in a tab. The one control on it that still did something, the
 * panel toggle, is the panel's own now (`ui/RailPanel.tsx`'s head).
 *
 * | what | why it needs an installed app |
 * |---|---|
 * | switching, connecting, forgetting a Firetower | there is only ever one behind a served page |
 * | the avatar's ember dot | it means *waiting somewhere you are not*, and there is no elsewhere |
 * | the title bar, whole | every reason it exists is the window's — above |
 * | window controls, the resize strips, drag regions | the window is not ours to move, size or close |
 * | the dock badge, OS notifications | there is no dock and no notification centre to reach |
 * | the *This app* section on Updates | a tab updates by reloading |
 * | every `⌘`-chord shortcut but `⌘F`, and its keycap | see below |
 *
 * ## The shortcuts, which were measured rather than assumed
 *
 * `evidence/ticket-06/` has the run. Driving both browsers with real
 * keystrokes, on this app and on a page that mirrors `Rail.tsx`'s handler:
 * **Chrome delivers `⌘1`–`⌘9` to the page** and `preventDefault()` suppresses
 * the tab switch, with one tab open or nine. **Safari never delivers them** —
 * they are menu equivalents and are taken before the page is offered them, so
 * with one tab nothing happens at all. `⌘,` is the same split. `⌘N` is
 * swallowed by both and opens a browser window.
 *
 * So a served page could keep about half of its shortcuts in one browser and
 * none of them in the other, and a window that lies about its shortcuts is
 * worse than one that is quiet. **The decision is the user's and it is all of
 * them: no `⌘`-chord shortcut in a browser except `⌘F`**, which was measured
 * separately and does arrive in both — and whose `preventDefault` takes the
 * browser's own find bar back, so the app's find bar is what opens.
 *
 * Nothing becomes unreachable by it. The palette has the panel's Search glyph
 * (`RailPanel.tsx`, the same `firetower:palette` event `⌘K` sent), New
 * workspace is a row above it, the panel has a glyph at each end, the
 * destinations are the rail's icons, Settings is a profile-menu row, a tab has
 * an ×, and the inspector has its own close. The one shortcut with no button
 * behind it is `⌘K` clearing the terminal, and the door there is the one every
 * terminal has: typing `clear`.
 *
 * **Not touched, because they are not what was meant.** Escape, `⏎` / `⇧⏎` and
 * `⌘⏎` in a composer, the arrow keys, `⌘C` on a selection — in-field editing
 * and the platform's own clipboard rather than the window's shortcuts. Nor the
 * inspector's `⌃1`–`⌃3`, which are the *local* modifier `platform.ts` keeps
 * deliberately apart from the window's, and which no browser claims.
 *
 * ## One predicate, not eleven reads of `bridge.native`
 *
 * `bridge.native` is already this codebase's test for the shell and is the
 * observable here — nothing is invented. What is added is a name, in one
 * place, for what the answer *means*, because the specification's F4 deletes
 * every surface in that table and a reader doing it should find one call site
 * per surface rather than eleven identical booleans to interpret one at a
 * time. When that day comes, each `installedApp()` is a line to delete along
 * with what it guards.
 *
 * **It is deliberately not "native".** Three of the rows above are about there
 * being several Firetowers, which is nothing to do with a shell language; the
 * shell is only how the client came to have more than one.
 *
 * ## It is not `platform.ts`'s question
 *
 * `isMac` asks *which desktop is this*, and is correct and still needed on
 * both sides of this: a page served to Safari on a Mac is still on a Mac, so
 * `⌘` is still the modifier's name and `localKey` is still `⌃`. This asks
 * whether there is a desktop client at all. The two are independent and
 * `Titlebar.tsx` is where both are asked — this one at the door, because a
 * tab gets no bar, and `isMac` inside it, because a window on a Mac gets the
 * traffic lights' gutter and a window anywhere else gets its own buttons.
 *
 * ## A development tab is a tab, deliberately
 *
 * `pnpm dev` serves the bundle from vite, with no shell around it, so this is
 * false there and a developer iterating in a tab sees the served interface
 * rather than the installed one. That costs the design loop the Firetower
 * switcher, and it is still the right answer: the person this change is for is
 * looking at a browser, and an escape hatch that hid the difference from
 * everybody developing would be an escape hatch from the only feedback there
 * is. `Updates`' *This app* section has been browser-invisible on the same
 * terms since it was written and nobody has wanted one.
 *
 * ## What this must never be used to gate
 *
 * `.stale` and the rule that an unreachable thing is dimmed and never red. One
 * control plane can still be out of reach — a VPN that is off is the common
 * case the memo predicts — and rows from a dark server still have to stay on
 * screen. That rule was about reachability and was never about having several.
 */
import { bridge } from "~/bridge";
import { key } from "~/platform";

/**
 * The rule, as a function of what can be observed and nothing else.
 *
 * Takes its input rather than reading it, the same shape as `probe.ts`'s
 * `ownFiretowerFrom`, so the decision can be read back in a test without a
 * window and without a mocked module. There is exactly one observable and
 * that is the point: anything else that wanted a say here — a build flag, an
 * origin, a query parameter — would be a second way for the two clients to
 * disagree about which one they are.
 */
export function installedAppFrom(seen: {
  /** Whether a native shell is wrapped around this page. `bridge.native`. */
  shell: boolean;
}): boolean {
  return seen.shell;
}

/** [`installedAppFrom`], asked of the client this is actually running in. */
export function installedApp(): boolean {
  return installedAppFrom({ shell: bridge.native });
}

/**
 * A shortcut as text, where there is one to advertise.
 *
 * Not a second decision — it is the predicate above applied to the one thing
 * it gates in a dozen places, and it exists so that a dozen call sites read
 * `advertisedKey("K")` rather than carrying the same ternary around `key("K")`
 * each. Every one of them already takes a `hint`, a `shortcut` or a `title`
 * that is optional, so `undefined` is the shape they already handle: `Glyph`,
 * `IconButton` and `RailButton` all draw the bare label when there is no hint,
 * and `ContextMenu` draws no shortcut column.
 *
 * **`.keycap` and the hints go together with the keys they name**, because
 * `STYLE.md`'s fifth rule is that the window says what it can do — a keycap
 * that names a key nothing listens for is that rule inverted. Kept for the
 * keys that are not the window's and still work: `⏎`, `⇧⏎`, `⌘⏎`, `Esc`, the
 * arrows.
 */
export function advertisedKey(k: string): string | undefined {
  return installedApp() ? key(k) : undefined;
}
