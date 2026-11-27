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
use std::time::Duration;

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
    //
    // `create_dir` and not `create_dir_all`: what is being asked is whether we
    // can make a cgroup, and finding one already there is not an answer to
    // that. See [`probe`] for what that distinction used to cost.
    let probe = probe();
    if let Err(e) = std::fs::create_dir(&probe) {
        tracing::debug!(probe = %probe.display(), "cgroups are not ours to write: {e}");
        return false;
    }

    // Ours alone, so taking it away can take nobody else's answer with it.
    match std::fs::remove_dir(&probe) {
        Ok(()) => true,
        Err(e) => {
            tracing::debug!(probe = %probe.display(), "the probe cgroup would not go away again: {e}");
            false
        }
    }
}

/// A probe directory no other call is using.
///
/// It used to be one fixed `ft-probe` for the whole machine, which turned a
/// question into a race. `create_dir_all` is content to find the directory
/// already there, so two sessions starting at once both believed they had made
/// it, the first removed it, and the second's `rmdir` failed with `ENOENT` —
/// which read as a host with no usable cgroups. Measured at 51 wrong answers
/// in 80 concurrent calls.
///
/// The cost of a wrong `false` is not a workspace that goes unaccounted. It is
/// [`create`] returning early, so the workspace has no cgroup at all, so
/// [`kill`] finds nothing to kill and teardown leaves every process that
/// workspace started running — the exact leak this module was changed to close,
/// reinstated by nothing more than two sessions starting at the same moment.
///
/// A name of our own makes it a local question again. The pid is not enough on
/// its own: `available` is asked once per session and twice per start, and two
/// of those overlap inside one worker as readily as between two.
fn probe() -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Path::new(ROOT).join(format!("ft-probe-{}-{n}", std::process::id()))
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
///
/// Silent takes the braces. `echo $$ > PATH 2>/dev/null` is not silent: a
/// shell performs redirections left to right, so the one that fails has
/// already failed — and been complained about on the real stderr — by the time
/// `2>/dev/null` is reached. Every host with no cgroup v2 at that path, which
/// is every macOS host, therefore opened each pane with
/// `No such file or directory` printed into it, above the agent, where it
/// reads as the agent having failed to start. Four orphaned sessions on one
/// machine showed it.
///
/// Redirecting the group's stderr instead silences the failure inside it, and
/// has to be the group rather than a reordered `2>/dev/null > PATH`: zsh
/// reports a redirection it could not perform on the stderr the shell started
/// with, whatever the command then does with fd 2. Verified against `sh`,
/// `bash` and `zsh` — all three stay quiet this way, and all three carry on to
/// the agent, which is the half that was already right.
pub fn join_command(workspace: &Path) -> String {
    let procs = agents_dir(workspace).join("cgroup.procs");
    format!("{{ echo $$ > {} ; }} 2>/dev/null;", procs.display())
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

/// Kill everything the workspace still has running.
///
/// Teardown's other handles do not reach far enough. `tmux kill-session` ends
/// the pane and signals its foreground process group, which is the agent and
/// whatever the agent was waiting on. It is not the dev server the agent left
/// running in the background, or the `workerd` that a `wrangler dev` spawned,
/// or a file watcher, or anything else started detached: those are in process
/// groups of their own, they outlive the pane, they reparent to init, and they
/// go on holding their memory with their working directory already deleted.
/// Someone running a worker on their own VPS found several of them that way —
/// deleting the workspace gave the disk back and not the RAM.
///
/// The cgroup is the handle that does reach them. A pane puts itself in
/// `agents/` as its first instruction, before it is the agent — see
/// [`join_command`] — and the kernel hands that membership to everything it
/// forks, through `setsid`, through daemonising, through reparenting. So the
/// tree under `ft-w_…` is this workspace's processes and nothing else, which
/// is both why it can be killed wholesale and why it must only be killed when
/// the workspace is finished with.
///
/// **Only for the last agent out.** The cgroup belongs to the workspace rather
/// than to the session, so a sibling agent still working is in here too and
/// this would end it mid-run — a worse thing by far than the leak. The `alone`
/// check in teardown is what establishes that, and it stays at the call site:
/// see [`remove`] for why nothing here decides it for itself.
///
/// Best effort like everything else in this module. A machine with no cgroups
/// has no handle to kill by and says nothing about it, which is the whole of
/// what happens on a macOS worker.
pub async fn kill(workspace: &Path, session: &SessionId) {
    let dir = dir(workspace);
    if !dir.exists() {
        return;
    }

    // Nothing left is both the ordinary case and the one worth no words: an
    // agent that started no daemon of its own has already gone with its pane.
    let found = members(&dir).await.len();
    if found == 0 {
        return;
    }

    let left = clear(&dir).await;
    if left.is_empty() {
        tracing::info!(
            session = %session,
            cgroup = %dir.display(),
            "killed {found} processes the workspace had left running"
        );
    } else {
        // A warning because this is the leak, still leaking, and the memory it
        // holds will not come back until somebody finds it by hand. The pids
        // are what they would need.
        tracing::warn!(
            session = %session,
            cgroup = %dir.display(),
            pids = ?left,
            "{} of {found} processes in the workspace would not die",
            left.len()
        );
    }
}

/// How many times to ask, and how long to wait between asking.
///
/// SIGKILL is immediate; exiting is not. A process with a lot of memory mapped
/// takes a moment for the kernel to take apart and stays in `cgroup.procs`
/// until it has, so a teardown that does not wait hands `remove` a cgroup that
/// is still busy and leaves it standing. A second of patience costs nothing
/// against a teardown that is already deleting a directory tree.
const ROUNDS: u32 = 20;
const PAUSE: Duration = Duration::from_millis(50);

/// Kill a cgroup's processes, and wait for them to actually be gone.
///
/// Rounds rather than one pass, because what is in here may fork while it is
/// being killed — a supervisor restarting the dev server it just lost is the
/// ordinary example, and a child born between the read and the signal is in
/// the cgroup but not in the list. `cgroup.kill` has no such gap, so on a
/// kernel that has it the second round is only ever the wait.
///
/// Returns whatever is still listed when patience runs out, which is empty on
/// every path that worked.
async fn clear(dir: &Path) -> Vec<i32> {
    let mut left = members(dir).await;
    for _ in 0..ROUNDS {
        if left.is_empty() {
            break;
        }
        sigkill(dir, &left).await;
        tokio::time::sleep(PAUSE).await;
        left = members(dir).await;
    }
    left
}

/// Every process in a cgroup and in the cgroups beneath it.
///
/// The walk is the point. `cgroup.procs` lists only what sits in that exact
/// cgroup, and the workspace's own is empty by design: the panes are in
/// `agents/` and a container the session started is in whatever the daemon
/// made for it under here. Reading the workspace alone would conclude there
/// was nothing to kill, every time.
///
/// Taking the directory rather than the workspace is also the test seam. This
/// and [`sigkill`] can be pointed at a temporary directory shaped like a
/// cgroup, which is the only way to exercise them off a Linux host, because
/// [`ROOT`] is a const and [`kill`] derives everything from it.
async fn members(dir: &Path) -> Vec<i32> {
    let mut pids: Vec<i32> = Vec::new();
    let mut pending = vec![dir.to_path_buf()];

    while let Some(cgroup) = pending.pop() {
        if let Ok(procs) = tokio::fs::read_to_string(cgroup.join("cgroup.procs")).await {
            pids.extend(
                procs
                    .lines()
                    .filter_map(|line| line.trim().parse::<i32>().ok()),
            );
        }

        let Ok(mut entries) = tokio::fs::read_dir(&cgroup).await else {
            continue;
        };
        // A cgroup filesystem holds directories and regular files and nothing
        // else — no symlinks, no mount points — so a directory here is a child
        // cgroup and there is no cycle to guard against.
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                pending.push(entry.path());
            }
        }
    }

    pids
}

/// SIGKILL a cgroup's processes, by the kernel's own handle where there is one.
///
/// `cgroup.kill` is a single write that takes the whole subtree down at once
/// and cannot be outrun: the kernel kills under a lock, so nothing escapes by
/// forking while a list is being worked through. It arrived in Linux 5.14, and
/// a worker on an older kernel — Debian 11 is still on 5.10 — has to be sent
/// the signals one at a time instead, which is what the list is read for.
///
/// Whether the file is there is the version question, asked the only way a
/// filesystem interface can be asked. The write is allowed to fail even when
/// it is — `/sys/fs/cgroup` is read-only on some hosts — and a pid is a handle
/// that outlives that, so the hard way is worth trying rather than giving up.
async fn sigkill(dir: &Path, pids: &[i32]) {
    let killer = dir.join("cgroup.kill");
    if killer.exists() && tokio::fs::write(&killer, "1").await.is_ok() {
        return;
    }

    for pid in pids {
        // Strictly positive, because `kill` reads everything else as a
        // broadcast rather than as a pid. Zero is every process in *our* own
        // process group, which is the worker: a teardown that killed itself
        // would take every other session on the machine with it. `-1` is every
        // process this user may signal at all, and any other negative number
        // is a whole process group.
        //
        // Not a worry about malformed files. `cgroup.procs` is written by the
        // kernel, but by the kernel's view of the pid namespace it was read
        // from — a process belonging to another namespace has no pid in ours
        // and reads here as `0`. One comparison against a worker that kills
        // itself is a trade worth making whatever the odds.
        if *pid <= 0 {
            tracing::debug!(pid, "not a pid in this namespace; left alone");
            continue;
        }

        // Nothing to do with the answer. `ESRCH` means it went while we were
        // reading, which is the point of the exercise, and anything else is a
        // process the next round will find still here.
        unsafe { libc::kill(*pid, libc::SIGKILL) };
    }
}

/// Take a workspace's cgroup away, once nothing is left in it.
///
/// Teardown calls this only for the last agent out of a workspace — `alone` at
/// the call site — but it is written as though that might be wrong, because
/// `rmdir` on a cgroup that still holds processes fails with `EBUSY` and that
/// is a guard worth keeping: a caller mistaken about being last leaves a
/// cgroup standing rather than taking the accounting out from under a live
/// agent.
///
/// Which is also why nothing here kills, though [`kill`] runs immediately
/// before it from the same place. Removing a directory that something is still
/// using is a failed `rmdir`; killing what is in it on the same mistaken
/// belief is somebody's agent gone mid-run. The dangerous half is a separate
/// call so that it is a decision somebody makes, in the one place that knows
/// the workspace is finished.
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

    /// And must not say so into the pane.
    ///
    /// Run for real, against a path that cannot exist, by each of the shells
    /// tmux might start a pane with. Asserting on the string would only
    /// restate the fix; what this is about is whether the shell stays quiet,
    /// and the shell is the only thing that can answer that.
    #[test]
    fn a_pane_that_cannot_join_says_nothing_about_it() {
        let line = format!(
            "{} echo the-agent-itself",
            join_command(Path::new("/ft-no-such-root/work-a1"))
        );

        for shell in ["/bin/sh", "/bin/bash", "/bin/zsh"] {
            if !Path::new(shell).exists() {
                continue;
            }
            let run = std::process::Command::new(shell)
                .args(["-c", &line])
                .output()
                .expect("the shell should run");

            assert_eq!(
                String::from_utf8_lossy(&run.stderr).trim(),
                "",
                "{shell} complained into the pane"
            );
            assert_eq!(
                String::from_utf8_lossy(&run.stdout).trim(),
                "the-agent-itself",
                "{shell} should have gone on to start the agent"
            );
        }
    }

    /// The shape of the thing being killed.
    ///
    /// Started by a shell that then exits, so it is nobody's child, in nobody's
    /// foreground process group, and reparented to init the moment it exists —
    /// which is what a `wrangler dev` or a backgrounded `npm run dev` looks
    /// like a second after the agent started it. Its own output goes nowhere,
    /// because a process holding the pipe `output()` is reading would hang this
    /// test rather than outlive it.
    fn detached() -> i32 {
        let started = std::process::Command::new("sh")
            .args(["-c", "sleep 60 >/dev/null 2>&1 </dev/null & echo $!"])
            .output()
            .expect("the shell should run");

        String::from_utf8_lossy(&started.stdout)
            .trim()
            .parse()
            .expect("the shell should have said the pid")
    }

    /// Signal 0 is the kernel being asked whether a pid is there, which is the
    /// only question these tests have about a process they did not start.
    fn alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Dying takes a moment even when the signal does not. Orphans are reaped
    /// by init as they go, so this settles in milliseconds or not at all.
    async fn gone(pid: i32) -> bool {
        for _ in 0..40 {
            if !alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        false
    }

    /// Asking the workspace cgroup alone would find nothing to kill, every
    /// time: the panes are a level down in `agents/` and a container is a
    /// level down in whatever the daemon named it. The walk is what makes the
    /// cgroup a handle on the whole workspace.
    #[tokio::test]
    async fn processes_are_found_in_the_cgroups_under_a_workspace_as_well() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("cgroup.procs"), "")
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join("agents"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("agents/cgroup.procs"), "111\n222\n")
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join("docker-abc.scope"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("docker-abc.scope/cgroup.procs"), "333\n")
            .await
            .unwrap();

        let mut found = members(dir.path()).await;
        found.sort_unstable();
        assert_eq!(found, vec![111, 222, 333]);
    }

    /// On a kernel that has `cgroup.kill`, that is the whole of it: one write,
    /// the subtree goes, and nothing is signalled by pid — which is what makes
    /// it proof against something forking while a list is worked through.
    ///
    /// Shown by what does *not* die. An ordinary directory is not a cgroup, so
    /// writing to the file here kills nothing, and a process that is still
    /// running afterwards is the evidence that no pid was signalled by hand.
    #[tokio::test]
    async fn a_kernel_that_can_kill_a_subtree_is_asked_to() {
        let dir = tempfile::tempdir().unwrap();
        let pid = detached();
        tokio::fs::write(dir.path().join("cgroup.procs"), format!("{pid}\n"))
            .await
            .unwrap();
        // Present is the only thing this file says about a kernel from here.
        tokio::fs::write(dir.path().join("cgroup.kill"), "")
            .await
            .unwrap();

        sigkill(dir.path(), &members(dir.path()).await).await;

        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("cgroup.kill"))
                .await
                .unwrap(),
            "1"
        );
        assert!(
            alive(pid),
            "the pids should not have been signalled as well"
        );
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }

    /// And on one that does not, the processes are signalled one at a time.
    /// A directory with no `cgroup.kill` in it is what a 5.10 kernel looks
    /// like from here, and the process is a real one so that the fallback has
    /// to actually work rather than merely be reached.
    #[tokio::test]
    async fn an_older_kernel_has_its_processes_killed_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let pid = detached();
        tokio::fs::write(dir.path().join("cgroup.procs"), format!("{pid}\n"))
            .await
            .unwrap();

        sigkill(dir.path(), &members(dir.path()).await).await;

        assert!(
            gone(pid).await,
            "a detached process should not survive its workspace"
        );
    }

    /// Two sessions starting at once must not take each other's answer away.
    ///
    /// The probe used to be one directory for the whole machine, and this is
    /// the shape of what that cost: 80 callers at once, 51 of which were told
    /// the host had no cgroups because somebody else had just removed the
    /// directory they were both using. What makes it worth a test rather than
    /// a comment is where that `false` lands — `create` bails, the workspace
    /// gets no cgroup, and teardown has nothing to kill.
    ///
    /// Consistency is the assertion, because the right answer differs by
    /// machine: `true` on a worker, `false` on a laptop, and the same both
    /// ways however many ask at once.
    #[test]
    fn two_sessions_asking_at_once_get_the_same_answer() {
        let alone = available();

        let answers: Vec<bool> = std::thread::scope(|scope| {
            let asking: Vec<_> = (0..80).map(|_| scope.spawn(available)).collect();
            asking
                .into_iter()
                .map(|ask| ask.join().expect("the thread should not panic"))
                .collect()
        });

        let wrong = answers.iter().filter(|answer| **answer != alone).count();
        assert_eq!(
            wrong, 0,
            "{wrong} of 80 concurrent calls disagreed with {alone}"
        );

        // And nothing of ours left in the hierarchy on the way through.
        let ours = format!("ft-probe-{}-", std::process::id());
        let left: Vec<String> = std::fs::read_dir(ROOT)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(&ours))
            .collect();
        assert!(left.is_empty(), "probes left behind: {left:?}");
    }

    /// A number out of `cgroup.procs` is not necessarily a pid, and `kill` is
    /// not forgiving about the difference: `0` is every process in the
    /// worker's own process group, and a negative number is a process group of
    /// its own. A process in another pid namespace reads as `0` from here.
    ///
    /// What this asserts is that the test survived at all, with a process of
    /// ours alongside it: without the guard, `kill(0, SIGKILL)` would take the
    /// test runner and everything beside it, which is exactly what it would do
    /// to a worker.
    #[tokio::test]
    async fn a_number_that_is_not_a_pid_is_never_signalled() {
        let dir = tempfile::tempdir().unwrap();
        let bystander = detached();

        // No `cgroup.kill` in this directory, so this is the path where a
        // number from the file becomes an argument to `kill`. `-12345` stands
        // for the negatives; `-1`, which means every process this user owns,
        // is not a thing to write into a test on somebody's laptop.
        tokio::fs::write(dir.path().join("cgroup.procs"), "0\n-12345\n")
            .await
            .unwrap();

        sigkill(dir.path(), &members(dir.path()).await).await;

        assert!(
            alive(bystander),
            "a process in the worker's own group must not be swept up"
        );
        unsafe { libc::kill(bystander, libc::SIGKILL) };
    }

    /// The leak, against the kernel: a process that outlived the shell that
    /// started it, a teardown that used to leave it running, and the same
    /// teardown with the kill in it.
    ///
    /// Skipped where there are no cgroups to make — a macOS worker, a
    /// container without the delegation — which is the same question `create`
    /// asks before it does anything. The three tests above are what runs
    /// there, against a directory shaped like a cgroup.
    #[tokio::test]
    async fn a_real_cgroup_gives_up_its_processes_and_then_itself() {
        if !available() {
            eprintln!("no cgroup v2 to write to here; skipping");
            return;
        }

        let session = SessionId::new();
        // A workspace that was never on disk. What names the cgroup is the
        // last component of the path and nothing here reads the directory, so
        // the pid keeps two of these from colliding on a busy machine.
        let workspace = std::env::temp_dir().join(format!("ft-killtest-{}", std::process::id()));
        assert!(create(&workspace, Limits::default()).await);

        // Put in the cgroup the way a pane puts itself in one, and then
        // orphaned: the shell that joined is gone, and nothing but the
        // membership connects what it left behind to the workspace.
        let procs = agents_dir(&workspace).join("cgroup.procs");
        let started = std::process::Command::new("sh")
            .args([
                "-c",
                &format!(
                    "echo $$ > {}; sleep 60 >/dev/null 2>&1 </dev/null & echo $!",
                    procs.display()
                ),
            ])
            .output()
            .expect("the shell should run");
        let pid: i32 = String::from_utf8_lossy(&started.stdout)
            .trim()
            .parse()
            .expect("the shell should have said the pid");

        assert!(
            members(&dir(&workspace)).await.contains(&pid),
            "the cgroup should hold what the shell left behind"
        );

        // Teardown as it was: `rmdir` on a cgroup with processes in it fails
        // with EBUSY, so the directory stays and so does everything in it.
        // This is the whole bug in three lines.
        remove(&workspace, &session).await;
        assert!(alive(pid), "removing a cgroup does not kill what is in it");
        assert!(dir(&workspace).exists(), "and cannot remove it either");

        kill(&workspace, &session).await;
        assert!(
            gone(pid).await,
            "the workspace should take its processes with it"
        );

        remove(&workspace, &session).await;
        assert!(
            !dir(&workspace).exists(),
            "and an empty cgroup should go rather than be left behind"
        );
    }
}
