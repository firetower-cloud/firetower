"use client";

import { useEffect, useRef, useState } from "react";

/* Handing a tool root on your own box deserves a visible log, not a spinner. */
const BOOTSTRAP = [
  "ssh root@203.0.113.44 — connected",
  "detecting distro… Debian 12 (bookworm)",
  "installing docker… already present, 27.1.1",
  "creating user firetower (uid 1101)",
  "writing /etc/firetower/worker.toml",
  "issuing worker certificate… fingerprint 4a:9c:1e:77",
  "installing firetowerd 0.3.1 → /usr/local/bin",
  "systemctl enable --now firetowerd",
  "worker dialled home — fire-04 is online",
];

export function AddHost() {
  const [step, setStep] = useState<"idle" | "form" | "log" | "done">("idle");
  const [n, setN] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (step !== "log") return;
    if (n >= BOOTSTRAP.length) {
      const t = setTimeout(() => setStep("done"), 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setN((v) => v + 1), 420);
    return () => clearTimeout(t);
  }, [step, n]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: 9999 });
  }, [n]);

  if (step === "idle") {
    return (
      <button
        onClick={() => setStep("form")}
        className="mt-4 w-full rounded-[6px] border border-dashed border-line py-3 text-[13px] text-mute transition-colors hover:border-ember/40 hover:text-ember"
      >
        + Add a host
      </button>
    );
  }

  return (
    <div className="panel mt-4 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Add a host</span>
        <span className="ml-auto font-mono text-[11px] text-mute">
          {step === "form" ? "1 of 2 · credentials" : "2 of 2 · bootstrap"}
        </span>
      </div>

      {step === "form" && (
        <div className="flex flex-col gap-3 p-4">
          <Field label="Address" value="203.0.113.44" />
          <Field label="SSH user" value="root" />
          <Field label="SSH key" value="~/.ssh/id_ed25519" mono />
          <div className="mt-1 flex items-center gap-2">
            <button
              onClick={() => setStep("log")}
              className="rounded-[5px] bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a0c04]"
            >
              Install firetowerd
            </button>
            <button
              onClick={() => setStep("idle")}
              className="rounded-[5px] border border-line px-3 py-1.5 text-[12.5px] text-mute hover:text-text"
            >
              Cancel
            </button>
            <span className="ml-auto text-[11.5px] text-mute">
              The key is used once and never stored.
            </span>
          </div>
        </div>
      )}

      {(step === "log" || step === "done") && (
        <>
          <div
            ref={logRef}
            className="max-h-[190px] overflow-y-auto bg-[#0a0908] px-4 py-3 font-mono text-[11.5px] leading-[1.8]"
          >
            {BOOTSTRAP.slice(0, n).map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-sage">✓</span>
                <span className={i === n - 1 ? "text-bone" : "text-mute"}>{l}</span>
              </div>
            ))}
            {step === "log" && (
              <span className="caret inline-block h-[13px] w-[6px] bg-dim align-middle" />
            )}
          </div>

          {step === "done" && (
            <div className="flex items-center gap-3 border-t border-line px-4 py-3">
              <span className="h-2 w-2 rounded-full bg-sage" />
              <span className="text-[13px] text-bone">fire-04 is online and taking work.</span>
              <button
                onClick={() => {
                  setStep("idle");
                  setN(0);
                }}
                className="ml-auto rounded-[5px] border border-line px-3 py-1 text-[12px] text-mute hover:text-text"
              >
                Done
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <label className="grid grid-cols-[110px_1fr] items-center gap-3">
      <span className="eyebrow">{label}</span>
      <input
        defaultValue={value}
        className={`rounded-[5px] border border-line bg-ground px-2.5 py-1.5 text-[13px] text-bone focus:border-ember focus:outline-none ${
          mono ? "font-mono text-[12px]" : ""
        }`}
      />
    </label>
  );
}
