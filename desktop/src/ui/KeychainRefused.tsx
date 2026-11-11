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
 * what differs is the name of the thing that said no. `store` is that same
 * thing named mid-sentence rather than at the start of one, for the sign-out
 * case, where what has to be said is which store the sign-in could not be
 * taken out of.
 *
 * A keyring that is *present but locked* — a gnome-keyring whose login
 * keyring never got unlocked, which is the common case over ssh — takes this
 * same card where it arrives as an error at all. Telling the two apart means
 * matching on the text of an error string from three different backends,
 * which is a worse bet than one sentence that covers both; the prototype's
 * fourth string for it is a deviation this declares rather than implements.
 *
 * **It does not always arrive as an error, and that is a separate thing.**
 * With a prompter on the bus the read does not fail, it *blocks*, behind an
 * `Unlock Login Keyring` dialog — which is why `hydrate` now runs behind the
 * first frame with a bounded wait rather than in front of it. Until that
 * changed, this card could not appear on that path because nothing rendered
 * at all.
 */
const NOWHERE: Record<typeof platform, { blocker: string; store: string; steps: string[] }> = {
  linux: {
    blocker: "There is no keyring running on this machine, so there is nowhere to put it.",
    /* Named in the middle of a sentence, so it is the thing rather than the
       capitalised product: "could not take the sign-in out of your keyring". */
    store: "your keyring",
    steps: [
      "Start a keyring — gnome-keyring or KWallet, whichever your desktop uses",
      "Sign in again, and Firetower will keep it",
    ],
  },
  macos: {
    blocker: "macOS would not let Firetower into your keychain.",
    store: "your keychain",
    steps: ["Press Always Allow when macOS asks for the keychain", "Sign in again, and Firetower will keep it"],
  },
  windows: {
    blocker: "Windows would not let Firetower into Credential Manager.",
    store: "Credential Manager",
    steps: [
      "A policy on this machine can block it — check with whoever manages it",
      "Sign in again, and Firetower will keep it",
    ],
  },
};

export function KeychainRefused() {
  const [unkept, setUnkept] = useState(unkeptSignIn);
  useEffect(() => onUnkept(() => setUnkept(unkeptSignIn())), []);

  /* Escape keeps the session, the same as the loud button: being signed out of
     a server by a stray keystroke is not a thing a dismissal should do. */
  useEffect(() => {
    if (!unkept) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && unkeptSaid();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [unkept]);

  if (!unkept) return null;
  const nowhere = NOWHERE[platform];

  /* The token is in memory and in no file, so forgetting it is all that
     signing out is. The server stays in the registry — the address is still
     right — and `App.tsx` draws that server's door. */
  const out = () => {
    unkeptSaid();
    signedOut(unkept.serverId);
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
          <h2 className="text-lede text-bone">
            {unkept.because === "signOut"
              ? "Firetower couldn’t finish signing you out"
              : "Firetower can’t keep you signed in on this machine"}
          </h2>
          <div className="mt-2 text-ui leading-relaxed text-dim">
            {unkept.because === "signOut" ? (
              /* Said because it cannot be fixed from in here. Neither the
                 keychain deletion nor the note that would have stopped the
                 credential being used went through, so the honest thing is
                 the one sentence nobody wants to write: it may come back. */
              <>
                You are signed out here, but this machine could not take the sign-in out of{" "}
                {nowhere.store} and could not record that you had ended it — so it may come back at the
                next launch. Until it does, nothing on this machine is using it.
              </>
            ) : unkept.because === "legacy" ? (
              <>
                {nowhere.blocker} An older version of Firetower had kept your sign-in in a file on this
                machine, and there is nowhere safe to move it to, so Firetower has stopped using it and
                you will need to sign in again.{" "}
                {unkept.revoked === "confirmed" ? (
                  /* The only state in which the copy an older build left on
                     this disk is harmless, and the only one we may say it in. */
                  <>That old sign-in has been ended with your Firetower, so the copy left in that file is no good to anybody.</>
                ) : (
                  <>
                    <strong className="text-text">It could not reach your Firetower to end that old sign-in.</strong>{" "}
                    Firetower will keep trying while this window is open. Until it succeeds, the copy in
                    that file still works — so sign out of everything from a Firetower you trust, or ask
                    whoever runs it to end your other sessions.
                  </>
                )}
              </>
            ) : (
              <>
                {nowhere.blocker} You are signed in now, and this will work until you quit — the next
                launch will ask for your password again.
              </>
            )}
            {/* A numbered list rather than a sentence, for the reason the
                microphone dialog gives: this is a procedure somewhere else,
                and it is followed from memory. Not on the sign-out case,
                which is not a procedure — there is nothing to go and do. */}
            {unkept.because !== "signOut" && (
              <ol className="mt-3 space-y-1.5 text-ui text-text">
                {nowhere.steps.map((step, i) => (
                  <li key={step} className="flex gap-2.5">
                    <span className="text-mute tabular-nums">{i + 1}.</span>
                    {step}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-panel/60 px-4 py-2.5">
          {unkept.because === "signIn" ? (
            <>
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
            </>
          ) : (
            /* One button on both of the others: there is no choice left to
               offer. The legacy sign-in is already over, and the sign-out has
               already happened — what is being acknowledged is a fact, not a
               decision. */
            <button
              onClick={unkeptSaid}
              className="control bg-bone font-medium text-ground hover:opacity-90"
            >
              {unkept.because === "legacy" ? "Sign in again" : "I understand"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
