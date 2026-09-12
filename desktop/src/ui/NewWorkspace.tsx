/**
 * Starting work.
 *
 * Reached from the `+` in the rail, from a task, and from ⌘N. When it comes
 * from a task the name and the repository are already answered, so the only
 * thing left is where it runs — which is the difference between a form and a
 * confirmation, and the reason Start is one click from the task list.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, Cpu, GitBranch, X } from "lucide-react";
import { GithubMark } from "@/components/ui";
import { AgentMark } from "@/components/AgentMark";
import { STATE, type Backend } from "~/mock/backends";

export type Seed = { title?: string; repo?: string; issue?: string };

const AGENTS = ["ClaudeCode", "Codex"] as const;

/** `auth refactor` → `agent/auth-refactor`, the way the web build suggests one. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function NewWorkspace({
  backend,
  seed,
  onClose,
}: {
  backend: Backend;
  seed?: Seed;
  onClose: () => void;
}) {
  const repos = [...new Set(STATE[backend.id].map((s) => s.repo).filter(Boolean))] as string[];

  const [name, setName] = useState(seed?.title ?? "");
  const [repo, setRepo] = useState(seed?.repo ?? repos[0] ?? "");
  const [branch, setBranch] = useState("");
  const [touched, setTouched] = useState(false);
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>("ClaudeCode");
  const [prompt, setPrompt] = useState(seed?.title ? `Work on: ${seed.title}` : "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const suggested = name ? `agent/${slug(name)}` : "";
  const shown = touched ? branch : suggested;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ground/70 pt-[9vh] backdrop-blur-[3px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[34rem] overflow-hidden rounded-2xl border border-line bg-panel shadow-(--shadow-float)"
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <h2 className="text-title text-bone">New workspace</h2>
          {seed?.issue && (
            <span className="rounded-md border border-line bg-raise px-2 py-0.5 font-mono text-micro text-dim">
              {seed.issue}
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-mute transition-colors hover:bg-raise hover:text-bone"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <Field label="Name" hint="What this branch is for">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auth refactor"
              className="w-full rounded-lg border border-line bg-ground px-3 py-2 text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
            />
          </Field>

          <Field label="Repository">
            <div className="relative">
              <GithubMark
                size={13}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-mute"
              />
              <select
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="w-full appearance-none rounded-lg border border-line bg-ground py-2 pr-8 pl-8 font-mono text-ui text-bone focus:border-slate-deep focus:outline-none"
              >
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="pointer-events-none absolute top-1/2 right-3 h-3.5 w-3.5 -translate-y-1/2 text-mute"
                strokeWidth={2}
              />
            </div>
          </Field>

          <Field label="Branch" hint="Cut from main">
            <div className="relative">
              <GitBranch
                className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-mute"
                strokeWidth={1.75}
              />
              <input
                value={shown}
                onChange={(e) => {
                  setTouched(true);
                  setBranch(e.target.value);
                }}
                placeholder="agent/…"
                className="w-full rounded-lg border border-line bg-ground py-2 pr-3 pl-8 font-mono text-ui text-bone placeholder:text-mute focus:border-slate-deep focus:outline-none"
              />
            </div>
          </Field>

          <Field label="Agent">
            <div className="flex gap-2">
              {AGENTS.map((a) => (
                <button
                  key={a}
                  onClick={() => setAgent(a)}
                  className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2 transition-colors ${
                    agent === a
                      ? "border-line bg-overlay text-bone"
                      : "border-line bg-ground text-mute hover:bg-raise"
                  }`}
                >
                  <AgentMark agent={a} size={14} />
                  <span className="text-ui">{a === "ClaudeCode" ? "Claude Code" : "Codex"}</span>
                  {agent === a && <Check className="ml-auto h-3.5 w-3.5" strokeWidth={2} />}
                </button>
              ))}
            </div>
          </Field>

          <Field label="First message" hint="What it should start on">
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the work…"
              className="scroll-slim w-full resize-none rounded-lg border border-line bg-ground px-3 py-2 text-read text-text placeholder:text-mute focus:border-slate-deep focus:outline-none"
            />
          </Field>
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-ground/40 px-5 py-3">
          <span className="flex items-center gap-1.5 text-meta text-mute">
            <Cpu className="h-3.5 w-3.5" strokeWidth={1.75} />
            {backend.id === "me" ? "hetzner" : `${backend.org.toLowerCase()}-1`}
          </span>
          <button onClick={onClose} className="control ml-auto text-mute hover:bg-raise hover:text-bone">
            Cancel
          </button>
          <button
            disabled={!name.trim() || !repo}
            onClick={onClose}
            className="control border border-line bg-bone font-medium text-ground transition-opacity hover:opacity-90 disabled:bg-raise disabled:text-mute"
          >
            Start it
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <span className="text-ui text-dim">{label}</span>
        {hint && <span className="text-meta text-mute">{hint}</span>}
      </span>
      {children}
    </label>
  );
}
