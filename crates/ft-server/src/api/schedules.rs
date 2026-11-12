//! Work that starts itself, over HTTP.
//!
//! Listed by owner and never filed: a schedule is not shared, so the question
//! is "is it mine" and the predicate is in the query.
//!
//! **Three things the server does rather than the client.** It compiles the
//! cadence and computes the next three fire times, so no client parses cron
//! and there is one implementation in the product. It enforces the
//! fifteen-minute floor on write, so the API refuses it and not only the form.
//! And it counts the streak off the run history on every read, so the words a
//! paused schedule shows are derivable rather than frozen in a column.

use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::schedules::{cadence, launch, pause, settle};
use crate::AppState;
use ft_core::schedule::{Cadence, Provenance, Schedule, ScheduleRun, TriggerKind};
use ft_core::{RepoId, ScheduleId, ScheduleRunId, TriggerId, UserId};

/// Whose schedules these are.
///
/// There is no owning one as nobody: a schedule spends a subscription and
/// pushes with a git token, and neither exists without an account.
fn owner(principal: &Principal) -> ApiResult<&str> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "a schedule runs as somebody, so this needs signing in",
        )
    })
}

/// What the API accepts to write one down.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSchedule {
    pub name: String,
    pub prompt: String,
    /// Omit for a bare agent. Several things are different without one — see
    /// `deleteCleanRuns`.
    #[serde(default)]
    pub repo_id: Option<RepoId>,
    /// The branch each run starts from. Only meaningful with a repository.
    #[serde(default)]
    pub base: Option<String>,
    pub cadence: Cadence,
    /// An IANA name. Required, and not defaulted to the server's own zone:
    /// "09:00" means nothing without saying whose nine.
    pub timezone: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default = "default_agent")]
    pub agent: ft_core::Agent,
    #[serde(default)]
    pub account_id: Option<String>,
    /// Model, effort, permissions and sandbox. **Pinned explicitly** — see
    /// [`pins_for`].
    #[serde(default)]
    pub settings: ft_core::controls::Preferred,
    /// The skills each run reads. `null` takes the repository's defaults *at
    /// creation* and pins the result.
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Whether a clean run's workspace is deleted. Ignored without a
    /// repository, where nothing is ever deleted automatically.
    #[serde(default = "yes")]
    pub delete_clean_runs: bool,
    /// The conversation that asked for this, when an agent did.
    #[serde(default)]
    pub from_session_id: Option<String>,
}

fn default_agent() -> ft_core::Agent {
    ft_core::Agent::ClaudeCode
}
fn yes() -> bool {
    true
}

/// What a cadence would do, before anything is written down.
///
/// The create form needs the read-back and the next three fire times while
/// somebody is still typing, and it must not compute them itself.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CadenceQuestion {
    pub cadence: Cadence,
    pub timezone: String,
}

/// The answer: what it means, and when it would fire.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CadenceAnswer {
    pub expr: String,
    pub reads: String,
    pub next_fires: Vec<chrono::DateTime<chrono::Utc>>,
}

/// One run of one schedule, with the schedule's name beside it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunOf {
    #[serde(flatten)]
    pub run: ScheduleRun,
    pub schedule_name: String,
}

#[derive(Debug, Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    /// How many to return. Twenty is what the page draws.
    #[serde(default)]
    pub limit: Option<i64>,
}

/// Every schedule of yours, newest change first.
#[utoipa::path(
    get, path = "/api/v1/schedules", tag = "schedules",
    responses((status = 200, body = Vec<Schedule>)),
)]
pub(super) async fn list_schedules(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Schedule>>> {
    let person = owner(&principal)?;
    let mut out = Vec::new();
    for row in state.db.schedules_of(person).await? {
        out.push(assemble(&state, row).await?);
    }
    Ok(Json(out))
}

/// Write one down. **Inactive and unapproved, whoever asked.**
///
/// This does not take an "and turn it on" argument, and that absence is the
/// rule rather than an omission. A schedule a person creates through the
/// sheet does land on — pressing Create is the act of approval, which is what
/// the pinned consequence summary is for — but the thing that turns it on is
/// [`approve_schedule`], a second explicit call against a path of its own.
///
/// **The distinction is the route, not the caller.** An `activate` flag here
/// would move it to the caller: anything able to reach this endpoint could
/// ask for a running schedule, and "an agent may propose but may not
/// activate" would rest on who was asking rather than on which path was
/// taken — which is a rule that drifts the first time something new calls it.
/// So everything that merely creates gets an inactive schedule: the MCP tool,
/// this endpoint by hand, a copy, a webhook trigger that does not exist yet.
/// One path activates, and it is one an agent has no door to.
#[utoipa::path(
    post, path = "/api/v1/schedules", tag = "schedules",
    request_body = NewSchedule,
    responses(
        (status = 201, body = Schedule),
        (status = 400, body = ApiError, description = "the cadence fires too often, or is not one"),
        (status = 404, body = ApiError, description = "that repository isn't connected"),
    ),
)]
pub(super) async fn create_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<NewSchedule>,
) -> ApiResult<(axum::http::StatusCode, Json<Schedule>)> {
    let person = owner(&principal)?.to_string();
    let id = ScheduleId::new();
    write_one(&state, &person, &person, &id, req, true).await?;
    let row = state
        .db
        .schedule_of(&person, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(assemble(&state, row).await?),
    ))
}

/// Shared by the handler and the MCP tool, so a proposal cannot reach a
/// weaker check than a person does.
pub(crate) async fn write_one(
    state: &AppState,
    owner_id: &str,
    created_by: &str,
    id: &ScheduleId,
    req: NewSchedule,
    fresh: bool,
) -> ApiResult<()> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a schedule needs a name",
        ));
    }
    if req.prompt.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a schedule needs something to ask for — nobody is there to say it later",
        ));
    }

    // **The repository, as the person who named it.** The same predicate every
    // launch re-checks; naming somebody else's here would be the ownership
    // hole with a timer attached.
    if let Some(repo) = &req.repo_id {
        if state.db.repo_of(owner_id, repo).await?.is_none() {
            return Err(ApiError::new(
                ErrorCode::RepoNotConnected,
                "that repository isn't connected",
            ));
        }
    }

    // The floor, on write, with the reason in the refusal.
    let clock = cadence::Clock::of(&req.cadence, &req.timezone)
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused.0))?;

    // **The engine that will actually run, resolved before anything is
    // validated against it.** A profile that pins an engine replaces the
    // requested one inside `create_session_as` — so a schedule asking for
    // `Shell` with a Codex profile was validated against `Shell`'s catalogue,
    // which has no controls at all, and handed a worker Codex with whatever
    // sandbox had been asked for. Everything below reads this, and the spec
    // records it, so the thing that is checked is the thing that runs.
    let profile = profile_for(state, owner_id, &req).await?;
    let agent = effective_agent(&req, profile.as_ref());
    let spec = spec_for(&req, agent);
    let pins = pins_for(state, owner_id, &req, agent, profile.as_ref()).await?;
    let delete_clean_runs = req.repo_id.is_some() && req.delete_clean_runs;

    if fresh {
        state
            .db
            .insert_schedule(
                id,
                owner_id,
                created_by,
                req.from_session_id.as_deref(),
                name,
                &spec,
                &pins,
                delete_clean_runs,
            )
            .await?;
    } else {
        state
            .db
            .update_schedule(id, name, &spec, &pins, delete_clean_runs)
            .await?;
        state.db.replace_triggers(id).await?;
    }

    state
        .db
        .insert_trigger(
            &TriggerId::new(),
            id,
            crate::schedules::kind_name(TriggerKind::Cron),
            &crate::schedules::trigger_config(&req.cadence, &req.timezone, &clock),
            // **No clock until it is approved and on.** A trigger with a fire
            // time is one the sweep will act on, and nothing may run before a
            // person turns it on.
            None,
        )
        .await?;
    Ok(())
}

/// The `NewSession` a run is started from, as approved.
///
/// Stored as the JSON it will be read back as rather than as a typed struct,
/// because what was approved is a *text* — and a build that adds a field to
/// `NewSession` must not retroactively change what an approved schedule does.
fn spec_for(req: &NewSchedule, agent: ft_core::Agent) -> serde_json::Value {
    let mut spec = serde_json::json!({
        "name": req.name.trim(),
        "prompt": req.prompt.trim(),
        // **The effective engine**, not the requested one. A profile that
        // pins an engine replaces the request inside `create_session_as`, so
        // recording the request meant the stored spec named an engine that
        // would not run — and everything validated against it was validated
        // against the wrong catalogue.
        "agent": agent,
        // Neither is a control on this surface, and both are written rather
        // than left to a default: `Equal` is what a workspace takes when
        // nobody says, and an unattended run should yield to whoever is at
        // their desk.
        //
        // Serialized from the values rather than written as strings, so a
        // rename on either enum is a compile error here instead of a spec
        // that silently fails to read back.
        "size": ft_core::WorkspaceSize::Medium,
        "share": ft_core::Share::Yields,
    });
    if let Some(repo) = &req.repo_id {
        spec["repoId"] = serde_json::json!(repo.as_str());
        if let Some(base) = req.base.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
            spec["base"] = serde_json::json!(base);
        }
    }
    // **No `hostId`.** A schedule pins a policy — any machine that is free —
    // and never a host: a pinned machine that is retired is a schedule that
    // fails every morning.
    spec
}

/// What must not be resolved again at launch.
///
/// **`settings: {}` is not "the defaults".** `carry_preferences` fills any
/// unset control field from whatever that person was last working with, so an
/// absent field means "whatever they were doing at 5pm yesterday" and would
/// change what the 9am unattended run does. All four are written in
/// explicitly, from the shipped defaults where the request left them unset.
async fn pins_for(
    state: &AppState,
    owner_id: &str,
    req: &NewSchedule,
    agent: ft_core::Agent,
    profile: Option<&crate::roles::Role>,
) -> ApiResult<serde_json::Value> {
    let mut settings = req.settings.clone();

    // **The permission mode, per engine.** It refuses anything not already
    // allowed rather than asking, because an unattended run has nobody to
    // ask — and the *word* for that differs: Claude Code spells it `dontAsk`
    // and Codex spells it `never`. This defaulted to `dontAsk` whatever the
    // engine, which for Codex is a value it has never heard of, so the
    // control silently did nothing.
    if settings.mode.is_none() {
        settings.mode = ft_core::controls::never_asks_as(agent).map(str::to_string);
    }

    // **The sandbox, where the engine has one.** Left unset it used to be
    // filled at launch from whatever that person last picked in an unrelated
    // session, which for Codex includes *Everything* — no filesystem fence,
    // unattended, on their credentials. Inheritance is off for a scheduled
    // launch now, and this pins the fence rather than leaving it to the
    // agent's own default.
    if settings.sandbox.is_none() {
        settings.sandbox = ft_core::controls::unattended_sandbox(agent).map(str::to_string);
    }

    // **And nothing that grants more than the agent otherwise had**, asked of
    // the control catalogue rather than of a list of dangerous words kept
    // here. A choice marked `.grants()` is one a person is warned about
    // before picking; there is nobody to warn when a schedule fires, so it is
    // refused on write and named in the refusal.
    //
    // `bypassPermissions` is refused by the same rule — it is not in the
    // menu at all, so it is not a value this engine takes.
    for (kind, value) in [
        (
            ft_core::controls::ControlKind::Mode,
            settings.mode.as_deref(),
        ),
        (
            ft_core::controls::ControlKind::Sandbox,
            settings.sandbox.as_deref(),
        ),
        (
            ft_core::controls::ControlKind::Model,
            settings.model.as_deref(),
        ),
        (
            ft_core::controls::ControlKind::Effort,
            settings.effort.as_deref(),
        ),
    ] {
        let Some(value) = value else { continue };
        // **Unknown is refused, not assumed safe.** `grants_more` answers
        // `false` for a value it has never heard of, so a sandbox value no
        // catalogue lists passed the check meant to stop exactly that. And a
        // control this engine does not have is not a harmless extra field —
        // it is one that will be ignored while somebody believes it is in
        // force.
        if !ft_core::controls::has_control(agent, kind) {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "{} has no such setting, and a schedule cannot be approved on one it would \
                     ignore.",
                    agent.label()
                ),
            ));
        }
        // Where the server can enumerate the choices, the value has to be one
        // of them. Where it cannot — Codex lists its models and efforts over
        // its own protocol — an empty list is "unknown to me", not "no such
        // value", and refusing on it would refuse every Codex model.
        let known = ft_core::controls::choices_for(agent, kind);
        if !known.is_empty() && !known.iter().any(|k| k == value) {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "“{value}” is not something {} offers for that setting, so a run started on \
                     it would not do what it says.",
                    agent.label()
                ),
            ));
        }
        if ft_core::controls::grants_more(agent, kind, value) {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "“{value}” lets the agent do more than it otherwise could, and a schedule \
                     runs with nobody there to be asked about it. Pick something a run can be \
                     left alone with."
                ),
            ));
        }
    }
    if settings.mode.as_deref() == Some("bypassPermissions") {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "bypassPermissions is not a mode a schedule may run in. An unattended run refuses \
             what it is not allowed to do rather than being allowed more.",
        ));
    }

    // The skills each run reads, resolved **now** and pinned. An absent list
    // is resolved from the repository's defaults at creation, because leaving
    // it absent would resolve it afresh at every launch — which is the thing
    // approval is supposed to fix.
    let repos: Vec<ft_core::RepoId> = req.repo_id.clone().into_iter().collect();
    let skills: Vec<String> = match &req.skills {
        Some(chosen) => chosen.clone(),
        None => state
            .skills
            .defaults_for(owner_id, &repos)
            .await
            .unwrap_or_default(),
    };

    // **The subscription this will spend, resolved now and required.**
    //
    // Pinned because "the default" is a preference somebody can change, and a
    // schedule approved against one subscription must not quietly start
    // spending another. A null pin was worse than that: `pin_agent_account`
    // is a `before insert` trigger that selects the owner's current default
    // when the column is null, so a schedule approved while no account was
    // connected would later spend whichever one turned up — one the gate
    // never authorized and never checked against its usage limit, because
    // both of those checks sit behind "is there an account pinned". And with
    // no portable credential the launch path falls through to host-local
    // authentication, which is the worker's identity rather than the
    // owner's.
    //
    // So resolution failure is a refusal rather than a null. There is no
    // ambient fallback for something that runs with nobody present.
    let account = match &req.account_id {
        Some(id) => Some(id.clone()),
        None => super::accounts::default_account(&state.db, owner_id, agent)
            .await
            .map_err(|e| {
                // **Not swallowed into a null.** An error reading the account
                // is not the same answer as there being none.
                ApiError::new(
                    ErrorCode::ActionFailed,
                    format!("could not read which subscription this would spend: {e:#}"),
                )
            })?
            .map(|a| a.id),
    };
    // Distinguished from an approved credential-free mode, which is a real
    // state: a plain shell authenticates nothing, so there is nothing to pin
    // and nothing to fall back to either.
    //
    // **Not required here — required at approval.** Writing one down is inert
    // for everybody, and refusing to let somebody draft a schedule because
    // they have not connected a subscription yet would make the inert row
    // unobtainable. [`approve_schedule`] is where the authorization is fixed,
    // and that is where an account has to exist and be spendable.
    let needs_account = agent.needs_credential();

    // The versions those skills resolve to **now**, and what a run is pinned
    // to. Recording the ids was not enough on its own: the launch pinned
    // whatever was current and the recorded version still passed an existence
    // check, so adding a version to a selected skill substituted it silently.
    let versions = state
        .skills
        .current_versions(&skills)
        .await
        .unwrap_or_default();

    // **The effective profile, snapshotted.** A writer of a shared profile —
    // or an agent with Writer calling `update_profile` — can change its
    // instructions, its engine, its account or its delegation after somebody
    // has approved a schedule that uses it, and the live profile was resolved
    // at every launch. So the composed system prompt is stored, and a
    // fingerprint of everything else about it that decides behaviour.
    //
    // A fingerprint rather than a revision because `roles` has no revision
    // column to read — there was nothing to check against at all, which is
    // why this was worse than "a revision check somebody could sidestep".
    // The gate recomputes it and refuses rather than running something
    // nobody approved; refusing is right, because the remedy is a person
    // looking at what changed.
    let (persona, fingerprint) = match profile {
        None => (None, None),
        Some(role) => (
            Some(super::sessions::persona_for(state, owner_id, role).await?),
            Some(profile_fingerprint(role)),
        ),
    };

    // **What the pins say about a control nobody can resolve here.** Codex
    // lists its own models over its protocol, so the server cannot name one
    // at approval — and an unset field is no longer a hole, because a
    // scheduled launch inherits nothing: it falls to the agent's own default,
    // which is fixed and documented. Recorded so a reader can tell "the
    // agent decides this" from "nobody thought about it".
    let decides_itself: Vec<&str> = ["model", "effort"]
        .into_iter()
        .filter(|f| match *f {
            "model" => settings.model.is_none(),
            _ => settings.effort.is_none(),
        })
        .collect();

    Ok(serde_json::json!({
        "settings": settings,
        "agentDecides": decides_itself,
        // Whether an account is a thing this engine has at all, so the gate
        // can tell "approved with no credential, deliberately" from "the pin
        // is missing".
        "accountNeeded": needs_account,
        "skills": skills,
        "accountId": account,
        "profile": req.profile,
        "skillVersionIds": versions,
        "persona": persona,
        "profileFingerprint": fingerprint,
    }))
}

/// One schedule of yours.
#[utoipa::path(
    get, path = "/api/v1/schedules/{id}", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn one_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    Ok(Json(assemble(&state, row).await?))
}

/// Change what it runs.
///
/// **An edit clears the approval and bumps the revision**, so the next
/// occurrence is refused until a person approves again — a schedule an agent
/// proposed and somebody approved is an authorization over a particular text.
/// A run already in flight carries the revision it started on and is
/// untouched.
#[utoipa::path(
    patch, path = "/api/v1/schedules/{id}", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    request_body = NewSchedule,
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn update_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<NewSchedule>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    let person = owner(&principal)?.to_string();
    write_one(&state, &row.owner_id, &person, &row.id, req, false).await?;
    // Off until somebody approves it again, and its clock stopped with it.
    state.db.set_schedule_active(&row.id, false, None).await?;
    let row = state
        .db
        .schedule_of(&person, &row.id)
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))?;
    Ok(Json(assemble(&state, row).await?))
}

/// Approve it and turn it on.
///
/// **The one act an agent may not do, and the only thing that activates a
/// schedule.** A person doing it is what makes a proposal an ordinary
/// schedule — the row afterwards is identical to one somebody wrote.
///
/// It is also what the create sheet calls the moment it has written one down,
/// because pressing Create is the approval. That is the whole of ruling 18:
/// creating is inert for everybody and this is the explicit act, so there is
/// one rule about the route instead of two about the caller.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/approve", tag = "schedules",
    params(
        ("id" = String, Path, description = "Schedule id"),
        ("revision" = Option<i32>, Query, description = "The revision being approved"),
    ),
    responses(
        (status = 200, body = Schedule),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError, description = "it changed since you read it"),
    ),
)]
pub(super) async fn approve_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(at): Query<Reviewed>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    pin_a_spendable_account(&state, &row).await?;

    // **The revision that was read, not whatever the row says now.** Open a
    // proposal in one tab, edit it in another, approve the stale tab, and
    // taking only the id authorized changes nobody had seen. The client sends
    // what it drew; omitting it approves what is current, which is what a
    // caller with no screen means.
    let approving = at.revision.unwrap_or(row.revision);
    if !state
        .db
        .approve_schedule(&row.id, owner(&principal)?, approving)
        .await?
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "This schedule changed since you opened it, so it was not turned on. Read it again \
             and approve what it says now.",
        ));
    }
    turn_on(&state, &row).await?;
    reread(&state, &principal, &row.id).await
}

/// Which revision a caller is approving.
#[derive(Debug, Default, Deserialize, ToSchema, utoipa::IntoParams)]
#[serde(rename_all = "camelCase")]
pub struct Reviewed {
    /// What the screen was showing. Omitted means "whatever is current",
    /// which is the honest answer for a caller that has not drawn anything.
    #[serde(default)]
    pub revision: Option<i32>,
}

/// The subscription this schedule will spend, fixed at the moment it is
/// authorized.
///
/// **A null pin cannot be allowed to survive activation.**
/// `pin_agent_account` is a `before insert` trigger that fills the column
/// from the owner's current default when it is null — so a schedule approved
/// with no account would later spend whichever one happened to be connected
/// by then, against a usage limit nothing had read, and with no portable
/// credential the launch falls through to host-local authentication, which is
/// the worker's identity rather than the owner's.
///
/// So the account is resolved here if the draft had none, and *written into
/// the pins*, which is what makes "approved against this subscription" a
/// fact rather than a hope. Approval is the right moment for it: it is when
/// somebody is present and deciding.
async fn pin_a_spendable_account(state: &AppState, row: &crate::db::ScheduleRow) -> ApiResult<()> {
    // An engine that authenticates nothing has nothing to pin and nothing to
    // fall back to. Told apart from an absent pin deliberately.
    let needs = row
        .pins
        .get("accountNeeded")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    if !needs {
        return Ok(());
    }

    let agent: ft_core::Agent = row
        .spec
        .get("agent")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(ft_core::Agent::ClaudeCode);

    let pinned = row.pins.get("accountId").and_then(|v| v.as_str());
    let account = match pinned {
        Some(id) => id.to_string(),
        None => super::accounts::default_account(&state.db, &row.owner_id, agent)
            .await
            .map_err(|e| {
                ApiError::new(
                    ErrorCode::ActionFailed,
                    format!("could not read which subscription this would spend: {e:#}"),
                )
            })?
            .map(|a| a.id)
            .ok_or_else(|| {
                ApiError::new(
                    ErrorCode::InvalidRequest,
                    format!(
                        "There is no connected {} subscription for this to spend, so it cannot \
                         be turned on. Connect one and turn it on then — a schedule is not left \
                         to pick whichever account turns up later, because nobody is there to \
                         notice which it chose.",
                        agent.label()
                    ),
                )
            })?,
    };

    // Usable, now, and theirs. The gate re-reads this at every launch; what
    // this adds is that it was true at the moment somebody said yes.
    match state.db.account_spendable(&row.owner_id, &account).await? {
        None => {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                "That subscription is not one of yours any more, so this cannot be turned on.",
            ))
        }
        Some((name, false)) => {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!("The {name} subscription is not connected, so this cannot be turned on."),
            ))
        }
        Some((_, true)) => {}
    }

    if pinned.is_none() {
        let mut pins = row.pins.clone();
        if let Some(obj) = pins.as_object_mut() {
            obj.insert("accountId".into(), serde_json::json!(account));
        }
        state.db.set_schedule_pins(&row.id, &pins).await?;
    }
    Ok(())
}

/// Stop future runs. **Never touches a run in flight** — that is a separate
/// control, and the two are different questions.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/pause", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 200, body = Schedule), (status = 404, body = ApiError)),
)]
pub(super) async fn pause_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    // **`paused_reason` stays null**, which is how "you paused this" is told
    // apart from "this gave up". The two have to read differently.
    state.db.set_schedule_active(&row.id, false, None).await?;
    for trigger in state.db.triggers_of(&row.id).await? {
        state.db.set_next_fire_at(&trigger.id, None).await?;
    }
    reread(&state, &principal, &row.id).await
}

/// Turn it back on.
///
/// Only ever a person. **Answering a question after a schedule has paused does
/// not resume it**, and nothing else does either: Firetower never turns a
/// schedule back on.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/resume", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses(
        (status = 200, body = Schedule),
        (status = 409, body = ApiError, description = "it has not been approved"),
    ),
)]
pub(super) async fn resume_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Schedule>> {
    let row = mine(&state, &principal, &id).await?;
    if row.approved_at.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this schedule has not been approved yet, so there is nothing to turn back on",
        ));
    }
    // Turning one back on is an activation too, so it answers the same
    // question: the subscription it was approved against has to still be
    // there and still be spendable.
    pin_a_spendable_account(&state, &row).await?;
    turn_on(&state, &row).await?;
    reread(&state, &principal, &row.id).await
}

/// Mark it on and give its triggers a clock.
async fn turn_on(state: &AppState, row: &crate::db::ScheduleRow) -> ApiResult<()> {
    state.db.set_schedule_active(&row.id, true, None).await?;
    let now = chrono::Utc::now();
    for trigger in state.db.triggers_of(&row.id).await? {
        let next = crate::schedules::clock_of(&trigger.config).and_then(|c| c.next_after(now));
        state.db.set_next_fire_at(&trigger.id, next).await?;
    }
    Ok(())
}

/// Start one now.
///
/// **The clock is not moved**, and the run is marked `manual` — the pause rule
/// reads only scheduled runs, so three presses that each asked something must
/// not pause a schedule that has never failed on its own clock.
#[utoipa::path(
    post, path = "/api/v1/schedules/{id}/run", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 202, body = StartedRun), (status = 404, body = ApiError)),
)]
pub(super) async fn run_schedule_now(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<(axum::http::StatusCode, Json<StartedRun>)> {
    let row = mine(&state, &principal, &id).await?;
    if row.approved_at.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this schedule has not been approved yet",
        ));
    }
    let run = launch::run_now(&state, &row)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok((
        axum::http::StatusCode::ACCEPTED,
        Json(StartedRun {
            run_id: run.as_str().to_string(),
        }),
    ))
}

/// Which run a press of Run now started.
///
/// **Not `Done`.** `sessions::Done` already owns that name in the contract,
/// and two schemas of one name there means the second quietly becomes the
/// first — the generated client would have typed this as `{ detail }` and
/// nothing would have said so until a field read `undefined`.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct StartedRun {
    pub run_id: String,
}

/// Delete it.
///
/// **Never stops a run.** One in flight finishes and its workspace stays. The
/// history goes, because the summary table is the only record of it.
#[utoipa::path(
    delete, path = "/api/v1/schedules/{id}", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_schedule(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    let row = mine(&state, &principal, &id).await?;
    state.db.delete_schedule(&row.id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// This schedule's runs, newest first.
#[utoipa::path(
    get, path = "/api/v1/schedules/{id}/runs", tag = "schedules",
    params(("id" = String, Path, description = "Schedule id"), Limit),
    responses((status = 200, body = Vec<ScheduleRun>), (status = 404, body = ApiError)),
)]
pub(super) async fn schedule_runs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(limit): Query<Limit>,
) -> ApiResult<Json<Vec<ScheduleRun>>> {
    let row = mine(&state, &principal, &id).await?;
    let rows = state
        .db
        .runs_of(&row.id, limit.limit.unwrap_or(20).clamp(1, 200))
        .await?;
    Ok(Json(rows.iter().map(as_run).collect()))
}

/// Every run from every schedule of yours, newest first.
#[utoipa::path(
    get, path = "/api/v1/schedule-runs", tag = "schedules",
    params(Limit),
    responses((status = 200, body = Vec<RunOf>)),
)]
pub(super) async fn all_runs(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(limit): Query<Limit>,
) -> ApiResult<Json<Vec<RunOf>>> {
    let person = owner(&principal)?;
    let rows = state
        .db
        .runs_for(person, limit.limit.unwrap_or(50).clamp(1, 500))
        .await?;
    Ok(Json(
        rows.iter()
            .map(|(name, row)| RunOf {
                run: as_run(row),
                schedule_name: name.clone(),
            })
            .collect(),
    ))
}

/// What a cadence would do.
///
/// Here rather than in the client, which is the whole of criterion 10: there
/// is one cron implementation in the product, and the row renders what it is
/// told.
#[utoipa::path(
    post, path = "/api/v1/schedules/cadence", tag = "schedules",
    request_body = CadenceQuestion,
    responses(
        (status = 200, body = CadenceAnswer),
        (status = 400, body = ApiError, description = "it fires too often, or is not a cadence"),
    ),
)]
pub(super) async fn read_cadence(
    State(_state): State<AppState>,
    Extension(_principal): Extension<Principal>,
    Json(req): Json<CadenceQuestion>,
) -> ApiResult<Json<CadenceAnswer>> {
    let clock = cadence::Clock::of(&req.cadence, &req.timezone)
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused.0))?;
    Ok(Json(CadenceAnswer {
        expr: clock.expr().to_string(),
        reads: clock.reads(),
        next_fires: clock.next_fires(chrono::Utc::now(), 3),
    }))
}

/// The engine that will actually run.
///
/// **A profile that pins one replaces whatever was requested**, and that
/// happens inside `create_session_as` — so anything validated against the
/// requested engine is validated against an engine that may never run. A
/// schedule asking for `Shell` with a Codex profile was checked against
/// `Shell`'s catalogue, which has no controls at all, and handed a worker
/// Codex with whatever sandbox had been asked for.
///
/// Resolved here, recorded in the spec, and used for every per-engine
/// question: the permission mode's word, the sandbox, whether a subscription
/// is needed, and which account is the default.
/// Pure, and resolved from the same field `create_session_as` reads, so the
/// two cannot disagree about which engine this is.
fn effective_agent(req: &NewSchedule, profile: Option<&crate::roles::Role>) -> ft_core::Agent {
    profile
        .and_then(|p| p.agent.as_deref())
        .and_then(ft_core::Agent::from_name)
        .unwrap_or(req.agent)
}

/// The profile this schedule runs as, read once as the person who named it.
///
/// Once, because the engine, the persona and the fingerprint all come off it
/// and two reads could see two different profiles.
async fn profile_for(
    state: &AppState,
    owner_id: &str,
    req: &NewSchedule,
) -> ApiResult<Option<crate::roles::Role>> {
    let Some(id) = &req.profile else {
        return Ok(None);
    };
    Ok(Some(
        state
            .roles
            .one(owner_id, id, crate::access::Level::Viewer)
            .await?
            .ok_or_else(|| {
                ApiError::new(
                    ErrorCode::InvalidRequest,
                    "that profile isn't one you can start a workspace as",
                )
            })?,
    ))
}

/// Everything about a profile that decides what a run does.
///
/// Hashed rather than stored field by field, because the question the gate
/// asks is "is this still the profile somebody approved" and a hash answers
/// exactly that — including for a field added later, which is the part a
/// hand-written comparison gets wrong the first time somebody extends
/// `Role`.
///
/// `name` is in it deliberately: it is in the composed persona, so a rename
/// changes what the agent is told it is.
pub(crate) fn profile_fingerprint(role: &crate::roles::Role) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        role.name.as_str(),
        role.does.as_str(),
        role.instructions.as_str(),
        role.placement.as_str(),
        role.agent.as_deref().unwrap_or(""),
        role.machine.as_deref().unwrap_or(""),
        role.account.as_deref().unwrap_or(""),
        role.on_usage_limit.as_str(),
    ] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher.update([u8::from(role.can_delegate)]);
    for scope in &role.delegate_scope {
        hasher.update(scope.as_bytes());
        hasher.update([0u8]);
    }
    hasher.update(
        serde_json::to_vec(&role.settings)
            .unwrap_or_default()
            .as_slice(),
    );
    format!("{:x}", hasher.finalize())
}

/// Mine, or not found.
async fn mine(
    state: &AppState,
    principal: &Principal,
    id: &str,
) -> ApiResult<crate::db::ScheduleRow> {
    state
        .db
        .schedule_of(owner(principal)?, &ScheduleId::from_stored(id.to_string()))
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))
}

async fn reread(
    state: &AppState,
    principal: &Principal,
    id: &ScheduleId,
) -> ApiResult<Json<Schedule>> {
    let row = state
        .db
        .schedule_of(owner(principal)?, id)
        .await?
        .ok_or_else(|| ApiError::not_found("schedule"))?;
    Ok(Json(assemble(state, row).await?))
}

/// A row, plus everything a page draws beside it.
async fn assemble(state: &AppState, row: crate::db::ScheduleRow) -> ApiResult<Schedule> {
    let triggers: Vec<_> = state
        .db
        .triggers_of(&row.id)
        .await?
        .iter()
        .filter_map(|t| crate::schedules::trigger_of(t, row.active))
        .collect();

    let (runs_total, workspaces_kept) = state.db.run_counts(&row.id).await?;

    // **Counted off the history, every read.** Nothing is stored, which is
    // what lets one rule read three ways — the page says which by counting
    // the same rows it is already drawing.
    let window = state.db.runs_for_streak(&row.id, pause::WINDOW).await?;
    let counted: Vec<_> = window.iter().map(settle::as_counted).collect();
    let streak = pause::streak(&counted);

    let last_run = state.db.runs_of(&row.id, 1).await?.first().map(as_run);

    let repo_id = row
        .spec
        .get("repoId")
        .and_then(|v| v.as_str())
        .map(|s| RepoId::from_stored(s.to_string()));
    let repo_slug = match &repo_id {
        Some(id) => state.db.repo_of(&row.owner_id, id).await?.map(|r| r.slug),
        None => None,
    };

    let by_agent = row.from_session_id.is_some();
    let who = match by_agent {
        true => row
            .pins
            .get("proposedBy")
            .and_then(|v| v.as_str())
            .unwrap_or("An agent")
            .to_string(),
        false => state
            .accounts
            .user_by_id(&UserId::from_stored(row.created_by.clone()))
            .await
            .ok()
            .flatten()
            .map(|u| u.username)
            .unwrap_or_else(|| "You".to_string()),
    };

    Ok(Schedule {
        id: row.id.clone(),
        name: row.name.clone(),
        prompt: row
            .spec
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        repo_id,
        repo_slug,
        base: row
            .spec
            .get("base")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        active: row.active,
        paused_reason: crate::schedules::paused_reason(row.paused_reason.as_deref()),
        approved_at: row.approved_at,
        revision: row.revision,
        triggers,
        delete_clean_runs: row.delete_clean_runs,
        workspaces_kept,
        streak,
        runs_total,
        last_run,
        made: Provenance {
            by_agent,
            who,
            from_session_id: row.from_session_id.clone(),
            from_workspace_name: row
                .pins
                .get("fromWorkspaceName")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            at: row.created_at,
        },
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

/// One stored run, as a client reads it.
pub(crate) fn as_run(row: &crate::db::RunRow) -> ScheduleRun {
    let counted = settle::as_counted(row);
    ScheduleRun {
        id: ScheduleRunId::from_stored(row.id.as_str()),
        schedule_id: row.schedule_id.clone(),
        fire_at: row.fire_at,
        revision: row.revision,
        state: counted.state,
        outcome: counted.outcome,
        source: crate::schedules::run_source(&row.source),
        detail: row.detail.clone(),
        summary: row.summary.clone(),
        session_id: row.session_id.clone(),
        workspace_kept: row.workspace_kept,
        host_name: row.host_name.clone(),
        error_code: row.error_code.clone(),
        launched_at: row.launched_at,
        ended_at: row.ended_at,
    }
}
