//! What Firetower holds, and every time it was touched.
//!
//! Names and history are ordinary reads. A value comes back from exactly one
//! route, and that one writes to the access log before it answers — which is
//! the only thing standing between a stored token and a quiet copy of it.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::vault::Key;
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A credential Firetower holds. Its name, and nothing else.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeldSecret {
    pub scope: String,
    pub name: String,
    /// Yours rather than the install's. What the screen says, so it never has
    /// to show an account id.
    pub mine: bool,
}

/// One line of the access log.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    pub id: i64,
    pub scope: String,
    pub name: String,
    /// `Write`, `Read`, `Delete`, or `Failed`.
    pub action: String,
    /// What the credential was wanted for, in words.
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    /// Where the key that unlocks all of this lives — in words, never the key.
    pub root_key: String,
    pub held: Vec<HeldSecret>,
    pub access: Vec<AccessEntry>,
    /// Whether the log's chain of digests still holds end to end.
    pub intact: bool,
    /// The first entry that doesn't follow from the one before it, if any.
    pub broken_at: Option<i64>,
}

/// What is stored, and every time it was touched.
///
/// Names and history only. A value comes back from exactly one route, which is
/// `reveal_secret` below, and that one writes to the log before it answers.
#[utoipa::path(
    get, path = "/api/v1/secrets", tag = "secrets",
    responses((status = 200, body = VaultView)),
)]
pub(super) async fn list_secrets(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<VaultView>> {
    // Yours, and the install's own. Somebody else's git token is not something
    // this screen has any business naming, let alone revealing.
    let mine = principal.owner().unwrap_or("");
    let (intact, broken_at) = match state.vault.verify().await? {
        vault::Verification::Intact { .. } => (true, None),
        vault::Verification::Broken { at } => (false, Some(at)),
    };

    Ok(Json(VaultView {
        root_key: state.key_source.to_string(),
        held: state
            .vault
            .names()
            .await?
            .into_iter()
            .filter(|held| held.owner.is_empty() || held.owner == mine)
            .map(|held| HeldSecret {
                scope: held.scope,
                name: held.name,
                // So the screen can say "yours" rather than showing an
                // account id nobody reads.
                mine: held.owner == mine && !held.owner.is_empty(),
            })
            .collect(),
        access: state
            .vault
            .access(100)
            .await?
            .into_iter()
            .filter(|a| a.owner.is_empty() || a.owner == mine)
            .map(|a| AccessEntry {
                id: a.id,
                scope: a.scope,
                name: a.name,
                action: a.action,
                reason: a.reason,
                at: a.at.to_rfc3339(),
            })
            .collect(),
        intact,
        broken_at,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSecret {
    /// What to store from now on. The previous value is not recoverable.
    pub value: String,
}

/// A value, on its way to a person who asked for it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecret {
    pub scope: String,
    pub name: String,
    pub value: String,
}

/// Which row a screen means by a scope and a name.
///
/// Yours if you have one, the install's otherwise — and never anybody else's,
/// because the path carries no owner and so there is no way to ask for one.
/// Two people both looking at `git/github` are each looking at their own.
async fn which<'a>(
    state: &AppState,
    scope: &'a str,
    name: &'a str,
    mine: &'a str,
) -> Result<Key<'a>, ApiError> {
    if !mine.is_empty() {
        let yours = Key::of(scope, name, mine);
        if state.vault.holds(yours).await? {
            return Ok(yours);
        }
    }
    Ok(Key::shared(scope, name))
}

/// Put a credential on screen.
///
/// A `POST` because it changes something: it writes a `Reveal` into the access
/// log, which is what makes this defensible at all. A `GET` would also sit in
/// browser history and proxy logs, which a credential shouldn't.
///
/// This is the one route that hands a stored value back, and it exists because
/// a credential you cannot inspect is one you cannot verify or copy elsewhere.
/// The cost is real: anything that can reach this API can read every token
/// here, and the log is what is left to notice it.
#[utoipa::path(
    post, path = "/api/v1/secrets/{scope}/{name}/reveal", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    responses((status = 200, body = RevealedSecret), (status = 404, body = ApiError)),
)]
pub(super) async fn reveal_secret(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((scope, name)): Path<(String, String)>,
) -> ApiResult<Json<RevealedSecret>> {
    let mine = principal.owner().unwrap_or("");
    let key = which(&state, &scope, &name, mine).await?;

    let value = state
        .vault
        .reveal(key, "shown on the Secrets screen")
        .await?
        .ok_or_else(|| ApiError::not_found("secret"))?;

    Ok(Json(RevealedSecret {
        scope,
        name,
        value: value.to_string(),
    }))
}

/// Replace a credential with a new one.
///
/// Only for a name that already exists. Storing under an arbitrary name would
/// let this screen fill up with values nothing ever reads — what a credential is
/// *for* is decided where it is used, not here.
#[utoipa::path(
    put, path = "/api/v1/secrets/{scope}/{name}", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    request_body = ReplaceSecret,
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn replace_secret(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((scope, name)): Path<(String, String)>,
    Json(req): Json<ReplaceSecret>,
) -> ApiResult<StatusCode> {
    let mine = principal.owner().unwrap_or("");
    let key = which(&state, &scope, &name, mine).await?;
    let value = req.value.trim();
    if value.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "paste the new value, or remove this credential instead",
        ));
    }

    if !state.vault.holds(key).await? {
        return Err(ApiError::not_found("secret"));
    }

    state
        .vault
        .put(key, value, "replaced on the Secrets screen")
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove a credential.
///
/// Whatever used it goes back to having none — an agent shows as needing one
/// again, a git host shows as not authorized. The log entry stays.
#[utoipa::path(
    delete, path = "/api/v1/secrets/{scope}/{name}", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    responses((status = 204)),
)]
pub(super) async fn remove_secret(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((scope, name)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let mine = principal.owner().unwrap_or("");
    let key = which(&state, &scope, &name, mine).await?;
    state
        .vault
        .forget(key, "removed on the Secrets screen")
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
