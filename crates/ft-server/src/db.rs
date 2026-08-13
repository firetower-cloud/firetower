//! The control plane's cache.
//!
//! Nothing here is authoritative. Hosts, repositories and credentials are ours;
//! sessions and events are a projection of what workers reported, rebuildable by
//! reconnecting and replaying from sequence zero.

use anyhow::{Context, Result};
use ft_core::{
    Event, EventKind, Host, HostId, HostState, Repo, RepoId, Session, SessionId, SessionStatus,
    WorkspaceSize,
};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::str::FromStr;

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

impl Db {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await
            .with_context(|| format!("opening {}", path.display()))?;

        Self::migrated(pool).await
    }

    pub async fn open_ephemeral() -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .idle_timeout(None)
            .max_lifetime(None)
            .connect("sqlite::memory:")
            .await?;
        Self::migrated(pool).await
    }

    async fn migrated(pool: SqlitePool) -> Result<Self> {
        sqlx::migrate!("../../migrations/server")
            .run(&pool)
            .await
            .context("applying control-plane migrations")?;
        Ok(Self { pool })
    }

    // ── hosts ──────────────────────────────────────────────────────────

    /// Register a host, or leave the existing one alone.
    ///
    /// `localhost` goes through this like any other host, because it *is* one.
    pub async fn ensure_host(&self, name: &str, ssh_target: Option<&str>) -> Result<Host> {
        if let Some(existing) = self.host_by_name(name).await? {
            return Ok(existing);
        }
        let id = HostId::new();
        sqlx::query(
            "INSERT INTO hosts (id, name, ssh_target, state, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(id.as_str())
        .bind(name)
        .bind(ssh_target)
        .bind("Unreachable")
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;

        self.host_by_name(name)
            .await?
            .context("host vanished immediately after insert")
    }

    pub async fn host_by_name(&self, name: &str) -> Result<Option<Host>> {
        let row = sqlx::query("SELECT * FROM hosts WHERE name = ?")
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
            "UPDATE hosts SET state = 'Online', worker_version = ?, cpus = ?, memory_mb = ?,
                              last_seen_at = ? WHERE id = ?",
        )
        .bind(version)
        .bind(cpus as i64)
        .bind(memory_mb as i64)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// A host we can't reach keeps its sessions visible — hiding them would make
    /// running work look as though it had disappeared.
    pub async fn mark_host_unreachable(&self, id: &HostId) -> Result<()> {
        sqlx::query("UPDATE hosts SET state = 'Unreachable' WHERE id = ?")
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// How far we have consumed this worker's log.
    pub async fn last_seq(&self, id: &HostId) -> Result<i64> {
        let row = sqlx::query("SELECT last_seq FROM hosts WHERE id = ?")
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
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(RepoId::new().as_str())
        .bind(slug)
        .bind(remote)
        .bind(default_branch)
        .bind(setup)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;

        self.repo_by_remote(remote)
            .await?
            .context("repo vanished after insert")
    }

    pub async fn repo_by_remote(&self, remote: &str) -> Result<Option<Repo>> {
        let row = sqlx::query("SELECT * FROM repos WHERE remote = ?")
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
        let rows = sqlx::query("SELECT title FROM sessions WHERE repo = ? AND status != ?")
            .bind(slug)
            .bind(format!("{:?}", SessionStatus::Ended))
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(|r| r.get::<String, _>("title")).collect())
    }

    pub async fn delete_repo(&self, id: &RepoId) -> Result<()> {
        sqlx::query("DELETE FROM repos WHERE id = ?")
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn repo_by_slug(&self, slug: &str) -> Result<Option<Repo>> {
        let row = sqlx::query("SELECT * FROM repos WHERE slug = ?")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(repo_from_row))
    }

    pub async fn repo(&self, id: &RepoId) -> Result<Option<Repo>> {
        let row = sqlx::query("SELECT * FROM repos WHERE id = ?")
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
        repo: &str,
        title: &str,
        prompt: &str,
        branch: &str,
        base: &str,
        agent: &str,
        size: WorkspaceSize,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO sessions
               (id, host_id, repo, title, prompt, branch, base, agent, size, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Starting', ?, ?)",
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
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn sessions(&self) -> Result<Vec<Session>> {
        sqlx::query("SELECT * FROM sessions ORDER BY updated_at DESC")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(session_from_row)
            .collect()
    }

    pub async fn session(&self, id: &SessionId) -> Result<Option<Session>> {
        let row = sqlx::query("SELECT * FROM sessions WHERE id = ?")
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
            "INSERT OR IGNORE INTO events (host_id, seq, session_id, payload, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(host_id.as_str())
        .bind(seq)
        .bind(session_id.as_str())
        .bind(serde_json::to_string(kind)?)
        .bind(at.to_rfc3339())
        .execute(&mut *tx)
        .await?;

        // The worker may have had to disambiguate the branch name, so the
        // authoritative value arrives with the event rather than being what we
        // asked for.
        if let EventKind::WorktreeAdded { branch } = kind {
            sqlx::query("UPDATE sessions SET branch = ?, updated_at = ? WHERE id = ?")
                .bind(branch)
                .bind(at.to_rfc3339())
                .bind(session_id.as_str())
                .execute(&mut *tx)
                .await?;
        }

        if let EventKind::StatusChanged { status } = kind {
            sqlx::query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
                .bind(serde_json::to_string(status)?.trim_matches('"'))
                .bind(at.to_rfc3339())
                .bind(session_id.as_str())
                .execute(&mut *tx)
                .await?;
        }

        sqlx::query("UPDATE hosts SET last_seq = ? WHERE id = ? AND last_seq < ?")
            .bind(seq)
            .bind(host_id.as_str())
            .bind(seq)
            .execute(&mut *tx)
            .await?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn events_since(&self, since: i64) -> Result<Vec<Event>> {
        let rows = sqlx::query(
            "SELECT id, session_id, payload, created_at FROM events WHERE id > ? ORDER BY id",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|r| {
                let payload: String = r.get("payload");
                let created: String = r.get("created_at");
                Ok(Event {
                    seq: r.get("id"),
                    session_id: SessionId::from_stored(r.get::<String, _>("session_id")),
                    kind: serde_json::from_str(&payload)?,
                    at: chrono::DateTime::parse_from_rfc3339(&created)?.with_timezone(&chrono::Utc),
                })
            })
            .collect()
    }
}

fn host_from_row(r: sqlx::sqlite::SqliteRow) -> Result<Host> {
    let raw: String = r.get("state");
    Ok(Host {
        id: HostId::from_stored(r.get::<String, _>("id")),
        name: r.get("name"),
        state: serde_json::from_str::<HostState>(&format!("\"{raw}\""))
            .context("decoding host state")?,
        ssh_target: r.get("ssh_target"),
        cpus: r.get::<Option<i64>, _>("cpus").map(|v| v as u32),
        memory_mb: r.get::<Option<i64>, _>("memory_mb").map(|v| v as u64),
        worker_version: r.get("worker_version"),
    })
}

fn repo_from_row(r: sqlx::sqlite::SqliteRow) -> Repo {
    Repo {
        id: RepoId::from_stored(r.get::<String, _>("id")),
        slug: r.get("slug"),
        remote: r.get("remote"),
        default_branch: r.get("default_branch"),
        setup: r.get("setup"),
    }
}

fn session_from_row(r: sqlx::sqlite::SqliteRow) -> Result<Session> {
    let status: String = r.get("status");
    let agent: String = r.get("agent");
    let size: String = r.get("size");
    let created: String = r.get("created_at");
    let updated: String = r.get("updated_at");
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
        created_at: chrono::DateTime::parse_from_rfc3339(&created)?.with_timezone(&chrono::Utc),
        updated_at: chrono::DateTime::parse_from_rfc3339(&updated)?.with_timezone(&chrono::Utc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn db() -> Db {
        Db::open_ephemeral().await.unwrap()
    }

    #[tokio::test]
    async fn localhost_is_stored_like_any_other_host() {
        let db = db().await;
        let local = db.ensure_host("localhost", None).await.unwrap();
        let remote = db
            .ensure_host("fire-01", Some("root@203.0.113.44"))
            .await
            .unwrap();

        assert_eq!(
            local.ssh_target, None,
            "there is nothing to connect to locally"
        );
        assert!(remote.ssh_target.is_some());
        assert_eq!(db.hosts().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn registering_a_host_twice_is_harmless() {
        let db = db().await;
        let first = db.ensure_host("localhost", None).await.unwrap();
        let again = db.ensure_host("localhost", None).await.unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(db.hosts().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_host_starts_unreachable_until_it_says_hello() {
        let db = db().await;
        let host = db.ensure_host("localhost", None).await.unwrap();
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
        let host = db.ensure_host("localhost", None).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            "acme/backend",
            "Fix",
            "Fix",
            "agent/fix",
            "main",
            "ClaudeCode",
            WorkspaceSize::Medium,
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
        let host = db.ensure_host("localhost", None).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            "acme/backend",
            "Fix",
            "Fix",
            "agent/fix",
            "main",
            "ClaudeCode",
            WorkspaceSize::Medium,
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
            db.session(&id).await.unwrap().unwrap().branch,
            "agent/fix-2"
        );
    }

    #[tokio::test]
    async fn a_replayed_event_is_ignored_rather_than_duplicated() {
        let db = db().await;
        let host = db.ensure_host("localhost", None).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            "acme/backend",
            "Fix",
            "Fix",
            "agent/fix",
            "main",
            "ClaudeCode",
            WorkspaceSize::Medium,
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
    async fn the_resume_cursor_only_moves_forward() {
        let db = db().await;
        let host = db.ensure_host("localhost", None).await.unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            "r",
            "t",
            "p",
            "b",
            "main",
            "Shell",
            WorkspaceSize::Medium,
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
}
