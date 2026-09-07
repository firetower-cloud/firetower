//! The worker containers Firetower runs on this machine.
//!
//! Lifecycle rather than transport: `DockerTransport` knows how to talk to a
//! container, and this knows how one comes to exist. It sits beside the
//! transport rather than inside a request handler, because bringing up compute
//! is not something the HTTP layer should know how to do.
//!
//! Firetower owns the containers it creates. One it merely found running is
//! left alone rather than silently adopted.
//!
//! ## Why these containers are privileged
//!
//! A session's whole value is being able to run what the repository runs, and
//! for most repositories worth pointing an agent at that is `docker compose
//! up`. So the worker runs a Docker daemon of its own, and a daemon inside a
//! container needs privileges an ordinary container does not have.
//!
//! It has to be a daemon *inside this container* rather than the machine's
//! own. [`ft_worker::tunnel`] connects to `127.0.0.1` and only ever
//! `127.0.0.1` — `TunnelOpen` carries a port and no host, deliberately — so a
//! preview reaches a compose service only if that service's port was published
//! into this container's network namespace. A daemon on the host publishes on
//! the host, where the worker's loopback cannot see it, and the preview would
//! find nothing listening.
//!
//! **What this costs.** A privileged container can become root on the machine
//! running it. The boundary that matters is therefore the machine's, not the
//! container's: a worker host should be a VM dedicated to running agents, and
//! anything else on it should be treated as reachable from any session. That
//! is a defensible arrangement — it is roughly how per-job CI runners work —
//! but it is an arrangement somebody has to have chosen, so it is written
//! here, in `deploy/firetower-worker.yml`, and in the documentation.
//!
//! **Where it stops being defensible** is a machine whose sessions belong to
//! people who do not own it. [`DOCKER_ENV`] turns it off for that case: the
//! container comes up exactly as it did before, serving terminals and git,
//! with no Docker inside and a session that says so rather than failing at a
//! shell prompt.

use anyhow::{Context, Result};
use tokio::process::Command;

/// Turns the daemon inside worker containers off.
///
/// Any value but `off` leaves it on, because the useful configuration is the
/// default one and a typo here should not quietly remove a feature.
///
/// Re-exported rather than declared: the worker reads the same variable inside
/// the container it is passed into, and two spellings of one contract is a
/// setting that appears to be ignored.
///
/// From `ft-core` rather than from `ft-worker`, which is only a dev-dependency
/// here — reaching for it compiles under `cargo test` and breaks every other
/// build of this crate.
pub use ft_core::DOCKER_ENV;

/// Whether workers this control plane creates run a Docker daemon.
fn docker_wanted() -> bool {
    !std::env::var(DOCKER_ENV).is_ok_and(|v| v.eq_ignore_ascii_case("off"))
}

/// The ceiling an operator put on a worker, if they put one there.
///
/// Blank is the same as unset. An operator who cleared the variable meant to
/// turn it off, and `--memory ""` is an error rather than a worker with no
/// limit.
fn memory_wanted() -> Option<String> {
    let said = std::env::var(ft_core::WORKER_MEMORY_ENV).ok()?;
    let said = said.trim();
    (!said.is_empty()).then(|| said.to_string())
}

/// Where a worker's image cache lives, keyed to the worker.
///
/// Named, and per worker rather than shared: two workers on one machine are
/// two daemons, and a daemon does not share `/var/lib/docker` with another
/// one — they would corrupt each other's metadata.
pub(crate) fn cache_volume(name: &str) -> String {
    format!("firetower-docker-{name}")
}

/// Bring up a worker container, or reuse the one that's already running.
pub(crate) async fn start(image: &str, name: &str) -> Result<()> {
    // Checked before running anything, because Docker's own answer is to try
    // pulling from a registry this image was never published to — and "pull
    // access denied" sends you looking for a login you don't need.
    let present = Command::new("docker")
        .args(["image", "inspect", image])
        .output()
        .await
        .context("is Docker running?")?;

    if !present.status.success() {
        anyhow::bail!(
            "the worker image {image} hasn't been built yet. Run `just worker-image` \
             — it takes a few minutes the first time and is cached after."
        );
    }

    let running = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", name])
        .output()
        .await
        .context("is Docker running?")?;

    match String::from_utf8_lossy(&running.stdout).trim() {
        "true" => return Ok(()),
        "false" => {
            Command::new("docker")
                .args(["start", name])
                .output()
                .await?;
            return Ok(());
        }
        _ => {}
    }

    let created = Command::new("docker")
        .args(run_args(image, name, docker_wanted()))
        .output()
        .await
        .context("starting the worker container")?;

    if !created.status.success() {
        let said = String::from_utf8_lossy(&created.stderr);
        anyhow::bail!("{}", refusal(&said));
    }
    Ok(())
}

/// What `docker run` said, turned into something to do about it.
///
/// One case is worth naming. A machine configured to refuse privileged
/// containers — a hardened daemon, some managed hosts, a rootless daemon —
/// says so in a way that reads as a bug in Firetower, and the answer is a
/// setting rather than a fix. Everything else is passed through: a wrong guess
/// in front of the real text sends somebody to the wrong place.
fn refusal(stderr: &str) -> String {
    let said = stderr.trim();
    let lowered = said.to_lowercase();

    if lowered.contains("privileged") {
        return format!(
            "this machine will not run privileged containers, which is what a worker \
             needs to run Docker inside a session. Set {DOCKER_ENV}=off on the control \
             plane to create workers without it — sessions there serve terminals, git \
             and agents as before, and simply have no Docker.\n\ndocker said: {said}"
        );
    }

    format!("docker refused: {said}")
}

/// The whole `docker run`, as one list, so that what a worker is created with
/// can be asserted rather than described.
fn run_args(image: &str, name: &str, docker: bool) -> Vec<String> {
    let mut args: Vec<String> = ["run", "-d", "--name", name]
        .iter()
        .map(|s| s.to_string())
        .collect();

    // An init as pid 1, to reap what the daemon leaves behind.
    //
    // The command below is `sleep infinity`, which reaps nothing. dockerd's
    // children — containerd, and a shim per container — reparent to pid 1
    // when they exit, and a session that starts and stops containers all day
    // would leave a growing pile of zombies on a worker that stays up for
    // weeks. `--init` puts tini in front and costs nothing when there is no
    // daemon to leave anything.
    args.push("--init".into());

    if docker {
        // See this module's header for what this is and what it costs.
        args.push("--privileged".into());

        // The daemon's own storage, on a volume rather than on the container's
        // filesystem.
        //
        // **Not an optimisation — a requirement.** A daemon writing its
        // overlay filesystem onto the overlay filesystem it is itself running
        // on is the classic nested-Docker failure, and it fails in ways that
        // read as a broken image rather than a bad mount.
        //
        // That it also keeps the cache is the second reason, and the one
        // somebody notices: upgrading Firetower recreates this container, and
        // without the volume every release would cost every worker a fresh
        // pull of postgres, node and everything else a session had built up.
        //
        // It does not outlive the worker. `remove()` deletes it, because a
        // person who removed a host has said what they want and gigabytes left
        // behind on their disk is not it.
        args.push("-v".into());
        args.push(format!("{}:/var/lib/docker", cache_volume(name)));
    } else {
        // Told rather than inferred. The entrypoint would otherwise start a
        // daemon that cannot work and leave a failure in the log that looks
        // like a fault instead of a setting.
        args.push("-e".into());
        args.push(format!("{DOCKER_ENV}=off"));
    }

    // What this worker may take of its machine. See `WORKER_MEMORY_ENV` for
    // why a machine with one worker on it still wants a number here.
    //
    // Swap is pinned to the same figure, which turns it off for this container
    // rather than leaving Docker's default of twice the limit. A worker allowed
    // to swap does not fail when it goes over — it gets slow enough that
    // everything in it looks broken, which is a worse way to find out.
    if let Some(memory) = memory_wanted() {
        args.push("--memory".into());
        args.push(memory.clone());
        args.push("--memory-swap".into());
        args.push(memory);
    }

    args.push(image.to_string());
    args.extend(["sleep", "infinity"].iter().map(|s| s.to_string()));
    args
}

/// Stop and remove a worker container, the anonymous volume holding its
/// worktrees, and the image cache it built up. Absent is success — the wanted
/// state is "not there".
pub(crate) async fn remove(name: &str) -> Result<()> {
    let removed = Command::new("docker")
        .args(["rm", "--force", "--volumes", name])
        .output()
        .await
        .context("is Docker running?")?;

    let stderr = String::from_utf8_lossy(&removed.stderr);
    if !removed.status.success() && !stderr.contains("No such container") {
        anyhow::bail!("docker refused: {}", stderr.trim());
    }

    // Separately, because `--volumes` above removes only anonymous ones and
    // this is named — it has to be, to survive the container being recreated
    // to upgrade it.
    //
    // Best effort, and after the container is gone rather than before: a
    // cache we could not delete is disk to reclaim by hand, not a reason to
    // keep a host nobody wants. `docker volume rm` on a volume that was never
    // created is the ordinary case for a worker that ran with Docker off.
    let volume = cache_volume(name);
    let dropped = Command::new("docker")
        .args(["volume", "rm", "--force", &volume])
        .output()
        .await;
    match dropped {
        Ok(out) if !out.status.success() => tracing::warn!(
            %volume,
            "the worker's image cache is still on disk: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ),
        Err(e) => tracing::warn!(%volume, "removing the worker's image cache: {e:#}"),
        Ok(_) => {}
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The environment is process-wide and these tests set it. Taken by every
    /// test that reads `WORKER_MEMORY_ENV`, so two of them cannot interleave a
    /// set with a read.
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The three things a session needs to run a compose stack, and the one
    /// that keeps a worker from filling up with zombies.
    /// Unset is unlimited, which is what every worker created before there was
    /// a setting had — so an operator who has not asked for one gets exactly
    /// the command they got last release.
    #[test]
    fn a_worker_has_no_ceiling_unless_an_operator_sets_one() {
        // Guarded: `set_var` is process-wide, and these run in one process.
        let _guard = env_lock();
        std::env::remove_var(ft_core::WORKER_MEMORY_ENV);
        let args = run_args("img", "w", true);
        assert!(!args.contains(&"--memory".to_string()), "{args:?}");
    }

    #[test]
    fn a_ceiling_is_passed_through_with_swap_pinned_to_it() {
        let _guard = env_lock();
        std::env::set_var(ft_core::WORKER_MEMORY_ENV, "17g");
        let args = run_args("img", "w", true);
        let at = args.iter().position(|a| a == "--memory").expect("--memory");
        assert_eq!(args[at + 1], "17g");
        // Left to Docker's default this would be twice the limit, and a worker
        // that swaps instead of failing is a worker everything in looks broken.
        let swap = args
            .iter()
            .position(|a| a == "--memory-swap")
            .expect("swap");
        assert_eq!(args[swap + 1], "17g");
        std::env::remove_var(ft_core::WORKER_MEMORY_ENV);
    }

    /// An operator who emptied the variable meant to turn it off. `--memory ""`
    /// is a worker that refuses to start.
    #[test]
    fn an_empty_ceiling_is_no_ceiling() {
        let _guard = env_lock();
        std::env::set_var(ft_core::WORKER_MEMORY_ENV, "   ");
        let args = run_args("img", "w", true);
        assert!(!args.contains(&"--memory".to_string()), "{args:?}");
        std::env::remove_var(ft_core::WORKER_MEMORY_ENV);
    }

    #[test]
    fn a_worker_that_runs_docker_is_privileged_with_its_own_cache() {
        let args = run_args("firetower/worker:dev", "fire-01", true);

        assert!(args.contains(&"--privileged".to_string()));
        assert!(args.contains(&"--init".to_string()));
        assert!(
            args.contains(&"firetower-docker-fire-01:/var/lib/docker".to_string()),
            "the daemon needs a volume, not the container's own overlay: {args:?}"
        );

        // The image and the command still come last, in that order — a flag
        // added after them would be read as an argument to `sleep`.
        let image = args.iter().position(|a| a == "firetower/worker:dev");
        let sleep = args.iter().position(|a| a == "sleep");
        assert!(image < sleep, "{args:?}");
        assert_eq!(args.last().map(String::as_str), Some("infinity"));
    }

    /// Turning Docker off must not turn the worker off with it.
    #[test]
    fn a_worker_without_docker_still_comes_up() {
        let args = run_args("firetower/worker:dev", "fire-01", false);

        assert!(
            !args.contains(&"--privileged".to_string()),
            "this is the whole point of the setting: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a.contains("/var/lib/docker")),
            "no daemon, so nothing to give a volume to: {args:?}"
        );
        assert!(
            args.contains(&format!("{DOCKER_ENV}=off")),
            "the entrypoint has to be told, or it tries and logs a failure"
        );

        // Still a worker: same image, same command, still running.
        assert!(args.contains(&"firetower/worker:dev".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("infinity"));
    }

    /// A machine that refuses privileged containers is a setting away from
    /// working, and the message has to say which setting.
    #[test]
    fn a_machine_that_refuses_privilege_is_told_what_to_change() {
        let said = refusal(
            "docker: Error response from daemon: privileged mode is not allowed on this host.",
        );

        assert!(said.contains(DOCKER_ENV), "{said}");
        assert!(
            said.contains("privileged mode is not allowed"),
            "the real text has to survive the explanation: {said}"
        );
    }

    /// Everything else is handed over as it came. A wrong guess in front of
    /// the real reason sends somebody to the wrong machine.
    #[test]
    fn an_unrecognised_refusal_is_not_guessed_at() {
        let said = refusal("Error response from daemon: no space left on device");
        assert_eq!(
            said,
            "docker refused: Error response from daemon: no space left on device"
        );
    }

    /// Two workers on one machine are two daemons, and one `/var/lib/docker`
    /// between them is mutual corruption rather than a shared cache.
    #[test]
    fn each_worker_gets_its_own_cache() {
        assert_ne!(cache_volume("fire-01"), cache_volume("fire-02"));
        assert!(cache_volume("fire-01").starts_with("firetower-docker-"));
    }
}
