//! Answering a deletion an agent asked for.
//!
//! **This is the half an agent cannot reach.** Its only door to the control
//! plane is `delegate.rs`'s tool dispatch — it has no API token, only a
//! session id handed to a local worker — and none of these three paths is on
//! that list. So "an agent can never delete on its own" is a property of the
//! shape rather than a check somebody has to remember to write.
//!
//! ## Approve re-reads everything
//!
//! A request records what was *asked*. It is not a capability to delete
//! whatever that id now points at, so [`approve_deletion`] re-reads the
//! object, re-computes what it takes with it, and runs the same delete the
//! person's own button runs — including every refusal that one makes. A
//! profile that has since been put into somebody else's team is refused here
//! exactly as it would be there.
//!
//! And the grant checked is the **approver's**, never the asker's. An agent
//! running as somebody who may only read a team cannot have the request
//! approved into a delete it was never entitled to: the delete runs as the
//! person pressing the button, under their own grants.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Level;
use crate::auth::Principal;
use crate::removals::{Kind, Request};
use crate::AppState;
use axum::{
    extract::{Path, State},
    Extension, Json,
};

/// What a person is asked to decide.
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    #[serde(flatten)]
    pub request: Request,
    /// What it takes with it **now**, re-read rather than replayed from the
    /// row. The tree may have grown a branch since the agent asked, and the
    /// number somebody approves has to be the number that happens.
    pub takes: String,
    /// Whether the object is still there at all.
    pub gone: bool,
}

/// Every deletion waiting on somebody in this organisation.
#[utoipa::path(
    get, path = "/api/v1/deletion-requests", tag = "deletions",
    responses((status = 200, body = Vec<Waiting>)),
)]
pub(super) async fn list_deletion_requests(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Waiting>>> {
    let me = whoever(&principal)?;
    let mut out = Vec::new();
    for request in state.removals.waiting(me.org_id.as_str()).await? {
        let (takes, gone) = consequence_now(&state, me.id.as_str(), &request).await?;
        out.push(Waiting {
            request,
            takes,
            gone,
        });
    }
    Ok(Json(out))
}

/// Say yes, and delete it.
#[utoipa::path(
    post, path = "/api/v1/deletion-requests/{id}/approve", tag = "deletions",
    params(("id" = String, Path)),
    responses((status = 200, body = Request), (status = 404)),
)]
pub(super) async fn approve_deletion(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Request>> {
    let me = whoever(&principal)?;
    let request = state
        .removals
        .one(me.org_id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("deletion request"))?;
    if request.state != "pending" {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("that was already {} — nothing to approve", request.state),
        ));
    }

    /* **The delete runs first, and only then is the row marked done.** The
       other order would mark a request answered and then discover the delete
       is refused, leaving the thing alive with nothing on screen saying
       anybody ever asked. */
    match request.kind {
        Kind::AgentTeam => {
            if !state
                .agent_teams
                .delete(me.id.as_str(), &request.target)
                .await?
            {
                // Either gone already or not theirs to delete. Both are
                // answered the same way: the question stops being open.
                state
                    .removals
                    .decide(&id, "refused", me.id.as_str(), Some("it was already gone"))
                    .await?;
                return Err(ApiError::not_found("agent team"));
            }
        }
        Kind::Role => {
            // The same refusal the person's own button gets, named teams and
            // all — see `api::roles::delete_role`, which this mirrors rather
            // than bypasses.
            let (held, teams) = state
                .agent_teams
                .standing_on(me.id.as_str(), &request.target)
                .await?;
            if held > 0 {
                return Err(ApiError::new(
                    ErrorCode::InvalidRequest,
                    match teams.is_empty() {
                        true => format!(
                            "this profile holds {held} position{} in teams you cannot see. Ask \
                             whoever owns them to take it out first.",
                            if held == 1 { "" } else { "s" }
                        ),
                        false => format!(
                            "this profile holds {held} position{} in {}. Take it out first.",
                            if held == 1 { "" } else { "s" },
                            teams.join(", ")
                        ),
                    },
                ));
            }
            if !state.roles.delete(me.id.as_str(), &request.target).await? {
                state
                    .removals
                    .decide(&id, "refused", me.id.as_str(), Some("it was already gone"))
                    .await?;
                return Err(ApiError::not_found("role"));
            }
        }
    }

    // Two people pressing at once settle it once. The delete above is
    // idempotent in effect — the second finds nothing and has already
    // returned — so losing this race is not a second deletion.
    state.removals.decide(&id, "done", me.id.as_str(), None).await?;
    let after = state
        .removals
        .one(me.org_id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("deletion request"))?;
    Ok(Json(after))
}

/// Say no.
///
/// The note is carried back to the agent, which is why it is worth writing
/// one: a refusal with a reason is the difference between an agent that asks
/// again tomorrow and one that does not.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub note: Option<String>,
}

#[utoipa::path(
    post, path = "/api/v1/deletion-requests/{id}/refuse", tag = "deletions",
    params(("id" = String, Path)), request_body = Refusal,
    responses((status = 200, body = Request), (status = 404)),
)]
pub(super) async fn refuse_deletion(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<Refusal>,
) -> ApiResult<Json<Request>> {
    let me = whoever(&principal)?;
    let request = state
        .removals
        .one(me.org_id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("deletion request"))?;
    if request.state != "pending" {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("that was already {}", request.state),
        ));
    }
    state
        .removals
        .decide(&id, "refused", me.id.as_str(), body.note.as_deref())
        .await?;
    let after = state
        .removals
        .one(me.org_id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("deletion request"))?;
    Ok(Json(after))
}

/// What deleting this would take with it, read now rather than replayed.
pub(crate) async fn consequence_now(
    state: &AppState,
    me: &str,
    request: &Request,
) -> anyhow::Result<(String, bool)> {
    match request.kind {
        Kind::AgentTeam => match state.agent_teams.one(me, &request.target, Level::Viewer).await? {
            None => Ok(("It is not there any more.".into(), true)),
            Some(team) => Ok((
                format!(
                    "{} and its {} position{}. Every profile in it is left alone.",
                    team.name,
                    team.positions.len(),
                    if team.positions.len() == 1 { "" } else { "s" }
                ),
                false,
            )),
        },
        Kind::Role => {
            let role = state.roles.one(me, &request.target, Level::Viewer).await?;
            let Some(role) = role else {
                return Ok(("It is not there any more.".into(), true));
            };
            let (held, teams) = state.agent_teams.standing_on(me, &request.target).await?;
            Ok((
                match held {
                    0 => format!(
                        "{}. No team stands on it, so nothing else changes.",
                        role.name
                    ),
                    _ => format!(
                        "{} — but it holds {held} position{} in {}, so the delete will be \
                         refused until it is taken out.",
                        role.name,
                        if held == 1 { "" } else { "s" },
                        if teams.is_empty() {
                            "teams you cannot see".to_string()
                        } else {
                            teams.join(", ")
                        }
                    ),
                },
                false,
            ))
        }
    }
}
