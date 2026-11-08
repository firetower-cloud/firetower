/**
 * Settings' index, in the page it indexes.
 *
 * Settings was a door in the rail, and the panel beside that door was how you
 * moved between People, Teams, Directories, Vault and This Firetower. The door
 * has gone — the profile menu is the single home for Settings, and
 * `destinations.ts` carries that argument — which took the only way between
 * the five panes with it. A pane you can reach and then cannot leave except by
 * going back to a menu is worse than the door was, so the index comes into the
 * page.
 *
 * **It is the rail panel's list, relocated and not redesigned.** The same five
 * panes, the same order, the same three group names, read from the same place
 * (`panes.ts`'s `SETTINGS`). The only thing that changed is the axis.
 *
 * **Groups stacked over their items, rather than a flat strip.** Five tabs in
 * a line is the obvious answer and it loses the grouping, which is the part
 * that says *why* Teams sits next to Directories and not next to Vault. Two
 * short lines keep it and cost 30px once per screen — and they cost nothing
 * horizontally, which a column of grouped rows beside the page would not: the
 * rail panel is still open next to this, and a third column is the "two rails
 * side by side" screen `panes.ts` argues against.
 *
 * **Plain text with an underline**, which is `Inspector.tsx`'s rule for the
 * same job: the index of a page should not compete with the page. No icons —
 * the rail panel's rows had them to survive a 252px column with no heading of
 * their own, and here the group label above says what the cluster is.
 *
 * It draws nothing anywhere else. Gated on the path rather than passed a flag,
 * so a sixth settings pane is navigable the moment it is in `SETTINGS` and
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
