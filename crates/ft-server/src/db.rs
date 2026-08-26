//! The control plane's cache.
//!
//! Nothing here is authoritative. Hosts, repositories and credentials are ours;
//! sessions and events are a projection of what workers reported, rebuildable by
//! reconnecting and replaying from sequence zero.

use anyhow::{Context, Result};
use ft_core::{
    session::Checkout, Agent, AgentMode, AgentPresence, Compute, Event, EventKind, Host, HostId,
    HostState, Repo, RepoId, Session, SessionId, SessionStatus, WorkspaceSize,
};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

/// What one host last said about one agent, and when.
pub struct StoredPresence {
    pub host: HostId,
    pub found: AgentPresence,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

impl Db {
    /// Connect and bring the schema up to date.
    ///
    /// The message on failure names the URL, because "connection refused" with
    /// no address is the least useful thing a program can say at start-up.
    pub async fn open(url: &str) -> Result<Self> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(url)
            .await
            .with_context(|| format!("connecting to {}", redacted(url)))?;

        Self::migrated(pool).await
    }

    /// Whether the database will answer, for `/readyz`.
    ///
    /// A real query rather than inspecting the pool: a pool can hold a
    /// connection that Postgres closed on its side, and reporting ready on the
    /// strength of a handle is how a container passes its health check while
    /// failing every request.
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .execute(&self.pool)
            .await
            .context("the database did not answer")?;
        Ok(())
    }

    /// For the vault, which owns its own tables but not its own connection —
    /// one pool, so a secret written while a session starts is in the same
    /// transaction discipline as everything else.
    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    async fn migrated(pool: PgPool) -> Result<Self> {
        sqlx::migrate!("../../migrations/server")
            .run(&pool)
            .await
            .context("applying control-plane migrations")?;
        Ok(Self { pool })
    }

    /// A test database with an organization and an administrator in it.
    ///
    /// Almost everything is owned now — a host belongs to an organization, a
    /// session to a person — and the foreign keys say so, so a test that
    /// inserts one needs the same rows a first boot creates. Returns the
    /// owner's id, which is what those inserts want.
    #[cfg(test)]
    pub async fn open_for_test_owned() -> Result<(Self, String)> {
        let db = Self::open_for_test().await?;
        let accounts = crate::accounts::Accounts::new(db.pool().clone());
        let user = accounts
            .create_first_admin("admin", "first-password")
            .await?;
        let id = user.id.as_str().to_string();
        Ok((db, id))
    }

    /// A database of its own, for one test.
    ///
    /// A schema rather than a container: tests then run in parallel against one
    /// server without seeing each other's rows, and cleaning up is a `DROP`.
    #[cfg(test)]
    pub async fn open_for_test() -> Result<Self> {
        let url = std::env::var("DATABASE_URL").unwrap_or_else(|_| {
            "postgres://firetower:firetower@localhost:5433/firetower".to_string()
        });

        let schema = format!("test_{}", ulid::Ulid::new().to_string().to_lowercase());

        let pool = PgPoolOptions::new()
            .max_connections(2)
            // Every connection in this pool works inside the test's own schema.
            .after_connect({
                let schema = schema.clone();
                move |conn, _| {
                    let schema = schema.clone();
                    Box::pin(async move {
                        sqlx::query(&format!("CREATE SCHEMA IF NOT EXISTS {schema}"))
                            .execute(&mut *conn)
                            .await?;
                        sqlx::query(&format!("SET search_path TO {schema}"))
                            .execute(&mut *conn)
                            .await?;
                        Ok(())
                    })
                }
            })
            .connect(&url)
            .await
            .with_context(|| {
                format!(
                    "these tests need Postgres. Start it with `just db`, or set \
                     DATABASE_URL. Tried {}",
                    redacted(&url)
                )
            })?;

        // Before this run adds one of its own.
        sweep_test_schemas(&pool).await;

        Self::migrated(pool).await
    }

    // ── hosts ──────────────────────────────────────────────────────────

    /// Which organization this Firetower belongs to.
    ///
    /// One row, so one answer. It exists as a lookup rather than a constant
    /// because the things that ask — a host coming up, a repository being
    /// connected — happen where there may be nobody signed in to ask instead.
    pub async fn org(&self) -> Result<String> {
        let row = sqlx::query("SELECT org_id FROM installation")
            .fetch_optional(&self.pool)
            .await?
            .context("this Firetower has no organization yet")?;
        Ok(row.get("org_id"))
    }

    /// Register a host, or leave the existing one alone.
    ///
    /// `localhost` goes through this like any other host, because it *is* one.
    pub async fn ensure_host(&self, name: &str, compute: Compute) -> Result<Host> {
        if let Some(existing) = self.host_by_name(name).await? {
            return Ok(existing);
        }
        let id = HostId::new();
        sqlx::query(
            "INSERT INTO hosts (id, org_id, name, compute, state, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id.as_str())
        // Compute is the team's: somebody pays for a machine and everybody
        // runs on it.
        .bind(self.org().await?)
        .bind(name)
        .bind(serde_json::to_value(&compute)?)
        .bind("Unreachable")
        .bind(chrono::Utc::now())
        .execute(&self.pool)
        .await?;

        self.host_by_name(name)
            .await?
            .context("host vanished immediately after insert")
    }

    /// Call a session something else.
    ///
    /// Only the name. The number it was given cannot change — it is what a
    /// renamed session can still be traced back to, and what nothing else is
    /// allowed to take.
    /// Change what a repository does before an agent starts, and where its
    /// variables are written.
    ///
    /// Both are optional and both are answered: `Some(None)` clears one,
    /// `None` leaves it as it was. A form that only edits the setup command
    /// must not silently drop the file path.
    pub async fn update_repo(
        &self,
        id: &RepoId,
        setup: Option<Option<&str>>,
        env_file: Option<Option<&str>>,
    ) -> Result<()> {
        if let Some(setup) = setup {
            sqlx::query("UPDATE repos SET setup = $1 WHERE id = $2")
                .bind(setup)
                .bind(id.as_str())
                .execute(&self.pool)
                .await
                .context("saving a setup command")?;
        }

        if let Some(env_file) = env_file {
            sqlx::query("UPDATE repos SET env_file = $1 WHERE id = $2")
                .bind(env_file)
                .bind(id.as_str())
                .execute(&self.pool)
                .await
                .context("saving an environment file path")?;
        }

        Ok(())
    }

    pub async fn rename_session(&self, id: &SessionId, name: &str) -> Result<()> {
        sqlx::query("UPDATE sessions SET name = $1, updated_at = $2 WHERE id = $3")
            .bind(name.trim())
            .bind(chrono::Utc::now())
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .context("renaming a session")?;
        Ok(())
    }

    /// Take a host out of service, or put it back.
    ///
    /// Draining is deliberately not a `HostState`: a draining host is still
    /// online and still finishing work, and conflating the two would make its
    /// sessions look unreachable.
    pub async fn set_drained(&self, id: &HostId, drained: bool) -> Result<()> {
        sqlx::query("UPDATE hosts SET drained = $1 WHERE id = $2")
            .bind(drained)
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn is_drained(&self, id: &HostId) -> Result<bool> {
        let row = sqlx::query("SELECT drained FROM hosts WHERE id = $1")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<bool, _>("drained")).unwrap_or(false))
    }

    /// Give a host a different name.
    ///
    /// Only the name: what a host *is* was decided when it was added, and
    /// changing where it points is removing it and adding another. Names are
    /// unique, so this can fail — and the caller has to say so in words rather
    /// than showing a constraint violation.
    pub async fn rename_host(&self, id: &HostId, name: &str) -> Result<()> {
        sqlx::query("UPDATE hosts SET name = $1 WHERE id = $2")
            .bind(name.trim())
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .context("renaming a host")?;
        Ok(())
    }

    /// Forget a host. Its sessions must be dealt with first.
    pub async fn delete_host(&self, id: &HostId) -> Result<()> {
        sqlx::query("DELETE FROM hosts WHERE id = $1")
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Sessions still running on a host, for refusing to remove it.
    /// End a session here without the machine being told.
    ///
    /// For a host that is not answering, where the usual ending — ask the
    /// worker, let its event come back — has nobody to ask. `forgotten_at` is
    /// what keeps a later replay from undoing this.
    pub async fn forget_session(&self, id: &SessionId) -> Result<()> {
        let now = chrono::Utc::now();
        sqlx::query(
            "UPDATE sessions SET status = 'Ended', forgotten_at = $1, updated_at = $1
              WHERE id = $2",
        )
        .bind(now)
        .bind(id.as_str())
        .execute(&self.pool)
        .await
        .context("forgetting a session")?;
        Ok(())
    }

    /// Sessions removed here while this host was away, that it has not been
    /// told about yet.
    ///
    /// Removing one does not stop the agent — it cannot, with nothing
    /// listening. This is the debt: when the machine comes back, it still gets
    /// torn down.
    pub async fn owed_cleanup_on(&self, host: &HostId) -> Result<Vec<SessionId>> {
        let rows = sqlx::query(
            "SELECT id FROM sessions
              WHERE host_id = $1 AND forgotten_at IS NOT NULL AND cleaned_at IS NULL
              ORDER BY forgotten_at",
        )
        .bind(host.as_str())
        .fetch_all(&self.pool)
        .await
        .context("listing sessions still owed a teardown")?;

        Ok(rows
            .into_iter()
            .map(|r| SessionId::from_stored(r.get::<String, _>("id")))
            .collect())
    }

    /// The machine has been told to tear this one down, so stop asking.
    pub async fn mark_cleaned(&self, id: &SessionId) -> Result<()> {
        sqlx::query("UPDATE sessions SET cleaned_at = $1 WHERE id = $2")
            .bind(chrono::Utc::now())
            .bind(id.as_str())
            .execute(&self.pool)
            .await
            .context("recording a teardown")?;
        Ok(())
    }

    pub async fn live_sessions_on(&self, id: &HostId) -> Result<Vec<String>> {
        // A failed session holds nothing — no workspace, no agent, no claim on
        // the host. Counting it would block removing a host forever.
        let rows =
            sqlx::query("SELECT title FROM sessions WHERE host_id = $1 AND status NOT IN ($2, $3)")
                .bind(id.as_str())
                .bind(format!("{:?}", SessionStatus::Ended))
                .bind(format!("{:?}", SessionStatus::Failed))
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>("title")).collect())
    }

    /// The same sessions, by id — for telling a worker to end them rather than
    /// for telling a person which they are.
    pub async fn live_session_ids_on(&self, id: &HostId) -> Result<Vec<SessionId>> {
        let rows =
            sqlx::query("SELECT id FROM sessions WHERE host_id = $1 AND status NOT IN ($2, $3)")
                .bind(id.as_str())
                .bind(format!("{:?}", SessionStatus::Ended))
                .bind(format!("{:?}", SessionStatus::Failed))
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .iter()
            .map(|r| SessionId::from_stored(r.get::<String, _>("id")))
            .collect())
    }

    pub async fn host_by_name(&self, name: &str) -> Result<Option<Host>> {
        let row = sqlx::query("SELECT * FROM hosts WHERE name = $1")
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        row.map(host_from_row).transpose()
    }

    pub async fn host_by_id(&self, id: &HostId) -> Result<Option<Host>> {
        let row = sqlx::query("SELECT * FROM hosts WHERE id = $1")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        row.map(host_from_row).transpose()
    }

    /// Every host, skipping any row this build cannot understand.
    ///
    /// One unreadable row used to fail the whole query, which meant it failed
    /// start-up: the control plane would not boot at all because of one host,
    /// and the message — `decoding compute` — named neither the host nor the
    /// fact that the other ones were fine.
    ///
    /// A row gets that way by being written by a different build: a version
    /// that knew a kind of compute this one doesn't, or a downgrade. Refusing
    /// to start is the worst available answer. Skipping it loudly means the
    /// fleet keeps working and the row is still there to be looked at.
    pub async fn hosts(&self) -> Result<Vec<Host>> {
        Ok(sqlx::query("SELECT * FROM hosts ORDER BY created_at")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .filter_map(|row| {
                let id: String = row.get("id");
                let name: String = row.get("name");
                match host_from_row(row) {
                    Ok(host) => Some(host),
                    Err(e) => {
                        tracing::error!(
                            host = %name,
                            id = %id,
                            "this build cannot read that host, so it is being left out of the \
                             fleet: {e:#}. It was probably written by a different version. \
                             Nothing has been deleted."
                        );
                        None
                    }
                }
            })
            .collect())
    }

    pub async fn mark_host_online(
        &self,
        id: &HostId,
        version: &str,
        cpus: u32,
        memory_mb: u64,
    ) -> Result<()> {
        // The diagnosis goes with it: it described a machine that is now
        // answering, and a stale one sends someone to fix what works.
        sqlx::query(
            "UPDATE hosts SET state = 'Online', worker_version = $1, cpus = $2, memory_mb = $3,
                              last_seen_at = $4, diagnosis = NULL WHERE id = $5",
        )
        .bind(version)
        .bind(cpus as i64)
        .bind(memory_mb as i64)
        .bind(chrono::Utc::now())
        .bind(id.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A host we can't reach keeps its sessions visible — hiding them would make
    /// running work look as though it had disappeared.
    pub async fn mark_host_unreachable(&self, id: &HostId) -> Result<()> {
        sqlx::query("UPDATE hosts SET state = 'Unreachable' WHERE id = $1")
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Record why a host isn't answering, and mark it as not answering.
    ///
    /// Stored rather than returned once, so a host that failed unattended can
    /// still say why later.
    pub async fn record_diagnosis(&self, id: &HostId, told: &ft_core::Diagnosis) -> Result<()> {
        sqlx::query("UPDATE hosts SET state = 'Unreachable', diagnosis = $1 WHERE id = $2")
            .bind(serde_json::to_value(told)?)
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// How far we have consumed this worker's log.
    pub async fn last_seq(&self, id: &HostId) -> Result<i64> {
        let row = sqlx::query("SELECT last_seq FROM hosts WHERE id = $1")
            .bind(id.as_str())
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("last_seq"))
    }

    // ── repositories ───────────────────────────────────────────────────

    /// Keyed on the remote rather than the slug: two hosts can both have an
    /// `acme/backend`, and the URL is the thing that is actually unique.
    pub async fn ensure_repo(
        &self,
        slug: &str,
        remote: &str,
        default_branch: Option<&str>,
        setup: Option<&str>,
        added_by: Option<&str>,
    ) -> Result<Repo> {
        if let Some(existing) = self.repo_by_remote(remote).await? {
            return Ok(existing);
        }
        sqlx::query(
            "INSERT INTO repos (id, org_id, added_by, slug, remote, default_branch, setup, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(RepoId::new().as_str())
        // The organization's, so one row means one setup script and one
        // mirror. Who connected it is recorded beside it, and what actually
        // opens it is their token, which is theirs alone.
        .bind(self.org().await?)
        .bind(added_by)
        .bind(slug)
        .bind(remote)
        .bind(default_branch)
        .bind(setup)
        .bind(chrono::Utc::now())
        .execute(&self.pool)
        .await?;

        self.repo_by_remote(remote)
            .await?
            .context("repo vanished after insert")
    }

    // ── agents ─────────────────────────────────────────────────────────

    /// How each configured agent authenticates. Kinds nobody has touched are
    /// absent rather than present-and-empty.
    ///
    /// No secret here, not even a flag for one: the vault owns those, and
    /// asking it is one query — see [`crate::vault::Vault::holds`].
    pub async fn agent_modes(&self, owner: &str) -> Result<Vec<(Agent, AgentMode, bool)>> {
        let rows = sqlx::query("SELECT kind, mode, enabled FROM agents WHERE user_id = $1")
            .bind(owner)
            .fetch_all(&self.pool)
            .await?;

        Ok(rows
            .iter()
            .filter_map(|r| {
                let kind = Agent::from_name(&r.get::<String, _>("kind"))?;
                let mode = match r.get::<String, _>("mode").as_str() {
                    "Subscription" => AgentMode::Subscription,
                    "ApiKey" => AgentMode::ApiKey,
                    _ => AgentMode::NotNeeded,
                };
                Some((kind, mode, r.get::<bool, _>("enabled")))
            })
            .collect())
    }

    /// What a person's commits are signed with on one git host.
    ///
    /// Per person and per host, because somebody with three addresses has one
    /// of them on their GitHub and a different one at work — and the branch
    /// has to carry the one the host expects.
    pub async fn git_identity(
        &self,
        owner: &str,
        provider: &str,
    ) -> Result<Option<ft_proto::Author>> {
        let row = sqlx::query(
            "SELECT name, email FROM git_identities WHERE user_id = $1 AND provider = $2",
        )
        .bind(owner)
        .bind(provider)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| ft_proto::Author {
            name: r.get("name"),
            email: r.get("email"),
        }))
    }

    /// Where the stored one came from — `host` or `set`.
    pub async fn git_identity_source(&self, owner: &str, provider: &str) -> Result<Option<String>> {
        let row =
            sqlx::query("SELECT source FROM git_identities WHERE user_id = $1 AND provider = $2")
                .bind(owner)
                .bind(provider)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|r| r.get("source")))
    }

    /// Forget one, so the host's answer is used again.
    pub async fn forget_git_identity(&self, owner: &str, provider: &str) -> Result<()> {
        sqlx::query("DELETE FROM git_identities WHERE user_id = $1 AND provider = $2")
            .bind(owner)
            .bind(provider)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Keep one.
    ///
    /// `source` is `host` for what a token said and `set` for what somebody
    /// typed. A typed one is never overwritten by the host's answer: the whole
    /// reason to type one is that the derived answer was wrong.
    pub async fn remember_git_identity(
        &self,
        owner: &str,
        provider: &str,
        author: &ft_proto::Author,
        source: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO git_identities (user_id, provider, name, email, source, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (user_id, provider) DO UPDATE
                SET name       = excluded.name,
                    email      = excluded.email,
                    source     = excluded.source,
                    updated_at = excluded.updated_at
              WHERE git_identities.source <> 'set' OR excluded.source = 'set'",
        )
        .bind(owner)
        .bind(provider)
        .bind(&author.name)
        .bind(&author.email)
        .bind(source)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Configure an agent. The value it authenticates with is the vault's.
    pub async fn set_agent_mode(
        &self,
        owner: &str,
        kind: Agent,
        mode: AgentMode,
        enabled: bool,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO agents (user_id, kind, mode, enabled, updated_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT(user_id, kind) DO UPDATE SET mode = excluded.mode,
                                                      enabled = excluded.enabled,
                                                      updated_at = excluded.updated_at",
        )
        .bind(owner)
        .bind(format!("{kind:?}"))
        .bind(format!("{mode:?}"))
        .bind(enabled)
        .bind(chrono::Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Back to unconfigured. The stored value is the caller's to forget.
    pub async fn forget_agent(&self, owner: &str, kind: Agent) -> Result<()> {
        sqlx::query("DELETE FROM agents WHERE user_id = $1 AND kind = $2")
            .bind(owner)
            .bind(format!("{kind:?}"))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remember what a host said, so the screen renders before we can ask again.
    pub async fn record_presence(&self, host: &HostId, found: &[AgentPresence]) -> Result<()> {
        let now = chrono::Utc::now();
        for a in found {
            sqlx::query(
                "INSERT INTO agent_presence
                     (host_id, kind, installed, version, logged_in, account, checked_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT(host_id, kind) DO UPDATE SET installed = excluded.installed,
                                                          version = excluded.version,
                                                          logged_in = excluded.logged_in,
                                                          account = excluded.account,
                                                          checked_at = excluded.checked_at",
            )
            .bind(host.as_str())
            .bind(format!("{:?}", a.kind))
            .bind(a.installed)
            .bind(a.version.as_deref())
            .bind(a.logged_in)
            .bind(a.account.as_deref())
            .bind(now)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Everything every host last reported.
    pub async fn presence(&self) -> Result<Vec<StoredPresence>> {
        let rows = sqlx::query("SELECT * FROM agent_presence")
            .fetch_all(&self.pool)
            .await?;

        Ok(rows
            .iter()
            .filter_map(|r| {
                Some(StoredPresence {
                    host: HostId::from_stored(r.get::<String, _>("host_id")),
                    found: AgentPresence {
                        kind: Agent::from_name(&r.get::<String, _>("kind"))?,
                        installed: r.get::<bool, _>("installed"),
                        version: r.get::<Option<String>, _>("version"),
                        logged_in: r.get::<Option<bool>, _>("logged_in"),
                        account: r.get::<Option<String>, _>("account"),
                    },
                    checked_at: r.get::<chrono::DateTime<chrono::Utc>, _>("checked_at"),
                })
            })
            .collect())
    }

    pub async fn repo_by_remote(&self, remote: &str) -> Result<Option<Repo>> {
        let row = sqlx::query("SELECT * FROM repos WHERE remote = $1")
            .bind(remote)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(repo_from_row))
    }

    /// Sessions that would be orphaned by disconnecting a repository.
    ///
    /// Ended ones don't count — their work is done and their history stays
    /// readable either way.
    pub async fn live_sessions_for_repo(&self, slug: &str) -> Result<Vec<String>> {
        let rows =
            sqlx::query("SELECT title FROM sessions WHERE repo = $1 AND status NOT IN ($2, $3)")
                .bind(slug)
                .bind(format!("{:?}", SessionStatus::Ended))
                .bind(format!("{:?}", SessionStatus::Failed))
                .fetch_all(&self.pool)
                .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>("title")).collect())
    }

    pub async fn delete_repo(&self, id: &RepoId) -> Result<()> {
        sqlx::query("DELETE FROM repos WHERE id = $1")
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn repo_by_slug(&self, slug: &str) -> Result<Option<Repo>> {
        let row = sqlx::query("SELECT * FROM repos WHERE slug = $1")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(repo_from_row))
    }

    /// Record the trunk once something has read the remote.
    ///
    /// A repository connected while nothing could answer has none, and the
    /// first session to clone it finds out.
    pub async fn set_default_branch(&self, id: &RepoId, branch: &str) -> Result<()> {
        sqlx::query("UPDATE repos SET default_branch = $1 WHERE id = $2")
            .bind(branch)
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn repo(&self, id: &RepoId) -> Result<Option<Repo>> {
        let row = sqlx::query("SELECT * FROM repos WHERE id = $1")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(repo_from_row))
    }

    pub async fn repos(&self) -> Result<Vec<Repo>> {
        Ok(sqlx::query("SELECT * FROM repos ORDER BY slug")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(repo_from_row)
            .collect())
    }

    // ── sessions ───────────────────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_session(
        &self,
        id: &SessionId,
        host_id: &HostId,
        owner: &str,
        repo: Option<&str>,
        title: &str,
        prompt: &str,
        branch: Option<&str>,
        base: Option<&str>,
        agent: &str,
        size: WorkspaceSize,
        steps: &[ft_core::Step],
    ) -> Result<()> {
        let now = chrono::Utc::now();
        sqlx::query(
            "INSERT INTO sessions
               (id, user_id, host_id, repo, title, prompt, branch, base, agent, size, status,
                steps, created_at, updated_at, number, name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Starting', $11, $12, $13,
                     nextval('session_number_seq'),
                     'Agent ' || currval('session_number_seq'))",
        )
        .bind(id.as_str())
        // Whoever started it. Everything about who may see it, whose token
        // pushes it and whose name is on its commits is read from here.
        .bind(owner)
        .bind(host_id.as_str())
        .bind(repo)
        .bind(title)
        .bind(prompt)
        .bind(branch)
        .bind(base)
        .bind(agent)
        .bind(serde_json::to_string(&size)?.trim_matches('"').to_string())
        .bind(serde_json::to_value(steps)?)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn sessions(&self, owner: &str) -> Result<Vec<Session>> {
        self.sessions_page(owner, None, None).await
    }

    /// Newest first, optionally a page at a time.
    ///
    /// Ordered and paged by id rather than by a timestamp. A cursor needs a key
    /// that never moves, and `updated_at` changes under you — which makes a
    /// page skip rows or repeat them.
    ///
    /// Ids sort close enough to creation order to read as "newest first"; two
    /// made in the same millisecond may swap, which nobody can tell apart.
    pub async fn sessions_page(
        &self,
        owner: &str,
        limit: Option<u32>,
        before: Option<&str>,
    ) -> Result<Vec<Session>> {
        let rows = sqlx::query(
            "SELECT * FROM sessions
             WHERE user_id = $3
               AND ($1::text IS NULL OR id < $1)
             ORDER BY id DESC
             LIMIT $2",
        )
        .bind(before)
        // NULL is how Postgres spells "no limit".
        .bind(limit.map(i64::from))
        .bind(owner)
        .fetch_all(&self.pool)
        .await?;

        self.with_checkouts(rows).await
    }

    /// Every session of this person's that hasn't ended, for stopping them all
    /// at once. Never anybody else's — "end all" ends yours.
    pub async fn live_sessions(&self, owner: &str) -> Result<Vec<Session>> {
        let rows = sqlx::query(
            "SELECT * FROM sessions WHERE user_id = $2 AND status != $1 ORDER BY id DESC",
        )
        .bind(format!("{:?}", SessionStatus::Ended))
        .bind(owner)
        .fetch_all(&self.pool)
        .await?;

        self.with_checkouts(rows).await
    }

    /// One session, if it is this person's.
    ///
    /// Absent rather than refused when it is somebody else's: a 403 and a 404
    /// differ only in confirming that the session exists, which is itself
    /// something the asker was not meant to learn.
    pub async fn session_of(&self, owner: &str, id: &SessionId) -> Result<Option<Session>> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = $1 AND user_id = $2")
            .bind(id.as_str())
            .bind(owner)
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        Ok(self.with_checkouts(vec![row]).await?.pop())
    }

    /// One session, whoever it belongs to.
    ///
    /// For the parts of the control plane that act on their own — a worker
    /// reconnecting, a clean-up sweep — where there is no request and so
    /// nobody to check against. Never reachable from an API handler: those use
    /// [`Db::session_of`].
    pub async fn session(&self, id: &SessionId) -> Result<Option<Session>> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = $1")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        let Some(row) = row else { return Ok(None) };
        Ok(self.with_checkouts(vec![row]).await?.pop())
    }

    /// Fill in what each of these sessions has checked out.
    ///
    /// One query for the lot rather than one per session: the dashboard asks
    /// for every session there is, and a list that costs a round trip per row
    /// is a list that gets slower the more you use Firetower.
    async fn with_checkouts(&self, rows: Vec<sqlx::postgres::PgRow>) -> Result<Vec<Session>> {
        let mut sessions: Vec<Session> = rows
            .into_iter()
            .map(session_from_row)
            .collect::<Result<_>>()?;

        let ids: Vec<String> = sessions.iter().map(|s| s.id.as_str().to_string()).collect();
        if ids.is_empty() {
            return Ok(sessions);
        }

        let rows = sqlx::query(
            "SELECT session_id, repo_id, slug, base, branch, path, trouble, pull_request
               FROM session_repos
              WHERE session_id = ANY($1)
              ORDER BY session_id, position",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await?;

        let mut by_session: std::collections::HashMap<String, Vec<Checkout>> =
            std::collections::HashMap::new();
        for r in rows {
            by_session
                .entry(r.get::<String, _>("session_id"))
                .or_default()
                .push(Checkout {
                    repo_id: r
                        .get::<Option<String>, _>("repo_id")
                        .map(RepoId::from_stored),
                    slug: r.get("slug"),
                    base: r.get("base"),
                    branch: r.get("branch"),
                    path: r.get("path"),
                    trouble: r.get("trouble"),
                    pull_request: r.get("pull_request"),
                });
        }

        for session in &mut sessions {
            session.checkouts = by_session.remove(session.id.as_str()).unwrap_or_default();
        }
        Ok(sessions)
    }

    /// Write down what a session is checking out, replacing whatever was there.
    pub async fn record_checkouts(&self, id: &SessionId, checkouts: &[Checkout]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM session_repos WHERE session_id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await?;

        for (position, c) in checkouts.iter().enumerate() {
            sqlx::query(
                "INSERT INTO session_repos
                   (session_id, position, repo_id, slug, base, branch, path, trouble, pull_request)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            )
            .bind(id.as_str())
            .bind(position as i32)
            .bind(c.repo_id.as_ref().map(|r| r.as_str()))
            .bind(&c.slug)
            .bind(&c.base)
            .bind(&c.branch)
            .bind(&c.path)
            .bind(c.trouble.as_deref())
            .bind(c.pull_request.as_deref())
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    /// Add one to a session that is already running.
    pub async fn add_checkout(&self, id: &SessionId, c: &Checkout) -> Result<()> {
        // `position` is an INT4, so `MAX(position) + 1` is one too. Reading it
        // as an i64 made sqlx refuse the row, which is what adding a repository
        // to a running session did instead of working.
        let next: i32 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM session_repos WHERE session_id = $1",
        )
        .bind(id.as_str())
        .fetch_one(&self.pool)
        .await?;

        sqlx::query(
            "INSERT INTO session_repos
               (session_id, position, repo_id, slug, base, branch, path, trouble, pull_request)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(id.as_str())
        .bind(next)
        .bind(c.repo_id.as_ref().map(|r| r.as_str()))
        .bind(&c.slug)
        .bind(&c.base)
        .bind(&c.branch)
        .bind(&c.path)
        .bind(c.trouble.as_deref())
        .bind(c.pull_request.as_deref())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remember where one checkout's pull request went.
    pub async fn set_checkout_pull_request(
        &self,
        id: &SessionId,
        path: &str,
        url: &str,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE session_repos SET pull_request = $1 WHERE session_id = $2 AND path = $3",
        )
        .bind(url)
        .bind(id.as_str())
        .bind(path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // ── events ─────────────────────────────────────────────────────────

    /// Record an event from a worker and advance that worker's cursor.
    ///
    /// Replays are expected — a worker resends anything we might have missed —
    /// so a duplicate is ignored rather than treated as an error.
    pub async fn record_event(
        &self,
        host_id: &HostId,
        seq: i64,
        session_id: &SessionId,
        kind: &EventKind,
        at: chrono::DateTime<chrono::Utc>,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            "INSERT INTO events (host_id, seq, session_id, payload, created_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (host_id, seq) DO NOTHING",
        )
        .bind(host_id.as_str())
        .bind(seq)
        .bind(session_id.as_str())
        .bind(serde_json::to_value(kind)?)
        .bind(at)
        .execute(&mut *tx)
        .await?;

        // The worker may have had to disambiguate the branch name, so the
        // authoritative value arrives with the event rather than being what we
        // asked for.
        if let EventKind::WorktreeAdded { branch, repo, .. } = kind {
            // Which checkout, when the worker says. Git may have numbered the
            // name differently in each repository, so the correction belongs to
            // one row rather than to the session.
            if let Some(slug) = repo {
                sqlx::query(
                    "UPDATE session_repos SET branch = $1
                      WHERE session_id = $2 AND slug = $3",
                )
                .bind(branch)
                .bind(session_id.as_str())
                .bind(slug)
                .execute(&mut *tx)
                .await?;
            }

            // The session's own branch is the first checkout's, and is what a
            // caption shows. Left alone for any other checkout.
            let first = match repo {
                // `position` is an INT4. Reading it as an i64 made sqlx refuse
                // the row at runtime, which failed this whole transaction —
                // so every WorktreeAdded from a session that names its
                // repository was rolled back and lost, and the branch the
                // worker actually created never reached the database.
                Some(slug) => sqlx::query_scalar::<_, i32>(
                    "SELECT position FROM session_repos WHERE session_id = $1 AND slug = $2",
                )
                .bind(session_id.as_str())
                .bind(slug)
                .fetch_optional(&mut *tx)
                .await?
                .is_some_and(|position| position == 0),
                None => true,
            };

            if first {
                sqlx::query("UPDATE sessions SET branch = $1, updated_at = $2 WHERE id = $3")
                    .bind(branch)
                    .bind(at)
                    .bind(session_id.as_str())
                    .execute(&mut *tx)
                    .await?;
            }
        }

        if let EventKind::StatusChanged { status, note } = kind {
            // The note is replaced every time, including with nothing. A
            // question that has been answered should not still be on the card
            // after the agent went back to work.
            // Not for a session you removed while its host was away. The
            // worker knows nothing about that and will happily report it as
            // working; applying that here would put a ghost back on the inbox.
            sqlx::query(
                "UPDATE sessions SET status = $1, note = $2, updated_at = $3
                  WHERE id = $4 AND forgotten_at IS NULL",
            )
            .bind(serde_json::to_string(status)?.trim_matches('"'))
            .bind(note.as_deref())
            .bind(at)
            .bind(session_id.as_str())
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query("UPDATE hosts SET last_seq = $1 WHERE id = $2 AND last_seq < $3")
            .bind(seq)
            .bind(host_id.as_str())
            .bind(seq)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    /// Keep one line a structured agent printed.
    ///
    /// Idempotent because a worker replays from a cursor after a reconnect, so
    /// the same line arriving twice is ordinary. Its own numbering is the key,
    /// not an identity of ours: both ends have to agree on what has been seen.
    pub async fn record_agent_line(
        &self,
        session_id: &SessionId,
        line_no: i64,
        line: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO agent_lines (session_id, line_no, line)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_id, line_no) DO NOTHING",
        )
        .bind(session_id.as_str())
        .bind(line_no)
        .bind(line)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remember where a session's pull request is.
    ///
    /// Written once it exists, so a screen can tell "pushed" from "already
    /// open" without asking GitHub every time somebody looks.
    pub async fn record_pull_request(&self, session_id: &SessionId, url: &str) -> Result<()> {
        sqlx::query("UPDATE sessions SET pull_request = $1, updated_at = now() WHERE id = $2")
            .bind(url)
            .bind(session_id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Keep what the agent proposed calling its work.
    ///
    /// Replaced whenever a newer one arrives: a session that carried on working
    /// has a newer answer, and the older one describes a diff that no longer
    /// exists.
    pub async fn record_proposal(
        &self,
        session_id: &SessionId,
        title: &str,
        body: &str,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET proposed_title = $1, proposed_body = $2, updated_at = now()
              WHERE id = $3",
        )
        .bind(title)
        .bind(body)
        .bind(session_id.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// What this session is currently reported as doing.
    ///
    /// Read before writing, so a notification can be sent on the *change* into
    /// needing somebody rather than every time we are reminded that it does.
    /// Without it, a reconnect re-announces every waiting session and somebody
    /// with four of them gets four notifications for things they already knew.
    pub async fn session_status(&self, session_id: &SessionId) -> Result<Option<SessionStatus>> {
        let stored: Option<String> =
            sqlx::query_scalar("SELECT status FROM sessions WHERE id = $1")
                .bind(session_id.as_str())
                .fetch_optional(&self.pool)
                .await?;
        Ok(stored.and_then(|s| serde_json::from_str(&format!("\"{s}\"")).ok()))
    }

    /// Say where a session has got to, from what its agent said.
    ///
    /// The only writer of this field for an agent that speaks a protocol —
    /// hooks are not installed for those, precisely so that this is not one of
    /// two mechanisms racing to describe the same moment.
    ///
    /// The note is replaced every time, including with nothing: a question that
    /// has been answered should not still be on the card after the agent went
    /// back to work.
    ///
    /// Not for a session somebody removed while its host was away. The worker
    /// knows nothing about that and will happily go on reporting; applying it
    /// here would put a ghost back in the inbox.
    pub async fn set_session_state(
        &self,
        session_id: &SessionId,
        status: SessionStatus,
        note: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET status = $1, note = $2, updated_at = now()
              WHERE id = $3 AND forgotten_at IS NULL AND status <> $4",
        )
        .bind(format!("{status:?}"))
        .bind(note)
        .bind(session_id.as_str())
        // Nothing leaves `Ended`.
        .bind(format!("{:?}", SessionStatus::Ended))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Everything the agent has said, in order, from `since` onward.
    pub async fn agent_lines_since(
        &self,
        session_id: &SessionId,
        since: i64,
    ) -> Result<Vec<(i64, String)>> {
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT line_no, line FROM agent_lines
              WHERE session_id = $1 AND line_no > $2
              ORDER BY line_no",
        )
        .bind(session_id.as_str())
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows)
    }

    /// How far the agent's log has got here.
    ///
    /// Sent to a worker as the resume cursor, so a reconnecting control plane
    /// asks only for what it is missing.
    pub async fn last_agent_line(&self, session_id: &SessionId) -> Result<i64> {
        let last: Option<i64> =
            sqlx::query_scalar("SELECT MAX(line_no) FROM agent_lines WHERE session_id = $1")
                .bind(session_id.as_str())
                .fetch_one(&self.pool)
                .await?;
        Ok(last.unwrap_or(0))
    }

    /// Every event since a cursor, whoever they belong to.
    ///
    /// For the control plane's own use — a worker reconnecting, the tests —
    /// where there is no request and so nobody to narrow to. API callers use
    /// [`Db::events_since_for`], which asks whose.
    pub async fn events_since(&self, since: i64) -> Result<Vec<Event>> {
        let rows = sqlx::query(
            "SELECT id, session_id, payload, created_at FROM events
             WHERE id > $1 ORDER BY id",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(event_from_row).collect()
    }

    /// Replay, optionally narrowed to one session.
    ///
    /// Narrowing in SQL rather than in the caller: a session's page wants tens
    /// of rows and the log holds every event from every host.
    pub async fn events_since_for(
        &self,
        owner: &str,
        since: i64,
        session: Option<&SessionId>,
    ) -> Result<Vec<Event>> {
        // Numbered rather than positional: mixing `?` and `?1` makes SQLite
        // reuse the first binding for both, which silently matches nothing.
        //
        // Joined to `sessions` rather than filtered on the id given: an event
        // stream is how a session narrates itself, and asking for somebody
        // else's id must return nothing rather than their build steps.
        let rows = sqlx::query(
            "SELECT e.id, e.session_id, e.payload, e.created_at
             FROM events e JOIN sessions s ON s.id = e.session_id
             WHERE e.id > $1 AND ($2::text IS NULL OR e.session_id = $2)
               AND s.user_id = $3
             ORDER BY e.id",
        )
        .bind(since)
        .bind(session.map(|s| s.as_str()))
        .bind(owner)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(event_from_row).collect()
    }
}

/// One row of the event log.
fn event_from_row(r: sqlx::postgres::PgRow) -> Result<Event> {
    let payload: serde_json::Value = r.get("payload");
    Ok(Event {
        seq: r.get("id"),
        session_id: SessionId::from_stored(r.get::<String, _>("session_id")),
        kind: serde_json::from_value(payload)?,
        at: r.get("created_at"),
    })
}

/// Drop the schemas left behind by runs that are over.
///
/// On the way *in*, not on the way out, and that is the whole design. Rust has
/// no teardown hook; `Drop` cannot help because `Db` is cloned into half the
/// crate and dropping a schema is an async query a synchronous `Drop` cannot
/// await; and anything that does run at the end is skipped by exactly the
/// panicking test you most want to look at. So each run tidies up after the
/// last one, and however this process dies, the next one cleans up after it.
///
/// Left to itself this leaked 1,117 schemas and half a gigabyte into a database
/// whose real contents are a few dozen rows.
///
/// Once per process. Failures are ignored on purpose: this is housekeeping, and
/// a test that cannot run is a better thing to report than a test that could
/// not tidy up.
#[cfg(test)]
async fn sweep_test_schemas(pool: &PgPool) {
    static SWEPT: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

    SWEPT
        .get_or_init(|| async {
            // An hour. The whole suite takes seconds, so nothing this old can
            // belong to a test that is still running — including one in another
            // process, which is why this is not "anything but mine".
            let stale: Vec<String> = match sqlx::query_scalar(
                "SELECT schema_name::text FROM information_schema.schemata
                  WHERE schema_name LIKE 'test\\_%' ESCAPE '\\'",
            )
            .fetch_all(pool)
            .await
            {
                Ok(found) => found,
                Err(e) => {
                    tracing::debug!("could not list test schemas: {e}");
                    return;
                }
            };

            let cutoff = chrono::Utc::now() - chrono::Duration::hours(1);
            let mut dropped = 0;

            for name in stale {
                // The name carries when it was made: `test_<ulid>`, and a ULID
                // is a timestamp with randomness after it.
                let Some(made) = name
                    .strip_prefix("test_")
                    .and_then(|id| ulid::Ulid::from_string(&id.to_uppercase()).ok())
                    .and_then(|id| {
                        chrono::DateTime::from_timestamp_millis(id.timestamp_ms() as i64)
                    })
                else {
                    continue;
                };

                if made >= cutoff {
                    continue;
                }

                // One statement per schema, each its own transaction. Dropping
                // a thousand of them in one goes through `max_locks_per_transaction`
                // and fails with `out of shared memory`, having done nothing.
                if sqlx::query(&format!("DROP SCHEMA \"{name}\" CASCADE"))
                    .execute(pool)
                    .await
                    .is_ok()
                {
                    dropped += 1;
                }
            }

            if dropped > 0 {
                eprintln!("swept {dropped} test schemas left by earlier runs");
            }
        })
        .await;
}

fn host_from_row(r: sqlx::postgres::PgRow) -> Result<Host> {
    let raw: String = r.get("state");
    Ok(Host {
        id: HostId::from_stored(r.get::<String, _>("id")),
        name: r.get("name"),
        state: serde_json::from_str::<HostState>(&format!("\"{raw}\""))
            .context("decoding host state")?,
        compute: serde_json::from_value(r.get("compute")).context("decoding compute")?,
        drained: r.get("drained"),
        cpus: r.get::<Option<i32>, _>("cpus").map(|v| v as u32),
        memory_mb: r.get::<Option<i64>, _>("memory_mb").map(|v| v as u64),
        worker_version: r.get("worker_version"),
        // A diagnosis that no longer parses is not worth failing the row
        // over; connecting again regenerates it.
        diagnosis: r
            .get::<Option<serde_json::Value>, _>("diagnosis")
            .and_then(|v| serde_json::from_value(v).ok()),
        // Answered by the fleet, which is the only thing that knows.
        reconnecting: false,
    })
}

fn repo_from_row(r: sqlx::postgres::PgRow) -> Repo {
    Repo {
        id: RepoId::from_stored(r.get::<String, _>("id")),
        slug: r.get("slug"),
        remote: r.get("remote"),
        default_branch: r.get("default_branch"),
        setup: r.get("setup"),
        env_file: r.get("env_file"),
        // Filled in by whoever asks the vault; a row knows only the path.
        env: Vec::new(),
    }
}

fn session_from_row(r: sqlx::postgres::PgRow) -> Result<Session> {
    let status: String = r.get("status");
    let agent: String = r.get("agent");
    let size: String = r.get("size");

    Ok(Session {
        number: r.get("number"),
        owner: ft_core::UserId::from_stored(r.get::<String, _>("user_id")),
        // Filled in by `with_checkouts`, which asks for the lot in one query.
        checkouts: Vec::new(),
        // Written when the session is created, so this is only ever absent for
        // a row from before names existed.
        name: r
            .get::<Option<String>, _>("name")
            .unwrap_or_else(|| format!("Agent {}", r.get::<i64, _>("number"))),
        note: r.get("note"),
        id: SessionId::from_stored(r.get::<String, _>("id")),
        repo: r.get("repo"),
        title: r.get("title"),
        prompt: r.get("prompt"),
        branch: r.get("branch"),
        base: r.get("base"),
        agent: serde_json::from_str(&format!("\"{agent}\"")).context("decoding agent")?,
        size: serde_json::from_str(&format!("\"{size}\"")).context("decoding size")?,
        status: serde_json::from_str::<SessionStatus>(&format!("\"{status}\""))
            .context("decoding session status")?,
        forgotten_at: r.get("forgotten_at"),
        pull_request: r.get("pull_request"),
        proposed_title: r.get("proposed_title"),
        proposed_body: r.get("proposed_body"),
        host_id: HostId::from_stored(r.get::<String, _>("host_id")),
        workspace_id: None,
        // Sessions created before steps were recorded have none, which renders
        // as the activity list it always did rather than as an empty checklist.
        steps: serde_json::from_value(r.get("steps")).unwrap_or_default(),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    })
}

/// A connection string without its password, for a message someone will paste.
fn redacted(url: &str) -> String {
    match (url.find("://"), url.find('@')) {
        (Some(scheme), Some(at)) if at > scheme => {
            format!("{}://…@{}", &url[..scheme], &url[at + 1..])
        }
        _ => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A database with somebody in it.
    ///
    /// Every table that matters now has an owner and a foreign key to enforce
    /// it, so a test that inserts a session needs an account for it to belong
    /// to — the same account the first boot creates.
    async fn db_with_user() -> (Db, String) {
        Db::open_for_test_owned().await.unwrap()
    }

    #[tokio::test]
    async fn localhost_is_stored_like_any_other_host() {
        let (db, _owner) = db_with_user().await;
        let local = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let remote = db
            .ensure_host(
                "fire-01",
                Compute::Server {
                    host: "203.0.113.44".into(),
                    user: Some("root".into()),
                    port: Some(2222),
                    key: ft_core::SshKey::File {
                        path: "~/.ssh/fire".into(),
                    },
                    host_key: None,
                    container: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(
            local.compute,
            Compute::Local,
            "there is nothing to connect to locally"
        );
        // Every part of a destination has to survive the trip: one missing
        // field is a host that connects to a different machine, or to none.
        assert_eq!(
            remote.compute,
            Compute::Server {
                host: "203.0.113.44".into(),
                user: Some("root".into()),
                port: Some(2222),
                key: ft_core::SshKey::File {
                    path: "~/.ssh/fire".into()
                },
                host_key: None,
                container: None,
            }
        );
        assert_eq!(db.hosts().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_container_host_round_trips_its_details() {
        // The kind is stored as a tagged value, so the fields that only mean
        // something for one variant have to survive the trip intact.
        let (db, _owner) = db_with_user().await;
        let host = db
            .ensure_host(
                "worker-1",
                Compute::Container {
                    image: "firetower/worker:dev".into(),
                    name: "firetower-worker-1".into(),
                },
            )
            .await
            .unwrap();

        assert_eq!(
            host.compute,
            Compute::Container {
                image: "firetower/worker:dev".into(),
                name: "firetower-worker-1".into(),
            }
        );
    }

    #[tokio::test]
    async fn a_host_with_live_sessions_refuses_to_be_forgotten() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();

        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Still going",
            "do a thing",
            Some("agent/x"),
            Some("main"),
            "Shell",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        assert_eq!(
            db.live_sessions_on(&host.id).await.unwrap(),
            vec!["Still going"],
            "removing this host would orphan running work"
        );
    }

    #[tokio::test]
    async fn draining_is_separate_from_being_unreachable() {
        // A draining host is still online and still finishing what it has;
        // folding the two together would make its sessions look lost.
        let (db, _owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        assert!(!db.is_drained(&host.id).await.unwrap());
        db.set_drained(&host.id, true).await.unwrap();
        assert!(db.is_drained(&host.id).await.unwrap());

        let still = db.hosts().await.unwrap();
        assert_eq!(still[0].state, HostState::Unreachable, "state is untouched");
    }

    #[tokio::test]
    async fn registering_a_host_twice_is_harmless() {
        let (db, _owner) = db_with_user().await;
        let first = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let again = db.ensure_host("localhost", Compute::Local).await.unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(db.hosts().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_host_starts_unreachable_until_it_says_hello() {
        let (db, _owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        assert_eq!(host.state, HostState::Unreachable);

        db.mark_host_online(&host.id, "0.1.0", 8, 16384)
            .await
            .unwrap();
        let online = db.host_by_name("localhost").await.unwrap().unwrap();
        assert_eq!(online.state, HostState::Online);
        assert_eq!(online.cpus, Some(8));
    }

    /// A failure that nobody was watching still has to be readable later.
    #[tokio::test]
    async fn why_a_host_failed_outlives_the_attempt() {
        let (db, _owner) = db_with_user().await;
        let host = db.ensure_host("fire-01", Compute::Local).await.unwrap();
        assert!(host.diagnosis.is_none(), "nothing has failed yet");

        let told = ft_core::Diagnosis::new(
            ft_core::Cause::WorkerMissing,
            "Firetower isn't installed on that machine.",
        )
        .with_detail("bash: firetower: command not found");
        db.record_diagnosis(&host.id, &told).await.unwrap();

        let stored = db.host_by_id(&host.id).await.unwrap().unwrap();
        assert_eq!(stored.state, HostState::Unreachable);
        let found = stored.diagnosis.expect("it said why");
        assert_eq!(found.cause, ft_core::Cause::WorkerMissing);
        assert_eq!(
            found.detail.as_deref(),
            Some("bash: firetower: command not found"),
            "the raw text is what gets pasted into an issue"
        );
    }

    /// And stops saying it once it stops being true.
    #[tokio::test]
    async fn a_host_that_comes_back_stops_explaining_itself() {
        let (db, _owner) = db_with_user().await;
        let host = db.ensure_host("fire-01", Compute::Local).await.unwrap();

        db.record_diagnosis(
            &host.id,
            &ft_core::Diagnosis::new(ft_core::Cause::Unreachable, "Nothing answered."),
        )
        .await
        .unwrap();

        db.mark_host_online(&host.id, "0.1.0", 4, 8192)
            .await
            .unwrap();

        let back = db.host_by_id(&host.id).await.unwrap().unwrap();
        assert_eq!(back.state, HostState::Online);
        assert!(back.diagnosis.is_none(), "it is answering");
    }

    #[tokio::test]
    async fn a_status_event_updates_the_session_projection() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Fix",
            "Fix",
            Some("agent/fix"),
            Some("main"),
            "ClaudeCode",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        assert_eq!(
            db.session(&id).await.unwrap().unwrap().status,
            SessionStatus::Starting
        );

        db.record_event(
            &host.id,
            1,
            &id,
            &EventKind::StatusChanged {
                status: SessionStatus::NeedsYou,
                note: None,
            },
            chrono::Utc::now(),
        )
        .await
        .unwrap();

        assert_eq!(
            db.session(&id).await.unwrap().unwrap().status,
            SessionStatus::NeedsYou
        );
    }

    #[tokio::test]
    async fn the_branch_the_worker_actually_used_wins() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Fix",
            "Fix",
            Some("agent/fix"),
            Some("main"),
            "ClaudeCode",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        // a second session on the same prompt: the worker had to number it
        db.record_event(
            &host.id,
            1,
            &id,
            &EventKind::WorktreeAdded {
                branch: "agent/fix-2".into(),
                repo: None,
                asked_for: None,
            },
            chrono::Utc::now(),
        )
        .await
        .unwrap();

        assert_eq!(
            db.session(&id).await.unwrap().unwrap().branch.as_deref(),
            Some("agent/fix-2")
        );
    }

    #[tokio::test]
    async fn a_replayed_event_is_ignored_rather_than_duplicated() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Fix",
            "Fix",
            Some("agent/fix"),
            Some("main"),
            "ClaudeCode",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        let kind = EventKind::WorktreeAdded {
            branch: "agent/fix".into(),
            repo: None,
            asked_for: None,
        };
        let now = chrono::Utc::now();

        // a worker replays everything it isn't sure we saw
        db.record_event(&host.id, 7, &id, &kind, now).await.unwrap();
        db.record_event(&host.id, 7, &id, &kind, now).await.unwrap();

        assert_eq!(db.events_since(0).await.unwrap().len(), 1);
    }

    /// Adding a repository to a running session never worked: `position` is
    /// an INT4 and the next one was read as an i64, so sqlx refused the row and
    /// the interface showed the type error rather than a checkout.
    #[tokio::test]
    async fn a_repository_can_be_added_to_a_running_session() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();

        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Fix",
            "fix",
            Some("agent/hello"),
            Some("main"),
            "ClaudeCode",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        let checkout = |slug: &str, path: &str| Checkout {
            repo_id: None,
            slug: slug.into(),
            base: "main".into(),
            branch: "agent/hello".into(),
            path: path.into(),
            trouble: None,
            pull_request: None,
        };

        db.record_checkouts(&id, &[checkout("acme/backend", "backend")])
            .await
            .unwrap();

        db.add_checkout(&id, &checkout("acme/web", "web"))
            .await
            .expect("adding a second repository must work");

        let held = db.session(&id).await.unwrap().unwrap().checkouts;
        assert_eq!(held.len(), 2);
        assert_eq!(held[1].slug, "acme/web", "and it goes after the first");

        // And a third, so the position really is being counted rather than
        // landing on a primary key that happens to be free.
        db.add_checkout(&id, &checkout("acme/docs", "docs"))
            .await
            .unwrap();
        assert_eq!(db.session(&id).await.unwrap().unwrap().checkouts.len(), 3);
    }

    /// The regression that hid for a day: every event covered by a test used
    /// `repo: None`, which skips the query that was reading an INT4 as an i64.
    /// A session that names its repository took the other branch, the
    /// transaction failed, and the event was silently rolled back — so the
    /// branch git actually created never reached the database.
    #[tokio::test]
    async fn a_worktree_event_that_names_its_repository_is_recorded() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();

        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Fix",
            "fix",
            Some("agent/hello"),
            Some("main"),
            "ClaudeCode",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        db.record_checkouts(
            &id,
            &[Checkout {
                repo_id: None,
                slug: "acme/backend".into(),
                base: "main".into(),
                branch: "agent/hello".into(),
                path: "backend".into(),
                trouble: None,
                pull_request: None,
            }],
        )
        .await
        .unwrap();

        // Git had to number it, because another session held the clean name.
        db.record_event(
            &host.id,
            1,
            &id,
            &EventKind::WorktreeAdded {
                branch: "agent/hello-2".into(),
                repo: Some("acme/backend".into()),
                asked_for: Some("agent/hello".into()),
            },
            chrono::Utc::now(),
        )
        .await
        .expect("recording must not fail");

        assert_eq!(
            db.events_since(0).await.unwrap().len(),
            1,
            "the event was dropped"
        );

        // And the correction reached both places that show a branch.
        let session = db.session(&id).await.unwrap().unwrap();
        assert_eq!(session.branch.as_deref(), Some("agent/hello-2"));
        assert_eq!(
            session.checkouts.first().map(|c| c.branch.as_str()),
            Some("agent/hello-2"),
        );
    }

    #[tokio::test]
    async fn a_session_can_have_no_repository_at_all() {
        // A bare agent: somewhere to work, nothing checked out. The columns
        // that describe a checkout are absent rather than empty strings.
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();

        db.insert_session(
            &id,
            &host.id,
            &owner,
            None,
            "Poke around",
            "have a look",
            None,
            None,
            "Shell",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();

        let session = db.session(&id).await.unwrap().unwrap();
        assert_eq!(session.repo, None);
        assert_eq!(session.branch, None);
        assert_eq!(session.base, None);
    }

    #[tokio::test]
    async fn paging_walks_backwards_without_skipping_or_repeating() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        for n in 0..5 {
            let id = SessionId::new();
            db.insert_session(
                &id,
                &host.id,
                &owner,
                Some("acme/backend"),
                &format!("Session {n}"),
                "do a thing",
                Some("agent/x"),
                Some("main"),
                "Shell",
                WorkspaceSize::Medium,
                &ft_core::Step::plan(true, false),
            )
            .await
            .unwrap();
        }

        let first = db.sessions_page(&owner, Some(2), None).await.unwrap();
        assert_eq!(first.len(), 2);

        let cursor = first.last().unwrap().id.to_string();
        let second = db
            .sessions_page(&owner, Some(2), Some(&cursor))
            .await
            .unwrap();
        assert_eq!(second.len(), 2);

        let paged: Vec<String> = first
            .iter()
            .chain(second.iter())
            .map(|s| s.id.to_string())
            .collect();

        // The invariant that matters: walking the pages gives exactly what
        // reading the whole list gives, in the same order. Nothing skipped,
        // nothing seen twice.
        let whole: Vec<String> = db
            .sessions_page(&owner, None, None)
            .await
            .unwrap()
            .iter()
            .map(|s| s.id.to_string())
            .collect();

        assert_eq!(paged, whole[..4], "pages should agree with the full list");
        assert_eq!(
            paged.iter().collect::<std::collections::HashSet<_>>().len(),
            4,
            "a page must not repeat what the previous one returned"
        );
    }

    #[tokio::test]
    async fn replay_can_be_narrowed_to_one_session() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        // Real sessions, because the log is now read through them: an event
        // belongs to whoever owns the session it is about, and that is how
        // narrowing knows whose it is.
        let mine = SessionId::new();
        let theirs = SessionId::new();
        for id in [&mine, &theirs] {
            db.insert_session(
                id,
                &host.id,
                &owner,
                None,
                "A session",
                "do a thing",
                None,
                None,
                "ClaudeCode",
                WorkspaceSize::Medium,
                &[],
            )
            .await
            .unwrap();
        }

        for (n, id) in [(1, &mine), (2, &theirs), (3, &mine)] {
            db.record_event(
                &host.id,
                n,
                id,
                &EventKind::StatusChanged {
                    status: SessionStatus::Working,
                    note: None,
                },
                chrono::Utc::now(),
            )
            .await
            .unwrap();
        }

        assert_eq!(db.events_since(0).await.unwrap().len(), 3);
        assert_eq!(
            db.events_since_for(&owner, 0, Some(&mine))
                .await
                .unwrap()
                .len(),
            2,
            "narrowing should return only that session's events"
        );
    }

    #[tokio::test]
    async fn the_resume_cursor_only_moves_forward() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("r"),
            "t",
            "p",
            Some("b"),
            Some("main"),
            "Shell",
            WorkspaceSize::Medium,
            &ft_core::Step::plan(true, false),
        )
        .await
        .unwrap();
        let kind = EventKind::RepoFetched { detail: "x".into() };

        db.record_event(&host.id, 5, &id, &kind, chrono::Utc::now())
            .await
            .unwrap();
        assert_eq!(db.last_seq(&host.id).await.unwrap(), 5);

        // an out-of-order replay must not rewind us
        db.record_event(&host.id, 2, &id, &kind, chrono::Utc::now())
            .await
            .unwrap();
        assert_eq!(db.last_seq(&host.id).await.unwrap(), 5);
    }

    #[tokio::test]
    async fn repositories_are_deduplicated_by_slug() {
        let (db, _owner) = db_with_user().await;
        let a = db
            .ensure_repo(
                "acme/backend",
                "git@x:acme/backend",
                Some("main"),
                None,
                None,
            )
            .await
            .unwrap();
        let b = db
            .ensure_repo(
                "acme/backend",
                "git@x:acme/backend",
                Some("main"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(db.repos().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn configuring_an_agent_twice_updates_rather_than_duplicates() {
        let (db, owner) = db_with_user().await;
        db.set_agent_mode(&owner, Agent::ClaudeCode, AgentMode::Subscription, true)
            .await
            .unwrap();
        db.set_agent_mode(&owner, Agent::ClaudeCode, AgentMode::ApiKey, true)
            .await
            .unwrap();

        let modes = db.agent_modes(&owner).await.unwrap();
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].1, AgentMode::ApiKey);
    }

    #[tokio::test]
    async fn an_unconfigured_agent_is_absent_not_defaulted() {
        let (db, owner) = db_with_user().await;
        assert!(db.agent_modes(&owner).await.unwrap().is_empty());

        db.set_agent_mode(&owner, Agent::Codex, AgentMode::ApiKey, true)
            .await
            .unwrap();
        db.forget_agent(&owner, Agent::Codex).await.unwrap();
        assert!(db.agent_modes(&owner).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn presence_is_remembered_per_host_and_refreshed_in_place() {
        let (db, _owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        db.record_presence(
            &host.id,
            &[AgentPresence {
                kind: Agent::ClaudeCode,
                installed: false,
                version: None,
                logged_in: None,
                account: None,
            }],
        )
        .await
        .unwrap();

        db.record_presence(
            &host.id,
            &[AgentPresence {
                kind: Agent::ClaudeCode,
                installed: true,
                version: Some("2.1.44".into()),
                logged_in: Some(true),
                account: Some("someone@example.com · max".into()),
            }],
        )
        .await
        .unwrap();

        let seen = db.presence().await.unwrap();
        assert_eq!(seen.len(), 1, "the second probe replaces the first");
        assert!(seen[0].found.installed);
        assert_eq!(seen[0].found.version.as_deref(), Some("2.1.44"));
        assert_eq!(seen[0].found.logged_in, Some(true));
    }

    #[tokio::test]
    async fn a_host_can_be_renamed_and_keeps_everything_else() {
        let (db, _owner) = db_with_user().await;
        let host = db
            .ensure_host(
                "34.122.172.74",
                Compute::Server {
                    host: "34.122.172.74".into(),
                    user: Some("kevin".into()),
                    port: None,
                    key: ft_core::SshKey::Default,
                    host_key: None,
                    container: Some("firetower-worker".into()),
                },
            )
            .await
            .unwrap();

        db.rename_host(&host.id, "fire-02").await.unwrap();

        let after = db.host_by_id(&host.id).await.unwrap().unwrap();
        assert_eq!(after.name, "fire-02");
        assert_eq!(after.id, host.id, "renaming is not replacing");
        assert_eq!(
            after.compute, host.compute,
            "the name is what changed, not where it is"
        );
    }

    /// A session removed while its host was away stays removed.
    ///
    /// The machine knows nothing about it. When it comes back it reports that
    /// session as working, because it is — and applying that would put a ghost
    /// back on the inbox that nobody can get rid of a second time.
    #[tokio::test]
    async fn a_forgotten_session_is_not_resurrected_by_its_host() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("fire-01", Compute::Local).await.unwrap();

        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            Some("acme/backend"),
            "Fix the flaky test",
            "fix the flaky test",
            None,
            Some("main"),
            "ClaudeCode",
            WorkspaceSize::Medium,
            &[],
        )
        .await
        .unwrap();

        db.forget_session(&id).await.unwrap();

        let gone = db.session(&id).await.unwrap().unwrap();
        assert_eq!(gone.status, ft_core::SessionStatus::Ended);
        assert!(
            gone.forgotten_at.is_some(),
            "removed here, not by the worker"
        );

        // The machine comes back and says what it has always said.
        db.record_event(
            &host.id,
            1,
            &id,
            &EventKind::StatusChanged {
                status: ft_core::SessionStatus::NeedsYou,
                note: Some("What would you like to work on next?".into()),
            },
            chrono::Utc::now(),
        )
        .await
        .unwrap();

        let still = db.session(&id).await.unwrap().unwrap();
        assert_eq!(
            still.status,
            ft_core::SessionStatus::Ended,
            "a removed session does not come back"
        );
        assert_eq!(still.note, None, "and brings no question with it");
    }

    /// Removing it here leaves a teardown owed on the machine.
    #[tokio::test]
    async fn a_forgotten_session_is_owed_a_teardown_until_it_is_told() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("fire-01", Compute::Local).await.unwrap();

        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &owner,
            None,
            "Ask me anything",
            "ask me anything",
            None,
            None,
            "ClaudeCode",
            WorkspaceSize::Medium,
            &[],
        )
        .await
        .unwrap();

        assert!(
            db.owed_cleanup_on(&host.id).await.unwrap().is_empty(),
            "a session nobody removed is nobody's debt"
        );

        db.forget_session(&id).await.unwrap();
        assert_eq!(
            db.owed_cleanup_on(&host.id).await.unwrap(),
            vec![id.clone()]
        );

        db.mark_cleaned(&id).await.unwrap();
        assert!(
            db.owed_cleanup_on(&host.id).await.unwrap().is_empty(),
            "asking twice would kill a session started since"
        );
    }

    /// Numbers are handed out once and never handed out again.
    ///
    /// Reuse would mean a number written down last week coming back pointing at
    /// somebody else's session, and the inbox is a place people come back to.
    #[tokio::test]
    async fn every_session_gets_its_own_number_and_a_name_from_it() {
        let (db, owner) = db_with_user().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        let mut made = Vec::new();
        for expected in 1..=3 {
            let id = SessionId::new();
            db.insert_session(
                &id,
                &host.id,
                &owner,
                Some("acme/backend"),
                "Ask me question about",
                "ask me a question about this repo",
                None,
                Some("main"),
                "ClaudeCode",
                WorkspaceSize::Medium,
                &[],
            )
            .await
            .unwrap();

            let session = db.session(&id).await.unwrap().unwrap();
            assert_eq!(
                session.number, expected,
                "numbering starts at 1 and counts up, on a fresh install too"
            );
            assert_eq!(
                session.name,
                format!("Agent {}", session.number),
                "a session is called after the number it was given"
            );
            made.push((id, session.number));
        }

        let mut numbers: Vec<i64> = made.iter().map(|(_, n)| *n).collect();
        numbers.sort_unstable();
        numbers.dedup();
        assert_eq!(numbers.len(), 3, "no two sessions share a number");

        // Renaming leaves the number alone: it is what a renamed session can
        // still be traced back to.
        let (id, number) = &made[0];
        db.rename_session(id, "the flaky test").await.unwrap();

        let after = db.session(id).await.unwrap().unwrap();
        assert_eq!(after.name, "the flaky test");
        assert_eq!(after.number, *number, "the handle does not move");
    }

    /// The failure that stopped a control plane from booting: a host row
    /// written by a build that knew a kind of compute this one does not.
    /// A second account, for the tests that have to prove one person cannot
    /// see another's work.
    async fn second_user(db: &Db) -> String {
        let accounts = crate::accounts::Accounts::new(db.pool().clone());
        let org = db.org().await.unwrap();
        let id = ft_core::UserId::new();
        sqlx::query(
            "INSERT INTO users (id, org_id, username, password_hash, role)
             VALUES ($1, $2, 'somebody-else', 'x', 'admin')",
        )
        .bind(id.as_str())
        .bind(&org)
        .execute(db.pool())
        .await
        .unwrap();
        let _ = accounts;
        id.as_str().to_string()
    }

    /// Clearing a typed identity brings the host's answer back.
    #[tokio::test]
    async fn clearing_a_typed_identity_lets_the_host_answer_again() {
        let (db, mine) = db_with_user().await;

        db.remember_git_identity(
            &mine,
            "github",
            &ft_proto::Author {
                name: "Typed".into(),
                email: "typed@example.com".into(),
            },
            "set",
        )
        .await
        .unwrap();
        assert_eq!(
            db.git_identity_source(&mine, "github")
                .await
                .unwrap()
                .as_deref(),
            Some("set")
        );

        db.forget_git_identity(&mine, "github").await.unwrap();
        assert_eq!(db.git_identity(&mine, "github").await.unwrap(), None);

        // And the host's answer takes hold again, rather than being refused
        // because a typed one once existed.
        let derived = ft_proto::Author {
            name: "kevinpiac".into(),
            email: "1+kevinpiac@users.noreply.github.com".into(),
        };
        db.remember_git_identity(&mine, "github", &derived, "host")
            .await
            .unwrap();
        assert_eq!(
            db.git_identity(&mine, "github").await.unwrap(),
            Some(derived)
        );
    }

    /// A session belongs to whoever started it, and to nobody else.
    ///
    /// Absent rather than refused: a 403 would confirm that the id names
    /// something, which is the one thing the asker had no way to know.
    #[tokio::test]
    async fn one_persons_session_is_not_another_persons() {
        let (db, mine) = db_with_user().await;
        let theirs = second_user(&db).await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &mine,
            None,
            "Mine",
            "do a thing",
            None,
            None,
            "ClaudeCode",
            WorkspaceSize::Medium,
            &[],
        )
        .await
        .unwrap();

        assert!(db.session_of(&mine, &id).await.unwrap().is_some());
        assert!(
            db.session_of(&theirs, &id).await.unwrap().is_none(),
            "somebody else's session must not be readable"
        );
    }

    /// The lists, too. A leak here is quieter than a fetch: nobody asked for
    /// the row, it simply appeared.
    #[tokio::test]
    async fn the_session_list_holds_only_your_own() {
        let (db, mine) = db_with_user().await;
        let theirs = second_user(&db).await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        for owner in [&mine, &theirs] {
            db.insert_session(
                &SessionId::new(),
                &host.id,
                owner,
                None,
                "A session",
                "do a thing",
                None,
                None,
                "ClaudeCode",
                WorkspaceSize::Medium,
                &[],
            )
            .await
            .unwrap();
        }

        assert_eq!(db.sessions(&mine).await.unwrap().len(), 1);
        assert_eq!(db.sessions(&theirs).await.unwrap().len(), 1);
        assert_eq!(db.live_sessions(&mine).await.unwrap().len(), 1);
    }

    /// What a session narrated is as much its owner's as the session is.
    #[tokio::test]
    async fn the_event_log_is_narrowed_to_its_owner() {
        let (db, mine) = db_with_user().await;
        let theirs = second_user(&db).await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            &mine,
            None,
            "Mine",
            "do a thing",
            None,
            None,
            "ClaudeCode",
            WorkspaceSize::Medium,
            &[],
        )
        .await
        .unwrap();

        db.record_event(
            &host.id,
            1,
            &id,
            &EventKind::StatusChanged {
                status: SessionStatus::Working,
                note: None,
            },
            chrono::Utc::now(),
        )
        .await
        .unwrap();

        assert_eq!(db.events_since_for(&mine, 0, None).await.unwrap().len(), 1);
        assert_eq!(
            db.events_since_for(&theirs, 0, None).await.unwrap().len(),
            0,
            "somebody else's build steps are not yours to replay"
        );
        assert_eq!(
            db.events_since_for(&theirs, 0, Some(&id))
                .await
                .unwrap()
                .len(),
            0,
            "naming the session directly must not get round it either"
        );
    }

    /// A git identity is one person's answer for one host.
    #[tokio::test]
    async fn a_git_identity_belongs_to_one_person() {
        let (db, mine) = db_with_user().await;
        let theirs = second_user(&db).await;

        let me = ft_proto::Author {
            name: "Kevin".into(),
            email: "kevin@example.com".into(),
        };
        db.remember_git_identity(&mine, "github", &me, "host")
            .await
            .unwrap();

        assert_eq!(db.git_identity(&mine, "github").await.unwrap(), Some(me));
        assert_eq!(db.git_identity(&theirs, "github").await.unwrap(), None);
    }

    /// One somebody typed is never replaced by one read from the host: the
    /// whole reason to type one is that the derived answer was wrong.
    #[tokio::test]
    async fn a_typed_identity_survives_the_host_disagreeing() {
        let (db, mine) = db_with_user().await;

        let typed = ft_proto::Author {
            name: "Kevin Piacentini".into(),
            email: "kevin@work.example".into(),
        };
        db.remember_git_identity(&mine, "github", &typed, "set")
            .await
            .unwrap();

        db.remember_git_identity(
            &mine,
            "github",
            &ft_proto::Author {
                name: "kevinpiac".into(),
                email: "1+kevinpiac@users.noreply.github.com".into(),
            },
            "host",
        )
        .await
        .unwrap();

        assert_eq!(db.git_identity(&mine, "github").await.unwrap(), Some(typed));
    }

    #[tokio::test]
    async fn a_host_this_build_cannot_read_is_skipped_rather_than_fatal() {
        let (db, _owner) = db_with_user().await;
        let keep = db.ensure_host("localhost", Compute::Local).await.unwrap();

        // What a newer version would have left behind.
        sqlx::query(
            "INSERT INTO hosts (id, org_id, name, compute, state, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind("h_fromthefuture")
        .bind(db.org().await.unwrap())
        .bind("mystery")
        .bind(serde_json::json!({ "type": "SomethingElse", "port": 9 }))
        .bind("Unreachable")
        .bind(chrono::Utc::now())
        .execute(db.pool())
        .await
        .unwrap();

        let hosts = db
            .hosts()
            .await
            .expect("one unreadable row must not fail the query");

        assert_eq!(hosts.len(), 1, "the readable host is still there");
        assert_eq!(hosts[0].id, keep.id);
    }
}
