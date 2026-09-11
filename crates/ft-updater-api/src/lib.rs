//! What the control plane and the updater say to each other.
//!
//! One crate, compiled into both binaries, the way `ft-proto` is the one
//! definition of the frames between the control plane and a worker. A field
//! renamed here is a compile error on both sides rather than a runtime
//! surprise in the one component whose job is to replace the other.
//!
//! ## Who talks to whom
//!
//! Only the control plane calls. The updater answers, does what it was asked in
//! the background, and is asked how it went — it never dials the control plane,
//! never holds a credential for it, and never decides on its own that anything
//! should change. A job it accepted keeps running after the control plane goes
//! away, which is the ordinary case: the job is usually the one that takes the
//! control plane down.
//!
//! ## Versioning
//!
//! [`API_VERSION`] moves when a request or response changes shape in a way an
//! older peer could not read. The updater is recreated first in every run, so
//! the rule to keep is that **an updater accepts requests from a control plane
//! one release older** — the one direction that is exercised.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// The shape of this contract. See the module header for the rule it carries.
pub const API_VERSION: u32 = 1;

/// The header a request carries its credential in.
pub const TOKEN_HEADER: &str = "authorization";

/// The variable both sides read the shared token from.
///
/// The same name on both sides on purpose: `firetower install` writes one line
/// into `.env`, and Compose hands it to both containers.
pub const TOKEN_ENV: &str = "FIRETOWER_UPDATER_TOKEN";

/// Where the control plane finds the updater. Set by the compose file; unset
/// means there is no updater on this install.
pub const URL_ENV: &str = "FIRETOWER_UPDATER_URL";

/// The port the updater listens on, inside the compose network. Never
/// published.
pub const PORT: u16 = 4410;

/// What the updater is, and what it is standing on.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The updater's own release.
    pub version: String,
    pub api_version: u32,
    /// The compose project the updater found itself in.
    pub project: String,
    /// Where that project's files live on the machine. What the helper container
    /// mounts to run Compose against them.
    pub deploy_dir: String,
    /// The compose files, as Compose recorded them on the updater's container.
    pub config_files: Vec<String>,
    pub docker_version: String,
    /// The job in progress, if one is.
    pub busy: Option<JobId>,
}

/// The deployment's own files, as they are on the machine.
///
/// Contents for the files an upgrade may rewrite; only the *names* of what is
/// in `.env`, whose values never leave the machine.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeployFiles {
    pub files: Vec<DeployFile>,
    pub env_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeployFile {
    pub name: String,
    /// Absent when the file is not there.
    pub content: Option<String>,
}

/// A file to write before recreating the control plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    pub name: String,
    pub content: String,
}

/// What the updater is asked to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobKind {
    /// `pg_dump` the database into `backups/` beside the compose file.
    #[serde(rename_all = "camelCase")]
    Backup {
        /// Named into the file, so a directory of dumps says which release each
        /// came from.
        from_version: String,
    },
    /// Pull the updater's own next image and have Compose recreate it.
    ///
    /// The job outlives the process that accepted it: the recreate is done by
    /// a helper container, so the reply the control plane gets is the new
    /// updater's status rather than this job's outcome.
    #[serde(rename_all = "camelCase")]
    UpgradeUpdater { version: String },
    /// Pull the control plane's next image, rewrite the files the release
    /// changed, have Compose recreate the service, and wait for it to answer.
    ///
    /// Put back the previous image if it does not.
    #[serde(rename_all = "camelCase")]
    UpgradeControlPlane {
        version: String,
        #[serde(default)]
        files: Vec<FileWrite>,
    },
}

impl JobKind {
    pub fn label(&self) -> &'static str {
        match self {
            JobKind::Backup { .. } => "backup",
            JobKind::UpgradeUpdater { .. } => "upgrade the updater",
            JobKind::UpgradeControlPlane { .. } => "upgrade the control plane",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewJob {
    pub kind: JobKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
pub struct JobId(pub String);

impl std::fmt::Display for JobId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    /// It went wrong and the previous image was put back.
    RolledBack,
}

impl JobState {
    pub fn is_over(self) -> bool {
        matches!(
            self,
            JobState::Done | JobState::Failed | JobState::RolledBack
        )
    }
}

/// One thing a job did, in order.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobStep {
    pub name: String,
    pub state: JobState,
    /// One line, for a screen.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,
    pub state: JobState,
    pub steps: Vec<JobStep>,
    /// What was run and what it said, redacted, bounded.
    pub log: Vec<String>,
    pub error: Option<String>,
    /// The image the service was on before, by id. What a rollback puts back.
    pub previous_image: Option<String>,
    /// The image it is on now, by id.
    pub image: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// Every failure the updater answers with.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tag is what the other side switches on; a rename here is the kind
    /// of change API_VERSION exists for.
    #[test]
    fn a_job_kind_is_tagged_by_its_name() {
        let json = serde_json::to_value(JobKind::UpgradeControlPlane {
            version: "0.31.0".into(),
            files: vec![],
        })
        .unwrap();
        assert_eq!(json["kind"], "upgradeControlPlane");
        assert_eq!(json["version"], "0.31.0");
        // Fields are camelCase like everything else that crosses HTTP here.
        let backup = serde_json::to_value(JobKind::Backup {
            from_version: "0.30.1".into(),
        })
        .unwrap();
        assert_eq!(backup["fromVersion"], "0.30.1");

        // An older control plane that sends no `files` is still understood.
        let old: JobKind =
            serde_json::from_str(r#"{"kind":"upgradeControlPlane","version":"0.31.0"}"#).unwrap();
        assert!(matches!(old, JobKind::UpgradeControlPlane { files, .. } if files.is_empty()));
    }

    #[test]
    fn a_job_that_is_over_says_so() {
        assert!(JobState::Done.is_over());
        assert!(JobState::RolledBack.is_over());
        assert!(!JobState::Running.is_over());
    }
}
