"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import { Button, Icon } from "./ui";
import type { PendingAuth } from "@/src/api/generated/model";
import { ApiError } from "@/src/api/http";
import { useDismissible } from "@/src/workspace/dismissible";

/**
 * A card on a desk, a sheet on a phone.
 *
 * The same component either way, because it is the same thing: one decision,
 * asked once, over whatever you were doing. What changes below `md` is only
 * that a 520px card floating in a 24px margin becomes the screen — which is
 * what it nearly was already, and pretending otherwise cost the edges and left
 * the confirm button somewhere you had to scroll to find.
 *
 * As a sheet it gets three things a card does not need: a floor that is above
 * the home indicator, a header tall enough to have a real target in it, and
 * Back as a way out.
 *
 * ## Why this is drawn on `body` rather than where it is written
 *
 * `position: fixed` is relative to the viewport only while no ancestor has a
 * transform, a filter or containment on it — any of those makes *it* the
 * containing block instead. The rail is `-translate-x-full` off-screen on a
 * phone and slides in, and a transform that animates is still a transform when
 * it is finished, so a modal opened from the rail's own `+` was laid out inside
 * a 236px column and clipped by its `overflow-hidden`.
 *
 * Portalling is the fix that keeps working. Neutralising the rail's transform
 * fixes today's instance and leaves the next one — a filter for a disabled
 * state, a `will-change` for a scroll — to be found the same way, by somebody
 * looking at a dialog folded into a sidebar.
 */
export function Modal({
  title,
  onClose,
  children,
  wide,
  /**
   * A floor pinned to the bottom of the sheet, rather than scrolling with it.
   *
   * For the one flow with a long body and a decision at the end of it — see
   * `ShipSheet`. Above `md` this is drawn where it always was, at the end of
   * the card.
   */
  floor,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  floor?: React.ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  useDismissible(true, onClose, "modal");

  // `document` does not exist while this renders on the server, so nothing is
  // drawn until this is running in a browser. `useSyncExternalStore` is how
  // that question is asked without writing state from an effect: the server
  // snapshot is `false`, the client's is `true`, and nothing ever changes it.
  const mounted = useSyncExternalStore(subscribe, here, notYet);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-center overflow-hidden sm:items-start sm:overflow-y-auto sm:p-10">
      <div className="fixed inset-0 bg-ground/80 backdrop-blur-[3px]" onClick={onClose} />
      <div
        className={`relative flex h-full w-full flex-col overflow-hidden border-line bg-panel sm:my-auto sm:h-auto sm:max-h-full sm:rounded-lg sm:border sm:shadow-float ${
          wide ? "sm:max-w-[620px]" : "sm:max-w-[520px]"
        }`}
      >
        <div className="shrink-0 border-b border-line pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-3 px-5 py-3">
          <span className="eyebrow">{title}</span>
          <button
            onClick={onClose}
            className="-mr-3 ml-auto grid h-11 w-11 place-items-center rounded-sm text-mute transition-colors hover:bg-raise hover:text-bone sm:-mr-1 sm:h-auto sm:w-auto sm:p-1"
            aria-label="Close"
          >
            <Icon of={X} size={14} />
          </button>
        </div>
        </div>

        {/* The body scrolls, not the page behind it. On a desk this is the
            card's own height and the scroller never engages; on a phone it is
            everything between the header and the floor. */}
        {/* A floor of its own pads for the home indicator; without one, the
            body is the bottom of the sheet and pads for it here. */}
        <div
          className={`min-h-0 flex-1 overflow-y-auto p-5 ${
            floor ? "" : "pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-5"
          }`}
        >
          {children}
        </div>

        {floor && (
          <div className="shrink-0 border-t border-line bg-panel px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-3">
            {floor}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* Nothing to subscribe to: whether this is a browser does not change. */
const subscribe = () => () => {};
const here = () => true;
const notYet = () => false;

/* Shared bits used by every flow that authorizes something. */

export function Choice({
  on,
  title,
  tag,
  body,
  onClick,
}: {
  on: boolean;
  title: string;
  tag?: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-md border px-3.5 py-3 text-left transition-colors duration-150 ${
        on ? "border-line bg-raise" : "border-line-soft hover:border-line hover:bg-raise/50"
      }`}
    >
      <span
        className={`mt-[3px] flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border ${
          on ? "border-bone" : "border-line"
        }`}
      >
        {on && <span className="h-[5px] w-[5px] rounded-full bg-bone" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`text-ui ${on ? "text-bone" : "text-text"}`}>{title}</span>
          {tag && (
            <span className="font-narrow text-micro font-semibold tracking-[0.12em] text-mute uppercase">
              {tag}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-meta text-dim">{body}</span>
      </span>
    </button>
  );
}

export function Command({ text }: { text: string }) {
  return (
    <code className="block rounded-md border border-line bg-ground px-3 py-2 font-mono text-meta text-bone">
      <span className="text-mute select-none">$ </span>
      {text}
    </code>
  );
}

export function Foot({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 flex items-center gap-3 border-t border-line pt-4">{children}</div>
  );
}

export function Go({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="primary" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

export function Quiet({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button variant="quiet" onClick={onClick} disabled={disabled}>
      {children}
    </Button>
  );
}

/**
 * The code to type, and the wait for somebody to type it.
 *
 * Shared with the screen that widens an existing authorization, which is the
 * same wait for the same reason and must not drift from this one. `note` is
 * what differs: re-authorizing is done for the organization list on the
 * approval screen, and saying so at the moment somebody is looking at that
 * screen is the whole point of sending them back to it.
 */
export function DeviceCode({ pending, note }: { pending: PendingAuth; note?: string }) {
  return (
    <>
      <p className="text-ui text-dim">
        A tab opened at{" "}
        <a
          href={pending.verificationUri}
          target="_blank"
          rel="noopener"
          className="text-dim underline underline-offset-2 transition-colors hover:text-bone"
        >
          {pending.verificationUri.replace(/^https?:\/\//, "")}
        </a>
        . Enter this code:
      </p>

      <CodeToType code={pending.userCode} />

      {note && <p className="mt-3 max-w-[54ch] text-meta leading-[1.55] text-dim">{note}</p>}

      <p className="mt-4 flex items-center gap-2 text-meta text-mute">
        <Spinner />
        Waiting for you to approve it…
      </p>
    </>
  );
}

/** Shown, not clicked — so it needs to be readable and copyable. */
export function CodeToType({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-3 flex items-center gap-3">
      <code className="rounded-md border border-line bg-raise px-4 py-2.5 font-mono text-display tracking-[0.18em] text-bone">
        {code}
      </code>
      <button
        onClick={() => {
          navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        className="text-meta text-mute transition-colors hover:text-text"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * The server writes these messages because only it knows which of several
 * things went wrong. Repeating them verbatim beats a generic line here.
 */
export function Failure({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError ? error.message : "Something went wrong. Try again.";

  return (
    <div className="mt-4 rounded-md border border-line bg-raise px-3.5 py-2.5">
      <p className="text-meta leading-[1.55] text-bone">{message}</p>
    </div>
  );
}

export function Spinner() {
  return (
    <Icon of={LoaderCircle} size={12} className="animate-spin" />
  );
}
