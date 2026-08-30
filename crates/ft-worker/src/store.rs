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

/// One repository checked out into a session's workspace, as the worker
/// records it.
///
/// Its own type rather than `ft_core::Checkout` because the worker is the side
/// that fetches and so needs the remote, and has no use for a control-plane
/// repository id.
#[derive(Debug, Clone)]
pub struct Checkout {
    pub slug: String,
    pub remote: String,
    pub base: String,
    pub branch: String,
    /// Relative to the workspace. Empty means the checkout *is* the workspace.
    pub path: String,
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
        // A session that is already here is one starting again, not a second
        // one. This database is on the volume, so it outlives the container —
        // and after an upgrade every session on the machine is relaunched into
        // a row that still describes it correctly. A plain insert answered that
        // with a constraint violation, which left the run in `Starting` with
        // nothing to explain it.
        //
        // `created_at` is deliberately not touched: the session began when it
        // began. Everything else is restated, because the caller has just been
        // told what this session is by the control plane and that is newer than
        // whatever is here.
        sqlx::query(
            "INSERT INTO sessions
               (id, repo, title, prompt, branch, base, agent, size, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               repo = excluded.repo,
               title = excluded.title,
               prompt = excluded.prompt,
               branch = excluded.branch,
               base = excluded.base,
               agent = excluded.agent,
               size = excluded.size,
               status = excluded.status,
               updated_at = excluded.updated_at",
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

    /// Which agent a session runs, and what it was asked to do.
    ///
    /// Both were written when it was created. Read back rather than passed
    /// around because the thing that wants them — describing the work at the
    /// end — happens a long way from where the session started.
    pub async fn session_brief(&self, id: &SessionId) -> Result<(ft_core::Agent, String)> {
        let row = sqlx::query("SELECT agent, prompt FROM sessions WHERE id = ?")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?
            .context("no such session")?;

        let agent: String = row.get("agent");
        let agent = ft_core::Agent::from_name(&agent)
            .with_context(|| format!("no agent called {agent}"))?;
        Ok((agent, row.get("prompt")))
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

    /// Why a session is where it is, if anything said.
    pub async fn note_of(&self, id: &SessionId) -> Result<Option<String>> {
        let row = sqlx::query("SELECT note FROM sessions WHERE id = ?")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.and_then(|r| r.get::<Option<String>, _>("note")))
    }

    /// How good the note currently on this session is.
    pub async fn note_rank_of(&self, id: &SessionId) -> Result<i64> {
        let row = sqlx::query("SELECT note_rank FROM sessions WHERE id = ?")
            .bind(id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<i64, _>("note_rank")).unwrap_or(0))
    }

    /// Record why, or clear it.
    ///
    /// Held here as well as in the event so that a hook can tell whether
    /// anything actually changed — without it, an agent that notifies four
    /// times while it waits writes four identical rows.
    pub async fn set_note(&self, id: &SessionId, note: Option<&str>, rank: i64) -> Result<()> {
        sqlx::query("UPDATE sessions SET note = ?, note_rank = ?, updated_at = ? WHERE id = ?")
            .bind(note)
            .bind(rank)
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

    /// Write down a repository this session has checked out.
    ///
    /// Upserted by position, so re-running a checkout corrects the row rather
    /// than adding a second one for the same repository.
    #[allow(clippy::too_many_arguments)]
    pub async fn record_checkout(
        &self,
        session_id: &SessionId,
        position: i64,
        slug: &str,
        remote: &str,
        base: &str,
        branch: &str,
        path: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO session_repos (session_id, position, slug, remote, base, branch, path)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (session_id, position) DO UPDATE SET
                slug = excluded.slug, remote = excluded.remote,
                base = excluded.base, branch = excluded.branch, path = excluded.path",
        )
        .bind(session_id.as_str())
        .bind(position)
        .bind(slug)
        .bind(remote)
        .bind(base)
        .bind(branch)
        .bind(path)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Everything this session has checked out, in the order it was added.
    pub async fn checkouts_of(&self, session_id: &SessionId) -> Result<Vec<Checkout>> {
        let rows = sqlx::query(
            "SELECT slug, remote, base, branch, path FROM session_repos
             WHERE session_id = ? ORDER BY position",
        )
        .bind(session_id.as_str())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| Checkout {
                slug: r.get("slug"),
                remote: r.get("remote"),
                base: r.get("base"),
                branch: r.get("branch"),
                path: r.get("path"),
            })
            .collect())
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

    /// The other agents still working in this session's directory.
    ///
    /// A workspace holds any number of agents and they all share one checkout,
    /// so the worktree belongs to the place rather than to whichever session
    /// was asked to end. Reclaiming it while a sibling is still running would
    /// delete the directory out from under a live process — the files it is
    /// editing, the git metadata, the socket it answers on.
    ///
    /// Ended ones do not count, which is what makes the last one out reclaim
    /// the worktree without anybody having to track who was first.
    pub async fn others_in_workspace(&self, session_id: &SessionId) -> Result<Vec<SessionId>> {
        let rows = sqlx::query(
            "SELECT w.session_id AS id
               FROM workspaces w
               JOIN sessions s ON s.id = w.session_id
              WHERE w.path = (SELECT path FROM workspaces WHERE session_id = ?)
                AND w.session_id <> ?
                AND s.status <> 'Ended'",
        )
        .bind(session_id.as_str())
        .bind(session_id.as_str())
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| SessionId::from_stored(r.get::<String, _>("id")))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> Store {
        Store::open_ephemeral().await.unwrap()
    }

    /// Upgrading Firetower recreates the container, which kills every agent on
    /// the machine — and this database is on the volume, so their rows are all
    /// still here when they come back. A plain insert answered that with a
    /// constraint violation, and the relaunch died before it started.
    #[tokio::test]
    async fn a_session_that_is_already_here_can_start_again() {
        let store = store().await;
        let id = a_session(&store).await;

        store.set_status(&id, SessionStatus::Working).await.unwrap();
        store
            .append(
                &id,
                &EventKind::AgentLaunched {
                    agent: ft_core::Agent::ClaudeCode,
                },
            )
            .await
            .unwrap();
        let before = store.head().await.unwrap();

        // The same session, starting again, exactly as `start_agent` does it.
        store
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
            .expect("a session that already exists starts again rather than failing");

        assert_eq!(
            store.status_of(&id).await.unwrap(),
            Some(SessionStatus::Starting),
            "it is starting, which is what it is doing"
        );
        assert_eq!(
            store.head().await.unwrap(),
            before,
            "and its history is still there, because this is the same session"
        );
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
                    repo: None,
                    asked_for: None,
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
        s.append(
            &id,
            &EventKind::WorktreeAdded {
                branch: "b".into(),
                repo: None,
                asked_for: None,
            },
        )
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
