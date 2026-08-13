"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mark, KeyGlyph } from "./Signal";
import { IMAGE } from "@/lib/data";

const STEPS = ["Running", "Repository", "Agent", "First session"];

export function Setup() {
  const [step, setStep] = useState(0);

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
        <Rail step={step} onJump={setStep} />

        <div className="mt-9">
          {step === 0 && <StepRunning onNext={() => setStep(1)} />}
          {step === 1 && <StepRepo onNext={() => setStep(2)} />}
          {step === 2 && <StepAgent onNext={() => setStep(3)} />}
          {step === 3 && <StepSession />}
        </div>
      </div>
    </div>
  );
}

/* ── The step rail ─────────────────────────────────────────────────── */

function Rail({ step, onJump }: { step: number; onJump: (n: number) => void }) {
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

/* ── Step 1 — what the install script just did ─────────────────────── */

const INSTALLED = [
  ["Firetower server", "listening on :4400 · https://firetower.local"],
  ["Firetower worker", "fire-01 — this machine, dialled home"],
  ["Docker", "27.1.1 — already present"],
  ["Workspace image", IMAGE.tag],
];

function StepRunning({ onNext }: { onNext: () => void }) {
  return (
    <Card
      title="Firetower is running."
      sub="The install script set up a server and one worker on this machine. You can add more hosts later — for now, this box is the whole fleet."
    >
      <div className="panel divide-y divide-line-soft">
        {INSTALLED.map(([what, detail]) => (
          <div key={what} className="flex items-baseline gap-3 px-4 py-2.5">
            <span className="text-sage">✓</span>
            <span className="w-[130px] shrink-0 text-[13px] text-text">{what}</span>
            <span className="font-mono text-[11.5px] text-mute">{detail}</span>
          </div>
        ))}
      </div>

      <Note>
        The image carries the agents, so nothing installs onto the host itself.
        That&apos;s what keeps every host running the same {" "}
        <span className="font-mono text-[11.5px] text-dim">claude</span>.
      </Note>

      <Actions>
        <Primary onClick={onNext}>Next — connect a repository</Primary>
      </Actions>
    </Card>
  );
}

/* ── Step 2 — GitHub ───────────────────────────────────────────────── */

const REPO_CHOICES = ["acme/backend", "acme/frontend", "acme/payments", "acme/infra"];

function StepRepo({ onNext }: { onNext: () => void }) {
  const [linked, setLinked] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  if (!linked) {
    return (
      <Card
        title="Connect a repository."
        sub="Firetower clones once per host and gives each session a worktree, so launching is fast after the first time."
      >
        <button
          onClick={() => setLinked(true)}
          className="panel flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:border-[#3a3631]"
        >
          <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" className="text-bone">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          <span className="flex-1">
            <span className="block text-[13.5px] text-bone">Install the GitHub App</span>
            <span className="block text-[12px] text-mute">
              Read code, push branches, open pull requests — on the repos you pick.
            </span>
          </span>
          <span className="text-mute">↗</span>
        </button>

        <button
          onClick={() => setLinked(true)}
          className="mt-2 w-full rounded-[6px] border border-dashed border-line py-2.5 text-[12.5px] text-mute transition-colors hover:border-[#3a3631] hover:text-text"
        >
          Use a personal access token instead
        </button>

        <Note>
          Firetower never puts your GitHub token inside a workspace — pushes are
          proxied through the worker.
        </Note>
      </Card>
    );
  }

  return (
    <Card
      title="Which repositories?"
      sub="Pick one to start. You can add the rest any time, and nothing is cloned until a session needs it."
    >
      <div className="panel divide-y divide-line-soft">
        {REPO_CHOICES.map((r) => {
          const on = picked.includes(r);
          return (
            <button
              key={r}
              onClick={() =>
                setPicked(on ? picked.filter((p) => p !== r) : [...picked, r])
              }
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raise/60"
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-[3px] border text-[10px] ${
                  on ? "border-ember bg-ember text-[#1a0c04]" : "border-line text-transparent"
                }`}
              >
                ✓
              </span>
              <span className={`font-mono text-[12.5px] ${on ? "text-bone" : "text-dim"}`}>
                {r}
              </span>
            </button>
          );
        })}
      </div>

      <Actions>
        <Primary onClick={onNext} disabled={picked.length === 0}>
          Next — connect an agent
        </Primary>
        <span className="text-[12px] text-mute">
          {picked.length || "No"} selected
        </span>
      </Actions>
    </Card>
  );
}

/* ── Step 3 — the agent. The one that actually matters. ────────────── */

type Mode = "subscription" | "api-key" | "cloud";

const MODES: { id: Mode; title: string; tag: string; body: string }[] = [
  {
    id: "subscription",
    title: "Use my Claude subscription",
    tag: "Pro · Max",
    body: "One command on your laptop. Work runs against the plan you already pay for.",
  },
  {
    id: "api-key",
    title: "Use an API key",
    tag: "metered",
    body: "Billed per token by Anthropic. Firetower can keep this out of the workspace entirely.",
  },
  {
    id: "cloud",
    title: "Bedrock · Vertex · Foundry",
    tag: "enterprise",
    body: "Firetower sets the environment; your cloud IAM does the authorising.",
  },
];

function StepAgent({ onNext }: { onNext: () => void }) {
  const [mode, setMode] = useState<Mode>("subscription");
  const [phase, setPhase] = useState<"choose" | "mint" | "done">("choose");

  if (phase === "done") {
    return (
      <Card
        title="Claude Code is connected."
        sub="Every workspace on every host will start with this credential."
      >
        <div className="panel px-4 py-4">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-sage" />
            <span className="text-[13.5px] text-bone">Claude Code</span>
            <span className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-slate">
              Max plan
            </span>
            <span className="ml-auto font-mono text-[11px] text-mute">2.1.44</span>
          </div>
          <div className="mt-3 grid grid-cols-[120px_1fr] gap-y-1.5 border-t border-line pt-3">
            <span className="eyebrow">Expires</span>
            <span className="font-mono text-[11.5px] text-dim">
              18 Aug 2027 · Firetower reminds you a week out
            </span>
            <span className="eyebrow">Secret lives</span>
            <span className="font-mono text-[11.5px] text-dim">
              in the workspace <span className="text-mute">— readable by the agent</span>
            </span>
            <span className="eyebrow">Concurrency</span>
            <span className="font-mono text-[11.5px] text-dim">
              up to 10 agents at once on this plan
            </span>
          </div>
        </div>

        <Note>
          Codex and a plain shell can be added later from Agents. You only need one
          to start.
        </Note>

        <Actions>
          <Primary onClick={onNext}>Next — launch your first session</Primary>
          <button
            onClick={() => setPhase("choose")}
            className="text-[12.5px] text-mute transition-colors hover:text-text"
          >
            Change
          </button>
        </Actions>
      </Card>
    );
  }

  if (phase === "mint") return <Mint onBack={() => setPhase("choose")} onDone={() => setPhase("done")} />;

  return (
    <Card
      title="Connect an agent."
      sub="Firetower runs the real CLI, so it needs whatever that CLI normally authenticates with."
    >
      <div className="flex flex-col gap-2">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={`panel flex items-start gap-3 px-4 py-3 text-left transition-colors ${
              mode === m.id ? "border-ember/40 bg-ember/[0.035]" : "hover:border-[#3a3631]"
            }`}
          >
            <span
              className={`mt-[3px] flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-full border ${
                mode === m.id ? "border-ember" : "border-line"
              }`}
            >
              {mode === m.id && <span className="h-[6px] w-[6px] rounded-full bg-ember" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <span className="text-[13.5px] text-bone">{m.title}</span>
                <span className="font-narrow text-[10px] font-semibold tracking-[0.12em] text-mute uppercase">
                  {m.tag}
                </span>
              </span>
              <span className="mt-0.5 block text-[12.5px] leading-[1.5] text-dim">
                {m.body}
              </span>
            </span>
          </button>
        ))}
      </div>

      <Actions>
        <Primary onClick={() => setPhase(mode === "subscription" ? "mint" : "done")}>
          Continue
        </Primary>
        <button
          onClick={onNext}
          className="text-[12.5px] text-mute transition-colors hover:text-text"
        >
          Skip — start with a plain shell
        </button>
      </Actions>
    </Card>
  );
}

/* The subscription wizard — the screen this whole flow exists for. */

function Mint({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const [help, setHelp] = useState(false);

  const valid = token.trim().startsWith("sk-ant-oat");

  useEffect(() => {
    if (!checking) return;
    const t = setTimeout(onDone, 1400);
    return () => clearTimeout(t);
  }, [checking, onDone]);

  return (
    <Card
      title="Sign in with your Claude subscription."
      sub="The browser step happens on your laptop. Firetower only ever sees the token it produces."
    >
      <ol className="flex flex-col gap-4">
        <Numbered n={1} label="Run this on your laptop">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-[5px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone">
              <span className="text-mute select-none">$ </span>claude setup-token
            </code>
            <button
              onClick={() => {
                navigator.clipboard?.writeText("claude setup-token");
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              }}
              className="shrink-0 rounded-[5px] border border-line px-2.5 py-2 text-[12px] text-mute transition-colors hover:border-[#3a3631] hover:text-text"
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
          <button
            onClick={() => setHelp(!help)}
            className="mt-2 text-[12px] text-mute underline decoration-line underline-offset-2 transition-colors hover:text-text"
          >
            Don&apos;t have Claude Code on your laptop?
          </button>
          {help && (
            <code className="mt-2 block rounded-[5px] border border-line bg-ground px-3 py-2 font-mono text-[12px] text-dim">
              <span className="text-mute select-none">$ </span>npm install -g
              @anthropic-ai/claude-code
            </code>
          )}
        </Numbered>

        <Numbered n={2} label="Approve in the browser it opens">
          <p className="text-[12.5px] leading-[1.55] text-dim">
            It signs you in with the Claude account you already use, then prints a
            token to your terminal. Nothing is saved on your laptop.
          </p>
        </Numbered>

        <Numbered n={3} label="Paste the token here">
          <input
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sk-ant-oat01-…"
            spellCheck={false}
            className="w-full rounded-[5px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
          />
          {token.trim() !== "" && !valid && (
            <p className="mt-1.5 font-mono text-[11.5px] text-brick">
              That doesn&apos;t look like a setup token — they start with sk-ant-oat.
            </p>
          )}
        </Numbered>
      </ol>

      <div className="mt-5 rounded-[6px] border border-line bg-panel px-3.5 py-3">
        <div className="eyebrow mb-1.5">Worth knowing</div>
        <ul className="flex flex-col gap-1.5 text-[12.5px] leading-[1.5] text-dim">
          <li>
            <span className="text-mute">·</span> The token is valid for about a year.
            Firetower tracks the date and tells you before it lapses.
          </li>
          <li>
            <span className="text-mute">·</span> It goes into the workspace as an
            environment variable, so the agent — and anything it installs — can read
            it. An API key can be brokered instead; a subscription token can&apos;t.
          </li>
          <li>
            <span className="text-mute">·</span> Subscriptions are per person. Running
            a whole team through one plan is a licensing question worth checking.
          </li>
        </ul>
      </div>

      <Actions>
        <Primary onClick={() => setChecking(true)} disabled={!valid || checking}>
          {checking ? "Checking…" : "Connect"}
        </Primary>
        <button
          onClick={onBack}
          className="text-[12.5px] text-mute transition-colors hover:text-text"
        >
          Back
        </button>
        {checking && (
          <span className="ml-auto flex items-center gap-2 font-mono text-[11.5px] text-ember">
            <span className="breathe h-1.5 w-1.5 rounded-full bg-current" />
            verifying with Anthropic…
          </span>
        )}
      </Actions>
    </Card>
  );
}

/* ── Step 4 — first session ───────────────────────────────────────────── */

const SUGGESTIONS = [
  "Add a health check endpoint and a test for it.",
  "Find and fix the three noisiest lint warnings.",
  "Write a README section explaining how to run the tests.",
];

function StepSession() {
  const [text, setText] = useState("");
  const router = useRouter();
  const ta = useRef<HTMLTextAreaElement>(null);

  return (
    <Card
      title="Launch something small."
      sub="A first session that finishes in a few minutes tells you more than a big one. You can watch the whole thing in the terminal."
    >
      <div className="panel overflow-hidden">
        <textarea
          ref={ta}
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="What should we work on?"
          className="w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-6 text-bone placeholder:text-mute focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2.5">
          <Pill>▣ acme/backend</Pill>
          <Pill>⑂ main</Pill>
          <Pill>◈ Claude Code</Pill>
          <Pill><KeyGlyph size={10} /> Max plan</Pill>
          <button
            onClick={() =>
              text.trim() &&
              router.push(
                `/sessions/new?p=${encodeURIComponent(text.trim())}&repo=acme%2Fbackend`,
              )
            }
            disabled={!text.trim()}
            className="ml-auto rounded-[5px] bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
          >
            Launch
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => {
              setText(s);
              ta.current?.focus();
            }}
            className="rounded-[5px] border border-line px-3 py-1.5 text-left text-[12.5px] text-dim transition-colors hover:border-[#3a3631] hover:text-text"
          >
            {s}
          </button>
        ))}
      </div>

      <Note>
        Firetower picks a host, cuts a branch, makes a worktree, starts tmux, and
        launches the agent. You can close the laptop as soon as it&apos;s running.
      </Note>

      <Actions>
        <Link href="/" className="text-[12.5px] text-mute transition-colors hover:text-text">
          Skip to the dashboard →
        </Link>
      </Actions>
    </Card>
  );
}

/* ── Shared bits ───────────────────────────────────────────────────── */

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

function Numbered({
  n,
  label,
  children,
}: {
  n: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[22px_1fr] gap-x-3">
      <span className="mt-[2px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-line font-mono text-[10px] text-mute">
        {n}
      </span>
      <div>
        <div className="mb-2 text-[13px] text-text">{label}</div>
        {children}
      </div>
    </li>
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

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[5px] border border-line bg-panel px-2 py-1 text-[12px] text-dim">
      {children}
    </span>
  );
}
