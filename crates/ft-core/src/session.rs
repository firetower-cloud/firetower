//! Sessions and the workspaces they run on.

use crate::{Agent, HostId, RepoId, SessionId, SessionStatus, WorkspaceId};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One repository checked out into a session's workspace.
///
/// A session used to be one of these, spread across three nullable columns on
/// the session itself. It is a list now, because the work is often two
/// repositories — a client and the API it calls — and two sessions that cannot
/// see each other is not an answer to that.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Checkout {
    /// Absent when the repository has since been disconnected. The slug is what
    /// this checkout *is*, and that does not stop being true.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<RepoId>,
    /// `acme/backend`
    pub slug: String,
    /// The branch it was cut from.
    pub base: String,
    /// The branch git actually made.
    ///
    /// Not always the one asked for: the same prompt twice wants the same
    /// name, and git numbers the second. Per checkout because git may number
    /// differently in each repository.
    pub branch: String,
    /// Where it sits inside the workspace.
    ///
    /// Empty means the checkout *is* the workspace — how every session made
    /// before a session could hold more than one is laid out on disk. Those
    /// directories are not moving.
    #[serde(default)]
    pub path: String,
    /// Why it is not there, when it is not.
    ///
    /// A repository the host could not reach fails its own checkout rather than
    /// the session: two of three is still a session worth having, and saying
    /// which one is missing beats pretending it was never asked for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trouble: Option<String>,
    /// Where this repository's pull request went, once it has one.
    ///
    /// Per repository, because that is what a git host can represent: one
    /// change across two repositories is two pull requests that point at each
    /// other, not one object spanning both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<String>,
}

impl Checkout {
    /// What to call the directory it lives in, for anything showing a path.
    pub fn dir(&self) -> &str {
        if self.path.is_empty() {
            "."
        } else {
            &self.path
        }
    }

    /// Whether it is actually on disk.
    pub fn ready(&self) -> bool {
        self.trouble.is_none()
    }
}

/// The directory name a repository gets inside a workspace.
///
/// The last part of the slug, so `acme/backend` becomes `backend` — that is
/// what somebody would call it, and it is what a path in a message should say.
/// Two repositories with the same last part get the owner as well, which the
/// caller resolves by passing what it has already used.
pub fn checkout_dir(slug: &str, taken: &[String]) -> String {
    let leaf = slug.rsplit('/').next().unwrap_or(slug);
    let safe = |name: &str| -> String {
        name.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect()
    };

    let first = safe(leaf);
    if !taken.contains(&first) {
        return first;
    }

    // `acme-backend`, rather than a number nobody can read.
    let whole = safe(&slug.replace('/', "-"));
    if !taken.contains(&whole) {
        return whole;
    }
    for n in 2..1000 {
        let candidate = format!("{first}-{n}");
        if !taken.contains(&candidate) {
            return candidate;
        }
    }
    first
}

/// A line of work with a conversation attached and a branch at the end.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: SessionId,
    /// Assigned once, never reused, and the same for as long as the session
    /// exists. What `name` is derived from, and what a name that has been
    /// changed can always be traced back to.
    pub number: i64,
    /// What to call it. `Agent 3` until somebody says otherwise.
    ///
    /// Separate from `title`, which is cut from the prompt and describes the
    /// work. This one identifies the session, which is a different job: five
    /// sessions on one repository all called "Ask me…" are impossible to tell
    /// apart, and renaming one of them to "the flaky test" fixes that.
    pub name: String,
    /// The first checkout's slug, or `None` for a bare agent.
    ///
    /// A convenience for the places that want one name — a row in a list, a
    /// caption. [`Session::checkouts`] is what is actually true.
    pub repo: Option<String>,
    /// Short, derived from the prompt — the prompt itself lives in the transcript.
    pub title: String,
    pub prompt: String,
    /// The first checkout's branch, or `None` for a bare agent.
    ///
    /// Every checkout in a session is cut with the same requested name, so this
    /// is the right thing to show once — but git may have numbered them
    /// differently, so anything acting on a branch reads it from the checkout.
    pub branch: Option<String>,
    pub base: Option<String>,
    /// Every repository checked out into this session's workspace.
    ///
    /// Empty for a bare agent. One for most sessions. The whole point of the
    /// list is the third case.
    #[serde(default)]
    pub checkouts: Vec<Checkout>,
    pub agent: Agent,
    pub size: WorkspaceSize,
    pub status: SessionStatus,
    /// Why it is in that status, when whatever set it knew.
    ///
    /// Only ever the agent's own words, and only for the statuses that mean
    /// your move. Cleared when it goes back to working — a question that has
    /// been answered is not worth keeping on screen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// When it was removed from here without the machine being told.
    ///
    /// Set only by a forced removal: the host was not answering, so nobody
    /// could tear the workspace down. The session is `Ended` here from that
    /// moment, and the agent may well still be running there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forgotten_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Where the pull request is, once one has been opened.
    ///
    /// Remembered so a screen can tell "pushed" from "already open" without
    /// asking GitHub, which is what lets one control name the next step rather
    /// than offering every verb at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<String>,
    /// What the agent proposed calling this work, when it finished.
    ///
    /// A draft to edit rather than a box to fill. Nothing acts on it: it is
    /// what the review sheet starts with, and whoever is shipping decides what
    /// it actually says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_body: Option<String>,
    pub host_id: HostId,
    pub workspace_id: Option<WorkspaceId>,
    /// What this session is going to do, in order, decided when it was created.
    ///
    /// Here rather than inferred from events so the screen has something to
    /// show before the worker has said a word — the difference between "this
    /// is fetching a repository" and a blank page.
    #[serde(default)]
    pub steps: Vec<crate::Step>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// What the API accepts to launch one.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    /// Omit for a bare agent: a workspace with nothing checked out.
    ///
    /// Kept alongside `repos` so that anything holding one repository still
    /// works; when both are given, this one goes first.
    #[serde(default)]
    pub repo_id: Option<RepoId>,
    /// Every repository to check out, in the order they should appear.
    ///
    /// Each may name its own base branch; the working branch is the session's
    /// and is the same in all of them, which is what makes a change across two
    /// repositories reviewable.
    #[serde(default)]
    pub repos: Vec<NewCheckout>,
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

/// One repository to check out, as the API accepts it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewCheckout {
    pub repo_id: RepoId,
    /// The branch to start from. Omit for the repository's own default.
    #[serde(default)]
    pub base: Option<String>,
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
    fn a_checkout_is_called_what_somebody_would_call_it() {
        // The last part of the slug: that is the name in conversation, and it
        // is what a path in a message should say.
        assert_eq!(checkout_dir("acme/backend", &[]), "backend");
        assert_eq!(
            checkout_dir("kevinpiac/sandbox-firetower", &[]),
            "sandbox-firetower"
        );
    }

    #[test]
    fn two_repositories_with_the_same_name_are_told_apart() {
        // `acme/api` and `globex/api` are both "api". The owner disambiguates,
        // rather than a number nobody can read.
        let taken = vec!["api".to_string()];
        assert_eq!(checkout_dir("globex/api", &taken), "globex-api");

        let taken = vec!["api".to_string(), "globex-api".to_string()];
        assert_eq!(checkout_dir("globex/api", &taken), "api-2");
    }

    #[test]
    fn a_slug_cannot_become_a_path() {
        // It comes from a git host, so it is treated as text rather than as a
        // path: this is the one place a bad one would write outside the
        // workspace it was meant for.
        assert!(!checkout_dir("acme/../../etc", &[]).contains("..'"));
        assert!(!checkout_dir("acme/../../etc", &[]).contains('/'));
    }

    #[test]
    fn a_checkout_that_is_the_workspace_still_has_a_directory_to_name() {
        let c = Checkout {
            repo_id: None,
            slug: "acme/backend".into(),
            base: "main".into(),
            branch: "agent/fix".into(),
            path: String::new(),
            trouble: None,
            pull_request: None,
        };
        // Every session made before a session could hold more than one is laid
        // out this way, and something still has to draw it.
        assert_eq!(c.dir(), ".");
        assert!(c.ready());
    }

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
