/**
 * The menus, and the one search box in them.
 *
 * `Menu`, `Head` and `Opt` were module-local to `StartComposer` and then
 * exported from it, which is where every picker in the product had been drawn.
 * They are here now because a composer is not where shared furniture lives,
 * and because the thing below could not import them from there without a
 * cycle.
 *
 * **`Sift` exists because the search box had already been written twice** —
 * once in `RepoMenu` and once in `ProfileMenu`, near-identical, and about to
 * be written a third time for several hundred time zones. What varies between
 * them is which field the query is matched against, which is the caller's to
 * say; the box, the filtering, the empty line and the Enter-takes-the-only-one
 * habit are not.
 *
 * **`PickOne` is the pill form of the same thing**, for a row of settings
 * rather than a chip on a shelf: it draws the current value, opens the menu
 * through `Pop` so nothing clips it, and takes the search or leaves it out. It
 * replaces seven native `<select>`s in the schedules sheet — the one control
 * that cannot be made to match anything around it, which is why they leapt
 * out of a screen where everything else is ours.
 */
import { useMemo, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Pop } from "~/ui/Pop";

/**
 * The scrolling part of a menu, and only that part.
 *
 * `min-h-0` because `Pop` caps the card at the room the window actually has
 * and a flex child refuses to shrink below its content without it — the
 * flexbox rule in STYLE.md. Anything that should stay put while this scrolls,
 * a search box or a readiness footer, goes beside it rather than inside it.
 */
export function Menu({ children }: { children: React.ReactNode }) {
  return <div className="scroll-slim max-h-80 min-h-0 overflow-y-auto py-1">{children}</div>;
}

export function Head({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pt-2 pb-1 text-micro text-mute">{children}</div>;
}

export function Opt({
  on,
  disabled,
  keepOpen,
  onPick,
  icon,
  title,
  sub,
  chip,
}: {
  on: boolean;
  disabled?: boolean;
  keepOpen?: boolean;
  onPick: () => void;
  icon: React.ReactNode;
  title: string;
  sub?: string;
  chip?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={on}
      disabled={disabled}
      onClick={(e) => {
        if (keepOpen) e.stopPropagation();
        onPick();
      }}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left ${
        disabled ? "opacity-40" : "hover:bg-raise"
      }`}
    >
      <span className={`shrink-0 ${on ? "text-bone" : "text-dim"}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui text-bone">{title}</span>
        {sub && <span className="block truncate text-micro text-mute">{sub}</span>}
      </span>
      {chip && <span className="chip2">{chip}</span>}
      <Check
        className={`h-4 w-4 shrink-0 ${on ? "text-slate" : "text-transparent"}`}
        strokeWidth={2.5}
      />
    </button>
  );
}

/**
 * Substring, folded, and `_` read as a space.
 *
 * The default rule, written for the list that needed one most: there are
 * several hundred IANA zones and the half anybody remembers is the city. So
 * `paris` finds `Europe/Paris`, `qatar` finds `Asia/Qatar`, and `new york`
 * finds `America/New_York` — the underscore is a wire format, not something
 * anybody types.
 *
 * Substring rather than prefix for the same reason `matching` is: the part of
 * a name you remember is rarely the first part of it.
 */
export function looselyMatches(text: string, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/_/g, " ");
  if (!q) return true;
  return text.toLowerCase().replace(/_/g, " ").includes(q);
}

/**
 * A menu with a filter above it.
 *
 * The box is this component's; the rows are the caller's, because what a
 * query means differs per list — a repository matches on its slug, a profile
 * on its name or what it does, a zone on the whole path. `match` says which,
 * and `children` draws whatever survived it.
 *
 * `when` is how a list short enough to read offers no box at all: five
 * cadences do not need searching, and a search field over five items is
 * furniture pretending to be a control.
 */
export function Sift<T>({
  items,
  match = (item, q) => looselyMatches(String(item), q),
  when = true,
  placeholder,
  noun,
  onlyOne,
  children,
}: {
  items: T[];
  /** Whether one item survives a query. Defaults to [`looselyMatches`]. */
  match?: (item: T, query: string) => boolean;
  /** Whether to offer the box at all. */
  when?: boolean;
  placeholder: string;
  /** For the line that says nothing matched — "No zone matches “x”." */
  noun: string;
  /**
   * Enter takes the only one left, which is what typing three characters and
   * reaching for the keyboard means. The old sheet did this and the habit
   * came with the people.
   */
  onlyOne?: (item: T) => void;
  children: (shown: T[], query: string) => React.ReactNode;
}) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => items.filter((i) => match(i, q)), [items, q, match]);

  return (
    <>
      {when && (
        <div className="shrink-0 border-b border-line-soft p-2">
          <div className="flex items-center gap-2 rounded-md bg-ground px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.8} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || shown.length !== 1 || !onlyOne) return;
                e.preventDefault();
                onlyOne(shown[0]);
              }}
              placeholder={placeholder}
              className="w-full bg-transparent text-meta text-bone placeholder:text-mute focus:outline-none"
            />
          </div>
        </div>
      )}
      <Menu>
        {children(shown, q)}
        {q.trim() !== "" && shown.length === 0 && (
          <div className="px-3 py-3 text-center text-micro text-mute">
            No {noun} matches “{q}”.
          </div>
        )}
      </Menu>
    </>
  );
}

/** One thing a [`PickOne`] offers. */
export type Choice = {
  value: string;
  label: string;
  /**
   * The half that says what picking it asks for next — *Choose a day*,
   * *Cron expression*. A native `<option>` cannot draw two lines, which is
   * why these used to be joined onto the label with an em dash.
   */
  note?: string;
};

/**
 * A pill that opens a menu: the product's answer to a native `<select>`.
 *
 * Through `Pop`, so it is portaled out of whatever is clipping it — a sheet's
 * body, a card, a scroller. That is the one thing a picker in a form has to
 * get right, and it is why this is not another absolutely-positioned panel.
 *
 * The pill is `.s-pill`, which is what the row it sits in already draws.
 */
export function PickOne({
  value,
  options,
  onPick,
  label,
  title,
  search,
  noun = "option",
  width = 260,
}: {
  value: string;
  options: Choice[];
  onPick: (value: string) => void;
  /** What a screen reader calls it. */
  label: string;
  title?: string;
  /** Offer a filter. Off by default: most of these lists are short. */
  search?: boolean;
  noun?: string;
  width?: number;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  const chosen = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        className="s-pill"
        aria-label={label}
        aria-haspopup="listbox"
        title={title}
        onClick={(e) => setOpen((at) => (at ? null : e.currentTarget))}
      >
        <span className="lbl">{chosen?.label ?? value}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-mute" strokeWidth={2} />
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={width}>
          <Sift
            items={options}
            match={(o, q) => looselyMatches(`${o.label} ${o.value}`, q)}
            when={!!search}
            placeholder={`Search ${noun}s`}
            noun={noun}
            onlyOne={(o) => {
              onPick(o.value);
              setOpen(null);
            }}
          >
            {(shown) =>
              shown.map((o) => (
                <Opt
                  key={o.value}
                  on={o.value === value}
                  onPick={() => {
                    onPick(o.value);
                    setOpen(null);
                  }}
                  icon={null}
                  title={o.label}
                  sub={o.note}
                />
              ))
            }
          </Sift>
        </Pop>
      )}
    </>
  );
}
