//! Connecting a connector, as the person who asked.
//!
//! Four routes and one of them is not an API call at all: the callback is a
//! browser landing on the control plane, so it answers with a page a person
//! reads rather than with JSON.
//!
//! **The authorization is per person and the connector is not.** A connector
//! travels with a plugin through a directory or a profile; the token it needs
//! does not. So every route here is about `me`, and a colleague reading the
//! same plugin's row sees their own answer.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::access::whoever;
use super::{ApiError, ApiResult, AppState, ErrorCode};
use crate::auth::Principal;
use crate::connectors::{self, Discovered};
use crate::vault::Key;

/// Where a browser comes back to.
///
/// Loopback, which RFC 8252 is explicit about for a client that is not a
/// hosted web application — and which every server offering dynamic
/// registration accepts.
///
/// **`api_url` and not `public_url`.** The second is where a *person* opens
/// Firetower, and in development that is a separate dev server on another
/// port: a redirect built from it sends the browser somewhere that does not
/// serve this route, and the authorization is lost at the last step with
/// nothing to say why. In production the two are one origin.
fn redirect_uri(state: &AppState) -> String {
    format!("{}/api/v1/connectors/callback", state.api_url)
}

/// Whether **you** are connected, and how this one is authorized at all.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorState {
    /// `none`, `borrow-git` or `oauth`. What the row on the screen says about
    /// what pressing Connect will do.
    pub auth: String,
    /// What the agent calls this server.
    pub server: String,
    pub url: String,
    /// Whether this person holds a credential for it.
    pub connected: bool,
    /// Why it cannot be connected here, when that is the answer. A connector
    /// whose git host nobody has authorized is not broken — it is waiting on
    /// a different screen, and saying so is cheaper than a failed attempt.
    pub blocked: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// Send the person's browser here.
    pub authorize_url: String,
}

#[derive(Debug, Deserialize)]
pub struct Returned {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[utoipa::path(
    get, path = "/api/v1/connectors/{id}", tag = "connectors",
    params(("id" = String, Path, description = "The plugin the connector belongs to")),
    responses((status = 200, body = ConnectorState), (status = 404, body = ApiError)),
)]
pub(super) async fn connector_state(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<ConnectorState>> {
    let me = whoever(&principal)?;
    let row = one(&state, &id).await?;

    let (connected, blocked) = match row.auth.as_str() {
        "borrow-git" => {
            let hosts = state.connections.all().await;
            let host = row.borrow.as_deref().and_then(|kind| {
                hosts
                    .iter()
                    .find(|h| h.kind.id == kind && h.configured())
                    .cloned()
            });
            // **There is nothing to press here, either way.** This connector
            // has no browser flow of its own — it reads the token that host
            // already holds — so an unconnected one is not a button that
            // would fail, it is a sentence naming the screen that fixes it.
            let held = match &host {
                Some(conn) => {
                    super::git_token(&state, conn, me.id.as_str(), "reading a connector's state")
                        .await
                        .is_some()
                }
                None => false,
            };
            let where_to = format!(
                "Connect {} under Git hosts and this comes with it — the connector reads the \
                 token you already have there rather than asking for a second one.",
                host.as_ref()
                    .map(|h| h.label.clone())
                    .unwrap_or_else(|| row.borrow.clone().unwrap_or_else(|| "that host".into()))
            );
            (held, (!held).then_some(where_to))
        }
        "oauth" => (
            state
                .vault
                .holds(Key::of(crate::vault::CONNECTOR, &id, me.id.as_str()))
                .await
                .unwrap_or(false),
            None,
        ),
        _ => (true, None),
    };

    Ok(Json(ConnectorState {
        auth: row.auth,
        server: row.server,
        url: row.url,
        connected,
        blocked,
    }))
}

#[utoipa::path(
    post, path = "/api/v1/connectors/{id}/connect", tag = "connectors",
    params(("id" = String, Path, description = "The plugin the connector belongs to")),
    responses(
        (status = 200, body = Opened, description = "Open this in the person's browser"),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn connect(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Opened>> {
    let me = whoever(&principal)?;
    let row = one(&state, &id).await?;
    if row.auth != "oauth" {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this connector does not authorize in a browser".to_string(),
        ));
    }

    let (found, client_id) = client_for(&state, &id, &row.url).await?;
    let pkce = connectors::Pkce::new();
    // The handle the browser carries. Random and single-use: it is the only
    // thing tying a callback back to the person who started it.
    let handle = {
        use chacha20poly1305::aead::rand_core::RngCore;
        let mut raw = [0u8; 24];
        chacha20poly1305::aead::OsRng.fill_bytes(&mut raw);
        ft_proto::encode(&raw).replace(['+', '/', '='], "")
    };

    sqlx::query(
        "INSERT INTO connector_pending (state, skill_id, owner, verifier) VALUES ($1,$2,$3,$4)",
    )
    .bind(&handle)
    .bind(&id)
    .bind(me.id.as_str())
    .bind(&pkce.verifier)
    .execute(state.skills.pool())
    .await
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("starting it: {e}")))?;

    Ok(Json(Opened {
        authorize_url: connectors::authorize_url(
            &found,
            &client_id,
            &redirect_uri(&state),
            &handle,
            &pkce,
        ),
    }))
}

/// Where the browser lands. **Not an API route** — a person is looking at it.
#[utoipa::path(
    get, path = "/api/v1/connectors/callback", tag = "connectors",
    responses((status = 200, description = "A page saying what happened")),
)]
pub(super) async fn connector_callback(
    State(state): State<AppState>,
    Query(back): Query<Returned>,
) -> impl IntoResponse {
    match finish(&state, back).await {
        Ok(name) => (
            StatusCode::OK,
            Html(page(
                "Connected",
                &format!("{name} is connected. You can close this tab."),
            )),
        ),
        Err(why) => (StatusCode::BAD_REQUEST, Html(page("Not connected", &why))),
    }
}

async fn finish(state: &AppState, back: Returned) -> Result<String, String> {
    if let Some(e) = back.error {
        // The server's own words, which say more than ours would: a declined
        // consent screen and an expired code are different things.
        return Err(back.error_description.unwrap_or(e));
    }
    let (code, handle) = match (back.code, back.state) {
        (Some(c), Some(s)) => (c, s),
        _ => return Err("that callback carried no authorization code".into()),
    };

    let row = sqlx::query(
        "DELETE FROM connector_pending WHERE state = $1 \
         RETURNING skill_id, owner, verifier",
    )
    .bind(&handle)
    .fetch_optional(state.skills.pool())
    .await
    .map_err(|e| e.to_string())?
    // Consumed on use, so a replayed callback finds nothing — which is the
    // same answer as one the control plane restarted out from under.
    .ok_or("that authorization has already been used, or this Firetower restarted during it")?;

    use sqlx::Row as _;
    let skill_id: String = row.get("skill_id");
    let owner: String = row.get("owner");
    let verifier: String = row.get("verifier");

    let connector = one(state, &skill_id).await.map_err(|e| e.message.clone())?;
    let (found, client_id) = client_for(state, &skill_id, &connector.url)
        .await
        .map_err(|e| e.message.clone())?;

    let grant = connectors::exchange(
        &found,
        &client_id,
        None,
        &code,
        &redirect_uri(state),
        &verifier,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;

    state
        .vault
        .put(
            Key::of(crate::vault::CONNECTOR, &skill_id, &owner),
            &grant.to_stored(),
            "connected a plugin's connector",
        )
        .await
        .map_err(|e| format!("storing it: {e}"))?;

    Ok(connector.server)
}

#[utoipa::path(
    delete, path = "/api/v1/connectors/{id}", tag = "connectors",
    params(("id" = String, Path, description = "The plugin the connector belongs to")),
    responses((status = 204, description = "Forgotten"), (status = 404, body = ApiError)),
)]
pub(super) async fn disconnect(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    // **Yours and only yours.** Disconnecting takes your credential out and
    // leaves everybody else's, which is the whole shape of the thing: the
    // connector is shared and the authorization is not.
    state
        .vault
        .forget(
            Key::of(crate::vault::CONNECTOR, &id, me.id.as_str()),
            "disconnected a plugin's connector",
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("forgetting it: {e}")))?;
    Ok(StatusCode::NO_CONTENT)
}

/// The connector row, refused as a 404 when the plugin has none.
async fn one(state: &AppState, id: &str) -> Result<crate::skills::SessionConnector, ApiError> {
    state
        .skills
        .connector_of(id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("reading it: {e}")))?
        .ok_or_else(|| ApiError::not_found("connector"))
}

/// What this connector's authorization server told us, discovered once.
///
/// Cached in `connector_clients` rather than re-walked per press: discovery is
/// three round trips to somebody else's server, and the registration it
/// produces identifies *Firetower* rather than a person, so everybody here
/// shares one.
async fn client_for(
    state: &AppState,
    id: &str,
    url: &str,
) -> Result<(Discovered, String), ApiError> {
    use sqlx::Row as _;
    let pool = state.skills.pool();
    let held = sqlx::query(
        "SELECT resource, authorize_url, token_url, register_url, client_id, scopes \
           FROM connector_clients WHERE skill_id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;

    if let Some(r) = held {
        if let Some(client_id) = r.get::<Option<String>, _>("client_id") {
            return Ok((
                Discovered {
                    resource: r.get("resource"),
                    authorize_url: r.get("authorize_url"),
                    token_url: r.get("token_url"),
                    register_url: r.get("register_url"),
                    scopes: r.get("scopes"),
                },
                client_id,
            ));
        }
    }

    let found = connectors::discover(url)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;
    let at = found.register_url.clone().ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "that server registers no clients dynamically, so it needs a client id somebody \
             creates by hand — which Firetower cannot do for you yet"
                .to_string(),
        )
    })?;
    let registered = connectors::register(&at, &redirect_uri(state))
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    sqlx::query(
        "INSERT INTO connector_clients \
           (skill_id, resource, authorize_url, token_url, register_url, client_id, scopes) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) \
         ON CONFLICT (skill_id) DO UPDATE SET \
           resource = excluded.resource, authorize_url = excluded.authorize_url, \
           token_url = excluded.token_url, register_url = excluded.register_url, \
           client_id = excluded.client_id, scopes = excluded.scopes",
    )
    .bind(id)
    .bind(&found.resource)
    .bind(&found.authorize_url)
    .bind(&found.token_url)
    .bind(&found.register_url)
    .bind(&registered.client_id)
    .bind(&found.scopes)
    .execute(pool)
    .await
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;

    Ok((found, registered.client_id))
}

/// The page a browser lands on. Plain, self-contained, and it says what to do
/// next rather than only what happened.
fn page(title: &str, says: &str) -> String {
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>{title} — Firetower</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f2f3;
color:#47474d;font:16px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif}}
main{{max-width:36rem;padding:40px;text-align:center}}
h1{{font-size:24px;color:#161617;margin:0 0 8px;letter-spacing:-.02em}}
p{{margin:0}}</style></head>
<body><main><h1>{title}</h1><p>{says}</p></main></body></html>"#,
        title = html(title),
        says = html(says),
    )
}

/// The server's own error text lands in this page, so it is escaped.
fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
