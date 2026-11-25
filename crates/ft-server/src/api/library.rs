//! The library, and the tools a server turns out to offer.
//!
//! **Two routes and one of them talks to somebody else's server.** Asking an
//! MCP server what it can do is the only way to find out — a tool list is not
//! in any manifest — and it answers only a client it has authorized. Measured
//! on Linear, Notion and Figma: all three refuse `tools/list` without a token.
//! So this is a thing that happens *after* connecting, and the screen before
//! that says so rather than guessing.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use serde::Serialize;
use utoipa::ToSchema;

use super::access::whoever;
use super::{ApiError, ApiResult, AppState, ErrorCode};
use crate::auth::Principal;
use crate::library::{Item, LibrarySwitch};

#[utoipa::path(
    get, path = "/api/v1/library", tag = "library",
    responses((status = 200, body = Vec<Item>)),
)]
pub(super) async fn list_library(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Item>>> {
    let me = whoever(&principal)?;
    let got = crate::library::items(state.skills.pool(), me.id.as_str(), &me.slug)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    Ok(Json(got))
}

/// Turn one component on or off, for this person.
#[utoipa::path(
    post, path = "/api/v1/library/switch", tag = "library",
    request_body = LibrarySwitch,
    responses((status = 204), (status = 400, body = ApiError)),
)]
pub(super) async fn switch_item(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<LibrarySwitch>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    crate::library::switch(state.skills.pool(), me.id.as_str(), &body.id, body.on)
        .await
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// What one server says it can do.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    /// Tool names, in the order the server listed them.
    pub names: Vec<String>,
    /// When somebody last asked. `None` has never been asked.
    pub fetched_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Why there is nothing, when there is nothing.
    pub why: Option<String>,
}

#[utoipa::path(
    get, path = "/api/v1/connectors/{id}/tools", tag = "library",
    params(("id" = String, Path, description = "The connector")),
    responses((status = 200, body = Tools)),
)]
pub(super) async fn connector_tools(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Tools>> {
    let me = whoever(&principal)?;
    let pool = state.skills.pool();

    // Cached first. A detail screen must not wait on somebody else's server,
    // and the answer is stable between their releases.
    if let Ok(Some(row)) = sqlx::query_as::<_, (serde_json::Value, chrono::DateTime<chrono::Utc>)>(
        "SELECT tools, fetched_at FROM connector_tools WHERE skill_id = $1",
    )
    .bind(&id)
    .fetch_optional(pool)
    .await
    {
        return Ok(Json(Tools {
            names: serde_json::from_value(row.0).unwrap_or_default(),
            fetched_at: Some(row.1),
            why: None,
        }));
    }

    let Some(found) = state
        .skills
        .connector_of(&id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?
    else {
        return Err(ApiError::not_found("connector"));
    };

    let Some(token) = super::connector_token(&state, &id, me.id.as_str()).await else {
        return Ok(Json(Tools {
            names: Vec::new(),
            fetched_at: None,
            why: Some(
                "connect it first — a server lists its tools only to a client it has authorized"
                    .into(),
            ),
        }));
    };

    match ask(&found.url, &token).await {
        Ok(names) => {
            let _ = sqlx::query(
                "INSERT INTO connector_tools (skill_id, tools, counted) VALUES ($1,$2,$3) \
                 ON CONFLICT (skill_id) DO UPDATE SET tools = excluded.tools, \
                   counted = excluded.counted, fetched_at = now()",
            )
            .bind(&id)
            .bind(serde_json::to_value(&names).unwrap_or_default())
            .bind(names.len() as i32)
            .execute(pool)
            .await;
            Ok(Json(Tools {
                names,
                fetched_at: Some(chrono::Utc::now()),
                why: None,
            }))
        }
        Err(e) => Ok(Json(Tools {
            names: Vec::new(),
            fetched_at: None,
            why: Some(format!("{e:#}")),
        })),
    }
}

/// `tools/list`, over the transport every one of these servers speaks.
///
/// The response may arrive as JSON or as one `text/event-stream` frame — the
/// specification allows both and real servers use both — so this reads either
/// rather than asking for one and failing on the other.
async fn ask(url: &str, token: &str) -> anyhow::Result<Vec<String>> {
    let http = reqwest::Client::builder()
        .user_agent("firetower")
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}
    });
    let r = http
        .post(url)
        .bearer_auth(token)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;
    if !r.status().is_success() {
        anyhow::bail!("that server answered {}", r.status());
    }
    let text = r.text().await?;
    let json = text
        .lines()
        .find_map(|l| l.strip_prefix("data: "))
        .unwrap_or(&text);
    let v: serde_json::Value = serde_json::from_str(json.trim())?;
    let tools = v
        .get("result")
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .ok_or_else(|| anyhow::anyhow!("that server listed no tools"))?;
    Ok(tools
        .iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_owned))
        .collect())
}
