"use client";

/**
 * What this session is doing, when there is no panel to keep it in.
 *
 * On a desk the answer is a permanent line at the foot of the `Inspector` —
 * one row, under every view, that does not move. Below `xl` there is no
 * Inspector, and putting that line in the header instead would spend a row of
 * a phone on a sentence that is usually "Ready".
 *
 * So the status light in the header is the control, and this is what it opens.
 * The light is already the thing that means "state"; making it the way to more
 * of it is cheaper than a fourth glyph in a bar that has three.
 *
 * It reuses `Doing` rather than restating it. The bring-up steps, the label
 * under them and the rule for when a workspace is finished enough to be worth
 * closing are decisions, and they should not exist in two places that can
 * disagree.
 */

import { Modal } from "@/components/Modal";
import { Doing } from "./Inspector";

export function StatusSheet({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  return (
    <Modal title="Status" onClose={onClose}>
      {/* `Doing` draws its own top border, which is right at the foot of a
          panel and wrong as the first thing in a sheet. */}
      <div className="-mt-2 [&>div]:border-t-0 [&>div]:px-0">
        <Doing sessionId={sessionId} />
      </div>
    </Modal>
  );
}
