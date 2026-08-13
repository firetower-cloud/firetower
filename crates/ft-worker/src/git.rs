//! Mirrors and worktrees.
//!
//! Each host keeps one bare mirror per repository and cuts a worktree per
//! session from it. The first session on a repository pays for the clone; every
//! session after gets a worktree in well under a second, which is what makes
//! launching feel free.

use crate::askpass::Askpass;
use anyhow::{bail, Context, Result};
use ft_proto::{Credential, ProbeFailure, RemoteInfo};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// A remote that answers slowly is indistinguishable from one that never will,
/// and someone is watching a spinner. Give up and say so.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Where a host keeps its git state.
#[derive(Debug, Clone)]
pub struct GitRoot {
    mirrors: PathBuf,
    worktrees: PathBuf,
}

impl GitRoot {
    pub fn new(base: impl AsRef<Path>) -> Self {
        let base = base.as_ref();
        Self {
            mirrors: base.join("repos"),
            worktrees: base.join("worktrees"),
        }
    }

    /// `github.com-acme-backend.git` — flat, collision-free, and readable when
    /// you're looking at the directory wondering what's on disk.
    fn mirror_path(&self, slug: &str) -> PathBuf {
        let flat: String = slug
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '.' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        self.mirrors.join(format!("{flat}.git"))
    }

    pub fn worktree_path(&self, session_id: &str) -> PathBuf {
        self.worktrees.join(session_id)
    }

    /// Can we reach this repository, and what is its default branch?
    ///
    /// `ls-remote` answers both in one round trip without cloning, which is what
    /// makes it usable while someone is still looking at the form. Reading the
    /// branch here is also how a repository whose trunk isn't called `main`
    /// stops being broken by an assumption.
    pub async fn probe(
        &self,
        remote: &str,
        credential: Option<Credential>,
    ) -> Result<RemoteInfo, ProbeFailure> {
        let env = cred_env(credential).await.map_err(|e| {
            tracing::error!("preparing credentials: {e:#}");
            ProbeFailure::Unreachable
        })?;

        let args = ["ls-remote", "--symref", remote, "HEAD"];
        let probe = run_env(Path::new("."), "git", &args, &env.vars);

        let output = match tokio::time::timeout(PROBE_TIMEOUT, probe).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => return Err(classify(&format!("{e:#}"))),
            Err(_) => return Err(ProbeFailure::Unreachable),
        };

        // ref: refs/heads/trunk\tHEAD
        // 5f3a…\tHEAD
        let default_branch = output
            .lines()
            .find_map(|l| l.strip_prefix("ref: refs/heads/"))
            .and_then(|l| l.split_whitespace().next())
            .unwrap_or("main")
            .to_string();

        Ok(RemoteInfo {
            default_branch,
            // No object lines means no commits, so there is nothing to branch
            // from — worth saying now rather than failing during the clone.
            empty: !output
                .lines()
                .any(|l| !l.starts_with("ref:") && !l.trim().is_empty()),
        })
    }

    /// Clone the mirror if it's cold, fetch if it's warm.
    ///
    /// Returns the mirror path and whether it had to clone, so the caller can
    /// say "fetched from the mirror" versus "cloned" in the event log.
    pub async fn ensure_mirror(
        &self,
        remote: &str,
        slug: &str,
        credential: Option<Credential>,
    ) -> Result<(PathBuf, bool)> {
        let path = self.mirror_path(slug);
        let env = cred_env(credential).await?;

        if path.join("HEAD").exists() {
            run_env(
                &self.mirrors,
                "git",
                &[
                    "--git-dir",
                    path.to_str().unwrap(),
                    "fetch",
                    "--all",
                    "--prune",
                ],
                &env.vars,
            )
            .await
            .with_context(|| format!("fetching {slug}"))?;
            return Ok((path, false));
        }

        tokio::fs::create_dir_all(&self.mirrors)
            .await
            .with_context(|| format!("creating {}", self.mirrors.display()))?;

        // `--mirror` rather than `--bare`: a bare clone records no fetch
        // refspec, so every later `fetch` is a no-op and the mirror silently
        // freezes at the moment it was cloned. Sessions would then branch from
        // whatever was true the first time anyone used the repository, which
        // surfaces days later as a baffling conflict rather than an error.
        run_env(
            &self.mirrors,
            "git",
            &["clone", "--mirror", remote, path.to_str().unwrap()],
            &env.vars,
        )
        .await
        .with_context(|| format!("cloning {remote}"))?;

        Ok((path, true))
    }

    /// Cut a worktree on a new branch from `base`.
    ///
    /// Two sessions started from the same prompt want the same branch name, so
    /// the first one gets it and the rest are numbered. Keeping the clean name
    /// for the common case matters: this is what shows up on the pull request.
    ///
    /// Returns the path and the branch actually used.
    pub async fn add_worktree(
        &self,
        mirror: &Path,
        branch: &str,
        base: &str,
        session_id: &str,
    ) -> Result<(PathBuf, String)> {
        let dest = self.worktree_path(session_id);
        tokio::fs::create_dir_all(&self.worktrees).await?;

        if dest.exists() {
            bail!("a worktree already exists at {}", dest.display());
        }

        let mut last_error = None;
        for attempt in 1..=20u32 {
            let candidate = if attempt == 1 {
                branch.to_string()
            } else {
                format!("{branch}-{attempt}")
            };

            match run(
                &self.worktrees,
                "git",
                &[
                    "--git-dir",
                    mirror.to_str().unwrap(),
                    "worktree",
                    "add",
                    "-b",
                    &candidate,
                    dest.to_str().unwrap(),
                    base,
                ],
            )
            .await
            {
                Ok(_) => return Ok((dest, candidate)),
                Err(e) => {
                    let taken = e.to_string().contains("already exists");
                    if !taken {
                        return Err(e)
                            .with_context(|| format!("creating worktree {candidate} from {base}"));
                    }
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap())
            .with_context(|| format!("every name from {branch} onwards was taken"))
    }

    /// Remove a worktree and forget it. Safe to call when it's already gone.
    pub async fn remove_worktree(&self, mirror: &Path, session_id: &str) -> Result<()> {
        let dest = self.worktree_path(session_id);
        if !dest.exists() {
            return Ok(());
        }
        run(
            &self.worktrees,
            "git",
            &[
                "--git-dir",
                mirror.to_str().unwrap(),
                "worktree",
                "remove",
                "--force",
                dest.to_str().unwrap(),
            ],
        )
        .await?;
        Ok(())
    }

    /// The unified diff of the work so far.
    ///
    /// Computed here rather than on the control plane: less traffic, and it
    /// works when the laptop has no clone of the repository at all.
    pub async fn diff(&self, session_id: &str, base: &str) -> Result<String> {
        let dest = self.worktree_path(session_id);
        let out = run(&dest, "git", &["diff", &format!("{base}...HEAD")]).await?;
        let unstaged = run(&dest, "git", &["diff"]).await?;
        Ok(format!("{out}{unstaged}"))
    }
}

/// Run a command, capturing stdout and turning a non-zero exit into an error
/// that carries stderr — otherwise every git failure looks the same.
async fn run(cwd: &Path, program: &str, args: &[&str]) -> Result<String> {
    run_env(cwd, program, args, &[]).await
}

/// Whatever a git invocation needs in its environment, plus the credential
/// server that has to outlive the command.
struct CredEnv {
    vars: Vec<(String, String)>,
    _serving: Option<Askpass>,
}

/// Stand up a credential server if there is a credential, and describe how git
/// should reach it. With no credential this is just the settings that stop git
/// from blocking on a prompt nobody can answer.
async fn cred_env(credential: Option<Credential>) -> Result<CredEnv> {
    let mut vars = vec![
        ("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()),
        // ssh has its own way of hanging on a passphrase. This is the same
        // instruction in ssh's language.
        (
            "GIT_SSH_COMMAND".to_string(),
            "ssh -oBatchMode=yes".to_string(),
        ),
    ];

    let Some(credential) = credential else {
        return Ok(CredEnv {
            vars,
            _serving: None,
        });
    };

    let helper = std::env::current_exe().context("locating this binary for git to call back")?;
    let serving = Askpass::start(credential).await?;
    vars.extend(serving.env(&helper));

    Ok(CredEnv {
        vars,
        _serving: Some(serving),
    })
}

async fn run_env(
    cwd: &Path,
    program: &str,
    args: &[&str],
    env: &[(String, String)],
) -> Result<String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(if cwd.exists() { cwd } else { Path::new(".") });
    for (k, v) in env {
        command.env(k, v);
    }

    let output = command
        .output()
        .await
        .with_context(|| format!("running {program}"))?;

    if !output.status.success() {
        bail!(
            "{program} {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Turn git's stderr into something the interface can act on.
///
/// Note that a private repository you have no access to and one that does not
/// exist are deliberately indistinguishable to an unauthenticated caller, so
/// "not found" is reported as denied — telling someone to check their access is
/// right far more often than telling them they typed the name wrong.
fn classify(stderr: &str) -> ProbeFailure {
    let e = stderr.to_ascii_lowercase();

    if e.contains("no such file or directory") && e.contains("git") && e.contains("running git") {
        return ProbeFailure::GitMissing;
    }
    if e.contains("authentication failed")
        || e.contains("could not read username")
        || e.contains("permission denied")
        || e.contains("access denied")
        || e.contains("repository not found")
        || e.contains("403")
        || e.contains("401")
    {
        return ProbeFailure::Denied;
    }
    if e.contains("could not resolve host")
        || e.contains("connection refused")
        || e.contains("connection timed out")
        || e.contains("network is unreachable")
        || e.contains("no such file or directory")
    {
        return ProbeFailure::Unreachable;
    }
    if e.contains("does not appear to be a git repository") || e.contains("not a git repository") {
        return ProbeFailure::NotARepository;
    }

    ProbeFailure::Unreachable
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn a_warm_mirror_actually_picks_up_new_commits() {
        let (origin_dir, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());

        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        let before = run(&mirror, "git", &["rev-parse", "main"]).await.unwrap();

        // someone pushes
        let origin_path = origin_dir.path();
        tokio::fs::write(origin_path.join("second.txt"), "more\n")
            .await
            .unwrap();
        run(origin_path, "git", &["add", "."]).await.unwrap();
        run(origin_path, "git", &["commit", "-m", "second"])
            .await
            .unwrap();

        let (mirror, cloned) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        assert!(!cloned, "the second call should fetch, not clone");

        let after = run(&mirror, "git", &["rev-parse", "main"]).await.unwrap();
        assert_ne!(
            before, after,
            "a mirror that never moves means every session branches from stale work"
        );
    }

    #[tokio::test]
    async fn probing_reads_the_real_default_branch() {
        let (_origin, remote) = origin_on_branch("trunk").await;
        let dir = TempDir::new().unwrap();
        let git = GitRoot::new(dir.path());

        let info = git.probe(&remote, None).await.unwrap();
        assert_eq!(info.default_branch, "trunk", "assuming main is the bug");
        assert!(!info.empty);
    }

    #[tokio::test]
    async fn probing_something_that_is_not_a_repository_says_which_it_is() {
        let dir = TempDir::new().unwrap();
        let git = GitRoot::new(dir.path());

        let failure = git.probe("/definitely/not/a/repo", None).await.unwrap_err();
        assert_eq!(failure, ProbeFailure::NotARepository);
    }

    #[tokio::test]
    async fn probing_a_host_that_does_not_exist_does_not_hang() {
        let dir = TempDir::new().unwrap();
        let git = GitRoot::new(dir.path());

        // No credential and no terminal, so git must fail rather than sit
        // waiting for a password nobody can type.
        let failure = git
            .probe("https://firetower.invalid/acme/backend.git", None)
            .await
            .unwrap_err();
        assert_eq!(failure, ProbeFailure::Unreachable);
    }

    #[tokio::test]
    async fn an_empty_repository_is_reported_as_empty_not_broken() {
        let dir = TempDir::new().unwrap();
        let bare = dir.path().join("empty.git");
        tokio::process::Command::new("git")
            .args([
                "init",
                "--bare",
                "--initial-branch=main",
                bare.to_str().unwrap(),
            ])
            .output()
            .await
            .unwrap();

        let git = GitRoot::new(dir.path());
        let info = git.probe(bare.to_str().unwrap(), None).await.unwrap();
        assert!(
            info.empty,
            "a repository with no commits has nothing to branch from"
        );
    }

    #[test]
    fn a_private_repository_reads_as_denied_not_missing() {
        // Hosts hide private repositories behind "not found" so that names
        // can't be enumerated. Telling someone to check access is the more
        // useful of the two readings.
        assert_eq!(
            classify("remote: Repository not found."),
            ProbeFailure::Denied
        );
        assert_eq!(
            classify("fatal: Authentication failed for 'https://x/'"),
            ProbeFailure::Denied
        );
        assert_eq!(
            classify("ssh: Could not resolve hostname nope"),
            ProbeFailure::Unreachable
        );
    }

    /// A real repository with one commit on `main`, to clone from.
    async fn origin() -> (TempDir, String) {
        origin_on_branch("main").await
    }

    async fn origin_on_branch(branch: &str) -> (TempDir, String) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().to_path_buf();

        run(
            &path,
            "git",
            &["init", &format!("--initial-branch={branch}"), "."],
        )
        .await
        .unwrap();
        run(
            &path,
            "git",
            &["config", "user.email", "test@firetower.dev"],
        )
        .await
        .unwrap();
        run(&path, "git", &["config", "user.name", "Test"])
            .await
            .unwrap();
        tokio::fs::write(path.join("README.md"), "# fixture\n")
            .await
            .unwrap();
        run(&path, "git", &["add", "."]).await.unwrap();
        run(&path, "git", &["commit", "-m", "first"]).await.unwrap();

        let remote = path.to_str().unwrap().to_string();
        (dir, remote)
    }

    #[tokio::test]
    async fn the_first_session_clones_and_the_next_one_fetches() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());

        let (path, cloned) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        assert!(cloned, "a cold mirror has to clone");
        assert!(path.join("HEAD").exists());

        let (again, cloned) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        assert!(!cloned, "a warm mirror fetches instead");
        assert_eq!(path, again);
    }

    #[tokio::test]
    async fn a_slug_becomes_a_readable_directory() {
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let path = git.mirror_path("acme/backend");
        assert_eq!(path.file_name().unwrap(), "acme-backend.git");
    }

    #[tokio::test]
    async fn a_worktree_is_cut_on_its_own_branch() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());

        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        let (tree, branch_used) = git
            .add_worktree(&mirror, "agent/fix-retries", "main", "s_test")
            .await
            .unwrap();
        assert_eq!(branch_used, "agent/fix-retries");

        assert!(
            tree.join("README.md").exists(),
            "the worktree has the repo in it"
        );

        let branch = run(&tree, "git", &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .unwrap();
        assert_eq!(branch.trim(), "agent/fix-retries");
    }

    #[tokio::test]
    async fn two_sessions_get_independent_worktrees() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();

        let (a, _) = git
            .add_worktree(&mirror, "agent/one", "main", "s_one")
            .await
            .unwrap();
        let (b, _) = git
            .add_worktree(&mirror, "agent/two", "main", "s_two")
            .await
            .unwrap();

        assert_ne!(a, b);
        tokio::fs::write(a.join("only-in-a.txt"), "x")
            .await
            .unwrap();
        assert!(
            !b.join("only-in-a.txt").exists(),
            "worktrees must not share a checkout"
        );
    }

    #[tokio::test]
    async fn a_second_session_on_the_same_prompt_gets_a_numbered_branch() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();

        let (_, first) = git
            .add_worktree(&mirror, "agent/retries", "main", "s_one")
            .await
            .unwrap();
        let (_, second) = git
            .add_worktree(&mirror, "agent/retries", "main", "s_two")
            .await
            .unwrap();

        assert_eq!(
            first, "agent/retries",
            "the first session keeps the clean name"
        );
        assert_eq!(second, "agent/retries-2");
    }

    #[tokio::test]
    async fn removing_a_worktree_is_safe_to_repeat() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        git.add_worktree(&mirror, "agent/gone", "main", "s_gone")
            .await
            .unwrap();

        git.remove_worktree(&mirror, "s_gone").await.unwrap();
        assert!(!git.worktree_path("s_gone").exists());
        // destroying a session twice shouldn't be an error
        git.remove_worktree(&mirror, "s_gone").await.unwrap();
    }

    #[tokio::test]
    async fn a_failing_git_command_says_why() {
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let err = git
            .ensure_mirror("/definitely/not/a/repo", "acme/nope", None)
            .await
            .unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("cloning"), "{msg}");
    }

    #[tokio::test]
    async fn diff_reports_work_in_progress() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None)
            .await
            .unwrap();
        let (tree, _) = git
            .add_worktree(&mirror, "agent/edit", "main", "s_diff")
            .await
            .unwrap();

        assert_eq!(
            git.diff("s_diff", "main").await.unwrap(),
            "",
            "nothing changed yet"
        );

        tokio::fs::write(tree.join("README.md"), "# fixture\nedited\n")
            .await
            .unwrap();
        let diff = git.diff("s_diff", "main").await.unwrap();
        assert!(diff.contains("+edited"), "{diff}");
    }
}
