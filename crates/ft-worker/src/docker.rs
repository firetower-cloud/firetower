//! The Docker daemon this worker has, and what a session leaves behind in it.
//!
//! ## Not ours to start
//!
//! The daemon belongs to the container, started by its entrypoint before this
//! binary exists. It has to: `firetower-worker --stdio` is one process per
//! control-plane connection and dies with it, so a daemon parented here would
//! take every running compose stack down on each reconnect — the thing tmux
//! exists to prevent. What this module does is *observe* it, which is the part
//! that was actually worth knowing, and clear up after the sessions that used
//! it.
//!
//! ## One daemon, many sessions
//!
//! A worker container is created per **host**, not per session, and every
//! session on that host shares this daemon. Two consequences that are stated
//! rather than hidden — in the workspace guide an agent reads, and in the
//! documentation:
//!
//! - The published-port space is shared. Two sessions both mapping `3000:3000`
//!   collide, and the second one to start is the one that fails.
//! - `docker ps` in one session lists another session's containers.
//!
//! Which is why teardown cannot be "remove the container it ran in" — there
//! isn't one. It is [`sweep`], by label, and everything a session starts has
//! to carry one for that to work.

use ft_core::{DockerState, SessionId};
use tokio::process::Command;

/// Where the entrypoint leaves the daemon's output.
///
/// Read when the daemon is not answering, because "cannot connect" says only
/// that and the reason is always in here.
const DAEMON_LOG: &str = "/var/log/firetower/dockerd.log";

/// The label every resource belonging to a session carries.
///
/// Compose sets its own project label and this is swept alongside it, so an
/// agent running a bare `docker run` has a way to have its containers cleared
/// up too. Named in the workspace guide for exactly that reason.
pub const SESSION_LABEL: &str = "com.firetower.session";

/// What Compose labels a session's resources with, via `COMPOSE_PROJECT_NAME`.
const COMPOSE_LABEL: &str = "com.docker.compose.project";

/// Re-exported so this module reads as one thing. Defined in `ft-core`,
/// which is the crate both the worker and the control plane share — see
/// [`ft_core::DOCKER_ENV`] for what it is and who reads it.
pub use ft_core::DOCKER_ENV;

/// How long any one Docker command gets before we give up on it.
///
/// **Not decoration.** A daemon that is wedged rather than absent accepts a
/// connection on its socket and then never answers, and the client waits for
/// it indefinitely. Both callers here are on paths that must not stall: the
/// handshake, where hanging means the control plane sees a worker that never
/// says hello and marks the host unreachable — and teardown, where it means a
/// session stuck in `Ending` with its worktree still on disk.
///
/// Generous, because the answer is worth waiting a moment for. A healthy
/// daemon answers `docker info` in well under a second.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(20);

/// Run a Docker command, or give up on it.
///
/// The timeout is the point — see [`PATIENCE`]. `Ok(None)` is "it did not
/// answer in time", which every caller has to treat as an answer rather than
/// as an error to propagate.
async fn run(command: &mut Command) -> std::io::Result<Option<std::process::Output>> {
    // Nulled, not inherited. `tokio`'s `output()` leaves stdin alone, and on
    // the handshake path this process's stdin is the frame pipe from the
    // control plane — see the same reasoning in `runtime::install`.
    command.stdin(std::process::Stdio::null());

    match tokio::time::timeout(PATIENCE, command.output()).await {
        Ok(result) => result.map(Some),
        Err(_) => Ok(None),
    }
}

/// The Compose project name for a session.
///
/// Per session, because the project name is what Compose scopes containers,
/// networks and volumes by — two sessions running the same `compose.yaml` on
/// one worker would otherwise be one stack that both of them think is theirs,
/// and the second `up` would adopt and restart the first one's containers.
///
/// Compose accepts lowercase letters, digits, dashes and underscores, and
/// wants a letter or digit first. A session id is already `s_` and a lowercase
/// ULID, so this only has to guard against a shape that changes later.
pub fn project(session: &SessionId) -> String {
    let cleaned: String = session
        .as_str()
        .chars()
        .map(|c| match c {
            'a'..='z' | '0'..='9' | '-' | '_' => c,
            'A'..='Z' => c.to_ascii_lowercase(),
            _ => '-',
        })
        .collect();
    format!("ft-{cleaned}")
}

/// Whether a session on this machine can run containers.
///
/// Asked of the daemon rather than of the filesystem: a socket that exists and
/// a daemon that answers are different things, and it is the second one a
/// `docker compose up` needs.
pub async fn state() -> DockerState {
    // Turned off deliberately, and that is not the same as broken.
    //
    // Without this the answer would be `Stopped`, because the client is in the
    // image and finds nothing behind the socket — and a session would be told
    // its machine has a fault and to report it, about a setting somebody chose
    // on purpose. `Absent` is what "there is no Docker here" means, and this
    // is that.
    //
    // Readable because the control plane passes it into the container, and
    // `docker exec` gives this process the container's environment.
    if std::env::var(DOCKER_ENV).is_ok_and(|v| v.eq_ignore_ascii_case("off")) {
        return DockerState {
            status: ft_core::DockerStatus::Absent,
            detail: Some("Docker is turned off for this worker".into()),
        };
    }

    let mut command = Command::new("docker");
    command.args(["info", "--format", "{{.ServerVersion}}"]);

    let output = match run(&mut command).await {
        Ok(Some(o)) => o,
        // Wedged rather than absent: the socket is there and nothing behind it
        // is answering. Named as its own reason, because "the daemon did not
        // answer" sends somebody to `systemctl status` and the client's own
        // wording for this is nothing at all.
        Ok(None) => {
            return DockerState::stopped(format!(
                "the daemon accepted a connection and did not answer within {}s",
                PATIENCE.as_secs()
            ))
        }
        // Nothing to run. A worker that only ever serves terminals and git is
        // a working worker, so this is a plain answer and not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return DockerState::absent(),
        Err(e) => return DockerState::stopped(format!("could not run docker: {e}")),
    };

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !version.is_empty() {
            return DockerState::running(version);
        }
    }

    DockerState::stopped(why_not(&String::from_utf8_lossy(&output.stderr)).await)
}

/// The most useful sentence available about a daemon that isn't answering.
///
/// The client's own message is nearly always "Cannot connect to the Docker
/// daemon", which names the symptom and never the cause. The daemon's log has
/// the cause, and on a worker it is somewhere known — so it is read first and
/// the client's wording is the fallback.
async fn why_not(stderr: &str) -> String {
    if let Ok(log) = tokio::fs::read_to_string(DAEMON_LOG).await {
        // The last line that looks like a complaint. dockerd's ordinary
        // start-up chatter is long, and the failure is at the end of it.
        let last = log
            .lines()
            .rev()
            .find(|l| {
                let l = l.to_lowercase();
                l.contains("error") || l.contains("failed") || l.contains("firetower:")
            })
            .map(str::trim);
        if let Some(line) = last.filter(|l| !l.is_empty()) {
            return trim_to(line, 300);
        }
    }

    let said = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("the daemon did not answer");
    trim_to(said, 300)
}

fn trim_to(text: &str, most: usize) -> String {
    match text.char_indices().nth(most) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// Remove everything a session started in this daemon.
///
/// **Best effort, and deliberately so.** This runs on the teardown path beside
/// killing tmux and reclaiming the worktree, and a daemon that is not
/// answering must not be able to strand a session in `Ending`. What it cannot
/// remove it says out loud, because a leaked container is disk and a port that
/// never come back on their own.
///
/// Ordering matters: containers first, because a network or a volume still
/// attached to a running container refuses to go.
pub async fn sweep(session: &SessionId) {
    // Asked once rather than discovered six times.
    //
    // Every session on a worker without Docker ends through here, and the loop
    // below would spawn a client per kind per filter to be told the same thing
    // each time. This is one spawn — and on a machine with no client at all it
    // is not even that, because the process fails to start.
    let state = state().await;
    if !state.usable() {
        tracing::debug!(session = %session, "nothing to sweep: {}", state.summary());
        return;
    }

    // Two filters rather than one, and not one command: `--filter` is AND, so
    // asking for both labels at once finds only resources carrying both, which
    // is nothing. Compose stamps its own, an agent following the workspace
    // guide stamps ours.
    let filters = [
        format!("label={COMPOSE_LABEL}={}", project(session)),
        format!("label={SESSION_LABEL}={}", session.as_str()),
    ];

    for kind in ["container", "network", "volume"] {
        for filter in &filters {
            let found = match list(kind, filter).await {
                Ok(ids) => ids,
                Err(e) => {
                    // Once per kind at debug: on a worker with no Docker this
                    // is every teardown, and it is not news.
                    tracing::debug!(session = %session, kind, "listing to sweep: {e:#}");
                    continue;
                }
            };
            if found.is_empty() {
                continue;
            }

            let removed = remove(kind, &found).await;
            match removed {
                Ok(()) => tracing::info!(
                    session = %session,
                    kind,
                    count = found.len(),
                    "swept what the session left in Docker"
                ),
                Err(e) => tracing::warn!(
                    session = %session,
                    kind,
                    "could not remove {} {kind}(s) this session left: {e:#}",
                    found.len()
                ),
            }
        }
    }
}

async fn list(kind: &str, filter: &str) -> anyhow::Result<Vec<String>> {
    let mut command = Command::new("docker");
    command
        .arg(kind)
        .arg("ls")
        .arg("-q")
        .arg("--filter")
        .arg(filter);
    // Only containers have a stopped state to be missed by a default listing.
    if kind == "container" {
        command.arg("-a");
    }

    let out = run(&mut command)
        .await
        .map_err(|e| anyhow::anyhow!("running docker: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("the daemon did not answer in {}s", PATIENCE.as_secs()))?;

    if !out.status.success() {
        anyhow::bail!(
            "docker refused: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }

    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

async fn remove(kind: &str, ids: &[String]) -> anyhow::Result<()> {
    let mut command = Command::new("docker");
    command.arg(kind).arg("rm");

    match kind {
        // `--volumes` collects the anonymous volumes a container declared,
        // which nothing else ever would.
        "container" => {
            command.arg("--force").arg("--volumes");
        }
        "volume" => {
            command.arg("--force");
        }
        // Not networks. `docker network rm` only grew `--force` in Engine 25,
        // and all it does there is forgive a network that is already gone —
        // which cannot happen to one we listed a moment ago. Passing it would
        // trade nothing for a failure on an older daemon.
        _ => {}
    }

    command.args(ids);

    let out = run(&mut command)
        .await
        .map_err(|e| anyhow::anyhow!("running docker: {e}"))?
        .ok_or_else(|| anyhow::anyhow!("the daemon did not answer in {}s", PATIENCE.as_secs()))?;

    if !out.status.success() {
        anyhow::bail!(
            "docker refused: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two sessions running the same compose.yaml on one worker must not be
    /// one stack. Compose adopts by project name, so the second `up` would
    /// restart the first session's containers under it.
    #[test]
    fn each_session_is_its_own_compose_project() {
        let a = SessionId::new();
        let b = SessionId::new();
        assert_ne!(project(&a), project(&b));
    }

    /// Compose wants a letter or digit first and a restricted alphabet after.
    /// A session id satisfies that today; this is what notices if it stops to.
    #[test]
    fn a_project_name_is_one_compose_will_accept() {
        let name = project(&SessionId::from_stored("s_01ARZ3NDEKTSV4RRFFQ69G5FAV"));

        assert!(
            name.chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric()),
            "{name}"
        );
        assert!(
            name.chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
            "{name}"
        );
    }

    /// An id in a shape nobody has used yet still has to come out usable,
    /// rather than making a project name Compose rejects at the worst moment.
    #[test]
    fn an_unexpected_id_is_cleaned_rather_than_passed_through() {
        let name = project(&SessionId::from_stored("Weird/Id With Spaces"));
        assert_eq!(name, "ft-weird-id-with-spaces");
    }

    /// A worker with no Docker is a working worker, and has to say so as a
    /// fact rather than as a failure.
    ///
    /// Asserted against whatever this machine actually has, because the answer
    /// is about a machine and there is no honest way to fake one. Both
    /// outcomes are correct; what this catches is `state()` panicking, hanging
    /// or reporting `Running` on a machine where nothing answered.
    #[tokio::test]
    async fn asking_a_machine_about_docker_always_gets_an_answer() {
        let state = super::state().await;
        match state.status {
            ft_core::DockerStatus::Running => {
                assert!(state.detail.is_some_and(|v| !v.is_empty()), "which version");
            }
            ft_core::DockerStatus::Stopped => {
                assert!(
                    state.detail.is_some_and(|v| !v.is_empty()),
                    "a no must say why"
                );
            }
            ft_core::DockerStatus::Absent => {}
            ft_core::DockerStatus::Unknown => panic!("having asked, we know something"),
        }
        assert!(!super::state().await.summary().is_empty());
    }

    #[test]
    fn a_long_reason_is_shortened_rather_than_carried_whole() {
        let long = "x".repeat(1000);
        let short = trim_to(&long, 300);
        assert!(short.chars().count() <= 301, "{}", short.chars().count());
        assert!(short.ends_with('…'));
    }

    /// Only "Running" means a session can be told to use it. "Unknown" in
    /// particular must not read as yes.
    #[test]
    fn only_a_daemon_that_answered_counts_as_usable() {
        assert!(DockerState::running("27.0.3").usable());
        assert!(!DockerState::default().usable());
        assert!(!DockerState::absent().usable());
        assert!(!DockerState::stopped("no").usable());
    }
}
