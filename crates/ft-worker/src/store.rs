//! The worker's own database.
//!
//! This is the authoritative record of what happened. The control plane keeps a
//! cache it can rebuild from here, which is what lets a laptop sleep for eight
//! hours and miss nothing: on reconnect it asks for everything since the last
//! sequence number it saw.

use anyhow::{Context, Result};
use ft_core::{EventKind, SessionId, SessionStatus};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::str::FromStr;

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

/// One thing that happened, as recorded.
#[derive(Debug, Clone)]
pub struct StoredEvent {
    pub seq: i64,
    pub session_id: SessionId,
    pub kind: EventKind,
    pub at: chrono::DateTime<chrono::Utc>,
}

impl Store {
    /// Open (creating if needed) and bring the schema up to date.
    ///
    /// Migrations are embedded and applied here rather than by a separate
    /// command, so an upgrade is never a thing a user has to remember to do.
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("creating {}", parent.display()))?;
        }

        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            // readers don't block the writer, which matters while events append
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
            .busy_timeout(std::time::Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .with_context(|| format!("opening {}", path.display()))?;

        sqlx::migrate!("../../migrations/worker")
            .run(&pool)
            .await
            .context("applying worker migrations")?;

        Ok(Self { pool })
    }

    /// In-memory, for tests.
    pub async fn open_ephemeral() -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::migrate!("../../migrations/worker").run(&pool).await?;
        Ok(Self { pool })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_session(
        &self,
        id: &SessionId,
        repo: Option<&str>,
        title: &str,
        prompt: &str,
        branch: Option<&str>,
        base: Option<&str>,
        agent: &str,
        size: ft_core::WorkspaceSize,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO sessions
               (id, repo, title, prompt, branch, base, agent, size, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id.as_str())
        .bind(repo)
        .bind(title)
        .bind(prompt)
        .bind(branch)
        .bind(base)
        .bind(agent)
        .bind(serde_json::to_string(&size)?.trim_matches('"').to_string())
        .bind(serde_json::to_string(&SessionStatus::Starting)?.trim_matches('"'))
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await
        .context("inserting session")?;
        Ok(())
    }

    pub async fn set_status(&self, id: &SessionId, status: SessionStatus) -> Result<()> {
        sqlx::query("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
            .bind(serde_json::to_string(&status)?.trim_matches('"'))
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn status_of(&self, id: &SessionId) -> Result<Option<SessionStatus>> {
        let row = sqlx::query("SELECT status FROM sessions WHERE id = ?")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;

        row.map(|r| {
            let raw: String = r.get("status");
            serde_json::from_str(&format!("\"{raw}\"")).context("decoding status")
        })
        .transpose()
    }

    /// Record an event and hand back its sequence number.
    ///
    /// The event is durable before it is sent, so a crash between the two means
    /// a replayed event rather than a lost one.
    pub async fn append(&self, session_id: &SessionId, kind: &EventKind) -> Result<StoredEvent> {
        let at = chrono::Utc::now();
        let result = sqlx::query(
            "INSERT INTO events (session_id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(session_id.as_str())
        .bind(kind.label())
        .bind(serde_json::to_string(kind)?)
        .bind(at.to_rfc3339())
        .execute(&self.pool)
        .await
        .context("appending event")?;

        Ok(StoredEvent {
            seq: result.last_insert_rowid(),
            session_id: session_id.clone(),
            kind: kind.clone(),
            at,
        })
    }

    /// Everything after `since`, oldest first. This is the resume path.
    /// The last sequence number in the log, or zero for an empty one.
    ///
    /// Read when a worker starts, so it knows what already happened without
    /// re-sending it: everything older belongs to a connection that is over,
    /// and a control plane that wants it asks with `Resume`.
    pub async fn latest_seq(&self) -> Result<i64> {
        let row = sqlx::query("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")
            .fetch_one(&self.pool)
            .await
            .context("reading the last sequence number")?;
        Ok(row.get("seq"))
    }

    pub async fn events_since(&self, since: i64) -> Result<Vec<StoredEvent>> {
        let rows = sqlx::query(
            "SELECT seq, session_id, payload, created_at
             FROM events WHERE seq > ? ORDER BY seq ASC",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;

        rows.into_iter()
            .map(|r| {
                let payload: String = r.get("payload");
                let created: String = r.get("created_at");
                Ok(StoredEvent {
                    seq: r.get("seq"),
                    session_id: SessionId::from_stored(r.get::<String, _>("session_id")),
                    kind: serde_json::from_str(&payload).context("decoding event payload")?,
                    at: chrono::DateTime::parse_from_rfc3339(&created)?.with_timezone(&chrono::Utc),
                })
            })
            .collect()
    }

    /// The highest sequence number recorded.
    pub async fn head(&self) -> Result<i64> {
        let row = sqlx::query("SELECT COALESCE(MAX(seq), 0) AS head FROM events")
            .fetch_one(&self.pool)
            .await?;
        Ok(row.get("head"))
    }

    pub async fn record_workspace(
        &self,
        session_id: &SessionId,
        path: &str,
        tmux_session: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO workspaces (session_id, path, tmux_session, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET path = excluded.path,
                                                   tmux_session = excluded.tmux_session",
        )
        .bind(session_id.as_str())
        .bind(path)
        .bind(tmux_session)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Correct the branch after git had to disambiguate it.
    pub async fn set_branch(&self, session_id: &SessionId, branch: &str) -> Result<()> {
        sqlx::query("UPDATE sessions SET branch = ?, updated_at = ? WHERE id = ?")
            .bind(branch)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(session_id.as_str())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// The branch a session's worktree is on. The worker may have had to
    /// number it, so this is the authority, not what was asked for.
    pub async fn branch_of(&self, session_id: &SessionId) -> Result<Option<String>> {
        let row = sqlx::query("SELECT branch FROM sessions WHERE id = ?")
            .bind(session_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.get::<Option<String>, _>("branch")))
    }

    /// The branch a session works on and the branch it started from.
    pub async fn refs_of(&self, session_id: &SessionId) -> Result<Option<(String, String)>> {
        let row = sqlx::query("SELECT branch, base FROM sessions WHERE id = ?")
            .bind(session_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| {
            match (
                r.get::<Option<String>, _>("branch"),
                r.get::<Option<String>, _>("base"),
            ) {
                (Some(branch), Some(base)) => Some((branch, base)),
                _ => None,
            }
        }))
    }

    /// Which repository a session came from, for finding its mirror again.
    pub async fn repo_of(&self, session_id: &SessionId) -> Result<Option<String>> {
        let row = sqlx::query("SELECT repo FROM sessions WHERE id = ?")
            .bind(session_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.get::<Option<String>, _>("repo")))
    }

    pub async fn workspace_path(&self, session_id: &SessionId) -> Result<Option<String>> {
        let row = sqlx::query("SELECT path FROM workspaces WHERE session_id = ?")
            .bind(session_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get("path")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> Store {
        Store::open_ephemeral().await.unwrap()
    }

    async fn a_session(s: &Store) -> SessionId {
        let id = SessionId::new();
        s.create_session(
            &id,
            Some("acme/backend"),
            "Fix retries",
            "Fix retries",
            Some("agent/fix"),
            Some("main"),
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
        )
        .await
        .unwrap();
        id
    }

    /// The whole mechanism, from the other side: a second process appends to
    /// this log while the worker is not looking, and the worker finds it.
    ///
    /// This is what makes closing Firetower safe. A hook is not talking to
    /// anybody — it writes to a file — so nothing has to be running to receive
    /// it, and the next connection collects whatever accumulated.
    #[tokio::test]
    async fn an_event_written_by_another_process_is_found_by_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("worker.db");

        let worker = Store::open(&path).await.unwrap();
        let id = SessionId::new();
        worker
            .create_session(
                &id,
                Some("acme/backend"),
                "Fix retries",
                "Fix retries",
                Some("agent/fix"),
                Some("main"),
                "ClaudeCode",
                ft_core::WorkspaceSize::Medium,
            )
            .await
            .unwrap();
        let up_to = worker.latest_seq().await.unwrap();

        // A hook, in its own process, with its own connection to the same file.
        {
            let hook = Store::open(&path).await.unwrap();
            hook.set_status(&id, SessionStatus::NeedsYou).await.unwrap();
            hook.append(
                &id,
                &EventKind::StatusChanged {
                    status: SessionStatus::NeedsYou,
                    note: Some("Claude wants to run `git push --force`".into()),
                },
            )
            .await
            .unwrap();
        }

        // The worker was never told. It finds it by asking what is new.
        let found = worker.events_since(up_to).await.unwrap();
        assert_eq!(found.len(), 1, "exactly the row the hook wrote");
        assert!(matches!(
            &found[0].kind,
            EventKind::StatusChanged {
                status: SessionStatus::NeedsYou,
                note: Some(n),
            } if n.contains("force")
        ));

        assert_eq!(
            worker.status_of(&id).await.unwrap(),
            Some(SessionStatus::NeedsYou),
            "and the session it belongs to is blocked"
        );
    }

    #[tokio::test]
    async fn sequence_numbers_are_monotonic() {
        let s = store().await;
        let id = a_session(&s).await;

        let a = s
            .append(
                &id,
                &EventKind::RepoFetched {
                    detail: "0.9s".into(),
                },
            )
            .await
            .unwrap();
        let b = s
            .append(
                &id,
                &EventKind::WorktreeAdded {
                    branch: "agent/fix".into(),
                },
            )
            .await
            .unwrap();

        assert!(b.seq > a.seq, "{} should follow {}", b.seq, a.seq);
    }

    #[tokio::test]
    async fn resume_returns_only_what_was_missed() {
        let s = store().await;
        let id = a_session(&s).await;

        let first = s
            .append(&id, &EventKind::RepoFetched { detail: "a".into() })
            .await
            .unwrap();
        s.append(&id, &EventKind::WorktreeAdded { branch: "b".into() })
            .await
            .unwrap();
        s.append(&id, &EventKind::TmuxOpened { name: "c".into() })
            .await
            .unwrap();

        // what a laptop that slept after the first event asks for
        let missed = s.events_since(first.seq).await.unwrap();
        assert_eq!(missed.len(), 2);
        assert!(missed[0].seq > first.seq);
    }

    #[tokio::test]
    async fn resuming_from_zero_replays_everything() {
        let s = store().await;
        let id = a_session(&s).await;
        s.append(&id, &EventKind::RepoFetched { detail: "a".into() })
            .await
            .unwrap();
        s.append(&id, &EventKind::TmuxOpened { name: "b".into() })
            .await
            .unwrap();

        assert_eq!(s.events_since(0).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn head_tracks_the_latest_event() {
        let s = store().await;
        assert_eq!(s.head().await.unwrap(), 0, "a fresh store has no history");

        let id = a_session(&s).await;
        let e = s
            .append(&id, &EventKind::RepoFetched { detail: "x".into() })
            .await
            .unwrap();
        assert_eq!(s.head().await.unwrap(), e.seq);
    }

    #[tokio::test]
    async fn event_payloads_survive_the_round_trip() {
        let s = store().await;
        let id = a_session(&s).await;
        s.append(
            &id,
            &EventKind::AgentLaunched {
                agent: ft_core::Agent::ClaudeCode,
            },
        )
        .await
        .unwrap();

        let back = s.events_since(0).await.unwrap();
        assert!(matches!(
            back[0].kind,
            EventKind::AgentLaunched {
                agent: ft_core::Agent::ClaudeCode
            }
        ));
    }

    #[tokio::test]
    async fn status_round_trips() {
        let s = store().await;
        let id = a_session(&s).await;
        assert_eq!(
            s.status_of(&id).await.unwrap(),
            Some(SessionStatus::Starting)
        );

        s.set_status(&id, SessionStatus::NeedsYou).await.unwrap();
        assert_eq!(
            s.status_of(&id).await.unwrap(),
            Some(SessionStatus::NeedsYou)
        );
    }

    #[tokio::test]
    async fn an_unknown_session_has_no_status() {
        let s = store().await;
        assert_eq!(s.status_of(&SessionId::new()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn recording_a_workspace_twice_updates_it() {
        let s = store().await;
        let id = a_session(&s).await;
        s.record_workspace(&id, "/tmp/one", "ft-1").await.unwrap();
        s.record_workspace(&id, "/tmp/two", "ft-1").await.unwrap();
        assert_eq!(
            s.workspace_path(&id).await.unwrap().as_deref(),
            Some("/tmp/two")
        );
    }
}

#[cfg(test)]
mod branch_tests {
    use super::*;
    use ft_core::WorkspaceSize;

    #[tokio::test]
    async fn the_branch_git_actually_used_is_what_gets_pushed() {
        let store = Store::open_ephemeral().await.unwrap();
        let id = SessionId::new();

        store
            .create_session(
                &id,
                Some("acme/backend"),
                "Hello",
                "hello",
                Some("agent/hello"),
                Some("main"),
                "Shell",
                WorkspaceSize::Medium,
            )
            .await
            .unwrap();

        // git numbered it because the first name was taken
        store.set_branch(&id, "agent/hello-2").await.unwrap();

        assert_eq!(
            store.branch_of(&id).await.unwrap().as_deref(),
            Some("agent/hello-2"),
            "the requested name would push over another session's branch"
        );
    }
}
