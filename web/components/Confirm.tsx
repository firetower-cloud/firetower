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
import { Button } from "@/components/ui";

export type Ask = {
  title: string;
  body: React.ReactNode;
  /** The verb on the button. Never "OK": the button should say what it does. */
  action: string;
  /** For the ones that take something away. */
  tone?: "danger";
  run: () => Promise<unknown> | void;
};

export function Confirm({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!ask) return null;

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

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="quiet" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={ask.tone === "danger" ? "danger" : "primary"} onClick={go} disabled={busy}>
          {busy ? "Working…" : ask.action}
        </Button>
      </div>
    </Modal>
  );
}
