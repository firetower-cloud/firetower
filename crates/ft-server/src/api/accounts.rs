//! Named, owner-scoped agent connections. Secrets retain their vault identity.
use super::{ApiError, ApiResult, ErrorCode};
use crate::{
    auth::Principal,
    vault::{self, Key},
    AppState,
};
use axum::{
    extract::{Path, State},
    Extension, Json,
};
use ft_core::{Agent, AgentMode, SessionId, TurnEvent};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mode: String,
    #[serde(skip)]
    #[schema(ignore)]
    pub credential_key: String,
    pub is_default: bool,
    pub enabled: bool,
    pub state: String,
    pub identity: Option<String>,
    pub revision: i64,
    pub credential_set: bool,
    #[sqlx(skip)]
    pub limits: Vec<Limit>,
}

pub(super) fn owner(p: &Principal) -> Result<&str, ApiError> {
    p.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "connecting an account requires signing in",
        )
    })
}
fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, message)
}
fn name(value: &str) -> Result<&str, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 {
        return Err(invalid(
            "choose an account name between 1 and 80 characters",
        ));
    }
    Ok(value)
}
pub(super) async fn find(db: &crate::db::Db, owner: &str, id: &str) -> Result<Account, ApiError> {
    sqlx::query_as::<_, Account>("SELECT a.*, EXISTS(SELECT 1 FROM secrets WHERE scope='agent' AND name=a.credential_key AND owner=a.user_id) AS credential_set FROM agent_accounts a WHERE user_id=$1 AND id=$2")
        .bind(owner).bind(id).fetch_optional(db.pool()).await?
        .ok_or_else(|| ApiError::not_found("account"))
}
pub(super) async fn selected(
    db: &crate::db::Db,
    owner: &str,
    session: &SessionId,
) -> anyhow::Result<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>("SELECT a.*, EXISTS(SELECT 1 FROM secrets WHERE scope='agent' AND name=a.credential_key AND owner=a.user_id) AS credential_set FROM sessions s JOIN agent_accounts a ON a.id=s.agent_account_id AND a.user_id=s.user_id WHERE s.user_id=$1 AND s.id=$2")
        .bind(owner).bind(session.as_str()).fetch_optional(db.pool()).await?)
}
pub(super) async fn default_account(
    db: &crate::db::Db,
    owner: &str,
    kind: Agent,
) -> anyhow::Result<Option<Account>> {
    Ok(sqlx::query_as::<_, Account>("SELECT a.*, EXISTS(SELECT 1 FROM secrets WHERE scope='agent' AND name=a.credential_key AND owner=a.user_id) AS credential_set FROM agent_accounts a WHERE user_id=$1 AND kind=$2 AND is_default AND enabled AND state='connected'")
        .bind(owner).bind(format!("{kind:?}")).fetch_optional(db.pool()).await?)
}
pub(super) async fn validate(
    state: &AppState,
    owner: &str,
    id: &str,
    kind: Agent,
) -> Result<Account, ApiError> {
    let a = find(&state.db, owner, id).await?;
    if a.kind != format!("{kind:?}") || !a.enabled || a.state != "connected" {
        return Err(invalid("that account is not connected for this agent"));
    }
    if !state
        .vault
        .holds(Key::of(vault::AGENT, &a.credential_key, owner))
        .await?
    {
        return Err(invalid("this account uses host-local authentication; connect a portable credential before selecting it"));
    }
    Ok(a)
}
pub(super) async fn pin(
    state: &AppState,
    owner: &str,
    session: &SessionId,
    id: &str,
    kind: Agent,
) -> Result<(), ApiError> {
    validate(state, owner, id, kind).await?;
    sqlx::query("UPDATE sessions SET agent_account_id=$1 WHERE id=$2 AND user_id=$3")
        .bind(id)
        .bind(session.as_str())
        .bind(owner)
        .execute(state.db.pool())
        .await?;
    Ok(())
}

#[utoipa::path(get, path="/api/v1/agent-accounts", tag="accounts", responses((status=200, body=Vec<Account>)))]
pub(super) async fn list_accounts(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
) -> ApiResult<Json<Vec<Account>>> {
    let mut rows = sqlx::query_as::<_, Account>("SELECT a.*, EXISTS(SELECT 1 FROM secrets WHERE scope='agent' AND name=a.credential_key AND owner=a.user_id) AS credential_set FROM agent_accounts a WHERE user_id=$1 ORDER BY kind, is_default DESC, created_at")
        .bind(owner(&p)?).fetch_all(state.db.pool()).await?;
    for account in &mut rows {
        account.limits =
            sqlx::query_as("SELECT * FROM agent_account_limits WHERE account_id=$1 ORDER BY scope")
                .bind(&account.id)
                .fetch_all(state.db.pool())
                .await?;
    }
    Ok(Json(rows))
}
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccount {
    pub kind: Agent,
    pub name: String,
    pub mode: AgentMode,
    pub secret: Option<String>,
}

#[utoipa::path(post, path="/api/v1/agent-accounts", tag="accounts", request_body=CreateAccount, responses((status=200, body=Account)))]
pub(super) async fn create_account(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Json(req): Json<CreateAccount>,
) -> ApiResult<Json<Account>> {
    let owner = owner(&p)?;
    let label = name(&req.name)?;
    if !matches!(req.kind, Agent::ClaudeCode | Agent::Codex) || req.mode == AgentMode::NotNeeded {
        return Err(invalid(
            "choose Claude Code or Codex and an authentication method",
        ));
    }
    let secret = req
        .secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if secret.is_none() && !(req.kind.signs_in_with_a_code() && req.mode == AgentMode::Subscription)
    {
        return Err(invalid("paste the subscription token or API key"));
    }
    if req.kind == Agent::Codex && req.mode == AgentMode::Subscription && secret.is_some() {
        return Err(invalid("connect this subscription using device sign-in"));
    }
    let id = ulid::Ulid::new().to_string();
    let key = format!("account:{id}");
    let result = sqlx::query("INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state) VALUES($1,$2,$3,$4,$5,$6,'pending')")
        .bind(&id).bind(owner).bind(format!("{:?}", req.kind)).bind(label).bind(format!("{:?}",req.mode)).bind(&key).execute(state.db.pool()).await;
    if let Err(e) = result {
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(invalid("an account with that name already exists"));
        }
        return Err(e.into());
    }
    if let Some(secret) = secret {
        if let Err(e) = connect(&state.db, &state.vault, owner, &id, secret).await {
            sqlx::query("DELETE FROM agent_accounts WHERE id=$1 AND state='pending'")
                .bind(&id)
                .execute(state.db.pool())
                .await?;
            return Err(e);
        }
    }
    Ok(Json(find(&state.db, owner, &id).await?))
}

/// Store first, then publish the connection. Serializing by owner also prevents
/// concurrent sign-ins from both becoming the default or duplicating credentials.
pub(super) async fn connect(
    db: &crate::db::Db,
    vault: &vault::Vault,
    owner: &str,
    id: &str,
    secret: &str,
) -> Result<(), ApiError> {
    let a = find(db, owner, id).await?;
    let parsed: serde_json::Value = serde_json::from_str(secret).unwrap_or_default();
    let identity = parsed
        .pointer("/tokens/account_id")
        .and_then(|v| v.as_str());
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(identity.unwrap_or(secret).as_bytes())
    );
    // Legacy credentials keep their encrypted vault names during migration.
    // Compare them only when a person connects another account, never on list.
    let legacy: Vec<(String,String)> = sqlx::query_as("SELECT name,credential_key FROM agent_accounts WHERE user_id=$1 AND kind=$2 AND fingerprint IS NULL AND id!=$3")
        .bind(owner).bind(&a.kind).bind(id).fetch_all(db.pool()).await?;
    for (label, key) in legacy {
        if let Some(previous) = vault
            .get(
                Key::of(vault::AGENT, &key, owner),
                "checking for a duplicate agent connection",
            )
            .await?
        {
            let previous_json: serde_json::Value =
                serde_json::from_str(&previous).unwrap_or_default();
            let previous_identity = previous_json
                .pointer("/tokens/account_id")
                .and_then(|v| v.as_str());
            if previous.as_str() == secret || (identity.is_some() && identity == previous_identity)
            {
                return Err(invalid(format!(
                    "this account is already connected as {label}"
                )));
            }
        }
    }
    let mut tx = db.pool().begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    let duplicate: Option<String> = sqlx::query_scalar("SELECT name FROM agent_accounts WHERE user_id=$1 AND kind=$2 AND fingerprint=$3 AND id!=$4")
        .bind(owner).bind(&a.kind).bind(&fingerprint).bind(id).fetch_optional(&mut *tx).await?;
    if let Some(label) = duplicate {
        return Err(invalid(format!(
            "this account is already connected as {label}"
        )));
    }
    vault
        .put_in(
            &mut tx,
            Key::of(vault::AGENT, &a.credential_key, owner),
            secret,
            &format!("connecting {}", a.name),
        )
        .await?;
    sqlx::query("UPDATE agent_accounts SET state='connected', enabled=true, revision=revision+1, fingerprint=$2, identity=$3, is_default=is_default OR NOT EXISTS(SELECT 1 FROM agent_accounts WHERE user_id=$4 AND kind=$5 AND is_default) WHERE id=$1")
        .bind(id).bind(fingerprint).bind(identity).bind(owner).bind(&a.kind).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO agents(user_id,kind,mode,enabled) VALUES($1,$2,$3,true) ON CONFLICT(user_id,kind) DO UPDATE SET enabled=true")
        .bind(owner).bind(&a.kind).bind(&a.mode).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAccount {
    pub name: Option<String>,
    pub is_default: Option<bool>,
    pub enabled: Option<bool>,
    pub secret: Option<String>,
}
#[utoipa::path(put, path="/api/v1/agent-accounts/{id}", tag="accounts", params(("id"=String,Path)), request_body=UpdateAccount, responses((status=200,body=Account)))]
pub(super) async fn update_account(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAccount>,
) -> ApiResult<Json<Account>> {
    let owner = owner(&p)?;
    let a = find(&state.db, owner, &id).await?;
    if let Some(secret) = req.secret.as_deref() {
        if a.kind == "Codex" && a.mode == "Subscription" {
            return Err(invalid("use device sign-in to reconnect this account"));
        }
        if secret.trim().is_empty() {
            return Err(invalid("paste a credential"));
        }
        connect(&state.db, &state.vault, owner, &id, secret.trim()).await?;
    }
    let label = req.name.as_deref().map(name).transpose()?;
    if req.is_default == Some(true) && (a.state != "connected" || !req.enabled.unwrap_or(a.enabled))
    {
        return Err(invalid(
            "connect and enable this account before making it the default",
        ));
    }
    let mut tx = state.db.pool().begin().await?;
    sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE")
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
    if req.is_default == Some(true) {
        sqlx::query("UPDATE agent_accounts SET is_default=false WHERE user_id=$1 AND kind=$2")
            .bind(owner)
            .bind(&a.kind)
            .execute(&mut *tx)
            .await?;
    }
    if req.enabled == Some(false) && a.is_default && req.is_default != Some(false) {
        return Err(invalid(
            "choose another default account before disabling this one",
        ));
    }
    let updated = sqlx::query("UPDATE agent_accounts SET name=COALESCE($2,name),is_default=COALESCE($3,is_default),enabled=COALESCE($4,enabled) WHERE id=$1")
        .bind(&id).bind(label).bind(req.is_default).bind(req.enabled).execute(&mut *tx).await;
    if let Err(e) = updated {
        if e.as_database_error()
            .is_some_and(|e| e.is_unique_violation())
        {
            return Err(invalid("an account with that name already exists"));
        }
        return Err(e.into());
    }
    tx.commit().await?;
    Ok(Json(find(&state.db, owner, &id).await?))
}

#[derive(Debug, Clone, Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub scope: String,
    pub status: String,
    pub resets_at: Option<i64>,
    pub used_percent: Option<i16>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Switch {
    pub to_account_id: String,
    pub next_session_id: Option<String>,
    pub state: String,
    pub detail: Option<String>,
    pub after_line: i64,
}
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionAccount {
    pub account: Option<Account>,
    pub limits: Vec<Limit>,
    pub switches: Vec<Switch>,
}

#[utoipa::path(get, path="/api/v1/sessions/{id}/account", tag="accounts", params(("id"=String,Path)), responses((status=200,body=SessionAccount)))]
pub(super) async fn session_account(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<SessionAccount>> {
    let owner = owner(&p)?;
    let id = SessionId::from_stored(id);
    let _session = state
        .db
        .session_of(owner, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    let account = selected(&state.db, owner, &id).await?;
    let switches = sqlx::query_as::<_, Switch>(
        "SELECT * FROM agent_account_switches WHERE session_id=$1 ORDER BY id",
    )
    .bind(id.as_str())
    .fetch_all(state.db.pool())
    .await?;
    let limits = match &account {
        Some(account) => {
            sqlx::query_as::<_, Limit>(
                "SELECT * FROM agent_account_limits WHERE account_id=$1 ORDER BY scope",
            )
            .bind(&account.id)
            .fetch_all(state.db.pool())
            .await?
        }
        None => Vec::new(),
    };
    Ok(Json(SessionAccount {
        account,
        limits,
        switches,
    }))
}

#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SwitchAccount {
    pub account_id: String,
    #[serde(default)]
    pub accept_permission_change: bool,
}
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SwitchedAccount {
    pub session_id: String,
}
#[utoipa::path(post, path="/api/v1/sessions/{id}/account", tag="accounts", params(("id"=String,Path)), request_body=SwitchAccount, responses((status=200,body=SwitchedAccount)))]
pub(super) async fn switch_account(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<SwitchAccount>,
) -> ApiResult<Json<SwitchedAccount>> {
    let owner = owner(&p)?.to_string();
    switch_for(&state, &owner, SessionId::from_stored(id), req).await
}

async fn switch_for(
    state: &AppState,
    owner: &str,
    id: SessionId,
    req: SwitchAccount,
) -> ApiResult<Json<SwitchedAccount>> {
    let session = state
        .db
        .session_of(&owner, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    if session.forgotten_at.is_some() {
        return Err(invalid("this workspace has been removed"));
    }
    let target = find(&state.db, &owner, &req.account_id).await?;
    let kind = Agent::from_name(&target.kind).ok_or_else(|| invalid("unknown agent"))?;
    validate(&state, &owner, &target.id, kind).await?;
    if kind != session.agent && !req.accept_permission_change {
        return Err(invalid(
            "confirm the destination agent’s default permissions before handing off",
        ));
    }
    if !state
        .db
        .presence()
        .await?
        .iter()
        .any(|p| p.host == session.host_id && p.found.kind == kind && p.found.installed)
    {
        return Err(invalid("install this agent on the workspace's host first"));
    }
    if session.status == ft_core::SessionStatus::Working
        || session.status == ft_core::SessionStatus::Starting
    {
        return Err(invalid("stop the current turn before switching accounts"));
    }
    if !state.fleet.asked(&id).await.is_empty() {
        return Err(invalid(
            "answer the pending approval or question before switching accounts",
        ));
    }
    let already_handed_off: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_account_switches WHERE session_id=$1 AND next_session_id IS NOT NULL AND state='continued')")
        .bind(id.as_str()).fetch_one(state.db.pool()).await?;
    if already_handed_off {
        return Err(invalid(
            "this task was already handed off; open its continuation",
        ));
    }
    let source = selected(&state.db, &owner, &id).await?;
    if source.as_ref().is_some_and(|a| a.id == target.id) {
        return Err(invalid("this task already uses that account"));
    }
    let line = state.db.last_agent_line(&id).await?;
    let switch: i64 = sqlx::query_scalar("INSERT INTO agent_account_switches(session_id,from_account_id,to_account_id,after_line) SELECT id,$2,$3,$4 FROM sessions WHERE id=$1 AND status IN ('HandedBack','Failed') AND agent_account_id IS NOT DISTINCT FROM $2 RETURNING id")
        .bind(id.as_str()).bind(source.as_ref().map(|a| &a.id)).bind(&target.id).bind(line).fetch_optional(state.db.pool()).await
        .map_err(|e| if e.as_database_error().is_some_and(|e| e.is_unique_violation()) { invalid("an account switch is already in progress") } else {e.into()})?
        .ok_or_else(||invalid("the task changed while selecting an account; refresh and try again"))?;
    let result =
        super::sessions::continue_with_account(&state, &owner, &session, &target.id, kind).await;
    match result {
        Ok(next) => {
            let detail = format!(
                "Switched from {} to {} · {}",
                source
                    .as_ref()
                    .map(|a| a.name.as_str())
                    .unwrap_or("host account"),
                kind.label(),
                target.name
            );
            sqlx::query("UPDATE agent_account_switches SET state='continued',next_session_id=$2,detail=$3 WHERE id=$1")
                .bind(switch).bind(if next==id {None} else {Some(next.as_str())}).bind(detail).execute(state.db.pool()).await?;
            Ok(Json(SwitchedAccount {
                session_id: next.to_string(),
            }))
        }
        Err(e) => {
            sqlx::query("UPDATE agent_account_switches SET state='failed',detail='The switch did not finish. Your workspace is preserved; retry when the host is ready.' WHERE id=$1").bind(switch).execute(state.db.pool()).await?;
            Err(e)
        }
    }
}

/// Called when the worker publishes a fresh line, even with no browser open.
pub(crate) async fn record_limits(
    db: &crate::db::Db,
    id: &SessionId,
    line: &str,
) -> anyhow::Result<()> {
    let value: serde_json::Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };
    let claude = value.get("type").and_then(|v| v.as_str());
    let codex = value.get("method").and_then(|v| v.as_str());
    let successful = (claude == Some("result") && value["subtype"] == "success")
        || (codex == Some("turn/completed") && value["params"]["turn"]["status"] == "completed");
    if successful {
        sqlx::query("UPDATE agent_account_limits SET status='allowed',observed_at=now() WHERE scope='account' AND account_id=(SELECT agent_account_id FROM sessions WHERE id=$1)")
            .bind(id.as_str()).execute(db.pool()).await?;
    }
    if !matches!(claude, Some("rate_limit_event" | "error"))
        && !matches!(
            codex,
            Some("account/rateLimits/updated" | "error" | "turn/completed")
        )
    {
        return Ok(());
    }
    let Some((agent, _)) = db.session_agent(id).await? else {
        return Ok(());
    };
    let mut reader = ft_core::normalise::Reader::for_agent(agent);
    for event in reader.push(line) {
        if let TurnEvent::Limited {
            window,
            status,
            resets_at,
            used_percent,
        } = event
        {
            sqlx::query("INSERT INTO agent_account_limits(account_id,scope,status,resets_at,used_percent) SELECT agent_account_id,$2,$3,$4,$5 FROM sessions WHERE id=$1 AND agent_account_id IS NOT NULL ON CONFLICT(account_id,scope) DO UPDATE SET status=excluded.status,resets_at=excluded.resets_at,used_percent=excluded.used_percent,observed_at=now()")
                .bind(id.as_str()).bind(window).bind(status).bind(resets_at).bind(used_percent.map(i16::from)).execute(db.pool()).await?;
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize, ToSchema, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fallback {
    pub enabled: bool,
    pub account_ids: Vec<String>,
}
#[utoipa::path(get, path="/api/v1/sessions/{id}/fallback", tag="accounts", params(("id"=String,Path)), responses((status=200,body=Fallback)))]
pub(super) async fn get_fallback(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Fallback>> {
    state
        .db
        .session_of(owner(&p)?, &SessionId::from_stored(id.clone()))
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    let row: Option<(bool, serde_json::Value)> =
        sqlx::query_as("SELECT enabled,account_ids FROM agent_fallbacks WHERE session_id=$1")
            .bind(id)
            .fetch_optional(state.db.pool())
            .await?;
    Ok(Json(match row {
        Some((enabled, ids)) => Fallback {
            enabled,
            account_ids: serde_json::from_value(ids).unwrap_or_default(),
        },
        None => Fallback::default(),
    }))
}
#[utoipa::path(put, path="/api/v1/sessions/{id}/fallback", tag="accounts", params(("id"=String,Path)), request_body=Fallback, responses((status=200,body=Fallback)))]
pub(super) async fn set_fallback(
    State(state): State<AppState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<Fallback>,
) -> ApiResult<Json<Fallback>> {
    let owner = owner(&p)?;
    state
        .db
        .session_of(owner, &SessionId::from_stored(id.clone()))
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    if req.account_ids.len() > 10 || (req.enabled && req.account_ids.is_empty()) {
        return Err(invalid("choose between one and ten fallback accounts"));
    }
    let mut seen = std::collections::HashSet::new();
    for account in &req.account_ids {
        if !seen.insert(account) {
            return Err(invalid("each fallback account can only appear once"));
        }
        let a = find(&state.db, owner, account).await?;
        let kind = Agent::from_name(&a.kind).ok_or_else(|| invalid("unknown agent"))?;
        if req.enabled {
            validate(&state, owner, account, kind).await?;
        }
    }
    sqlx::query("INSERT INTO agent_fallbacks(session_id,enabled,account_ids) VALUES($1,$2,$3) ON CONFLICT(session_id) DO UPDATE SET enabled=excluded.enabled,account_ids=excluded.account_ids,updated_at=now()")
        .bind(id).bind(req.enabled).bind(serde_json::json!(req.account_ids)).execute(state.db.pool()).await?;
    Ok(Json(req))
}

/// Runs without a browser. Only explicit quota rejection can spend an explicitly
/// selected fallback; percentages, auth failures and throttling never trigger it.
pub(crate) async fn watch_fallbacks(state: AppState) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        interval.tick().await;
        if let Err(e) = fallback_tick(&state).await {
            tracing::warn!("checking account fallbacks: {e:#}");
        }
    }
}
async fn fallback_tick(state: &AppState) -> anyhow::Result<()> {
    let rows: Vec<(String,String,serde_json::Value)> = sqlx::query_as("SELECT s.id,s.user_id,f.account_ids FROM agent_fallbacks f JOIN sessions s ON s.id=f.session_id WHERE f.enabled AND s.status IN ('HandedBack','Failed') AND EXISTS(SELECT 1 FROM agent_account_limits l WHERE l.account_id=s.agent_account_id AND l.status IN ('blocked','rejected') AND (l.resets_at IS NULL OR l.resets_at > extract(epoch from now()))) AND NOT EXISTS(SELECT 1 FROM agent_account_switches x WHERE x.session_id=s.id AND (x.state='switching' OR x.next_session_id IS NOT NULL))")
        .fetch_all(state.db.pool()).await?;
    for (session, owner, ids) in rows {
        let id = SessionId::from_stored(session.clone());
        if !state.fleet.asked(&id).await.is_empty() {
            continue;
        }
        let current = selected(&state.db, &owner, &id).await?;
        let ids: Vec<String> = serde_json::from_value(ids)?;
        let tried: Vec<String> = sqlx::query_scalar("SELECT DISTINCT used.account_id FROM agent_account_switches x JOIN agent_fallbacks f ON f.session_id=x.session_id CROSS JOIN LATERAL unnest(ARRAY[x.from_account_id,x.to_account_id]) AS used(account_id) WHERE x.session_id=$1 AND x.created_at>=f.updated_at AND used.account_id IS NOT NULL")
            .bind(&session).fetch_all(state.db.pool()).await?;
        let target = ids
            .iter()
            .find(|a| !tried.contains(a) && current.as_ref().is_none_or(|c| &c.id != *a));
        let Some(target) = target else {
            continue;
        };
        match switch_for(
            state,
            &owner,
            id,
            SwitchAccount {
                account_id: target.clone(),
                accept_permission_change: true,
            },
        )
        .await
        {
            Ok(Json(next)) if next.session_id != session => {
                // Carry only the untried remainder across an agent handoff.
                let remainder: Vec<_> = ids
                    .iter()
                    .filter(|a| {
                        *a != target
                            && !tried.contains(a)
                            && current.as_ref().is_none_or(|c| &c.id != *a)
                    })
                    .collect();
                sqlx::query("INSERT INTO agent_fallbacks(session_id,enabled,account_ids) VALUES($1,$2,$3) ON CONFLICT(session_id) DO NOTHING")
                    .bind(next.session_id).bind(!remainder.is_empty()).bind(serde_json::json!(remainder)).execute(state.db.pool()).await?;
                sqlx::query("UPDATE agent_fallbacks SET enabled=false WHERE session_id=$1")
                    .bind(&session)
                    .execute(state.db.pool())
                    .await?;
            }
            Ok(_) => (),
            Err(e) => {
                tracing::warn!(session=%session,"automatic account switch paused: {:?}",e.code);
                sqlx::query("UPDATE agent_fallbacks SET enabled=false WHERE session_id=$1")
                    .bind(&session)
                    .execute(state.db.pool())
                    .await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    async fn account(db: &Db, owner: &str, id: &str, label: &str) {
        sqlx::query("INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state) VALUES($1,$2,'ClaudeCode',$3,'Subscription',$1,'pending')")
            .bind(id).bind(owner).bind(label).execute(db.pool()).await.unwrap();
    }
    async fn session(db: &Db, owner: &str) -> SessionId {
        let host = db
            .ensure_host("test", ft_core::Compute::Local)
            .await
            .unwrap();
        let id = SessionId::new();
        db.insert_session(
            &id,
            &host.id,
            owner,
            None,
            "task",
            "do the task",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
        id
    }
    #[tokio::test]
    async fn account_selection_is_pinned_and_owner_scoped() {
        let (db, owner) = Db::open_for_test_owned().await.unwrap();
        let vault = vault::Vault::new(db.pool().clone(), vault::crypto::RootKey::generate());
        account(&db, &owner, "first", "Team").await;
        connect(&db, &vault, &owner, "first", "team-token")
            .await
            .unwrap();
        let first = session(&db, &owner).await;
        account(&db, &owner, "second", "Personal").await;
        connect(&db, &vault, &owner, "second", "personal-token")
            .await
            .unwrap();
        sqlx::query("UPDATE agent_accounts SET is_default=false WHERE id='first'")
            .execute(db.pool())
            .await
            .unwrap();
        sqlx::query("UPDATE agent_accounts SET is_default=true WHERE id='second'")
            .execute(db.pool())
            .await
            .unwrap();
        let second = session(&db, &owner).await;
        assert_eq!(
            selected(&db, &owner, &first).await.unwrap().unwrap().id,
            "first"
        );
        assert_eq!(
            selected(&db, &owner, &second).await.unwrap().unwrap().id,
            "second"
        );
        assert!(find(&db, "another-user", "first").await.is_err());
        assert!(selected(&db, "another-user", &first)
            .await
            .unwrap()
            .is_none());
        let first_env = super::super::agents::agent_credential(
            &db,
            &vault,
            Agent::ClaudeCode,
            &owner,
            &first,
            "test",
        )
        .await
        .unwrap();
        let second_env = super::super::agents::agent_credential(
            &db,
            &vault,
            Agent::ClaudeCode,
            &owner,
            &second,
            "test",
        )
        .await
        .unwrap();
        assert_eq!(first_env[0].1 .0, "team-token");
        assert_eq!(second_env[0].1 .0, "personal-token");
        let public = serde_json::to_string(&find(&db, &owner, "first").await.unwrap()).unwrap();
        assert!(!public.contains("credentialKey"));
        assert!(!public.contains("team-token"));
    }
    #[tokio::test]
    async fn duplicate_credentials_do_not_replace_the_original() {
        let (db, owner) = Db::open_for_test_owned().await.unwrap();
        let vault = vault::Vault::new(db.pool().clone(), vault::crypto::RootKey::generate());
        account(&db, &owner, "a", "Team").await;
        account(&db, &owner, "b", "Personal").await;
        connect(&db, &vault, &owner, "a", "one-token")
            .await
            .unwrap();
        assert!(connect(&db, &vault, &owner, "b", "one-token")
            .await
            .is_err());
        assert!(!vault
            .holds(Key::of(vault::AGENT, "b", &owner))
            .await
            .unwrap());
        assert_eq!(find(&db, &owner, "a").await.unwrap().revision, 1);
    }
    #[tokio::test]
    async fn migration_preserves_credentials_sessions_and_host_local_auth() {
        let (db, owner) = Db::open_for_test_owned().await.unwrap();
        // Reconstruct the immediately preceding schema, then apply the exact
        // upgrade SQL to real existing users, encrypted secrets and sessions.
        sqlx::raw_sql("DROP TABLE agent_fallbacks; DROP TABLE agent_account_limits; DROP TABLE agent_account_switches; DROP TRIGGER pin_agent_account ON sessions; DROP FUNCTION pin_agent_account(); ALTER TABLE sessions DROP COLUMN agent_account_id; DROP TABLE agent_accounts;")
            .execute(db.pool()).await.unwrap();
        db.set_agent_mode(&owner, Agent::ClaudeCode, AgentMode::Subscription, true)
            .await
            .unwrap();
        db.set_agent_mode(&owner, Agent::Codex, AgentMode::Subscription, true)
            .await
            .unwrap();
        let vault = vault::Vault::new(db.pool().clone(), vault::crypto::RootKey::generate());
        vault
            .put(
                Key::of(vault::AGENT, "ClaudeCode", &owner),
                "existing-token",
                "test setup",
            )
            .await
            .unwrap();
        let id = session(&db, &owner).await;
        let ciphertext: Vec<u8> =
            sqlx::query_scalar("SELECT ciphertext FROM secrets WHERE owner=$1")
                .bind(&owner)
                .fetch_one(db.pool())
                .await
                .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../../migrations/server/20260910130000_agent_accounts.sql"
        ))
        .execute(db.pool())
        .await
        .unwrap();
        let migrated = selected(&db, &owner, &id).await.unwrap().unwrap();
        assert_eq!(migrated.name, "Default account");
        assert_eq!(migrated.credential_key, "ClaudeCode");
        assert!(migrated.credential_set);
        let after: Vec<u8> = sqlx::query_scalar("SELECT ciphertext FROM secrets WHERE owner=$1")
            .bind(&owner)
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(
            ciphertext, after,
            "migration must not rewrite encrypted credentials"
        );
        assert_eq!(
            vault
                .get(Key::of(vault::AGENT, "ClaudeCode", &owner), "after upgrade")
                .await
                .unwrap()
                .unwrap()
                .as_str(),
            "existing-token"
        );
        let host_local = default_account(&db, &owner, Agent::Codex)
            .await
            .unwrap()
            .unwrap();
        assert!(!host_local.credential_set);
        assert_eq!(
            db.session(&id).await.unwrap().unwrap().prompt,
            "do the task"
        );
    }
    #[tokio::test]
    async fn independent_quota_windows_do_not_overwrite_each_other() {
        let (db, owner) = Db::open_for_test_owned().await.unwrap();
        account(&db, &owner, "a", "Team").await;
        sqlx::query("UPDATE agent_accounts SET is_default=true,state='connected' WHERE id='a'")
            .execute(db.pool())
            .await
            .unwrap();
        let id = session(&db, &owner).await;
        record_limits(&db,&id,r#"{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"rejected","resetsAt":9999999999}}"#).await.unwrap();
        record_limits(&db,&id,r#"{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"seven_day","status":"allowed"}}"#).await.unwrap();
        let rows: Vec<Limit> =
            sqlx::query_as("SELECT * FROM agent_account_limits WHERE account_id='a'")
                .fetch_all(db.pool())
                .await
                .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|l| l.scope == "five_hour" && l.status == "rejected"));
    }
}

pub(super) async fn ensure_not_switching(
    db: &crate::db::Db,
    id: &SessionId,
) -> Result<(), ApiError> {
    let changing:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM agent_account_switches WHERE session_id=$1 AND state='switching')")
        .bind(id.as_str()).fetch_one(db.pool()).await?;
    if changing {
        return Err(invalid("wait for the account switch to finish"));
    }
    Ok(())
}
