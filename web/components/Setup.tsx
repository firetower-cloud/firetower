"use client";

/**
 * Setting up: the two things a fresh install needs from its first
 * administrator, then how to get the app.
 *
 * The password came out of a file, so it is replaced first; the organisation
 * has no name, so it is named second. Each step leaves the rail once it is
 * answered — a reload never asks twice — and the last panel is the same one
 * `/` shows from then on.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mark } from "./Signal";
import { useSetupState, useCompleteSetup } from "@/src/api/generated/setup/setup";
import { StepPassword, StepOrganization } from "./SetupAccount";
import { GetTheApp } from "./GetTheApp";

export function Setup() {
  const router = useRouter();
  const { data: state, isLoading, refetch } = useSetupState();
  const complete = useCompleteSetup();
  const outstanding = [
    state?.needsPassword ? "Password" : null,
    state?.needsOrganization ? "Organisation" : null,
  ].filter(Boolean) as string[];
  const [done, setDone] = useState(false);

  if (isLoading) {
    return (
      <div className="min-h-screen px-8 pt-7">
        <p className="text-ui text-mute">Looking…</p>
      </div>
    );
  }
  // Nothing left to ask, and this is not the moment right after answering:
  // the page has no reason to exist for this install.
  if (outstanding.length === 0 && state?.completed && !done) {
    router.replace("/");
    return null;
  }
  const current = outstanding[0];
  const advance = () => void refetch();
  const finish = () => {
    if (!state?.completed) complete.mutate();
    setDone(true);
  };
  const steps = ["Password", "Organisation", "The app"];
  const at = current === "Password" ? 0 : current === "Organisation" ? 1 : 2;

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-2.5 px-8 pt-7 pb-8">
        <span className="text-bone">
          <Mark size={22} />
        </span>
        <span className="font-narrow text-ui font-semibold tracking-[0.22em] text-bone uppercase">Firetower</span>
      </header>
      <div className="mx-auto max-w-[660px] px-8 pb-24">
        <Rail steps={steps} step={at} />
        <div className="mt-9">
          {current === "Password" && <StepPassword onNext={advance} />}
          {current === "Organisation" && <StepOrganization onNext={advance} />}
          {!current && (
            <>
              <Done onSeen={finish} />
              <GetTheApp />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Marks setting up as finished the moment the last panel is on screen. */
function Done({ onSeen }: { onSeen: () => void }) {
  const [seen, setSeen] = useState(false);
  if (!seen) {
    setSeen(true);
    onSeen();
  }
  return (
    <p className="px-6 text-ui text-sage">Done. This Firetower is yours.</p>
  );
}

function Rail({ steps, step }: { steps: string[]; step: number }) {
  return (
    <div className="flex items-center">
      {steps.map((label, i) => (
        <div key={label} className="flex flex-1 items-center last:flex-none">
          <span className="flex items-center gap-2.5">
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-mono text-meta ${
                i < step ? "bg-sage/20 text-sage" : i === step ? "bg-bone text-ground" : "border border-line text-mute"
              }`}
            >
              {i < step ? "✓" : i + 1}
            </span>
            <span className={`text-ui ${i === step ? "text-bone" : "text-mute"}`}>{label}</span>
          </span>
          {i < steps.length - 1 && <span className="mx-3 h-px flex-1 bg-line" />}
        </div>
      ))}
    </div>
  );
}
