/**
 * The diff, with a file list beside it.
 *
 * The memo calls review-with-comments-back-to-the-agent the one UI worth
 * owning, because it is the loop itself. This is the shape that would carry it:
 * files on the left, hunks on the right, and a line you can talk to.
 */
import { useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { Icon } from "@/components/ui";
import type { Diff } from "~/mock/backends";

export function DiffPane({ diffs }: { diffs: Diff[] }) {
  const [at, setAt] = useState(0);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const file = diffs[at];

  if (!file) {
    return <div className="grid h-full place-items-center text-ui text-mute">Nothing changed yet.</div>;
  }

  const added = diffs.reduce((n, d) => n + d.added, 0);
  const removed = diffs.reduce((n, d) => n + d.removed, 0);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex h-8 shrink-0 items-center gap-2 px-3">
          <span className="eyebrow">Changed</span>
          <span className="ml-auto font-mono text-micro">
            <span className="text-sage">+{added}</span> <span className="text-brick">−{removed}</span>
          </span>
        </div>
        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {diffs.map((d, i) => (
            <button
              key={d.path}
              onClick={() => setAt(i)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left transition-colors ${
                i === at ? "bg-overlay" : "hover:bg-raise/60"
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className={`block truncate font-mono text-micro ${i === at ? "text-bone" : "text-dim"}`}>
                  {d.path.split("/").pop()}
                </span>
                <span className="block truncate font-mono text-[9.5px] text-mute">
                  {d.path.split("/").slice(0, -1).join("/")}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[9.5px]">
                <span className="text-sage">+{d.added}</span>{" "}
                <span className="text-brick">−{d.removed}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-slim min-w-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 flex h-8 items-center gap-2 border-b border-line bg-ground/90 px-3 backdrop-blur">
          <span className="truncate font-mono text-meta text-dim">{file.path}</span>
        </div>

        <div className="font-mono text-code">
          {file.hunk.map(([kind, text], i) => {
            const id = `${file.path}:${i}`;
            return (
              <div key={i} className="group">
                <div
                  className={`flex items-start gap-3 px-3 py-px ${
                    kind === "add"
                      ? "bg-sage-tint text-sage"
                      : kind === "del"
                        ? "bg-brick-tint text-brick"
                        : "text-dim"
                  }`}
                >
                  <span className="w-6 shrink-0 text-right text-mute select-none">{i + 1}</span>
                  <span className="w-2 shrink-0 select-none">
                    {kind === "add" ? "+" : kind === "del" ? "−" : " "}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{text}</span>
                  <button
                    onClick={() => setNotes((n) => ({ ...n, [id]: n[id] ? "" : " " }))}
                    className="shrink-0 text-mute opacity-0 transition-opacity group-hover:opacity-100 hover:text-bone"
                    title="Comment on this line"
                  >
                    <Icon of={MessageSquarePlus} size={12} />
                  </button>
                </div>

                {notes[id] !== undefined && notes[id] !== "" && (
                  <div className="border-y border-line bg-panel px-3 py-2 pl-12">
                    <input
                      autoFocus
                      placeholder="Tell the agent what to change here"
                      value={notes[id].trimStart()}
                      onChange={(e) => setNotes((n) => ({ ...n, [id]: e.target.value || " " }))}
                      className="w-full bg-transparent text-ui text-bone placeholder:text-mute focus:outline-none"
                    />
                    <div className="mt-1.5 flex gap-1.5">
                      <button className="rounded-sm border border-line bg-raise px-2 py-0.5 text-micro text-text hover:bg-overlay">
                        Send to the agent
                      </button>
                      <button
                        onClick={() => setNotes((n) => ({ ...n, [id]: "" }))}
                        className="rounded-sm px-2 py-0.5 text-micro text-mute hover:text-dim"
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
      </div>
    </div>
  );
}
