//! Upgrading Firetower from Firetower.
//!
//! The control plane already knows what version everything is: its own from
//! the build, each worker's from the handshake. What it did not know was what
//! the newest release is, and it had no way to move anything — the operator
//! went to the machine for `firetower upgrade`, and to each worker's machine
//! for `firetower worker upgrade`. This module is both of those, from the
//! screen.
//!
//! ## Who does what
//!
//! * **Workers** are recreated by the control plane, over the same ssh path a
//!   connection takes — see [`worker`] for what is run, and [`runner`] for
//!   how. The key never goes anywhere it did not already go.
//! * **The control plane** cannot recreate itself, so an updater container
//!   beside it does — see [`client`] and the `ft-updater` crate. The updater
//!   holds the Docker socket and nothing else: no key, no password, no
//!   database.
//! * **The CLI** on the operator's own machine is out of reach. The most this
//!   can do is say which version a release wants.
//!
//! A run is a row and its steps are rows — see [`store`] — so the process
//! being replaced in the middle of one is the ordinary case, handled in
//! [`runs::resume`].
//!
//! Nothing here is automatic. A check every few hours says what is available;
//! a person starts a run.

pub mod check;
pub mod client;
pub mod deploy;
pub mod runner;
pub mod runs;
pub mod status;
pub mod store;
pub mod version;
pub mod worker;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

/// The one handle the rest of the control plane holds.
#[derive(Clone)]
pub struct Updates {
    pub store: store::Store,
    pub updater: Result<client::Updater, client::Absent>,
    pub feed: check::Feed,
    pub http: reqwest::Client,
    pub notify: crate::notify::Notifier,
    /// Runs this process is driving, so one is never driven twice.
    pub driving: Arc<tokio::sync::Mutex<std::collections::HashSet<String>>>,
}

impl Updates {
    pub fn new(pool: sqlx::PgPool) -> Self {
        let updater = client::Updater::from_env();
        match &updater {
            Ok(_) => tracing::info!(
                "updater configured at {}",
                std::env::var(ft_updater_api::URL_ENV).unwrap_or_default()
            ),
            Err(client::Absent::NotConfigured) => {
                tracing::info!(
                    "no updater on this install; the control plane upgrades workers only"
                )
            }
            Err(client::Absent::NoToken) => tracing::warn!(
                "{} is set but {} is not; the updater will refuse every request",
                ft_updater_api::URL_ENV,
                ft_updater_api::TOKEN_ENV
            ),
        }
        Self {
            store: store::Store::new(pool),
            updater,
            feed: check::Feed::from_env(),
            http: check::client(),
            notify: crate::notify::Notifier::from_env(),
            driving: Default::default(),
        }
    }
}

// ── what the API says ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum RunState {
    Planned,
    WaitingIdle,
    /// Stopped part-way, waiting for somebody to say whether to carry on.
    ///
    /// Only the backup reaches this. An upgrade with no backup is a decision,
    /// and it belongs to the person pressing the button rather than to a step
    /// that failed for its own reasons.
    WaitingDecision,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunState {
    pub fn as_db(self) -> &'static str {
        match self {
            RunState::Planned => "planned",
            RunState::WaitingIdle => "waiting_idle",
            RunState::WaitingDecision => "waiting_decision",
            RunState::Running => "running",
            RunState::Succeeded => "succeeded",
            RunState::Failed => "failed",
            RunState::Cancelled => "cancelled",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        Some(match s {
            "planned" => RunState::Planned,
            "waiting_idle" => RunState::WaitingIdle,
            "waiting_decision" => RunState::WaitingDecision,
            "running" => RunState::Running,
            "succeeded" => RunState::Succeeded,
            "failed" => RunState::Failed,
            "cancelled" => RunState::Cancelled,
            _ => return None,
        })
    }

    pub fn is_over(self) -> bool {
        matches!(
            self,
            RunState::Succeeded | RunState::Failed | RunState::Cancelled
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum StepState {
    Pending,
    Running,
    Done,
    Failed,
    /// Did not do what it was for, and the run goes on anyway.
    ///
    /// A backup that cannot be taken is worth knowing about and worth
    /// recording — the run's history should say it went ahead without one —
    /// but it is not a reason the upgrade cannot happen.
    Warned,
    Skipped,
}

impl StepState {
    pub fn as_db(self) -> &'static str {
        match self {
            StepState::Pending => "pending",
            StepState::Running => "running",
            StepState::Done => "done",
            StepState::Failed => "failed",
            StepState::Warned => "warned",
            StepState::Skipped => "skipped",
        }
    }

    pub fn from_db(s: &str) -> Option<Self> {
        Some(match s {
            "pending" => StepState::Pending,
            "running" => StepState::Running,
            "done" => StepState::Done,
            "failed" => StepState::Failed,
            "warned" => StepState::Warned,
            "skipped" => StepState::Skipped,
            _ => return None,
        })
    }
}

/// The newest release, as far as the last check knows.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub published_at: Option<chrono::DateTime<chrono::Utc>>,
    pub notes_url: Option<String>,
    /// The changelog section for the release, as markdown.
    pub notes: Option<String>,
    /// The least `@firetower/cli` the release wants on the operator's own
    /// machine. Reported; nothing here can install it.
    pub cli_minimum: Option<String>,
}

/// The updater beside the control plane, if there is one.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterView {
    pub configured: bool,
    pub reachable: bool,
    pub version: Option<String>,
    pub api_version: Option<u32>,
    /// Why it cannot be used, in words, when it cannot.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneTarget {
    pub version: String,
    pub upgradable: bool,
    pub reason: Option<String>,
    /// Sessions on this machine, by title. They end when it is recreated.
    pub sessions: Vec<String>,
    pub updater: UpdaterView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    /// A worker container Firetower can recreate — on a server, or here.
    Container,
    /// A `firetower-worker` binary somebody put on a machine. Reported only.
    Binary,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostTarget {
    pub host_id: String,
    pub name: String,
    pub kind: TargetKind,
    pub version: Option<String>,
    pub online: bool,
    pub drained: bool,
    pub upgradable: bool,
    pub reason: Option<String>,
    /// Sessions on this machine, by title. They end when it is recreated.
    pub sessions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: Option<Release>,
    pub checked_at: Option<chrono::DateTime<chrono::Utc>>,
    pub check_error: Option<String>,
    /// Whether anything at all is behind the newest release.
    pub update_available: bool,
    pub control_plane: ControlPlaneTarget,
    pub hosts: Vec<HostTarget>,
    pub active_run: Option<String>,
}

/// What a run would do to the deployment's files, asked before agreeing.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpgradePlan {
    pub version: String,
    pub files: Vec<deploy::FilePlan>,
    /// Variables the release's `.env.example` requires that `.env` lacks.
    pub env_missing: Vec<String>,
    /// Whether the updater itself is behind and will be recreated first.
    pub updater_upgrade: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileChoice {
    pub name: String,
    /// Replace an edited file with the release's copy, keeping the edited one
    /// as `.backup`. Files the release changed and nobody edited are replaced
    /// without being asked.
    pub replace: bool,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewRun {
    /// The release to move to. Has to be the one the last check found.
    pub version: String,
    #[serde(default)]
    pub control_plane: bool,
    #[serde(default)]
    pub host_ids: Vec<String>,
    /// Drain every target and wait until nothing is running on it, rather
    /// than ending what is.
    #[serde(default)]
    pub when_idle: bool,
    /// Acknowledged: sessions on the targets are ended. Required when
    /// `when_idle` is off and anything is running.
    #[serde(default)]
    pub end_sessions: bool,
    #[serde(default)]
    pub files: Vec<FileChoice>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStep {
    pub position: i32,
    pub target: String,
    pub title: String,
    pub state: StepState,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub detail: Option<String>,
    pub log: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRun {
    pub id: String,
    pub from_version: String,
    pub to_version: String,
    pub targets: store::Targets,
    pub when_idle: bool,
    pub state: RunState,
    pub started_by: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
    pub error: Option<String>,
    pub steps: Vec<UpdateStep>,
}

impl UpdateRun {
    pub fn from_store(run: store::Run, steps: Vec<store::Step>) -> Self {
        Self {
            id: run.id,
            from_version: run.from_version,
            to_version: run.to_version,
            targets: run.targets,
            when_idle: run.when_idle,
            state: run.state,
            started_by: run.started_by,
            created_at: run.created_at,
            started_at: run.started_at,
            finished_at: run.finished_at,
            error: run.error,
            steps: steps
                .into_iter()
                .map(|s| UpdateStep {
                    position: s.position,
                    target: s.target,
                    title: s.title,
                    state: s.state,
                    started_at: s.started_at,
                    finished_at: s.finished_at,
                    detail: s.detail,
                    log: s.log,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn states_round_trip_through_the_database() {
        for s in [
            RunState::Planned,
            RunState::WaitingIdle,
            RunState::Running,
            RunState::Succeeded,
            RunState::Failed,
            RunState::Cancelled,
            RunState::WaitingDecision,
        ] {
            assert_eq!(RunState::from_db(s.as_db()), Some(s));
        }
        for s in [
            StepState::Pending,
            StepState::Running,
            StepState::Done,
            StepState::Failed,
            StepState::Warned,
            StepState::Skipped,
        ] {
            assert_eq!(StepState::from_db(s.as_db()), Some(s));
        }
        assert!(RunState::from_db("nonsense").is_none());
    }

    /// A run stopped for an answer has not finished, and the screen has to
    /// keep showing it — there is nowhere else to give the answer.
    #[test]
    fn a_run_waiting_for_an_answer_is_not_over() {
        assert!(!RunState::WaitingDecision.is_over());
    }
}
