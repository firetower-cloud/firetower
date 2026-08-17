//! Signing in, signing out, and replacing a password.
//!
//! `auth` rather than `sessions`: a session in Firetower is an agent working on
//! a branch, and two meanings for one noun in one API is how somebody calls the
//! wrong endpoint.

use super::{ApiError, ApiResult, ErrorCode};
use crate::accounts::User;
use crate::auth::Principal;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use utoipa::ToSchema;

/// How many wrong passwords before a username is left alone for a while.
const ATTEMPTS: usize = 10;
const LOCKOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

/// What a browser gets for a correct password.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SignedIn {
    /// Sent back on every later request. Said once — only its hash is kept.
    pub token: String,
    pub user: User,
}

/// Who the caller is, and what they belong to.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    pub user: User,
    /// Absent until setting up has finished.
    pub organization: Option<crate::accounts::Organization>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewPassword {
    /// The one in use. Required even when it came from a file: knowing the
    /// session token should not be enough to lock the owner out.
    pub current: String,
    pub new: String,
}

#[utoipa::path(
    post, path = "/api/v1/auth/login", tag = "auth",
    request_body = Credentials,
    responses(
        (status = 200, body = SignedIn),
        (status = 401, body = ApiError, description = "Wrong, or too many tries"),
    ),
)]
pub(super) async fn login(
    State(state): State<AppState>,
    Json(credentials): Json<Credentials>,
) -> ApiResult<Json<SignedIn>> {
    let username = credentials.username.trim().to_string();

    if locked_out(&username) {
        return Err(ApiError::new(
            ErrorCode::Unauthorized,
            "too many attempts. Wait a few minutes and try again.",
        ));
    }

    let Some(user) = state
        .accounts
        .authenticate(&username, &credentials.password)
        .await?
    else {
        record_failure(&username);
        // One message for both "no such user" and "wrong password". The
        // difference is how somebody learns which usernames exist.
        return Err(ApiError::new(
            ErrorCode::Unauthorized,
            "that username and password don't match",
        ));
    };

    forget_failures(&username);
    let token = state.accounts.open_session(&user.id).await?;

    tracing::info!(user = %user.username, "signed in");
    Ok(Json(SignedIn { token, user }))
}

#[utoipa::path(
    post, path = "/api/v1/auth/logout", tag = "auth",
    responses((status = 204, description = "Signed out")),
)]
pub(super) async fn logout(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> ApiResult<StatusCode> {
    // The token that is being ended is the one that arrived, which the
    // middleware has already checked. Reading it again here is cheaper than
    // carrying it through the principal, and it cannot be a different one.
    if let Some(token) = bearer(&headers) {
        state.accounts.close_session(&token).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get, path = "/api/v1/auth/me", tag = "auth",
    responses((status = 200, body = Me)),
)]
pub(super) async fn me(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Me>> {
    let user = principal
        .user
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    Ok(Json(Me {
        user,
        organization: state.accounts.organization().await?,
    }))
}

#[utoipa::path(
    post, path = "/api/v1/auth/password", tag = "auth",
    request_body = NewPassword,
    responses(
        (status = 204, description = "Changed. Every browser is now signed out."),
        (status = 400, body = ApiError, description = "Too short, or the current one is wrong"),
    ),
)]
pub(super) async fn change_password(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<NewPassword>,
) -> ApiResult<StatusCode> {
    let user = principal
        .user
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "nobody is signed in"))?;

    if state
        .accounts
        .authenticate(&user.username, &request.current)
        .await?
        .is_none()
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that isn't the current password",
        ));
    }

    state
        .accounts
        .set_password(&user.id, &request.new)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;

    tracing::info!(user = %user.username, "password changed; every session ended");
    Ok(StatusCode::NO_CONTENT)
}

fn bearer(headers: &axum::http::HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, rest) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| rest.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Failed attempts, per username.
///
/// In memory, not in the database: this is a speed bump against guessing, and
/// losing it on restart costs an attacker one restart's worth of patience.
/// Keyed by username rather than by address, because the address is the easy
/// half to vary.
fn failures() -> &'static Mutex<HashMap<String, (usize, std::time::Instant)>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, (usize, std::time::Instant)>>> =
        OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn locked_out(username: &str) -> bool {
    let held = failures().lock().unwrap();
    match held.get(username) {
        Some((count, since)) => *count >= ATTEMPTS && since.elapsed() < LOCKOUT,
        None => false,
    }
}

fn record_failure(username: &str) {
    let mut held = failures().lock().unwrap();
    let entry = held
        .entry(username.to_string())
        .or_insert((0, std::time::Instant::now()));

    // A window that has passed starts again, so a wrong password on Monday and
    // another on Friday are not two thirds of a lockout.
    if entry.1.elapsed() >= LOCKOUT {
        *entry = (0, std::time::Instant::now());
    }
    entry.0 += 1;
}

fn forget_failures(username: &str) {
    failures().lock().unwrap().remove(username);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_username_is_left_alone_after_enough_wrong_guesses() {
        let who = "someone-for-this-test";
        forget_failures(who);
        assert!(!locked_out(who));

        for _ in 0..ATTEMPTS {
            record_failure(who);
        }
        assert!(locked_out(who));

        // Signing in correctly clears it, so one forgotten password does not
        // cost the rest of the afternoon.
        forget_failures(who);
        assert!(!locked_out(who));
    }
}
