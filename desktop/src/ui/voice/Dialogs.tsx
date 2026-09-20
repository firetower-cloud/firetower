/**
 * The three things that stop dictation before it starts.
 *
 * Each one is a dialog because each one has something for you to *do* behind
 * it — paste a key, grant a permission, replace a key that stopped working.
 * That is the whole rule for what belongs here: a refusal you can only
 * acknowledge is not worth a dialog and stays on the composer's own line, next
 * to the one that says a file was too big.
 *
 * The card is `Confirm.tsx`'s, down to the measurements — same 26rem, same
 * overlay, same footer on a hairline. Not imported from it because that one is
 * a promise with two answers, and these have a field, a numbered list and a
 * link in them. Shared markup, separate lives.
 */
import { useEffect, useState } from "react";
import { openExternal } from "~/open";
import { platform } from "~/platform";
import type { Blocked } from "./state";

/**
 * Where the microphone permission lives, per platform.
 *
 * Deep links straight to the pane rather than to the top of settings. Both
 * schemes are declared in `src-tauri/capabilities/default.json`; the opener
 * plugin allows `http`, `https`, `mailto` and `tel` and refuses everything
 * else in silence, so a scheme that is not listed there opens nothing and says
 * nothing about why.
 */
const SETTINGS: Record<string, { url: string; name: string; steps: string[] } | null> = {
  macos: {
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    name: "System Settings",
    steps: ["Open Privacy & Security → Microphone", "Switch Firetower on", "Come back and press the microphone"],
  },
  windows: {
    url: "ms-settings:privacy-microphone",
    name: "Settings",
    /* Two switches on Windows, not one, and the second is the one people
       miss: the per-app list is below a master toggle for desktop
       applications, and with that off the app never appears in the list at
       all — which reads as the app being unknown to Windows rather than as a
       setting being off. */
    steps: [
      "Open Privacy & security → Microphone",
      "Turn on “Let desktop apps access your microphone”",
      "Come back and press the microphone",
    ],
  },
  // No one pane to point at across desktops; the words carry it instead.
  linux: null,
};

const KEYS = "https://platform.openai.com/api-keys";

function Card({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-ground/40 pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className="w-[26rem] overflow-hidden rounded-xl border border-line bg-overlay shadow-(--shadow-float)"
      >
        {children}
      </div>
    </div>
  );
}

const Head = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="px-5 pt-4 pb-3">
    <h2 className="text-lede text-bone">{title}</h2>
    <div className="mt-2 text-ui leading-relaxed text-dim">{children}</div>
  </div>
);

const Foot = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-4 py-2.5">{children}</div>
);

const Quiet = ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
  <button onClick={onClick} className="control text-dim hover:bg-raise hover:text-bone">
    {children}
  </button>
);

const Loud = ({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="control bg-bone font-medium text-ground hover:opacity-90 disabled:opacity-50"
  >
    {children}
  </button>
);

export function VoiceDialog({
  blocked,
  onDismiss,
  onConfigure,
}: {
  blocked: Blocked;
  onDismiss: () => void;
  onConfigure: (key: string) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  /* "Replace the key" turns the refusal into the setup form in place, rather
     than closing one dialog and opening another. Held here rather than pushed
     back up into `blocked`, because it is a step within this conversation and
     not a new thing standing in the way. */
  const [replacing, setReplacing] = useState(false);

  const save = async () => {
    if (!key.trim() || saving) return;
    setSaving(true);
    setTrouble(null);
    try {
      await onConfigure(key.trim());
    } catch (e) {
      setTrouble(e instanceof Error ? e.message : "That key could not be saved.");
      setSaving(false);
    }
  };

  if (blocked.why === "unsupported") {
    return (
      <Card onClose={onDismiss}>
        <Head title="This Firetower doesn't have voice input">
          The app has it; the server it is connected to does not. The desktop updates itself and a control plane does
          not, so this is what a new app pointed at an older Firetower looks like. Updating the server is what fixes it.
        </Head>
        <Foot>
          <Loud onClick={onDismiss}>Close</Loud>
        </Foot>
      </Card>
    );
  }

  if (blocked.why === "denied") {
    const here = SETTINGS[platform];
    return (
      <Card onClose={onDismiss}>
        <Head title="Firetower can't hear the microphone">
          {platform === "macos" ? "macOS" : platform === "windows" ? "Windows" : "The system"} is blocking it, and it
          won't ask again on its own.
          {/* A numbered list rather than a sentence: this is a procedure in
              another application, and the person reading it is about to leave
              this window and follow it from memory. */}
          <ol className="mt-3 space-y-1.5 text-ui text-text">
            {(here?.steps ?? ["Allow microphone access for Firetower in your system settings", "Come back and press the microphone"]).map(
              (step, n) => (
                <li key={step} className="flex gap-2.5">
                  <span className="text-mute tabular-nums">{n + 1}.</span>
                  {step}
                </li>
              ),
            )}
          </ol>
        </Head>
        <Foot>
          <Quiet onClick={onDismiss}>Not now</Quiet>
          {/* No button where there is nowhere to send them. An action that
              does nothing is worse than an instruction that asks them to. */}
          {here && <Loud onClick={() => void openExternal(here.url)}>Open {here.name}</Loud>}
        </Foot>
      </Card>
    );
  }

  if (blocked.why === "rejected" && !replacing) {
    return (
      <Card onClose={onDismiss}>
        <Head title="Voice input was refused">
          OpenAI rejected this Firetower's key. It may have been revoked, or the account may be out of credit.
          {blocked.detail && <p className="mt-2 font-mono text-meta text-mute">{blocked.detail}</p>}
        </Head>
        <Foot>
          <Quiet onClick={onDismiss}>Dismiss</Quiet>
          {/* Only an administrator is offered the fix, because only an
              administrator can carry it out. Offering a button that answers
              "you may not" is worse than not offering it. */}
          {blocked.mayConfigure && <Loud onClick={() => setReplacing(true)}>Replace the key</Loud>}
        </Foot>
      </Card>
    );
  }

  if (blocked.why === "unconfigured" && !blocked.mayConfigure) {
    return (
      <Card onClose={onDismiss}>
        <Head title="Voice input isn't set up">
          Dictation needs an OpenAI key, and this Firetower doesn't have one yet. An administrator can add it in
          Configuration.
        </Head>
        <Foot>
          <Loud onClick={onDismiss}>Close</Loud>
        </Foot>
      </Card>
    );
  }

  return (
    <Card onClose={onDismiss}>
      <Head title={replacing ? "Replace the voice key" : "Set up voice input"}>
        {replacing
          ? "The new key replaces the one in this server's vault for everyone on it."
          : "Firetower needs an OpenAI key to turn speech into text. It is held encrypted in this server's vault, shared by everyone on it, and every use is logged."}
        <input
          autoFocus
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder="sk-…"
          spellCheck={false}
          className="mt-3 w-full rounded-md border border-line bg-ground px-2.5 py-1.5 font-mono text-ui text-bone placeholder:text-mute focus:border-mute focus:outline-none"
        />
        <a href={KEYS} className="mt-2 inline-block text-meta text-dim underline decoration-line hover:text-bone">
          Where to get a key ↗
        </a>
        {trouble && <p className="mt-2 text-meta text-brick">{trouble}</p>}
      </Head>
      <Foot>
        <Quiet onClick={onDismiss}>Cancel</Quiet>
        {/* "Save and use", not "Save": you pressed the microphone, so the
            thing you asked for is listening — not a dismissed dialog and a
            second press. */}
        <Loud onClick={() => void save()} disabled={!key.trim() || saving}>
          {saving ? "Saving…" : "Save and use"}
        </Loud>
      </Foot>
    </Card>
  );
}
