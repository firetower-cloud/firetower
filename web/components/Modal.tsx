"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button, Icon } from "./ui";

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-6 sm:p-10">
      <div className="fixed inset-0 bg-ground/80 backdrop-blur-[3px]" onClick={onClose} />
      <div
        className={`relative my-auto w-full rounded-lg border border-line bg-panel shadow-float ${
          wide ? "max-w-[620px]" : "max-w-[520px]"
        }`}
      >
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <span className="eyebrow">{title}</span>
          <button
            onClick={onClose}
            className="-mr-1 ml-auto rounded-sm p-1 text-mute transition-colors hover:bg-raise hover:text-bone"
            aria-label="Close"
          >
            <Icon of={X} size={14} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* Shared bits used by both connect flows. */

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
