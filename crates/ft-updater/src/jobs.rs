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
//! 1. Pull the next image, **from the tag the deployment file will name once
//!    step 2 has run** — which is not always the tag the container was
//!    created from, and a release that moves that line is the whole of the
//!    difference. Check the version the build stamped on it is the one that
//!    was asked for — `latest` may have moved on since the person looked at
//!    the screen, and this is the moment to notice rather than after.
//! 2. Rewrite the deployment files the release changed, keeping `.backup`s.
//! 3. Have Compose recreate the service. **Compose, not us:** a helper
//!    container runs `docker compose up -d --no-deps firetower` against the
//!    deployment's own files, so what comes up is exactly what `firetower
//!    upgrade` would have brought up — same labels, same network, same `.env`.
//!    The updater never reimplements how a container is made. It is run with
//!    `--pull never`, so the file decides what has to be on the machine and
//!    step 1 is the only chance to put it there.
//! 4. Wait for `/readyz`. If it does not answer, put the previous image back
//!    under the same tag, restore the files, and have Compose recreate it
//!    again. That needs nothing from a registry: the old image is still here.

use crate::docker::{split_reference, Docker};
use crate::redact::redact;
use crate::site::Site;
use anyhow::{anyhow, Context, Result};
use ft_updater_api::{
    image_tag, FileWrite, ImageRole, Job, JobId, JobKind, JobState, JobStep, ServiceImage,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How long the recreated control plane has to answer `/readyz`.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(180);

/// How many log lines a job keeps. Enough for a pull and a compose run; bounded
/// so a helper that prints in a loop cannot grow it without limit.
const LOG_LINES: usize = 400;

/// How many dumps to keep. A dump of this database is small, and ten upgrades
/// back is further than anybody has ever restored from. Nothing pruned them
/// before, so `backups/` grew until the disk did not.
const KEEP_DUMPS: usize = 10;

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
            // `None` means "nothing to add", not "forget what was said". A
            // rollback records why it rolled back and then finishes without
            // an error of its own, because rolling back is what it was for.
            if let Some(error) = error {
                job.error = Some(redact(&error));
            }
            job.finished_at = Some(chrono::Utc::now());
        });
    }
}

/// Where a failed control-plane upgrade goes back to: the service to recreate,
/// the tag to re-point at the image it was on, and that image.
///
/// One value rather than four arguments — they are only ever passed together,
/// and getting the repository and the tag the wrong way round would re-tag
/// somebody's control plane image with a name that is not its own.
#[derive(Clone, Copy)]
struct Rollback<'a> {
    service: &'a str,
    repo: &'a str,
    tag: &'a str,
    previous: &'a str,
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
                JobKind::UpgradeUpdater { version, tag } => {
                    jobs.upgrade_self(&reporter, version, tag.as_deref()).await
                }
                JobKind::UpgradeControlPlane {
                    version,
                    files,
                    tag,
                } => {
                    jobs.upgrade_control_plane(&reporter, version, files, tag.as_deref())
                        .await
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

        // What else is in there. A database somebody has run the test suite
        // against carries a `test_*` schema per test, forever — the sweeper
        // that removes them is `#[cfg(test)]`, so no release build has ever
        // cleaned one up. The dump below skips them; this is so the screen
        // says why the database is the size it is, before it gets bad enough
        // to matter again.
        match self.foreign_schemas(&db.id).await {
            Ok(0) => {}
            Ok(n) => say.say(format!(
                "{n} schemas in this database that Firetower did not create. \
                 The backup skips them. See docs/updates.md#schemas-firetower-did-not-create to clear them."
            )),
            // Never fatal. This is a remark, not a check.
            Err(e) => tracing::debug!("could not count schemas: {e:#}"),
        }

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
                    // `-n public`, not the whole database. Everything every
                    // migration makes is in `public`, and it is the only
                    // schema a restore needs — while a database that has had
                    // the test suite pointed at it holds thousands more.
                    //
                    // `pg_dump` takes `ACCESS SHARE` on everything it will
                    // dump in one statement, so the whole-database form put
                    // every table in the database into a single `LOCK TABLE`
                    // and fell over `max_locks_per_transaction`; before that
                    // it ran out of memory building the object graph. Both
                    // scale with what is dumped, and this is what decides it.
                    //
                    // `-n` carries no roles or database-level grants. Neither
                    // did the old command — only `pg_dumpall` emits those.
                    "pg_dump -U \"${POSTGRES_USER:-firetower}\" -d \"${POSTGRES_DB:-firetower}\" -n public -Fc",
                ],
                &mut file,
            )
            .await?;
        drop(file);

        if code != 0 {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(anyhow!("{}", dump_failure(code, &stderr)));
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

        // After the rename, never before: a prune that runs first and then
        // fails to dump has traded a backup for nothing.
        for line in prune(&dir, KEEP_DUMPS).await {
            say.say(line);
        }
        Ok(JobState::Done)
    }

    /// How many schemas are in there that Firetower did not make.
    ///
    /// Everything of ours is in `public`. `pg_catalog`, `information_schema`
    /// and `pg_toast*` are the server's own.
    async fn foreign_schemas(&self, container: &str) -> Result<i64> {
        let mut out = Vec::new();
        let (code, stderr) = self
            .docker
            .exec(
                container,
                &[
                    "sh",
                    "-c",
                    "psql -U \"${POSTGRES_USER:-firetower}\" -d \"${POSTGRES_DB:-firetower}\" -tAc \
                     \"SELECT count(*) FROM information_schema.schemata \
                       WHERE schema_name NOT IN ('public','information_schema') \
                         AND schema_name NOT LIKE 'pg\\_%'\"",
                ],
                &mut out,
            )
            .await?;
        if code != 0 {
            return Err(anyhow!("psql exited {code}: {}", clip(&stderr, 400)));
        }
        Ok(String::from_utf8_lossy(&out).trim().parse().unwrap_or(0))
    }

    // ── the updater itself ─────────────────────────────────────────────

    async fn upgrade_self(
        &self,
        say: &Reporter,
        version: &str,
        fetch_tag: Option<&str>,
    ) -> Result<JobState> {
        say.step("find the updater");
        let me = self
            .service_container(&self.site.service)
            .await?
            .context("the updater cannot find its own container")?;
        say.done(me.name.clone());

        let (repo, was_on) = split_reference(&me.image_ref);
        // The caller's tag first here, which is the other way round from the
        // control plane's — and for a reason that is only true of this step.
        // A channel switch rewrites both image lines in the *control-plane*
        // step, which runs after this one, so while this job runs the file
        // still names the channel being left and the caller is the only thing
        // that knows otherwise.
        //
        // The file next, for the opposite case: the release that moved both
        // lines onto the general-access tag left this container as the one
        // Compose created from the floating one, so the file and the
        // container disagree until the next recreate — and it is the file
        // Compose reads. Same rule as the control plane's, same reason.
        let tag = fetch_tag
            .map(str::to_string)
            .or_else(|| {
                self.compose_on_disk()
                    .and_then(|compose| image_tag(&compose, &repo))
            })
            .unwrap_or_else(|| was_on.clone());
        if tag != was_on {
            say.say(format!(
                "fetching :{tag} rather than :{was_on}, which is what this container was made \
                 from"
            ));
        }
        let pulled = self.pull_release(say, &repo, &tag, version).await?;
        say.edit(|job| {
            job.previous_image = Some(me.image_id.clone());
            job.image = Some(pulled.clone());
        });

        // **The tag, as well as the image.** The channel *is* the tag the
        // running container was created from — nothing stores it — so an
        // updater left on the tag of the channel being left is on the old
        // channel however identical the bytes it is running are. Two channels
        // holding one build is the ordinary state between a release and its
        // promotion, and on that day a matching image id is not a reason to
        // skip the recreate: it is the whole reason #478 was silent, with the
        // control plane moved and the updater not.
        //
        // The same shape as the control plane's, which skips only when there
        // is nothing at all to do: no new image *and* no file rewritten.
        if pulled == me.image_id && tag == was_on {
            say.step("recreate");
            say.done(format!(
                "already on that image and on :{tag}; nothing to recreate"
            ));
            return Ok(JobState::Done);
        }

        say.step("recreate");

        // Everything that can be found out before the handover, before it:
        // once the helper is started this process is gone, and nothing is
        // left to report what went wrong. Fetching the image and creating the
        // container are the two steps that can fail for ordinary reasons — a
        // registry that cannot be reached, a name already taken — and both
        // are done here, where a failure is still this job's to report.
        //
        // The image especially. Nothing else pulls it before this point: the
        // control-plane step does, and that comes after, so on the first
        // upgrade of any install it is not on the machine. Creating a
        // container from an image that is not there is a 404 — which used to
        // be discarded with the rest of the handover, leaving the control
        // plane to wait out its timeout against an updater that had never
        // been asked to do anything.
        self.fetch_helper_image(say).await?;

        let spec = self.helper_spec(&self.site.service);
        let name = self.helper_name(say);
        let _ = self.docker.remove(&name).await;
        let helper_id = self
            .docker
            .create(spec, &name)
            .await
            .context("creating the helper container that recreates the updater")?;

        say.say("handing over to Compose — this updater goes away here and the new one answers");
        // Not waited for: the helper replaces this process. The new updater
        // removes the helper when it starts.
        let docker = self.docker.clone();
        tokio::spawn(async move {
            if let Err(e) = docker.start(&helper_id).await {
                tracing::error!("starting the helper container: {e:#}");
            }
        });
        Ok(JobState::Running)
    }

    // ── the control plane ──────────────────────────────────────────────

    async fn upgrade_control_plane(
        &self,
        say: &Reporter,
        version: &str,
        files: &[FileWrite],
        fetch_tag: Option<&str>,
    ) -> Result<JobState> {
        let service = control_plane_service();

        say.step("find the control plane");
        let current = self
            .service_container(&service)
            .await?
            .with_context(|| format!("no `{service}` container in this project"))?;
        say.done(format!("{} on {}", current.name, short(&current.image_id)));
        say.edit(|job| job.previous_image = Some(current.image_id.clone()));

        // Two tags, and the difference is the whole of a release that moves an
        // image line: the one to fetch from is what the compose file will name
        // once this job has written it, and the one to go back to is the one
        // the container was created from. They are the same for every ordinary
        // upgrade.
        //
        // **The file decides, not the container.** Compose is run with
        // `--pull never`, so the image that has to be on this machine before
        // the recreate is the one the rewritten file names, and this is the
        // only chance to put it there. Fetching the container's tag instead
        // brings the right image down under a name the file does not mention,
        // and Compose refuses an image it cannot find — after it has already
        // taken the old container away. That is #407: every installation on
        // the floating tag rolled back cleanly and none of them could upgrade.
        //
        // The order of the three answers, each because the one before it can
        // be absent or wrong:
        //
        // * **The file, as this job will leave it.** What Compose will read.
        // * **The tag the caller named**, for a compose file with no line to
        //   read at all. It is intent, and intent is what `--pull never` does
        //   not honour, so it does not come first — and the caller may not
        //   have named one: the control plane asking for this upgrade is the
        //   one being replaced, and a release from before channels existed
        //   does not know to.
        // * **The container's own tag**, which is what this always used.
        let (repo, was_on) = split_reference(&current.image_ref);
        let fetch = self
            .compose_after(files)
            .and_then(|compose| image_tag(&compose, &repo))
            .or_else(|| fetch_tag.map(str::to_string))
            .unwrap_or_else(|| was_on.clone());
        if fetch != was_on {
            say.say(format!(
                "fetching :{fetch} rather than :{was_on} — {} names {repo}:{fetch}, and that is \
                 what Compose will ask this machine for",
                crate::site::COMPOSE_FILE
            ));
        }
        let pulled = self.pull_release(say, &repo, &fetch, version).await?;
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
        // `was_on`, not `fetch`: a rollback restores the files, so the
        // compose file goes back to naming the tag this container came from,
        // and that is the name the previous image has to answer to.
        let back_to = Rollback {
            service: &service,
            repo: &repo,
            tag: &was_on,
            previous: &current.image_id,
        };
        if let Err(e) = self.compose_up(say, &service).await {
            say.failed(format!("{e:#}"));
            return self.roll_back(say, &back_to, &written, &e).await;
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
                self.roll_back(say, &back_to, &written, &e).await
            }
        }
    }

    /// Put the previous image back under the same tag and let Compose recreate
    /// the service from it. Reports what it managed.
    async fn roll_back(
        &self,
        say: &Reporter,
        back_to: &Rollback<'_>,
        written: &[(String, Option<String>)],
        why: &anyhow::Error,
    ) -> Result<JobState> {
        let Rollback {
            service,
            repo,
            tag,
            previous,
        } = *back_to;
        // The job's error, not only the step's. Without it the control plane
        // reported "rolled back to 0.39.0:" and stopped — the one thing the
        // person reading it needs is the half that was missing.
        say.edit(|job| job.error = Some(redact(&format!("{why:#}"))));
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

    /// The compose file as this job will leave it: the content it is about to
    /// write, or what is on the machine when the release does not change that
    /// file.
    ///
    /// This is the document Compose will be run against, and with
    /// `--pull never` it is the only thing that decides which image has to be
    /// here. `None` when there is nothing to read.
    fn compose_after(&self, files: &[FileWrite]) -> Option<String> {
        match files.iter().find(|f| f.name == crate::site::COMPOSE_FILE) {
            Some(write) => Some(write.content.clone()),
            None => self.compose_on_disk(),
        }
    }

    /// The compose file as it is on the machine now.
    ///
    /// Unreadable is `None` rather than an error: it is one input to a
    /// decision that has two more answers behind it, and a deployment whose
    /// compose file this process cannot read is one Compose will refuse on
    /// its own, with a better message than this could manage.
    fn compose_on_disk(&self) -> Option<String> {
        std::fs::read_to_string(self.site.mount.join(crate::site::COMPOSE_FILE)).ok()
    }

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
            let said = pinned_tag_refusal(repo, tag);
            say.failed(said.clone());
            return Err(anyhow!(said));
        }
        let mut say_line = |line: String| say.say(format!("{repo}:{tag}: {line}"));
        self.docker.pull(repo, tag, &mut say_line).await?;

        let image = self.docker.inspect_image(&format!("{repo}:{tag}")).await?;
        let stamped = image.version().unwrap_or("unknown");
        if stamped != version {
            let said = version_mismatch(repo, tag, stamped, version);
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

    /// Make sure the image the helper runs from is on the machine.
    ///
    /// Pulled, because it may not be here at all — nothing else fetches it,
    /// and the first upgrade of an install finds it missing. But a copy that
    /// is already here is good enough: the tag is pinned to a major, so a
    /// refresh changes nothing an upgrade depends on, and a registry that is
    /// rate-limiting or unreachable is not a reason to refuse to upgrade a
    /// deployment that has everything it needs. Seen as a Docker Hub token
    /// endpoint failing for twenty seconds, mid-upgrade, which rolled the
    /// control plane back for no reason at all.
    async fn fetch_helper_image(&self, say: &Reporter) -> Result<()> {
        let helper = helper_image();
        let (repo, tag) = split_reference(&helper);
        let Err(e) = self.docker.pull(&repo, &tag, |_| {}).await else {
            return Ok(());
        };
        if self.docker.inspect_image(&helper).await.is_ok() {
            say.say(format!(
                "could not reach the registry for {helper} ({e:#}); using the copy already here"
            ));
            return Ok(());
        }
        Err(e).with_context(|| format!("fetching the helper image {helper}"))
    }

    async fn compose_up(&self, say: &Reporter, service: &str) -> Result<()> {
        self.fetch_helper_image(say).await?;

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

    /// The image each of the deployment's own containers was created from.
    ///
    /// The control plane's tag is the installation's channel, and this is the
    /// only place it can be read — see [`ft_updater_api::Status::images`].
    /// Asked of the daemon every time rather than remembered: a container
    /// recreated between two asks is the case this exists for, and a
    /// remembered answer would be the stored setting the design refuses.
    ///
    /// A container that cannot be found is left out rather than guessed at.
    pub async fn images(&self) -> Vec<ServiceImage> {
        let mut found = Vec::new();
        for (role, service) in [
            (ImageRole::ControlPlane, control_plane_service()),
            (ImageRole::Updater, self.site.service.clone()),
        ] {
            match self.service_container(&service).await {
                Ok(Some(container)) => found.push(ServiceImage {
                    role,
                    service,
                    reference: container.image_ref,
                }),
                Ok(None) => tracing::debug!("no `{service}` container in this project"),
                Err(e) => tracing::warn!("reading the `{service}` container's image: {e:#}"),
            }
        }
        found
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
/// The tags that name a channel, and the only two an operator should pin.
///
/// `latest` is deliberately not here. It keeps its conventional meaning — the
/// newest build published — and is not a channel, which is precisely why an
/// installation pinned to it is the one that gets stuck: it is told general
/// access is 0.55.0, pulls `latest`, gets 0.58.0, and refuses. See
/// `docs/channels.md` for all four tags together.
///
/// `edge` is not here either: it is the tip of main, and not selectable.
pub const CHANNEL_TAGS: [&str; 2] = ["beta", "stable"];

/// Does this tag name a channel?
pub fn is_channel_tag(tag: &str) -> bool {
    CHANNEL_TAGS.contains(&tag)
}

/// What an operator is told when the image that came down is not the release
/// they were offered.
///
/// **The condition is that the tag is not the tag of the channel being
/// fetched** — which, since an installation's channel *is* the tag on the
/// image it is running, reduces to "this tag does not name a channel at all".
/// Stating it the other way round, as "the tag is a channel tag", would be the
/// bug rather than the fix: the installation this message exists for is pinned
/// to `latest`, which is not a channel, so that condition would never fire for
/// the only case that needs it.
///
/// Two genuinely different situations, and the old text gave the second one's
/// explanation to both:
///
/// * **On a channel tag.** The channel really did move between being offered a
///   version and pulling it, which is a race and is what the original wording
///   described.
/// * **On anything else** — `latest`, `edge`, a two-part version. The compose
///   file names a tag that is not the channel this installation is being served
///   from, so the pull can never produce the version it was told to want, and
///   it will not upgrade again until the file is changed. The old message sent
///   this operator to look for a newer release, which is a dead end: there is
///   nothing to find and nothing they could have done. This is the difference
///   between a dead end and an instruction.
pub fn version_mismatch(repo: &str, tag: &str, stamped: &str, version: &str) -> String {
    if is_channel_tag(tag) {
        return format!(
            "{repo}:{tag} is {stamped}, not {version}. A newer release may have been \
             published since you looked — check again and choose it"
        );
    }
    format!(
        "{repo}:{tag} is {stamped}, not {version}. :{tag} does not name a channel, so this \
         deployment cannot be upgraded while it is pinned to it. Change the image line to \
         :stable for general access, or :beta for the newest release, and this upgrade will \
         go through"
    )
}

/// What an operator is told when the compose file names an exact version.
///
/// A separate string from the one above and raised in a different situation —
/// this one is the tag being a three-part version, which the updater will not
/// move at all. It used to advise changing it to `latest`, which is the one tag
/// this design says not to pin: an installation on `latest` is floated onto
/// whatever was published most recently rather than onto a channel, so the
/// advice would move an operator from one stuck state into the state that
/// produces the message above.
pub fn pinned_tag_refusal(repo: &str, tag: &str) -> String {
    format!(
        "{repo} is pinned to :{tag} in the compose file, and the updater does not move an \
         exact version. Change it to :stable for general access, or :beta for the newest \
         release, and the updater can move it"
    )
}

pub fn is_pinned(tag: &str) -> bool {
    let parts: Vec<&str> = tag.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

/// Keep the newest `keep` dumps, and sweep the remains of killed ones.
///
/// Only `firetower-*.dump` and `*.writing` are ever candidates: this is a
/// bind-mounted directory on somebody's server and nothing else in it is ours.
///
/// A `.writing` file is what a dump that was *killed* leaves — the failure
/// path deletes its own temporary, but an out-of-memory `pg_dump` never
/// reaches it. A day is long enough that no dump in progress is caught.
async fn prune(dir: &std::path::Path, keep: usize) -> Vec<String> {
    let mut said = Vec::new();
    let mut dumps: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    let mut writing: Vec<PathBuf> = Vec::new();

    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return said;
    };
    let day_ago = std::time::SystemTime::now() - Duration::from_secs(24 * 60 * 60);
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Ok(made) = entry.metadata().await.and_then(|m| m.modified()) else {
            continue;
        };
        if name.ends_with(".writing") {
            if made < day_ago {
                writing.push(path);
            }
        } else if name.starts_with("firetower-") && name.ends_with(".dump") {
            dumps.push((made, path));
        }
    }

    for path in writing {
        if tokio::fs::remove_file(&path).await.is_ok() {
            said.push(format!(
                "swept {}, left by a dump that was killed",
                shown(&path)
            ));
        }
    }

    // Newest first, so everything past `keep` is the oldest.
    dumps.sort_by_key(|(made, _)| std::cmp::Reverse(*made));
    let mut dropped = 0;
    for (_, path) in dumps.into_iter().skip(keep) {
        if tokio::fs::remove_file(&path).await.is_ok() {
            dropped += 1;
        }
    }
    if dropped > 0 {
        said.push(format!("removed {dropped} older dump(s), keeping {keep}"));
    }
    said
}

fn shown(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// What to say when `pg_dump` did not finish.
///
/// 137 is SIGKILL, which inside a container is almost always the OOM killer —
/// and the stderr in that case is empty or cut mid-sentence, which is the
/// least informative failure this can produce. Naming it is the difference
/// between a number and something to act on.
fn dump_failure(code: i64, stderr: &str) -> String {
    let said = stderr.trim();
    if code == 137 {
        return format!(
            "the database dump ran out of memory and was killed{}",
            if said.is_empty() {
                String::new()
            } else {
                format!(": {}", clip(said, 2000))
            }
        );
    }
    format!("pg_dump exited {code}: {}", clip(said, 2000))
}

/// Keep the head and the tail of something too long to show.
///
/// The middle, not the end: a Postgres failure puts `ERROR:` at the top and
/// `HINT:` at the bottom, and a `LOCK TABLE` naming every table in the
/// database in between. Truncating from one end loses one of the two things
/// worth reading.
fn clip(text: &str, keep: usize) -> String {
    if text.len() <= keep {
        return text.to_string();
    }
    let half = keep / 2;
    let head = floor_char_boundary(text, half);
    let tail = ceil_char_boundary(text, text.len() - half);
    format!(
        "{}\n… {} bytes not shown …\n{}",
        &text[..head],
        tail - head,
        &text[tail..]
    )
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
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
    /// Set a file's modified time, which is what `prune` orders by.
    fn touch(path: &std::path::Path, when: std::time::SystemTime) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    /// The two failures a whole-database dump met: one `LOCK TABLE` naming
    /// every table, and the object graph behind it. Both scale with what is
    /// dumped, and `-n public` is what decides that.
    #[test]
    fn the_dump_asks_only_for_the_schema_firetower_owns() {
        // The command as `backup` builds it, kept in one place so this cannot
        // drift from it silently.
        let command = "pg_dump -U \"${POSTGRES_USER:-firetower}\" -d \"${POSTGRES_DB:-firetower}\" -n public -Fc";
        assert!(command.contains(" -n public "), "{command}");
        assert!(command.contains("-Fc"), "already compressed: {command}");
        assert!(
            !command.contains("pg_dumpall"),
            "that would carry every schema, which is the opposite: {command}"
        );
    }

    #[test]
    fn a_killed_dump_says_it_ran_out_of_memory() {
        let said = dump_failure(137, "");
        assert!(said.contains("ran out of memory"), "{said}");
        // Not just the number, which is what it used to be.
        assert!(!said.contains("exited 137"), "{said}");
    }

    #[test]
    fn any_other_failure_keeps_its_code_and_its_text() {
        let said = dump_failure(1, "FATAL: role \"nobody\" does not exist");
        assert!(said.contains("exited 1"), "{said}");
        assert!(said.contains("role"), "{said}");
    }

    /// A Postgres failure puts `ERROR:` at the top and `HINT:` at the bottom,
    /// with the statement in between. Cutting from one end loses one of them.
    #[test]
    fn a_long_failure_keeps_both_ends() {
        let text = format!(
            "ERROR: out of shared memory\n{}\nHINT: max_locks",
            "x".repeat(200_000)
        );
        let kept = clip(&text, 2000);
        assert!(kept.len() < 3000, "{} bytes", kept.len());
        assert!(kept.starts_with("ERROR: out of shared memory"), "{kept}");
        assert!(kept.ends_with("HINT: max_locks"), "{kept}");
        assert!(
            kept.contains("not shown"),
            "it says what it dropped: {kept}"
        );
    }

    #[test]
    fn something_short_is_left_alone() {
        assert_eq!(clip("ERROR: nope", 2000), "ERROR: nope");
    }

    #[tokio::test]
    async fn pruning_keeps_the_newest_and_drops_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let mut made = Vec::new();
        for n in 0..6 {
            let path = dir
                .path()
                .join(format!("firetower-0.{n}.0-2026010{n}T000000Z.dump"));
            std::fs::write(&path, "x").unwrap();
            // Distinct mtimes, oldest first.
            let when =
                std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000 + n * 60);
            touch(&path, when);
            made.push(path);
        }

        prune(dir.path(), 3).await;

        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), 3, "{left:?}");
        for path in &made[3..] {
            assert!(path.exists(), "the newest three stay: {}", path.display());
        }
        for path in &made[..3] {
            assert!(!path.exists(), "the oldest three go: {}", path.display());
        }
    }

    /// Somebody's server, and a directory this did not create everything in.
    #[tokio::test]
    async fn pruning_touches_nothing_that_is_not_ours() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["notes.txt", "firetower.env", "someone-elses.dump", "README"] {
            std::fs::write(dir.path().join(name), "x").unwrap();
        }
        prune(dir.path(), 0).await;
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 4);
    }

    /// What an out-of-memory dump leaves: the failure path deletes its own
    /// temporary, and a killed process never reaches it.
    #[tokio::test]
    async fn the_remains_of_a_killed_dump_are_swept_once_they_are_old() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("firetower-0.32.0-x.dump.writing");
        let fresh = dir.path().join("firetower-0.33.0-y.dump.writing");
        std::fs::write(&old, "x").unwrap();
        std::fs::write(&fresh, "x").unwrap();
        let two_days = std::time::SystemTime::now() - Duration::from_secs(48 * 60 * 60);
        touch(&old, two_days);

        prune(dir.path(), 10).await;

        assert!(!old.exists(), "an old one is swept");
        assert!(fresh.exists(), "a dump in progress is not");
    }

    use super::*;

    #[test]
    fn only_a_full_version_counts_as_a_pin() {
        assert!(is_pinned("0.31.0"));
        assert!(!is_pinned("latest"));
        assert!(!is_pinned("edge"));
        assert!(!is_pinned("0.31"));
        assert!(!is_pinned("v0.31.0"));
        // The two channel tags float, like everything that is not three
        // numeric parts. Nothing in the updater needed changing for them.
        assert!(!is_pinned("beta"));
        assert!(!is_pinned("stable"));
    }

    #[test]
    fn only_beta_and_stable_name_a_channel() {
        assert!(is_channel_tag("beta"));
        assert!(is_channel_tag("stable"));
        // The one that matters. `latest` keeps its conventional meaning and
        // is *not* a channel, which is what makes an installation pinned to it
        // the one that gets stuck.
        assert!(!is_channel_tag("latest"));
        assert!(!is_channel_tag("edge"));
        assert!(!is_channel_tag("0.31"));
        assert!(!is_channel_tag("0.31.0"));
    }

    /// Worth a test rather than a careful edit, because the whole value of
    /// these two strings is their wording and nothing else would catch a
    /// regression to the old text.
    #[test]
    fn a_wrong_channel_pin_is_named_as_one() {
        // The frozen installation: pinned to the tag that existed before
        // channels, offered the general-access version, handed the newest
        // build instead, and stuck until somebody edits the file.
        let said = version_mismatch(
            "ghcr.io/firetower-cloud/firetower",
            "latest",
            "0.58.0",
            "0.55.0",
        );
        assert!(said.contains("does not name a channel"), "{said}");
        assert!(said.contains(":stable"), "it names the tag to use: {said}");
        assert!(said.contains(":beta"), "and the other one: {said}");
        // The old text sent this operator to look for a newer release, which
        // is a dead end — there is nothing to find.
        assert!(!said.contains("A newer release may have been"), "{said}");
        assert!(!said.contains("check again and choose it"), "{said}");

        // And the same for every other tag that is not a channel.
        for tag in ["edge", "0.55", "v0.55.0"] {
            let said = version_mismatch("firetower", tag, "0.58.0", "0.55.0");
            assert!(said.contains("does not name a channel"), "{tag}: {said}");
        }
    }

    /// The other half of the same condition, and the reason it is written as
    /// "not the tag of the channel being fetched" rather than "is a channel
    /// tag": on a channel tag the mismatch really is a race, and the original
    /// wording is the right one.
    #[test]
    fn a_mismatch_on_a_channel_tag_is_still_a_race() {
        for tag in CHANNEL_TAGS {
            let said = version_mismatch("firetower", tag, "0.58.0", "0.55.0");
            assert!(
                said.contains("A newer release may have been"),
                "{tag}: {said}"
            );
            assert!(!said.contains("does not name a channel"), "{tag}: {said}");
        }
    }

    #[test]
    fn the_pinned_tag_refusal_no_longer_advises_pinning_latest() {
        // A different string from the one above, raised in a different
        // situation: this one is an exact version in the compose file. It used
        // to advise `:latest`, which is the one tag this design says not to
        // pin — the advice would have moved an operator straight into the
        // frozen state the message above exists for.
        let said = pinned_tag_refusal("ghcr.io/firetower-cloud/firetower", "0.55.0");
        assert!(said.contains(":stable"), "{said}");
        assert!(said.contains(":beta"), "{said}");
        assert!(!said.contains(":latest"), "{said}");
        assert!(said.contains("0.55.0"), "it names what is pinned: {said}");
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

    // ── the handover to Compose ────────────────────────────────────────
    //
    // A fake daemon, because the thing worth testing is an order: what the
    // updater finds out *before* it starts the container that replaces it.
    // After that start there is no process left to report anything, so a
    // failure that arrives late arrives nowhere — which is what a missing
    // helper image used to be.

    use std::sync::{Arc, Mutex};

    /// Every request the updater made, in order, as "METHOD /path".
    type Seen = Arc<Mutex<Vec<String>>>;

    /// Answers the handful of endpoints `upgrade_self` asks for.
    ///
    /// `create_fails` makes `POST /containers/create` a 404, which is exactly
    /// what the daemon says when the image is not on the machine.
    /// What the fake daemon should go wrong at, if anything.
    #[derive(Clone, Copy, Default)]
    struct Awkward {
        /// `POST /containers/create` 404s, as it does for a missing image.
        create_fails: bool,
        /// Pulling the helper image fails, as a rate-limited registry does.
        helper_pull_fails: bool,
    }

    /// What the one container the fake daemon has reports as its image, when
    /// a test does not say otherwise: the updater's own.
    const UPDATER_REF: &str = "ghcr.io/firetower-cloud/firetower-updater:latest";

    async fn fake_daemon(
        seen: Seen,
        awkward: Awkward,
    ) -> (crate::docker::Docker, tempfile::TempDir) {
        fake_daemon_running(seen, awkward, UPDATER_REF).await
    }

    /// The same, for a test that needs the container to be on some other
    /// image — a control plane, or one created from a different tag.
    async fn fake_daemon_running(
        seen: Seen,
        awkward: Awkward,
        image_ref: &'static str,
    ) -> (crate::docker::Docker, tempfile::TempDir) {
        use http_body_util::Full;
        use hyper::body::Bytes;
        use hyper::{Request, Response};

        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("docker.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();

        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let seen = seen.clone();
                tokio::spawn(async move {
                    let service =
                        hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                            let seen = seen.clone();
                            async move {
                                // Path and query only: the client builds an
                                // absolute URI, and what matters here is the
                                // endpoint it asked for.
                                let path = req
                                    .uri()
                                    .path_and_query()
                                    .map(|p| p.as_str().to_string())
                                    .unwrap_or_default();
                                seen.lock()
                                    .unwrap()
                                    .push(format!("{} {}", req.method(), path));

                                let (status, body) =
                                    answer(req.method(), &path, awkward, image_ref);
                                Ok::<_, std::convert::Infallible>(
                                    Response::builder()
                                        .status(status)
                                        .header("content-type", "application/json")
                                        .body(Full::new(Bytes::from(body)))
                                        .unwrap(),
                                )
                            }
                        });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                        .await;
                });
            }
        });

        (crate::docker::Docker::at(socket), dir)
    }

    fn answer(
        method: &hyper::Method,
        path: &str,
        awkward: Awkward,
        image_ref: &str,
    ) -> (u16, String) {
        // The one container the fake daemon has, as Compose labelled it.
        let me = serde_json::json!({
            "Id": "updater-container",
            "Name": "/firetower-updater-1",
            "Image": "sha256:old",
            "Config": {
                "Image": image_ref,
                "Labels": {
                    "com.docker.compose.project": "firetower",
                    "com.docker.compose.service": "updater",
                }
            },
            "State": {"Running": true}
        });

        if path.starts_with("/containers/json") {
            return (
                200,
                serde_json::json!([{"Id": "updater-container"}]).to_string(),
            );
        }
        if path.starts_with("/containers/updater-container/json") {
            return (200, me.to_string());
        }
        if path.starts_with("/images/create") {
            // The daemon answers 200 and puts the failure in the stream.
            if awkward.helper_pull_fails && path.contains("fromImage=docker&") {
                return (
                    200,
                    r#"{"error":"failed to fetch anonymous token: 429 Too Many Requests"}"#
                        .to_string(),
                );
            }
            return (200, r#"{"status":"Downloaded newer image"}"#.to_string());
        }
        if path.starts_with("/images/") && path.ends_with("/json") {
            return (
                200,
                serde_json::json!({
                    "Id": "sha256:new",
                    "RepoDigests": ["ghcr.io/firetower-cloud/firetower-updater@sha256:new"],
                    "Config": {"Labels": {"org.opencontainers.image.version": "0.39.0"}}
                })
                .to_string(),
            );
        }
        if method == hyper::Method::POST && path.starts_with("/containers/create") {
            return if awkward.create_fails {
                (
                    404,
                    r#"{"message":"No such image: docker:28-cli"}"#.to_string(),
                )
            } else {
                (201, r#"{"Id":"helper-container"}"#.to_string())
            };
        }
        if method == hyper::Method::DELETE {
            return (204, String::new());
        }
        if path.ends_with("/start") {
            return (204, String::new());
        }
        (200, "{}".to_string())
    }

    fn jobs_for(docker: crate::docker::Docker) -> (Jobs, Reporter) {
        jobs_with(
            docker,
            crate::site::Site {
                project: "firetower".into(),
                service: "updater".into(),
                deploy_dir: "/opt/firetower".into(),
                config_files: vec!["/opt/firetower/firetower.yml".into()],
                mount: std::path::PathBuf::from("/deploy"),
            },
        )
    }

    /// A site whose deployment directory is a real one, for a test that reads
    /// or writes the compose file.
    fn site_at(dir: &std::path::Path) -> crate::site::Site {
        crate::site::Site {
            project: "firetower".into(),
            service: "updater".into(),
            deploy_dir: dir.display().to_string(),
            config_files: vec![dir.join(crate::site::COMPOSE_FILE).display().to_string()],
            mount: dir.to_path_buf(),
        }
    }

    fn jobs_with(docker: crate::docker::Docker, site: crate::site::Site) -> (Jobs, Reporter) {
        let jobs = Jobs::new(docker, site);
        let reporter = Reporter {
            id: JobId("test".into()),
            held: jobs.held.clone(),
        };
        jobs.held.lock().unwrap().insert(
            "test".into(),
            Job {
                id: JobId("test".into()),
                kind: JobKind::UpgradeUpdater {
                    version: "0.39.0".into(),
                    tag: None,
                },
                state: JobState::Running,
                steps: Vec::new(),
                log: Vec::new(),
                error: None,
                previous_image: None,
                image: None,
                created_at: chrono::Utc::now(),
                finished_at: None,
            },
        );
        (jobs, reporter)
    }

    /// A channel switch rewrites the compose file to a different tag in the
    /// same job, so the image to fetch is the one the file will name and not
    /// the one the container came from. Without this the switch pulls
    /// `:stable`, finds the general-access version, and refuses the move it
    /// was asked to make.
    #[tokio::test]
    async fn an_explicit_tag_is_what_gets_fetched() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon(seen.clone(), Awkward::default()).await;
        let (jobs, say) = jobs_for(docker);

        jobs.upgrade_self(&say, "0.39.0", Some("beta"))
            .await
            .unwrap();

        let asked = seen.lock().unwrap().clone();
        assert!(
            asked.iter().any(|r| r.contains(
                "/images/create?fromImage=ghcr.io%2Ffiretower-cloud%2Ffiretower-updater&tag=beta"
            )),
            "it should have pulled :beta, not the container's :latest: {asked:#?}"
        );
    }

    /// Nothing else pulls the helper image before this point — the
    /// control-plane step does, and that runs afterwards — so on the first
    /// upgrade of any install it is not on the machine. Creating a container
    /// from an image that is not there is a 404, and this used to be thrown
    /// away along with the rest of the handover.
    #[tokio::test]
    async fn the_helper_image_is_fetched_before_the_container_that_runs_it() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon(seen.clone(), Awkward::default()).await;
        let (jobs, say) = jobs_for(docker);

        jobs.upgrade_self(&say, "0.39.0", None).await.unwrap();

        let asked = seen.lock().unwrap().clone();
        let pulled_helper = asked
            .iter()
            .position(|r| r.contains("/images/create") && r.contains("fromImage=docker"))
            .expect("the helper image is pulled");
        let created = asked
            .iter()
            .position(|r| r.contains("POST /containers/create"))
            .expect("the helper container is created");
        assert!(
            pulled_helper < created,
            "the image has to be there before the container is made: {asked:#?}"
        );
    }

    /// And when it still cannot be made, that is this job's failure to report
    /// — not silence for the control plane to wait out.
    #[tokio::test]
    async fn a_helper_that_cannot_be_made_fails_the_job() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon(
            seen.clone(),
            Awkward {
                create_fails: true,
                ..Default::default()
            },
        )
        .await;
        let (jobs, say) = jobs_for(docker);

        let outcome = jobs.upgrade_self(&say, "0.39.0", None).await;
        let said = format!("{:#}", outcome.unwrap_err());
        assert!(
            said.contains("helper container"),
            "it should say what could not be made: {said}"
        );

        // And the start is never reached, so nothing replaced this process.
        let asked = seen.lock().unwrap().clone();
        assert!(
            !asked.iter().any(|r| r.ends_with("/start")),
            "nothing should have been started: {asked:#?}"
        );
    }

    /// A registry that will not answer is not a reason to refuse an upgrade
    /// whose helper image is already on the machine. Docker Hub's token
    /// endpoint failing for twenty seconds, mid-upgrade, rolled a control
    /// plane back for nothing.
    #[tokio::test]
    async fn a_registry_that_will_not_answer_is_survivable_when_the_image_is_here() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon(
            seen.clone(),
            Awkward {
                helper_pull_fails: true,
                ..Default::default()
            },
        )
        .await;
        let (jobs, say) = jobs_for(docker);

        jobs.upgrade_self(&say, "0.39.0", None)
            .await
            .expect("the copy already here is good enough");

        let asked = seen.lock().unwrap().clone();
        assert!(
            asked.iter().any(|r| r.contains("POST /containers/create")),
            "it should still have made the helper: {asked:#?}"
        );
    }

    /// A compose file naming a tag the container was not created from is what
    /// the release that moves an image line leaves behind: Compose rewrote
    /// nothing under the running container, so the file is ahead of it until
    /// the next recreate. The file is the one Compose reads.
    ///
    /// Without this the updater fetches the tag its own container came from,
    /// Compose is run with `--pull never` against a file naming another, and
    /// the recreate fails on an image that was never asked for. #407.
    #[tokio::test]
    async fn the_updater_follows_its_compose_file_when_nobody_names_a_tag() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon(seen.clone(), Awkward::default()).await;
        let deploy = tempfile::tempdir().unwrap();
        std::fs::write(
            deploy.path().join(crate::site::COMPOSE_FILE),
            "services:\n  firetower:\n    image: ghcr.io/firetower-cloud/firetower:stable\n  \
             updater:\n    image: ghcr.io/firetower-cloud/firetower-updater:stable\n",
        )
        .unwrap();
        let (jobs, say) = jobs_with(docker, site_at(deploy.path()));

        jobs.upgrade_self(&say, "0.39.0", None).await.unwrap();

        let asked = seen.lock().unwrap().clone();
        assert!(
            asked.iter().any(|r| r.contains(
                "/images/create?fromImage=ghcr.io%2Ffiretower-cloud%2Ffiretower-updater&tag=stable"
            )),
            "it should have pulled the file's :stable, not the container's :latest: {asked:#?}"
        );
    }

    /// And the tag the caller named still wins over the file, because a
    /// channel switch rewrites the image lines in the step *after* this one:
    /// while the updater is being replaced the file still names the channel
    /// being left, and the caller is the only thing that knows otherwise.
    #[tokio::test]
    async fn a_named_tag_still_wins_over_the_file_it_has_not_rewritten_yet() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon(seen.clone(), Awkward::default()).await;
        let deploy = tempfile::tempdir().unwrap();
        std::fs::write(
            deploy.path().join(crate::site::COMPOSE_FILE),
            "services:\n  updater:\n    image: ghcr.io/firetower-cloud/firetower-updater:stable\n",
        )
        .unwrap();
        let (jobs, say) = jobs_with(docker, site_at(deploy.path()));

        jobs.upgrade_self(&say, "0.39.0", Some("beta"))
            .await
            .unwrap();

        let asked = seen.lock().unwrap().clone();
        assert!(
            asked.iter().any(|r| r.contains(
                "/images/create?fromImage=ghcr.io%2Ffiretower-cloud%2Ffiretower-updater&tag=beta"
            )),
            "the switch's own tag should still be the one fetched: {asked:#?}"
        );
    }

    /// The pin is read from the compose file, which is where an operator put
    /// it — so it is refused even when the container the updater can see was
    /// created from something that floats. Nothing is written and nothing is
    /// recreated: a refusal has to leave the deployment exactly as it was.
    #[tokio::test]
    async fn an_exact_version_in_the_compose_file_is_refused() {
        let seen: Seen = Default::default();
        let (docker, _dir) = fake_daemon_running(
            seen.clone(),
            Awkward::default(),
            "ghcr.io/firetower-cloud/firetower:latest",
        )
        .await;
        let deploy = tempfile::tempdir().unwrap();
        let was = "services:\n  firetower:\n    image: ghcr.io/firetower-cloud/firetower:latest\n";
        std::fs::write(deploy.path().join(crate::site::COMPOSE_FILE), was).unwrap();
        let (jobs, say) = jobs_with(docker, site_at(deploy.path()));

        let pins = "services:\n  firetower:\n    image: ghcr.io/firetower-cloud/firetower:0.39.0\n";
        let outcome = jobs
            .upgrade_control_plane(
                &say,
                "0.39.0",
                &[FileWrite {
                    name: crate::site::COMPOSE_FILE.into(),
                    content: pins.into(),
                }],
                None,
            )
            .await;

        let said = format!("{:#}", outcome.unwrap_err());
        assert!(said.contains("pinned to :0.39.0"), "{said}");
        assert_eq!(
            std::fs::read_to_string(deploy.path().join(crate::site::COMPOSE_FILE)).unwrap(),
            was,
            "a refusal must not have rewritten the file"
        );
        let asked = seen.lock().unwrap().clone();
        assert!(
            !asked.iter().any(|r| r.contains("/images/create")),
            "and nothing should have been pulled: {asked:#?}"
        );
    }

    // ── a real deployment, across a tag change ─────────────────────────
    //
    // Everything above runs against a fake daemon, and every one of those
    // tests passed while an upgrade that moves the image line from one tag to
    // another could not complete at all. The defect was in neither half: it
    // was in the join between a file being rewritten and Compose being run
    // against that file, and only a real daemon, a real registry and a real
    // `docker compose` have that join in them. See #407.
    //
    // So this builds a deployment. Two images with a version stamped on them
    // and a `/readyz` to answer, a registry on loopback to pull from, the
    // repository's own `deploy/firetower.yml` as the release's copy, and the
    // same file with the general-access tag put back to the floating one as
    // the copy already on the machine — which is exactly the shape of 0.55.0
    // beside 0.56.0.
    //
    // It needs the Docker socket, the way the database tests need Postgres.

    /// Where the daemon is, for a test running on the machine rather than in
    /// a container beside it.
    fn socket_path() -> std::path::PathBuf {
        match std::env::var("DOCKER_HOST") {
            Ok(host) => match host.strip_prefix("unix://") {
                Some(path) => std::path::PathBuf::from(path),
                None => std::path::PathBuf::from(crate::docker::SOCKET),
            },
            Err(_) => std::path::PathBuf::from(crate::docker::SOCKET),
        }
    }

    /// `docker …`, for building the deployment. Never for the thing under
    /// test: that goes through the updater's own client, over the socket.
    fn cli(args: &[&str]) -> String {
        let out = std::process::Command::new("docker")
            .args(args)
            .output()
            .unwrap_or_else(|e| {
                panic!(
                    "this test needs Docker, the way the database tests need Postgres. \
                     `docker {}` could not be run: {e}",
                    args.join(" ")
                )
            });
        assert!(
            out.status.success(),
            "docker {} exited {:?}\n{}{}",
            args.join(" "),
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Best effort, for tearing down: a container that is already gone is not
    /// a failure.
    fn cli_quietly(args: &[&str]) {
        let _ = std::process::Command::new("docker").args(args).output();
    }

    /// `n` ports nothing on this machine is listening on. Bound and released,
    /// so they are ports the kernel just handed out rather than guesses — and
    /// all bound at once, because a port released and asked for again can be
    /// handed back, and two of these in the same deployment have to differ.
    fn free_ports<const N: usize>() -> [u16; N] {
        let held: Vec<std::net::TcpListener> = (0..N)
            .map(|_| std::net::TcpListener::bind("127.0.0.1:0").expect("a loopback port"))
            .collect();
        let mut ports = [0u16; N];
        for (port, listener) in ports.iter_mut().zip(&held) {
            *port = listener.local_addr().unwrap().port();
        }
        ports
    }

    /// `deploy/firetower.yml` with both Firetower image lines on `tag`.
    ///
    /// The repository's own file names `:stable`, and only the two Firetower
    /// lines do — the database's `postgres:17-alpine` is left alone, which is
    /// the same thing the control plane's `retag` guarantees by only touching
    /// repositories the updater reported.
    fn retagged(compose: &str, tag: &str) -> String {
        compose.replace(
            &format!(":{}", ft_updater_api::tags::STABLE),
            &format!(":{tag}"),
        )
    }

    /// The deployment this test upgrades, and everything made for it.
    ///
    /// Torn down on the way out, including when a panic is what is on the way
    /// out — nothing here is shared with anything else on the machine, and a
    /// run that leaves a registry and three volumes behind is a run nobody
    /// does twice.
    struct Deployment {
        project: String,
        registry: String,
        dir: tempfile::TempDir,
        /// `deploy/firetower.yml` as the release ships it: the general-access
        /// tag, which is not the tag the file on the machine names.
        release_compose: String,
        site: crate::site::Site,
        /// Where the control plane answers on this machine. Normally the
        /// updater reaches it over the compose network, and a test running
        /// beside the daemon rather than in a container on it cannot.
        published: u16,
    }

    const WAS: &str = "0.55.0";
    const NOW: &str = "0.56.0";

    impl Deployment {
        /// Build it: two images, a registry holding the newer one under every
        /// channel tag, and Compose having created the containers from the
        /// older one on the floating tag — every installation before channels
        /// existed.
        async fn made() -> Self {
            Self::made_on(ft_updater_api::tags::LATEST, WAS).await
        }

        /// The same deployment, started from a given tag and a given release.
        ///
        /// `(:latest, WAS)` is the installation an upgrade moves onto a
        /// channel. `(:stable, NOW)` is one already on general access, which
        /// is what a channel switch is performed on — and because the
        /// registry holds one build under every channel tag, the switch's
        /// destination is the same image the containers are already running.
        /// **That is the shape this was silent in:** nothing to recreate, as
        /// far as an image id can tell, and the tag is the whole of what a
        /// switch changes.
        async fn made_on(start: &'static str, running: &'static str) -> Self {
            let id = ulid::Ulid::new().to_string().to_lowercase();
            let project = format!("ft-updater-test-{id}");
            let dir = tempfile::tempdir().expect("a directory for the deployment");
            let [port, published] = free_ports::<2>();
            let registry = format!("127.0.0.1:{port}");
            let compose = dir
                .path()
                .join(crate::site::COMPOSE_FILE)
                .display()
                .to_string();

            // Built before the first thing that can leave something behind,
            // so that a setup which panics half way still tears down what it
            // had got to: this is a local, and unwinding drops it.
            let mut deployment = Self {
                site: crate::site::Site {
                    project: project.clone(),
                    service: "updater".into(),
                    deploy_dir: dir.path().display().to_string(),
                    config_files: vec![compose.clone()],
                    mount: dir.path().to_path_buf(),
                },
                project,
                registry,
                dir,
                release_compose: String::new(),
                published,
            };
            let project = deployment.project.clone();
            let registry = deployment.registry.clone();

            // A registry on loopback. Docker treats 127.0.0.1 as insecure
            // without being told to, so this needs no daemon configuration.
            cli(&[
                "run",
                "-d",
                "--name",
                &format!("{project}-registry"),
                "-p",
                &format!("127.0.0.1:{port}:5000"),
                "registry:2",
            ]);

            // Two images that differ only in the version the build stamped on
            // them, which is the one thing `pull_release` checks.
            let build = deployment.dir.path().join("image");
            std::fs::create_dir_all(&build).unwrap();
            std::fs::write(
                build.join("Dockerfile"),
                "FROM nginx:alpine\n\
                 ARG V\n\
                 LABEL org.opencontainers.image.version=$V\n\
                 RUN printf 'server {\\n listen 4400;\\n location /readyz { return 200 \"ok\"; }\\n}\\n' \
                 > /etc/nginx/conf.d/default.conf\n",
            )
            .unwrap();
            let at = build.display().to_string();
            let old = format!("{project}-old");
            let new = format!("{project}-new");
            cli(&[
                "build",
                "-q",
                "--build-arg",
                &format!("V={WAS}"),
                "-t",
                &old,
                &at,
            ]);
            cli(&[
                "build",
                "-q",
                "--build-arg",
                &format!("V={NOW}"),
                "-t",
                &new,
                &at,
            ]);

            // The registry holds the new build under every channel tag,
            // which is what this installation is today: `:stable` and
            // `:beta` are one image, and so is `:latest`.
            for repo in ["firetower", "firetower-updater"] {
                for tag in [
                    ft_updater_api::tags::LATEST,
                    ft_updater_api::tags::STABLE,
                    ft_updater_api::tags::BETA,
                ] {
                    let reference = format!("{registry}/{repo}:{tag}");
                    cli(&["tag", &new, &reference]);
                    cli(&["push", "-q", &reference]);
                    // Off the machine again: a deployment that has not
                    // upgraded yet does not have the new image, and a pull
                    // that found it already here would prove nothing.
                    cli(&["rmi", &reference]);
                }
                // What it does have is the build it is running, under the one
                // tag its own compose file names. Every other tag has to be
                // fetched.
                let here = if running == WAS { &old } else { &new };
                cli(&["tag", here, &format!("{registry}/{repo}:{start}")]);
            }
            cli(&["rmi", &new]);

            // The deployment's own files: the repository's `firetower.yml`
            // with this registry in place of ghcr.io, and the image lines put
            // back to the tag the previous release named.
            let release_compose = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../deploy/firetower.yml"),
            )
            .expect("the repository's own deploy/firetower.yml")
            .replace("ghcr.io/firetower-cloud/", &format!("{registry}/"));
            let on_the_machine = retagged(&release_compose, start);

            // Asserted rather than assumed: an operation that moves no image
            // line would exercise nothing, and a test of a tag change that
            // changes no tag is the check #388 is about. Each test asserts
            // the move it performs; this is the floor both stand on.
            let repository = format!("{registry}/firetower");
            let from = ft_updater_api::image_tag(&on_the_machine, &repository);
            let to = ft_updater_api::image_tag(&release_compose, &repository);
            assert_eq!(
                from.as_deref(),
                Some(start),
                "the file on the machine has to name the tag it was started on"
            );
            assert_eq!(to.as_deref(), Some(ft_updater_api::tags::STABLE));

            let dir = deployment.dir.path();
            std::fs::write(dir.join(crate::site::COMPOSE_FILE), &on_the_machine).unwrap();
            std::fs::write(
                dir.join(".env"),
                format!(
                    "POSTGRES_PASSWORD=updater-test\nHTTP_PORT={published}\n\
                     FIRETOWER_UPDATER_TOKEN=updater-test\n"
                ),
            )
            .unwrap();

            cli(&["compose", "-p", &project, "-f", &compose, "up", "-d"]);

            deployment.release_compose = release_compose;
            deployment
        }

        fn jobs(&self) -> (Jobs, Reporter) {
            jobs_with(crate::docker::Docker::at(socket_path()), self.site.clone())
        }

        /// What the release asks the updater to write.
        fn writes(&self) -> Vec<FileWrite> {
            self.writes_onto(ft_updater_api::tags::STABLE)
        }

        /// What a switch onto `tag` asks the updater to write: the release's
        /// own copy of the file with **both** image lines moved, which is
        /// what the control plane's `retag` produces.
        fn writes_onto(&self, tag: &str) -> Vec<FileWrite> {
            vec![FileWrite {
                name: crate::site::COMPOSE_FILE.into(),
                content: retagged(&self.release_compose, tag),
            }]
        }

        /// The tag a container of this deployment was created from, as
        /// Compose recorded it — which is what the channel is read off.
        ///
        /// `None` while it cannot be read. A recreate is two containers for a
        /// moment, and the daemon lists them before it is asked about each
        /// one, so a container that was listed can be gone by the time it is
        /// inspected. That is "not yet", not an answer.
        async fn tag_of(&self, jobs: &Jobs, service: &str) -> Option<String> {
            let container = jobs.service_container(service).await.ok()??;
            Some(split_reference(&container.image_ref).1)
        }

        /// The same, waited for: the tag `service` is on once it has stopped
        /// moving, or whatever it is on when the wait runs out.
        async fn tag_settled(&self, jobs: &Jobs, service: &str, wanted: &str) -> Option<String> {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(120);
            loop {
                let read = self.tag_of(jobs, service).await;
                if read.as_deref() == Some(wanted) || std::time::Instant::now() >= until {
                    return read;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        }

        fn compose_file(&self) -> String {
            std::fs::read_to_string(self.dir.path().join("firetower.yml")).unwrap()
        }
    }

    impl Drop for Deployment {
        fn drop(&mut self) {
            let compose = self.dir.path().join("firetower.yml").display().to_string();
            cli_quietly(&[
                "compose",
                "-p",
                &self.project,
                "-f",
                &compose,
                "down",
                "-v",
                "-t",
                "1",
            ]);
            cli_quietly(&["rm", "-f", &format!("{}-registry", self.project)]);
            // The helper that recreates the *updater* is the one nothing
            // removes: the new updater sweeps it when it starts, and in this
            // test there is no new updater process to do it. Removed by the
            // same name `compose_up` already removes before reusing.
            for n in 0..4 {
                cli_quietly(&["rm", "-f", &format!("firetower-updater-helper-test-{n}")]);
            }
            for repo in ["firetower", "firetower-updater"] {
                for tag in ["latest", "stable", "beta"] {
                    cli_quietly(&["rmi", "-f", &format!("{}/{repo}:{tag}", self.registry)]);
                }
            }
            cli_quietly(&["rmi", "-f", &format!("{}-old", self.project)]);
        }
    }

    /// The release that moves both image lines from the floating tag to the
    /// general-access one, performed against a deployment that is on the
    /// floating tag — which is every installation there was.
    ///
    /// The pull has to be of the tag the file names *after* the rewrite.
    /// Pulling the one the container was created from puts the new image on
    /// the machine under a name the rewritten file does not mention, and
    /// `--pull never` then has Compose refuse an image it cannot find. Four
    /// real deployments rolled back cleanly and none of them could upgrade.
    #[tokio::test]
    async fn an_upgrade_that_moves_the_image_line_to_another_tag_goes_through() {
        // Read by `wait_healthy`, which normally reaches the control plane
        // over the compose network. This test is on the machine rather than
        // in a container on it, so it goes in by the published port.
        // Process-global, and nothing else in this binary reads it.
        let deployment = Deployment::made().await;
        std::env::set_var(
            "FIRETOWER_UPDATER_CP_URL",
            format!("http://127.0.0.1:{}", deployment.published),
        );

        let (jobs, say) = deployment.jobs();
        // `None`: the control plane that asks for this upgrade is the one
        // being replaced, and the release before channels existed does not
        // name a tag. The updater has to work it out from the file it is
        // being asked to write.
        let outcome = jobs
            .upgrade_control_plane(&say, NOW, &deployment.writes(), None)
            .await;
        let log = jobs
            .get("test")
            .map(|j| j.log.join("\n"))
            .unwrap_or_default();

        assert_eq!(
            outcome.as_ref().ok(),
            Some(&JobState::Done),
            "the upgrade did not go through:\n{log}"
        );

        // And what is running is the release, under the tag the file now
        // names — not the old image, and not the new one under the old name.
        let now = jobs
            .service_container("firetower")
            .await
            .unwrap()
            .expect("a control-plane container");
        assert_eq!(
            now.image_ref,
            format!(
                "{}/firetower:{}",
                deployment.registry,
                ft_updater_api::tags::STABLE
            ),
            "it should have come up from the tag the rewritten file names:\n{log}"
        );
        let stamped = jobs
            .docker
            .inspect_image(&now.image_id)
            .await
            .unwrap()
            .version()
            .map(str::to_string);
        assert_eq!(
            stamped.as_deref(),
            Some(NOW),
            "and it should be the release"
        );
        assert!(
            deployment.compose_file().contains(&format!(
                "{}/firetower:{}",
                deployment.registry,
                ft_updater_api::tags::STABLE
            )),
            "the file should have been rewritten"
        );
    }
    /// A channel switch has to move the updater as well as the control plane.
    ///
    /// The two images are published together, always, and the control plane
    /// checks its API version against the updater's on every call — the
    /// deployment file says so on the updater's own image line: *change both
    /// lines or neither*. **The channel is the tag**, so a container left on
    /// the tag of the channel being left is on the old channel, whatever
    /// bytes it is running.
    ///
    /// Which is why this is performed in the shape the defect was silent in:
    /// both channels holding one build, so the destination tag resolves to
    /// the image the containers are already running. The control plane still
    /// moves — its step rewrites files, and a rewrite is a reason to recreate
    /// — and the updater's own step, which has nothing to write, decided from
    /// the image id alone that there was nothing to do and left itself on the
    /// channel being left. Nothing afterwards compared the two, so it was
    /// silent. #478.
    #[tokio::test]
    async fn a_channel_switch_moves_the_updater_as_well_as_the_control_plane() {
        use ft_updater_api::tags::{BETA, STABLE};

        // Read by `wait_healthy`, which normally reaches the control plane
        // over the compose network. This test is on the machine rather than
        // in a container on it, so it goes in by the published port.
        let deployment = Deployment::made_on(STABLE, NOW).await;
        std::env::set_var(
            "FIRETOWER_UPDATER_CP_URL",
            format!("http://127.0.0.1:{}", deployment.published),
        );

        let (jobs, say) = deployment.jobs();
        let writes = deployment.writes_onto(BETA);
        let switched = writes[0].content.clone();

        // The premise, asserted: this switch moves *both* image lines, and it
        // moves them to a tag that is the same image as the one already
        // running. A test of a switch that moved no line, or that moved onto
        // a different build, would not be a test of #478.
        for repo in ["firetower", "firetower-updater"] {
            let repository = format!("{}/{repo}", deployment.registry);
            assert_eq!(
                ft_updater_api::image_tag(&deployment.compose_file(), &repository).as_deref(),
                Some(STABLE),
                "{repo} should start on the channel being left"
            );
            assert_eq!(
                ft_updater_api::image_tag(&switched, &repository).as_deref(),
                Some(BETA),
                "{repo}'s line should be moved by this switch"
            );
        }
        assert_eq!(
            deployment.tag_of(&jobs, "updater").await.as_deref(),
            Some(STABLE),
            "the updater's container should start on the channel being left"
        );

        // A switch is this, in this order: the control-plane step, which is
        // what rewrites the image lines, and then the updater's own, which
        // runs second so that the file it is recreated against already names
        // the channel being taken. `runs::steps_for` puts them this way
        // round for a switch and the other way round for an upgrade.
        let outcome = jobs
            .upgrade_control_plane(&say, NOW, &writes, Some(BETA))
            .await;
        let log = || {
            jobs.get("test")
                .map(|j| j.log.join("\n"))
                .unwrap_or_default()
        };
        assert_eq!(
            outcome.as_ref().ok(),
            Some(&JobState::Done),
            "the control plane did not move onto the channel:\n{}",
            log()
        );
        let control_plane = deployment.tag_of(&jobs, "firetower").await;
        assert_eq!(
            control_plane.as_deref(),
            Some(BETA),
            "the control plane should be on the channel being taken:\n{}",
            log()
        );

        let outcome = jobs
            .upgrade_self(&say, NOW, Some(BETA))
            .await
            .unwrap_or_else(|e| panic!("the updater's own step failed: {e:#}\n{}", log()));
        // `Running` is the handover: the helper recreates this container
        // after the job has returned, so the result is waited for. `Done`
        // means it decided there was nothing to do, and no wait will change
        // the answer — which is the shape of the defect, and is read once.
        let updater = match outcome {
            JobState::Running => deployment.tag_settled(&jobs, "updater", BETA).await,
            _ => deployment.tag_of(&jobs, "updater").await,
        };
        assert_eq!(
            updater.as_deref(),
            Some(BETA),
            "the switch left the updater on :{} while the control plane went to :{} — they are \
             published together and cannot be on different channels:\n{}",
            updater.as_deref().unwrap_or("?"),
            control_plane.as_deref().unwrap_or("?"),
            log()
        );
        assert_eq!(
            updater, control_plane,
            "both of the deployment's containers have to be on one channel"
        );
    }
}
