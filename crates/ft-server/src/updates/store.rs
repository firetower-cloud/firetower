//! What an upgrade leaves in the database: the last check, the runs, and
//! each step's log.
//!
//! In Postgres rather than in memory because the run that matters most
//! recreates the control plane half way through. A new process picks the run
//! up from these rows and carries on.

use super::{RunState, StepState};
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::{PgPool, Row};

/// How much of a step's log is kept. A compose pull is a few kilobytes; a
/// helper that loops is not something to keep all of.
const LOG_CAP: usize = 64 * 1024;

/// How many runs the history shows.
pub const HISTORY: i64 = 50;

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

/// What the last check found. One row.
#[derive(Debug, Clone)]
pub struct Checked {
    pub checked_at: DateTime<Utc>,
    pub latest_version: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub notes_url: Option<String>,
    pub notes: Option<String>,
    pub cli_minimum: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Run {
    pub id: String,
    pub from_version: String,
    pub to_version: String,
    pub targets: Targets,
    pub when_idle: bool,
    pub plan: Plan,
    pub state: RunState,
    pub started_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Targets {
    pub control_plane: bool,
    pub host_ids: Vec<String>,
}

/// Decided when the run was made and carried with it.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    #[serde(default)]
    pub files: Vec<ft_updater_api::FileWrite>,
}

#[derive(Debug, Clone)]
pub struct Step {
    pub position: i32,
    pub target: String,
    pub title: String,
    pub state: StepState,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub detail: Option<String>,
    pub log: String,
    pub job_id: Option<String>,
    pub was_drained: Option<bool>,
}

impl Store {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    // ── the check ──────────────────────────────────────────────────────

    pub async fn record_check(&self, found: &Checked) -> Result<()> {
        sqlx::query(
            "INSERT INTO update_checks (singleton, checked_at, latest_version, published_at,
                                        notes_url, notes, cli_minimum, error)
             VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (singleton) DO UPDATE SET
                checked_at = EXCLUDED.checked_at,
                latest_version = COALESCE(EXCLUDED.latest_version, update_checks.latest_version),
                published_at = COALESCE(EXCLUDED.published_at, update_checks.published_at),
                notes_url = COALESCE(EXCLUDED.notes_url, update_checks.notes_url),
                notes = COALESCE(EXCLUDED.notes, update_checks.notes),
                cli_minimum = COALESCE(EXCLUDED.cli_minimum, update_checks.cli_minimum),
                error = EXCLUDED.error",
        )
        .bind(found.checked_at)
        .bind(&found.latest_version)
        .bind(found.published_at)
        .bind(&found.notes_url)
        .bind(&found.notes)
        .bind(&found.cli_minimum)
        .bind(&found.error)
        .execute(&self.pool)
        .await
        .context("recording the update check")?;
        Ok(())
    }

    pub async fn last_check(&self) -> Result<Option<Checked>> {
        let row = sqlx::query("SELECT * FROM update_checks")
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| Checked {
            checked_at: r.get("checked_at"),
            latest_version: r.get("latest_version"),
            published_at: r.get("published_at"),
            notes_url: r.get("notes_url"),
            notes: r.get("notes"),
            cli_minimum: r.get("cli_minimum"),
            error: r.get("error"),
        }))
    }

    // ── runs ───────────────────────────────────────────────────────────

    /// Make a run and its steps together. Refuses while one is in progress:
    /// two runs over one fleet is a recreate under a rollback.
    pub async fn create_run(&self, run: &Run, steps: &[(String, String)]) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let active = sqlx::query(
            "SELECT id FROM update_runs WHERE state IN ('planned', 'waiting_idle', 'running') FOR UPDATE",
        )
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(row) = active {
            anyhow::bail!(
                "an upgrade is already in progress ({})",
                row.get::<String, _>("id")
            );
        }

        sqlx::query(
            "INSERT INTO update_runs (id, from_version, to_version, targets, when_idle, plan,
                                      state, started_by, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        )
        .bind(&run.id)
        .bind(&run.from_version)
        .bind(&run.to_version)
        .bind(serde_json::to_value(&run.targets)?)
        .bind(run.when_idle)
        .bind(serde_json::to_value(&run.plan)?)
        .bind(run.state.as_db())
        .bind(&run.started_by)
        .bind(run.created_at)
        .execute(&mut *tx)
        .await
        .context("recording the run")?;

        for (position, (target, title)) in steps.iter().enumerate() {
            sqlx::query(
                "INSERT INTO update_steps (run_id, position, target, title) VALUES ($1, $2, $3, $4)",
            )
            .bind(&run.id)
            .bind(position as i32)
            .bind(target)
            .bind(title)
            .execute(&mut *tx)
            .await
            .context("recording a step")?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn run(&self, id: &str) -> Result<Option<Run>> {
        let row = sqlx::query("SELECT * FROM update_runs WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(run_from_row).transpose()
    }

    pub async fn runs(&self) -> Result<Vec<Run>> {
        sqlx::query("SELECT * FROM update_runs ORDER BY created_at DESC LIMIT $1")
            .bind(HISTORY)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(run_from_row)
            .collect()
    }

    /// Runs that are not over. Normally none or one.
    pub async fn active_runs(&self) -> Result<Vec<Run>> {
        sqlx::query(
            "SELECT * FROM update_runs WHERE state IN ('planned', 'waiting_idle', 'running')
             ORDER BY created_at",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(run_from_row)
        .collect()
    }

    pub async fn set_run_state(&self, id: &str, state: RunState) -> Result<()> {
        sqlx::query("UPDATE update_runs SET state = $1 WHERE id = $2")
            .bind(state.as_db())
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn start_run(&self, id: &str) -> Result<()> {
        sqlx::query(
            "UPDATE update_runs SET state = 'running', started_at = COALESCE(started_at, $1) WHERE id = $2",
        )
        .bind(Utc::now())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn finish_run(&self, id: &str, state: RunState, error: Option<String>) -> Result<()> {
        sqlx::query(
            "UPDATE update_runs SET state = $1, error = $2, finished_at = $3 WHERE id = $4",
        )
        .bind(state.as_db())
        .bind(error)
        .bind(Utc::now())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Ask a run to stop. Only a run that is not over can be asked, and the
    /// executor is what actually stops it, at its next look.
    pub async fn request_cancel(&self, id: &str) -> Result<bool> {
        let done = sqlx::query(
            "UPDATE update_runs SET state = 'cancelled', finished_at = $1
              WHERE id = $2 AND state IN ('planned', 'waiting_idle')",
        )
        .bind(Utc::now())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() > 0)
    }

    // ── steps ──────────────────────────────────────────────────────────

    pub async fn steps(&self, run_id: &str) -> Result<Vec<Step>> {
        sqlx::query("SELECT * FROM update_steps WHERE run_id = $1 ORDER BY position")
            .bind(run_id)
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(step_from_row)
            .collect()
    }

    pub async fn start_step(&self, run_id: &str, position: i32) -> Result<()> {
        sqlx::query(
            "UPDATE update_steps SET state = 'running', started_at = $1
              WHERE run_id = $2 AND position = $3",
        )
        .bind(Utc::now())
        .bind(run_id)
        .bind(position)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn end_step(
        &self,
        run_id: &str,
        position: i32,
        state: StepState,
        detail: Option<String>,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE update_steps SET state = $1, detail = $2, finished_at = $3
              WHERE run_id = $4 AND position = $5",
        )
        .bind(state.as_db())
        .bind(detail)
        .bind(Utc::now())
        .bind(run_id)
        .bind(position)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Everything still pending is not going to happen.
    pub async fn skip_pending(&self, run_id: &str) -> Result<()> {
        sqlx::query(
            "UPDATE update_steps SET state = 'skipped' WHERE run_id = $1 AND state = 'pending'",
        )
        .bind(run_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn append_log(&self, run_id: &str, position: i32, line: &str) -> Result<()> {
        let line = format!("{line}\n");
        sqlx::query(
            "UPDATE update_steps SET log = right(log || $1, $2)
              WHERE run_id = $3 AND position = $4",
        )
        .bind(line)
        .bind(LOG_CAP as i32)
        .bind(run_id)
        .bind(position)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_job_id(&self, run_id: &str, position: i32, job_id: &str) -> Result<()> {
        sqlx::query("UPDATE update_steps SET job_id = $1 WHERE run_id = $2 AND position = $3")
            .bind(job_id)
            .bind(run_id)
            .bind(position)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn set_was_drained(&self, run_id: &str, position: i32, was: bool) -> Result<()> {
        sqlx::query("UPDATE update_steps SET was_drained = $1 WHERE run_id = $2 AND position = $3")
            .bind(was)
            .bind(run_id)
            .bind(position)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

fn run_from_row(r: sqlx::postgres::PgRow) -> Result<Run> {
    let state: String = r.get("state");
    Ok(Run {
        id: r.get("id"),
        from_version: r.get("from_version"),
        to_version: r.get("to_version"),
        targets: serde_json::from_value(r.get::<serde_json::Value, _>("targets"))
            .context("reading a run's targets")?,
        when_idle: r.get("when_idle"),
        plan: serde_json::from_value(r.get::<serde_json::Value, _>("plan"))
            .context("reading a run's plan")?,
        state: RunState::from_db(&state).with_context(|| format!("run state {state}"))?,
        started_by: r.get("started_by"),
        created_at: r.get("created_at"),
        started_at: r.get("started_at"),
        finished_at: r.get("finished_at"),
        error: r.get("error"),
    })
}

fn step_from_row(r: sqlx::postgres::PgRow) -> Result<Step> {
    let state: String = r.get("state");
    Ok(Step {
        position: r.get("position"),
        target: r.get("target"),
        title: r.get("title"),
        state: StepState::from_db(&state).with_context(|| format!("step state {state}"))?,
        started_at: r.get("started_at"),
        finished_at: r.get("finished_at"),
        detail: r.get("detail"),
        log: r.get("log"),
        job_id: r.get("job_id"),
        was_drained: r.get("was_drained"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_run(id: &str) -> Run {
        Run {
            id: id.into(),
            from_version: "0.30.1".into(),
            to_version: "0.31.0".into(),
            targets: Targets {
                control_plane: true,
                host_ids: vec![],
            },
            when_idle: false,
            plan: Plan::default(),
            state: RunState::Planned,
            started_by: None,
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn a_run_is_kept_with_its_steps_and_only_one_may_be_in_progress() {
        let (db, _owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let store = Store::new(db.pool().clone());

        store
            .create_run(
                &a_run("run_1"),
                &[
                    ("preflight".into(), "Check".into()),
                    ("control_plane".into(), "Upgrade the control plane".into()),
                ],
            )
            .await
            .unwrap();

        let said = store
            .create_run(&a_run("run_2"), &[])
            .await
            .unwrap_err()
            .to_string();
        assert!(said.contains("already in progress"), "{said}");

        store.start_step("run_1", 0).await.unwrap();
        store.append_log("run_1", 0, "hello").await.unwrap();
        store.append_log("run_1", 0, "world").await.unwrap();
        store
            .end_step("run_1", 0, StepState::Done, Some("ok".into()))
            .await
            .unwrap();
        store.set_job_id("run_1", 1, "job_9").await.unwrap();
        store.set_was_drained("run_1", 1, false).await.unwrap();

        let steps = store.steps("run_1").await.unwrap();
        assert_eq!(steps[0].state, StepState::Done);
        assert_eq!(steps[0].log, "hello\nworld\n");
        assert_eq!(steps[0].detail.as_deref(), Some("ok"));
        assert_eq!(steps[1].job_id.as_deref(), Some("job_9"));
        assert_eq!(steps[1].was_drained, Some(false));

        store.start_run("run_1").await.unwrap();
        assert_eq!(store.active_runs().await.unwrap().len(), 1);
        assert!(
            !store.request_cancel("run_1").await.unwrap(),
            "a running run is not cancelled from outside"
        );
        store
            .finish_run("run_1", RunState::Succeeded, None)
            .await
            .unwrap();
        assert!(store.active_runs().await.unwrap().is_empty());

        // Now a second is allowed, and the history lists both, newest first.
        store.create_run(&a_run("run_2"), &[]).await.unwrap();
        let runs = store.runs().await.unwrap();
        assert_eq!(runs[0].id, "run_2");
        assert_eq!(runs[1].state, RunState::Succeeded);

        // A planned run can be cancelled from outside; pending steps are skipped.
        assert!(store.request_cancel("run_2").await.unwrap());
        store.skip_pending("run_2").await.unwrap();
        assert_eq!(
            store.run("run_2").await.unwrap().unwrap().state,
            RunState::Cancelled
        );
    }

    #[tokio::test]
    async fn the_log_is_bounded() {
        let (db, _owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let store = Store::new(db.pool().clone());
        store
            .create_run(&a_run("run_1"), &[("preflight".into(), "Check".into())])
            .await
            .unwrap();
        let long = "x".repeat(LOG_CAP);
        store.append_log("run_1", 0, &long).await.unwrap();
        store.append_log("run_1", 0, "tail").await.unwrap();
        let log = store.steps("run_1").await.unwrap()[0].log.clone();
        assert!(log.len() <= LOG_CAP);
        assert!(
            log.ends_with("tail\n"),
            "the end is what explains a failure"
        );
    }

    #[tokio::test]
    async fn the_check_keeps_the_last_good_answer_through_a_failed_one() {
        let (db, _owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let store = Store::new(db.pool().clone());
        assert!(store.last_check().await.unwrap().is_none());

        store
            .record_check(&Checked {
                checked_at: Utc::now(),
                latest_version: Some("0.31.0".into()),
                published_at: None,
                notes_url: None,
                notes: Some("notes".into()),
                cli_minimum: Some("0.9.0".into()),
                error: None,
            })
            .await
            .unwrap();
        store
            .record_check(&Checked {
                checked_at: Utc::now(),
                latest_version: None,
                published_at: None,
                notes_url: None,
                notes: None,
                cli_minimum: None,
                error: Some("GitHub is down".into()),
            })
            .await
            .unwrap();

        let last = store.last_check().await.unwrap().unwrap();
        assert_eq!(last.latest_version.as_deref(), Some("0.31.0"));
        assert_eq!(last.notes.as_deref(), Some("notes"));
        assert_eq!(last.error.as_deref(), Some("GitHub is down"));
    }
}
