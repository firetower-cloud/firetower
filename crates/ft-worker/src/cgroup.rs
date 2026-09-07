//! What a workspace is allowed to take from the machine.
//!
//! ## Why a workspace and not a session
//!
//! A person asks for "this piece of work to go faster", and the piece of work
//! is the workspace — a checkout with any number of agents in it. Limiting a
//! session instead would hand a workspace running three agents three times the
//! budget of one running a single agent, as an accident of how many happen to
//! be going. So the knob lives on the workspace and the sessions inside it
//! share what it has.
//!
//! ## The shape on disk
//!
//! ```text
//! /sys/fs/cgroup/ft-w_<workspace>/          limits live here
//!     ├── agents/                           the tmux panes
//!     └── <whatever dockerd creates>        the session's containers
//! ```
//!
//! The `agents/` child is not tidiness. A cgroup hands its controllers to its
//! children through `cgroup.subtree_control`, and the kernel will not delegate
//! every controller out of a cgroup that also holds processes of its own. Put
//! the panes directly in `ft-w_…` and the daemon still starts containers under
//! it — but `memory` and `io` quietly fail to delegate, leaving `cpuset cpu
//! pids` behind. Nothing looks broken: the workspace ceiling is still enforced,
//! because a descendant with no memory controller of its own is charged to the
//! nearest ancestor that has one. What breaks is the session's own
//! `docker run --memory`, which lands on a cgroup with no `memory.max` to
//! write. One empty directory avoids all of that.
//!
//! ## Containers have to be told
//!
//! A container started in a session is not a child of that session. It is a
//! child of the daemon, which lives in this container's own cgroup, so it comes
//! up as a sibling of the workspace and inherits none of its limits. The daemon
//! puts it where it is told with `--cgroup-parent`, which is what
//! [`CGROUP_PARENT_ENV`] carries into a session for the Docker shim to pass on.
//!
//! That is cooperative rather than enforced: a session that calls
//! `/usr/bin/docker` directly goes around it. Worth saying plainly — this is
//! fairness between workspaces, not a sandbox. A worker is `--privileged`
//! already, and anything inside it could have the machine if it wanted one.
//!
//! ## Nothing here is fatal
//!
//! A worker runs on someone's laptop, in a container that was created without
//! `--privileged` by a CLI too old to pass it, and on hosts whose `/sys/fs/
//! cgroup` is read-only or still on v1. None of those can run a session any
//! less well for the want of an accounting directory, so every function in this
//! module reports what it could not do and carries on. [`available`] is the one
//! question worth asking first, and the answer is allowed to be no.

use std::path::{Path, PathBuf};

use ft_core::{SessionId, Share, WorkspaceSize};

/// Where the cgroup v2 hierarchy is mounted.
const ROOT: &str = "/sys/fs/cgroup";

/// The environment variable naming a session's cgroup, read by the Docker shim.
///
/// In the session's environment beside `COMPOSE_PROJECT_NAME`, and for the same
/// reason: the thing that has to know is a program the agent runs, not this
/// process.
pub const CGROUP_PARENT_ENV: &str = "FIRETOWER_CGROUP_PARENT";

/// The controllers a workspace hands down to its children.
///
/// `cpu` and `memory` are the two anyone set out to divide. `io` comes along
/// because a build that saturates the disk starves its neighbours as surely as
/// one that saturates the CPU, and the weight costs nothing to set.
const CONTROLLERS: &str = "+cpu +memory +io";

/// What a workspace may take.
///
/// Two axes, and they answer different questions. The size is how much this
/// workspace may have at most; the share is who yields when two of them want
/// the same core at the same moment. A ceiling is absolute and a share is
/// relative, which is exactly the asymmetry between memory and CPU.
#[derive(Debug, Clone, Copy, Default)]
pub struct Limits {
    pub share: Share,
    pub size: WorkspaceSize,
}

impl Limits {
    /// The hard memory ceiling, in bytes.
    ///
    /// From the size the workspace was asked for, which until now was reported
    /// and never applied: a worker emits `WorkspaceStarted` saying "2 CPU / 4
    /// GB" and then let the workspace have the machine. Applying it here is
    /// what makes that sentence true.
    fn memory_max(self) -> u64 {
        let (_, megabytes) = self.size.resources();
        megabytes * 1024 * 1024
    }

    /// The `cpu.weight` this workspace competes with.
    ///
    /// The size's CPU count and the share multiply, because they mean
    /// different things and both are true at once. A large workspace really
    /// should out-pull a small one — four cores against one is a ratio, and a
    /// weight is the only way to keep that ratio without also capping the large
    /// one at four cores on an empty machine. The share then moves it around
    /// that baseline.
    ///
    /// Clamped to the kernel's range. Large and `TakesMore` is 1600, which is
    /// inside it, but the arithmetic should not be the thing that has to be
    /// right if a size is ever added.
    fn weight(self) -> u32 {
        let (cpus, _) = self.size.resources();
        (self.share.weight() * cpus.max(1)).clamp(1, 10_000)
    }
}

/// What a workspace is taking, now.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub memory_current: u64,
    /// The high-water mark since the workspace started.
    ///
    /// The number worth showing. `memory_current` on an idle agent says little,
    /// and the question behind "how much does this need" is always about the
    /// peak — which is also the only evidence for what a ceiling should be.
    pub memory_peak: u64,
    pub memory_max: Option<u64>,
    /// Total CPU time, in microseconds. A rate needs two of these.
    pub cpu_usec: u64,
    /// How many times something here was killed for going over the ceiling.
    ///
    /// Carried so a session can say so. Without it an agent's build vanishing
    /// is a mystery that reads as a crash in whatever it was running.
    pub oom_kills: u64,
}

/// Whether this machine will let us divide it up.
///
/// Three things have to hold, and on an ordinary worker they all do: the
/// hierarchy is v2, we may write to it, and the controllers we need have been
/// handed down to us. A `--privileged` container gets all three; the entrypoint
/// arranges the third for older hosts that need telling.
pub fn available() -> bool {
    let root = Path::new(ROOT);
    if !root.join("cgroup.controllers").exists() {
        return false;
    }

    // Readable, and it says the two we cannot do without. A host that delegated
    // only `pids` can host sessions perfectly well and simply has no shares to
    // divide.
    let Ok(delegated) = std::fs::read_to_string(root.join("cgroup.subtree_control")) else {
        return false;
    };
    if !(delegated.contains("cpu") && delegated.contains("memory")) {
        return false;
    }

    // Writable is asked by trying, because the mount can be read-only in ways
    // that permissions do not show — a worker created without `--privileged` is
    // exactly that case.
    std::fs::create_dir_all(root.join("ft-probe"))
        .and_then(|()| std::fs::remove_dir(root.join("ft-probe")))
        .is_ok()
}

/// The cgroup a workspace's directory name makes.
///
/// The directory is the workspace's identity on a worker — it is what
/// `StartAgent` sends to put a second agent in the same place, and what the
/// store hands back for a session. Deriving the name from it means every path
/// into a workspace arrives at the same cgroup without anything new to thread
/// through.
pub fn name(workspace: &Path) -> String {
    let leaf = workspace
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let cleaned: String = leaf
        .chars()
        .map(|c| match c {
            'a'..='z' | '0'..='9' | '-' | '_' => c,
            'A'..='Z' => c.to_ascii_lowercase(),
            _ => '-',
        })
        .collect();

    format!("ft-w_{cleaned}")
}

/// Where that cgroup sits.
pub fn dir(workspace: &Path) -> PathBuf {
    Path::new(ROOT).join(name(workspace))
}

/// The child holding the workspace's own processes. See this module's header
/// for why it exists.
pub fn agents_dir(workspace: &Path) -> PathBuf {
    dir(workspace).join("agents")
}

/// What `--cgroup-parent` should be told, for containers a session starts.
pub fn parent_arg(workspace: &Path) -> String {
    format!("/{}", name(workspace))
}

/// Make a workspace's cgroup, and say what it may take.
///
/// Idempotent, because a second agent in a workspace comes through here too and
/// the workspace it is joining already has one. Best effort throughout: what
/// this returns is whether there is a cgroup to put anything in, and a `false`
/// costs accounting rather than a session.
pub async fn create(workspace: &Path, limits: Limits) -> bool {
    if !available() {
        return false;
    }

    // A path with no last component — `/`, or one ending in `..` — names no
    // workspace, and `name` has nothing to build from. Refused rather than
    // allowed to become the bare prefix, which every such path would share:
    // two workspaces in one cgroup would hold each other to one ceiling and
    // the first to end would take the other's accounting away.
    if workspace.file_name().is_none_or(|n| n.is_empty()) {
        tracing::warn!(
            workspace = %workspace.display(),
            "no workspace name to account against; this workspace runs unlimited"
        );
        return false;
    }

    let dir = dir(workspace);
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!(cgroup = %dir.display(), "could not make the workspace's cgroup: {e}");
        return false;
    }

    // Before the `agents` child and before anything is in it. Delegation is
    // refused once a cgroup holds processes, and the ordering is the difference
    // between `cpu io memory` and the silent `cpuset cpu pids` described in
    // this module's header.
    write(&dir.join("cgroup.subtree_control"), CONTROLLERS).await;

    if let Err(e) = tokio::fs::create_dir_all(dir.join("agents")).await {
        tracing::warn!(cgroup = %dir.display(), "could not make the agents cgroup: {e}");
        return false;
    }

    apply(workspace, limits).await;
    true
}

/// Change what a workspace may take, while it is running.
///
/// Live, with nothing restarted. `cpu.weight` is read by the scheduler on the
/// next contended moment, which is what lets the interface offer this on a
/// workspace somebody is watching.
pub async fn apply(workspace: &Path, limits: Limits) {
    let dir = dir(workspace);
    if !dir.exists() {
        return;
    }

    let weight = limits.weight().to_string();
    write(&dir.join("cpu.weight"), &weight).await;
    write(&dir.join("io.weight"), &weight).await;

    let bytes = limits.memory_max();
    write(&dir.join("memory.max"), &bytes.to_string()).await;

    // Below the ceiling, so pressure is felt as slowness before it is felt as
    // a kill. Without this a workspace runs at full speed until the moment
    // something in it dies.
    let high = (bytes as f64 * 0.85) as u64;
    write(&dir.join("memory.high"), &high.to_string()).await;

    let low = (bytes as f64 * limits.share.protection()) as u64;
    write(&dir.join("memory.low"), &low.to_string()).await;
}

/// The shell that puts a pane in its workspace's cgroup.
///
/// Prefixed to the session's command rather than applied to the process that
/// spawns it, because the pane is not that process's child. `tmux new-session`
/// asks a tmux server that is already running to make one, and the pane hangs
/// off the server — which is in whatever cgroup the server started in, and will
/// stay there.
///
/// So the pane moves itself, in its own first instruction, before the agent it
/// is going to exec exists. Everything it forks afterwards inherits the cgroup,
/// which is the whole point.
///
/// Silent and unconditional on failure. A pane that cannot join is a pane that
/// runs unaccounted, and refusing to start the agent over it would trade a
/// missing measurement for a session nobody can use.
pub fn join_command(workspace: &Path) -> String {
    let procs = agents_dir(workspace).join("cgroup.procs");
    format!("echo $$ > {} 2>/dev/null;", procs.display())
}

/// What a workspace is taking, or `None` if it is not being accounted.
pub async fn usage(workspace: &Path) -> Option<Usage> {
    let dir = dir(workspace);
    if !dir.exists() {
        return None;
    }

    Some(Usage {
        memory_current: number(&dir.join("memory.current")).await.unwrap_or(0),
        memory_peak: number(&dir.join("memory.peak")).await.unwrap_or(0),
        // `max` is the kernel's word for uncapped, and it is not a number. A
        // `None` here is what the interface draws as a meter with no ceiling
        // on it.
        memory_max: number(&dir.join("memory.max")).await,
        cpu_usec: keyed(&dir.join("cpu.stat"), "usage_usec")
            .await
            .unwrap_or(0),
        oom_kills: keyed(&dir.join("memory.events"), "oom_kill")
            .await
            .unwrap_or(0),
    })
}

/// Take a workspace's cgroup away, once nothing is left in it.
///
/// Called from teardown, where the session that ended may not have been the
/// last one in its workspace. `rmdir` on a cgroup with processes still in it
/// fails with `EBUSY`, which is exactly the answer we want and why this does
/// not check first: the last session out is the one that succeeds.
///
/// The `agents` child goes first, because a cgroup with children will not go
/// either.
pub async fn remove(workspace: &Path, session: &SessionId) {
    let dir = dir(workspace);
    if !dir.exists() {
        return;
    }

    let _ = tokio::fs::remove_dir(dir.join("agents")).await;

    match tokio::fs::remove_dir(&dir).await {
        Ok(()) => {
            tracing::info!(session = %session, cgroup = %dir.display(), "workspace cgroup removed")
        }
        // The ordinary case for every session but the last, and not news.
        Err(e) => {
            tracing::debug!(session = %session, "workspace cgroup still in use: {e}");
            // Put back what the last-but-one session's teardown just removed,
            // so the agents still running there keep somewhere to be.
            let _ = tokio::fs::create_dir_all(dir.join("agents")).await;
        }
    }
}

/// Write one cgroup file, and say so if it would not take it.
///
/// Debug rather than warn. Several of these are attempts by design — a
/// controller a host never delegated refuses every write to it, once per
/// session, and that is a fact about the host rather than a fault.
async fn write(path: &Path, value: &str) {
    if let Err(e) = tokio::fs::write(path, value).await {
        tracing::debug!(path = %path.display(), value, "cgroup write refused: {e}");
    }
}

/// A cgroup file holding one number, or `max`.
async fn number(path: &Path) -> Option<u64> {
    let read = tokio::fs::read_to_string(path).await.ok()?;
    read.trim().parse().ok()
}

/// One line of a `key value` cgroup file, by key.
async fn keyed(path: &Path, key: &str) -> Option<u64> {
    let read = tokio::fs::read_to_string(path).await.ok()?;
    read.lines()
        .find_map(|line| line.strip_prefix(key)?.trim().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspace_names_its_cgroup_from_its_directory() {
        let name = name(Path::new(
            "/var/lib/firetower/worker/worktrees/auth-refactor-ab12",
        ));
        assert_eq!(name, "ft-w_auth-refactor-ab12");
    }

    /// The same guard `docker::project` has, for the same reason: the shape of
    /// what names a workspace is allowed to change, and a directory that
    /// arrived with a slash or a space in it must not become a path.
    #[test]
    fn anything_unexpected_in_a_directory_name_is_flattened() {
        assert_eq!(
            name(Path::new("/tmp/Auth Refactor!")),
            "ft-w_auth-refactor-"
        );
    }

    /// A path with no last component would otherwise name the bare prefix,
    /// which every such path shares — so `create` refuses it rather than
    /// putting two workspaces in one cgroup. Asserted on the name because that
    /// is what makes the collision, and the guard is what stops it being used.
    #[tokio::test]
    async fn a_workspace_with_no_name_is_not_accounted() {
        assert_eq!(name(Path::new("/tmp/..")), "ft-w_");
        assert_eq!(name(Path::new("/")), "ft-w_");
        assert!(!create(Path::new("/"), Limits::default()).await);
    }

    #[test]
    fn the_parent_a_container_is_told_is_absolute() {
        assert_eq!(parent_arg(Path::new("/tmp/work-a1")), "/ft-w_work-a1");
    }

    /// Four times the weight, which is the number the interface promises when
    /// it says a workspace that takes more gets about four times the share.
    #[test]
    fn taking_more_is_four_times_an_equal_share() {
        assert_eq!(Share::TakesMore.weight(), 4 * Share::Equal.weight());
        assert_eq!(Share::Equal.weight(), 2 * Share::Yields.weight());
    }

    /// The size a workspace was asked for is the ceiling it gets. Until now
    /// this number was reported in an event and applied to nothing.
    #[test]
    fn the_size_asked_for_is_the_ceiling_applied() {
        let limits = Limits {
            share: Share::Equal,
            size: WorkspaceSize::Medium,
        };
        assert_eq!(limits.memory_max(), 4096 * 1024 * 1024);
    }

    /// Both axes at once: a large workspace out-pulls a small one even when
    /// both are taking their turn, and the share moves each around that.
    #[test]
    fn size_and_share_multiply() {
        let small = Limits {
            share: Share::Equal,
            size: WorkspaceSize::Small,
        };
        let large = Limits {
            share: Share::Equal,
            size: WorkspaceSize::Large,
        };
        assert_eq!(large.weight(), 4 * small.weight());

        let yielding_large = Limits {
            share: Share::Yields,
            size: WorkspaceSize::Large,
        };
        assert_eq!(yielding_large.weight(), large.weight() / 2);
    }

    /// A weight the kernel would refuse is a session that fails to start for
    /// arithmetic. Every combination has to land inside 1..=10000.
    #[test]
    fn every_combination_is_a_weight_the_kernel_accepts() {
        for size in [
            WorkspaceSize::Small,
            WorkspaceSize::Medium,
            WorkspaceSize::Large,
        ] {
            for share in [Share::Yields, Share::Equal, Share::TakesMore] {
                let weight = Limits { share, size }.weight();
                assert!(
                    (1..=10_000).contains(&weight),
                    "{size:?}/{share:?} = {weight}"
                );
            }
        }
    }

    /// The pane moves itself into `agents`, never into the workspace cgroup
    /// proper — see this module's header for what putting processes there
    /// costs.
    #[test]
    fn a_pane_joins_the_agents_child_and_never_the_workspace_itself() {
        let joined = join_command(Path::new("/tmp/work-a1"));
        assert!(
            joined.contains("/sys/fs/cgroup/ft-w_work-a1/agents/cgroup.procs"),
            "{joined}"
        );
    }

    /// A failed join must not take the agent down with it.
    #[test]
    fn a_pane_that_cannot_join_still_runs_its_agent() {
        let joined = join_command(Path::new("/tmp/work-a1"));
        assert!(joined.contains("2>/dev/null"), "{joined}");
        assert!(!joined.contains("||"), "no branch to fail down: {joined}");
        assert!(joined.trim_end().ends_with(';'), "{joined}");
    }
}
