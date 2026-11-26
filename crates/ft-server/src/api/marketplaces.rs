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
use serde::{Deserialize, Serialize};
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
    /// `mcp`, `skills`, or absent for everything. The segmented control.
    #[serde(default)]
    pub kind: Option<String>,
    /// One-based. Absent or zero is the first page.
    #[serde(default)]
    pub page: Option<u32>,
    /// `true` for only what is installed, `false` for only what is not.
    #[serde(default)]
    pub installed: Option<bool>,
}

/// One page of the catalogue.
///
/// **A shape and not a bare array, because a page without a count is not
/// browsable.** The screen has to say whether there is more behind it, and
/// deciding that from "did I get a full page" is wrong on the one catalogue
/// whose size is an exact multiple of the page.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub entries: Vec<Listed>,
    /// How many match the filter, across every page.
    pub total: i64,
    /// Whether asking for the next page is worth it.
    pub more: bool,
    /// How many a page holds, so the caller need not agree with us by
    /// hardcoding it.
    pub per_page: u32,
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

    read_now(&state, &id, &body.url, &git_ref, me.id.as_str()).await?;
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
    read_now(&state, &id, &url, &git_ref, me.id.as_str()).await?;
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
    params(
        ("q" = Option<String>, Query, description = "Filter by name or description"),
        ("kind" = Option<String>, Query, description = "mcp, skills, or absent for everything"),
        ("page" = Option<u32>, Query, description = "One-based"),
        ("installed" = Option<bool>, Query, description = "Only what is installed, or only what is not"),
    ),
    responses((status = 200, body = Shelf)),
)]
pub(super) async fn list_entries(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(search): Query<Search>,
) -> ApiResult<Json<Shelf>> {
    let me = whoever(&principal)?;

    // **A source nobody has read yet is read now.** Booting must not depend on
    // reaching GitHub, so the default marketplace is added at start-up and not
    // fetched — which left a new installation with a Discover tab that was
    // empty until somebody found a Refresh button and guessed that it was the
    // thing standing between them and a catalogue. Asking for the list *is*
    // that guess, made for them.
    //
    // Only for a source that has never answered, so this costs one fetch in
    // the lifetime of each; a stale one is refreshed on purpose, by a person.
    for m in marketplace::list(state.skills.pool(), me.org_id.as_str())
        .await
        .unwrap_or_default()
    {
        if m.fetched_at.is_some() {
            continue;
        }
        if let Err(e) = read_now(&state, &m.id, &m.url, &m.git_ref, me.id.as_str()).await {
            // Recorded on the row, where the screen already shows it. A
            // source that cannot be reached must not take the others' rows
            // down with it.
            tracing::info!(source = %m.url, "first read failed: {}", e.message);
        }
    }

    let got = marketplace::entries(
        state.skills.pool(),
        me.org_id.as_str(),
        &marketplace::Asked {
            q: search.q.as_deref(),
            kind: search.kind.as_deref(),
            installed: search.installed,
            page: search.page.unwrap_or(1),
        },
    )
    .await
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok(Json(Shelf {
        entries: got.entries,
        total: got.total,
        more: got.more,
        per_page: marketplace::PER_PAGE,
    }))
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

    let (source, market_url, commit, name, display_name, description) =
        marketplace::address_of(pool, me.org_id.as_str(), &id, &slug)
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?
            .ok_or_else(|| ApiError::not_found("plugin"))?;

    let token = reading_as(&state, me.id.as_str(), &market_url).await;
    let files = marketplace::files_of(&source, &market_url, &commit, token.as_deref())
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
        display_name: Some(display_name),
        description,
        frontmatter: serde_json::json!({ "name": name }),
        body: String::new(),
        files: incoming,
        notes: None,
        kind: Some("plugin".into()),
    };
    crate::skills::check(&new).map_err(|e| ApiError::new(ErrorCode::InvalidRequest, e.0))?;

    // **Asked before writing, because the database's answer is unreadable.**
    // One name per owner is a real constraint and hitting it surfaced
    // `duplicate key value violates unique constraint
    // "skills_one_name_per_owner"`, which tells somebody nothing they can act
    // on. The collision is ordinary: a connector pasted by hand lands as
    // `notion`, and so does the marketplace's.
    let taken: Option<String> = sqlx::query_scalar(
        "SELECT name FROM skills WHERE org_id = $1 AND created_by = $2 AND name = $3",
    )
    .bind(me.org_id.as_str())
    .bind(me.id.as_str())
    .bind(&name)
    .fetch_optional(pool)
    .await
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;
    if taken.is_some() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "you already have a plugin called `{name}` — remove or rename it, \
                 and then add this one"
            ),
        ));
    }

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
        // Ask the server how it wants authorizing now, so the row can say so
        // rather than finding out when somebody presses a button.
        crate::connectors::remember(pool, made.as_str(), &url).await;
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

/// This person's GitHub token, when they have one, for reading a repository.
///
/// **Unauthenticated is sixty requests an hour, shared by everybody behind
/// one address.** Measured the hard way: a laptop running three sessions
/// exhausted it and every refresh started answering `403 Forbidden`, which
/// reads as "that repository is gone" rather than "come back in half an
/// hour". A token raises it to five thousand, and it is the same credential
/// that makes a private marketplace possible at all.
///
/// `None` is not an error — a public repository is readable without one, and
/// somebody who has not connected a git host can still browse ours.
async fn reading_as(state: &AppState, owner: &str, url: &str) -> Option<String> {
    let host = reqwest::Url::parse(url).ok()?.host_str()?.to_string();
    let conns = state.connections.all().await;
    if let Some(conn) = conns.iter().find(|c| c.git_host == host) {
        if let Some(t) = super::git_token(state, conn, owner, "reading a marketplace").await {
            return Some(t.to_string());
        }
    }

    // **The installation's own, when nobody's will do.** Somebody who has not
    // connected a git account still has to be able to browse a catalogue, and
    // on a shared office address the anonymous sixty is spent by lunchtime.
    // `MARKETPLACE_TOKEN` is the escape hatch a self-hosted administrator
    // reaches for, and it is deliberately narrow: it is read for marketplace
    // fetches and nothing else.
    //
    // It is server-wide, so a token that can see private repositories lets
    // every organisation here read them. That is a thing an administrator
    // chooses by setting it; a read-only token with no private scope raises
    // the limit and grants nothing.
    std::env::var("MARKETPLACE_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Read a repository now, and record the failure rather than throwing it away.
async fn read_now(
    state: &AppState,
    id: &str,
    url: &str,
    git_ref: &str,
    owner: &str,
) -> Result<(), ApiError> {
    let pool = state.skills.pool();
    let token = reading_as(state, owner, url).await;
    match marketplace::fetch(url, git_ref, token.as_deref()).await {
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

/// What one catalogue entry carries, before anybody installs it.
///
/// **Read before you agree, not after.** An entry's card says how many skills
/// it brings; it cannot say what they tell an agent to do, and nothing else
/// could until this existed — so the only way to read a stranger's
/// instructions was to install them first. The files are pulled at the
/// pinned commit and thrown away; nothing is stored.
#[utoipa::path(
    get, path = "/api/v1/marketplaces/{id}/entries/{slug}/preview", tag = "marketplaces",
    params(
        ("id" = String, Path, description = "Marketplace"),
        ("slug" = String, Path, description = "Entry"),
    ),
    responses(
        (status = 200, body = crate::skills::Inside),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn preview_entry(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((id, slug)): Path<(String, String)>,
) -> ApiResult<Json<crate::skills::Inside>> {
    let me = whoever(&principal)?;
    let (source, market_url, commit, _, _, _) =
        marketplace::address_of(state.skills.pool(), me.org_id.as_str(), &id, &slug)
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?
            .ok_or_else(|| ApiError::not_found("plugin"))?;

    let token = reading_as(&state, me.id.as_str(), &market_url).await;
    let files = marketplace::files_of(&source, &market_url, &commit, token.as_deref())
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    Ok(Json(crate::skills::read_bundle(&files)))
}
