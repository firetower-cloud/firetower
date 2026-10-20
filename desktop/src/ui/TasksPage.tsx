/**
 * What you could work on.
 *
 * One tracker at a time, because `/tasks` answers for one source per request
 * and they page differently — a git host by number with a total, Linear by
 * cursor with none. Merging them into one list would mean inventing a paging
 * scheme neither side has.
 *
 * Which tracker is a mark rather than a word: the logos are the thing people
 * already scan for, and the glyphs fit where "GitHub | GitLab | Linear" would
 * push the filters onto a second row. The mark comes from the tracker's *kind*
 * rather than its id — a second GitHub is its own tracker with an id of its
 * own, and the two are told apart by the label on hover.
 *
 * The chips and the box are sent, not applied here. Every one of them is a
 * query parameter the source reads in its own dialect, so what comes back is
 * already the answer — filtering it again locally is how rows go missing.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  RotateCw,
  Ticket,
  User,
} from "lucide-react";
import { GiteaMark, GitLabMark, GithubMark, Icon, Input, LinearMark, Select } from "~/components/ui";
import { elapsed, minutesSince } from "~/api/view";
import type { Backend } from "~/fleet";
import { useTasks, useTrackers, useTrackerScopes } from "~/data";
import { useStart } from "~/start";
import { navigate } from "~/shims/next-navigation";
import { Pop } from "~/ui/Pop";
import { getListTasksQueryKey } from "~/api/generated/tasks/tasks";
import type { ListTasksParams, TaskKind, TaskState, TrackerStatus } from "~/api/generated/model";

/**
 * Where somebody goes to connect this tracker.
 *
 * **Not `/configuration` on its own.** That used to be right: there was one
 * Integrations pane and it held both halves. Splitting it into Git hosts and
 * Trackers left this link pointing at nothing in particular, and the fallback
 * in `paneAt` is the *first* pane — Repositories — so pressing "Connect
 * GitHub" landed on a list of repositories with no mention of GitHub on it.
 *
 * Which half depends on how the tracker authorizes, not on what it is called:
 * a git host shares the token that pushes commits and is connected on Git
 * hosts, while an API key is its own credential and lives under Trackers.
 */
export function paneFor(tracker: Pick<TrackerStatus, "auth">): string {
  return tracker.auth === "apiKey" ? "/configuration/trackers" : "/configuration/git-hosts";
}

const KIND = { issue: CircleDot, pullRequest: GitPullRequest, ticket: Ticket };

/** What each kind is called on the toggle. A tracker only offers its own. */
const KIND_LABEL: Record<TaskKind, string> = {
  issue: "Issues",
  pullRequest: "PRs",
  ticket: "Tickets",
};

/** The mark for a tracker, by kind. Anything unrecognised keeps the page working. */
const MARK: Record<string, (p: { size?: number; className?: string }) => React.ReactNode> = {
  github: GithubMark,
  gitlab: GitLabMark,
  gitea: GiteaMark,
  linear: LinearMark,
};

/**
 * Which trackers the picker offers: the ones that can actually answer.
 *
 * **Not every tracker.** It used to list them all, with the unconnected ones
 * greyed, on the reasoning that picking one was how somebody reached the
 * prompt that connects it. That held when there were two. With a git host for
 * every row it does not: a fresh install shows six entries of which four say
 * "not connected", so the control that chooses what you are reading is mostly
 * made of things you cannot read — and the answer to "connect this" was never
 * here anyway, it is Git hosts or Trackers.
 *
 * Connecting is still reachable with nothing connected at all: `source` falls
 * back to the first tracker either way, and the panel under the list offers
 * it by name. That is the path, rather than a menu of dead rows.
 */
export function pickable(trackers: TrackerStatus[]): TrackerStatus[] {
  return trackers.filter((t) => t.connected);
}

export function TasksPage({ backend }: { backend: Backend }) {
  const start = useStart();
  const cache = useQueryClient();

  const { data: trackers, loading: findingTrackers } = useTrackers();

  const [picked, setPicked] = useState<string | null>(null);
  const [kind, setKind] = useState<TaskKind | null>(null);
  const [state, setState] = useState<TaskState>("open");
  const [mine, setMine] = useState(false);
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [scopes, setScopes] = useState<Record<string, string>>({});
  /* The cursors spent getting here, one per page. Its length is the depth, so
     a source that pages by number reads the same state as one that pages by
     cursor and Previous is a pop either way. */
  const [trail, setTrail] = useState<string[]>([]);

  /* Derived rather than stored, so the first connected tracker is the answer
     from the first render — an effect would show GitHub's empty list for a
     frame to somebody who only has Linear. */
  const source: TrackerStatus | undefined =
    trackers.find((t) => t.id === picked) ?? trackers.find((t) => t.connected) ?? trackers[0];

  /* The toggle offers what this tracker returns and nothing more. Linear has
     no pull requests, so asking for them would ask for an empty list. */
  const kinds = source?.kinds ?? [];
  const showing = kind && kinds.includes(kind) ? kind : kinds[0];

  const scope = (source && scopes[source.id]) || "";
  const connected = !!source?.connected;

  /* The box is not the request. It is sent once somebody stops typing, so a
     six-word query is one call rather than six. */
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const ask: ListTasksParams = useMemo(() => {
    const at = trail.at(-1);
    return {
      source: source?.id,
      kind: showing,
      state,
      ...(mine ? { mine: true } : {}),
      ...(q ? { q } : {}),
      ...(source?.scopeKind === "teams" ? { team: scope || undefined } : { repo: scope || undefined }),
      ...(at ? { cursor: at } : {}),
      ...(trail.length > 0 ? { page: trail.length + 1 } : {}),
    };
  }, [source?.id, source?.scopeKind, showing, state, mine, q, scope, trail]);

  const feed = useTasks(ask, connected && !!source);

  /* A different question is a different first page. Without this, narrowing to
     a team while three pages deep asks for page four of a list that has one. */
  const question = `${source?.id}|${showing}|${state}|${mine}|${q}|${scope}`;
  useEffect(() => setTrail([]), [question]);

  const tracker = useTrackerScopes(source?.id ?? "", connected);
  const count = feed.total ?? feed.data.length;

  const refresh = () => cache.invalidateQueries({ queryKey: getListTasksQueryKey(ask) });

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-6 py-6">
        <h1 className="text-display text-bone">{count} to pick from.</h1>
        <p className="mt-1 text-body text-dim">
          Read from your trackers as you look. Starting one opens a workspace.
        </p>

        <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
          {/* Which tracker, and what to narrow it to. */}
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
            <Sources
              trackers={pickable(trackers)}
              value={source?.id}
              onPick={(id) => {
                setPicked(id);
                setKind(null);
              }}
            />
            {/* Beside the source rather than across the row from it: "which
                tracker" and "which part of it" are one question asked twice,
                and the refresh is the only thing here that acts rather than
                narrows. */}
            {connected && tracker.data.length > 0 && (
              <Select
                value={scope}
                onChange={(v) => source && setScopes({ ...scopes, [source.id]: v })}
                options={[
                  ["", source?.scopeKind === "teams" ? "All teams" : "All repositories"],
                  ...tracker.data.map((s) => [s.key, s.label] as [string, string]),
                ]}
                className="h-7 max-w-[220px] text-meta"
              />
            )}
            <span className="flex-1" />
            <button
              onClick={refresh}
              aria-label="Read the tracker again"
              title="Read the tracker again"
              className="grid h-7 w-7 place-items-center rounded-md border border-line bg-ground text-mute hover:text-bone"
            >
              <Icon of={RotateCw} size={12} />
            </button>
          </div>

          {/* What to ask it for. All of it is hidden until there is something
              to ask: filters over a tracker nobody has connected are controls
              that cannot do anything. */}
          {connected && (
            <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-2">
            {kinds.length > 1 && (
              <Seg
                value={showing as TaskKind}
                onPick={setKind}
                options={kinds.map((k) => [k, KIND_LABEL[k]] as [TaskKind, string])}
              />
            )}
            <Seg
              value={state}
              onPick={setState}
              options={[
                ["open", "Open"],
                ["closed", "Closed"],
              ]}
            />
            <button
              onClick={() => setMine(!mine)}
              className={`flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-ui transition-colors ${
                mine ? "border-line bg-overlay text-bone" : "border-line bg-ground text-mute hover:text-dim"
              }`}
            >
              <Icon of={User} size={12} />
              Assigned to me
            </button>
            <Input
              value={typed}
              onChange={setTyped}
              placeholder={
                source?.id === "linear" ? "team:ENG label:bug" : "label:bug sort:updated-desc"
              }
              mono
              className="h-7 flex-1"
            />
          </div>

          {/* What was actually sent, in the tracker's own dialect. */}
          <div className="border-b border-line-soft px-3 py-1.5">
            <span className="font-mono text-[9.5px] text-mute">{sent(ask)}</span>
          </div>

          <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5">
            <span className="eyebrow w-[150px] shrink-0">Id</span>
            <span className="eyebrow flex-1">Title</span>
            <span className="eyebrow w-[70px] shrink-0">Status</span>
            <span className="eyebrow w-[56px] shrink-0">Updated</span>
            <span className="w-[72px] shrink-0" />
          </div>
            </>
          )}

          {!findingTrackers && source && !connected && (
            <div className="px-3 py-8 text-center">
              <p className="text-ui text-bone">{source.label} isn't connected yet.</p>
              <p className="mx-auto mt-1 max-w-[380px] text-meta text-mute">
                {source.auth === "apiKey"
                  ? `It reads with a personal API key, kept in this server's vault.`
                  : `It shares the git host's authorization.`}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <button
                  onClick={() => navigate(paneFor(source))}
                  className="control border border-line bg-raise px-3 text-text hover:bg-overlay hover:text-bone"
                >
                  Connect {source.label}
                  <Icon of={ArrowRight} size={12} />
                </button>
                {/* **Only where a key is the thing to make.** `keyUrl` is set
                    for every tracker — Linear's API key page, and a git host's
                    personal-access-token page — so this drew "Make a key" next
                    to GitHub, which is Linear's word for Linear's flow and the
                    wrong instruction besides: a git host here is connected in
                    a browser on the Git hosts screen, and a token is the
                    fallback offered there with the scopes spelled out. Two
                    buttons where the second contradicts the first. */}
                {source.auth === "apiKey" && source.keyUrl && (
                  <a
                    href={source.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="control border border-line bg-ground px-3 text-mute hover:text-bone"
                  >
                    Make a key
                    <Icon of={ExternalLink} size={12} />
                  </a>
                )}
              </div>
            </div>
          )}

          {connected && feed.loading && (
            <p className="px-3 py-6 text-center text-ui text-mute">Reading {source?.label}…</p>
          )}
          {connected && feed.error && (
            <p className="px-3 py-6 text-center text-ui text-brick">{feed.error}</p>
          )}
          {connected && !feed.loading && !feed.error && feed.data.length === 0 && (
            <p className="px-3 py-6 text-center text-ui text-mute">
              Nothing {state} here.
            </p>
          )}

          {feed.data.map((t) => {
            const Glyph = KIND[t.kind] ?? CircleDot;
            // The tail is what identifies it; the org prefix is noise at every row.
            const short = t.key.replace(/^[a-z]+:/, "").replace(/^.*\//, "");
            return (
              <div
                key={t.id}
                className="group flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-0 hover:bg-raise/60"
              >
                <span className="flex w-[150px] shrink-0 items-center gap-1.5">
                  <Icon of={Glyph} size={12} className="shrink-0 text-mute" />
                  <span className="truncate font-mono text-micro text-dim" title={t.key}>
                    {short}
                  </span>
                </span>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui text-bone">{t.title}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    {t.labels.map((l) => (
                      <span
                        key={l.name}
                        className="rounded-sm px-1 text-[9.5px]"
                        style={{ color: l.colour ?? undefined, background: `${l.colour}1a` }}
                      >
                        {l.name}
                      </span>
                    ))}
                    {t.assignees.map((a) => (
                      <span key={a.login} className="text-[9.5px] text-mute">
                        @{a.login}
                      </span>
                    ))}
                  </span>
                </span>

                <span className="w-[70px] shrink-0">
                  <span className="rounded-sm border border-sage-deep bg-sage-tint px-1.5 py-0.5 text-micro text-sage">
                    {t.state}
                  </span>
                </span>

                <span className="w-[56px] shrink-0 font-mono text-micro text-mute">
                  {elapsed(minutesSince(t.updatedAt))}
                </span>

                <button
                  onClick={() =>
                    start({
                      title: t.title,
                      repo: t.repo ?? undefined,
                      issue: short,
                      taskKey: t.key,
                      taskUrl: t.url,
                    })
                  }
                  className="control w-[5rem] shrink-0 justify-center border border-line bg-raise text-text transition-colors hover:bg-overlay hover:text-bone"
                >
                  Start
                  <Icon of={ArrowRight} size={12} />
                </button>
              </div>
            );
          })}

          {connected && (trail.length > 0 || feed.more) && (
            <div className="flex items-center justify-between border-t border-line px-3 py-2">
              <Step
                of={ArrowLeft}
                label="Previous"
                onClick={() => setTrail(trail.slice(0, -1))}
                disabled={trail.length === 0}
              />
              <span className="font-mono text-micro text-mute">Page {trail.length + 1}</span>
              <Step
                of={ArrowRight}
                label="Next"
                after
                onClick={() => setTrail([...trail, feed.next ?? ""])}
                disabled={!feed.more}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Which tracker the page is reading.
 *
 * **A dropdown, not a strip of marks.** A row of round icons was a fine
 * control for "GitHub or Linear" and is not one for six: every git host is a
 * tracker now, so two GitLabs render as the same mark with no way to tell
 * them apart, the dot that means "not connected" is a few pixels, and the
 * strip shared one line with four other controls. The name is the thing that
 * distinguishes them, so the control has to show the name.
 *
 * Deliberately the same shape as the host picker on Repositories, so the two
 * screens teach each other rather than each having to be learned.
 *
 * A tracker nobody has connected stays on the list, greyed, because picking
 * it is how somebody reaches the prompt that connects it. Hiding it would
 * mean a Linear user with an empty page and nothing to click.
 */
function Sources({
  trackers,
  value,
  onPick,
}: {
  trackers: TrackerStatus[];
  value?: string;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  if (trackers.length < 2) return null;

  const on = trackers.find((t) => t.id === value);
  const Mark = on ? MARK[on.kind] : undefined;

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="flex h-7 items-center gap-1.5 rounded-md border border-line bg-ground px-2.5 text-ui text-bone hover:bg-raise"
      >
        {Mark && <Mark size={14} />}
        <span className="max-w-[12rem] truncate">{on?.label ?? "Pick a tracker"}</span>
        <Icon of={ChevronDown} size={12} />
      </button>

      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)}>
          <SourceRows
            trackers={trackers}
            value={value}
            onPick={(id) => { onPick(id); setOpen(null); }}
          />
        </Pop>
      )}
    </div>
  );
}

/**
 * What the picker offers, as its own component.
 *
 * Split out because `Pop` draws into `document.body` on a click, and a static
 * render can open nothing — so with the rows inline, the two guarantees worth
 * pinning became untestable the moment the strip became a menu: that a
 * tracker nobody has connected is still *on* the list, and that a tracker
 * whose id is not its kind gets its kind's mark rather than the first letter
 * of a label.
 */
export function SourceRows({
  trackers,
  value,
  onPick,
}: {
  trackers: TrackerStatus[];
  value?: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className="w-[17rem]">
      {trackers.map((t) => {
        const M = MARK[t.kind];
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            aria-label={t.label}
            className="flex w-full items-center gap-2.5 border-b border-line-soft px-3 py-2 text-left last:border-b-0 hover:bg-raise/60"
          >
            {M ? <M size={15} /> : <span className="text-micro">{t.label[0]}</span>}
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-ui ${t.connected ? "text-bone" : "text-mute"}`}>
                {t.label}
              </span>
              {/* The address, because two GitLabs differ by nothing else — and
                  "not connected" where that is the fact worth knowing before
                  picking it. */}
              <span className="block truncate font-mono text-micro text-mute">
                {t.connected ? t.host : "not connected"}
              </span>
            </span>
            {t.id === value && <Icon of={Check} size={14} className="shrink-0 text-sage" />}
          </button>
        );
      })}
    </div>
  );
}

/** What went on the wire, so a query that returns nothing can be read back. */
function sent(ask: ListTasksParams): string {
  return (
    Object.entries(ask)
      .filter(([, v]) => v !== undefined && v !== "")
      // The cursor is an opaque blob and takes the whole line if it is shown.
      .filter(([k]) => k !== "cursor")
      .map(([k, v]) => `${k}:${v}`)
      .join("  ") || "everything"
  );
}

function Step({
  of,
  label,
  onClick,
  disabled,
  after,
}: {
  of: typeof ArrowLeft;
  label: string;
  onClick: () => void;
  disabled: boolean;
  after?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="control border border-line bg-ground px-2.5 text-mute transition-colors hover:text-bone disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-mute"
    >
      {!after && <Icon of={of} size={12} />}
      {label}
      {after && <Icon of={of} size={12} />}
    </button>
  );
}

function Seg<T extends string>({
  value,
  onPick,
  options,
}: {
  value: T;
  onPick: (v: T) => void;
  options: [T, string][];
}) {
  return (
    <div className="flex gap-0.5 rounded-md bg-ground p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onPick(v)}
          className={`rounded-sm px-2.5 py-1 text-ui transition-colors ${
            value === v ? "bg-overlay text-bone" : "text-mute hover:text-dim"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
