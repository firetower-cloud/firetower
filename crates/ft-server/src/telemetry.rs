//! Opt-out telemetry: what leaves an install, and what cannot.
//!
//! ## The shape, and why it is this one
//!
//! The control plane does not call out. It computes one digest per completed
//! UTC day into `telemetry_digests`, and a desktop app collects it and posts it
//! to the hosted backend. The server is the thing that knows the numbers; the
//! laptop is the thing that can reach the internet.
//!
//! Three properties follow, and each of them is the reason for a decision
//! somewhere below:
//!
//! * **No egress is required here.** Nothing in a request path makes a network
//!   call. An install behind a firewall reports exactly as well as one that is
//!   not.
//! * **A multi-seat organisation is counted once.** The digest is computed once
//!   and the first client to collect it acks it. Twelve teammates with the app
//!   open deliver one digest between them.
//! * **Backfill is free.** A fortnight offline delivers a fortnight of digests
//!   when somebody opens the app, and the gateway's `(install_id, day)` key
//!   makes a replay an upsert rather than a double count.
//!
//! ## Counts, never records about people
//!
//! There is no per-person row in the payload and no hashed user identifier
//! either. `active_today`, `active_7d` and `active_28d` are counts, and
//! `active_days_28d` is a histogram — which together distinguish seven people
//! who use Firetower daily from a rotating cast of eleven who each appear once,
//! without recording anything about any individual.
//!
//! That is a deliberate ceiling. It gives up seat-level cohort retention, and
//! keeps "we send daily counts, not records about people" true — a sentence
//! worth more to a self-hosted product than the metric it costs.
//!
//! The payload is a whitelist, assembled field by field. It must stay one:
//! `consumption_events` sits next to `repo_remote`, `branch`, `session_title`,
//! `task_key` and `account_name`, which are the most sensitive strings in the
//! product. `payload_carries_no_identity` in the tests below reads the real
//! document and fails on any key that looks like one of them.
//!
//! ## Why everything is measured from `consumption_events`
//!
//! Because it is the only durable record of who did what.
//!
//! `reclaim::sweep` runs every sixty seconds and deletes any workspace whose
//! sessions have all ended, cascading to the sessions themselves. So by the
//! time a digest for yesterday is computed, most of yesterday's workspaces and
//! sessions are gone — counting `workspaces.created_at` would report a small
//! fraction of the truth and get smaller the more the fleet is used.
//!
//! `consumption_events` was built to outlive exactly that: "the question this
//! table answers is asked *after* the work is finished and the worktree is
//! gone." One row per turn per model, with the workspace, session, person and
//! agent copied in rather than joined.
//!
//! The consequence is in the field names. **`workspaces_active`, not
//! `workspaces_created`**: a workspace that was cut and abandoned without an
//! agent ever taking a turn in it is not counted, because nothing durable
//! records that it existed. The same for `sessions_active` and `tasks_worked`.
//! Naming them `*_created` would have been a lie that a dashboard repeats for
//! years.
//!
//! ## What a day means
//!
//! A completed UTC day, and only a completed one. Window bounds are computed in
//! Rust and passed as parameters so no query depends on the database session's
//! `TimeZone`; the one place a date is derived in SQL says `at time zone 'UTC'`
//! explicitly.

use crate::accounts::Accounts;
use crate::db::Db;
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use sqlx::postgres::PgPool;
use sqlx::Row;
use std::collections::BTreeMap;
use utoipa::ToSchema;

/// Bumped only when a field already here changes meaning.
///
/// Additive changes do not move it: the gateway accepts unknown fields and
/// keeps the whole document, so a newer control plane talking to an older
/// gateway loses nothing. Only a change an old reader would get *wrong* —
/// rather than merely miss — earns a bump.
pub const SCHEMA_VERSION: u32 = 1;

/// How long an undelivered digest is kept.
///
/// Thirty days of nobody opening the app is an install that has stopped being
/// used, and the gateway refuses anything older than thirty-five — so a digest
/// held past this is one that would be rejected on arrival.
pub const KEEP_UNDELIVERED_DAYS: i64 = 30;

/// Where a digest goes.
///
/// Held here rather than compiled into the desktop app, and handed to the
/// courier with the digests themselves. Three reasons, in order of how much
/// they matter:
///
/// * **One source of truth.** The client is a courier; deciding the address is
///   not its job, and a hostname duplicated into a shipped binary is one that
///   cannot be corrected for anybody who has not updated.
/// * **`/telemetry/preview` can say where, not only what.** A preview that
///   showed the bytes but not the destination answers half the question an
///   administrator is actually asking.
/// * **It can be pointed somewhere else.** An organisation that wants its own
///   collector, or none, sets the environment variable — the same escape hatch
///   `FIRETOWER_UPDATE_FEED` already gives for the releases feed.
///
/// Not a secret and not authenticated: the endpoint is unauthenticated by
/// necessity, because a key shipped inside an AGPL build is readable by anyone
/// who downloads it.
pub const ENDPOINT_ENV: &str = "FIRETOWER_TELEMETRY_ENDPOINT";

const DEFAULT_ENDPOINT: &str = "https://telemetry.usefiretower.com/v1/digests";

pub fn endpoint() -> String {
    chosen_endpoint(std::env::var(ENDPOINT_ENV).ok())
}

/// The choice, apart from where the environment is read.
///
/// Split out so it can be tested without `set_var`, which is process-global
/// and would race every other test running beside it.
fn chosen_endpoint(from_env: Option<String>) -> String {
    from_env
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
}

/// Install-wide settings, in the existing `settings` table.
pub mod keys {
    /// `"false"` disables collection. Absent means enabled — this is opt-out,
    /// and absent is the state of every install that has never been told
    /// otherwise.
    pub const ENABLED: &str = "telemetry.enabled";
    /// Minted once, never leaves. What makes `install_id` unlinkable to the
    /// organisation id it is derived from.
    pub const SALT: &str = "telemetry.salt";
    /// The last desktop version seen collecting a digest.
    pub const COURIER: &str = "telemetry.courier";
}

// ── the payload ─────────────────────────────────────────────────────────────
//
// Deliberately **not** `rename_all = "camelCase"`, unlike every other type in
// this crate's API. These are not Firetower's API shape; they are the wire
// contract with the backend, which is snake_case, and
// `fixtures/digest-v1.json` — committed identically in both repositories — is
// what holds the two halves together. A rename here silently breaks that.

/// What one install did on one day.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Digest {
    pub schema_version: u32,
    /// `sha256(org_id || "|" || salt)`, hex.
    pub install_id: String,
    pub day: NaiveDate,
    /// How old the install was that day.
    ///
    /// Rather than a creation timestamp, and rather than the organisation id it
    /// would otherwise be read from: ids here are ULIDs, which embed the
    /// moment they were minted. This says the cohort deliberately instead of
    /// leaking it.
    pub install_age_days: Option<i64>,
    pub generated_at: DateTime<Utc>,
    pub versions: Versions,
    pub people: People,
    pub activity: Activity,
    pub hosts: Hosts,
}

/// Which versions are running — the distribution this exists to measure.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Versions {
    pub control_plane: Option<String>,
    /// The last desktop version seen collecting a digest.
    ///
    /// Read from settings rather than filled in by the client on its way past,
    /// so that `/telemetry/preview` shows the whole document. A preview that
    /// omitted a field the client would add is not a preview.
    pub courier_desktop: Option<String>,
    pub workers: Vec<WorkerVersion>,
}

/// How many hosts run a given worker build.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct WorkerVersion {
    pub version: String,
    pub hosts: i64,
}

/// Counts of people. No identifiers, hashed or otherwise.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct People {
    /// Accounts that exist and are not disabled — seats, in effect.
    ///
    /// As at the end of the day being reported, by `created_at`, so a backfill
    /// does not report today's headcount against a day three weeks ago.
    /// Somebody offboarded since is missing, because offboarding deletes the
    /// row; the principal survives but carries no seat.
    pub registered: Option<i64>,
    pub active_today: Option<i64>,
    pub active_7d: Option<i64>,
    pub active_28d: Option<i64>,
    pub teams: Option<i64>,
    /// How many of the last 28 days each active person appeared on, bucketed.
    ///
    /// Sums to `active_28d`. The field that distinguishes a daily habit from a
    /// rotating cast, without a row per person: `{"1-3": 4}` is four people who
    /// turned up once or twice and drifted.
    pub active_days_28d: BTreeMap<String, i64>,
}

/// What was done that day.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Activity {
    /// Workspaces an agent took at least one turn in. See the module comment
    /// for why this is not `workspaces_created`.
    pub workspaces_active: Option<i64>,
    pub sessions_active: Option<i64>,
    /// Keyed by agent kind — `claude-code`, `codex`, whatever is added next.
    pub sessions_by_agent: BTreeMap<String, i64>,
    /// Distinct tracker issues worked on. The count only; the keys themselves
    /// never leave.
    pub tasks_worked: Option<i64>,
    /// Keyed by tracker — `github`, `linear`.
    pub task_providers: BTreeMap<String, i64>,
}

/// How much compute the organisation runs.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Hosts {
    pub count: Option<i64>,
}

// ── identity ────────────────────────────────────────────────────────────────

/// The install's stable, opaque id.
///
/// `sha256(org_id || "|" || salt)`. The salt is random, minted once, and never
/// sent, which buys two things: the backend cannot recover the organisation id
/// from it, and the id carries none of the creation timestamp that the ULID it
/// is derived from would have leaked.
///
/// Stable forever, because the salt is stored. That is the point — a new id
/// every day would make every install look new every day and no retention
/// question would have an answer.
pub fn install_id(org_id: &str, salt: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{org_id}|{salt}").as_bytes())
    )
}

/// The install's salt, minting one the first time it is asked for.
pub async fn salt(accounts: &Accounts) -> Result<String> {
    if let Some(existing) = accounts.setting(keys::SALT).await? {
        if !existing.trim().is_empty() {
            return Ok(existing);
        }
    }
    // Two ULIDs rather than a random-bytes dependency this crate does not
    // otherwise have. Each carries 80 bits from the platform's generator, and
    // hashing them together gives a value that is uniform, opaque and the same
    // shape as everything else here.
    let seed = format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new());
    let minted = format!("{:x}", Sha256::digest(seed.as_bytes()));
    accounts.set_setting(keys::SALT, &minted).await?;
    Ok(minted)
}

/// Whether this install collects telemetry.
///
/// Absent means yes. It is opt-out, and an install that has never been told
/// otherwise has no row.
pub async fn enabled(accounts: &Accounts) -> Result<bool> {
    Ok(accounts
        .setting(keys::ENABLED)
        .await?
        .map(|v| v.trim() != "false")
        .unwrap_or(true))
}

pub async fn set_enabled(accounts: &Accounts, on: bool) -> Result<()> {
    accounts
        .set_setting(keys::ENABLED, if on { "true" } else { "false" })
        .await
}

/// Throw away everything not yet sent.
///
/// Called when somebody turns collection off. Without it, switching off would
/// stop *new* digests while the ones already computed went out on the next
/// client to connect — which is not what anybody means by off, and is the one
/// behaviour that would make the setting a lie.
pub async fn discard_undelivered(db: &Db) -> Result<u64> {
    let done = sqlx::query("DELETE FROM telemetry_digests WHERE delivered_at IS NULL")
        .execute(db.pool())
        .await
        .context("discarding undelivered digests")?;
    Ok(done.rows_affected())
}

/// Remember which desktop version last collected a digest.
///
/// Written only when it changes. Every collection passes its version, so an
/// unconditional upsert is one write per poll per desktop — for a value that
/// moves when somebody updates the app, which is to say almost never. A read
/// on the common path instead of a write is what lets the courier's interval be
/// shortened without the server paying for it.
pub async fn note_courier(accounts: &Accounts, version: &str) -> Result<()> {
    let version = version.trim();
    if version.is_empty() || version.len() > 64 {
        return Ok(());
    }
    if accounts.setting(keys::COURIER).await?.as_deref() == Some(version) {
        return Ok(());
    }
    accounts.set_setting(keys::COURIER, version).await
}

// ── building one ────────────────────────────────────────────────────────────

/// The histogram's buckets, in order.
///
/// Zero-padded so they sort into reading order rather than lexicographic
/// nonsense — `"11-28"` sorts before `"4-10"` and a reader would be entitled to
/// conclude the data was wrong. All three are always present, zeros included,
/// so the shape does not change with the data and `sum == active_28d` holds
/// without a special case for an install nobody used.
const BUCKETS: [(&str, i64, i64); 3] = [("01-03", 1, 3), ("04-10", 4, 10), ("11-28", 11, 28)];

/// Which organisation this install is, and when it started.
async fn installed(pool: &PgPool) -> Result<Option<(String, DateTime<Utc>)>> {
    let row = sqlx::query(
        "SELECT o.id, o.created_at
           FROM installation i
           JOIN organizations o ON o.id = i.org_id",
    )
    .fetch_optional(pool)
    .await
    .context("reading the installation")?;

    Ok(row.map(|r| (r.get::<String, _>("id"), r.get("created_at"))))
}

/// Build the digest for one completed UTC day.
///
/// Reads only. Nothing here writes, sends or decides whether to — see
/// `enabled` for that, which the caller checks.
pub async fn build(db: &Db, accounts: &Accounts, day: NaiveDate) -> Result<Digest> {
    let pool = db.pool();

    let (org_id, org_created) = installed(pool)
        .await?
        .context("this install has no organisation yet")?;

    let salt = salt(accounts).await?;

    // Bounds in Rust, passed as parameters, so no query depends on the
    // database session's TimeZone.
    let start = day
        .and_hms_opt(0, 0, 0)
        .context("a day that has no midnight")?
        .and_utc();
    let end = start + Duration::days(1);
    let week = end - Duration::days(7);
    let month = end - Duration::days(28);

    let (workspaces_active, sessions_active, tasks_worked) =
        activity(pool, &org_id, start, end).await?;

    Ok(Digest {
        schema_version: SCHEMA_VERSION,
        install_id: install_id(&org_id, &salt),
        day,
        // Whole days between the organisation being created and the day being
        // reported. Negative is impossible for a real day and clamped anyway,
        // because a clock that went backwards should not produce a cohort in
        // the future.
        install_age_days: Some((start - org_created).num_days().max(0)),
        generated_at: Utc::now(),
        versions: Versions {
            control_plane: Some(env!("CARGO_PKG_VERSION").to_string()),
            courier_desktop: accounts.setting(keys::COURIER).await?,
            workers: worker_versions(pool, &org_id).await?,
        },
        people: People {
            registered: Some(registered(pool, &org_id, end).await?),
            active_today: Some(active_people(pool, &org_id, start, end).await?),
            active_7d: Some(active_people(pool, &org_id, week, end).await?),
            active_28d: Some(active_people(pool, &org_id, month, end).await?),
            teams: Some(teams(pool, &org_id).await?),
            active_days_28d: active_days(pool, &org_id, month, end).await?,
        },
        activity: Activity {
            workspaces_active: Some(workspaces_active),
            sessions_active: Some(sessions_active),
            sessions_by_agent: sessions_by_agent(pool, &org_id, start, end).await?,
            tasks_worked: Some(tasks_worked),
            task_providers: task_providers(pool, &org_id, start, end).await?,
        },
        hosts: Hosts {
            count: Some(hosts_count(pool, &org_id, end).await?),
        },
    })
}

/// How many people did something in a window.
///
/// "Something" is a completed agent turn, which is what `consumption_events`
/// records. Somebody who read a conversation and ran nothing is not counted —
/// deliberately, because for a product whose purpose is running agents that is
/// the more honest reading of "used it", and because it is the only definition
/// that survives `reclaim`.
async fn active_people(
    pool: &PgPool,
    org: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(DISTINCT ran_as)
           FROM consumption_events
          WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3
            AND ran_as IS NOT NULL",
    )
    .bind(org)
    .bind(from)
    .bind(to)
    .fetch_one(pool)
    .await
    .context("counting active people")
}

/// The frequency histogram: how many days each active person appeared on.
async fn active_days(
    pool: &PgPool,
    org: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<BTreeMap<String, i64>> {
    // `at time zone 'UTC'` stated rather than left to `::date`, which would
    // use the session's zone and silently bucket by whatever the database
    // happens to be set to.
    let rows = sqlx::query(
        "SELECT days, count(*) AS people
           FROM (
                SELECT ran_as,
                       count(DISTINCT (occurred_at AT TIME ZONE 'UTC')::date) AS days
                  FROM consumption_events
                 WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3
                   AND ran_as IS NOT NULL
                 GROUP BY ran_as
           ) per_person
          GROUP BY days",
    )
    .bind(org)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
    .context("counting how often people appeared")?;

    let mut out: BTreeMap<String, i64> = BUCKETS
        .iter()
        .map(|(label, _, _)| ((*label).to_string(), 0))
        .collect();

    for row in rows {
        let days: i64 = row.get("days");
        let people: i64 = row.get("people");
        if let Some((label, _, _)) = BUCKETS
            .iter()
            .find(|(_, lo, hi)| days >= *lo && days <= *hi)
        {
            *out.entry((*label).to_string()).or_default() += people;
        }
    }
    Ok(out)
}

/// Seats, as at the end of the day being reported.
async fn registered(pool: &PgPool, org: &str, as_of: DateTime<Utc>) -> Result<i64> {
    sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM users
          WHERE org_id = $1 AND NOT disabled AND created_at < $2",
    )
    .bind(org)
    .bind(as_of)
    .fetch_one(pool)
    .await
    .context("counting seats")
}

/// Teams. Point-in-time: the table carries no `created_at` to read a day from.
async fn teams(pool: &PgPool, org: &str) -> Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM teams WHERE org_id = $1")
        .bind(org)
        .fetch_one(pool)
        .await
        .context("counting teams")
}

/// Workspaces, sessions and tracker issues worked in a window.
///
/// One query for three counts, because they are three `count(DISTINCT …)` over
/// exactly the same rows and the index is already open.
async fn activity(
    pool: &PgPool,
    org: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<(i64, i64, i64)> {
    let row = sqlx::query(
        "SELECT count(DISTINCT workspace_id) AS workspaces,
                count(DISTINCT session_id)   AS sessions,
                count(DISTINCT task_key)     AS tasks
           FROM consumption_events
          WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3",
    )
    .bind(org)
    .bind(from)
    .bind(to)
    .fetch_one(pool)
    .await
    .context("counting activity")?;

    Ok((row.get("workspaces"), row.get("sessions"), row.get("tasks")))
}

/// Which agents were actually used, by sessions rather than turns — a long
/// conversation is one session's worth of adoption, not two hundred.
async fn sessions_by_agent(
    pool: &PgPool,
    org: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<BTreeMap<String, i64>> {
    let rows = sqlx::query(
        "SELECT agent, count(DISTINCT session_id) AS n
           FROM consumption_events
          WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3
          GROUP BY agent",
    )
    .bind(org)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
    .context("counting sessions by agent")?;

    Ok(rows
        .into_iter()
        .map(|r| (r.get::<String, _>("agent"), r.get::<i64, _>("n")))
        .collect())
}

/// Which trackers are in use. The provider, never the key.
async fn task_providers(
    pool: &PgPool,
    org: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<BTreeMap<String, i64>> {
    let rows = sqlx::query(
        "SELECT task_provider, count(DISTINCT task_key) AS n
           FROM consumption_events
          WHERE org_id = $1 AND occurred_at >= $2 AND occurred_at < $3
            AND task_provider IS NOT NULL
          GROUP BY task_provider",
    )
    .bind(org)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
    .context("counting tasks by tracker")?;

    Ok(rows
        .into_iter()
        .map(|r| (r.get::<String, _>("task_provider"), r.get::<i64, _>("n")))
        .collect())
}

async fn hosts_count(pool: &PgPool, org: &str, as_of: DateTime<Utc>) -> Result<i64> {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM hosts WHERE org_id = $1 AND created_at < $2")
        .bind(org)
        .bind(as_of)
        .fetch_one(pool)
        .await
        .context("counting hosts")
}

/// Worker builds across the fleet. Point-in-time, which is the only thing a
/// version distribution can be.
async fn worker_versions(pool: &PgPool, org: &str) -> Result<Vec<WorkerVersion>> {
    let rows = sqlx::query(
        "SELECT worker_version, count(*) AS n
           FROM hosts
          WHERE org_id = $1 AND worker_version IS NOT NULL
          GROUP BY worker_version
          ORDER BY worker_version DESC",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .context("counting worker versions")?;

    Ok(rows
        .into_iter()
        .map(|r| WorkerVersion {
            version: r.get::<String, _>("worker_version"),
            hosts: r.get::<i64, _>("n"),
        })
        .collect())
}

// ── the outbox ──────────────────────────────────────────────────────────────

/// A digest still owed, as the client will send it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub day: NaiveDate,
    /// The bytes to post, verbatim.
    ///
    /// Opaque to the client on purpose. It is a courier: it carries the
    /// envelope and does not open it, which is what keeps the whole payload
    /// this server's to decide and `/telemetry/preview` honest about it.
    #[schema(value_type = Object)]
    pub payload: serde_json::Value,
}

/// Write a digest into the outbox, replacing any already held for that day.
///
/// Replacing rather than skipping, because recomputing is how a release that
/// adds a metric backfills: the day is the key, so the newer document wins and
/// `delivered_at` is cleared so it goes again.
pub async fn record(db: &Db, digest: &Digest) -> Result<()> {
    let payload = serde_json::to_value(digest).context("serialising a digest")?;
    sqlx::query(
        "INSERT INTO telemetry_digests (day, payload)
         VALUES ($1, $2)
         ON CONFLICT (day) DO UPDATE
            SET payload = excluded.payload,
                computed_at = now(),
                delivered_at = NULL",
    )
    .bind(digest.day)
    .bind(&payload)
    .execute(db.pool())
    .await
    .context("recording a digest")?;
    Ok(())
}

/// What is still owed, **newest first**.
///
/// Newest rather than oldest, because the order is what a truncated round
/// delivers. A courier sends until something fails transiently and then stops,
/// and a batch is bounded — so whichever end of the window leads is the end
/// that gets through. Yesterday is the day every question on the dashboard is
/// about, and a month of backfill ahead of it means the one number anybody
/// reads arrives last, or on a bad week not at all.
///
/// The backlog therefore drains from the front, and what stays owed is a
/// contiguous run of the oldest days — the same property the old ordering had,
/// pointing the other way, and the reason nothing is left with holes in it.
///
/// Delivery order is not otherwise meaningful: the gateway keys on
/// `(install_id, day)`, so days arriving out of order is an upsert each time
/// and not a sequence it has to reassemble.
pub async fn undelivered(db: &Db, limit: i64) -> Result<Vec<Pending>> {
    let rows = sqlx::query(
        "SELECT day, payload FROM telemetry_digests
          WHERE delivered_at IS NULL
          ORDER BY day DESC
          LIMIT $1",
    )
    .bind(limit.clamp(1, 60))
    .fetch_all(db.pool())
    .await
    .context("listing undelivered digests")?;

    Ok(rows
        .into_iter()
        .map(|r| Pending {
            day: r.get("day"),
            payload: r.get("payload"),
        })
        .collect())
}

/// Mark days as delivered.
///
/// Idempotent, and deliberately not an error when a day is already marked:
/// two clients racing is a thing that happens, and the second one losing is
/// not a failure anybody should see.
pub async fn mark_delivered(db: &Db, days: &[NaiveDate]) -> Result<u64> {
    if days.is_empty() {
        return Ok(0);
    }
    let done = sqlx::query(
        "UPDATE telemetry_digests SET delivered_at = now()
          WHERE day = ANY($1) AND delivered_at IS NULL",
    )
    .bind(days)
    .execute(db.pool())
    .await
    .context("marking digests delivered")?;
    Ok(done.rows_affected())
}

/// Which completed days have no digest yet.
///
/// Days are generated here rather than in SQL so that "a completed UTC day" is
/// decided in one place, by the same clock that built the bounds. Bounded by
/// the keep window: a digest older than that would be refused by the gateway
/// on arrival, so computing one is work nobody can use.
pub async fn days_to_compute(db: &Db, today: NaiveDate) -> Result<Vec<NaiveDate>> {
    let oldest = today - Duration::days(KEEP_UNDELIVERED_DAYS);
    let have: Vec<NaiveDate> =
        sqlx::query_scalar("SELECT day FROM telemetry_digests WHERE day >= $1")
            .bind(oldest)
            .fetch_all(db.pool())
            .await
            .context("reading which days are already computed")?;

    // Yesterday backwards. Today is deliberately absent: a digest describes a
    // day that has finished, and one built at noon would have to be rebuilt at
    // midnight and would disagree with itself in between.
    Ok((1..=KEEP_UNDELIVERED_DAYS)
        .map(|back| today - Duration::days(back))
        .filter(|day| !have.contains(day))
        .collect())
}

/// Drop what is no longer worth keeping: anything too old for the gateway to
/// accept, and nothing else.
///
/// ## Why a delivered row is kept rather than dropped
///
/// It is the record of what has already been sent, and `days_to_compute` reads
/// it as exactly that: a day is due when there is no row for it. Deleting a row
/// because it was delivered therefore erases the memory of having delivered it,
/// and the next sweep rebuilds the day and owes it again — `record` clears
/// `delivered_at` on conflict, so the rebuild arrives undelivered.
///
/// That loop is not harmless. `/telemetry/pending` serves a bounded batch, so a
/// window that regenerates itself keeps refilling the queue ahead of the newest
/// day, and it refilled faster than any courier drained it. The most recent
/// day, which is the only one anybody looks at, is starved behind a backlog
/// that never empties.
///
/// So age is the only reason to delete. A row costs a few hundred bytes and the
/// window holds thirty of them; the correctness of "which days are done" is
/// worth more than the thirty rows.
pub async fn prune(db: &Db, today: NaiveDate) -> Result<u64> {
    let done = sqlx::query("DELETE FROM telemetry_digests WHERE day < $1")
        .bind(today - Duration::days(KEEP_UNDELIVERED_DAYS))
        .execute(db.pool())
        .await
        .context("pruning digests")?;
    Ok(done.rows_affected())
}

// ── the daily job ───────────────────────────────────────────────────────────

/// How often to look for a day that needs a digest.
///
/// Hourly, not daily. A control plane is restarted, redeployed and occasionally
/// off overnight, so "run at midnight" is a schedule that quietly skips days.
/// Asking every hour whether anything is missing converges on the same answer
/// and survives being switched off for a week.
const SWEEP: std::time::Duration = std::time::Duration::from_secs(3600);

/// Compute whatever days are missing, prune what is spent.
///
/// Returns how many digests were written, so the caller can say something
/// useful in a log line rather than running silently.
pub async fn sweep(db: &Db, accounts: &Accounts, today: NaiveDate) -> Result<usize> {
    if !enabled(accounts).await? {
        // Not merely "do not compute": anything already computed and not yet
        // collected goes, because off has to mean off.
        let dropped = discard_undelivered(db).await?;
        if dropped > 0 {
            tracing::info!("telemetry is off; discarded {dropped} undelivered digest(s)");
        }
        return Ok(0);
    }

    // Nothing to report until somebody has named the organisation. Before that
    // the install is mid-setup and `installed` has no row to read.
    if installed(db.pool()).await?.is_none() {
        return Ok(0);
    }

    let mut wrote = 0;
    for day in days_to_compute(db, today).await? {
        let digest = build(db, accounts, day).await?;
        record(db, &digest).await?;
        wrote += 1;
    }

    prune(db, today).await?;
    Ok(wrote)
}

/// The loop. Spawned at start-up.
pub async fn watch(state: crate::AppState) {
    let (db, accounts) = (state.db.clone(), state.accounts.clone());
    // Not immediately. Start-up has migrations, a fleet reconnecting and a
    // setup wizard possibly still unanswered; a sweep racing that is reading a
    // database that is still settling.
    tokio::time::sleep(std::time::Duration::from_secs(45)).await;
    loop {
        match sweep(&db, &accounts, Utc::now().date_naive()).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("computed {n} telemetry digest(s)"),
            // A warning, never a failure that stops anything. Telemetry is the
            // least important thing this process does, and an install whose
            // digests cannot be built should keep running agents.
            Err(e) => tracing::warn!("computing telemetry digests: {e:#}"),
        }
        tokio::time::sleep(SWEEP).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A turn to seed. Everything a `consumption_events` row needs that a test
    /// might want to vary; the rest is filled in below.
    struct Turn<'a> {
        day: NaiveDate,
        who: &'a str,
        workspace: &'a str,
        session: &'a str,
        turn: &'a str,
        agent: &'a str,
        task: Option<(&'a str, &'a str)>,
    }

    async fn harness() -> (Db, Accounts, String, String) {
        let (db, who) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let (org, _) = installed(db.pool()).await.unwrap().unwrap();

        // The organisation and its administrator are backdated well before
        // `DAY`, because the harness creates them *now* and the days these
        // tests report on are in the fixture's past. Without this the data is
        // incoherent — turns running before the person who ran them existed —
        // and `registered`, which asks who had a seat as at the end of the day,
        // correctly answers nobody.
        for (table, col) in [("organizations", "id"), ("users", "id")] {
            sqlx::query(&format!(
                "UPDATE {table} SET created_at = $1 WHERE {col} = $2"
            ))
            .bind(DAY.and_hms_opt(0, 0, 0).unwrap().and_utc() - Duration::days(90))
            .bind(if table == "organizations" { &org } else { &who })
            .execute(db.pool())
            .await
            .unwrap();
        }

        (db, accounts, org, who)
    }

    /// A host, so the fleet has a worker version to report.
    async fn seed_host(db: &Db, org: &str, name: &str, worker_version: &str) {
        sqlx::query(
            "INSERT INTO hosts (id, org_id, name, state, worker_version, compute, path)
             VALUES ($1, $2, $3, 'ready', $4, '{}'::jsonb, 'd.compute'::ltree)",
        )
        .bind(format!("h_{name}"))
        .bind(org)
        .bind(name)
        .bind(worker_version)
        .execute(db.pool())
        .await
        .unwrap();
    }

    /// Written straight to the table rather than through `record_consumption`,
    /// because the whole point of these tests is which *day* a row falls on and
    /// that path stamps `now()`.
    async fn seed(db: &Db, org: &str, t: Turn<'_>) {
        sqlx::query(
            "INSERT INTO consumption_events
               (org_id, occurred_at, path, ran_as, workspace_id, session_id, turn_id,
                task_key, task_provider, agent, model, input_tokens, output_tokens)
             VALUES ($1, $2, 'u.admin'::ltree, $3, $4, $5, $6, $7, $8, $9, 'a-model', 10, 1)",
        )
        .bind(org)
        .bind(t.day.and_hms_opt(12, 0, 0).unwrap().and_utc())
        .bind(t.who)
        .bind(t.workspace)
        .bind(t.session)
        .bind(t.turn)
        .bind(t.task.map(|(k, _)| k))
        .bind(t.task.map(|(_, p)| p))
        .bind(t.agent)
        .execute(db.pool())
        .await
        .unwrap();
    }

    const DAY: NaiveDate = match NaiveDate::from_ymd_opt(2026, 10, 14) {
        Some(d) => d,
        None => panic!("a real date"),
    };

    #[test]
    fn install_id_is_stable_and_hides_the_organisation() {
        let id = install_id("o_01k7abc", "pepper");
        assert_eq!(
            id,
            install_id("o_01k7abc", "pepper"),
            "stable, or retention is impossible"
        );
        assert_eq!(id.len(), 64);
        assert!(id
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));

        // The gateway validates lowercase hex and would reject anything else.
        assert_ne!(
            id,
            install_id("o_01k7abc", "other-pepper"),
            "the salt has to matter"
        );
        assert_ne!(id, install_id("o_01k7xyz", "pepper"));

        // The point of the salt: the organisation id is not recoverable from,
        // or visible in, what leaves.
        assert!(!id.contains("o_01k7abc"));
    }

    #[tokio::test]
    async fn the_salt_is_minted_once_and_then_kept() {
        let (_db, accounts, _org, _who) = harness().await;
        let first = salt(&accounts).await.unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(
            first,
            salt(&accounts).await.unwrap(),
            "a new salt each call would make every install look new"
        );
    }

    #[tokio::test]
    async fn telemetry_is_on_until_somebody_turns_it_off() {
        let (_db, accounts, _org, _who) = harness().await;
        assert!(
            enabled(&accounts).await.unwrap(),
            "opt-out: absent means on"
        );

        set_enabled(&accounts, false).await.unwrap();
        assert!(!enabled(&accounts).await.unwrap());

        set_enabled(&accounts, true).await.unwrap();
        assert!(enabled(&accounts).await.unwrap());
    }

    #[tokio::test]
    async fn a_digest_counts_only_its_own_day() {
        let (db, accounts, org, who) = harness().await;

        // Two turns on the day, in one workspace, across two sessions and two
        // agents. One turn the day before, which must not appear in the
        // day's counts but must appear in the 7- and 28-day windows.
        for (session, agent, turn) in [("s_a", "claude-code", "t1"), ("s_b", "codex", "t2")] {
            seed(
                &db,
                &org,
                Turn {
                    day: DAY,
                    who: &who,
                    workspace: "w_1",
                    session,
                    turn,
                    agent,
                    task: Some(("github:acme/web#1", "github")),
                },
            )
            .await;
        }
        seed(
            &db,
            &org,
            Turn {
                day: DAY - Duration::days(1),
                who: &who,
                workspace: "w_0",
                session: "s_z",
                turn: "t0",
                agent: "claude-code",
                task: None,
            },
        )
        .await;

        let d = build(&db, &accounts, DAY).await.unwrap();

        assert_eq!(d.day, DAY);
        assert_eq!(d.schema_version, SCHEMA_VERSION);
        assert_eq!(d.activity.workspaces_active, Some(1), "w_0 is yesterday's");
        assert_eq!(d.activity.sessions_active, Some(2));
        assert_eq!(d.activity.sessions_by_agent.get("claude-code"), Some(&1));
        assert_eq!(d.activity.sessions_by_agent.get("codex"), Some(&1));
        assert_eq!(d.activity.tasks_worked, Some(1));
        assert_eq!(d.activity.task_providers.get("github"), Some(&1));

        assert_eq!(
            d.people.active_today,
            Some(1),
            "one person, however many turns"
        );
        assert_eq!(d.people.active_28d, Some(1));
        assert_eq!(d.people.registered, Some(1));

        // Yesterday's turn is inside the 28-day window, so the person appears
        // on two days of it.
        assert_eq!(d.people.active_days_28d.get("01-03"), Some(&1));
        assert_eq!(d.people.active_days_28d.get("04-10"), Some(&0));
    }

    #[tokio::test]
    async fn the_histogram_accounts_for_everybody_active() {
        let (db, accounts, org, who) = harness().await;
        for back in 0..5 {
            seed(
                &db,
                &org,
                Turn {
                    day: DAY - Duration::days(back),
                    who: &who,
                    workspace: "w_1",
                    session: "s_a",
                    turn: &format!("t{back}"),
                    agent: "claude-code",
                    task: None,
                },
            )
            .await;
        }

        let d = build(&db, &accounts, DAY).await.unwrap();
        let bucketed: i64 = d.people.active_days_28d.values().sum();

        assert_eq!(
            Some(bucketed),
            d.people.active_28d,
            "a histogram that loses people is not one"
        );
        assert_eq!(
            d.people.active_days_28d.get("04-10"),
            Some(&1),
            "five days running"
        );
        assert_eq!(d.people.active_days_28d.get("01-03"), Some(&0));
    }

    /// The guardrail.
    ///
    /// Telemetry is defensible only while it carries counts and never records
    /// about people or their work. This walks the real document and fails on
    /// any key that looks like identity.
    ///
    /// Matched as substrings, which is the point: nobody adding identity to a
    /// payload names the field `user`. An earlier version of this test in the
    /// backend repository compared whole keys, and let `active_user_ids`
    /// through while catching `repo`.
    #[tokio::test]
    async fn payload_carries_no_identity() {
        let (db, accounts, org, who) = harness().await;
        seed(
            &db,
            &org,
            Turn {
                day: DAY,
                who: &who,
                workspace: "w_1",
                session: "s_a",
                turn: "t1",
                agent: "claude-code",
                task: Some(("github:acme/web#1", "github")),
            },
        )
        .await;

        let d = build(&db, &accounts, DAY).await.unwrap();
        let v = serde_json::to_value(&d).unwrap();

        const FORBIDDEN: &[&str] = &[
            "user",
            "email",
            "person",
            "people_ids",
            "member",
            "repo",
            "remote",
            "branch",
            "commit",
            "worktree",
            "prompt",
            "title",
            "note",
            "message",
            "body",
            "secret",
            "token",
            "password",
            "credential",
            "account",
            "model",
            "slug",
            "path",
            "name",
            "url",
            "org_id",
            "organization",
            "task_key",
            "task_url",
            "session_id",
            "workspace_id",
            "host_id",
            "hostname",
        ];
        // Too short to match inside words — `description` contains one, and
        // `install_id` the other — so these are whole-key only.
        const FORBIDDEN_EXACT: &[&str] = &["ip", "id", "ids", "who", "by"];
        /// The one identifier the digest carries: a salted hash with nothing on
        /// the receiving side to reverse it with.
        const ALLOWED: &[&str] = &["install_id"];

        fn walk(v: &serde_json::Value, at: &str, bad: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(map) => {
                    for (k, child) in map {
                        let here = if at.is_empty() {
                            k.clone()
                        } else {
                            format!("{at}.{k}")
                        };
                        let key = k.to_ascii_lowercase();
                        let suspicious = FORBIDDEN.iter().any(|f| key.contains(f))
                            || FORBIDDEN_EXACT.contains(&key.as_str());
                        if suspicious && !ALLOWED.contains(&key.as_str()) {
                            bad.push(here.clone());
                        }
                        walk(child, &here, bad);
                    }
                }
                serde_json::Value::Array(items) => {
                    for (i, child) in items.iter().enumerate() {
                        walk(child, &format!("{at}[{i}]"), bad);
                    }
                }
                _ => {}
            }
        }

        let mut bad = Vec::new();
        walk(&v, "", &mut bad);
        assert!(
            bad.is_empty(),
            "the digest must carry counts, not records about people or their work. Found: {bad:?}"
        );

        // And the values, not only the keys: the seeded task key and agent
        // account must not appear anywhere in the document.
        let text = serde_json::to_string(&v).unwrap();
        for leak in ["github:acme/web#1", "acme/web", &who, &org] {
            assert!(!text.contains(leak), "{leak} reached the payload");
        }
    }

    /// The contract with the backend.
    ///
    /// `fixtures/digest-v1.json` is committed identically here and in the
    /// backend repository, which is deliberately not a shared crate: this is
    /// AGPL and that service is private. Two structs and one file, instead of a
    /// licence problem.
    ///
    /// Shape rather than values — the fixture's numbers are invented. What has
    /// to match is the set of keys, exactly, in both directions: a field added
    /// here that the fixture does not have is one the backend will not store,
    /// and one the fixture has that this stops producing is a column that goes
    /// quietly null.
    #[tokio::test]
    async fn the_payload_matches_the_shared_fixture() {
        let (db, accounts, org, who) = harness().await;
        seed(
            &db,
            &org,
            Turn {
                day: DAY,
                who: &who,
                workspace: "w_1",
                session: "s_a",
                turn: "t1",
                agent: "claude-code",
                task: Some(("github:acme/web#1", "github")),
            },
        )
        .await;
        // A host, so `versions.workers` is populated: an empty array has no
        // element shape, and comparing one against the fixture's would pass
        // whatever the element looked like.
        seed_host(&db, &org, "box", "0.45.0").await;

        let built = serde_json::to_value(build(&db, &accounts, DAY).await.unwrap()).unwrap();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/digest-v1.json")).unwrap();

        fn shape(v: &serde_json::Value, at: &str, out: &mut Vec<String>) {
            match v {
                serde_json::Value::Object(map) => {
                    for (k, child) in map {
                        let here = if at.is_empty() {
                            k.clone()
                        } else {
                            format!("{at}.{k}")
                        };
                        out.push(here.clone());
                        shape(child, &here, out);
                    }
                }
                // Arrays are shaped by their element, not their length, and an
                // empty one says nothing — `workers` is empty in a test with no
                // hosts, so only the first element is compared when present.
                serde_json::Value::Array(items) => {
                    if let Some(first) = items.first() {
                        shape(first, &format!("{at}[]"), out);
                    }
                }
                _ => {}
            }
        }

        let mut ours = Vec::new();
        shape(&built, "", &mut ours);
        let mut theirs = Vec::new();
        shape(&fixture, "", &mut theirs);

        // The histogram's keys are data, not shape: they are always the same
        // three buckets, and comparing them would be comparing the fixture's
        // numbers.
        let strip = |v: &mut Vec<String>| {
            v.retain(|k| !k.starts_with("people.active_days_28d."));
            v.retain(|k| !k.starts_with("activity.sessions_by_agent."));
            v.retain(|k| !k.starts_with("activity.task_providers."));
            v.sort();
            v.dedup();
        };
        strip(&mut ours);
        strip(&mut theirs);

        assert_eq!(
            ours, theirs,
            "the digest and the committed fixture have drifted apart"
        );
    }

    #[tokio::test]
    async fn recomputing_a_day_replaces_it_and_owes_it_again() {
        let (db, accounts, _org, _who) = harness().await;
        let d = build(&db, &accounts, DAY).await.unwrap();

        record(&db, &d).await.unwrap();
        record(&db, &d).await.unwrap();

        let owed = undelivered(&db, 10).await.unwrap();
        assert_eq!(
            owed.len(),
            1,
            "a day is one row, however many times it is computed"
        );

        assert_eq!(mark_delivered(&db, &[DAY]).await.unwrap(), 1);
        assert!(undelivered(&db, 10).await.unwrap().is_empty());

        // A release that adds a metric recomputes, and the day is owed again.
        record(&db, &d).await.unwrap();
        assert_eq!(undelivered(&db, 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delivering_twice_is_not_an_error() {
        let (db, accounts, _org, _who) = harness().await;
        record(&db, &build(&db, &accounts, DAY).await.unwrap())
            .await
            .unwrap();

        assert_eq!(mark_delivered(&db, &[DAY]).await.unwrap(), 1);
        assert_eq!(
            mark_delivered(&db, &[DAY]).await.unwrap(),
            0,
            "two clients racing: the loser is not a failure"
        );
    }

    #[tokio::test]
    async fn today_is_never_computed_and_old_days_are_dropped() {
        let (db, accounts, _org, _who) = harness().await;

        let due = days_to_compute(&db, DAY).await.unwrap();
        assert!(
            !due.contains(&DAY),
            "a digest describes a day that has finished"
        );
        assert_eq!(
            due.first(),
            Some(&(DAY - Duration::days(1))),
            "yesterday first"
        );
        assert_eq!(due.len() as i64, KEEP_UNDELIVERED_DAYS);

        // A computed day stops being due.
        let d = build(&db, &accounts, DAY - Duration::days(1))
            .await
            .unwrap();
        record(&db, &d).await.unwrap();
        let due = days_to_compute(&db, DAY).await.unwrap();
        assert!(!due.contains(&(DAY - Duration::days(1))));

        // And a day past the window is pruned rather than kept forever.
        let ancient = build(&db, &accounts, DAY - Duration::days(90))
            .await
            .unwrap();
        record(&db, &ancient).await.unwrap();
        assert!(prune(&db, DAY).await.unwrap() >= 1);
        let left = undelivered(&db, 60).await.unwrap();
        assert!(left
            .iter()
            .all(|p| p.day > DAY - Duration::days(KEEP_UNDELIVERED_DAYS)));
    }

    #[test]
    fn the_endpoint_can_be_pointed_elsewhere() {
        assert_eq!(chosen_endpoint(None), DEFAULT_ENDPOINT);
        // Unset and set-to-nothing are the same intent, and a trailing newline
        // from a shell is not part of a URL.
        assert_eq!(chosen_endpoint(Some("   ".into())), DEFAULT_ENDPOINT);
        assert_eq!(
            chosen_endpoint(Some("  https://collector.acme.internal/v1  \n".into())),
            "https://collector.acme.internal/v1"
        );
    }

    #[tokio::test]
    async fn a_sweep_computes_the_days_that_are_missing() {
        let (db, accounts, _org, _who) = harness().await;

        let wrote = sweep(&db, &accounts, DAY).await.unwrap();
        assert_eq!(
            wrote as i64, KEEP_UNDELIVERED_DAYS,
            "every day in the window, once"
        );

        // Idempotent: a second sweep has nothing left to do.
        assert_eq!(sweep(&db, &accounts, DAY).await.unwrap(), 0);

        let owed = undelivered(&db, 60).await.unwrap();
        assert_eq!(owed.len() as i64, KEEP_UNDELIVERED_DAYS);
        assert!(owed.iter().all(|p| p.day < DAY), "never today");
        assert!(
            owed.windows(2).all(|w| w[0].day > w[1].day),
            "newest first: whichever end leads is the end a truncated round \
             delivers, and yesterday is the day anybody is asking about"
        );
        assert_eq!(
            owed.first().map(|p| p.day),
            Some(DAY - Duration::days(1)),
            "yesterday goes out first"
        );
    }

    /// Off has to mean off, including for what was already computed.
    #[tokio::test]
    async fn turning_it_off_discards_what_was_not_yet_collected() {
        let (db, accounts, _org, _who) = harness().await;
        sweep(&db, &accounts, DAY).await.unwrap();
        assert!(!undelivered(&db, 60).await.unwrap().is_empty());

        set_enabled(&accounts, false).await.unwrap();
        let wrote = sweep(&db, &accounts, DAY).await.unwrap();

        assert_eq!(wrote, 0, "nothing new while off");
        assert!(
            undelivered(&db, 60).await.unwrap().is_empty(),
            "a digest computed before the switch must not go out after it"
        );
    }

    #[tokio::test]
    async fn discarding_leaves_what_was_already_sent() {
        let (db, accounts, _org, _who) = harness().await;
        let a = build(&db, &accounts, DAY - Duration::days(1))
            .await
            .unwrap();
        let b = build(&db, &accounts, DAY - Duration::days(2))
            .await
            .unwrap();
        record(&db, &a).await.unwrap();
        record(&db, &b).await.unwrap();
        mark_delivered(&db, &[a.day]).await.unwrap();

        assert_eq!(
            discard_undelivered(&db).await.unwrap(),
            1,
            "only the one still owed"
        );

        // The delivered row is still there, so it is not computed and sent
        // again on the next sweep.
        let due = days_to_compute(&db, DAY).await.unwrap();
        assert!(
            !due.contains(&a.day),
            "a day already sent is not owed again"
        );
        assert!(due.contains(&b.day), "a discarded day is owed again");
    }

    /// Every poll reports a version, and the version moves when somebody
    /// updates the app — so writing it per poll is a write per poll for a value
    /// that almost never changes. This is what keeps the courier's interval
    /// cheap to shorten.
    #[tokio::test]
    async fn the_courier_version_is_written_only_when_it_changes() {
        let (db, accounts, _org, _who) = harness().await;

        note_courier(&accounts, "0.46.0").await.unwrap();

        // Backdated, so a needless rewrite is unmistakable rather than a
        // question about the clock's resolution.
        let backdated = "2020-01-01T00:00:00Z".parse::<DateTime<Utc>>().unwrap();
        sqlx::query("UPDATE settings SET updated_at = $1 WHERE key = $2")
            .bind(backdated)
            .bind(keys::COURIER)
            .execute(db.pool())
            .await
            .unwrap();

        // The same version again, as every subsequent poll reports it.
        note_courier(&accounts, "0.46.0").await.unwrap();

        let touched: DateTime<Utc> =
            sqlx::query_scalar("SELECT updated_at FROM settings WHERE key = $1")
                .bind(keys::COURIER)
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(
            touched, backdated,
            "an unchanged courier version must not be rewritten"
        );

        // An upgrade is the case this exists to record, and it still lands.
        note_courier(&accounts, "0.47.0").await.unwrap();
        assert_eq!(
            accounts.setting(keys::COURIER).await.unwrap().as_deref(),
            Some("0.47.0")
        );
    }

    /// The regression guard for a sweep that never settled.
    ///
    /// `prune` used to delete delivered rows, and `days_to_compute` reads the
    /// absence of a row as "this day is due" — so pruning a delivered day
    /// erased the record of having delivered it and the next sweep built it
    /// again, undelivered. With an hourly sweep refilling the window and a
    /// bounded batch serving it, the newest day could sit behind a backlog that
    /// regenerated faster than a courier drained it.
    ///
    /// Two sweeps, because one was never enough to show it: the first prunes
    /// and the second is the one that used to rebuild what the first forgot.
    #[tokio::test]
    async fn a_day_already_delivered_is_never_owed_again() {
        let (db, accounts, _org, _who) = harness().await;

        sweep(&db, &accounts, DAY).await.unwrap();
        let owed: Vec<NaiveDate> = undelivered(&db, 60)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.day)
            .collect();
        assert_eq!(owed.len() as i64, KEEP_UNDELIVERED_DAYS);

        // The courier gets there and acknowledges the lot.
        mark_delivered(&db, &owed).await.unwrap();
        assert!(undelivered(&db, 60).await.unwrap().is_empty());

        for round in 1..=2 {
            let wrote = sweep(&db, &accounts, DAY).await.unwrap();
            assert_eq!(
                wrote, 0,
                "sweep {round} rebuilt a day that had already been delivered"
            );
            assert!(
                undelivered(&db, 60).await.unwrap().is_empty(),
                "sweep {round} put a delivered day back in the outbox"
            );
        }

        // And the record of having sent them is what makes that true, so it
        // has to survive the prune that runs at the end of every sweep.
        assert!(
            days_to_compute(&db, DAY).await.unwrap().is_empty(),
            "nothing is due: every day in the window has been sent"
        );
    }

    /// Age is the only reason a row is dropped, and it is still a reason.
    #[tokio::test]
    async fn a_day_past_the_window_goes_whether_it_was_delivered_or_not() {
        let (db, accounts, _org, _who) = harness().await;

        for (back, delivered) in [(90, true), (91, false)] {
            let d = build(&db, &accounts, DAY - Duration::days(back))
                .await
                .unwrap();
            record(&db, &d).await.unwrap();
            if delivered {
                mark_delivered(&db, &[d.day]).await.unwrap();
            }
        }

        assert_eq!(
            prune(&db, DAY).await.unwrap(),
            2,
            "both are past the window"
        );

        let kept: i64 = sqlx::query_scalar("SELECT count(*) FROM telemetry_digests")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(kept, 0);
    }

    /// An install mid-setup has no organisation, and asking for one would be an
    /// error rather than an empty answer.
    #[tokio::test]
    async fn an_unnamed_install_reports_nothing_rather_than_failing() {
        let (db, _accounts, _org, _who) = harness().await;
        sqlx::query("DELETE FROM installation")
            .execute(db.pool())
            .await
            .unwrap();
        let accounts = Accounts::new(db.pool().clone());

        assert_eq!(sweep(&db, &accounts, DAY).await.unwrap(), 0);
    }
}
