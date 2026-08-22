"use client";

import { useEffect } from "react";

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
      <div
        className="fixed inset-0 bg-[#070605]/80 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        className={`panel relative my-auto w-full ${wide ? "max-w-[620px]" : "max-w-[520px]"} shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)]`}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span className="eyebrow">{title}</span>
          <button
            onClick={onClose}
            className="ml-auto text-[14px] text-mute transition-colors hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/* Shared bits used by both connect flows. */

export function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1 rounded-[6px] border border-line bg-ground p-1">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className={`flex-1 rounded-[4px] px-3 py-1.5 text-[12.5px] transition-colors ${
            value === o ? "bg-raise text-bone" : "text-mute hover:text-text"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

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
      className={`flex w-full items-start gap-3 rounded-[6px] border px-3.5 py-2.5 text-left transition-colors ${
        on ? "border-ember/40 bg-ember/[0.04]" : "border-line hover:border-[#3a3631]"
      }`}
    >
      <span
        className={`mt-[3px] flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border ${
          on ? "border-ember" : "border-line"
        }`}
      >
        {on && <span className="h-[5px] w-[5px] rounded-full bg-ember" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] text-bone">{title}</span>
          {tag && (
            <span className="font-narrow text-[9.5px] font-semibold tracking-[0.12em] text-mute uppercase">
              {tag}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-[12px] leading-[1.5] text-dim">{body}</span>
      </span>
    </button>
  );
}

export function Command({ text }: { text: string }) {
  return (
    <code className="block rounded-[5px] border border-line bg-ground px-3 py-2 font-mono text-[12.5px] text-bone">
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
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-[5px] bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
    >
      {children}
    </button>
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
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-[12.5px] text-mute transition-colors hover:text-text disabled:opacity-40 disabled:hover:text-mute"
    >
      {children}
    </button>
  );
}
