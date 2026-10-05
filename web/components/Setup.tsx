"use client";

/**
 * Setting up, and the one step everybody goes through.
 *
 * Two different visits land here. A fresh install's first administrator has a
 * password that came out of a file and an organisation with no name, and
 * answers both. Anybody else — invited, or whose password an administrator has
 * just reset — has exactly one thing to do, and the organisation is long since
 * named.
 *
 * `completed` is what tells them apart, and it is deliberately not
 * `needsOrganization`: that one goes false halfway through the administrator's
 * own wizard, which would make the rail lose a step while they were standing on
 * it. `completed` holds still from the first visit to the last.
 *
 * **This is the only place in the product where a password is replaced under
 * duress.** The desktop and phone apps do not offer it; they send people here.
 * One screen to get right, on the one surface that is always reachable.
 */
import { useEffect, useRef } from "react";
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
  /* While developing, `?preview=password|organisation|done` draws a step
     without the server having to be in that state, and `&member` draws it as
     somebody who is not setting the install up. Not in a build. */
  const params =
    process.env.NODE_ENV === "development" && typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const preview = params?.get("preview") ?? null;
  const shown = preview === "password" ? ["Password"] : preview === "organisation" ? ["Organisation"] : preview === "done" ? [] : outstanding;

  // Whether this visit is an install being set up, or a person being let in.
  const onboarding = params?.has("member") ? false : !state?.completed;
  const current = shown[0];

  // Nothing left to ask. Mark setting up as finished, then go to the dashboard.
  //
  // This used to draw one more panel, saying where to get the app. But `/` *is*
  // that page — it is the first thing in the rail — so the panel was the same
  // words with the navigation taken away, on the one screen in the product that
  // deliberately has none. People finished setting up and were left somewhere
  // with no way onward and nothing to say they had arrived.
  //
  // Decided in an effect because navigating while rendering is a state change
  // React refuses, and latched because this must happen once: the redirect
  // unmounts nothing fast enough to stop a second pass from firing it again.
  const settled = useRef(false);
  const settling = !preview && !isLoading && !current;
  useEffect(() => {
    if (!settling || settled.current) return;
    settled.current = true;
    void (async () => {
      // Awaited rather than fired and forgotten: this flag is what stops the
      // wizard offering itself again, and leaving before it lands would mean
      // setting up never finished.
      if (onboarding && !state?.completed) {
        await complete.mutateAsync().catch(() => {});
      }
      router.replace("/");
    })();
  }, [settling, onboarding, state?.completed, complete, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen px-8 pt-7">
        <p className="text-ui text-mute">Looking…</p>
      </div>
    );
  }
  if (settling) return null;
  const advance = () => void refetch();
  const steps = onboarding ? ["Password", "Organisation", "The app"] : ["Password", "The app"];
  const at = current === "Password" ? 0 : current === "Organisation" ? 1 : steps.length - 1;

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
          {current === "Password" && <StepPassword fromFile={onboarding} onNext={advance} />}
          {current === "Organisation" && <StepOrganization onNext={advance} />}
          {/* Only `?preview=done` reaches this now: a real visit with nothing
              left to ask has already gone to the dashboard. */}
          {!current && (
            <>
              <p className="px-6 text-ui text-sage">
                {onboarding
                  ? "Done. This Firetower is yours."
                  : "Your password is set. Sign in with it from here on."}
              </p>
              <GetTheApp />
            </>
          )}
        </div>
      </div>
    </div>
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
