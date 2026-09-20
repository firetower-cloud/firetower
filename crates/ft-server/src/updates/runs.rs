//! Carrying out an upgrade, one step at a time, surviving one's own restart.
//!
//! A run is made with its steps already written down, in the order they
//! happen: check, back up, the updater, the control plane, then each worker.
//! The executor walks them, writing what happened to each into the database
//! as it goes. That is what makes the middle of a run survivable — the
//! control plane step ends this process, and [`resume`] on the next start
//! finds the row that says which job to ask the updater about.
//!
//! **Control plane first, then workers.** A worker newer than the control
//! plane is the same protocol mismatch as one older, so nothing moves a worker
//! ahead. Between the two, older workers show the mismatch the handshake
//! already reports; the run's own screen says it is expected.
//!
//! Every host a run drains, it puts back — on success, failure, cancellation
//! and after a restart — unless it was drained before the run touched it.

use super::store::{Run, Step, Store};
use super::{version, RunState, StepState};
use crate::AppState;
use anyhow::{anyhow, Context, Result};
use ft_updater_api::{JobKind, JobState};
use std::time::Duration;

/// The step targets, as written in the database.
pub const PREFLIGHT: &str = "preflight";
pub const BACKUP: &str = "backup";
pub const UPDATER: &str = "updater";
pub const CONTROL_PLANE: &str = "control_plane";
pub const HOST_PREFIX: &str = "host:";

/// How long a reinstalled worker has to come back and shake hands.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(180);
/// How long the updater has to finish a backup.
const BACKUP_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the updater has to come back as the new version.
const UPDATER_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long this process waits for its own recreate before deciding it is
/// not going to happen.
const RECREATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// After a restart, how long the updater has to answer about the job.
const RESUME_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How many times a step is walked into before a run gives up on it.
///
/// Only reached by restarting in the middle of the same step that many times,
/// which is a control plane that cannot stay up rather than an upgrade that
/// cannot be done.
const MOST_ATTEMPTS: i32 = 3;

/// The steps a run has, in order.
pub fn steps_for(
    targets: &super::store::Targets,
    host_names: &[(String, String)],
) -> Vec<(String, String)> {
    let mut steps = vec![(
        PREFLIGHT.to_string(),
        "Check the updater and the machines".to_string(),
    )];
    if targets.control_plane {
        steps.push((BACKUP.into(), "Back up the database".into()));
        steps.push((UPDATER.into(), "Upgrade the updater".into()));
        steps.push((CONTROL_PLANE.into(), "Upgrade the control plane".into()));
    }
    for id in &targets.host_ids {
        let name = host_names
            .iter()
            .find(|(hid, _)| hid == id)
            .map(|(_, n)| n.clone())
            .unwrap_or_else(|| id.clone());
        steps.push((format!("{HOST_PREFIX}{id}"), format!("Upgrade {name}")));
    }
    steps
}

/// Drive a run on a task of its own. Idempotent: a run already being driven
/// by this process is left to it.
pub async fn spawn(state: AppState, run_id: String) {
    {
        let mut driving = state.updates.driving.lock().await;
        if !driving.insert(run_id.clone()) {
            return;
        }
    }
    tokio::spawn(async move {
        let store = state.updates.store.clone();
        if let Err(e) = drive(&state, &store, &run_id).await {
            tracing::error!(run = %run_id, "upgrade run failed: {e:#}");
            let _ = store.skip_pending(&run_id).await;
            let _ = store
                .finish_run(&run_id, RunState::Failed, Some(format!("{e:#}")))
                .await;
            put_back(&state, &store, &run_id).await;
        }
        state.updates.driving.lock().await.remove(&run_id);
    });
}

async fn drive(state: &AppState, store: &Store, run_id: &str) -> Result<()> {
    let run = store.run(run_id).await?.context("no such run")?;
    if run.state.is_over() {
        return Ok(());
    }
    // Somebody has to say whether to go on without a backup. Nothing decides
    // that on its own, including a restart of this process.
    if run.state == RunState::WaitingDecision {
        return Ok(());
    }

    if run.when_idle && matches!(run.state, RunState::Planned | RunState::WaitingIdle) {
        store.set_run_state(run_id, RunState::WaitingIdle).await?;
        drain_targets(state, store, &run).await?;
        loop {
            if is_cancelled(store, run_id).await? {
                store.skip_pending(run_id).await?;
                put_back(state, store, run_id).await;
                return Ok(());
            }
            if all_idle(state, &run).await? {
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    if matches!(run.state, RunState::Planned | RunState::WaitingIdle) {
        store.start_run(run_id).await?;
    }

    for step in store.steps(run_id).await? {
        if matches!(
            step.state,
            StepState::Done | StepState::Skipped | StepState::Warned
        ) {
            continue;
        }
        if is_cancelled(store, run_id).await? {
            store.skip_pending(run_id).await?;
            put_back(state, store, run_id).await;
            return Ok(());
        }

        store.start_step(run_id, step.position).await?;
        let log = Log {
            store: store.clone(),
            run_id: run_id.to_string(),
            position: step.position,
        };

        let outcome = if step.target == PREFLIGHT {
            preflight(state, &run, &log).await
        } else if step.target == BACKUP {
            backup(state, &run, &log).await
        } else if step.target == UPDATER {
            upgrade_updater(state, &run, &log).await
        } else if step.target == CONTROL_PLANE {
            upgrade_control_plane(state, store, &run, &step, &log).await
        } else if let Some(host_id) = step.target.strip_prefix(HOST_PREFIX) {
            upgrade_host(state, store, &run, &step, host_id, &log).await
        } else {
            Err(anyhow!("unknown step {}", step.target))
        };

        match outcome {
            Ok(detail) => {
                store
                    .end_step(run_id, step.position, StepState::Done, Some(detail))
                    .await?
            }
            // A backup is a precaution, not the upgrade. When it cannot be
            // taken the run stops and asks, rather than ending — which is what
            // left the Updates screen with no way past a database `pg_dump`
            // could not read, and the CLI as the only route.
            Err(e) if step.target == BACKUP => {
                let said = format!("{e:#}");
                log.say(&said).await;
                log.say("the upgrade is waiting: carry on without a backup, or stop")
                    .await;
                store
                    .end_step(run_id, step.position, StepState::Warned, Some(said))
                    .await?;
                store
                    .set_run_state(run_id, RunState::WaitingDecision)
                    .await?;
                // Deliberately no `put_back`: the run has not finished, and
                // undraining now would let work onto a machine that is about
                // to be upgraded.
                return Ok(());
            }
            Err(e) => {
                let said = format!("{e:#}");
                log.say(&said).await;
                store
                    .end_step(run_id, step.position, StepState::Failed, Some(said.clone()))
                    .await?;
                store.skip_pending(run_id).await?;
                store
                    .finish_run(run_id, RunState::Failed, Some(said))
                    .await?;
                put_back(state, store, run_id).await;
                return Ok(());
            }
        }
    }

    put_back(state, store, run_id).await;
    store.finish_run(run_id, RunState::Succeeded, None).await?;
    tracing::info!(run = %run_id, "upgraded to {}", run.to_version);
    Ok(())
}

/// Where a step writes what it is doing.
#[derive(Clone)]
struct Log {
    store: Store,
    run_id: String,
    position: i32,
}

impl Log {
    async fn say(&self, line: &str) {
        let line = redact(line);
        tracing::info!(run = %self.run_id, step = self.position, "{line}");
        if let Err(e) = self
            .store
            .append_log(&self.run_id, self.position, &line)
            .await
        {
            tracing::warn!("writing the upgrade log: {e:#}");
        }
    }

    async fn say_all(&self, text: &str, prefix: &str) {
        for line in text.lines().filter(|l| !l.trim().is_empty()) {
            self.say(&format!("{prefix}{line}")).await;
        }
    }
}

/// Mask the value after `KEY=` for keys that name a secret. The same rule the
/// updater applies; nothing here should carry one, and the log is kept.
fn redact(line: &str) -> String {
    const SUSPECT: [&str; 5] = ["password", "token", "secret", "key", "credential"];
    let mut out = String::new();
    for (i, word) in line.split(' ').enumerate() {
        if i > 0 {
            out.push(' ');
        }
        match word.split_once('=') {
            Some((name, value))
                if !value.is_empty()
                    && SUSPECT
                        .iter()
                        .any(|s| name.to_ascii_lowercase().contains(s)) =>
            {
                out.push_str(name);
                out.push_str("=***");
            }
            _ => out.push_str(word),
        }
    }
    out
}

async fn is_cancelled(store: &Store, run_id: &str) -> Result<bool> {
    Ok(store
        .run(run_id)
        .await?
        .map(|r| r.state == RunState::Cancelled)
        .unwrap_or(true))
}

// ── the steps ────────────────────────────────────────────────────────

async fn preflight(state: &AppState, run: &Run, log: &Log) -> Result<String> {
    let mut said = Vec::new();

    if run.targets.control_plane {
        let updater = state
            .updates
            .updater
            .as_ref()
            .map_err(|absent| anyhow!("{}", absent.explain()))?;
        let status = updater
            .status()
            .await
            .context("the updater has to answer before the control plane can be upgraded")?;
        if let Some(job) = status.busy {
            anyhow::bail!("the updater is still busy with job {job}");
        }
        log.say(&format!(
            "updater {} (api {}) at {}, Docker {}",
            status.version, status.api_version, status.deploy_dir, status.docker_version
        ))
        .await;
        said.push(format!("updater {}", status.version));
    }

    for host_id in &run.targets.host_ids {
        let id = ft_core::HostId::from_stored(host_id.clone());
        let host = state
            .db
            .host_by_id(&id)
            .await?
            .with_context(|| format!("host {host_id} is gone"))?;
        if !state.fleet.is_connected(&id).await {
            anyhow::bail!("{} is not connected", host.name);
        }
        crate::fleet::Fleet::ssh_transport_for(&host, &state.home, Some(&state.vault))?
            .with_context(|| format!("{} is not reached over ssh", host.name))?;
        log.say(&format!(
            "{} answers as worker {}",
            host.name,
            host.worker_version.as_deref().unwrap_or("?")
        ))
        .await;
    }
    if !run.targets.host_ids.is_empty() {
        said.push(format!(
            "{} machine{} reachable",
            run.targets.host_ids.len(),
            if run.targets.host_ids.len() == 1 {
                ""
            } else {
                "s"
            }
        ));
    }

    Ok(said.join(" · "))
}

async fn backup(state: &AppState, run: &Run, log: &Log) -> Result<String> {
    let updater = updater(state)?;
    let job = updater
        .start(JobKind::Backup {
            from_version: run.from_version.clone(),
        })
        .await?;
    log.say(&format!("updater job {}", job.id)).await;

    let started = std::time::Instant::now();
    let mut seen = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Some(job) = updater.job(&job.id.0).await? else {
            anyhow::bail!("the updater lost track of the backup");
        };
        for line in &job.log[seen.min(job.log.len())..] {
            log.say(line).await;
        }
        seen = job.log.len();
        match job.state {
            JobState::Done => {
                return Ok(job
                    .steps
                    .last()
                    .and_then(|s| s.detail.clone())
                    .unwrap_or_else(|| "backed up".into()));
            }
            JobState::Failed | JobState::RolledBack => {
                anyhow::bail!(
                    "{}",
                    job.error.unwrap_or_else(|| "the backup failed".into())
                )
            }
            JobState::Queued | JobState::Running => {}
        }
        if started.elapsed() > BACKUP_TIMEOUT {
            anyhow::bail!(
                "the backup was still running after {}s",
                BACKUP_TIMEOUT.as_secs()
            );
        }
    }
}

async fn upgrade_updater(state: &AppState, run: &Run, log: &Log) -> Result<String> {
    let updater = updater(state)?;
    let started = std::time::Instant::now();

    // What it is now — waited for rather than demanded. This step can be
    // walked into a second time, after the control plane was replaced part
    // way through it, and the updater may be being recreated at that very
    // moment by the job the first attempt asked for.
    let before = loop {
        match updater.status().await {
            Ok(status) => break status,
            Err(e) => {
                if started.elapsed() > UPDATER_TIMEOUT {
                    return Err(e).context("the updater never answered");
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    };
    if version::parse(&before.version).as_ref() == version::parse(&run.to_version).as_ref() {
        return Ok(format!("already {}", before.version));
    }

    // A job already in flight is this run's own, from before the restart.
    // Asking for a second recreate would be refused as a conflict anyway, and
    // the one that is running is the one to watch.
    let job = match before.busy.clone() {
        Some(id) => {
            log.say(&format!(
                "the updater is already on job {id}; waiting for it"
            ))
            .await;
            id
        }
        None => {
            let job = updater
                .start(JobKind::UpgradeUpdater {
                    version: run.to_version.clone(),
                })
                .await?;
            log.say(&format!("updater job {}: recreating the updater", job.id))
                .await;
            job.id
        }
    };

    let mut seen = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        // While it is being recreated, it does not answer. That is expected;
        // the job's own record is gone with the old process.
        match updater.status().await {
            Ok(status)
                if version::parse(&status.version).as_ref()
                    == version::parse(&run.to_version).as_ref() =>
            {
                return Ok(format!("{} → {}", before.version, status.version));
            }
            Ok(_) => {
                // Still the old one: read the job for a failure.
                if let Ok(Some(job)) = updater.job(&job.0).await {
                    for line in &job.log[seen.min(job.log.len())..] {
                        log.say(line).await;
                    }
                    seen = job.log.len();
                    if matches!(job.state, JobState::Failed | JobState::RolledBack) {
                        anyhow::bail!(
                            "{}",
                            job.error
                                .unwrap_or_else(|| "the updater could not upgrade itself".into())
                        );
                    }
                }
            }
            Err(_) => {}
        }
        if started.elapsed() > UPDATER_TIMEOUT {
            anyhow::bail!(
                "the updater did not come back as {} within {}s",
                run.to_version,
                UPDATER_TIMEOUT.as_secs()
            );
        }
    }
}

async fn upgrade_control_plane(
    state: &AppState,
    store: &Store,
    run: &Run,
    step: &Step,
    log: &Log,
) -> Result<String> {
    let updater = updater(state)?;
    let local = local_host(state).await?;

    if !run.when_idle {
        end_sessions_on(state, &local, log).await?;
    }

    let files = run.plan.files.clone();
    if !files.is_empty() {
        log.say(&format!(
            "rewriting {}",
            files
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))
        .await;
    }

    let job = updater
        .start(JobKind::UpgradeControlPlane {
            version: run.to_version.clone(),
            files,
        })
        .await?;
    store.set_job_id(&run.id, step.position, &job.id.0).await?;
    log.say(&format!(
        "updater job {}: this control plane goes away here and the new one picks the run up",
        job.id
    ))
    .await;

    // Normally this loop is ended by the process being replaced. If it is
    // not, the updater says why.
    let started = std::time::Instant::now();
    let mut seen = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let Ok(Some(job)) = updater.job(&job.id.0).await else {
            if started.elapsed() > RECREATE_TIMEOUT {
                anyhow::bail!("the updater stopped answering about the job");
            }
            continue;
        };
        for line in &job.log[seen.min(job.log.len())..] {
            log.say(line).await;
        }
        seen = job.log.len();
        match job.state {
            JobState::Done => {
                // Still here, and the job is over: nothing recreated us.
                if version::current().to_string() == run.to_version {
                    return Ok(format!("already {}", run.to_version));
                }
                anyhow::bail!(
                    "the updater finished, but this control plane is still {} — Compose did \
                     not recreate it",
                    version::current()
                );
            }
            JobState::Failed => {
                anyhow::bail!(
                    "{}",
                    job.error.unwrap_or_else(|| "the upgrade failed".into())
                )
            }
            JobState::RolledBack => anyhow::bail!(
                "rolled back to {}: {}",
                run.from_version,
                job.error.unwrap_or_default()
            ),
            JobState::Queued | JobState::Running => {}
        }
        if started.elapsed() > RECREATE_TIMEOUT {
            anyhow::bail!(
                "still waiting to be recreated after {}s",
                RECREATE_TIMEOUT.as_secs()
            );
        }
    }
}

async fn upgrade_host(
    state: &AppState,
    store: &Store,
    run: &Run,
    step: &Step,
    host_id: &str,
    log: &Log,
) -> Result<String> {
    let id = ft_core::HostId::from_stored(host_id.to_string());
    let host = state
        .db
        .host_by_id(&id)
        .await?
        .with_context(|| format!("host {host_id} is gone"))?;
    let ssh = crate::fleet::Fleet::ssh_transport_for(&host, &state.home, Some(&state.vault))?
        .context("a server host is reached over ssh")?;

    // Taken out of service for the length of the step, and put back after
    // unless it was already out.
    if step.was_drained.is_none() {
        store
            .set_was_drained(&run.id, step.position, host.drained)
            .await?;
        if !host.drained {
            state.db.set_drained(&id, true).await?;
        }
    }

    if run.when_idle {
        wait_idle(state, store, &run.id, &id).await?;
    } else {
        end_sessions_on(state, &host, log).await?;
    }

    // The same installer a person runs, over the same connection a session
    // takes, pinned to the version this run is moving to. What it fetches is
    // the build for that machine's own shape.
    log.say(&format!(
        "installing firetower-worker {} on {} via ssh {}",
        run.to_version, host.name, ssh.destination
    ))
    .await;
    let said = crate::install::install_version(&ssh, &run.to_version)
        .await
        .context("reinstalling the worker")?;
    log.say_all(&said, "").await;

    // The installer replaces the file. It cannot replace the process.
    //
    // The worker answering right now was started from the old binary and is
    // holding the ssh connection open, so it goes on reporting the old
    // version for as long as that connection lasts — and nothing else ends
    // it. Without this the step reinstalled the worker perfectly and then
    // waited out its whole timeout for a handshake that was never going to
    // change, which is every worker upgrade that has ever been asked for.
    //
    // Dropping it is the ordinary reconnect path, not a special one: tmux
    // keeps the sessions, the supervisor redials immediately, and sshd starts
    // what is now on disk.
    log.say("dropping the connection so the worker restarts on the new binary")
        .await;
    state.fleet.disconnect(&id).await;

    log.say("waiting for the worker to reconnect").await;
    let started = std::time::Instant::now();
    loop {
        state.fleet.try_now(&id).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        if let Some(seen) = state.db.host_by_id(&id).await? {
            if seen.state == ft_core::HostState::Online
                && seen.worker_version.as_deref() == Some(run.to_version.as_str())
            {
                return Ok(format!(
                    "{} → {}",
                    host.worker_version.as_deref().unwrap_or("?"),
                    run.to_version
                ));
            }
        }
        if started.elapsed() > HANDSHAKE_TIMEOUT {
            anyhow::bail!(
                "the worker was reinstalled but did not shake hands as {} within {}s",
                run.to_version,
                HANDSHAKE_TIMEOUT.as_secs()
            );
        }
    }
}

// ── after a restart ──────────────────────────────────────────────────

/// Pick up whatever was in progress when this process last ran.
pub async fn resume(state: AppState) {
    let store = state.updates.store.clone();
    let runs = match store.active_runs().await {
        Ok(runs) => runs,
        Err(e) => {
            tracing::warn!("reading upgrade runs: {e:#}");
            return;
        }
    };
    for run in runs {
        if run.state == RunState::WaitingDecision {
            continue;
        }
        let steps = match store.steps(&run.id).await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(run = %run.id, "reading its steps: {e:#}");
                continue;
            }
        };
        let running = steps.iter().find(|s| s.state == StepState::Running);
        match running {
            None => spawn(state.clone(), run.id.clone()).await,
            Some(step) if step.target == CONTROL_PLANE => {
                let state = state.clone();
                let step = step.clone();
                tokio::spawn(async move {
                    let store = state.updates.store.clone();
                    let log = Log {
                        store: store.clone(),
                        run_id: run.id.clone(),
                        position: step.position,
                    };
                    match settle_control_plane(&state, &run, &step, &log).await {
                        Ok(detail) => {
                            let _ = store
                                .end_step(&run.id, step.position, StepState::Done, Some(detail))
                                .await;
                            spawn(state.clone(), run.id.clone()).await;
                        }
                        Err(e) => {
                            let said = format!("{e:#}");
                            let _ = store
                                .end_step(
                                    &run.id,
                                    step.position,
                                    StepState::Failed,
                                    Some(said.clone()),
                                )
                                .await;
                            let _ = store.skip_pending(&run.id).await;
                            let _ = store
                                .finish_run(&run.id, RunState::Failed, Some(said))
                                .await;
                            put_back(&state, &store, &run.id).await;
                        }
                    }
                });
            }
            // Every other step is re-enterable, so a restart in the middle of
            // one is picked up rather than thrown away. Preflight only looks;
            // a backup takes another dump; the updater step asks the updater
            // what version it is now and does nothing if that is already the
            // one wanted; a host step reinstalls a worker that is by then
            // often already installed. Failing the whole run here is what
            // turned a control plane restarting for its own reasons — which
            // this module exists to survive — into an upgrade that could not
            // be finished.
            Some(step) if step.attempts < MOST_ATTEMPTS => {
                tracing::info!(
                    run = %run.id,
                    step = %step.target,
                    attempts = step.attempts,
                    "the control plane restarted during this step; picking it up again"
                );
                let log = Log {
                    store: store.clone(),
                    run_id: run.id.clone(),
                    position: step.position,
                };
                log.say("the control plane restarted here; picking this step up again")
                    .await;
                if let Err(e) = store.restart_step(&run.id, step.position).await {
                    tracing::warn!(run = %run.id, "putting the step back: {e:#}");
                    continue;
                }
                spawn(state.clone(), run.id.clone()).await;
            }
            // Tried enough. A control plane that dies every time it reaches
            // this step would otherwise retry it on every start for ever.
            Some(step) => {
                let said = format!(
                    "the control plane restarted during this step {} times; \
                     it is not being tried again",
                    step.attempts
                );
                tracing::warn!(run = %run.id, step = %step.target, "{said}");
                let _ = store
                    .end_step(
                        &run.id,
                        step.position,
                        StepState::Failed,
                        Some(said.clone()),
                    )
                    .await;
                let _ = store.skip_pending(&run.id).await;
                let _ = store
                    .finish_run(&run.id, RunState::Failed, Some(said))
                    .await;
                put_back(&state, &store, &run.id).await;
            }
        }
    }
}

/// This is the process the control-plane step was waiting to become. Find out
/// from the updater whether that is the release it meant.
async fn settle_control_plane(
    state: &AppState,
    run: &Run,
    step: &Step,
    log: &Log,
) -> Result<String> {
    let here = version::current().to_string();
    log.say(&format!("the control plane came back as {here}"))
        .await;

    let updater = updater(state)?;
    let job_id = step.job_id.clone().context("no updater job was recorded")?;
    let started = std::time::Instant::now();
    loop {
        match updater.job(&job_id).await {
            Ok(Some(job)) => match job.state {
                JobState::Done => break,
                JobState::RolledBack => anyhow::bail!(
                    "the updater rolled back to {}: {}",
                    run.from_version,
                    job.error.unwrap_or_default()
                ),
                JobState::Failed => {
                    anyhow::bail!(
                        "{}",
                        job.error.unwrap_or_else(|| "the upgrade failed".into())
                    )
                }
                // The updater is still waiting for us to answer /readyz, which
                // we are about to.
                JobState::Queued | JobState::Running => {}
            },
            // The updater was recreated too and has no memory of the job. What
            // we are is the answer.
            Ok(None) => break,
            Err(e) => {
                if started.elapsed() > RESUME_TIMEOUT {
                    anyhow::bail!("the updater did not answer after the restart: {e:#}");
                }
            }
        }
        if started.elapsed() > RESUME_TIMEOUT {
            anyhow::bail!("the updater never reported the job finished");
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    if here == run.to_version {
        Ok(format!("{} → {here}", run.from_version))
    } else {
        anyhow::bail!("came back as {here}, not {}", run.to_version)
    }
}

// ── draining, ending, putting back ───────────────────────────────────

async fn drain_targets(state: &AppState, store: &Store, run: &Run) -> Result<()> {
    for step in store.steps(&run.id).await? {
        let host = if step.target == CONTROL_PLANE {
            local_host(state).await?
        } else if let Some(id) = step.target.strip_prefix(HOST_PREFIX) {
            match state
                .db
                .host_by_id(&ft_core::HostId::from_stored(id.to_string()))
                .await?
            {
                Some(h) => h,
                None => continue,
            }
        } else {
            continue;
        };
        if step.was_drained.is_none() {
            store
                .set_was_drained(&run.id, step.position, host.drained)
                .await?;
            if !host.drained {
                state.db.set_drained(&host.id, true).await?;
            }
        }
    }
    Ok(())
}

/// Undrain every host this run drained.
async fn put_back(state: &AppState, store: &Store, run_id: &str) {
    let Ok(steps) = store.steps(run_id).await else {
        return;
    };
    for step in steps {
        if step.was_drained != Some(false) {
            continue;
        }
        let host = if step.target == CONTROL_PLANE {
            local_host(state).await.ok()
        } else if let Some(id) = step.target.strip_prefix(HOST_PREFIX) {
            state
                .db
                .host_by_id(&ft_core::HostId::from_stored(id.to_string()))
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        if let Some(host) = host {
            if let Err(e) = state.db.set_drained(&host.id, false).await {
                tracing::warn!(host = %host.name, "putting it back in service: {e:#}");
            }
        }
    }
}

async fn all_idle(state: &AppState, run: &Run) -> Result<bool> {
    if run.targets.control_plane {
        let local = local_host(state).await?;
        if !state.db.live_sessions_on(&local.id).await?.is_empty() {
            return Ok(false);
        }
    }
    for id in &run.targets.host_ids {
        let id = ft_core::HostId::from_stored(id.clone());
        if !state.db.live_sessions_on(&id).await?.is_empty() {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn wait_idle(
    state: &AppState,
    store: &Store,
    run_id: &str,
    host: &ft_core::HostId,
) -> Result<()> {
    loop {
        if state.db.live_sessions_on(host).await?.is_empty() {
            return Ok(());
        }
        if is_cancelled(store, run_id).await? {
            anyhow::bail!("cancelled while waiting for the machine to be idle");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Stop every agent on a host, keeping its workspaces. What is being
/// recreated takes tmux with it; this is the version of that where each
/// agent gets to shut down.
async fn end_sessions_on(state: &AppState, host: &ft_core::Host, log: &Log) -> Result<()> {
    let live = state.db.live_session_ids_on(&host.id).await?;
    if live.is_empty() {
        return Ok(());
    }
    log.say(&format!(
        "ending {} session{} on {}",
        live.len(),
        if live.len() == 1 { "" } else { "s" },
        host.name
    ))
    .await;
    if !state.fleet.is_connected(&host.id).await {
        // Nothing to tell. The container is going anyway, and the sessions
        // are already marked unreachable.
        return Ok(());
    }
    for session in live {
        if let Err(e) = state
            .fleet
            .send(
                &host.id,
                ft_proto::ToWorker::Stop {
                    session_id: session.clone(),
                },
            )
            .await
        {
            log.say(&format!("could not stop {session}: {e:#}")).await;
        }
    }
    tokio::time::sleep(Duration::from_secs(3)).await;
    Ok(())
}

// ── helpers ──────────────────────────────────────────────────────────

fn updater(state: &AppState) -> Result<&super::client::Updater> {
    state
        .updates
        .updater
        .as_ref()
        .map_err(|absent| anyhow!("{}", absent.explain()))
}

async fn local_host(state: &AppState) -> Result<ft_core::Host> {
    state
        .db
        .hosts()
        .await?
        .into_iter()
        .find(|h| h.compute == ft_core::Compute::Local)
        .context("this machine is not in the fleet")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_steps_go_control_plane_first_then_each_machine() {
        let steps = steps_for(
            &super::super::store::Targets {
                control_plane: true,
                host_ids: vec!["h_1".into(), "h_2".into()],
            },
            &[("h_1".into(), "fire-01".into())],
        );
        let targets: Vec<&str> = steps.iter().map(|(t, _)| t.as_str()).collect();
        assert_eq!(
            targets,
            vec![
                PREFLIGHT,
                BACKUP,
                UPDATER,
                CONTROL_PLANE,
                "host:h_1",
                "host:h_2"
            ]
        );
        assert_eq!(steps[4].1, "Upgrade fire-01");
        assert_eq!(
            steps[5].1, "Upgrade h_2",
            "a host that vanished keeps its id"
        );

        let workers_only = steps_for(
            &super::super::store::Targets {
                control_plane: false,
                host_ids: vec!["h_1".into()],
            },
            &[],
        );
        assert_eq!(workers_only.len(), 2);
        assert!(!workers_only.iter().any(|(t, _)| t == BACKUP));
    }

    #[test]
    fn a_log_line_keeps_its_secrets_to_itself() {
        assert_eq!(
            redact("FIRETOWER_UPDATER_TOKEN=abc DOMAIN=x"),
            "FIRETOWER_UPDATER_TOKEN=*** DOMAIN=x"
        );
        assert_eq!(redact("$ docker pull x"), "$ docker pull x");
    }
}
