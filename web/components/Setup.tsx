"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "./Signal";
import { useSetupState, useCompleteSetup } from "@/src/api/generated/setup/setup";
import { useListRepos } from "@/src/api/generated/repos/repos";
import { useListAgents } from "@/src/api/generated/agents/agents";
import type { AgentView } from "@/src/api/generated/model";
import { StepPassword, StepOrganization, StepGitHub } from "./SetupAccount";
import { ConnectRepo } from "./ConnectRepo";
import { ConnectAgent } from "./ConnectAgent";

/**
 * Three steps that ask something, then three that set something up.
 *
 * A step drops off once it is answered, so a Firetower that has been set up
 * shows only what is left however often this page is opened.
 *
 * There used to be a fourth called "Running", which listed what the install had
 * done. It is gone: it told you that Firetower was running, which you could
 * tell from looking at it.
 */
const TOUR_STEPS = ["Repository", "Agent", "First session"];

export function Setup() {
  const router = useRouter();
  const { data: state, isLoading, refetch } = useSetupState();
  const complete = useCompleteSetup();

  // What is still outstanding decides how much of the wizard exists. Rendering
  // a step somebody has already answered would ask them to do it twice.
  const outstanding = [
    state?.needsPassword ? "Password" : null,
    state?.needsOrganization ? "Organisation" : null,
    state?.needsGithub ? "GitHub" : null,
  ].filter(Boolean) as string[];

  // The tour goes once. Whatever was skipped on the way stays skipped —
  // connecting GitHub is asked for again on the screen that needs it, where
  // there is no skipping it.
  const STEPS = state?.completed ? outstanding : [...outstanding, ...TOUR_STEPS];
  const [step, setStep] = useState(0);

  if (isLoading) {
    return (
      <div className="min-h-screen px-8 pt-7">
        <p className="text-[13px] text-mute">Looking…</p>
      </div>
    );
  }

  // Nothing left to ask and the tour already taken: this page has no reason to
  // exist for this install.
  if (STEPS.length === 0) {
    router.replace("/");
    return null;
  }

  const current = STEPS[step];
  // An answered step leaves the rail, so index 0 is then whatever is next —
  // the remaining question, or the first page of the tour.
  const advance = () => {
    void refetch();
    setStep(0);
  };

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-2.5 px-8 pt-7 pb-8">
        <span className="text-bone">
          <Mark size={22} />
        </span>
        <span className="font-narrow text-[13px] font-semibold tracking-[0.22em] text-bone uppercase">
          Firetower
        </span>
      </header>

      <div className="mx-auto max-w-[660px] px-8 pb-24">
        <Rail steps={STEPS} step={step} onJump={setStep} />

        <div className="mt-9">
          {current === "Password" && <StepPassword onNext={advance} />}
          {current === "Organisation" && <StepOrganization onNext={advance} />}
          {current === "GitHub" && <StepGitHub onNext={advance} />}
          {current === "Repository" && (
            <StepRepository onNext={() => setStep(step + 1)} />
          )}
          {current === "Agent" && <StepAgent onNext={() => setStep(step + 1)} />}
          {current === "First session" && (
            <StepSession onDone={() => complete.mutate()} />
          )}
        </div>
      </div>
    </div>
  );
}

/* ── The step rail ─────────────────────────────────────────────────── */

function Rail({
  steps,
  step,
  onJump,
}: {
  steps: string[];
  step: number;
  onJump: (n: number) => void;
}) {
  const STEPS = steps;
  return (
    <div className="flex items-center">
      {STEPS.map((label, i) => (
        <div key={label} className="flex flex-1 items-center last:flex-none">
          <button
            onClick={() => i <= step && onJump(i)}
            disabled={i > step}
            className="flex items-center gap-2.5 disabled:cursor-default"
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] transition-colors ${
                i < step
                  ? "bg-sage/20 text-sage"
                  : i === step
                    ? "bg-ember text-[#1a0c04]"
                    : "border border-line text-mute"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </span>
            <span
              className={`font-narrow text-[11px] font-semibold tracking-[0.14em] uppercase ${
                i === step ? "text-bone" : i < step ? "text-dim" : "text-mute"
              }`}
            >
              {label}
            </span>
          </button>
          {i < STEPS.length - 1 && (
            <span
              className={`mx-3 h-px flex-1 ${i < step ? "bg-sage/30" : "bg-line"}`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/* ── The three that used to be a mockup ────────────────────────────

   Each of these mounts the component the real screen uses. They were four
   hand-written imitations before — a GitHub button whose whole behaviour was
   `setLinked(true)`, a checklist of four invented repositories, an agent that
   reported a version nobody asked a host for. They drifted because they were a
   second implementation of screens that already existed, so there is no second
   implementation here.

   None of it is required. Every one can be skipped, and the inbox works with
   no repository, no agent and no session — it just has nothing in it.        */

function StepRepository({ onNext }: { onNext: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const { data: repos = [] } = useListRepos();

  return (
    <Card
      title="Connect a repository."
      sub="Firetower clones once per host and gives each session its own worktree, so only the first one waits. Pasting a URL works with nothing configured — the worker uses whatever git credentials the machine already has."
    >
      {repos.length > 0 && (
        <div className="panel divide-y divide-line-soft">
          {repos.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="text-sage">✓</span>
              <span className="font-mono text-[12.5px] text-dim">{r.slug}</span>
              {/* Absent until a host has been asked, which is the usual state
                  seconds after connecting one. */}
              <span className="ml-auto font-mono text-[11px] text-mute">
                {r.defaultBranch ?? "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={() => setConnecting(true)}
        className={`w-full rounded-[6px] border border-dashed border-line py-3 text-[13px] text-mute transition-colors hover:border-ember/40 hover:text-ember ${
          repos.length > 0 ? "mt-2.5" : ""
        }`}
      >
        {repos.length > 0 ? "Connect another" : "Connect a repository"}
      </button>

      <Note>
        To pick from a list of your repositories instead of pasting a URL,
        that screen asks for a GitHub client id and shows you where to get one.
      </Note>

      <Actions>
        <Primary onClick={onNext}>
          {repos.length > 0 ? "Next — connect an agent" : "Skip for now"}
        </Primary>
        {repos.length > 0 && (
          <span className="text-[12px] text-mute">
            {repos.length} connected
          </span>
        )}
      </Actions>

      {connecting && <ConnectRepo onClose={() => setConnecting(false)} />}
    </Card>
  );
}

function StepAgent({ onNext }: { onNext: () => void }) {
  const [configuring, setConfiguring] = useState<AgentView | null>(null);
  const { data: agents = [] } = useListAgents();

  // Only the ones that need a credential. A plain shell authenticates against
  // nothing, and offering to connect it would be a question with no answer.
  const askable = agents.filter((a) => a.needsCredential);

  return (
    <Card
      title="Connect an agent."
      sub="Firetower runs the real CLI on your hosts. You authenticate once here and the credential is handed to a workspace as it starts — never written to a worker's disk."
    >
      <div className="panel divide-y divide-line-soft">
        {askable.length === 0 && (
          <p className="px-4 py-3 text-[12.5px] text-mute">
            Nothing to configure yet.
          </p>
        )}

        {askable.map((a) => {
          const present = a.hosts.filter((h) => h.installed);
          return (
            <div key={a.kind} className="flex items-center gap-3 px-4 py-3">
              <span className={a.mode ? "text-sage" : "text-mute"}>
                {a.mode ? "✓" : "·"}
              </span>
              <span className="text-[13.5px] text-bone">{a.label}</span>

              {/* What a host actually reported, rather than a version typed
                  into a mockup. */}
              <span className="font-mono text-[11px] text-mute">
                {present.length > 0
                  ? `on ${present.length} of ${a.hosts.length} host${a.hosts.length === 1 ? "" : "s"}`
                  : a.hosts.some((h) => h.checkedAt)
                    ? "not installed"
                    : "not checked yet"}
              </span>

              <button
                onClick={() => setConfiguring(a)}
                className="ml-auto text-[11.5px] text-mute transition-colors hover:text-ember"
              >
                {a.mode ? "Change" : "Connect"}
              </button>
            </div>
          );
        })}
      </div>

      <Note>
        A subscription stays in the agent&apos;s own config on the host it was
        signed in on, so Firetower holds nothing — only the intent to use it.
      </Note>

      <Actions>
        <Primary onClick={onNext}>
          {askable.some((a) => a.mode) ? "Next — start something" : "Skip for now"}
        </Primary>
      </Actions>

      {configuring && (
        <ConnectAgent agent={configuring} onClose={() => setConfiguring(null)} />
      )}
    </Card>
  );
}

function StepSession({ onDone }: { onDone: () => void }) {
  const router = useRouter();

  // Either way out of here is the end of onboarding, so both record it. Leaving
  // by closing the tab does not, which is deliberate: nothing was decided.
  const leave = (to: string) => {
    onDone();
    router.push(to);
  };

  return (
    <Card
      title="That's everything."
      sub="A session is a branch, a worktree and an agent running in tmux on one of your hosts. It survives you closing the laptop, and the inbox is where it comes back to you when it stops being useful without you."
    >
      <Actions>
        <Primary onClick={() => leave("/sessions/new")}>Start a session</Primary>
        <button
          onClick={() => leave("/")}
          className="text-[12.5px] text-mute hover:text-text"
        >
          Go to the inbox
        </button>
      </Actions>
    </Card>
  );
}

function Card({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-[24px] leading-[1.2] font-semibold tracking-[-0.02em] text-bone">
        {title}
      </h1>
      <p className="mt-2 mb-6 max-w-[56ch] text-[14px] leading-[1.55] text-dim">{sub}</p>
      {children}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 border-l border-line pl-3 text-[12.5px] leading-[1.55] text-mute">
      {children}
    </p>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-6 flex items-center gap-4">{children}</div>;
}

function Primary({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-[5px] bg-ember px-4 py-2 text-[13px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
    >
      {children}
    </button>
  );
}
