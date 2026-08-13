"use client";

import Link from "next/link";
import { useState } from "react";
import { Terminal } from "./Terminal";
import { Diff } from "./Diff";
import { Signal, TONE } from "./Signal";
import { STATUS_LABEL, elapsed, type Session } from "@/lib/data";

const TABS = ["Terminal", "Diff", "Files", "Activity"] as const;
type Tab = (typeof TABS)[number];

export function SessionView({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>("Terminal");
  const live = session.status === "Working" || session.status === "NeedsYou";
  const add = session.files.reduce((a, f) => a + f.add, 0);
  const del = session.files.reduce((a, f) => a + f.del, 0);

  return (
    <div className="flex h-screen min-h-0 flex-col">
      {/* identity */}
      <header className="shrink-0 border-b border-line bg-panel">
        <div className="flex items-center gap-3 px-5 pt-3.5 pb-2.5">
          <Link
            href="/"
            className="rounded-[4px] px-1.5 py-0.5 text-[13px] text-mute transition-colors hover:bg-raise hover:text-text"
          >
            ←
          </Link>
          <span className="font-mono text-[12px] text-mute">{session.repo}</span>
          <h1 className="text-[15px] font-semibold text-bone">{session.name}</h1>

          <span
            className={`ml-2 flex items-center gap-1.5 rounded-full border border-line bg-ground py-0.5 pr-2.5 pl-1.5 font-narrow text-[10px] font-semibold tracking-[0.12em] uppercase ${TONE[session.status]}`}
          >
            <Signal status={session.status} size={5} />
            {STATUS_LABEL[session.status]}
          </span>

          <span className="ml-auto font-mono text-[11.5px] text-mute">
            {elapsed(session.minutes)}
          </span>
        </div>

        <div className="flex items-center gap-4 px-5 pb-2.5 font-mono text-[11.5px] text-mute">
          <span>
            <span className="text-slate">⑂ {session.branch}</span> → {session.base}
          </span>
          <span>⌂ {session.host}</span>
          <span>◈ {session.agent}</span>
          <span>▤ {session.size}</span>
        </div>

        <nav className="flex items-center gap-px px-3">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`relative px-3 py-2 text-[12.5px] transition-colors ${
                tab === t ? "text-bone" : "text-mute hover:text-text"
              }`}
            >
              {t}
              {t === "Diff" && session.files.length > 0 && (
                <span className="ml-1.5 font-mono text-[10.5px] text-mute">
                  {session.files.length}
                </span>
              )}
              {tab === t && <span className="absolute inset-x-2 -bottom-px h-[2px] bg-ember" />}
            </button>
          ))}
          <button className="ml-auto px-3 py-2 font-narrow text-[10px] font-semibold tracking-[0.12em] text-mute uppercase transition-colors hover:text-text">
            ⤢ Fullscreen
          </button>
        </nav>
      </header>

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {tab === "Terminal" && <Terminal session={session} live={live} />}
          {tab === "Diff" &&
            (session.files.length ? (
              <Diff files={session.files} />
            ) : (
              <Empty text="Nothing has changed on this branch yet." />
            ))}
          {tab === "Files" && <Files session={session} />}
          {tab === "Activity" && <Activity session={session} />}
        </div>

        {tab !== "Diff" && (
          <aside className="hidden w-[264px] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel lg:flex">
            <div className="px-4 pt-4">
              <div className="eyebrow">Changes</div>
              {session.files.length ? (
                <>
                  <div className="mt-2 flex items-baseline gap-2 font-mono text-[13px]">
                    <span className="text-sage">+{add}</span>
                    <span className="text-brick">−{del}</span>
                    <span className="text-mute text-[11px]">{session.files.length} files</span>
                  </div>
                  <div className="mt-2.5 flex h-[3px] overflow-hidden rounded-full bg-line">
                    <span className="bg-sage" style={{ width: `${(add / (add + del)) * 100}%` }} />
                    <span className="bg-brick" style={{ width: `${(del / (add + del)) * 100}%` }} />
                  </div>
                  <div className="mt-3 flex flex-col">
                    {session.files.slice(0, 6).map((f) => {
                      const cut = f.path.lastIndexOf("/") + 1;
                      return (
                        <div key={f.path} className="flex items-baseline gap-2 py-[3px]">
                          <span
                            className={`font-mono text-[10px] ${f.mode === "A" ? "text-sage" : "text-mute"}`}
                          >
                            {f.mode}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                            <span className="text-mute/70">{f.path.slice(0, cut)}</span>
                            <span className="text-dim">{f.path.slice(cut)}</span>
                          </span>
                          <span className="font-mono text-[10px] text-sage">+{f.add}</span>
                        </div>
                      );
                    })}
                    {session.files.length > 6 && (
                      <span className="mt-1 font-mono text-[10.5px] text-mute">
                        …{session.files.length - 6} more
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <p className="mt-2 text-[12px] text-mute">No changes yet.</p>
              )}
            </div>

            {session.ports && (
              <div className="mt-6 px-4">
                <div className="eyebrow">Ports</div>
                <div className="mt-2 flex flex-col gap-1">
                  {session.ports.map((p) => (
                    <button
                      key={p.port}
                      className="flex items-center gap-2 rounded-[4px] px-1.5 py-1 text-left transition-colors hover:bg-raise"
                    >
                      <span className="font-mono text-[11.5px] text-slate">:{p.port}</span>
                      <span className="text-[11.5px] text-dim">{p.label}</span>
                      <span className="ml-auto text-[10px] text-mute">↗</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-auto flex flex-col gap-1.5 border-t border-line p-3">
              {session.status === "HandedBack" ? (
                <>
                  <Action primary>Open pull request</Action>
                  <Action>Keep working on it</Action>
                </>
              ) : session.status === "Failed" ? (
                <>
                  <Action primary>Retry on another host</Action>
                  <Action>Edit setup script</Action>
                </>
              ) : (
                /* Still working — it isn't your move yet, so nothing here shouts. */
                <>
                  <Action>Commit and push</Action>
                  <Action>Open pull request</Action>
                </>
              )}
              <div className="mt-1 flex gap-1.5">
                <Action small>Stop</Action>
                <Action small danger>
                  Destroy
                </Action>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function Action({
  children,
  primary,
  small,
  danger,
}: {
  children: React.ReactNode;
  primary?: boolean;
  small?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`rounded-[5px] px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
        small ? "flex-1" : "w-full"
      } ${
        primary
          ? "bg-ember text-[#1a0c04] hover:opacity-90"
          : danger
            ? "border border-line text-mute hover:border-brick/50 hover:text-brick"
            : "border border-line bg-raise text-text hover:border-[#3a3631] hover:text-bone"
      }`}
    >
      {children}
    </button>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-[#0a0908] text-[13px] text-mute">
      {text}
    </div>
  );
}

function Files({ session }: { session: Session }) {
  const tree = [
    "src/",
    "  webhooks/",
    "    stripe.ts",
    "    handlers/",
    "      invoice.ts",
    "      charge.ts",
    "  lib/",
    "    retry.ts",
    "    retry.test.ts",
    "  types/",
    "    webhook.ts",
    "  config/",
    "    limits.ts",
    "docs/",
    "  webhooks.md",
    "package.json",
  ];
  const changed = new Set(session.files.map((f) => f.path.split("/").pop()));

  return (
    <div className="h-full overflow-y-auto bg-[#0a0908] px-5 py-4 font-mono text-[12.5px] leading-[1.8]">
      <div className="eyebrow mb-3">/var/lib/firetower/worktrees/{session.id}</div>
      {tree.map((l) => {
        const leaf = l.trim();
        const isChanged = changed.has(leaf);
        return (
          <div key={l} className="flex items-center gap-2 whitespace-pre">
            <span className={isChanged ? "text-bone" : leaf.endsWith("/") ? "text-slate" : "text-mute"}>
              {l}
            </span>
            {isChanged && <span className="text-[10px] text-ember">●</span>}
          </div>
        );
      })}
    </div>
  );
}

function Activity({ session }: { session: Session }) {
  const events = [
    ["20:02:11", "Session created", `${session.repo} · ${session.base}`],
    ["20:02:11", "Host selected", `${session.host} — 9 of 16 GB free`],
    ["20:02:14", "Repo fetched", "from mirror cache · 0.9s"],
    ["20:02:15", "Worktree added", `${session.branch} from ${session.base}`],
    ["20:02:19", "Workspace started", "docker · 2 CPU / 4 GB"],
    ["20:02:24", "Setup script", "npm ci — 41 packages · 4.2s"],
    ["20:02:29", "tmux session", `firetower:${session.id}`],
    ["20:02:29", "Agent launched", session.agent],
    ["20:02:31", "Status", "Working"],
    ["20:20:02", "Status", STATUS_LABEL[session.status]],
  ];

  return (
    <div className="h-full overflow-y-auto bg-[#0a0908] px-5 py-4">
      {events.map(([t, what, detail], i) => (
        <div key={i} className="flex items-baseline gap-4 border-b border-line-soft py-2">
          <span className="w-16 shrink-0 font-mono text-[11px] text-mute">{t}</span>
          <span className="w-36 shrink-0 text-[12.5px] text-text">{what}</span>
          <span className="font-mono text-[11.5px] text-mute">{detail}</span>
        </div>
      ))}
    </div>
  );
}
