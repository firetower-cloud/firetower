"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useListRepos } from "@/src/api/generated/repos/repos";
import {
  useCreateSession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useQueryClient } from "@tanstack/react-query";
import { KeyGlyph } from "./Signal";

const AGENTS = ["Claude Code", "Codex", "Shell"];
const SIZES = ["Small · 1 CPU / 2 GB", "Medium · 2 CPU / 4 GB", "Large · 4 CPU / 8 GB"];

export function Composer() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [repoId, setRepoId] = useState<string>("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: repos = [] } = useListRepos();
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];

  const create = useCreateSession({
    mutation: {
      onSuccess: (session) => {
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        router.push(`/sessions/${session.id}`);
      },
    },
  });

  useEffect(() => {
    if (open) ta.current?.focus();
  }, [open]);

  /* Launching opens the session — you land on the workspace being built. */
  const launch = () => {
    if (!text.trim() || !repo || create.isPending) return;
    create.mutate({ data: { repoId: repo.id, prompt: text.trim(), agent: "ClaudeCode" } });
  };

  return (
    <div
      className={`panel overflow-hidden transition-colors ${
        open ? "border-line bg-raise" : "hover:border-[#33302c]"
      }`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <textarea
          ref={ta}
          rows={open ? 3 : 1}
          value={text}
          placeholder="What should we work on?"
          onFocus={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
            if (e.key === "Escape") setOpen(false);
          }}
          className="flex-1 resize-none bg-transparent text-[14px] leading-6 text-bone placeholder:text-mute focus:outline-none"
        />
        {!open && (
          <span className="mt-0.5 font-mono text-[11px] text-mute">{repo?.slug ?? "no repository"}</span>
        )}
      </div>

      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              glyph="repo"
              value={repo?.slug ?? "none"}
              onChange={(slug) => setRepoId(repos.find((r) => r.slug === slug)?.id ?? "")}
              options={repos.map((r) => r.slug)}
            />
            <Chip glyph="branch" value={repo?.defaultBranch ?? "main"} options={[repo?.defaultBranch ?? "main"]} />
            <Chip glyph="agent" value="Claude Code" options={AGENTS} />
            <Chip glyph="size" value="Medium · 2 CPU / 4 GB" options={SIZES} />
            <Chip glyph="host" value="auto" options={["auto"]} />
            <Chip glyph="cred" value="Max plan" options={["Max plan", "API key"]} />

            <div className="ml-auto flex items-center gap-3">
              <span className="font-mono text-[10px] text-mute">⌘⏎</span>
              <button
                onClick={launch}
                disabled={!text.trim() || !repo || create.isPending}
                className="rounded-[5px] bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
              >
                {create.isPending ? "Opening…" : "Launch"}
              </button>
            </div>
          </div>

          {create.isError && (
            <p className="mt-2.5 border-t border-line pt-2.5 font-mono text-[11.5px] text-brick">
              {(create.error as { code?: string; message?: string }).code === "NoCapacity"
                ? "No host is available to take this."
                : (create.error as { message?: string }).message ?? "Couldn't launch."}
            </p>
          )}

          <p className="mt-2.5 border-t border-line pt-2.5 text-[11.5px] text-mute">
            Opens the session so you can watch it start. Firetower names the branch from your
            prompt and destroys the workspace once it&apos;s pushed.
          </p>
        </div>
      )}
    </div>
  );
}

const GLYPHS: Record<string, React.ReactNode> = {
  repo: "▣",
  branch: "⑂",
  agent: "◈",
  size: "▤",
  host: "⌂",
  cred: <KeyGlyph size={10} />,
};

function Chip({
  glyph,
  value,
  options,
  onChange,
}: {
  glyph: string;
  value: string;
  options: string[];
  onChange?: (v: string) => void;
}) {
  return (
    <label className="group relative flex items-center gap-1.5 rounded-[5px] border border-line bg-panel py-1 pr-6 pl-2 text-[12px] text-dim transition-colors hover:border-[#3a3631] hover:text-text">
      <span className="text-mute">{GLYPHS[glyph]}</span>
      <span className="max-w-[150px] truncate">{value}</span>
      <span className="pointer-events-none absolute right-2 text-[9px] text-mute">▾</span>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}
