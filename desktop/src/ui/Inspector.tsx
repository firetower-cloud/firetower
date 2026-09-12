/**
 * The right rail: what changed, what's in there, and shipping it.
 *
 * Three tabs rather than three panes, because they are three answers to the
 * same question — what has this agent actually done to my repository — and you
 * want one of them at a time while you read the conversation beside it.
 *
 * Diff leads because reviewing is the loop; Files is for when the diff is not
 * enough; Commit is the end of it.
 */
import { useState } from "react";
import {
  ChevronRight, FileCode2, FileDiff, FolderTree, GitBranch, GitPullRequest,
  MessageSquarePlus, PanelRightClose, Ship as ShipIcon,
} from "lucide-react";
import { filesFor, shipFor, type Diff, type Node } from "~/mock/backends";

const TABS = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "ship", label: "Commit", icon: ShipIcon },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function Inspector({
  workspace,
  branch,
  diffs,
  tab,
  onTab,
  onOpenFile,
  onClose,
}: {
  workspace: string;
  branch?: string;
  diffs: Diff[];
  tab: TabId;
  onTab: (t: TabId) => void;
  onOpenFile: (path: string, keep?: boolean) => void;
  onClose: () => void;
}) {
  return (
    <aside className="flex w-[23rem] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        <div className="track">
          {TABS.map((t) => (
            <button key={t.id} data-on={tab === t.id} onClick={() => onTab(t.id)}>
              <span className="flex items-center gap-1.5">
                <t.icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t.label}
                {t.id === "diff" && diffs.length > 0 && (
                  <span className="font-mono text-micro opacity-60">{diffs.length}</span>
                )}
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          title="Hide the inspector"
          className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
        >
          <PanelRightClose className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto">
        {tab === "diff" && <DiffList diffs={diffs} onOpenFile={onOpenFile} />}
        {tab === "files" && <Files nodes={filesFor(workspace)} onOpenFile={onOpenFile} />}
        {tab === "ship" && <Commit workspace={workspace} branch={branch} />}
      </div>
    </aside>
  );
}

function DiffList({ diffs, onOpenFile }: { diffs: Diff[]; onOpenFile: (p: string, keep?: boolean) => void }) {
  const [open, setOpen] = useState<string | null>(diffs[0]?.path ?? null);
  const [note, setNote] = useState<string | null>(null);

  if (diffs.length === 0) {
    return <Empty line="Nothing changed yet." hint="Edits the agent makes will show up here." />;
  }

  return (
    <div className="py-1">
      {diffs.map((d) => {
        const on = open === d.path;
        return (
          <div key={d.path}>
            <button
              onClick={() => setOpen(on ? null : d.path)}
              className="group/file flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-raise/60"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 text-mute transition-transform duration-150 ${on ? "rotate-90" : ""}`}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-ui text-bone">
                  {d.path.split("/").pop()}
                </span>
                <span className="block truncate font-mono text-micro text-mute">
                  {d.path.split("/").slice(0, -1).join("/")}
                </span>
              </span>
              <span className="shrink-0 font-mono text-micro">
                <span className="text-sage">+{d.added}</span>{" "}
                <span className="text-brick">−{d.removed}</span>
              </span>
              <span
                role="button"
                tabIndex={0}
                title="Open the whole file"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFile(d.path, true);
                }}
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-mute opacity-0 transition-opacity hover:bg-overlay hover:text-bone group-hover/file:opacity-100"
              >
                <FileCode2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
            </button>

            {on && (
              <div className="scroll-slim overflow-x-auto border-y border-line-soft bg-ground/50 font-mono text-code">
                {d.hunk.map(([kind, text], i) => {
                  const id = `${d.path}:${i}`;
                  return (
                    <div key={i} className="group/line">
                      <div
                        className={`flex w-max min-w-full items-start gap-2 px-3 py-px ${
                          kind === "add"
                            ? "bg-sage-tint text-sage"
                            : kind === "del"
                              ? "bg-brick-tint text-brick"
                              : "text-dim"
                        }`}
                      >
                        <span className="w-3 shrink-0 select-none opacity-60">
                          {kind === "add" ? "+" : kind === "del" ? "−" : " "}
                        </span>
                        {/* Code scrolls; it never wraps. A line broken mid-identifier is
                            harder to read than one you have to scroll to. */}
                        <span className="flex-1 whitespace-pre">{text}</span>
                        <button
                          onClick={() => setNote(note === id ? null : id)}
                          title="Ask for a change here"
                          className="shrink-0 text-mute opacity-0 transition-opacity group-hover/line:opacity-100 hover:text-bone"
                        >
                          <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      </div>

                      {note === id && (
                        <div className="border-y border-line bg-panel px-3 py-2.5">
                          <input
                            autoFocus
                            placeholder="What should change here?"
                            className="w-full bg-transparent font-sans text-ui text-bone placeholder:text-mute focus:outline-none"
                          />
                          <div className="mt-2 flex gap-1.5">
                            <button className="control bg-raise text-ui text-bone hover:bg-overlay">
                              Send to the agent
                            </button>
                            <button
                              onClick={() => setNote(null)}
                              className="control text-mute hover:text-dim"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Files({ nodes, onOpenFile }: { nodes: Node[]; onOpenFile: (p: string, keep?: boolean) => void }) {
  if (nodes.length === 0) return <Empty line="No workspace yet." hint="It appears once the repository is checked out." />;
  return (
    <div className="py-1.5">
      {nodes.map((n) => (
        <Branch key={n.name} node={n} depth={0} trail="" onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

function Branch({
  node,
  depth,
  trail,
  onOpenFile,
}: {
  node: Node;
  depth: number;
  /** The path so far, so a leaf knows its own address. */
  trail: string;
  onOpenFile: (p: string, keep?: boolean) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const dir = !!node.dir;
  const path = trail ? `${trail}/${node.name}` : node.name;

  return (
    <>
      <button
        onClick={() => (dir ? setOpen(!open) : onOpenFile(path))}
        onDoubleClick={() => !dir && onOpenFile(path, true)}
        style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
        className="flex h-7 w-full items-center gap-1.5 pr-3 text-left transition-colors hover:bg-raise/60"
      >
        {dir ? (
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-mute transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className={`min-w-0 flex-1 truncate font-mono text-ui ${
            dir ? "text-dim" : node.added ? "text-sage" : node.changed ? "text-bone" : "text-mute"
          }`}
        >
          {node.name}
        </span>
        {node.added && <span className="shrink-0 font-mono text-micro text-sage">new</span>}
        {node.changed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate" />}
      </button>

      {dir &&
        open &&
        node.dir!.map((c) => (
          <Branch key={c.name} node={c} depth={depth + 1} trail={path} onOpenFile={onOpenFile} />
        ))}
    </>
  );
}

function Commit({ workspace, branch }: { workspace: string; branch?: string }) {
  const ship = shipFor(workspace);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const keeping = ship.files.filter((f) => !leaving.has(f.path));

  const toggle = (path: string) =>
    setLeaving((held) => {
      const next = new Set(held);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  if (ship.stage === "open") {
    return (
      <div className="p-4">
        <div className="flex items-center gap-2 text-ui text-sage">
          <GitPullRequest className="h-4 w-4" strokeWidth={1.75} />
          The pull request is open.
        </div>
        <button className="control mt-3 w-full justify-center border border-line bg-raise text-bone hover:bg-overlay">
          Open it on GitHub
        </button>
      </div>
    );
  }

  return (
    <div className="p-3.5">
      <div className="flex items-center gap-2 font-mono text-meta text-mute">
        <GitBranch className="h-3.5 w-3.5" strokeWidth={1.75} />
        <span className="truncate text-dim">{branch}</span>
        <span>→</span>
        <span>main</span>
      </div>

      <input
        defaultValue="Serve the device flow"
        className="mt-3.5 w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone focus:border-slate-deep focus:outline-none"
      />
      <textarea
        rows={4}
        defaultValue={"Symmetric to the flow we already consume, so a native client can sign in without a password form.\n\nCodes are single use and expire in ten minutes."}
        className="scroll-slim mt-2 w-full resize-none rounded-lg border border-line bg-ground px-3 py-2 text-meta leading-relaxed text-text focus:border-slate-deep focus:outline-none"
      />

      <div className="mt-3.5">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="text-ui text-dim">
            {keeping.length} of {ship.files.length} files
          </span>
          <span className="font-mono text-micro text-mute">
            <span className="text-sage">+{keeping.reduce((n, f) => n + f.added, 0)}</span>{" "}
            <span className="text-brick">−{keeping.reduce((n, f) => n + f.removed, 0)}</span>
          </span>
        </div>

        <div className="overflow-hidden rounded-lg border border-line">
          {ship.files.map((f) => {
            const going = !leaving.has(f.path);
            return (
              <button
                key={f.path}
                onClick={() => toggle(f.path)}
                className="flex w-full items-center gap-2.5 border-b border-line-soft px-2.5 py-2 text-left last:border-0 transition-colors hover:bg-raise/60"
              >
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                    going ? "border-sage-deep bg-sage-tint text-sage" : "border-line text-transparent"
                  }`}
                >
                  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 fill-none stroke-current stroke-2">
                    <path d="M1.5 5.2 4 7.5 8.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span
                  className={`min-w-0 flex-1 truncate font-mono text-meta ${going ? "text-dim" : "text-mute line-through"}`}
                >
                  {f.path}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {ship.issue && (
        <a
          href={ship.issue.url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-start gap-2 rounded-lg border border-line bg-ground px-2.5 py-2 transition-colors hover:bg-raise"
        >
          <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={1.75} />
          <span className="min-w-0">
            <span className="block truncate text-meta text-dim">{ship.issue.title}</span>
            <span className="block font-mono text-micro text-mute">
              closes {ship.issue.key} when this merges
            </span>
          </span>
        </a>
      )}

      <button
        disabled={keeping.length === 0}
        className="control mt-3.5 w-full justify-center border border-sage-deep bg-sage-tint font-medium text-sage transition-colors hover:bg-sage-deep/40 disabled:border-line disabled:bg-raise disabled:text-mute"
      >
        {ship.label}
      </button>
    </div>
  );
}

function Empty({ line, hint }: { line: string; hint: string }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="text-ui text-dim">{line}</p>
      <p className="mt-1 text-meta text-mute">{hint}</p>
    </div>
  );
}
