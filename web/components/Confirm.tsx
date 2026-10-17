"use client";

/**
 * One question, asked before something happens to somebody else's account.
 *
 * Every action on the People screen is instant and silent, and three of them
 * are things you would want a moment to reconsider: switching an account off
 * ends its sessions, changing a role changes what somebody can reach, and
 * resetting a password stops the one they have from working. A menu item that
 * does any of those on the way past is a menu item that gets clicked by
 * accident.
 *
 * The body says what will happen, in the future tense, including the parts
 * that are *not* obvious from the label — what survives, and whether it can be
 * undone. A confirmation that only repeats the button is a speed bump, not an
 * explanation.
 *
 * **It does not predict a refusal.** The server holds the rules that would
 * lock the room — the last administrator cannot be demoted, switched off or
 * removed — and says so in a sentence. This asks, runs, and lets that sentence
 * land where every other one on the screen does.
 */
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { Button, Input } from "@/components/ui";

export type Ask = {
  title: string;
  body: React.ReactNode;
  /** The verb on the button. Never "OK": the button should say what it does. */
  action: string;
  /** For the ones that take something away. */
  tone?: "danger";
  /**
   * Words that have to be typed before the button works.
   *
   * For the few decisions that should not be reachable by clicking twice in
   * the same place. Matched exactly, because a confirmation you can satisfy
   * by typing "turn it off" in a hurry is one you can satisfy by accident.
   */
  confirmWith?: string;
  run: () => Promise<unknown> | void;
};

/**
 * Whether what was typed releases the button.
 *
 * Its own function so the rule is testable and stated once. Trimmed, because a
 * trailing space from a paste is not a different answer; otherwise exact,
 * including case — a confirmation that accepts "turn it off" in lower case is
 * one that can be satisfied without reading it.
 */
export function confirmed(confirmWith: string | undefined, typed: string): boolean {
  if (!confirmWith) return true;
  return typed.trim() === confirmWith;
}

export function Confirm({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");

  // Reset the field when the question changes, by adjusting state during
  // render rather than in an effect.
  //
  // This component stays mounted with `ask = null` between questions, so
  // without it the field still holds what was typed into the last one and the
  // next question opens already answered. An effect would do it one render too
  // late — and the compiler rejects `setState` inside one, because that is the
  // render it would be cascading from.
  const [askedFor, setAskedFor] = useState(ask);
  if (ask !== askedFor) {
    setAskedFor(ask);
    setTyped("");
  }

  if (!ask) return null;

  const held = !confirmed(ask.confirmWith, typed);

  const go = async () => {
    setBusy(true);
    try {
      await ask.run();
    } finally {
      // Closed either way. What was refused is reported where this screen
      // reports everything else, under the table — and a modal that stays
      // open over it is a modal hiding the answer.
      setBusy(false);
      onClose();
    }
  };

  return (
    <Modal title={ask.title} onClose={() => !busy && onClose()}>
      <div className="text-ui leading-[1.6] text-dim">{ask.body}</div>

      {ask.confirmWith ? (
        <div className="mt-4">
          <label className="text-meta text-mute" htmlFor="confirm-with">
            Type <span className="font-mono text-bone">{ask.confirmWith}</span> to confirm
          </label>
          <Input
            id="confirm-with"
            value={typed}
            onChange={setTyped}
            placeholder={ask.confirmWith}
            autoFocus
            className="mt-1.5 w-full"
            onKeyDown={(e) => e.key === "Enter" && !held && !busy && void go()}
          />
        </div>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={ask.tone === "danger" ? "danger" : "primary"}
          onClick={go}
          disabled={busy || held}
        >
          {busy ? "Working…" : ask.action}
        </Button>
      </div>
    </Modal>
  );
}
