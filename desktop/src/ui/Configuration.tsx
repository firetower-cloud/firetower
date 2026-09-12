/**
 * Everything you set up once: the machines, the repositories, the agents, and
 * what Firetower is allowed to reach on your behalf.
 *
 * One page with sections rather than four destinations — you touch these on the
 * first day and then not again until something breaks. Every section reads the
 * real server when there is one, and says so when there is not.
 */
import { Check, Cpu, HardDrive, Link2, Loader2, X } from "lucide-react";
import { AgentMark } from "@/components/AgentMark";
import { GithubMark, Icon } from "@/components/ui";
import { useAgents, useHosts, useProviders, useRepos, useTrackers } from "~/data";
import { isLive } from "~/mock/http";
import { useBackendKey } from "~/backend";
import type { Backend } from "~/mock/backends";

export function Configuration({ backend }: { backend: Backend }) {
  const live = isLive(useBackendKey());
  const hosts = useHosts();
  const repos = useRepos();
  const agents = useAgents();
  const providers = useProviders();
  const trackers = useTrackers();

  return (
    <div className="scroll-slim h-full overflow-y-auto">
      <div className="mx-auto max-w-[52rem] px-6 py-6">
        <h1 className="text-display text-bone">{backend.org}</h1>
        <p className="mt-2 text-read text-dim">
          Signed in as <span className="text-text">{backend.user}</span>. This account exists on
          this server only.
        </p>
        {!live && (
          <p className="mt-2 text-meta text-mute">
            Showing fixtures — this is one of the demo servers, not a real one.
          </p>
        )}

        <Section title="Compute" note="One owner per host until sessions are isolated from each other.">
          <Rows feed={hosts} empty="No machine is connected yet.">
            {hosts.data.map((h) => (
              <div key={h.id} className="flex items-center gap-3 px-3.5 py-3">
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    h.state === "Online" ? "bg-sage" : h.state === "Draining" ? "bg-kind-data" : "bg-brick"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-bone">{h.name}</span>
                  <span className="block font-mono text-micro text-mute">
                    {h.machine ?? "—"} · worker {h.workerVersion ?? "not installed"}
                  </span>
                </span>
                {h.cpus != null && (
                  <span className="flex items-center gap-1.5 text-meta text-mute">
                    <Icon of={Cpu} size={12} /> {h.cpus}
                  </span>
                )}
                {h.memoryMb != null && (
                  <span className="flex items-center gap-1.5 text-meta text-mute">
                    <Icon of={HardDrive} size={12} /> {Math.round(h.memoryMb / 1024)} GB
                  </span>
                )}
                <span className="w-[68px] text-right text-meta text-mute">{h.state}</span>
              </div>
            ))}
          </Rows>
        </Section>

        <Section
          title="Repositories"
          note="A pointer and some setup. What opens one is the token, which is per person."
        >
          <Rows feed={repos} empty="No repository is connected yet.">
            {repos.data.map((r) => (
              <div key={r.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <GithubMark size={13} className="shrink-0 text-mute" />
                <span className="min-w-0 flex-1 truncate font-mono text-ui text-dim">{r.slug}</span>
                <span className="font-mono text-micro text-mute">{r.defaultBranch ?? "main"}</span>
              </div>
            ))}
          </Rows>
        </Section>

        <Section
          title="Connections"
          note="What Firetower may reach on your behalf. Authorised as you, and revocable."
        >
          <Rows feed={providers} empty="Nothing is connected.">
            {providers.data.map((p) => (
              <div key={p.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <GithubMark size={13} className="shrink-0 text-mute" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-bone">{p.label}</span>
                  <span className="block font-mono text-micro text-mute">
                    {p.configured ? p.id : "no client id set on this server"}
                  </span>
                </span>
                {p.connected ? (
                  <span className="flex items-center gap-1.5 text-meta text-sage">
                    <Icon of={Check} size={12} /> connected
                  </span>
                ) : (
                  <button className="control border border-line bg-raise text-ui text-text hover:bg-overlay">
                    <Icon of={Link2} size={12} />
                    Connect
                  </button>
                )}
              </div>
            ))}
          </Rows>
        </Section>

        <Section title="Trackers" note="Where the tasks list reads from.">
          <Rows feed={trackers} empty="No tracker is connected, so Tasks will be empty.">
            {trackers.data.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-bone">{t.label}</span>
                  <span className="block text-micro text-mute">{t.kinds.join(", ")}</span>
                </span>
                <span className="flex items-center gap-1.5 text-meta">
                  {t.connected ? (
                    <span className="flex items-center gap-1.5 text-sage">
                      <Icon of={Check} size={12} /> connected
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-mute">
                      <Icon of={X} size={12} /> not connected
                    </span>
                  )}
                </span>
              </div>
            ))}
          </Rows>
        </Section>

        <Section title="Agents" note="Your subscriptions, injected per session. Nothing is logged in on the host.">
          <Rows feed={agents} empty="No agent is configured.">
            {agents.data.map((a) => (
              <div key={a.kind} className="flex items-center gap-2.5 px-3.5 py-2.5">
                <AgentMark agent={a.kind} size={14} className="shrink-0 text-dim" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-bone">{a.label}</span>
                  <span className="block text-micro text-mute">
                    {a.hosts?.length ?? 0} host{(a.hosts?.length ?? 0) === 1 ? "" : "s"}
                  </span>
                </span>
                {a.credentialSet ? (
                  <span className="flex items-center gap-1.5 text-meta text-sage">
                    <Icon of={Check} size={12} /> signed in
                  </span>
                ) : a.needsCredential ? (
                  <span className="text-meta text-kind-data">needs a credential</span>
                ) : (
                  <span className="text-meta text-mute">no credential needed</span>
                )}
              </div>
            ))}
          </Rows>
        </Section>
      </div>
    </div>
  );
}

/** The three states a list off a server can be in, drawn the same way everywhere. */
function Rows<T>({
  feed,
  empty,
  children,
}: {
  feed: { data: T[]; live: boolean; loading: boolean; error: string | null };
  empty: string;
  children: React.ReactNode;
}) {
  if (feed.loading) {
    return (
      <div className="flex items-center gap-2 px-3.5 py-4 text-ui text-mute">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Reading it off the server…
      </div>
    );
  }
  if (feed.error) {
    return <p className="px-3.5 py-4 text-ui text-brick">{feed.error}</p>;
  }
  if (feed.data.length === 0) {
    return <p className="px-3.5 py-4 text-ui text-mute">{empty}</p>;
  }
  return <>{children}</>;
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="text-title text-bone">{title}</h2>
      {note && <p className="mt-0.5 text-meta text-mute">{note}</p>}
      <div className="mt-2.5 divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-panel">
        {children}
      </div>
    </section>
  );
}
