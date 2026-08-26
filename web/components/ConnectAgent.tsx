"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Choice, Command, Foot, Go, Quiet } from "./Modal";
import {
  useConfigureAgent,
  useSignAgentIn,
  useListAgents,
  getListAgentsQueryKey,
} from "@/src/api/generated/agents/agents";
import { AgentMode, type AgentView, type AgentOnHost } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { CodeToType, Spinner } from "./ConnectRepo";

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
  // Two different acts wearing one word. Claude Code hands you a token to
  // carry here; Codex has no such command, and signs a machine in directly.
  if (agent.signsInWithACode) {
    return <WithACode agent={agent} onClose={onClose} />;
  }
  return <WithAToken agent={agent} onClose={onClose} />;
}

/**
 * Signing in with a device code, for an agent that has no token to paste.
 *
 * The code is asked for by a host, because that is the machine OpenAI delivers
 * the credential to. It comes straight back to the vault, so which host asked
 * stops mattering the moment it lands — every host uses it afterwards, the
 * same as a pasted token.
 */
function WithACode({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const signIn = useSignAgentIn();
  const pending = signIn.data;

  // Only while a code is on screen. Nothing else here polls, and the moment
  // the credential lands there is nothing left to wait for.
  const agents = useListAgents({
    query: { refetchInterval: pending ? 3000 : false, enabled: !!pending },
  });
  const signedIn = agents.data?.find((a) => a.kind === agent.kind)?.credentialSet;

  const queryClient = useQueryClient();
  useEffect(() => {
    if (!pending || !signedIn) return;
    queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
    onClose();
  }, [pending, signedIn, onClose, queryClient]);

  const start = () =>
    signIn.mutate(
      { kind: agent.kind, data: {} },
      { onSuccess: (auth) => window.open(auth.verificationUri, "_blank", "noopener") },
    );

  return (
    <Modal title={`Connect ${agent.label}`} onClose={onClose} wide>
      {!pending ? (
        <>
          <p className="max-w-[52ch] text-[13.5px] leading-[1.6] text-dim">
            {agent.label} signs a machine in rather than handing you a token to
            copy. One of your hosts asks for a code, you approve it in a browser,
            and the credential comes back here.
          </p>
          <ul className="mt-4 flex flex-col gap-2">
            {[
              "No password is typed here, and none passes through your browser.",
              "It is encrypted before it is stored, and every read of it is logged.",
              "Signed in once — every host uses it, not one sign-in per server.",
            ].map((line) => (
              <li key={line} className="flex gap-2.5 text-[12.5px] text-slate">
                <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-mute" />
                {line}
              </li>
            ))}
          </ul>

          <Hosts agent={agent} />

          {signIn.isError && <Failure error={signIn.error} />}

          <Foot>
            <Go onClick={start} disabled={signIn.isPending}>
              {signIn.isPending ? "Asking for a code…" : `Sign in to ${agent.label}`}
            </Go>
            <Quiet onClick={onClose}>Cancel</Quiet>
          </Foot>
        </>
      ) : (
        <>
          <p className="text-[13.5px] text-dim">
            A tab opened at{" "}
            <a
              href={pending.verificationUri}
              target="_blank"
              rel="noopener"
              className="text-ember underline underline-offset-2"
            >
              {pending.verificationUri.replace(/^https?:\/\//, "")}
            </a>
            . Enter this code:
          </p>

          <CodeToType code={pending.userCode} />

          <p className="mt-4 flex items-center gap-2 text-[12.5px] text-mute">
            <Spinner />
            Waiting for you to approve it…
          </p>

          <p className="mt-3 text-[12px] text-mute">
            The code lasts fifteen minutes. Closing this gives up on it.
          </p>
        </>
      )}
    </Modal>
  );
}

/** Signing in by carrying a token here, for an agent that prints one. */
function WithAToken({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
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
      {/* Only the subscription. The protocol and the vault both handle an API
          key — `AgentMode::ApiKey` is real on the server — but nothing has been
          run end to end that way, and offering an untested path beside a
          working one is how somebody spends an afternoon finding that out.
          Restoring the choice is this block and nothing else.

          An agent already configured with a key still reports it, and the
          agents screen still shows it. This is about what is offered, not what
          is understood. */}
      <div className="flex flex-col gap-2">
        <Choice
          on={mode === AgentMode.Subscription}
          title="My subscription"
          tag="plan"
          body="Get a token once on your own machine. Every host uses it — no signing in server by server."
          onClick={() => setMode(AgentMode.Subscription)}
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
        <label className="eyebrow">Paste the token</label>
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

