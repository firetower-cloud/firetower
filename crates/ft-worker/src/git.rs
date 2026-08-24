//! Mirrors and worktrees.
//!
//! Each host keeps one bare mirror per repository and cuts a worktree per
//! session from it. The first session on a repository pays for the clone; every
//! session after gets a worktree in well under a second, which is what makes
//! launching feel free.

use crate::askpass::Askpass;
use anyhow::{bail, Context, Result};
use ft_core::WorkSummary;
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
    pub fn mirror_path(&self, slug: &str) -> PathBuf {
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

    /// Where a named workspace lives.
    pub fn worktree_path(&self, name: &str) -> PathBuf {
        self.worktrees.join(name)
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

        // No `HEAD` argument: naming a ref restricts the output to that ref,
        // and the branch list has to come out of this same call.
        let args = ["ls-remote", "--symref", remote];
        let probe = run_env(Path::new("."), "git", &args, &env.vars);

        let output = match tokio::time::timeout(PROBE_TIMEOUT, probe).await {
            Ok(Ok(out)) => out,
            Ok(Err(e)) => {
                // What git said, kept where someone can read it. The frame
                // carries a category and nothing else, and `Unreachable` is
                // also where everything unrecognised lands — so without this
                // line a failure we have no case for is indistinguishable from
                // a network that is genuinely down.
                let said = format!("{e:#}");
                tracing::warn!(remote, "ls-remote failed: {said}");
                return Err(classify(&said));
            }
            Err(_) => {
                tracing::warn!(remote, "ls-remote gave up after {PROBE_TIMEOUT:?}");
                return Err(ProbeFailure::Unreachable);
            }
        };

        // ref: refs/heads/trunk\tHEAD
        // 5f3a…\tHEAD
        let default_branch = output
            .lines()
            .find_map(|l| l.strip_prefix("ref: refs/heads/"))
            .and_then(|l| l.split_whitespace().next())
            .unwrap_or("main")
            .to_string();

        let mut branches: Vec<String> = output
            .lines()
            .filter_map(|l| l.split_once("\trefs/heads/"))
            .map(|(_, name)| name.trim().to_string())
            .collect();
        branches.sort();
        branches.dedup();

        Ok(RemoteInfo {
            default_branch,
            branches,
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
        progress: Option<Progress<'_>>,
    ) -> Result<(PathBuf, bool)> {
        let path = self.mirror_path(slug);
        let env = cred_env(credential).await?;

        if path.join("HEAD").exists() {
            // Repairs a mirror made by an older build as well as configuring a
            // new one; setting it is idempotent.
            self.set_refspec(&path).await?;
            transferring(
                &self.mirrors,
                &[
                    "--git-dir",
                    path.to_str().unwrap(),
                    "fetch",
                    "--all",
                    "--prune",
                    "--progress",
                ],
                &env.vars,
                progress,
            )
            .await
            .with_context(|| format!("fetching {slug}"))?;
            return Ok((path, false));
        }

        tokio::fs::create_dir_all(&self.mirrors)
            .await
            .with_context(|| format!("creating {}", self.mirrors.display()))?;

        transferring(
            &self.mirrors,
            &[
                "clone",
                "--bare",
                "--progress",
                remote,
                path.to_str().unwrap(),
            ],
            &env.vars,
            progress,
        )
        .await
        .with_context(|| format!("cloning {remote}"))?;

        self.set_refspec(&path).await?;

        // A bare clone puts the remote's branches in `refs/heads/*` and creates
        // no remote-tracking refs at all. One fetch with the refspec now set
        // populates `refs/remotes/origin/*`, so the first session branches from
        // the same place as every session after it.
        transferring(
            &self.mirrors,
            &[
                "--git-dir",
                path.to_str().unwrap(),
                "fetch",
                "--prune",
                "--progress",
                "origin",
            ],
            &env.vars,
            progress,
        )
        .await
        .with_context(|| format!("fetching {slug} after cloning"))?;

        Ok((path, true))
    }

    /// Fetch the remote's branches into `refs/remotes/origin/*`.
    ///
    /// A bare clone configures no refspec at all, so every later fetch is a
    /// no-op and the mirror silently freezes at the moment it was made. The
    /// obvious repair — cloning with `--mirror` — is worse: that maps
    /// `+refs/*:refs/*`, so fetching tries to overwrite local branches, and git
    /// refuses outright as soon as one of them is checked out by a worktree.
    /// One live session would break every session after it.
    ///
    /// The ordinary refspec is the answer. Remote branches land somewhere that
    /// never collides with the branches sessions work on.
    async fn set_refspec(&self, mirror: &Path) -> Result<()> {
        run(
            &self.mirrors,
            "git",
            &[
                "--git-dir",
                mirror.to_str().unwrap(),
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        )
        .await
        .context("configuring the mirror's fetch")?;
        Ok(())
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
        workspace: &str,
    ) -> Result<(PathBuf, String)> {
        let dest = self.worktree_path(workspace);
        self.add_worktree_at(mirror, branch, base, &dest).await
    }

    /// The same, at a path the caller has already decided.
    ///
    /// A workspace holds a checkout per repository now, so where one goes is
    /// the caller's business — and one of them may be the workspace itself, for
    /// a session laid out before that was true.
    pub async fn add_worktree_at(
        &self,
        mirror: &Path,
        branch: &str,
        base: &str,
        dest: &Path,
    ) -> Result<(PathBuf, String)> {
        let dest = dest.to_path_buf();
        tokio::fs::create_dir_all(&self.worktrees).await?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        // Before anything is called taken, drop what only looks taken. A
        // workspace removed by hand — or by a host that died mid-clean-up —
        // leaves an administrative entry behind that git still counts, and
        // pruning it is what turns "everything breaks" into "nothing happened".
        // Best effort: a mirror too old to have a worktree list is not a reason
        // to refuse to make one.
        let _ = run(
            &self.worktrees,
            "git",
            &["--git-dir", mirror.to_str().unwrap(), "worktree", "prune"],
        )
        .await;

        let dest = self.free_path(dest).await?;

        // `origin/main` rather than `main`: the local ref is whatever the clone
        // saw once, while the remote-tracking one is what the last fetch found.
        let remote_base = format!("origin/{base}");
        let base = if run(
            &self.worktrees,
            "git",
            &[
                "--git-dir",
                mirror.to_str().unwrap(),
                "rev-parse",
                "--verify",
                &remote_base,
            ],
        )
        .await
        .is_ok()
        {
            remote_base.as_str()
        } else {
            base
        };

        // What git says is taken, rather than what git says when it refuses.
        // The retry below still reads the error text, because two sessions
        // starting together can both find a name free and only one can have it
        // — but a name that is already taken when we look should never reach
        // that path, and never depends on git's wording or the machine's
        // locale to be recognised.
        let taken = self.branches_in_use(mirror).await;

        let mut last_error = None;
        for attempt in 1..=20u32 {
            let candidate = if attempt == 1 {
                branch.to_string()
            } else {
                format!("{branch}-{attempt}")
            };

            if taken.contains(&candidate) {
                continue;
            }

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
                    if !name_is_taken(&e.to_string()) {
                        return Err(e)
                            .with_context(|| format!("creating worktree {candidate} from {base}"));
                    }
                    last_error = Some(e);
                }
            }
        }

        // `last_error` is absent when every candidate was already taken at the
        // moment we looked, so none of them reached git. Unwrapping it here
        // panicked the worker; saying what happened does not.
        match last_error {
            Some(e) => {
                Err(e).with_context(|| format!("every name from {branch} onwards was taken"))
            }
            None => bail!("every name from {branch} onwards is already taken"),
        }
    }

    /// A directory nothing is in, starting from the one asked for.
    ///
    /// An empty directory is not in the way — the workspace is made before
    /// anything is checked into it, and a checkout that *is* the workspace
    /// would otherwise refuse on the directory holding it.
    ///
    /// One that is genuinely occupied used to end the session. It is numbered
    /// instead, the way a taken branch name is: the caller is told the path it
    /// got, records that, and the session runs.
    async fn free_path(&self, dest: PathBuf) -> Result<PathBuf> {
        for attempt in 1..=20u32 {
            let candidate = if attempt == 1 {
                dest.clone()
            } else {
                let name = dest
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "worktree".to_string());
                dest.with_file_name(format!("{name}-{attempt}"))
            };

            let occupied = match tokio::fs::read_dir(&candidate).await {
                Ok(mut entries) => entries.next_entry().await.ok().flatten().is_some(),
                Err(_) => candidate.exists(),
            };
            if !occupied {
                return Ok(candidate);
            }
        }
        bail!(
            "every directory from {} onwards is already in use",
            dest.display()
        )
    }

    /// Every branch name this mirror cannot hand out again.
    ///
    /// Local branches and the branches its worktrees are on. Empty when git
    /// cannot be asked, which leaves the retry loop to find out the slow way
    /// rather than refusing to start.
    async fn branches_in_use(&self, mirror: &Path) -> std::collections::HashSet<String> {
        let mut taken = std::collections::HashSet::new();

        if let Ok(out) = run(
            &self.worktrees,
            "git",
            &[
                "--git-dir",
                mirror.to_str().unwrap(),
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
            ],
        )
        .await
        {
            taken.extend(
                out.lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty()),
            );
        }

        // A branch checked out by a worktree is refused even where the ref
        // itself would have been free, so both lists matter.
        if let Ok(out) = run(
            &self.worktrees,
            "git",
            &[
                "--git-dir",
                mirror.to_str().unwrap(),
                "worktree",
                "list",
                "--porcelain",
            ],
        )
        .await
        {
            taken.extend(
                out.lines()
                    .filter_map(|l| l.strip_prefix("branch "))
                    .map(|r| r.trim().trim_start_matches("refs/heads/").to_string()),
            );
        }

        taken
    }

    /// Remove a worktree and forget it. Safe to call when it's already gone.
    pub async fn remove_worktree(&self, mirror: &Path, name: &str) -> Result<()> {
        let dest = self.worktree_path(name);
        self.remove_worktree_at(mirror, &dest).await
    }

    /// The same, for a worktree at a path the caller already knows.
    pub async fn remove_worktree_at(&self, mirror: &Path, dest: &Path) -> Result<()> {
        let dest = dest.to_path_buf();
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

    /// What is in the workspace that isn't safely elsewhere yet.
    ///
    /// This is what makes ending a session a decision rather than a gamble:
    /// uncommitted files and unpushed commits are exactly what would be lost.
    pub async fn summary(&self, dest: &Path, branch: &str, base: &str) -> Result<WorkSummary> {
        let dirty = run(dest, "git", &["status", "--porcelain"]).await?;
        let uncommitted = dirty.lines().filter(|l| !l.trim().is_empty()).count() as u32;

        // `@{upstream}` rather than `origin/<branch>`: these worktrees hang off
        // a mirror, where fetched refs live under `refs/heads/*` and there is
        // no `refs/remotes/origin/*` to compare against. The upstream is what
        // the push actually set, so it is what knows.
        let pushed = run(dest, "git", &["rev-parse", "--verify", "@{upstream}"])
            .await
            .is_ok();

        let range = if pushed {
            "@{upstream}..HEAD".to_string()
        } else {
            // Never pushed: everything this session did is at risk.
            format!("{base}..HEAD")
        };

        let ahead = run(dest, "git", &["rev-list", "--count", &range])
            .await
            .ok()
            .and_then(|c| c.trim().parse().ok())
            .unwrap_or(0);

        // Always against the base, whatever the push state. `ahead` stops
        // answering this the moment a branch is pushed, and a pushed branch
        // holding nothing is exactly the case that looked ready to open a pull
        // request from and had nothing to open one for.
        let commits = run(
            dest,
            "git",
            &["rev-list", "--count", &format!("{base}..HEAD")],
        )
        .await
        .ok()
        .and_then(|c| c.trim().parse().ok());

        Ok(WorkSummary {
            branch: branch.to_string(),
            uncommitted,
            ahead,
            pushed,
            commits,
        })
    }

    /// Commit whatever the agent left behind, including new files.
    /// Commit the workspace, or only the paths somebody chose.
    ///
    /// `paths` empty means everything, which is what an unattended session
    /// wants and what this always used to do. A list means exactly those, and
    /// exactly those — anything already staged from an earlier attempt is
    /// unstaged first, or unticking a file in the review sheet would not
    /// actually leave it out.
    ///
    /// Paths are passed after `--`, so a file called `-f` is a file rather than
    /// an argument.
    pub async fn commit(&self, dest: &Path, message: &str, paths: &[String]) -> Result<String> {
        if paths.is_empty() {
            run(dest, "git", &["add", "-A"]).await?;
        } else {
            // Start from nothing staged. A previous run, or the agent itself,
            // may have staged something nobody asked to include.
            run(dest, "git", &["reset"]).await?;
            let mut args = vec!["add", "--"];
            args.extend(paths.iter().map(String::as_str));
            run(dest, "git", &args).await?;
        }

        let staged = run(dest, "git", &["diff", "--cached", "--name-only"]).await?;
        if staged.trim().is_empty() {
            bail!("there is nothing to commit");
        }

        run(dest, "git", &["commit", "-m", message]).await?;
        let count = staged.lines().filter(|l| !l.trim().is_empty()).count();
        Ok(format!(
            "committed {count} {}",
            if count == 1 { "file" } else { "files" }
        ))
    }

    /// Send the branch to the remote, so the work survives the workspace.
    pub async fn push(
        &self,
        dest: &Path,
        branch: &str,
        credential: Option<Credential>,
    ) -> Result<String> {
        let env = cred_env(credential).await?;

        run_env(
            dest,
            "git",
            &["push", "--set-upstream", "origin", branch],
            &env.vars,
        )
        .await
        .with_context(|| format!("pushing {branch}"))?;

        Ok(format!("pushed {branch}"))
    }

    /// The unified diff of the work so far.
    ///
    /// Computed here rather than on the control plane: less traffic, and it
    /// works when the laptop has no clone of the repository at all.
    pub async fn diff(&self, dest: &Path, base: &str) -> Result<String> {
        let out = run(dest, "git", &["diff", &format!("{base}...HEAD")]).await?;
        let unstaged = run(dest, "git", &["diff"]).await?;
        let untracked = self.untracked_diff(dest).await.unwrap_or_default();
        Ok(format!("{out}{unstaged}{untracked}"))
    }

    /// New files, which `git diff` says nothing about until they are tracked.
    ///
    /// An agent's first act is often to create something, and a diff that
    /// silently omits new files is worse than no diff — it looks complete.
    ///
    /// Done by comparing each against nothing rather than with `add -N`, which
    /// would write intent-to-add entries into an index the agent is also using.
    async fn untracked_diff(&self, dest: &Path) -> Result<String> {
        let listed = run(dest, "git", &["ls-files", "--others", "--exclude-standard"]).await?;

        let mut out = String::new();
        for path in listed.lines().map(str::trim).filter(|p| !p.is_empty()) {
            // `--no-index` exits 1 when the files differ, which here is always.
            let shown = Command::new("git")
                .args(["diff", "--no-index", "--", "/dev/null", path])
                .current_dir(dest)
                .output()
                .await;

            if let Ok(shown) = shown {
                out.push_str(&String::from_utf8_lossy(&shown.stdout));
            }
        }
        Ok(out)
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
    let serving = Askpass::start(credential, &helper).await?;
    vars.extend(serving.env());

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
    run_watched(cwd, program, args, env, None).await
}

/// A git command that moves data: retried once when the network drops it, and
/// never allowed to run forever.
///
/// `curl 92`, `early EOF` and `unexpected disconnect` are the network giving up
/// partway through, not the server saying no. They are worth one more attempt —
/// a repository that doesn't exist, or that we can't read, says so the first
/// time and says the same thing every time after, so those are not retried.
async fn transferring(
    cwd: &Path,
    args: &[&str],
    env: &[(String, String)],
    progress: Option<Progress<'_>>,
) -> Result<String> {
    // Generous, because a first clone of a large repository legitimately takes
    // minutes. It exists so that a stalled transfer eventually becomes an error
    // someone can read rather than a session that waits forever.
    const CEILING: std::time::Duration = std::time::Duration::from_secs(30 * 60);

    let mut last = match attempt(cwd, args, env, progress, CEILING).await {
        Ok(out) => return Ok(out),
        Err(e) => e,
    };

    if !is_transient(&last.to_string()) {
        return Err(last);
    }

    if let Some(report) = progress {
        report("the connection dropped — trying once more".to_string());
    }
    tracing::warn!("retrying git after a dropped transfer: {last:#}");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    match attempt(cwd, args, env, progress, CEILING).await {
        Ok(out) => Ok(out),
        Err(e) => {
            last = e;
            Err(last)
        }
    }
}

async fn attempt(
    cwd: &Path,
    args: &[&str],
    env: &[(String, String)],
    progress: Option<Progress<'_>>,
    ceiling: std::time::Duration,
) -> Result<String> {
    match tokio::time::timeout(ceiling, run_watched(cwd, "git", args, env, progress)).await {
        Ok(result) => result,
        Err(_) => bail!("git gave up after {} minutes", ceiling.as_secs() / 60),
    }
}

/// Whether the network dropped it, as opposed to the far end refusing.
fn is_transient(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    [
        "early eof",
        "unexpected disconnect",
        "rpc failed",
        "connection reset",
        "the remote end hung up",
        "operation timed out",
        "could not read from remote repository",
    ]
    .iter()
    .any(|marker| e.contains(marker))
}

/// What a long git command says about itself while it runs.
///
/// `git` writes progress to stderr as carriage-return-separated lines —
/// "Receiving objects:  61% (1234/2000)". Reading them as they arrive is the
/// difference between a fetch that looks frozen for eight minutes and one that
/// is visibly downloading something large.
pub type Progress<'a> = &'a (dyn Fn(String) + Send + Sync);

async fn run_watched(
    cwd: &Path,
    program: &str,
    args: &[&str],
    env: &[(String, String)],
    progress: Option<Progress<'_>>,
) -> Result<String> {
    use tokio::io::AsyncReadExt;

    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(if cwd.exists() { cwd } else { Path::new(".") })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in env {
        command.env(k, v);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("running {program}"))?;

    let mut out = child.stdout.take().context("no stdout")?;
    let mut err = child.stderr.take().context("no stderr")?;

    // Both pipes are drained concurrently. Reading one at a time deadlocks the
    // moment the other fills its buffer, which for a chatty clone is quickly.
    let stdout = async {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf).await;
        buf
    };

    let stderr = async {
        let mut collected = Vec::new();
        let mut line = Vec::new();
        let mut byte = [0u8; 1];

        while err.read_exact(&mut byte).await.is_ok() {
            collected.push(byte[0]);
            // Progress lines end in \r and overwrite each other; ordinary
            // messages end in \n. Both terminate a line for our purposes.
            if byte[0] == b'\r' || byte[0] == b'\n' {
                if let Some(report) = progress {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if !text.is_empty() {
                        report(text);
                    }
                }
                line.clear();
            } else {
                line.push(byte[0]);
            }
        }
        collected
    };

    let (stdout, stderr) = tokio::join!(stdout, stderr);
    let status = child.wait().await.context("waiting for git")?;

    if !status.success() {
        bail!(
            "{program} {} failed: {}",
            args.join(" "),
            what_went_wrong(&String::from_utf8_lossy(&stderr))
        );
    }

    Ok(String::from_utf8_lossy(&stdout).to_string())
}

/// The part of git's stderr worth showing someone.
///
/// Asking for `--progress` means stderr is mostly progress: hundreds of
/// carriage-return-separated counters that overwrite each other on a terminal
/// and pile up in a buffer anywhere else. One failed fetch produced an
/// eighteen-thousand-character message, of which four lines mattered — and
/// those four were at the end, past everything a person would give up reading.
///
/// So progress is dropped and the tail is kept. If nothing survives the filter,
/// the raw tail is better than saying nothing at all.
fn what_went_wrong(stderr: &str) -> String {
    const KEEP: usize = 8;

    let lines: Vec<&str> = stderr
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_progress(line))
        .collect();

    if lines.is_empty() {
        return stderr
            .trim()
            .chars()
            .rev()
            .take(400)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }

    lines[lines.len().saturating_sub(KEEP)..].join("\n")
}

/// A counter, not a message.
fn is_progress(line: &str) -> bool {
    let l = line.trim_start_matches("remote: ");
    [
        "Enumerating objects",
        "Counting objects",
        "Compressing objects",
        "Receiving objects",
        "Resolving deltas",
        "Updating files",
        "Cloning into",
    ]
    .iter()
    .any(|marker| l.starts_with(marker))
}

/// Whether git refused because this branch name is spoken for.
///
/// It has two ways of saying so and they are not interchangeable: a branch that
/// merely exists, and a branch checked out by another worktree. Only matching
/// the first meant a second session on the same prompt failed outright instead
/// of taking the next number — which is the whole point of the loop.
fn name_is_taken(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("already exists") || e.contains("already used by worktree")
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
mod message_tests {
    use super::what_went_wrong;

    /// The real one: 18,526 characters of counters wrapped around four useful
    /// lines, sent to a screen that has to render it next to a step.
    #[test]
    fn progress_is_dropped_and_the_failure_is_kept() {
        let mut noise = String::from("remote: Enumerating objects: 1132, done.\n");
        for percent in 0..100 {
            noise.push_str(&format!(
                "remote: Counting objects: {percent}% (7/633)        \r"
            ));
            noise.push_str(&format!(
                "Receiving objects:  {percent}% (24/1132), 5.00 MiB\r"
            ));
        }
        noise.push_str(
            "error: RPC failed; curl 56 Recv failure: Connection reset by peer\n\
             error: 5484 bytes of body are still expected\n\
             fatal: early EOF\n\
             fatal: fetch-pack: invalid index-pack output\n",
        );

        let shown = what_went_wrong(&noise);

        assert!(shown.len() < 400, "still {} characters", shown.len());
        assert!(shown.contains("Connection reset by peer"));
        assert!(shown.contains("fatal: early EOF"));
        assert!(!shown.contains("Counting objects"));
        assert!(!shown.contains("Receiving objects"));
    }

    #[test]
    fn a_short_refusal_survives_intact() {
        let refused = "remote: Repository not found.\nfatal: repository not found";
        assert_eq!(what_went_wrong(refused), refused);
    }

    /// Nothing but progress, and it still failed. Saying nothing would be worse
    /// than saying something unhelpful.
    #[test]
    fn something_is_always_said() {
        let only_noise = "Receiving objects: 50% (1/2)\rReceiving objects: 99% (1/2)\r";
        assert!(!what_went_wrong(only_noise).is_empty());
    }
}

#[cfg(test)]
mod retry_tests {
    use super::is_transient;

    /// The failure that cost a real session: a dropped transfer, which is worth
    /// trying again.
    #[test]
    fn a_dropped_transfer_is_worth_retrying() {
        for message in [
            "error: RPC failed; curl 92 HTTP/2 stream 7 was not closed cleanly: CANCEL (err 8)\n             fatal: early EOF",
            "fetch-pack: unexpected disconnect while reading sideband packet",
            "fatal: the remote end hung up unexpectedly",
            "Connection reset by peer",
            "ssh: connect to host example.com port 22: Operation timed out",
        ] {
            assert!(is_transient(message), "should retry: {message}");
        }
    }

    /// A refusal says the same thing every time. Retrying it wastes a minute
    /// and tells the person nothing new.
    #[test]
    fn a_refusal_is_not() {
        for message in [
            "remote: Repository not found.",
            "fatal: Authentication failed for 'https://github.com/acme/backend.git/'",
            "error: pathspec 'nope' did not match any file(s) known to git",
            "fatal: destination path already exists and is not an empty directory",
        ] {
            assert!(!is_transient(message), "should not retry: {message}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn only_the_chosen_files_are_committed() {
        // Unticking a file in the review sheet has to actually leave it out —
        // including when something else already staged it, which an agent
        // often has.
        let dest = tempfile::tempdir().unwrap();
        let git = GitRoot::new(dest.path());
        run(dest.path(), "git", &["init", "-q"]).await.unwrap();
        run(dest.path(), "git", &["config", "user.email", "a@b"])
            .await
            .unwrap();
        run(dest.path(), "git", &["config", "user.name", "t"])
            .await
            .unwrap();

        std::fs::write(dest.path().join("wanted.txt"), "keep").unwrap();
        std::fs::write(dest.path().join("not-wanted.txt"), "drop").unwrap();
        // Already staged by somebody else, and still not wanted.
        run(dest.path(), "git", &["add", "not-wanted.txt"])
            .await
            .unwrap();

        git.commit(dest.path(), "only one", &["wanted.txt".to_string()])
            .await
            .unwrap();

        let inside = run(
            dest.path(),
            "git",
            &["show", "--name-only", "--format=", "HEAD"],
        )
        .await
        .unwrap();
        assert!(inside.contains("wanted.txt"), "{inside:?}");
        assert!(!inside.contains("not-wanted.txt"), "{inside:?}");
    }

    #[tokio::test]
    async fn work_can_be_pushed_back_to_where_it_came_from() {
        let (origin_dir, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        let (dest, branch) = git
            .add_worktree(&mirror, "agent/work", "main", "s_push")
            .await
            .unwrap();

        tokio::fs::write(dest.join("new.txt"), "from the agent\n")
            .await
            .unwrap();
        git.commit(&dest, "Add a file", &[]).await.unwrap();
        git.push(&dest, &branch, None).await.unwrap();

        // the branch reached the origin, which is what makes ending a session
        // safe rather than destructive
        let branches = run(origin_dir.path(), "git", &["branch", "--list", &branch])
            .await
            .unwrap();
        assert!(branches.contains(&branch), "{branches:?}");

        let after = git.summary(&dest, &branch, "main").await.unwrap();
        assert_eq!(after.uncommitted, 0);
        assert_eq!(after.ahead, 0, "nothing should be left behind");
        assert!(after.pushed);
    }

    #[tokio::test]
    async fn a_fresh_mirror_has_something_to_branch_from() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());

        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        // The very first session branches from this, so it has to exist before
        // anyone has fetched a second time.
        run(&mirror, "git", &["rev-parse", "--verify", "origin/main"])
            .await
            .expect("a fresh mirror should have remote-tracking refs");
    }

    #[tokio::test]
    async fn fetching_works_while_a_session_holds_a_branch() {
        let (origin_dir, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        // One session is live and holding its branch checked out.
        git.add_worktree(&mirror, "agent/busy", "main", "s_busy")
            .await
            .unwrap();

        // Someone pushes, and a second session starts. Fetching must not refuse
        // just because the first session exists.
        tokio::fs::write(origin_dir.path().join("more.txt"), "more\n")
            .await
            .unwrap();
        run(origin_dir.path(), "git", &["add", "."]).await.unwrap();
        run(origin_dir.path(), "git", &["commit", "-m", "more"])
            .await
            .unwrap();

        git.ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .expect("a live worktree must not block fetching");

        git.add_worktree(&mirror, "agent/next", "main", "s_next")
            .await
            .expect("a second session should still start");
    }

    #[tokio::test]
    async fn a_warm_mirror_actually_picks_up_new_commits() {
        let (origin_dir, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());

        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();
        let before = run(&mirror, "git", &["rev-parse", "origin/main"])
            .await
            .unwrap();

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
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();
        assert!(!cloned, "the second call should fetch, not clone");

        let after = run(&mirror, "git", &["rev-parse", "origin/main"])
            .await
            .unwrap();
        assert_ne!(
            before, after,
            "a mirror that never moves means every session branches from stale work"
        );
    }

    #[test]
    fn both_of_gits_ways_of_saying_taken_are_recognised() {
        assert!(name_is_taken(
            "fatal: a branch named 'agent/x' already exists"
        ));
        assert!(name_is_taken(
            "fatal: 'agent/x' is already used by worktree at '/tmp/other'"
        ));
        // Anything else is a real failure and must not be retried away.
        assert!(!name_is_taken("fatal: invalid reference: nonsense"));
    }

    #[tokio::test]
    async fn a_live_worktree_holding_the_branch_does_not_fail_the_next_session() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        // The first session is still running, so its worktree still holds the
        // branch — which is a different refusal from "the branch exists".
        let (_, first) = git
            .add_worktree(&mirror, "agent/hello", "main", "s_first")
            .await
            .unwrap();
        assert_eq!(first, "agent/hello");

        let (_, second) = git
            .add_worktree(&mirror, "agent/hello", "main", "s_second")
            .await
            .unwrap();
        assert_eq!(second, "agent/hello-2", "the second one takes a number");
    }

    #[tokio::test]
    async fn probing_reads_the_real_default_branch() {
        let (_origin, remote) = origin_on_branch("trunk").await;
        let dir = TempDir::new().unwrap();
        let git = GitRoot::new(dir.path());

        let info = git.probe(&remote, None).await.unwrap();
        assert_eq!(info.default_branch, "trunk", "assuming main is the bug");
        assert!(!info.empty);
        assert_eq!(info.branches, vec!["trunk"], "sessions pick from these");
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
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();
        assert!(cloned, "a cold mirror has to clone");
        assert!(path.join("HEAD").exists());

        let (again, cloned) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
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
            .ensure_mirror(&remote, "acme/backend", None, None)
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

    /// The signal the interface needs to stop offering a pull request for a
    /// branch that holds nothing: measured against the base, whatever the
    /// push state, unlike `ahead`.
    #[tokio::test]
    async fn a_branch_reports_whether_it_carries_anything() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        let (tree, branch) = git
            .add_worktree(&mirror, "agent/empty", "main", "s_empty")
            .await
            .unwrap();

        // Cut and left alone: identical to the base.
        let fresh = git.summary(&tree, &branch, "main").await.unwrap();
        assert_eq!(
            fresh.commits,
            Some(0),
            "an untouched branch carries nothing"
        );
        assert_eq!(fresh.uncommitted, 0);

        // A file, and then a commit holding it.
        tokio::fs::write(tree.join("new.txt"), "x").await.unwrap();
        let dirty = git.summary(&tree, &branch, "main").await.unwrap();
        assert_eq!(dirty.uncommitted, 1);
        assert_eq!(dirty.commits, Some(0), "uncommitted is not yet a commit");

        git.commit(&tree, "add a file", &[]).await.unwrap();
        let done = git.summary(&tree, &branch, "main").await.unwrap();
        assert_eq!(done.commits, Some(1), "now there is something to open");
    }

    /// A directory in the way used to end the session. It is numbered instead,
    /// and the caller is told where the checkout actually went.
    #[tokio::test]
    async fn an_occupied_directory_is_worked_around_rather_than_fatal() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        // Something unrelated is already sitting where the checkout would go.
        let taken = git.worktree_path("s_blocked");
        tokio::fs::create_dir_all(&taken).await.unwrap();
        tokio::fs::write(taken.join("in-the-way.txt"), "x")
            .await
            .unwrap();

        let (path, branch) = git
            .add_worktree(&mirror, "agent/blocked", "main", "s_blocked")
            .await
            .expect("an occupied directory must not fail the session");

        assert_ne!(path, taken, "it must not check out over what was there");
        assert!(path.join(".git").exists(), "{path:?} is not a checkout");
        assert!(
            taken.join("in-the-way.txt").exists(),
            "what was already there must survive"
        );
        // Nothing was contending for the name, so it kept the clean one.
        assert_eq!(branch, "agent/blocked");
    }

    /// The branch is numbered by asking git what it holds, not by reading the
    /// wording of the error it returns when it refuses.
    #[tokio::test]
    async fn a_taken_branch_is_numbered_without_reading_gits_prose() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();

        let taken = git.branches_in_use(&mirror).await;
        assert!(
            taken.contains("main"),
            "the mirror's own branches have to count as taken: {taken:?}"
        );

        let (_, first) = git
            .add_worktree(&mirror, "agent/same", "main", "s_a")
            .await
            .unwrap();
        let (_, second) = git
            .add_worktree(&mirror, "agent/same", "main", "s_b")
            .await
            .unwrap();

        assert_eq!(first, "agent/same");
        assert_eq!(second, "agent/same-2");
        assert!(git.branches_in_use(&mirror).await.contains("agent/same-2"));
    }

    #[tokio::test]
    async fn two_sessions_get_independent_worktrees() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
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
            .ensure_mirror(&remote, "acme/backend", None, None)
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
            .ensure_mirror(&remote, "acme/backend", None, None)
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
            .ensure_mirror("/definitely/not/a/repo", "acme/nope", None, None)
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
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();
        let (tree, _) = git
            .add_worktree(&mirror, "agent/edit", "main", "s_diff")
            .await
            .unwrap();

        assert_eq!(
            git.diff(&tree, "main").await.unwrap(),
            "",
            "nothing changed yet"
        );

        tokio::fs::write(tree.join("README.md"), "# fixture\nedited\n")
            .await
            .unwrap();
        let diff = git.diff(&tree, "main").await.unwrap();
        assert!(diff.contains("+edited"), "{diff}");
    }

    #[tokio::test]
    async fn a_file_the_agent_created_shows_up_in_the_diff() {
        let (_origin, remote) = origin().await;
        let home = TempDir::new().unwrap();
        let git = GitRoot::new(home.path());
        let (mirror, _) = git
            .ensure_mirror(&remote, "acme/backend", None, None)
            .await
            .unwrap();
        let (tree, _) = git
            .add_worktree(&mirror, "agent/new-file", "main", "s_new")
            .await
            .unwrap();

        // Untracked, which is what every file an agent writes starts out as.
        tokio::fs::write(tree.join("NOTES.md"), "written by the agent\n")
            .await
            .unwrap();

        let diff = git.diff(&tree, "main").await.unwrap();
        assert!(
            diff.contains("NOTES.md"),
            "a new file must not be invisible"
        );
        assert!(diff.contains("+written by the agent"), "{diff}");
    }
}
