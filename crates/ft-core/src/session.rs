//! Sessions and the workspaces they run on.

use crate::{Agent, HostId, RepoId, SessionId, SessionStatus, WorkspaceId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A line of work with a conversation attached and a branch at the end.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: SessionId,
    pub repo: String,
    /// Short, derived from the prompt — the prompt itself lives in the transcript.
    pub title: String,
    pub prompt: String,
    pub branch: String,
    pub base: String,
    pub agent: Agent,
    pub size: WorkspaceSize,
    pub status: SessionStatus,
    pub host_id: HostId,
    pub workspace_id: Option<WorkspaceId>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// What the API accepts to launch one.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    pub repo_id: RepoId,
    pub prompt: String,
    #[serde(default = "default_agent")]
    pub agent: Agent,
    /// Omit to let the scheduler choose.
    #[serde(default)]
    pub host_id: Option<HostId>,
    #[serde(default)]
    pub size: WorkspaceSize,
}

fn default_agent() -> Agent {
    Agent::ClaudeCode
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
pub enum WorkspaceSize {
    Small,
    #[default]
    Medium,
    Large,
}

impl WorkspaceSize {
    /// (cpus, memory in MB)
    pub fn resources(&self) -> (u32, u64) {
        match self {
            Self::Small => (1, 2048),
            Self::Medium => (2, 4096),
            Self::Large => (4, 8192),
        }
    }
}

/// Where a session's work physically happens.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: WorkspaceId,
    pub session_id: SessionId,
    pub host_id: HostId,
    /// Absolute path to the worktree on the host.
    pub path: String,
    pub tmux_session: String,
    pub size: WorkspaceSize,
}

/// Derive a branch-safe slug from what the user typed.
///
/// Firetower names the branch; naming branches is a chore and the prompt already
/// says what the work is.
pub fn slugify(prompt: &str) -> String {
    const SKIP: &[&str] = &[
        "the", "a", "an", "for", "to", "in", "and", "of", "on", "with",
    ];

    let slug: Vec<String> = prompt
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|w| !SKIP.contains(w))
        .take(4)
        .map(|w| w.to_string())
        .collect();

    if slug.is_empty() {
        "session".to_string()
    } else {
        slug.join("-")
    }
}

/// A short human title, from the same derivation as the branch.
pub fn title_from(prompt: &str) -> String {
    let slug = slugify(prompt).replace('-', " ");
    let mut chars = slug.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => slug,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_drops_filler_and_punctuation() {
        assert_eq!(
            slugify("Fix retry handling for the Stripe webhooks!"),
            "fix-retry-handling-stripe"
        );
    }

    #[test]
    fn slug_survives_a_prompt_with_nothing_usable() {
        assert_eq!(slugify("!!!"), "session");
        assert_eq!(slugify(""), "session");
        assert_eq!(slugify("the a an of"), "session");
    }

    #[test]
    fn slug_is_branch_safe() {
        let s = slugify("Add `retry` support — with 5 attempts (max)");
        assert!(
            s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "{s}"
        );
    }

    #[test]
    fn title_reads_like_a_sentence() {
        assert_eq!(
            title_from("fix retry handling for stripe webhooks"),
            "Fix retry handling stripe"
        );
    }

    #[test]
    fn sizes_map_to_resources() {
        assert_eq!(WorkspaceSize::Medium.resources(), (2, 4096));
        assert_eq!(WorkspaceSize::default(), WorkspaceSize::Medium);
    }
}
