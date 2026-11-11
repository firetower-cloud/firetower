/**
 * When there is nowhere on this machine to keep the sign-in.
 *
 * The OS keychain refused the token — there is no Secret Service on the bus,
 * or the keyring is locked, or a policy has closed Credential Manager — and
 * `servers.ts` did the only safe thing with it: held it in memory for the
 * session and put it nowhere else. So this session works and the next launch
 * is the password field again, and the whole of this file is saying that out
 * loud at the moment it happens rather than letting somebody find out by being
 * signed out a day later.
 *
 * It meets `voice/Dialogs.tsx`'s own test for a dialog: there is something to
 * do behind it. And like that file's Linux microphone case it has **no deep
 * link** — there is no one pane on any of the three platforms to send anybody
 * to, and a button that opens the wrong settings application is worse than a
 * sentence that admits it.
 *
 * The card is `voice/Dialogs.tsx`'s, down to the 26rem, the overlay and the
 * footer on a hairline — and copied rather than imported, for the reason that
 * file gives for not importing `Confirm.tsx`'s: shared markup, separate lives.
 */
import { useEffect, useState } from "react";
import { platform } from "~/platform";
import { onUnkept, signedOut, unkeptSaid, unkeptSignIn } from "~/servers";

/**
 * What is refusing, and the one real remedy, per platform.
 *
 * `REFUSAL` in `voice/Dialogs.tsx` in shape and in voice. All three say the
 * same two things — this machine will not hold it, and signing in again once
 * it will is what fixes it — because that is all there honestly is to say;
 * what differs is the name of the thing that said no.
 *
 * A keyring that is *present but locked* — a gnome-keyring whose login
 * keyring never got unlocked, which is the common case over ssh — arrives as
 * a different D-Bus error and takes this same card. Telling the two apart
 * means matching on the text of an error string from three different
 * backends, which is a worse bet than one sentence that covers both.
 */
const NOWHERE: Record<typeof platform, { blocker: string; steps: string[] }> = {
  linux: {
    blocker: "There is no keyring running on this machine, so there is nowhere to put it.",
    steps: [
      "Start a keyring — gnome-keyring or KWallet, whichever your desktop uses",
      "Sign in again, and Firetower will keep it",
    ],
  },
  macos: {
    blocker: "macOS would not let Firetower into your keychain.",
    steps: ["Press Always Allow when macOS asks for the keychain", "Sign in again, and Firetower will keep it"],
  },
  windows: {
    blocker: "Windows would not let Firetower into Credential Manager.",
    steps: [
      "A policy on this machine can block it — check with whoever manages it",
      "Sign in again, and Firetower will keep it",
    ],
  },
};

export function KeychainRefused() {
  const [serverId, setServerId] = useState(unkeptSignIn);
  useEffect(() => onUnkept(() => setServerId(unkeptSignIn())), []);

  /* Escape keeps the session, the same as the loud button: being signed out of
     a server by a stray keystroke is not a thing a dismissal should do. */
  useEffect(() => {
    if (!serverId) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && unkeptSaid();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [serverId]);

  if (!serverId) return null;
  const nowhere = NOWHERE[platform];

  /* The token is in memory and in no file, so forgetting it is all that
     signing out is. The server stays in the registry — the address is still
     right — and `App.tsx` draws that server's door. */
  const out = () => {
    unkeptSaid();
    signedOut(serverId);
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-start justify-center bg-scrim pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={unkeptSaid}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
        className="w-[26rem] overflow-hidden rounded-xl border border-line lift shadow-(--shadow-float)"
      >
        <div className="px-5 pt-4 pb-3">
          <h2 className="text-lede text-bone">Firetower can’t keep you signed in on this machine</h2>
          <div className="mt-2 text-ui leading-relaxed text-dim">
            {nowhere.blocker} You are signed in now, and this will work until you quit — the next launch will ask for
            your password again.
            {/* A numbered list rather than a sentence, for the reason the
                microphone dialog gives: this is a procedure somewhere else,
                and it is followed from memory. */}
            <ol className="mt-3 space-y-1.5 text-ui text-text">
              {nowhere.steps.map((step, i) => (
                <li key={step} className="flex gap-2.5">
                  <span className="text-mute tabular-nums">{i + 1}.</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-4 py-2.5">
          <button onClick={out} className="control text-dim hover:bg-raise hover:text-bone">
            Back
          </button>
          {/* The person has already authenticated. Refusing to go on would
              make the app unusable on a legitimate machine for a reason that
              is not theirs; this is what makes it a choice rather than a
              silence. */}
          <button
            onClick={unkeptSaid}
            className="control bg-bone font-medium text-ground hover:opacity-90"
          >
            Use it for this session
          </button>
        </div>
      </div>
    </div>
  );
}
