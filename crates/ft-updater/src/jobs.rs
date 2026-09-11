//! What the updater does when asked, and how it is asked how it went.
//!
//! A job is accepted, given an id, and run on a task of its own. The caller
//! polls. That shape is not a convenience — the job that recreates the control
//! plane ends the process that asked for it, and the one that recreates the
//! updater ends this one. A reply is only ever a snapshot.
//!
//! One job at a time. Two of these racing over one Compose project is a
//! recreate happening under a rollback, and no order of steps makes that safe.
//!
//! ## What a control-plane upgrade actually does
//!
//! 1. Pull the next image. Check the version the build stamped on it is the
//!    one that was asked for — `latest` may have moved on since the person
//!    looked at the screen, and this is the moment to notice rather than
//!    after.
//! 2. Rewrite the deployment files the release changed, keeping `.backup`s.
//! 3. Have Compose recreate the service. **Compose, not us:** a helper
//!    container runs `docker compose up -d --no-deps firetower` against the
//!    deployment's own files, so what comes up is exactly what `firetower
//!    upgrade` would have brought up — same labels, same network, same `.env`.
//!    The updater never reimplements how a container is made.
//! 4. Wait for `/readyz`. If it does not answer, put the previous image back
//!    under the same tag, restore the files, and have Compose recreate it
//!    again. That needs nothing from a registry: the old image is still here.

use crate::docker::{split_reference, Docker};
use crate::redact::redact;
use crate::site::Site;
use anyhow::{anyhow, Context, Result};
use ft_updater_api::{FileWrite, Job, JobId, JobKind, JobState, JobStep};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long the recreated control plane has to answer `/readyz`.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);

/// How many log lines a job keeps. Enough for a pull and a compose run; bounded
/// so a helper that prints in a loop cannot grow it without limit.
const LOG_LINES: usize = 400;

/// A label on every helper container, so a leftover one is recognisably ours.
pub const HELPER_LABEL: &str = "com.firetower.updater";

/// The image the helper runs Compose from. The official CLI image carries the
/// compose plugin; pinned to a major so a rebuild of `latest` upstream cannot
/// change what an upgrade does.
pub fn helper_image() -> String {
    std::env::var("FIRETOWER_UPDATER_HELPER_IMAGE").unwrap_or_else(|_| "docker:28-cli".into())
}

/// Which compose service is the control plane, and which is the database.
fn control_plane_service() -> String {
    std::env::var("FIRETOWER_UPDATER_CP_SERVICE").unwrap_or_else(|_| "firetower".into())
}
fn database_service() -> String {
    std::env::var("FIRETOWER_UPDATER_DB_SERVICE").unwrap_or_else(|_| "postgres".into())
}
/// Where the control plane answers, from inside the compose network.
fn control_plane_url() -> String {
    std::env::var("FIRETOWER_UPDATER_CP_URL").unwrap_or_else(|_| "http://firetower:4400".into())
}

#[derive(Clone)]
pub struct Jobs {
    docker: Docker,
    site: Arc<Site>,
    held: Arc<Mutex<HashMap<String, Job>>>,
    /// The job in progress, so a second one is refused rather than raced.
    busy: Arc<Mutex<Option<JobId>>>,
    /// How many helpers have been run, for naming the next one.
    helpers: Arc<std::sync::atomic::AtomicU64>,
    http: reqwest::Client,
}

/// The one thing a running job holds to say how it is going.
#[derive(Clone)]
struct Reporter {
    id: JobId,
    held: Arc<Mutex<HashMap<String, Job>>>,
}

impl Reporter {
    fn edit(&self, f: impl FnOnce(&mut Job)) {
        if let Some(job) = self.held.lock().unwrap().get_mut(&self.id.0) {
            f(job);
        }
    }

    fn say(&self, line: impl Into<String>) {
        let line = redact(&line.into());
        tracing::info!(job = %self.id, "{line}");
        self.edit(|job| {
            if job.log.len() >= LOG_LINES {
                job.log.remove(0);
            }
            job.log.push(line);
        });
    }

    fn step(&self, name: &str) {
        self.edit(|job| {
            job.steps.push(JobStep {
                name: name.to_string(),
                state: JobState::Running,
                detail: None,
            })
        });
    }

    fn done(&self, detail: impl Into<String>) {
        let detail = redact(&detail.into());
        self.edit(|job| {
            if let Some(step) = job.steps.last_mut() {
                step.state = JobState::Done;
                step.detail = Some(detail);
            }
        });
    }

    fn failed(&self, detail: impl Into<String>) {
        let detail = redact(&detail.into());
        self.edit(|job| {
            if let Some(step) = job.steps.last_mut() {
                step.state = JobState::Failed;
                step.detail = Some(detail);
            }
        });
    }

    fn finish(&self, state: JobState, error: Option<String>) {
        self.edit(|job| {
            job.state = state;
            job.error = error.map(|e| redact(&e));
            job.finished_at = Some(chrono::Utc::now());
        });
    }
}

impl Jobs {
    pub fn new(docker: Docker, site: Site) -> Self {
        Self {
            docker,
            site: Arc::new(site),
            held: Default::default(),
            busy: Default::default(),
            helpers: Default::default(),
            http: reqwest::Client::new(),
        }
    }

    pub fn site(&self) -> &Site {
        &self.site
    }

    pub fn busy(&self) -> Option<JobId> {
        self.busy.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Option<Job> {
        self.held.lock().unwrap().get(id).cloned()
    }

    /// Accept a job and start it. Refused while another is running, with
    /// that job as the answer.
    pub fn start(&self, kind: JobKind) -> Result<Job, Box<Job>> {
        let id = JobId(ulid::Ulid::new().to_string().to_lowercase());
        {
            let mut busy = self.busy.lock().unwrap();
            if let Some(current) = busy.as_ref() {
                if let Some(job) = self.get(&current.0) {
                    if !job.state.is_over() {
                        return Err(Box::new(job));
                    }
                }
            }
            *busy = Some(id.clone());
        }

        let job = Job {
            id: id.clone(),
            kind: kind.clone(),
            state: JobState::Running,
            steps: Vec::new(),
            log: Vec::new(),
            error: None,
            previous_image: None,
            image: None,
            created_at: chrono::Utc::now(),
            finished_at: None,
        };
        self.held.lock().unwrap().insert(id.0.clone(), job.clone());

        let jobs = self.clone();
        let reporter = Reporter {
            id: id.clone(),
            held: self.held.clone(),
        };
        tokio::spawn(async move {
            let outcome = match &kind {
                JobKind::Backup { from_version } => jobs.backup(&reporter, from_version).await,
                JobKind::UpgradeUpdater { version } => jobs.upgrade_self(&reporter, version).await,
                JobKind::UpgradeControlPlane { version, files } => {
                    jobs.upgrade_control_plane(&reporter, version, files).await
                }
            };
            match outcome {
                Ok(state) => reporter.finish(state, None),
                Err(e) => {
                    reporter.failed(format!("{e:#}"));
                    reporter.finish(JobState::Failed, Some(format!("{e:#}")));
                }
            }
            *jobs.busy.lock().unwrap() = None;
        });

        Ok(job)
    }

    // ── backup ─────────────────────────────────────────────────────────

    async fn backup(&self, say: &Reporter, from_version: &str) -> Result<JobState> {
        say.step("find the database");
        let db = self
            .service_container(&database_service())
            .await?
            .context("no database container in this project")?;
        say.done(db.name.clone());

        say.step("pg_dump");
        let dir = self.site.backups_dir()?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
        let name = format!("firetower-{}-{stamp}.dump", safe(from_version));
        let path = dir.join(&name);
        let temporary = dir.join(format!("{name}.writing"));

        let mut file = tokio::fs::File::create(&temporary)
            .await
            .with_context(|| format!("creating {}", temporary.display()))?;
        // The database image's own local socket trusts the local account, so
        // no password is needed here — and none is held here to give.
        let (code, stderr) = self
            .docker
            .exec(
                &db.id,
                &[
                    "sh",
                    "-c",
                    "pg_dump -U \"${POSTGRES_USER:-firetower}\" -d \"${POSTGRES_DB:-firetower}\" -Fc",
                ],
                &mut file,
            )
            .await?;
        drop(file);

        if code != 0 {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(anyhow!("pg_dump exited {code}: {}", stderr.trim()));
        }
        tokio::fs::rename(&temporary, &path)
            .await
            .with_context(|| format!("renaming into {}", path.display()))?;
        let size = tokio::fs::metadata(&path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        say.done(format!("backups/{name} ({})", human(size)));
        say.say(format!("wrote backups/{name}"));
        Ok(JobState::Done)
    }

    // ── the updater itself ─────────────────────────────────────────────

    async fn upgrade_self(&self, say: &Reporter, version: &str) -> Result<JobState> {
        say.step("find the updater");
        let me = self
            .service_container(&self.site.service)
            .await?
            .context("the updater cannot find its own container")?;
        say.done(me.name.clone());

        let (repo, tag) = split_reference(&me.image_ref);
        let pulled = self.pull_release(say, &repo, &tag, version).await?;
        say.edit(|job| {
            job.previous_image = Some(me.image_id.clone());
            job.image = Some(pulled.clone());
        });

        if pulled == me.image_id {
            say.step("recreate");
            say.done("already on that image; nothing to recreate");
            return Ok(JobState::Done);
        }

        say.step("recreate");
        say.say("handing over to Compose — this updater goes away here and the new one answers");
        // Not waited for: the helper replaces this process. The new updater
        // removes the helper when it starts.
        let spec = self.helper_spec(&self.site.service);
        let docker = self.docker.clone();
        let name = self.helper_name(say);
        tokio::spawn(async move {
            let _ = docker.remove(&name).await;
            let _ = docker.run_to_completion(spec, &name).await;
        });
        Ok(JobState::Running)
    }

    // ── the control plane ──────────────────────────────────────────────

    async fn upgrade_control_plane(
        &self,
        say: &Reporter,
        version: &str,
        files: &[FileWrite],
    ) -> Result<JobState> {
        let service = control_plane_service();

        say.step("find the control plane");
        let current = self
            .service_container(&service)
            .await?
            .with_context(|| format!("no `{service}` container in this project"))?;
        say.done(format!("{} on {}", current.name, short(&current.image_id)));
        say.edit(|job| job.previous_image = Some(current.image_id.clone()));

        let (repo, tag) = split_reference(&current.image_ref);
        let pulled = self.pull_release(say, &repo, &tag, version).await?;
        say.edit(|job| job.image = Some(pulled.clone()));

        // Files, remembered so a rollback can undo them.
        let mut written: Vec<(String, Option<String>)> = Vec::new();
        if !files.is_empty() {
            say.step("deployment files");
            for file in files {
                match self.site.write_file(&file.name, &file.content) {
                    Ok(previous) => {
                        say.say(format!("wrote {}", file.name));
                        written.push((file.name.clone(), previous));
                    }
                    Err(e) => {
                        say.failed(format!("{e:#}"));
                        self.restore(say, &written);
                        return Err(e);
                    }
                }
            }
            say.done(format!(
                "{} rewritten, previous kept as .backup",
                written.len()
            ));
        }

        say.step("recreate");
        if pulled == current.image_id && written.is_empty() {
            say.done("already on that image; nothing to recreate");
            return Ok(JobState::Done);
        }
        if let Err(e) = self.compose_up(say, &service).await {
            say.failed(format!("{e:#}"));
            return self
                .roll_back(say, &service, &repo, &tag, &current.image_id, &written)
                .await;
        }
        say.done("Compose recreated it");

        say.step("wait for it to answer");
        match self.wait_healthy(say, &service, &pulled).await {
            Ok(said) => {
                say.done(said);
                Ok(JobState::Done)
            }
            Err(e) => {
                say.failed(format!("{e:#}"));
                self.roll_back(say, &service, &repo, &tag, &current.image_id, &written)
                    .await
            }
        }
    }

    /// Put the previous image back under the same tag and let Compose recreate
    /// the service from it. Reports what it managed.
    async fn roll_back(
        &self,
        say: &Reporter,
        service: &str,
        repo: &str,
        tag: &str,
        previous: &str,
        written: &[(String, Option<String>)],
    ) -> Result<JobState> {
        say.step("roll back");
        say.say(format!("putting {} back as {repo}:{tag}", short(previous)));
        self.restore(say, written);
        self.docker.tag(previous, repo, tag).await?;
        self.compose_up(say, service).await?;
        let said = self.wait_healthy(say, service, previous).await?;
        say.done(format!("back on the previous release: {said}"));
        Ok(JobState::RolledBack)
    }

    fn restore(&self, say: &Reporter, written: &[(String, Option<String>)]) {
        for (name, previous) in written {
            match self.site.restore_file(name, previous.as_deref()) {
                Ok(()) => say.say(format!("restored {name}")),
                Err(e) => say.say(format!("could not restore {name}: {e:#}")),
            }
        }
    }

    // ── shared pieces ──────────────────────────────────────────────────

    /// Pull `repo:tag` and check it is the release that was asked for.
    /// Returns the image id.
    async fn pull_release(
        &self,
        say: &Reporter,
        repo: &str,
        tag: &str,
        version: &str,
    ) -> Result<String> {
        say.step("pull");
        if is_pinned(tag) {
            let said = format!(
                "{repo} is pinned to :{tag} in the compose file. Change it to :latest, or to :{version}, \
                 and the updater can move it"
            );
            say.failed(said.clone());
            return Err(anyhow!(said));
        }
        let mut say_line = |line: String| say.say(format!("{repo}:{tag}: {line}"));
        self.docker.pull(repo, tag, &mut say_line).await?;

        let image = self.docker.inspect_image(&format!("{repo}:{tag}")).await?;
        let stamped = image.version().unwrap_or("unknown");
        if stamped != version {
            let said = format!(
                "{repo}:{tag} is {stamped}, not {version}. A newer release may have been \
                 published since you looked — check again and choose it"
            );
            say.failed(said.clone());
            return Err(anyhow!(said));
        }
        let digest = image
            .repo_digests
            .first()
            .cloned()
            .unwrap_or_else(|| image.id.clone());
        say.done(format!("{version} · {}", short(&digest)));
        Ok(image.id)
    }

    async fn compose_up(&self, say: &Reporter, service: &str) -> Result<()> {
        let helper = helper_image();
        let (repo, tag) = split_reference(&helper);
        self.docker
            .pull(&repo, &tag, |_| {})
            .await
            .with_context(|| format!("fetching the helper image {helper}"))?;

        let spec = self.helper_spec(service);
        // A name of its own per attempt, and cleared first: a helper the
        // daemon created after this process gave up waiting on it is a name
        // already taken, and a rollback must not fail on that.
        let name = self.helper_name(say);
        let _ = self.docker.remove(&name).await;
        say.say(format!(
            "docker compose -p {} up -d --no-deps --pull never {service}",
            self.site.project
        ));
        let finished = self.docker.run_to_completion(spec, &name).await?;
        for line in finished.output.lines().filter(|l| !l.trim().is_empty()) {
            say.say(format!("compose: {line}"));
        }
        if finished.exit_code != 0 {
            return Err(anyhow!("docker compose exited {}", finished.exit_code));
        }
        Ok(())
    }

    /// A name for the next helper this job runs. Distinct per attempt.
    fn helper_name(&self, say: &Reporter) -> String {
        let n = self
            .helpers
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("firetower-updater-helper-{}-{n}", say.id)
    }

    /// The helper container that runs Compose against the deployment's files.
    fn helper_spec(&self, service: &str) -> serde_json::Value {
        let mut cmd = self.site.compose_args();
        cmd.extend(
            ["up", "-d", "--no-deps", "--pull", "never", service]
                .iter()
                .map(|s| s.to_string()),
        );
        // The deployment directory, at the same path, so the compose files
        // and `.env` are where Compose recorded them — and the directory of
        // any compose file that lives elsewhere, for a deployment run with an
        // override from another directory.
        let mut binds = vec![
            format!("{}:{}", crate::docker::SOCKET, crate::docker::SOCKET),
            format!("{}:{}", self.site.deploy_dir, self.site.deploy_dir),
        ];
        for file in &self.site.config_files {
            let dir = std::path::Path::new(file)
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            if dir.is_empty()
                || dir == self.site.deploy_dir
                || dir.starts_with(&format!("{}/", self.site.deploy_dir.trim_end_matches('/')))
            {
                continue;
            }
            let bind = format!("{dir}:{dir}:ro");
            if !binds.contains(&bind) {
                binds.push(bind);
            }
        }
        serde_json::json!({
            "Image": helper_image(),
            "Cmd": cmd,
            "WorkingDir": self.site.deploy_dir,
            "Labels": { HELPER_LABEL: "helper" },
            "HostConfig": { "Binds": binds },
        })
    }

    /// Wait for the service to be the expected image and to answer `/readyz`.
    async fn wait_healthy(&self, say: &Reporter, service: &str, image_id: &str) -> Result<String> {
        let url = format!("{}/readyz", control_plane_url().trim_end_matches('/'));
        let started = std::time::Instant::now();
        let mut last = String::new();
        while started.elapsed() < HEALTH_TIMEOUT {
            tokio::time::sleep(Duration::from_secs(2)).await;

            let container = match self.service_container(service).await {
                Ok(Some(c)) => c,
                _ => {
                    last = "no container yet".into();
                    continue;
                }
            };
            if container.image_id != image_id {
                last = format!(
                    "the container is on {}, expected {}",
                    short(&container.image_id),
                    short(image_id)
                );
                continue;
            }
            if !container.running {
                last = "the container is not running".into();
                continue;
            }
            match self
                .http
                .get(&url)
                .timeout(Duration::from_secs(5))
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => {
                    let version = self
                        .docker
                        .inspect_image(image_id)
                        .await
                        .ok()
                        .and_then(|i| i.version().map(str::to_string))
                        .unwrap_or_else(|| "unknown".into());
                    return Ok(format!(
                        "ready after {}s, version {version}",
                        started.elapsed().as_secs()
                    ));
                }
                Ok(r) => last = format!("{url} answered {}", r.status()),
                Err(e) => last = format!("{url}: {e}"),
            }
        }
        say.say(format!("gave up waiting: {last}"));
        Err(anyhow!(
            "the control plane did not answer within {}s ({last})",
            HEALTH_TIMEOUT.as_secs()
        ))
    }

    async fn service_container(&self, service: &str) -> Result<Option<crate::docker::Container>> {
        let mut found = self
            .docker
            .containers_labelled(&[
                ("com.docker.compose.project", &self.site.project),
                ("com.docker.compose.service", service),
            ])
            .await?;
        // Prefer the one that is running; Compose can leave a stopped replica
        // behind for a moment during a recreate.
        found.sort_by_key(|c| !c.running);
        Ok(found.into_iter().next())
    }

    /// Remove helper containers a previous updater left behind — its own
    /// recreate is the one it cannot wait for.
    pub async fn sweep_helpers(&self) {
        let Ok(found) = self
            .docker
            .containers_labelled(&[(HELPER_LABEL, "helper")])
            .await
        else {
            return;
        };
        for helper in found {
            if helper.running {
                continue;
            }
            tracing::info!(helper = %helper.name, "removing a finished helper container");
            let _ = self.docker.remove(&helper.id).await;
        }
    }
}

/// A full version is a pin; `latest`, `edge` and `major.minor` float.
pub fn is_pinned(tag: &str) -> bool {
    let parts: Vec<&str> = tag.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn short(id: &str) -> String {
    let hex = id.rsplit(':').next().unwrap_or(id);
    hex.chars().take(12).collect()
}

fn safe(version: &str) -> String {
    version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn human(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else {
        format!("{} KB", bytes / 1024)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_full_version_counts_as_a_pin() {
        assert!(is_pinned("0.31.0"));
        assert!(!is_pinned("latest"));
        assert!(!is_pinned("edge"));
        assert!(!is_pinned("0.31"));
        assert!(!is_pinned("v0.31.0"));
    }

    #[test]
    fn a_dump_is_named_by_release_and_time() {
        assert_eq!(safe("0.30.1"), "0.30.1");
        assert_eq!(safe("0.30.1+dirty/x"), "0.30.1-dirty-x");
    }

    #[test]
    fn the_helper_runs_compose_against_the_deployment_s_own_files() {
        let site = Site {
            project: "firetower".into(),
            service: "updater".into(),
            deploy_dir: "/opt/firetower".into(),
            config_files: vec!["/opt/firetower/firetower.yml".into()],
            mount: "/deploy".into(),
        };
        let jobs = Jobs::new(Docker::at("/nowhere"), site);
        let spec = jobs.helper_spec("firetower");

        let cmd: Vec<String> = serde_json::from_value(spec["Cmd"].clone()).unwrap();
        assert_eq!(
            cmd,
            vec![
                "docker",
                "compose",
                "-p",
                "firetower",
                "-f",
                "/opt/firetower/firetower.yml",
                "up",
                "-d",
                "--no-deps",
                "--pull",
                "never",
                "firetower"
            ]
        );
        assert_eq!(spec["WorkingDir"], "/opt/firetower");
        let binds: Vec<String> =
            serde_json::from_value(spec["HostConfig"]["Binds"].clone()).unwrap();
        assert!(binds.contains(&"/opt/firetower:/opt/firetower".to_string()));
        assert!(binds.contains(&"/var/run/docker.sock:/var/run/docker.sock".to_string()));
        assert_eq!(binds.len(), 2, "nothing else is mounted: {binds:?}");
        assert_eq!(spec["Labels"][HELPER_LABEL], "helper");
    }

    /// A compose file from outside the deployment directory is reachable by
    /// the helper too, read-only, at the path Compose recorded.
    #[test]
    fn a_compose_file_elsewhere_is_mounted_for_the_helper() {
        let site = Site {
            project: "firetower".into(),
            service: "updater".into(),
            deploy_dir: "/opt/firetower".into(),
            config_files: vec![
                "/opt/firetower/firetower.yml".into(),
                "/opt/firetower/overrides/extra.yml".into(),
                "/etc/firetower/site.yml".into(),
            ],
            mount: "/deploy".into(),
        };
        let jobs = Jobs::new(Docker::at("/nowhere"), site);
        let spec = jobs.helper_spec("firetower");
        let binds: Vec<String> =
            serde_json::from_value(spec["HostConfig"]["Binds"].clone()).unwrap();
        assert!(
            binds.contains(&"/etc/firetower:/etc/firetower:ro".to_string()),
            "{binds:?}"
        );
        assert_eq!(
            binds.len(),
            3,
            "a file under the deployment is already there: {binds:?}"
        );
    }

    #[test]
    fn a_second_job_is_refused_while_one_runs() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let site = Site {
                project: "p".into(),
                service: "updater".into(),
                deploy_dir: "/x".into(),
                config_files: vec!["/x/firetower.yml".into()],
                mount: "/deploy".into(),
            };
            let jobs = Jobs::new(Docker::at("/nowhere"), site);
            let first = jobs
                .start(JobKind::Backup {
                    from_version: "0.30.1".into(),
                })
                .expect("accepted");
            // The first one is failing against a socket that is not there, but
            // until it has, a second is refused with the first.
            match jobs.start(JobKind::Backup {
                from_version: "0.30.1".into(),
            }) {
                Err(running) => assert_eq!(running.id, first.id),
                Ok(_) => {
                    // It may already have failed; then acceptance is right.
                    assert!(jobs.get(&first.id.0).unwrap().state.is_over());
                }
            }
        });
    }
}
