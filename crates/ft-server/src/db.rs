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

    pub async fn hosts(&self) -> Result<Vec<Host>> {
        sqlx::query("SELECT * FROM hosts ORDER BY created_at")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(host_from_row)
            .collect()
    }

    pub async fn mark_host_online(
        &self,
        id: &HostId,
        version: &str,
        cpus: u32,
        memory_mb: u64,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE hosts SET state = 'Online', worker_version = $1, cpus = $2, memory_mb = $3,
                              last_seen_at = $4 WHERE id = $5",
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
        default_branch: &str,
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
                steps, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Starting', $10, $11, $12)",
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

        if let EventKind::StatusChanged { status } = kind {
            sqlx::query("UPDATE sessions SET status = $1, updated_at = $2 WHERE id = $3")
                .bind(serde_json::to_string(status)?.trim_matches('"'))
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
                    target: "root@203.0.113.44".into(),
                    host_key: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(
            local.compute,
            Compute::Local,
            "there is nothing to connect to locally"
        );
        assert!(matches!(remote.compute, Compute::Server { .. }));
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
            .ensure_repo("acme/backend", "git@x:acme/backend", "main", None)
            .await
            .unwrap();
        let b = db
            .ensure_repo("acme/backend", "git@x:acme/backend", "main", None)
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
}
