//! Work that starts itself.
//!
//! A schedule is a durable authorization to start an agent with nobody
//! present. The row says what was approved; it cannot say whether that is
//! still true, so nothing is trusted from it except what was approved — see
//! `schedules::launch`'s gate, which re-reads every permission immediately
//! before the vault is touched.
//!
//! The types here are what the API hands a client. Three of them are worth
//! reading before changing anything.
//!
//! **A run outlives its workspace.** `reclaim.rs` deletes a workspace within a
//! minute of its last session ending, so [`ScheduleRun::summary`] is a copy
//! and [`ScheduleRun::session_id`] is the link *while there is one*. A history
//! built from sessions would evaporate.
//!
//! **No counter is stored.** [`Schedule::streak`] is computed on every read
//! from the run history, which is append-only and therefore cannot drift from
//! itself. It is what lets the page say the exact shape of a pause without a
//! vocabulary being frozen in a column.
//!
//! **No cap, anywhere.** There is no `keepAtMost` and no per-person
//! equivalent. What bounds the pile of kept workspaces is the disk floor on
//! the launch path; [`Schedule::workspaces_kept`] is what makes it legible.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::{RepoId, ScheduleId, ScheduleRunId, SessionId, TriggerId};

/// How often a schedule runs, as the person expressed it.
///
/// Kept beside the cron expression it compiles to rather than derived back out
/// of it: "every weekday at 08:30" and `30 8 * * 1-5` are the same instruction,
/// and only one of them is a control an edit form can redraw. Reversing a cron
/// expression into a cadence is guesswork that gets it wrong for the
/// expressions a person wrote by hand.
///
/// **No client parses cron.** The server compiles this, computes the next
/// three fire times and writes the plain-English read-back, so there is one
/// cron implementation in the product rather than two that disagree about
/// daylight saving in March.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Cadence {
    /// Every day at `at`, which is `HH:MM` on a 24-hour clock.
    ///
    /// A string rather than two integers because it is what the control sends
    /// and what the row renders, and because "07:00" survives a round trip
    /// through JSON without a leading zero going missing.
    Daily { at: String },
    /// Monday to Friday.
    Weekdays { at: String },
    /// One day a week.
    Weekly { at: String, day: Weekday },
    /// One day a month, by date or by weekday.
    Monthly { at: String, on: MonthlyOn },
    /// A cron expression, written by hand.
    ///
    /// Five fields, the form everybody writes. Validated on write, and refused
    /// when it would fire more often than every fifteen minutes.
    Custom { expr: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Weekday {
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
    Sunday,
}

impl Weekday {
    /// Cron's own numbering, where Sunday is 0.
    pub fn cron(self) -> u8 {
        match self {
            Self::Sunday => 0,
            Self::Monday => 1,
            Self::Tuesday => 2,
            Self::Wednesday => 3,
            Self::Thursday => 4,
            Self::Friday => 5,
            Self::Saturday => 6,
        }
    }
}

/// Which day of the month, for a monthly cadence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MonthlyOn {
    /// The 1st, the 15th, the last.
    Day { day: u8 },
    /// The first Monday, the third Friday.
    Nth { nth: u8, day: Weekday },
}

/// What kind of thing starts a run.
///
/// A cron is the only one that exists. The others are the stated future, and
/// they are in this enum rather than in a comment because
/// `schedule_runs.source` records which kind fired a run and the history has
/// to be able to say so about a kind this build does not have yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TriggerKind {
    Cron,
}

/// One trigger, with everything the row needs to render it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: TriggerId,
    pub kind: TriggerKind,
    pub cadence: Cadence,
    /// An IANA name, never an offset: an offset is wrong twice a year.
    pub timezone: String,
    pub enabled: bool,
    /// The compiled expression, for somebody who wants to see it.
    pub expr: String,
    /// What the cadence means, in words. Written by the server — see
    /// [`Cadence`].
    pub reads: String,
    /// The next three, computed by the server. Empty when the schedule is off
    /// or the trigger is disabled: there is no next run to name.
    #[serde(default)]
    pub next_fires: Vec<chrono::DateTime<chrono::Utc>>,
    pub next_fire_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Which rule stopped a schedule.
///
/// **The rule, and nothing else.** Not a composed sentence and not a tally:
/// the streak is the leading part of the history the page already draws, so it
/// counts the failures and the questions itself and says the exact shape —
/// including the mixed case, which no single rule name covers. A sentence
/// stored here would be a second copy of that, free to disagree with it.
///
/// Null — `None` — is a person. "You paused this" and "this gave up" have to
/// read differently, and the absence is the cheapest way to tell them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PausedReason {
    /// The streak held three failures.
    ThreeFailures,
    /// The streak held five counted runs of any kind.
    FiveRuns,
    /// A second observation of one run that would not finish.
    Overran,
    /// The owner's account was disabled. Not really a pause — the schedule has
    /// nobody to run as.
    OwnerDisabled,
}

/// The streak, counted off the run history at read time.
///
/// **Derived, never stored.** A column would have had three writers and would
/// have needed a backfill, all to cache an answer an append-only table already
/// holds. This is what lets one rule read three ways: `five_runs` is neither
/// *kept failing* nor *kept needing you*, and the page says which by counting.
///
/// Zero everywhere is a schedule with nothing against it, which is the
/// ordinary case and is what a healthy schedule reports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Streak {
    /// Runs that joined the streak, of any kind.
    pub counted: u32,
    /// Of those, the ones that count as a failure — `failed`, for a reason
    /// other than a machine that could not be reached.
    pub failures: u32,
    /// Of those, the ones that stopped to ask.
    pub questions: u32,
    /// Runs that joined without being either: a machine that could not be
    /// reached says nothing about the schedule's health, so it contributes to
    /// the five and not to the three.
    pub unreachable: u32,
}

/// What a run is, and how it ended.
///
/// Eight states rather than three, because "nothing was started" is several
/// different sentences and a person reads the sentence rather than the word.
///
/// **Not `RunState`.** `updates::RunState` already owns that name in the
/// contract, and two schemas of one name there means the second quietly
/// becomes the first — the generated clients would have typed a schedule's
/// run with an upgrade's states and nothing would have said so.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleRunState {
    /// Taken, not yet launched.
    Claimed,
    /// A session exists.
    Running,
    /// It ended; see [`ScheduleRun::outcome`].
    Finished,
    /// The previous run was still going.
    Skipped,
    /// A gate said no. Nothing was started and no secret was read.
    Refused,
    /// The launch or the run broke.
    Failed,
    /// The control plane was not running when this was due, and nothing is
    /// ever run late.
    Missed,
    /// The control plane died mid-launch.
    Lost,
}

impl ScheduleRunState {
    /// Whether nothing follows this.
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Claimed | Self::Running)
    }
}

/// How a finished run ended.
///
/// **Four, not three.** `Unknown` is "could not tell": classifying a run needs
/// a live round trip to the machine, and one that went away after the run
/// finished cannot be asked. The workspace is kept either way — that is the
/// right action — but the history line must not claim it was kept *because*
/// something was uncommitted, which would be a guess stated as a fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Every checkout committed and pushed, and there was at least one.
    Clean,
    /// Something was left behind, so the workspace stands.
    Kept,
    /// It stopped to ask and nobody answered inside the window.
    NeedsYou,
    /// It was still working at `max_runtime`. Never stopped — recorded.
    Overran,
    /// The machine could not be asked what the run left.
    Unknown,
}

/// What started a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunSource {
    /// A trigger fired. Only these are considered by the pause rule.
    Cron,
    /// Somebody pressed Run now. **Ignored by the pause rule entirely**,
    /// whatever its outcome: you pressed it and you are there.
    Manual,
}

/// One occurrence, and what became of it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: ScheduleRunId,
    pub schedule_id: ScheduleId,
    /// Which occurrence this is.
    pub fire_at: chrono::DateTime<chrono::Utc>,
    /// Which approved revision ran. "Why did it do that" is asked after the
    /// schedule has been changed, so the answer has to be on the run.
    pub revision: i32,
    pub state: ScheduleRunState,
    pub outcome: Option<Outcome>,
    pub source: RunSource,
    /// The sentence a person reads. Written once.
    pub detail: Option<String>,
    /// The agent's own summary, copied before the workspace was torn down.
    pub summary: Option<String>,
    /// The workspace, while there is one to open.
    pub session_id: Option<SessionId>,
    /// Whether this run is still holding a workspace.
    ///
    /// A real field rather than `session_id.is_some()`: that goes null the
    /// moment `reclaim` purges a deleted run, so a count reading it would
    /// quietly fall to zero exactly as the real number climbed.
    pub workspace_kept: bool,
    /// Where it ran. Copied, so the history can still say so after the machine
    /// has been retired.
    pub host_name: Option<String>,
    /// The `ErrorCode`, verbatim, when a launch failed or was refused.
    pub error_code: Option<String>,
    pub launched_at: Option<chrono::DateTime<chrono::Utc>>,
    pub ended_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Who wrote a schedule.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    /// `false` for a person.
    pub by_agent: bool,
    /// The person, or the profile the agent was running as.
    pub who: String,
    /// The conversation that asked for it, when an agent did. Copied text, not
    /// a link that `reclaim` will empty.
    pub from_session_id: Option<String>,
    pub from_workspace_name: Option<String>,
    pub at: chrono::DateTime<chrono::Utc>,
}

/// A schedule, as a client reads it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: ScheduleId,
    pub name: String,
    /// What it asks for.
    pub prompt: String,
    /// Which repository, if any. A schedule with none is a bare agent, and
    /// several things about it are different — see `deleteCleanRuns`.
    pub repo_id: Option<RepoId>,
    pub repo_slug: Option<String>,
    pub base: Option<String>,
    /// Whether it is on. Off and `pausedReason: null` is a person's doing.
    pub active: bool,
    pub paused_reason: Option<PausedReason>,
    /// Null until a person turns it on. The whole of "an agent may propose but
    /// not activate".
    pub approved_at: Option<chrono::DateTime<chrono::Utc>>,
    pub revision: i32,
    pub triggers: Vec<Trigger>,
    /// Whether a clean run's workspace is deleted.
    ///
    /// Always false, and not offered as a control, when there is no
    /// repository: `session_work` answers an empty list for a workspace with
    /// nothing checked out, so "nothing uncommitted" is vacuously true and a
    /// clean-run rule would read a bare workspace as the safe case and delete
    /// every file the agent made.
    pub delete_clean_runs: bool,
    /// How many of this schedule's runs are still holding a workspace.
    ///
    /// Drawn in both switch states. With no cap this is the only thing that
    /// says whether somebody's machines are filling.
    pub workspaces_kept: u32,
    pub streak: Streak,
    pub runs_total: u32,
    pub last_run: Option<ScheduleRun>,
    pub made: Provenance,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
