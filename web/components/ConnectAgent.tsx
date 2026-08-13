"use client";

import { useEffect, useState } from "react";
import { Modal, Segmented, Choice, Command, Foot, Go, Quiet } from "./Modal";

type Agent = "Claude Code" | "Codex" | "Shell";

const MODES: Record<Agent, { id: string; title: string; tag?: string; body: string }[]> = {
  "Claude Code": [
    {
      id: "sub",
      title: "My Claude subscription",
      tag: "Pro · Max",
      body: "One command on your laptop. Runs against the plan you already pay for.",
    },
    {
      id: "key",
      title: "An API key",
      tag: "metered",
      body: "Billed per token. Firetower can keep this out of the workspace entirely.",
    },
    {
      id: "cloud",
      title: "Bedrock · Vertex · Foundry",
      tag: "enterprise",
      body: "Firetower sets the environment; your cloud IAM authorises.",
    },
  ],
  Codex: [
    {
      id: "sub",
      title: "My ChatGPT plan",
      tag: "Plus · Pro",
      body: "Codex supports device codes, so Firetower can start this for you on a host.",
    },
    {
      id: "key",
      title: "An API key",
      tag: "metered",
      body: "OPENAI_API_KEY. Brokered — the workspace never holds the value.",
    },
  ],
  Shell: [
    {
      id: "none",
      title: "No credential",
      body: "A plain bash session in a workspace. Useful for poking at a repo without an agent.",
    },
  ],
};

export function ConnectAgent({ onClose }: { onClose: () => void }) {
  const [agent, setAgent] = useState<Agent>("Claude Code");
  const [mode, setMode] = useState("sub");
  const [phase, setPhase] = useState<"pick" | "run" | "done">("pick");

  const pick = (a: Agent) => {
    setAgent(a);
    setMode(MODES[a][0].id);
  };

  return (
    <Modal title="Connect an agent" onClose={onClose} wide>
      {phase === "pick" && (
        <>
          <Segmented
            options={["Claude Code", "Codex", "Shell"]}
            value={agent}
            onChange={(v) => pick(v as Agent)}
          />

          <p className="mt-3.5 mb-3 text-[12.5px] leading-[1.55] text-dim">
            {agent === "Shell"
              ? "Nothing to authenticate — this one is always available."
              : `Firetower runs the real ${agent} CLI, so it needs whatever that CLI normally signs in with.`}
          </p>

          <div className="flex flex-col gap-1.5">
            {MODES[agent].map((m) => (
              <Choice
                key={m.id}
                on={mode === m.id}
                title={m.title}
                tag={m.tag}
                body={m.body}
                onClick={() => setMode(m.id)}
              />
            ))}
          </div>

          <Foot>
            <Go onClick={() => setPhase(agent === "Shell" ? "done" : "run")}>
              {agent === "Shell" ? "Enable" : "Continue"}
            </Go>
            <Quiet onClick={onClose}>Cancel</Quiet>
          </Foot>
        </>
      )}

      {phase === "run" && agent === "Claude Code" && mode === "sub" && (
        <PasteToken
          command="claude setup-token"
          prefix="sk-ant-oat"
          placeholder="sk-ant-oat01-…"
          blurb="It opens your browser, signs you in with the Claude account you already use, and prints a token."
          caveat="This one goes into the workspace as an environment variable, so the agent can read it. Anthropic has no brokered equivalent for subscription tokens — an API key does support that."
          onBack={() => setPhase("pick")}
          onDone={() => setPhase("done")}
        />
      )}

      {phase === "run" && agent === "Codex" && mode === "sub" && (
        <DeviceCode onBack={() => setPhase("pick")} onDone={() => setPhase("done")} />
      )}

      {phase === "run" && mode === "key" && (
        <PasteToken
          command={
            agent === "Codex"
              ? "open platform.openai.com/api-keys"
              : "open platform.claude.com/settings/keys"
          }
          prefix={agent === "Codex" ? "sk-" : "sk-ant-"}
          placeholder={agent === "Codex" ? "sk-proj-…" : "sk-ant-api03-…"}
          blurb="Create a key scoped to just this use, so you can revoke it without touching anything else."
          caveat="Firetower brokers API keys: the workspace gets short-lived credentials it can use but not read, and you can revoke a running session's access without killing it."
          isKey
          onBack={() => setPhase("pick")}
          onDone={() => setPhase("done")}
        />
      )}

      {phase === "run" && mode === "cloud" && (
        <CloudVars onBack={() => setPhase("pick")} onDone={() => setPhase("done")} />
      )}

      {phase === "done" && <Connected agent={agent} mode={mode} onClose={onClose} />}
    </Modal>
  );
}

/* ── Paste a token or key ──────────────────────────────────────────── */

function PasteToken({
  command,
  prefix,
  placeholder,
  blurb,
  caveat,
  isKey,
  onBack,
  onDone,
}: {
  command: string;
  prefix: string;
  placeholder: string;
  blurb: string;
  caveat: string;
  isKey?: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  const valid = token.trim().startsWith(prefix);

  useEffect(() => {
    if (!checking) return;
    const t = setTimeout(onDone, 1300);
    return () => clearTimeout(t);
  }, [checking, onDone]);

  return (
    <>
      <div className="eyebrow mb-2">{isKey ? "Where to get one" : "Run on your laptop"}</div>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <Command text={command} />
        </div>
        {!isKey && (
          <button
            onClick={() => {
              navigator.clipboard?.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
            className="shrink-0 rounded-[5px] border border-line px-2.5 py-2 text-[12px] text-mute transition-colors hover:border-[#3a3631] hover:text-text"
          >
            {copied ? "copied" : "copy"}
          </button>
        )}
      </div>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-dim">{blurb}</p>

      <div className="eyebrow mt-4 mb-2">Paste it here</div>
      <input
        autoFocus
        value={token}
        onChange={(e) => setToken(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && valid && setChecking(true)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full rounded-[5px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone placeholder:text-mute focus:border-ember focus:outline-none"
      />
      {token.trim() !== "" && !valid && (
        <p className="mt-1.5 font-mono text-[11.5px] text-brick">
          Expected something starting with {prefix}
        </p>
      )}

      <p className="mt-4 border-l border-line pl-3 text-[12px] leading-[1.55] text-mute">
        {caveat}
      </p>

      <Foot>
        <Go onClick={() => setChecking(true)} disabled={!valid || checking}>
          {checking ? "Checking…" : "Connect"}
        </Go>
        <Quiet onClick={onBack}>Back</Quiet>
        {checking && (
          <span className="ml-auto flex items-center gap-2 font-mono text-[11.5px] text-ember">
            <span className="breathe h-1.5 w-1.5 rounded-full bg-current" />
            verifying…
          </span>
        )}
      </Foot>
    </>
  );
}

/* ── Codex device code — Firetower can drive this one itself ───────── */

function DeviceCode({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [left, setLeft] = useState(583);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (approved) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [approved]);

  useEffect(() => {
    if (!approved) return;
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, [approved, onDone]);

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");

  return (
    <>
      <p className="mb-3 text-[12.5px] leading-[1.55] text-dim">
        Codex supports device codes, so there&apos;s nothing to run on your laptop —
        Firetower started the login on a host and is holding the connection open.
      </p>

      <div className="mb-3">
        <Command text="codex login --device-auth" />
        <p className="mt-1.5 font-mono text-[11px] text-mute">running on fire-01</p>
      </div>

      <div className="rounded-[6px] border border-ember/25 bg-ember/[0.04] px-4 py-5 text-center">
        <div className="eyebrow">Go to</div>
        <div className="mt-1 font-mono text-[15px] text-bone">chatgpt.com/device</div>
        <div className="eyebrow mt-4">and enter</div>
        <div className="mt-1.5 font-mono text-[26px] tracking-[0.28em] text-ember">
          FTWR-9K2X
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 font-mono text-[11.5px]">
        {approved ? (
          <span className="flex items-center gap-2 text-sage">
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            Approved — writing the credential.
          </span>
        ) : (
          <>
            <span className="flex items-center gap-2 text-ember">
              <span className="breathe h-1.5 w-1.5 rounded-full bg-current" />
              waiting for you to approve…
            </span>
            <span className="ml-auto text-mute">
              expires in {mm}:{ss}
            </span>
          </>
        )}
      </div>

      <p className="mt-4 border-l border-line pl-3 text-[12px] leading-[1.55] text-mute">
        Device authorisation has to be switched on in your ChatGPT security settings
        before this works. If the code is rejected, that&apos;s usually why.
      </p>

      <Foot>
        <Go onClick={() => setApproved(true)} disabled={approved}>
          I&apos;ve approved it
        </Go>
        <Quiet onClick={onBack}>Back</Quiet>
      </Foot>
    </>
  );
}

/* ── Cloud provider ────────────────────────────────────────────────── */

function CloudVars({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [provider, setProvider] = useState("Bedrock");
  return (
    <>
      <Segmented
        options={["Bedrock", "Vertex", "Foundry"]}
        value={provider}
        onChange={setProvider}
      />
      <p className="mt-3.5 mb-3 text-[12.5px] leading-[1.55] text-dim">
        Nothing is stored here. Firetower sets these on every workspace and your cloud
        IAM decides what they can do.
      </p>
      <pre className="overflow-x-auto rounded-[5px] border border-line bg-ground px-3 py-2.5 font-mono text-[11.5px] leading-[1.8] text-dim">
{provider === "Bedrock"
  ? `CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=eu-central-1
AWS_ROLE_ARN=arn:aws:iam::…:role/firetower`
  : provider === "Vertex"
    ? `CLAUDE_CODE_USE_VERTEX=1
CLOUD_ML_REGION=europe-west1
ANTHROPIC_VERTEX_PROJECT_ID=acme-prod`
    : `CLAUDE_CODE_USE_FOUNDRY=1
FOUNDRY_RESOURCE=acme-eu
FOUNDRY_API_KEY=•••••••••••••`}
      </pre>
      <Foot>
        <Go onClick={onDone}>Save</Go>
        <Quiet onClick={onBack}>Back</Quiet>
      </Foot>
    </>
  );
}

/* ── Connected ─────────────────────────────────────────────────────── */

function Connected({
  agent,
  mode,
  onClose,
}: {
  agent: Agent;
  mode: string;
  onClose: () => void;
}) {
  const brokered = mode === "key";
  return (
    <>
      <div className="flex items-center gap-2.5">
        <span className="h-2 w-2 rounded-full bg-sage" />
        <span className="text-[14px] font-semibold text-bone">{agent} is connected.</span>
      </div>

      {agent !== "Shell" && (
        <div className="mt-3.5 grid grid-cols-[110px_1fr] gap-y-2 border-t border-line pt-3.5">
          <span className="eyebrow">Signed in as</span>
          <span className="font-mono text-[11.5px] text-dim">
            {mode === "sub"
              ? agent === "Codex"
                ? "ChatGPT Plus"
                : "Max plan"
              : mode === "key"
                ? "API key · acme-firetower"
                : "cloud provider"}
          </span>
          {mode === "sub" && (
            <>
              <span className="eyebrow">Expires</span>
              <span className="font-mono text-[11.5px] text-dim">
                {agent === "Codex"
                  ? "refreshes automatically"
                  : "18 Aug 2027 · reminder a week out"}
              </span>
            </>
          )}
          <span className="eyebrow">Secret lives</span>
          <span className="font-mono text-[11.5px] text-dim">
            {brokered ? (
              <>
                brokered <span className="text-mute">— the workspace never holds it</span>
              </>
            ) : mode === "cloud" ? (
              <>
                nowhere <span className="text-mute">— your cloud IAM authorises</span>
              </>
            ) : (
              <>
                in the workspace{" "}
                <span className="text-mute">— readable by the agent</span>
              </>
            )}
          </span>
        </div>
      )}

      <p className="mt-4 border-l border-line pl-3 text-[12px] leading-[1.55] text-mute">
        Every workspace on every host starts with this from now on. Sessions already
        running keep the credential they launched with.
      </p>

      <Foot>
        <Go onClick={onClose}>Done</Go>
      </Foot>
    </>
  );
}
