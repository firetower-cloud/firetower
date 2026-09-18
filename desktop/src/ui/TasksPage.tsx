/**
 * What you could work on.
 *
 * One tracker at a time, because `/tasks` answers for one source per request
 * and the two page differently — GitHub by number with a total, Linear by
 * cursor with none. Merging them into one list would mean inventing a paging
 * scheme neither side has.
 *
 * Which tracker is a mark rather than a word: the GitHub and Linear logos are
 * the thing people already scan for, and two glyphs fit where "GitHub |
 * Linear" would push the filters onto a second row.
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
  CircleDot,
  ExternalLink,
  GitPullRequest,
  RotateCw,
  Ticket,
  User,
} from "lucide-react";
import { GithubMark, Icon, Input, LinearMark, Select } from "~/components/ui";
import { elapsed, minutesSince } from "~/api/view";
import type { Backend } from "~/fleet";
import { useTasks, useTrackers, useTrackerScopes } from "~/data";
import { useStart } from "~/start";
import { navigate } from "~/shims/next-navigation";
import { getListTasksQueryKey } from "~/api/generated/tasks/tasks";
import type { ListTasksParams, TaskKind, TaskState, TrackerStatus } from "~/api/generated/model";

const KIND = { issue: CircleDot, pullRequest: GitPullRequest, ticket: Ticket };

/** What each kind is called on the toggle. A tracker only offers its own. */
const KIND_LABEL: Record<TaskKind, string> = {
  issue: "Issues",
  pullRequest: "PRs",
  ticket: "Tickets",
};

/** The mark for a tracker, by id. Anything unrecognised keeps the page working. */
const MARK: Record<string, (p: { size?: number; className?: string }) => React.ReactNode> = {
  github: GithubMark,
  linear: LinearMark,
};

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
              trackers={trackers}
              value={source?.id}
              onPick={(id) => {
                setPicked(id);
                setKind(null);
              }}
            />
            <span className="flex-1" />
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
                  onClick={() => navigate("/configuration")}
                  className="control border border-line bg-raise px-3 text-text hover:bg-overlay hover:text-bone"
                >
                  Connect {source.label}
                  <Icon of={ArrowRight} size={12} />
                </button>
                {source.keyUrl && (
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
 * Which tracker, as marks.
 *
 * A tracker with no credential is still offered — dimmed, and picking it is
 * how somebody reaches the prompt that connects it. Hiding it instead would
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
  if (trackers.length < 2) return null;
  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-ground p-0.5">
      {trackers.map((t) => {
        const Mark = MARK[t.id];
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            aria-label={t.label}
            aria-pressed={on}
            title={t.connected ? t.label : `${t.label} — not connected`}
            className={`relative grid h-7 w-8 place-items-center rounded-sm transition-colors duration-150 ${
              on ? "bg-overlay text-bone" : "text-mute hover:text-dim"
            }`}
          >
            {/* 16 rather than the 14 an icon takes: Linear's mark is four
                bands with gaps between them, and at 14 on a 2x screen the gaps
                fall under a pixel and it reads as a filled circle. */}
            {Mark ? <Mark size={16} /> : <span className="text-micro">{t.label[0]}</span>}
            {/* A tracker you have not connected says so quietly, rather than
                by being missing from a row of two. */}
            {!t.connected && (
              <span className="absolute right-1 top-1 h-1 w-1 rounded-full bg-mute" />
            )}
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
