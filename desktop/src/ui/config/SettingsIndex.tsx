/**
 * Settings' index, in the page it indexes.
 *
 * Settings was a door in the rail, and the panel beside that door was how you
 * moved between People, Teams, Directories, Vault and This Firetower. The door
 * has gone — the profile menu is the single home for Settings, and
 * `destinations.ts` carries that argument — which took the only way between
 * those panes with it. A pane you can reach and then cannot leave except by
 * going back to a menu is worse than the door was, so the index comes into the
 * page.
 *
 * **Three of the five then left Settings altogether.** People, Teams and
 * Directories are the Organisation destination's, so they are indexed by its
 * rail panel and this draws nothing on them. What it indexes is the two that
 * are genuinely nobody's work surface, and the axis is still the only thing
 * that changed about the list itself.
 *
 * **Groups stacked over their items, rather than a flat strip.** Tabs in a line
 * is the obvious answer and it loses the grouping, which is the part that says
 * *why* a pane sits where it does. Two short lines keep it and cost 30px once
 * per screen — and they cost nothing horizontally, which a column of grouped
 * rows beside the page would not: the rail panel is still open next to this,
 * and a third column is the "two rails side by side" screen `panes.ts` argues
 * against.
 *
 * **Plain text with an underline**, which is `Inspector.tsx`'s rule for the
 * same job: the index of a page should not compete with the page. No icons —
 * the rail panel's rows had them to survive a 252px column with no heading of
 * their own, and here the group label above says what the cluster is.
 *
 * It draws nothing anywhere else. Gated on the path rather than passed a flag,
 * so another settings pane is navigable the moment it is in `SETTINGS` and
 * nobody has to remember to thread a prop through `Section`.
 */
import { navigate, usePathname } from "~/shims/next-navigation";
import { inSettings, paneAt, SETTINGS } from "~/ui/config/panes";

export function SettingsIndex() {
  const path = usePathname();
  if (!inSettings(path)) return null;
  const at = paneAt(path);

  return (
    <nav className="snav" aria-label="Settings">
      {SETTINGS.map((g) => (
        <div key={g.group} className="sgroup">
          <span className="slabel">{g.group}</span>
          <span className="sitems">
            {g.items.map((i) => (
              <button
                key={i.at}
                onClick={() => navigate(`/configuration/${i.at}`)}
                aria-current={i.at === at ? "page" : undefined}
                className="sitem"
              >
                {i.label}
                {i.at === at && <span className="ul" />}
              </button>
            ))}
          </span>
        </div>
      ))}
    </nav>
  );
}
