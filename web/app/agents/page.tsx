"use client";

import { useState } from "react";
import { AGENTS, IMAGE, type AgentCred } from "@/lib/data";
import { KeyGlyph } from "@/components/Signal";
import { ConnectAgent } from "@/components/ConnectAgent";

export default function Agents() {
  const [connecting, setConnecting] = useState(false);

  return (
    <div className="max-w-[900px] px-8 pt-8 pb-24">
      <header className="mb-7">
        <div className="eyebrow">Agents</div>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] text-bone">
          Two agents need a credential.
        </h1>
        <p className="mt-1.5 max-w-[56ch] text-[14px] text-dim">
          Firetower runs the real CLI, so it holds whatever that CLI authenticates with.
          Credentials are stored encrypted here and injected when a workspace starts —
          never written to a worker&apos;s disk.
        </p>
      </header>

      <div className="flex flex-col gap-2.5">
        {AGENTS.map((a) => (
          <AgentRow key={a.agent} agent={a} />
        ))}
      </div>

      <button
        onClick={() => setConnecting(true)}
        className="mt-4 w-full rounded-[6px] border border-dashed border-line py-3 text-[13px] text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        + Connect an agent
      </button>

      {connecting && <ConnectAgent onClose={() => setConnecting(false)} />}

      <Section label="Everywhere config" className="mt-10">
        <div className="panel px-4 py-3.5">
          <p className="mb-3 max-w-[62ch] text-[12.5px] leading-[1.55] text-dim">
            Mounted into every workspace as{" "}
            <span className="font-mono text-[11.5px] text-slate">~/.claude/</span>, so an
            agent on a host behaves like the one on your laptop. Per-repo instructions stay
            in the repo — Firetower reads whatever{" "}
            <span className="font-mono text-[11.5px] text-slate">CLAUDE.md</span> is checked in.
          </p>
          <pre className="overflow-x-auto rounded-[5px] border border-line bg-ground px-3 py-2.5 font-mono text-[11.5px] leading-[1.7] text-dim">
{`{
  "mcpServers": {
    "linear":   { "url": "https://mcp.linear.app/mcp" },
    "sentry":   { "url": "https://mcp.sentry.dev/mcp" }
  },
  "permissions": { "allow": ["Bash(npm test:*)", "Bash(git push:*)"] }
}`}
          </pre>
          <div className="mt-3 flex items-center gap-3 border-t border-line pt-3">
            <span className="font-mono text-[11px] text-mute">settings.json · 2 MCP servers</span>
            <button className="ml-auto rounded-[5px] border border-line px-2.5 py-1 text-[12px] text-mute transition-colors hover:text-text">
              Edit
            </button>
          </div>
        </div>
      </Section>

      <Section label="Workspace image" className="mt-8">
        <div className="panel px-4 py-3.5">
          <div className="flex items-center gap-3">
            <span className="h-2 w-2 rounded-full bg-sage" />
            <span className="font-mono text-[13px] text-bone">{IMAGE.tag}</span>
            <span className="ml-auto font-mono text-[11px] text-mute">on all hosts</span>
          </div>
          <div className="mt-2.5 grid grid-cols-[110px_1fr] gap-y-1.5 border-t border-line pt-3">
            <span className="eyebrow">Toolchain</span>
            <span className="font-mono text-[11.5px] text-dim">{IMAGE.includes}</span>
            <span className="eyebrow">Agents</span>
            <span className="font-mono text-[11.5px] text-dim">{IMAGE.agents}</span>
          </div>
          <p className="mt-3 border-t border-line pt-3 text-[12px] text-mute">
            Agents ship in the image, not on the host — so pinning a session to an older
            Claude Code is a tag change, and adding a host never means matching versions
            by hand.
          </p>
        </div>
      </Section>
    </div>
  );
}

/* ── One agent ─────────────────────────────────────────────────────── */

function AgentRow({ agent: a }: { agent: AgentCred }) {
  const [renewing, setRenewing] = useState(false);
  const [token, setToken] = useState("");

  const dot =
    a.state === "connected"
      ? "bg-sage"
      : a.state === "expiring"
        ? "bg-ember"
        : a.state === "failed"
          ? "bg-brick"
          : "border border-mute";

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="text-[13.5px] text-bone">{a.agent}</span>
        {a.label && (
          <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
            <KeyGlyph size={10} /> {a.label}
          </span>
        )}
        {a.version && (
          <span className="ml-auto font-mono text-[11px] text-mute">{a.version}</span>
        )}
      </div>

      {a.note && <p className="mt-2 text-[12.5px] text-mute">{a.note}</p>}

      {a.state !== "connected" || a.concurrent ? (
        <div className="mt-3 grid grid-cols-[110px_1fr] items-baseline gap-y-2 border-t border-line pt-3">
          {a.expires && (
            <>
              <span className="eyebrow">Expires</span>
              <span
                className={`font-mono text-[11.5px] ${a.state === "expiring" ? "text-ember" : "text-dim"}`}
              >
                {a.expires}
                {a.daysLeft !== undefined && ` · in ${a.daysLeft} days`}
              </span>
            </>
          )}

          {a.placement && (
            <>
              <span className="eyebrow">Secret lives</span>
              <span className="font-mono text-[11.5px] text-dim">
                {a.placement === "workspace" ? (
                  <>
                    in the workspace{" "}
                    <span className="text-mute">— readable by the agent</span>
                  </>
                ) : (
                  <>
                    brokered <span className="text-mute">— the workspace never holds it</span>
                  </>
                )}
              </span>
            </>
          )}

          {a.concurrent && (
            <>
              <span className="eyebrow">Concurrency</span>
              <span className="flex items-center gap-2.5">
                <span className="flex h-[3px] w-[120px] overflow-hidden rounded-full bg-line">
                  <span
                    className="bg-slate"
                    style={{ width: `${(a.concurrent[0] / a.concurrent[1]) * 100}%` }}
                  />
                </span>
                <span className="font-mono text-[11px] text-dim">
                  {a.concurrent[0]} of {a.concurrent[1]} running
                </span>
              </span>
            </>
          )}
        </div>
      ) : null}

      {a.state === "expiring" && !renewing && (
        <div className="mt-3 flex items-center gap-3 rounded-[5px] border border-ember/25 bg-ember/[0.04] px-3 py-2.5">
          <span className="text-[12.5px] text-text">
            Three sessions are scheduled past this date. They&apos;d stop mid-run.
          </span>
          <button
            onClick={() => setRenewing(true)}
            className="ml-auto shrink-0 rounded-[5px] bg-ember px-3 py-1.5 text-[12px] font-semibold text-[#1a0c04]"
          >
            Renew
          </button>
        </div>
      )}

      {renewing && (
        <div className="mt-3 rounded-[5px] border border-line bg-ground px-3 py-3">
          <div className="eyebrow mb-2">Run this on your laptop, then paste</div>
          <code className="mb-2 block rounded-[4px] border border-line bg-panel px-2.5 py-1.5 font-mono text-[12px] text-bone">
            <span className="text-mute select-none">$ </span>claude setup-token
          </code>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="sk-ant-oat01-…"
              spellCheck={false}
              className="flex-1 rounded-[5px] border border-line bg-panel px-2.5 py-1.5 font-mono text-[12px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
            />
            <button
              onClick={() => setRenewing(false)}
              className="rounded-[5px] bg-ember px-3 py-1.5 text-[12px] font-semibold text-[#1a0c04]"
            >
              Update
            </button>
            <button
              onClick={() => setRenewing(false)}
              className="text-[12px] text-mute hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {a.state !== "none" && a.label && (
        <div className="mt-3 flex gap-1.5 border-t border-line pt-3">
          <button className="rounded-[5px] border border-line px-2.5 py-1 text-[12px] text-mute transition-colors hover:text-text">
            Rotate
          </button>
          <button className="rounded-[5px] border border-line px-2.5 py-1 text-[12px] text-mute transition-colors hover:border-brick/50 hover:text-brick">
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="mb-2.5 flex items-center gap-3">
        <span className="eyebrow">{label}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {children}
    </section>
  );
}
