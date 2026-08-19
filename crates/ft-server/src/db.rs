//! The control plane's cache.
//!
//! Nothing here is authoritative. Hosts, repositories and credentials are ours;
//! sessions and events are a projection of what workers reported, rebuildable by
//! reconnecting and replaying from sequence zero.

use anyhow::{Context, Result};
use ft_core::{
    Agent, AgentMode, AgentPresence, Compute, Event, EventKind, Host, HostId, HostState, Repo,
    RepoId, Session, SessionId, SessionStatus, WorkspaceSize,
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

    /// Register a host, or leave the existing one alone.
    ///
    /// `localhost` goes through this like any other host, because it *is* one.
    pub async fn ensure_host(&self, name: &str, compute: Compute) -> Result<Host> {
        if let Some(existing) = self.host_by_name(name).await? {
            return Ok(existing);
        }
        let id = HostId::new();
        sqlx::query(
            "INSERT INTO hosts (id, name, compute, state, created_at)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(id.as_str())
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
    ) -> Result<Repo> {
        if let Some(existing) = self.repo_by_remote(remote).await? {
            return Ok(existing);
        }
        sqlx::query(
            "INSERT INTO repos (id, slug, remote, default_branch, setup, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(RepoId::new().as_str())
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
    pub async fn agent_modes(&self) -> Result<Vec<(Agent, AgentMode, bool)>> {
        let rows = sqlx::query("SELECT kind, mode, enabled FROM agents")
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

    /// Configure an agent. The value it authenticates with is the vault's.
    pub async fn set_agent_mode(&self, kind: Agent, mode: AgentMode, enabled: bool) -> Result<()> {
        sqlx::query(
            "INSERT INTO agents (kind, mode, enabled, updated_at) VALUES ($1, $2, $3, $4)
             ON CONFLICT(kind) DO UPDATE SET mode = excluded.mode,
                                             enabled = excluded.enabled,
                                             updated_at = excluded.updated_at",
        )
        .bind(format!("{kind:?}"))
        .bind(format!("{mode:?}"))
        .bind(enabled)
        .bind(chrono::Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Back to unconfigured. The stored value is the caller's to forget.
    pub async fn forget_agent(&self, kind: Agent) -> Result<()> {
        sqlx::query("DELETE FROM agents WHERE kind = $1")
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
               (id, host_id, repo, title, prompt, branch, base, agent, size, status,
                steps, created_at, updated_at, number, name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Starting', $10, $11, $12,
                     nextval('session_number_seq'),
                     'Agent ' || currval('session_number_seq'))",
        )
        .bind(id.as_str())
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

    pub async fn sessions(&self) -> Result<Vec<Session>> {
        self.sessions_page(None, None).await
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
        limit: Option<u32>,
        before: Option<&str>,
    ) -> Result<Vec<Session>> {
        let rows = sqlx::query(
            "SELECT * FROM sessions
             WHERE ($1::text IS NULL OR id < $1)
             ORDER BY id DESC
             LIMIT $2",
        )
        .bind(before)
        // NULL is how Postgres spells "no limit".
        .bind(limit.map(i64::from))
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter().map(session_from_row).collect()
    }

    /// Every session that hasn't ended, for stopping them all at once.
    pub async fn live_sessions(&self) -> Result<Vec<Session>> {
        let rows = sqlx::query("SELECT * FROM sessions WHERE status != $1 ORDER BY id DESC")
            .bind(format!("{:?}", SessionStatus::Ended))
            .fetch_all(&self.pool)
            .await?;

        rows.into_iter().map(session_from_row).collect()
    }

    pub async fn session(&self, id: &SessionId) -> Result<Option<Session>> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = $1")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        row.map(session_from_row).transpose()
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
        if let EventKind::WorktreeAdded { branch } = kind {
            sqlx::query("UPDATE sessions SET branch = $1, updated_at = $2 WHERE id = $3")
                .bind(branch)
                .bind(at)
                .bind(session_id.as_str())
                .execute(&mut *tx)
                .await?;
        }

        if let EventKind::StatusChanged { status, note } = kind {
            // The note is replaced every time, including with nothing. A
            // question that has been answered should not still be on the card
            // after the agent went back to work.
            sqlx::query(
                "UPDATE sessions SET status = $1, note = $2, updated_at = $3 WHERE id = $4",
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

    pub async fn events_since(&self, since: i64) -> Result<Vec<Event>> {
        self.events_since_for(since, None).await
    }

    /// Replay, optionally narrowed to one session.
    ///
    /// Narrowing in SQL rather than in the caller: a session's page wants tens
    /// of rows and the log holds every event from every host.
    pub async fn events_since_for(
        &self,
        since: i64,
        session: Option<&SessionId>,
    ) -> Result<Vec<Event>> {
        // Numbered rather than positional: mixing `?` and `?1` makes SQLite
        // reuse the first binding for both, which silently matches nothing.
        let rows = sqlx::query(
            "SELECT id, session_id, payload, created_at FROM events
             WHERE id > $1 AND ($2::text IS NULL OR session_id = $2) ORDER BY id",
        )
        .bind(since)
        .bind(session.map(|s| s.as_str()))
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|r| {
                let payload: serde_json::Value = r.get("payload");
                Ok(Event {
                    seq: r.get("id"),
                    session_id: SessionId::from_stored(r.get::<String, _>("session_id")),
                    kind: serde_json::from_value(payload)?,
                    at: r.get("created_at"),
                })
            })
            .collect()
    }
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
    }
}

fn session_from_row(r: sqlx::postgres::PgRow) -> Result<Session> {
    let status: String = r.get("status");
    let agent: String = r.get("agent");
    let size: String = r.get("size");

    Ok(Session {
        number: r.get("number"),
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

    async fn db() -> Db {
        Db::open_for_test().await.unwrap()
    }

    #[tokio::test]
    async fn localhost_is_stored_like_any_other_host() {
        let db = db().await;
        let local = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let remote = db
            .ensure_host(
                "fire-01",
                Compute::Server {
                    host: "203.0.113.44".into(),
                    user: Some("root".into()),
                    port: Some(2222),
                    identity_file: Some("~/.ssh/fire".into()),
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
                identity_file: Some("~/.ssh/fire".into()),
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
        let db = Db::open_for_test().await.unwrap();
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
        let db = Db::open_for_test().await.unwrap();
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();

        db.insert_session(
            &id,
            &host.id,
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
        let db = Db::open_for_test().await.unwrap();
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        assert!(!db.is_drained(&host.id).await.unwrap());
        db.set_drained(&host.id, true).await.unwrap();
        assert!(db.is_drained(&host.id).await.unwrap());

        let still = db.hosts().await.unwrap();
        assert_eq!(still[0].state, HostState::Unreachable, "state is untouched");
    }

    #[tokio::test]
    async fn registering_a_host_twice_is_harmless() {
        let db = db().await;
        let first = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let again = db.ensure_host("localhost", Compute::Local).await.unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(db.hosts().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_host_starts_unreachable_until_it_says_hello() {
        let db = db().await;
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
        let db = db().await;
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
        let db = db().await;
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
        let db = db().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
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
        let db = db().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
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
        let db = db().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
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
        };
        let now = chrono::Utc::now();

        // a worker replays everything it isn't sure we saw
        db.record_event(&host.id, 7, &id, &kind, now).await.unwrap();
        db.record_event(&host.id, 7, &id, &kind, now).await.unwrap();

        assert_eq!(db.events_since(0).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_session_can_have_no_repository_at_all() {
        // A bare agent: somewhere to work, nothing checked out. The columns
        // that describe a checkout are absent rather than empty strings.
        let db = db().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();

        db.insert_session(
            &id,
            &host.id,
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
        let db = Db::open_for_test().await.unwrap();
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        for n in 0..5 {
            let id = SessionId::new();
            db.insert_session(
                &id,
                &host.id,
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

        let first = db.sessions_page(Some(2), None).await.unwrap();
        assert_eq!(first.len(), 2);

        let cursor = first.last().unwrap().id.to_string();
        let second = db.sessions_page(Some(2), Some(&cursor)).await.unwrap();
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
            .sessions_page(None, None)
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
        let db = Db::open_for_test().await.unwrap();
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        let mine = SessionId::new();
        let theirs = SessionId::new();
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
            db.events_since_for(0, Some(&mine)).await.unwrap().len(),
            2,
            "narrowing should return only that session's events"
        );
    }

    #[tokio::test]
    async fn the_resume_cursor_only_moves_forward() {
        let db = db().await;
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
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
        let db = db().await;
        let a = db
            .ensure_repo("acme/backend", "git@x:acme/backend", Some("main"), None)
            .await
            .unwrap();
        let b = db
            .ensure_repo("acme/backend", "git@x:acme/backend", Some("main"), None)
            .await
            .unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(db.repos().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn configuring_an_agent_twice_updates_rather_than_duplicates() {
        let db = Db::open_for_test().await.unwrap();
        db.set_agent_mode(Agent::ClaudeCode, AgentMode::Subscription, true)
            .await
            .unwrap();
        db.set_agent_mode(Agent::ClaudeCode, AgentMode::ApiKey, true)
            .await
            .unwrap();

        let modes = db.agent_modes().await.unwrap();
        assert_eq!(modes.len(), 1);
        assert_eq!(modes[0].1, AgentMode::ApiKey);
    }

    #[tokio::test]
    async fn an_unconfigured_agent_is_absent_not_defaulted() {
        let db = Db::open_for_test().await.unwrap();
        assert!(db.agent_modes().await.unwrap().is_empty());

        db.set_agent_mode(Agent::Codex, AgentMode::ApiKey, true)
            .await
            .unwrap();
        db.forget_agent(Agent::Codex).await.unwrap();
        assert!(db.agent_modes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn presence_is_remembered_per_host_and_refreshed_in_place() {
        let db = Db::open_for_test().await.unwrap();
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
        let db = Db::open_for_test().await.unwrap();
        let host = db
            .ensure_host(
                "34.122.172.74",
                Compute::Server {
                    host: "34.122.172.74".into(),
                    user: Some("kevin".into()),
                    port: None,
                    identity_file: None,
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

    /// Numbers are handed out once and never handed out again.
    ///
    /// Reuse would mean a number written down last week coming back pointing at
    /// somebody else's session, and the inbox is a place people come back to.
    #[tokio::test]
    async fn every_session_gets_its_own_number_and_a_name_from_it() {
        let db = Db::open_for_test().await.unwrap();
        let host = db.ensure_host("localhost", Compute::Local).await.unwrap();

        let mut made = Vec::new();
        for expected in 1..=3 {
            let id = SessionId::new();
            db.insert_session(
                &id,
                &host.id,
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
    #[tokio::test]
    async fn a_host_this_build_cannot_read_is_skipped_rather_than_fatal() {
        let db = Db::open_for_test().await.unwrap();
        let keep = db.ensure_host("localhost", Compute::Local).await.unwrap();

        // What a newer version would have left behind.
        sqlx::query(
            "INSERT INTO hosts (id, name, compute, state, created_at)
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind("h_fromthefuture")
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
