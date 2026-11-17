/**
 * The profile import review, one specimen plan at a time.
 *
 * Not a mock of the screen — **the screen**, imported, handed an `ImportPlan`
 * from `import-plans.ts`. The drop that produces a real one and the apply that
 * spends it are #358, so without this there is no way to look at the review at
 * all, let alone at the states that matter: a drop of twenty-three, a file that
 * never parsed, a drop refused for its size.
 *
 * The address is the state: `/review.html#mixed`, `#all-blocked`, `#large`.
 * `shoot-import-review.mjs` drives exactly these, so the pictures and the
 * assertions are of the same thing the tests are about.
 *
 * Dev only. Vite serves it; it is not a build entry, so it cannot reach a
 * production bundle — the same arrangement as `demo.html`.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CandidateDecision } from "~/api/generated/model";
import { ImportProfiles } from "~/ui/config/ImportProfiles";
import { PLANS, type PlanName } from "~/ui/config/import-plans";
import "~/theme";
import "~/styles.css";

const names = Object.keys(PLANS) as PlanName[];
const asked = window.location.hash.replace(/^#/, "") as PlanName;
const first: PlanName = names.includes(asked) ? asked : "mixed";

function Harness() {
  const [name, setName] = useState<PlanName>(first);
  const [applying, setApplying] = useState(false);

  /* The plan the page is drawing, published for the shoot script — so "rows
     are in file order" is checked against the order the plan declares rather
     than against a guess about what that order looks like. The same move
     `shoot-proto.mjs` makes: read the table out of the document. */
  (window as unknown as { __PLAN__: unknown }).__PLAN__ = PLANS[name];

  /* Answering a candidate re-plans in the product (#358 posts the answer back
     in `ProfileDrop.answers`). Here the answered plan is a second specimen, so
     the diff a chosen row gains is the server's rather than this page's
     guess at one. */
  const replan = (_key: string, answer: CandidateDecision) => {
    if (name === "near-match" && answer.kind === "sameProfile") setName("near-match-answered");
  };

  /* The window is the app and nothing scrolls but the panes inside it, so the
     harness makes a pane of its own — `Configuration.tsx`'s, verbatim. Without
     it the sticky foot has no scrolling ancestor to stick to, and the one
     thing the foot exists for is being on screen while you scroll a list of
     twenty-three. */
  return (
    <div className="flex h-full flex-col bg-panel">
      <div
        data-harness="bar"
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-ground px-3 py-2"
      >
        {names.map((n) => (
          <button key={n} className="fp" aria-pressed={name === n} onClick={() => setName(n)}>
            {n}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        {/* The rail's 62px, as a spacer. The app's own breakpoint keys off the
            window and not the pane, so a narrow shot is only true if the
            window is 880 *and* the content has 818 to live in. Without this the
            narrow pictures would be 62px kinder than the app. */}
        <div data-harness="rail" className="w-[62px] shrink-0 border-r border-line-soft bg-panel" />
        <div className="scroll-slim flex h-full min-h-0 flex-1 flex-col overflow-y-auto">
      <ImportProfiles
        key={name}
        plan={PLANS[name]}
        applying={applying}
        onClose={() => setApplying(false)}
        onApply={() => {
          setApplying(true);
          window.setTimeout(() => setApplying(false), 1200);
        }}
        onAnswer={replan}
      />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
