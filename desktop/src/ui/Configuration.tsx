/**
 * Everything you set up once: the machines, the repositories, the agents.
 *
 * One page with sections rather than four destinations, which is the shape the
 * web build settled on — you touch these on the first day and then not again
 * until something breaks.
 */
import { Check, Cpu, HardDrive } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { GithubMark, Icon } from "@/components/ui";
import { STATE, type Backend } from "~/mock/backends";

export function Configuration({ backend }: { backend: Backend }) {
  const repos = [...new Set(STATE[backend.id].map((s) => s.repo).filter(Boolean))] as string[];
  const hostName = backend.id === "me" ? "hetzner" : `${backend.org.toLowerCase()}-1`;
  const running = STATE[backend.id].filter((s) => s.status !== "Ended").length;

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[820px] px-6 py-6">
        <span className="eyebrow">Configuration</span>
        <h1 className="mt-1 text-display text-bone">{backend.org}</h1>
        <p className="mt-1 text-body text-dim">
          Signed in as <span className="text-text">{backend.user}</span>. This account exists on
          this server only.
        </p>

        <Section title="Compute" note="One owner per host until sessions are isolated from each other.">
          <div className="flex items-center gap-3 px-3 py-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-sage" />
            <span className="min-w-0 flex-1">
              <span className="block text-ui text-bone">{hostName}</span>
              <span className="block font-mono text-micro text-mute">
                {backend.url.replace(/^https?:\/\//, "")}
              </span>
            </span>
            <span className="flex items-center gap-1 text-meta text-mute">
              <Icon of={Cpu} size={12} /> 8 cores
            </span>
            <span className="flex items-center gap-1 text-meta text-mute">
              <Icon of={HardDrive} size={12} /> 32 GB
            </span>
            <span className="w-[70px] text-right text-meta text-mute">{running} running</span>
          </div>
        </Section>

        <Section title="Repositories" note="A pointer and some setup. What opens it is the token, which is per person.">
          {repos.map((slug) => (
            <div key={slug} className="flex items-center gap-2.5 px-3 py-2">
              <GithubMark size={13} className="text-mute" />
              <span className="flex-1 truncate font-mono text-ui text-dim">{slug}</span>
              <span className="font-mono text-micro text-mute">main</span>
            </div>
          ))}
        </Section>

        <Section title="Agents" note="Your subscriptions, injected per session. Nothing is logged in on the host.">
          {(["ClaudeCode", "Codex"] as const).map((kind) => (
            <div key={kind} className="flex items-center gap-2.5 px-3 py-2">
              <AgentMark agent={kind} size={14} className="text-dim" />
              <span className="flex-1 text-ui text-bone">
                {kind === "ClaudeCode" ? "Claude Code" : "Codex"}
              </span>
              <span className="font-mono text-micro text-mute">{backend.user}</span>
              <span className="flex items-center gap-1 text-meta text-sage">
                <Icon of={Check} size={12} /> connected
              </span>
            </div>
          ))}
        </Section>

        <Section title="Updates" note="">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <span className="flex-1 text-ui text-dim">
              Control plane and worker are both on{" "}
              <span className="font-mono text-bone">0.32.2</span>.
            </span>
            <span className="text-meta text-mute">up to date</span>
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-title text-bone">{title}</h2>
        {note && <p className="min-w-0 flex-1 truncate text-meta text-mute">{note}</p>}
      </div>
      <div className="mt-2 divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-panel">
        {children}
      </div>
    </section>
  );
}
