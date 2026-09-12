/**
 * What you could work on.
 *
 * Same columns and the same filters as the web page — issues or PRs, open or
 * closed, assigned to you, a repository, a raw query — because that is the
 * vocabulary people already have. The key is monospace and truncated from the
 * left: `…/firetower#112` is the part you read, and the org prefix is what
 * makes every row the same width of noise.
 */
import { useState } from "react";
import { ArrowRight, CircleDot, GitPullRequest, RotateCw, Ticket, User } from "lucide-react";
import { Icon } from "@/components/ui";
import { elapsed, minutesSince } from "@/src/api/view";
import { TASKS, type Backend } from "~/mock/backends";
import { useStart } from "~/start";

const KIND = { issue: CircleDot, pullRequest: GitPullRequest, ticket: Ticket };

export function TasksPage({ backend }: { backend: Backend }) {
  const start = useStart();
  const [kind, setKind] = useState<"issue" | "pullRequest">("issue");
  const [state, setState] = useState<"open" | "closed">("open");
  const [mine, setMine] = useState(false);

  const all = TASKS[backend.id];
  const shown = all.filter(
    (t) =>
      (kind === "issue" ? t.kind !== "pullRequest" : t.kind === "pullRequest") &&
      t.state === state &&
      (!mine || t.assignees.length > 0),
  );

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[1000px] px-6 py-6">
        <h1 className="text-display text-bone">{shown.length} to pick from.</h1>
        <p className="mt-1 text-body text-dim">
          Read from your trackers as you look. Starting one opens a workspace.
        </p>

        <div className="mt-5 overflow-hidden rounded-lg border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-2">
            <Seg
              value={kind}
              onPick={setKind}
              options={[
                ["issue", "Issues"],
                ["pullRequest", "PRs"],
              ]}
            />
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
            <input
              placeholder="label:bug sort:updated-desc"
              className="h-7 min-w-0 flex-1 rounded-md border border-line bg-ground px-2 font-mono text-micro text-dim placeholder:text-mute focus:outline-none"
            />
            <button className="grid h-7 w-7 place-items-center rounded-md border border-line bg-ground text-mute hover:text-bone">
              <Icon of={RotateCw} size={12} />
            </button>
          </div>

          <div className="flex items-center gap-3 border-b border-line-soft px-3 py-1.5">
            <span className="eyebrow w-[150px] shrink-0">Id</span>
            <span className="eyebrow flex-1">Title</span>
            <span className="eyebrow w-[70px] shrink-0">Status</span>
            <span className="eyebrow w-[56px] shrink-0">Updated</span>
            <span className="w-[72px] shrink-0" />
          </div>

          {shown.length === 0 && (
            <p className="px-3 py-6 text-center text-ui text-mute">Nothing open here.</p>
          )}

          {shown.map((t) => {
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
                  onClick={() => start({ title: t.title, repo: t.repo ?? undefined, issue: short })}
                  className="control w-[5rem] shrink-0 justify-center border border-line bg-raise text-text transition-colors hover:bg-overlay hover:text-bone"
                >
                  Start
                  <Icon of={ArrowRight} size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
