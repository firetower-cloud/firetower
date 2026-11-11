//! When a schedule stops itself.
//!
//! **The rule, stated once.** After every run that reaches a terminal state,
//! recompute the schedule's streak and pause the schedule if either bound is
//! met. The streak is the run of consecutive *counted* runs, newest first,
//! stopping at the first run that resets it. Only runs started by a trigger
//! are considered — a run somebody started by hand with Run now is ignored
//! entirely, whatever its outcome.
//!
//! Every terminal run is exactly one of three things:
//!
//! - **Resets** — the run completed: `finished` with outcome `clean`, `kept`
//!   or `unknown`. The streak ends here and is empty.
//! - **Transparent** — `refused`, `missed`, `skipped`, `lost`, and `finished`
//!   with outcome `overran`. Stepped over: it neither joins the streak nor
//!   ends it. A run still `claimed` or `running` is transparent for the same
//!   reason — it has no outcome yet.
//! - **Joins** — everything else, which is `failed` and `finished` with
//!   outcome `needs_you`. Of these, a run counts as a **failure** only if it
//!   is `failed` *and* its `error_code` is not `HostUnreachable`.
//!
//! **Pause when the streak contains three failures, or five runs of any
//! kind.**
//!
//! Which gives: three failures pauses; five questions pauses; two failures and
//! three questions pauses on the fifth. A mixed streak is bounded by the
//! weaker of the two rather than being unreachable, which is the failure mode
//! of the obvious alternative — two independent counters would never trip on
//! `failed, needs_you, failed, needs_you, …`.
//!
//! ## Three categories, not two
//!
//! A two-way split quietly turns every not-counted row into a reset, and a
//! full disk would then launder two failures into none. `failed, failed,
//! refused, failed` is three failures.
//!
//! ## There is no unreachable-machine exception
//!
//! There used to be one, raising three to five for a machine that was off.
//! Under two bounds it falls out: an unreachable failure joins the streak
//! without counting toward the three, so it is bounded only by the five —
//! which is exactly what the exception bought. Five shut laptops pause a
//! schedule and three do not, and there is no branch anywhere in this file for
//! `HostUnreachable` beyond the failure predicate.
//!
//! ## It fails toward leaving a schedule running
//!
//! The window is the last [`WINDOW`] runs. A truncated window can only hide
//! older rows, which could only have added to the streak, so it under-counts —
//! and under-counting means not pausing. The case that truncates it is a
//! schedule nothing has been allowed to run for six weeks, where not pausing
//! is the right answer anyway: there is nothing to conclude about a schedule
//! that has not been given a chance to fail.

use ft_core::schedule::{Outcome, PausedReason, ScheduleRunState, Streak};

/// Three failures pauses a schedule.
pub const FAILURES: u32 = 3;

/// Five counted runs of any kind pauses a schedule.
///
/// More than [`FAILURES`] because the two causes have different remedies and a
/// question is less alarming than a failure: a failure means the run did not
/// work, while a question means it worked right up to the one thing it could
/// not decide. Three of those is not yet evidence that the schedule is the
/// wrong shape; five is.
pub const COUNTED: u32 = 5;

/// How many runs to read.
///
/// The read has to see at most [`COUNTED`] counted runs plus whatever
/// transparent rows are interleaved among them. Fifty leaves room for
/// forty-five transparent rows between them — on a daily schedule, a month and
/// a half of unbroken refusals or missed occurrences before the window can no
/// longer see the whole streak.
pub const WINDOW: i64 = 50;

/// One run, as the rule reads it.
///
/// Three fields, and `detail` is deliberately not among them: it is prose
/// written for a person, which is never a predicate.
#[derive(Debug, Clone, Copy)]
pub struct Counted<'a> {
    pub state: ScheduleRunState,
    pub outcome: Option<Outcome>,
    pub error_code: Option<&'a str>,
}

/// What a run does to the streak.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Does {
    /// It completed. The streak ends here and is empty.
    Reset,
    /// Nothing was attempted, or nothing can yet be concluded.
    StepOver,
    /// It was attempted and did not finish the work.
    Join {
        /// Whether it says something about the schedule's health.
        failure: bool,
        /// Whether it stopped to ask.
        question: bool,
    },
}

/// The `ErrorCode` whose failures say nothing about a schedule.
///
/// Matched against the column as stored, which is the variant name verbatim —
/// see `schedules::error_code`. A laptop that is shut is not a broken
/// schedule.
const UNREACHABLE: &str = "HostUnreachable";

/// Which of the three a run is.
pub fn does(run: Counted<'_>) -> Does {
    match (run.state, run.outcome) {
        // Completed, whatever became of its workspace. **Not the clean
        // disposition alone**: a run that finished and kept its workspace
        // because it left work uncommitted still completed, and so did one
        // nobody could classify. Reading this as `clean` only would pause a
        // schedule doing useful work every other night, because `kept` is the
        // dominant population — it is what the feature is for.
        (ScheduleRunState::Finished, Some(Outcome::Clean | Outcome::Kept | Outcome::Unknown)) => {
            Does::Reset
        }
        // It stopped to ask and nobody answered inside the window. Joins
        // without being a failure: the run did its work and stopped at the one
        // thing it could not decide.
        (ScheduleRunState::Finished, Some(Outcome::NeedsYou)) => Does::Join {
            failure: false,
            question: true,
        },
        // Attempted and broken. A failure unless the machine could not be
        // reached, which is the whole of the unreachable rule.
        (ScheduleRunState::Failed, _) => Does::Join {
            failure: run.error_code != Some(UNREACHABLE),
            question: false,
        },
        // Nothing was started, or the run has not finished, or it overran —
        // which has its own path to paused and must not be counted twice.
        _ => Does::StepOver,
    }
}

/// The streak, from runs newest first.
///
/// The slice must already be scheduled runs only. A manual run is not
/// transparent — it is not in the list at all, which is what "ignored
/// entirely" means and is why the filter belongs in the query.
pub fn streak(runs: &[Counted<'_>]) -> Streak {
    let mut it = Streak::default();
    for run in runs {
        match does(*run) {
            Does::Reset => break,
            Does::StepOver => continue,
            Does::Join { failure, question } => {
                it.counted += 1;
                if failure {
                    it.failures += 1;
                } else if question {
                    it.questions += 1;
                } else {
                    it.unreachable += 1;
                }
            }
        }
    }
    it
}

/// Which bound a streak has met, if either.
///
/// Failures first, because three is the tighter bound and is therefore the one
/// a live schedule reaches first: the streak is recomputed after every terminal
/// run, so a third failure pauses before a fifth run can accumulate. Checking
/// it first only matters for a window that was read all at once, where it is
/// the answer that would have been given at the time.
pub fn bound_met(streak: &Streak) -> Option<PausedReason> {
    if streak.failures >= FAILURES {
        return Some(PausedReason::ThreeFailures);
    }
    if streak.counted >= COUNTED {
        return Some(PausedReason::FiveRuns);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shorthands, so a streak reads as the sequence it is.
    fn completed() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Finished,
            outcome: Some(Outcome::Clean),
            error_code: None,
        }
    }
    fn kept() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Finished,
            outcome: Some(Outcome::Kept),
            error_code: None,
        }
    }
    fn could_not_tell() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Finished,
            outcome: Some(Outcome::Unknown),
            error_code: None,
        }
    }
    fn failed() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Failed,
            outcome: None,
            error_code: Some("ActionFailed"),
        }
    }
    fn unreachable() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Failed,
            outcome: None,
            error_code: Some("HostUnreachable"),
        }
    }
    fn asked() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Finished,
            outcome: Some(Outcome::NeedsYou),
            error_code: None,
        }
    }
    fn refused() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Refused,
            outcome: None,
            error_code: Some("NoCapacity"),
        }
    }
    fn missed() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Missed,
            outcome: None,
            error_code: None,
        }
    }
    fn skipped() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Skipped,
            outcome: None,
            error_code: None,
        }
    }
    fn lost() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Lost,
            outcome: None,
            error_code: None,
        }
    }
    fn overran() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Finished,
            outcome: Some(Outcome::Overran),
            error_code: None,
        }
    }
    fn working() -> Counted<'static> {
        Counted {
            state: ScheduleRunState::Running,
            outcome: None,
            error_code: None,
        }
    }

    /// Newest first, which is the order the rule reads in.
    fn verdict(newest_first: &[Counted<'_>]) -> Option<PausedReason> {
        bound_met(&streak(newest_first))
    }

    /// **Every terminal run is exactly one of three things.**
    ///
    /// Asserted as a partition rather than case by case, because the bug this
    /// prevents is a two-way split: anything not recognised falling through to
    /// "reset" would let a full disk launder two failures into none.
    #[test]
    fn the_three_categories_partition_every_run() {
        for run in [completed(), kept(), could_not_tell()] {
            assert_eq!(does(run), Does::Reset, "{run:?}");
        }
        for run in [
            refused(),
            missed(),
            skipped(),
            lost(),
            overran(),
            working(),
            Counted {
                state: ScheduleRunState::Claimed,
                outcome: None,
                error_code: None,
            },
        ] {
            assert_eq!(does(run), Does::StepOver, "{run:?}");
        }
        assert_eq!(
            does(failed()),
            Does::Join {
                failure: true,
                question: false
            }
        );
        assert_eq!(
            does(asked()),
            Does::Join {
                failure: false,
                question: true
            }
        );
        assert_eq!(
            does(unreachable()),
            Does::Join {
                failure: false,
                question: false
            },
            "it joins, and it is not a failure"
        );
    }

    /// Criterion 36: the two bounds, each on its own.
    #[test]
    fn three_failures_pauses() {
        assert_eq!(
            verdict(&[failed(), failed(), failed(), completed()]),
            Some(PausedReason::ThreeFailures)
        );
        assert_eq!(verdict(&[failed(), failed(), completed()]), None, "two does not");
    }

    #[test]
    fn five_questions_pauses() {
        assert_eq!(
            verdict(&[asked(), asked(), asked(), asked(), asked(), completed()]),
            Some(PausedReason::FiveRuns)
        );
        assert_eq!(
            verdict(&[asked(), asked(), asked(), asked(), completed()]),
            None,
            "four does not — and three questions must never pause a schedule"
        );
    }

    /// **The mixed streak**, which is the case that explains why there are two
    /// bounds over one streak rather than two counters. Two counters would
    /// never trip this.
    #[test]
    fn two_failures_and_three_questions_pauses_on_the_fifth() {
        // Newest first: ask, ask, fail, ask, fail.
        let streak_of_five = [asked(), asked(), failed(), asked(), failed(), completed()];
        assert_eq!(
            verdict(&streak_of_five),
            Some(PausedReason::FiveRuns),
            "five counted, never three failures"
        );
        let it = streak(&streak_of_five);
        assert_eq!(it.counted, 5);
        assert_eq!(it.failures, 2);
        assert_eq!(it.questions, 3);

        // One short, so it carries on.
        assert_eq!(verdict(&streak_of_five[1..]), None);
    }

    /// Criterion 36a: the unreachable-machine cases, which are where the rule
    /// earns its shape. No special case produces all three.
    #[test]
    fn the_unreachable_machine_cases_fall_out_of_the_general_rule() {
        assert_eq!(
            verdict(&[unreachable(), unreachable(), unreachable()]),
            None,
            "three shut laptops are not a broken schedule"
        );
        assert_eq!(
            verdict(&[
                unreachable(),
                unreachable(),
                unreachable(),
                unreachable(),
                unreachable()
            ]),
            Some(PausedReason::FiveRuns),
            "five are, and this is the old exception reproduced"
        );
        assert_eq!(
            verdict(&[
                failed(),
                failed(),
                failed(),
                unreachable(),
                unreachable(),
                completed()
            ]),
            Some(PausedReason::ThreeFailures),
            "a mixed streak is never inspected for purity: the three bound is met on its own"
        );
        // And the same five rows with only two ordinary failures stop on the
        // fifth rather than on a third that never arrives.
        assert_eq!(
            verdict(&[failed(), failed(), unreachable(), unreachable(), unreachable()]),
            Some(PausedReason::FiveRuns)
        );
    }

    /// Criterion 37, and the reason the middle category exists.
    #[test]
    fn a_month_of_refusals_neither_pauses_a_schedule_nor_absolves_a_broken_one() {
        let mut month: Vec<Counted<'_>> = vec![failed()];
        month.extend(std::iter::repeat_n(refused(), 40));
        month.extend([failed(), failed()]);

        assert_eq!(
            verdict(&month),
            Some(PausedReason::ThreeFailures),
            "stepped over, not reset: a full disk must not launder two failures"
        );

        // And on its own, a run of refusals moves nothing.
        let quiet: Vec<Counted<'_>> = std::iter::repeat_n(refused(), 40).collect();
        assert_eq!(verdict(&quiet), None);
        assert_eq!(streak(&quiet), Streak::default(), "and visibly so");
    }

    /// One completed run clears everything before it.
    #[test]
    fn a_run_that_completed_ends_the_streak() {
        assert_eq!(verdict(&[failed(), completed(), failed(), failed()]), None);
        let it = streak(&[failed(), completed(), failed(), failed()]);
        assert_eq!(it.counted, 1, "only the newest, up to the run that completed");

        // Including the two completions that are not `clean`.
        assert_eq!(verdict(&[failed(), kept(), failed(), failed()]), None);
        assert_eq!(verdict(&[failed(), could_not_tell(), failed(), failed()]), None);
    }

    /// **An overrun has its own path to paused and must not be counted here.**
    ///
    /// The streak counts completed runs; the overrun rule watches one run that
    /// has not completed. Merging them would double-count one incident — a
    /// strike for overrunning, and a second when the same run finally ends
    /// failed.
    #[test]
    fn an_overrun_is_stepped_over_by_the_counter() {
        assert_eq!(
            verdict(&[overran(), overran(), overran(), overran(), overran()]),
            None
        );
    }

    /// Criterion 36b: a truncated window may only fail toward running.
    #[test]
    fn a_window_that_cannot_see_the_whole_streak_does_not_pause() {
        // Fifty transparent rows and nothing else: nothing can be concluded.
        let all_quiet: Vec<Counted<'_>> = std::iter::repeat_n(missed(), WINDOW as usize).collect();
        assert_eq!(verdict(&all_quiet), None);

        // And a window whose oldest rows are cut off under-counts, which is
        // the safe direction.
        let long = [asked(), asked(), asked(), asked()];
        assert_eq!(verdict(&long), None, "four visible of a longer streak");
    }

    /// An empty history is a schedule that has never run.
    #[test]
    fn nothing_against_a_schedule_is_a_streak_of_nought() {
        assert_eq!(streak(&[]), Streak::default());
        assert_eq!(verdict(&[]), None);
    }

    /// The ten streaks the design was checked against, as one table.
    #[test]
    fn the_worked_streaks() {
        let cases: Vec<(&str, Vec<Counted<'_>>, Option<PausedReason>)> = vec![
            ("failure × 3", vec![failed(); 3], Some(PausedReason::ThreeFailures)),
            ("question × 5", vec![asked(); 5], Some(PausedReason::FiveRuns)),
            (
                "failure × 2, question × 3",
                vec![asked(), asked(), asked(), failed(), failed()],
                Some(PausedReason::FiveRuns),
            ),
            ("unreachable × 5", vec![unreachable(); 5], Some(PausedReason::FiveRuns)),
            ("unreachable × 3", vec![unreachable(); 3], None),
            (
                "unreachable × 2, failure × 3",
                vec![failed(), failed(), failed(), unreachable(), unreachable()],
                Some(PausedReason::ThreeFailures),
            ),
            (
                "failure, failure, completed, failure",
                vec![failed(), completed(), failed(), failed()],
                None,
            ),
            (
                "failure × 2, refused × 40, failure",
                {
                    let mut v = vec![failed()];
                    v.extend(std::iter::repeat_n(refused(), 40));
                    v.extend([failed(), failed()]);
                    v
                },
                Some(PausedReason::ThreeFailures),
            ),
            (
                "question × 4",
                vec![asked(); 4],
                None,
            ),
            (
                "overran × 5",
                vec![overran(); 5],
                None,
            ),
        ];

        for (name, runs, want) in cases {
            assert_eq!(verdict(&runs), want, "{name}");
        }
    }
}
