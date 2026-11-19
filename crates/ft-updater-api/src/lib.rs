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
///
/// 2 — the updater reports the image reference each of its containers was
/// created from, and takes a tag to fetch and recreate from. An updater at 1
/// can read both requests, because an unknown field is ignored, but it would
/// pull the tag its container is already on: which is the one thing a channel
/// switch must not do. So the control plane asks this number before it offers
/// to switch, and that is what this number is for.
pub const API_VERSION: u32 = 2;

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
    /// The deployment's own containers, and the image each was created from.
    ///
    /// **This is where an installation's channel is read.** It is the tag on
    /// the control plane's image, and nothing anywhere stores it — a row
    /// saying `beta` beside a compose file saying `:stable` would drift, and
    /// the operator would be shown an error about image versions whose real
    /// cause was a stale setting.
    ///
    /// Empty from an updater older than API version 2, which is absence
    /// rather than an answer: a control plane that cannot be told what it is
    /// running says so instead of assuming.
    #[serde(default)]
    pub images: Vec<ServiceImage>,
}

/// One of the deployment's containers, by the reference it was created from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServiceImage {
    pub role: ImageRole,
    /// The compose service, as the deployment names it.
    pub service: String,
    /// `ghcr.io/firetower-cloud/firetower:stable`, as Compose recorded it on
    /// the container. Opaque here: nothing in the updater reads a meaning out
    /// of the tag.
    pub reference: String,
}

/// Which of the two this is. They are published together and upgraded
/// together, so they can never be on different channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ImageRole {
    ControlPlane,
    Updater,
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
    UpgradeUpdater {
        version: String,
        /// Which tag to fetch the version from. See
        /// [`JobKind::UpgradeControlPlane`]; the same rule, for the container
        /// beside it.
        #[serde(default)]
        tag: Option<String>,
    },
    /// Pull the control plane's next image, rewrite the files the release
    /// changed, have Compose recreate the service, and wait for it to answer.
    ///
    /// Put back the previous image if it does not.
    #[serde(rename_all = "camelCase")]
    UpgradeControlPlane {
        version: String,
        #[serde(default)]
        files: Vec<FileWrite>,
        /// Which tag to fetch the version from, when it is not the tag the
        /// container is already on.
        ///
        /// The compose file is the intent and the container is the fact, and
        /// a channel switch is the moment they differ: the file is being
        /// rewritten to `:beta` in this same job, so the image to pull is
        /// `:beta` and the one the container came from is not. `None` keeps
        /// the old behaviour — fetch the tag the container is on — which is
        /// what every ordinary upgrade still wants.
        ///
        /// Whatever is fetched is still checked against `version` before
        /// anything is recreated, and a rollback still goes back to the tag
        /// the container was created from, so a switch that fails leaves the
        /// installation where it was.
        #[serde(default)]
        tag: Option<String>,
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

// ── reading an image reference ───────────────────────────────────────
//
// Both sides read one: the updater to know what to pull and what to put back,
// the control plane to know which channel an installation is on. One
// implementation, in the crate they share, because two would be two answers
// for a registry with a port in it — and the wrong one would be silent.

/// The tags this project publishes, and what each means.
///
/// All four together, because the one that catches people out is `latest`:
/// it keeps its conventional meaning and is therefore the one somebody pins
/// by mistake.
pub mod tags {
    /// General access — the version a maintainer has promoted. **This is the
    /// tag an installation should be pinned to.**
    pub const STABLE: &str = "stable";
    /// Beta — every release, as soon as it is cut. Moved on every release.
    pub const BETA: &str = "beta";
    /// The newest build published. A convention for whoever pulls by hand,
    /// and not a channel: an installation pinned here follows beta's builds
    /// without having chosen beta.
    pub const LATEST: &str = "latest";
    /// The tip of the trunk. Unreleased, and not a channel either.
    pub const EDGE: &str = "edge";
}

/// Split `repo:tag` — or `repo` alone, which Docker reads as `:latest`.
///
/// The colon that separates a tag is the last one after the last slash, so a
/// registry with a port (`localhost:5000/firetower:latest`) comes apart right.
pub fn split_reference(reference: &str) -> (String, String) {
    let after_slash = reference.rfind('/').map(|i| i + 1).unwrap_or(0);
    match reference[after_slash..].rfind(':') {
        Some(i) => (
            reference[..after_slash + i].to_string(),
            reference[after_slash + i + 1..].to_string(),
        ),
        None => (reference.to_string(), tags::LATEST.to_string()),
    }
}

/// The tag a compose file's `image:` line gives a repository.
///
/// **In this crate because both sides of the contract have to get the same
/// answer.** The control plane reads it to decide which tag to ask the
/// updater to fetch; the updater reads it to decide what Compose will demand
/// of the machine once the file has been rewritten. Two copies of this that
/// disagree are an image pulled under one name and asked for under another,
/// which is #407 — an upgrade that could not complete on any installation.
pub fn image_tag(compose: &str, repository: &str) -> Option<String> {
    compose.lines().find_map(|line| {
        let value = line.trim_start().strip_prefix("image:")?;
        let reference = value.trim().split(" #").next().unwrap_or("").trim();
        let (repo, tag) = split_reference(reference);
        (repo == repository).then_some(tag)
    })
}

/// A full version is a pin; `latest`, `edge`, `stable`, `beta` and
/// `major.minor` all float.
///
/// A pinned container is one the updater refuses to move at all, which is why
/// the control plane has to be able to say so before offering anything.
pub fn is_pinned(tag: &str) -> bool {
    let parts: Vec<&str> = tag.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_comes_apart_at_the_right_colon() {
        assert_eq!(
            split_reference("ghcr.io/firetower-cloud/firetower:latest"),
            ("ghcr.io/firetower-cloud/firetower".into(), "latest".into())
        );
        // The trap: the colon in the registry's port is not the tag's.
        assert_eq!(
            split_reference("localhost:5000/firetower"),
            ("localhost:5000/firetower".into(), "latest".into())
        );
        assert_eq!(
            split_reference("localhost:5000/firetower:0.31.0"),
            ("localhost:5000/firetower".into(), "0.31.0".into())
        );
        // A bare repository with no registry and no tag.
        assert_eq!(
            split_reference("firetower"),
            ("firetower".into(), "latest".into())
        );
        for tag in [tags::STABLE, tags::BETA, tags::EDGE] {
            assert_eq!(
                split_reference(&format!("ghcr.io/firetower-cloud/firetower:{tag}")).1,
                tag
            );
        }
    }

    #[test]
    fn only_a_full_version_pins_a_container() {
        assert!(is_pinned("0.31.0"));
        assert!(!is_pinned(tags::LATEST));
        assert!(!is_pinned(tags::EDGE));
        assert!(!is_pinned(tags::STABLE));
        assert!(!is_pinned(tags::BETA));
        assert!(!is_pinned("0.31"), "a two-part version floats");
        assert!(!is_pinned("v0.31.0"));
    }

    /// The tag is what the other side switches on; a rename here is the kind
    /// of change API_VERSION exists for.
    #[test]
    fn a_job_kind_is_tagged_by_its_name() {
        let json = serde_json::to_value(JobKind::UpgradeControlPlane {
            version: "0.31.0".into(),
            files: vec![],
            tag: None,
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

        // An older control plane that sends no `files` and no `tag` is still
        // understood, and asking for no tag is asking for the one the
        // container is already on.
        let old: JobKind =
            serde_json::from_str(r#"{"kind":"upgradeControlPlane","version":"0.31.0"}"#).unwrap();
        assert!(
            matches!(old, JobKind::UpgradeControlPlane { files, tag, .. } if files.is_empty() && tag.is_none())
        );

        let switching = serde_json::to_value(JobKind::UpgradeControlPlane {
            version: "0.55.0".into(),
            files: vec![],
            tag: Some(tags::BETA.into()),
        })
        .unwrap();
        assert_eq!(switching["tag"], "beta");
    }

    #[test]
    fn a_job_that_is_over_says_so() {
        assert!(JobState::Done.is_over());
        assert!(JobState::RolledBack.is_over());
        assert!(!JobState::Running.is_over());
    }
}
