"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Choice, Command, Foot, Go, Quiet } from "./Modal";
import {
  useConfigureAgent,
  getListAgentsQueryKey,
} from "@/src/api/generated/agents/agents";
import { AgentMode, type AgentView, type AgentOnHost } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";

/**
 * How an agent authenticates.
 *
 * A subscription is the front door: it's the plan most people already pay for.
 * The browser step happens on your own machine — servers don't have one — and
 * what crosses the gap is a token every host can use.
 */
export function ConnectAgent({
  agent,
  onClose,
}: {
  agent: AgentView;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<AgentMode>(agent.mode ?? AgentMode.Subscription);
  const [secret, setSecret] = useState("");

  const queryClient = useQueryClient();
  const configure = useConfigureAgent();

  const save = () =>
    configure.mutate(
      { kind: agent.kind, data: { mode, secret } },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
          onClose();
        },
      },
    );

  return (
    <Modal title={`Connect ${agent.label}`} onClose={onClose} wide>
      <div className="flex flex-col gap-2">
        <Choice
          on={mode === AgentMode.Subscription}
          title="My subscription"
          tag="plan"
          body="Get a token once on your own machine. Every host uses it — no signing in server by server."
          onClick={() => setMode(AgentMode.Subscription)}
        />
        <Choice
          on={mode === AgentMode.ApiKey}
          title="An API key"
          tag="metered"
          body="Billed per token, rather than against a plan you already pay for."
          onClick={() => setMode(AgentMode.ApiKey)}
        />
      </div>

      {mode === AgentMode.Subscription && agent.tokenCommand && (
        <div className="mt-4">
          <p className="text-[13px] leading-[1.6] text-dim">
            Run this <span className="text-bone">on your own machine</span> — it opens a
            browser and prints a token that lasts a year.
          </p>
          <div className="mt-2.5">
            <Command text={agent.tokenCommand} />
          </div>
          <p className="mt-2 text-[12px] text-mute">
            Your servers have no browser, so signing in happens where you are. The token is
            what travels — obtained once, used by every host.
          </p>
        </div>
      )}

      <div className="mt-4">
        <label className="eyebrow">
          {mode === AgentMode.Subscription ? "Paste the token" : "API key"}
        </label>
        <input
          autoFocus
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={agent.credentialSet ? "•••••••• — replace it" : "paste it here"}
          spellCheck={false}
          onKeyDown={(e) => e.key === "Enter" && secret.trim() && save()}
          className="mt-2 w-full rounded-[6px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone outline-none placeholder:text-mute focus:border-ember/40"
        />
      </div>

      <Hosts agent={agent} />

      {configure.isError && <Failure error={configure.error} />}

      <Foot>
        <Go onClick={save} disabled={!secret.trim() || configure.isPending}>
          {configure.isPending ? "Saving…" : "Save"}
        </Go>
        <Quiet onClick={onClose}>Cancel</Quiet>
      </Foot>
    </Modal>
  );
}

/** Which hosts this will actually work on, and why. */
function Hosts({ agent }: { agent: AgentView }) {
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="eyebrow mb-2">Where it will run</div>

      {agent.hosts.length === 0 && (
        <p className="text-[12.5px] text-mute">No hosts yet.</p>
      )}

      <div className="flex flex-col gap-px">
        {agent.hosts.map((h) => (
          <div key={h.hostId} className="flex items-center gap-2.5 rounded-[5px] px-2 py-2">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                h.loggedIn ? "bg-sage" : "border border-mute"
              }`}
            />
            <span className="font-mono text-[12px] text-dim">{h.hostName}</span>

            <span className="min-w-0 flex-1 truncate text-[11.5px] text-mute">
              {reads(h, agent)}
            </span>
          </div>
        ))}
      </div>

      {agent.hosts.some((h) => !h.installed) && (
        <p className="mt-3 text-[12px] text-mute">
          A host without {agent.label} installed needs it there first — Firetower runs the
          real CLI rather than shipping its own.
        </p>
      )}
    </div>
  );
}

/**
 * A host can be usable two ways, and they are different facts: someone signed
 * in on the machine itself, or the token we hold covers it.
 */
function reads(host: AgentOnHost, agent: AgentView) {
  if (!host.installed) return "not installed";
  if (host.loggedIn) return host.account ?? "signed in on the host";
  if (host.coveredByToken || agent.credentialSet) return "will use your token";
  return "needs a token";
}

/* ── shared ────────────────────────────────────────────────────────── */

function Failure({ error }: { error: unknown }) {
  return (
    <div className="mt-4 rounded-[6px] border border-ember/30 bg-ember/[0.05] px-3.5 py-2.5">
      <p className="text-[12.5px] leading-[1.55] text-bone">
        {error instanceof ApiError ? error.message : "Something went wrong. Try again."}
      </p>
    </div>
  );
}

