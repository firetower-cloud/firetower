/**
 * The 48px strip: which servers you have, and which one you are looking at.
 *
 * `ALL` sits at the top and is the default, which is the one real design
 * decision in this file. The memo contains two models — "one Slack client holds
 * N workspaces" (§2) and "unified inbox" (§3) — and they are opposites: Slack
 * has no unified inbox, you switch workspaces and each is a separate world.
 *
 * The thesis breaks the tie. *Your phone tells you when an agent needs you*, and
 * the phone does not care whose server it came from. So the inbox is home and a
 * server is context you drop into, not the other way round.
 */
import { BACKENDS, type BackendId } from "~/mock/backends";
import { useFixtures } from "~/mock/socket";
import { drag } from "~/drag";
import { STATE } from "~/mock/backends";
import { NEEDS_YOU } from "@/src/api/view";

export type Scope = "all" | BackendId;

export function ServerStrip({ scope, onScope }: { scope: Scope; onScope: (s: Scope) => void }) {
  useFixtures();

  const waitingIn = (id: BackendId) => STATE[id].filter((s) => NEEDS_YOU.includes(s.status)).length;
  const total = BACKENDS.reduce((n, b) => n + waitingIn(b.id), 0);

  return (
    <div
      {...drag}
      className="flex h-full w-(--chrome-strip) shrink-0 flex-col items-center gap-1 border-r border-line bg-(--color-strip) pt-2 pb-2"
    >
      <Mark
        label="All servers"
        mark={"\u2302"}
        on={scope === "all"}
        reach="live"
        count={total}
        onPick={() => onScope("all")}
      />

      <div className="my-1 h-px w-5 bg-line-soft" />

      {BACKENDS.map((b) => (
        <Mark
          key={b.id}
          label={`${b.org} — ${b.user}`}
          mark={b.mark}
          on={scope === b.id}
          reach={b.reach}
          count={waitingIn(b.id)}
          onPick={() => onScope(b.id)}
        />
      ))}
    </div>
  );
}

function Mark({
  label,
  mark,
  on,
  reach,
  count,
  onPick,
}: {
  label: string;
  mark: string;
  on: boolean;
  reach: "live" | "slow" | "unreachable";
  count: number;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={reach === "unreachable" ? `${label} — can't reach it` : label}
      aria-label={label}
      className="no-drag relative grid h-9 w-9 place-items-center"
    >
      <span className="server-mark grid h-8 w-8 place-items-center" data-on={on} data-reach={reach}>
        {mark}
      </span>

      {/* Ember, and only ember. A count of things waiting on you is the one
          question this colour is allowed to answer. */}
      {count > 0 && reach !== "unreachable" && (
        <span className="pointer-events-none absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full border border-ember-deep bg-ember px-1 text-[9px] font-bold text-ground">
          {count}
        </span>
      )}

      {/* The selected server gets a bar, not a colour — same reasoning as the
          mark itself. */}
      {on && <span className="absolute -left-0.5 h-5 w-0.5 rounded-full bg-bone" />}
    </button>
  );
}
