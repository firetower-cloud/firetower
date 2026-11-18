/**
 * The specimen plans the review is built and photographed against.
 *
 * **Generated, not written.** `import-plans.json` is produced by
 * `crates/ft-server/src/roles/import.rs`'s `specimens` tests, which build the
 * drops, run the real planner over them and write what it returns. That test
 * also asserts the committed file is current, so a wording change in Rust
 * fails `cargo test` on all three platforms until the fixture and its
 * screenshots are brought along.
 *
 * The first version of this file held the sentences instead, read off the
 * server by hand. Every one of them was wrong — plausible, well-edited, and
 * never printed by the product — and a hundred and twenty assertions passed
 * over them because each checked shape rather than words. A constant
 * transcribed into the other language is not a source of truth. It is a second
 * place to drift, and this one drifted before it was ever committed.
 *
 * Nothing in the product imports this: it is read by the tests beside it and
 * by the dev harness at `/review.html`.
 */
import type { ImportPlan } from "~/api/generated/model";
import specimens from "./import-plans.json";

/** Every specimen, by the name the harness and the shoot script use. */
export const PLANS = specimens.plans as unknown as Record<string, ImportPlan>;

/**
 * A drop past a bound, as the sentence the person is shown.
 *
 * **Not a plan.** `plan()` returns `Err(Refused)` and the API turns it into an
 * `InvalidRequest`, so a review is never handed one — the refusal belongs to
 * whatever made the call, and the screen draws it in place of a list.
 */
export const REFUSALS = specimens.refusals as Record<string, string>;

export type PlanName = keyof typeof specimens.plans;

/** The names, in the order the evidence walks them. */
export const PLAN_NAMES = Object.keys(PLANS) as PlanName[];
