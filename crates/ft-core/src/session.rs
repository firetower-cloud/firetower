//! Sessions and the workspaces they run on.

use crate::{Agent, HostId, RepoId, SessionId, SessionStatus, WorkspaceId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A line of work with a conversation attached and a branch at the end.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: SessionId,
    /// `None` for a bare agent: a workspace with nothing checked out.
    pub repo: Option<String>,
    /// Short, derived from the prompt — the prompt itself lives in the transcript.
    pub title: String,
    pub prompt: String,
    /// Absent along with the repository — there is nothing to branch.
    pub branch: Option<String>,
    pub base: Option<String>,
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
    /// Omit for a bare agent: a workspace with nothing checked out.
    #[serde(default)]
    pub repo_id: Option<RepoId>,
    pub prompt: String,
    #[serde(default = "default_agent")]
    pub agent: Agent,
    /// Omit to let the scheduler choose.
    #[serde(default)]
    pub host_id: Option<HostId>,
    /// The branch to start from. Omit for the repository's default.
    #[serde(default)]
    pub base: Option<String>,
    /// The branch the agent works on. Omit to derive one from the prompt.
    ///
    /// Named by whoever starts the session, because this is what ends up on a
    /// pull request and a machine-written slug is a poor thing to live with.
    #[serde(default)]
    pub branch: Option<String>,
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

/// Make a branch name git will accept, keeping it recognisable.
///
/// Named by a person, so it arrives with spaces, capitals and the occasional
/// stray slash. This keeps the shape they typed and removes what git refuses.
pub fn sanitize_branch(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_dash = false;

    for c in name.trim().chars() {
        let keep = match c {
            'a'..='z' | '0'..='9' | '/' | '_' | '.' => c,
            'A'..='Z' => c.to_ascii_lowercase(),
            _ => '-',
        };
        // git rejects a doubled slash and a run of dashes reads badly
        if keep == '-' || keep == '/' {
            if last_dash {
                continue;
            }
            last_dash = true;
        } else {
            last_dash = false;
        }
        out.push(keep);
    }

    let out = out.trim_matches(['-', '/', '.'].as_slice()).to_string();
    if out.is_empty() {
        "work".to_string()
    } else {
        out
    }
}

/// A directory name for a workspace, from its branch.
///
/// Flat, because worktrees all live side by side and a slash would nest them.
pub fn workspace_name(branch: &str) -> String {
    sanitize_branch(branch).replace('/', "-")
}

#[cfg(test)]
mod naming_tests {
    use super::*;

    #[test]
    fn a_typed_branch_name_keeps_its_shape() {
        assert_eq!(sanitize_branch("Fix retry handling"), "fix-retry-handling");
        assert_eq!(sanitize_branch("feature/payments"), "feature/payments");
        assert_eq!(sanitize_branch("  spaced  out  "), "spaced-out");
    }

    #[test]
    fn what_git_would_refuse_is_removed() {
        // Doubled slashes, leading and trailing punctuation, and characters
        // that are not allowed in a ref at all.
        assert_eq!(sanitize_branch("a//b"), "a/b");
        assert_eq!(sanitize_branch("/leading/"), "leading");
        assert_eq!(sanitize_branch("what?! now"), "what-now");
        assert_eq!(sanitize_branch("   "), "work", "never empty");
    }

    #[test]
    fn a_workspace_is_a_flat_directory() {
        assert_eq!(workspace_name("feature/payments"), "feature-payments");
        assert!(!workspace_name("a/b/c").contains('/'), "must not nest");
    }
}
