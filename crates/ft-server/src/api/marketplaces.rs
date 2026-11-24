//! Where plugins come from, and taking a copy of one.
//!
//! **Refreshing a catalogue and installing from it are different acts.** A
//! refresh rewrites a list of what is on offer and touches nothing anybody
//! has. An install takes a copy, pinned to the commit the list was read at,
//! and from then on that copy is yours — an upstream that changes, renames
//! itself or disappears cannot reach it.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Deserialize;
use utoipa::ToSchema;

use super::access::whoever;
use super::{ApiError, ApiResult, AppState, ErrorCode};
use crate::auth::Principal;
use crate::marketplace::{self, Listed, Market};

/// A repository to read.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddMarket {
    /// A GitHub repository, as somebody would paste it.
    pub url: String,
    /// Which branch or tag. `main` when unsaid.
    #[serde(default)]
    pub git_ref: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    #[serde(default)]
    pub q: Option<String>,
}

#[utoipa::path(
    get, path = "/api/v1/marketplaces", tag = "marketplaces",
    responses((status = 200, body = Vec<Market>)),
)]
pub(super) async fn list_marketplaces(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Market>>> {
    let me = whoever(&principal)?;
    let got = marketplace::list(state.skills.pool(), me.org_id.as_str())
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok(Json(got))
}

/// Add a source and read it at once.
///
/// **The fetch is not deferred.** Somebody who pastes an address is asking
/// whether it works; answering "added" and failing quietly in the background
/// is answering a question they did not ask.
#[utoipa::path(
    post, path = "/api/v1/marketplaces", tag = "marketplaces",
    request_body = AddMarket,
    responses((status = 201, body = Market), (status = 400, body = ApiError)),
)]
pub(super) async fn add_marketplace(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<AddMarket>,
) -> ApiResult<(StatusCode, Json<Market>)> {
    let me = whoever(&principal)?;
    let pool = state.skills.pool();
    let git_ref = body.git_ref.unwrap_or_else(|| "main".into());

    let id = marketplace::add(
        pool,
        me.org_id.as_str(),
        Some(me.id.as_str()),
        &body.url,
        &git_ref,
        false,
    )
    .await
    .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;

    read_now(&state, &id, &body.url, &git_ref).await?;
    mine(&state, me.org_id.as_str(), &id).await.map(|m| (StatusCode::CREATED, Json(m)))
}

#[utoipa::path(
    post, path = "/api/v1/marketplaces/{id}/refresh", tag = "marketplaces",
    params(("id" = String, Path, description = "Marketplace")),
    responses((status = 200, body = Market), (status = 404, body = ApiError)),
)]
pub(super) async fn refresh_marketplace(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Market>> {
    let me = whoever(&principal)?;
    let pool = state.skills.pool();
    let (url, git_ref, _) = marketplace::one(pool, me.org_id.as_str(), &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?
        .ok_or_else(|| ApiError::not_found("marketplace"))?;
    read_now(&state, &id, &url, &git_ref).await?;
    mine(&state, me.org_id.as_str(), &id).await.map(Json)
}

#[utoipa::path(
    delete, path = "/api/v1/marketplaces/{id}", tag = "marketplaces",
    params(("id" = String, Path, description = "Marketplace")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn remove_marketplace(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let gone = marketplace::remove(state.skills.pool(), me.org_id.as_str(), &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;
    if !gone {
        return Err(ApiError::not_found("marketplace"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get, path = "/api/v1/marketplaces/entries", tag = "marketplaces",
    params(("q" = Option<String>, Query, description = "Filter by name or description")),
    responses((status = 200, body = Vec<Listed>)),
)]
pub(super) async fn list_entries(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(search): Query<Search>,
) -> ApiResult<Json<Vec<Listed>>> {
    let me = whoever(&principal)?;
    let got = marketplace::entries(state.skills.pool(), me.org_id.as_str(), search.q.as_deref())
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok(Json(got))
}

/// Take a copy of one entry.
#[utoipa::path(
    post, path = "/api/v1/marketplaces/{id}/entries/{slug}/install", tag = "marketplaces",
    params(
        ("id" = String, Path, description = "Marketplace"),
        ("slug" = String, Path, description = "Entry"),
    ),
    responses((status = 201, body = crate::skills::Skill), (status = 400, body = ApiError)),
)]
pub(super) async fn install_entry(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, slug)): Path<(String, String)>,
) -> ApiResult<(StatusCode, Json<crate::skills::Skill>)> {
    let me = whoever(&principal)?;
    let pool = state.skills.pool();

    let (source, market_url, commit, name, description) =
        marketplace::address_of(pool, me.org_id.as_str(), &id, &slug)
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?
            .ok_or_else(|| ApiError::not_found("plugin"))?;

    let files = marketplace::files_of(&source, &market_url, &commit, None)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    // Read before the bytes are encoded, because this is the step that makes
    // an installed plugin work at all: without it the skills land and the
    // tools silently do not.
    let connector = marketplace::connector_of(&files);

    let incoming: Vec<crate::skills::IncomingFile> = files
        .iter()
        .map(|(path, body)| crate::skills::IncomingFile {
            path: path.clone(),
            contents: ft_proto::encode(body),
            executable: false,
        })
        .collect();

    let new = crate::skills::NewSkill {
        name: name.clone(),
        description,
        frontmatter: serde_json::json!({ "name": name }),
        body: String::new(),
        files: incoming,
        notes: None,
        kind: Some("plugin".into()),
    };
    crate::skills::check(&new).map_err(|e| ApiError::new(ErrorCode::InvalidRequest, e.0))?;

    let made = state
        .skills
        .create(me.org_id.as_str(), me.id.as_str(), &me.slug, &new, false)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    if let Some((server, url, auth, borrow)) = connector {
        state
            .skills
            .set_connector(made.as_str(), &server, &url, &auth)
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;
        if let Some(kind) = borrow {
            sqlx::query("UPDATE connectors SET borrow = $2 WHERE skill_id = $1")
                .bind(made.as_str())
                .bind(kind)
                .execute(pool)
                .await
                .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;
        }
    }

    // The pin, so the row can later say there is a newer one.
    if let Ok(Some(version)) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT current_version_id FROM skills WHERE id = $1",
    )
    .bind(made.as_str())
    .fetch_one(pool)
    .await
    {
        let _ = marketplace::pin(pool, &version, &id, &slug, &commit).await;
    }

    let skill = state
        .skills
        .one(me.id.as_str(), made.as_str(), crate::access::Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("plugin"))?;
    Ok((StatusCode::CREATED, Json(skill)))
}

/// Read a repository now, and record the failure rather than throwing it away.
async fn read_now(state: &AppState, id: &str, url: &str, git_ref: &str) -> Result<(), ApiError> {
    let pool = state.skills.pool();
    match marketplace::fetch(url, git_ref, None).await {
        Ok(got) => marketplace::save(pool, id, &got)
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}"))),
        Err(e) => {
            let why = format!("{e:#}");
            let _ = marketplace::failed(pool, id, &why).await;
            Err(ApiError::new(ErrorCode::ActionFailed, why))
        }
    }
}

async fn mine(state: &AppState, org: &str, id: &str) -> Result<Market, ApiError> {
    marketplace::list(state.skills.pool(), org)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| ApiError::not_found("marketplace"))
}
