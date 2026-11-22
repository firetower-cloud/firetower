//! Deletions an agent asked for and a person has not answered yet.
//!
//! **There is no tool that deletes.** `request_deletion` writes a row here
//! and stops; the delete happens in `POST /deletion-requests/{id}/approve`,
//! which is reachable only by a signed-in person. An agent's single door to
//! the control plane is `delegate.rs`'s tool dispatch, and approving is not
//! on it — so "the agent can never do it on its own" is a property of the
//! shape rather than of a check somebody has to remember.
//!
//! It is the same asymmetry [`crate::delegate`] already gives schedules: an
//! agent may write a thing down, and a person turns it on.
//!
//! ## What is trusted at approval time, and what is not
//!
//! The row records **what was asked**. It is not a capability to delete
//! whatever that id now points at: `approve` re-reads the object, re-computes
//! what it takes with it, and runs the same delete a person's own button
//! runs — including every refusal that one makes. A team that grew a branch
//! between the ask and the answer is deleted with the branch, and the person
//! sees the count as it is now rather than as it was.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use utoipa::ToSchema;

/// What kind of thing a request is about.
///
/// Two, and a third needs a migration — the check constraint and this enum
/// are the same statement, and the point of both is that adding a kind means
/// looking at what its delete does first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    AgentTeam,
    Role,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::AgentTeam => "agentTeam",
            Kind::Role => "role",
        }
    }
    fn read(s: &str) -> Kind {
        match s {
            "agentTeam" => Kind::AgentTeam,
            _ => Kind::Role,
        }
    }
    /// What this kind is called in a sentence to a person.
    pub fn noun(self) -> &'static str {
        match self {
            Kind::AgentTeam => "team",
            Kind::Role => "profile",
        }
    }
}

/// One question waiting for an answer.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub id: String,
    pub kind: Kind,
    /// What it points at. Still here after a refusal, so the same thing is
    /// not asked about twice without somebody noticing.
    pub target: String,
    /// The name as it was when the request was written.
    pub target_name: String,
    /// What it takes with it, as computed when asked. Re-computed before the
    /// delete actually happens — this is the version the agent saw.
    pub consequence: String,
    /// Why the agent says it should go, in its own words.
    pub reason: Option<String>,
    /// The session that asked, so the decision can be read back to the
    /// conversation that wanted it.
    pub session: Option<String>,
    pub asked_at: String,
    pub state: String,
    pub decided_at: Option<String>,
    /// What the person said when they refused.
    pub note: Option<String>,
}

fn read(row: &sqlx::postgres::PgRow) -> Request {
    Request {
        id: row.get("id"),
        kind: Kind::read(row.get::<String, _>("kind").as_str()),
        target: row.get("target_id"),
        target_name: row.get("target_name"),
        consequence: row.get("consequence"),
        reason: row.get("reason"),
        session: row.get("asked_session"),
        asked_at: row
            .get::<chrono::DateTime<chrono::Utc>, _>("asked_at")
            .to_rfc3339(),
        state: row.get("state"),
        decided_at: row
            .get::<Option<chrono::DateTime<chrono::Utc>>, _>("decided_at")
            .map(|t| t.to_rfc3339()),
        note: row.get("note"),
    }
}

#[derive(Clone)]
pub struct Removals {
    pool: PgPool,
}

impl Removals {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Write one down, pending.
    ///
    /// Returns `Ok(None)` when there is already one waiting for the same
    /// thing — the caller says so rather than stacking a second question up,
    /// which is what the partial unique index is for.
    #[allow(clippy::too_many_arguments)]
    pub async fn ask(
        &self,
        org: &str,
        kind: Kind,
        target: &str,
        target_name: &str,
        consequence: &str,
        reason: Option<&str>,
        asked_by: &str,
        session: Option<&str>,
    ) -> Result<Option<Request>> {
        let id = format!("dr_{}", ulid::Ulid::new().to_string().to_lowercase());
        let row = sqlx::query(
            "INSERT INTO deletion_requests
               (id, org_id, kind, target_id, target_name, consequence, reason,
                asked_by, asked_session)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT DO NOTHING
             RETURNING *",
        )
        .bind(&id)
        .bind(org)
        .bind(kind.as_str())
        .bind(target)
        .bind(target_name)
        .bind(consequence)
        .bind(reason)
        .bind(asked_by)
        .bind(session)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(read))
    }

    /// The one already waiting for this thing, if there is one.
    pub async fn pending_for(&self, kind: Kind, target: &str) -> Result<Option<Request>> {
        let row = sqlx::query(
            "SELECT * FROM deletion_requests
             WHERE kind = $1 AND target_id = $2 AND state = 'pending'",
        )
        .bind(kind.as_str())
        .bind(target)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.as_ref().map(read))
    }

    /// Every request still waiting in this organization.
    ///
    /// **Not filtered by what the asker could see.** A pending deletion is a
    /// question put to whoever administers the thing, and the approve call
    /// runs as the person answering — so the grant that matters is theirs,
    /// checked there, on the object itself.
    pub async fn waiting(&self, org: &str) -> Result<Vec<Request>> {
        let rows = sqlx::query(
            "SELECT * FROM deletion_requests
             WHERE org_id = $1 AND state = 'pending'
             ORDER BY asked_at DESC",
        )
        .bind(org)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(read).collect())
    }

    pub async fn one(&self, org: &str, id: &str) -> Result<Option<Request>> {
        let row = sqlx::query("SELECT * FROM deletion_requests WHERE org_id = $1 AND id = $2")
            .bind(org)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.as_ref().map(read))
    }

    /// Mark one answered. `state` is `done` or `refused`.
    ///
    /// Only moves a row that is still pending, so two people pressing at once
    /// settle it once — the second gets `Ok(false)` and the caller says the
    /// question has already been answered rather than deleting twice.
    pub async fn decide(
        &self,
        id: &str,
        state: &str,
        by: &str,
        note: Option<&str>,
    ) -> Result<bool> {
        let done = sqlx::query(
            "UPDATE deletion_requests
                SET state = $2, decided_by = $3, decided_at = now(), note = $4
              WHERE id = $1 AND state = 'pending'",
        )
        .bind(id)
        .bind(state)
        .bind(by)
        .bind(note)
        .execute(&self.pool)
        .await?;
        Ok(done.rows_affected() == 1)
    }
}
