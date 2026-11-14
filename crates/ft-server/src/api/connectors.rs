//! The connector library, and what each session can reach.
//!
//! **No route here returns a credential.** Not a token, not a refresh token,
//! not a client secret, not a header with one in it — criterion 12, and the
//! same rule `api::secrets` holds itself to, except that there the one route
//! which does hand a value back now excludes connector grants by name.
//!
//! Everything is scoped to whoever is asking. A connector somebody cannot
//! reach is absent rather than refused, the rule every other kind follows, and
//! a credential resolves by **the person whose session it is** — see
//! `connectors::Connectors::for_session`, which is where that is enforced
//! rather than asked politely.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::connectors::{self, Connector, DriftRow, NewConnector, Opening, Refused, ToolRow};
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Html,
    Extension, Json,
};
use ft_core::SessionId;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::auth::Principal;

fn refused(e: Refused) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, e.to_string())
}

/// Everything this person's library holds.
#[utoipa::path(
    get, path = "/api/v1/connectors", tag = "connectors",
    responses((status = 200, body = Vec<Connector>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_connectors(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Connector>>> {
    let me = whoever(&principal)?;
    Ok(Json(
        state
            .connectors
            .visible(&state.vault, me.id.as_str())
            .await?,
    ))
}

/// Add one by URL.
///
/// **Criterion 7 lives in the ordering.** The address is checked, the server is
/// asked what it is, and only then is a row written — so a URL that is not an
/// MCP server fails at the form, naming what went wrong, and leaves nothing
/// half-made behind.
#[utoipa::path(
    post, path = "/api/v1/connectors", tag = "connectors",
    request_body = NewConnector,
    responses(
        (status = 201, body = Connector),
        (status = 400, body = ApiError, description = "the address is not an MCP server, \
            is unreachable, or carries a credential in its query string"),
    ),
)]
pub(super) async fn create_connector(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(new): Json<NewConnector>,
) -> ApiResult<(StatusCode, Json<Connector>)> {
    let me = whoever(&principal)?;
    let id = state
        .connectors
        .add(me.org_id.as_str(), me.id.as_str(), &me.slug, &new)
        .await
        .map_err(refused)?;

    let made = state
        .connectors
        .one(&state.vault, me.id.as_str(), id.as_str())
        .await?
        .ok_or_else(|| ApiError::not_found("connector"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

/// One connector, with what it said it can do and anything that has drifted.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDetail {
    #[serde(flatten)]
    pub connector: Connector,
    /// The tool list as last measured, writes first. Empty where the server
    /// would not list them — which is what `probed.shape` says, and why the
    /// detail view shows permissions there instead.
    pub tools: Vec<ToolRow>,
    /// Every time a tool's definition stopped matching, newest first.
    pub drift: Vec<DriftRow>,
}

#[utoipa::path(
    get, path = "/api/v1/connectors/{id}", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    responses((status = 200, body = ConnectorDetail), (status = 404, body = ApiError)),
)]
pub(super) async fn connector_detail(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<ConnectorDetail>> {
    let me = whoever(&principal)?;
    let connector = state
        .connectors
        .one(&state.vault, me.id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("connector"))?;
    Ok(Json(ConnectorDetail {
        tools: state.connectors.tools(&id).await?,
        drift: state.connectors.drift(&id, 50).await?,
        connector,
    }))
}

/// The two fields that are a person's rather than the server's.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DescribeConnector {
    #[serde(default)]
    pub name: Option<String>,
    /// The line in the model's context every turn. Editable because an
    /// imported one written for somebody else's work mis-fires constantly.
    #[serde(default)]
    pub description: Option<String>,
}

#[utoipa::path(
    patch, path = "/api/v1/connectors/{id}", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    request_body = DescribeConnector,
    responses((status = 200, body = Connector), (status = 404, body = ApiError)),
)]
pub(super) async fn describe_connector(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<DescribeConnector>,
) -> ApiResult<Json<Connector>> {
    let me = whoever(&principal)?;
    if !state
        .connectors
        .describe(
            me.id.as_str(),
            &id,
            body.name.as_deref(),
            body.description.as_deref(),
        )
        .await?
    {
        return Err(ApiError::not_found("connector"));
    }
    state
        .connectors
        .one(&state.vault, me.id.as_str(), &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("connector"))
}

/// Remove it, and this person's grant with it. The vault's log entry stays.
#[utoipa::path(
    delete, path = "/api/v1/connectors/{id}", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_connector(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    match state
        .connectors
        .remove(&state.vault, me.id.as_str(), &id)
        .await?
    {
        true => Ok(StatusCode::NO_CONTENT),
        false => Err(ApiError::not_found("connector")),
    }
}

/// Ask the server again, and record anything that has changed.
///
/// A `POST` because it writes: a probe replaces the recorded answer and may
/// append a drift row. Criteria 13 and 14.
#[utoipa::path(
    post, path = "/api/v1/connectors/{id}/probe", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    responses((status = 200, body = ConnectorDetail), (status = 404, body = ApiError)),
)]
pub(super) async fn probe_connector(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<ConnectorDetail>> {
    let me = whoever(&principal)?;
    if state
        .connectors
        .probe_again(&state.vault, me.id.as_str(), &id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("connector"));
    }
    connector_detail(State(state), Extension(principal), Path(id)).await
}

/// What this person is about to grant, **read from the server now**.
///
/// **Criterion 10.** The first step of the sign-in sheet, and the reason it is
/// its own request: the list is fetched when the screen opens, from the
/// server's own metadata, so it cannot be out of date and nobody in Firetower
/// has to keep it true. `authorize` is absent here — the browser does not open
/// until [`authorize_connector`].
#[utoipa::path(
    get, path = "/api/v1/connectors/{id}/scopes", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    responses((status = 200, body = Opening), (status = 404, body = ApiError)),
)]
pub(super) async fn connector_scopes(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Opening>> {
    let me = whoever(&principal)?;
    state
        .connectors
        .what_it_will_ask(me.id.as_str(), &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("connector"))
}

/// Start the browser leg: discovery, registration, PKCE, and a URL to open.
#[utoipa::path(
    post, path = "/api/v1/connectors/{id}/authorize", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    responses(
        (status = 200, body = Opening, description = "`authorize` is the address to open. \
            Where it is absent, `trouble` says why a browser sign-in cannot be offered."),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn authorize_connector(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Opening>> {
    let me = whoever(&principal)?;
    let redirect = redirect_uri(&state);
    state
        .connectors
        .begin_browser_leg(&state.vault, me.id.as_str(), &id, &redirect)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("connector"))
}

/// A token somebody pasted, for a server that publishes no OAuth metadata.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PasteToken {
    pub token: String,
}

/// Store a pasted token, after checking the server will use it.
///
/// Checked rather than trusted: a token the server refuses is a connector that
/// reads as connected and fails on its first call, which is the state this
/// product exists to avoid.
#[utoipa::path(
    put, path = "/api/v1/connectors/{id}/token", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    request_body = PasteToken,
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn set_connector_token(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<PasteToken>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    match state
        .connectors
        .accept_token(&state.vault, me.id.as_str(), &id, &body.token)
        .await?
    {
        None => Err(ApiError::not_found("connector")),
        Some(Err(e)) => Err(refused(e)),
        Some(Ok(())) => Ok(StatusCode::NO_CONTENT),
    }
}

/// Drop this person's grant. The connector stays in the library.
#[utoipa::path(
    delete, path = "/api/v1/connectors/{id}/grant", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn sign_out_of_connector(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    match state
        .connectors
        .sign_out(&state.vault, me.id.as_str(), &id)
        .await?
    {
        true => Ok(StatusCode::NO_CONTENT),
        false => Err(ApiError::not_found("connector")),
    }
}

/// What an authorization server sends a browser back with.
#[derive(Debug, Deserialize)]
pub struct Callback {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
}

/// The browser coming back from a consent screen.
///
/// **This is the third hole in the authentication gate, and the reason is
/// structural rather than convenient.** An authorization server redirects a
/// *browser* here, and that browser carries no Firetower credential — the
/// person may be using the desktop app and never have signed into the web
/// interface at all. Every OAuth redirect URI in existence has this shape.
///
/// What makes it safe is that the request authorises nothing by itself:
///
/// * `state` is 32 characters of `OsRng`, **single-use** — the row is deleted
///   as it is read — and expires in fifteen minutes. A replay finds nothing.
/// * **The grant lands under the person named on that row**, read from the
///   database, never from a cookie or a header on this request. A callback
///   cannot put a token under somebody else's name.
/// * It discloses nothing: the page says a connector is connected or that the
///   sign-in is no longer waiting, and never which connector, whose it is, or
///   anything about this installation.
///
/// Answers HTML because a person is looking at it, in a tab they are about to
/// close.
#[utoipa::path(
    get, path = "/api/v1/connectors/callback", tag = "connectors",
    params(
        ("code" = Option<String>, Query, description = "The authorization code"),
        ("state" = Option<String>, Query, description = "The single-use value that names the attempt"),
        ("error" = Option<String>, Query, description = "Set where the person declined"),
    ),
    responses((status = 200, description = "A page saying whether it worked", content_type = "text/html")),
)]
pub(super) async fn connector_callback(
    State(state): State<AppState>,
    Query(back): Query<Callback>,
) -> Html<String> {
    if let Some(error) = back.error {
        // Declined, or the server refused. Its own words, escaped — this is
        // the one thing on the page that did not come from here.
        let detail = back
            .error_description
            .unwrap_or_else(|| "the authorization server did not say why".into());
        return page(
            "That sign-in did not finish",
            &format!("{}: {}", escape(&error), escape(&detail)),
        );
    }
    let (Some(code), Some(returned)) = (back.code, back.state) else {
        return page(
            "That sign-in did not finish",
            "The authorization server sent no code back. Start it again from the connector.",
        );
    };

    match state
        .connectors
        .finish_browser_leg(&state.vault, &returned, &code)
        .await
    {
        Ok(landed) => {
            tracing::info!(
                connector = %landed.name,
                user = %landed.user_id,
                "a connector was authorized in a browser"
            );
            page(
                "Connected",
                "You can close this tab. Firetower has the authorization.",
            )
        }
        Err(e) => {
            // Logged with the detail, shown without it: the detail names a
            // connector and an endpoint, and whoever is holding this tab is
            // not necessarily whoever started the sign-in.
            tracing::warn!("finishing a connector's browser leg: {e:#}");
            page(
                "That sign-in did not finish",
                "It may have been completed already, or it may have expired. \
                 Start it again from the connector in Firetower.",
            )
        }
    }
}

/// What a session has on, and anything that stops one working.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionConnectors {
    /// The connectors this session has on.
    pub selected: Vec<String>,
    /// Everything this person could turn on, so the picker is one request.
    pub available: Vec<Connector>,
    /// The ones that are on and cannot be used, and why.
    ///
    /// Criteria 17 and 18: a connector this person holds no grant for is shown
    /// and counted at zero rather than sent, and a grant that has lapsed says
    /// so and offers to reconnect — instead of the agent telling somebody to
    /// run `/mcp` in a session that has no prompt.
    pub trouble: Vec<connectors::SessionTrouble>,
}

#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/connectors", tag = "connectors",
    params(("id" = String, Path, description = "The session")),
    responses((status = 200, body = SessionConnectors), (status = 404, body = ApiError)),
)]
pub(super) async fn session_connectors(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<SessionId>,
) -> ApiResult<Json<SessionConnectors>> {
    let me = whoever(&principal)?;
    let session = state
        .db
        .session_of(me.id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    // **The session's owner, not whoever is looking.** A colleague watching a
    // session should see which connectors it is running and whether they work
    // for the person it belongs to — not whether they would work for the
    // watcher, which is a different and misleading answer.
    let owner = session.owner.as_str();
    Ok(Json(SessionConnectors {
        selected: state.connectors.of_session(id.as_str()).await?,
        available: state
            .connectors
            .visible(&state.vault, me.id.as_str())
            .await?,
        trouble: state
            .connectors
            .trouble_for_session(&state.vault, id.as_str(), owner)
            .await?,
    }))
}

/// The whole selection, never a delta.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChooseConnectors {
    pub selected: Vec<String>,
}

/// Set what this session can reach.
///
/// **It takes effect at the agent's next start, not now.** An agent reads its
/// MCP configuration and its permission rules once, when it launches — so both
/// files are rewritten on the worker and the answer says a restart is needed.
/// Skills are different and can change mid-session; saying so here is what
/// stops somebody expecting the same of this.
#[utoipa::path(
    put, path = "/api/v1/sessions/{id}/connectors", tag = "connectors",
    params(("id" = String, Path, description = "The session")),
    request_body = ChooseConnectors,
    responses((status = 200, body = SessionConnectors), (status = 404, body = ApiError)),
)]
pub(super) async fn choose_connectors(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<SessionId>,
    Json(body): Json<ChooseConnectors>,
) -> ApiResult<Json<SessionConnectors>> {
    let me = whoever(&principal)?;
    // Choosing what an agent can reach is working in the place, so it takes the
    // Writer method rather than the one that only answers "may I watch this".
    state
        .db
        .session_to_work_in(me.id.as_str(), &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    // Only connectors this person can actually see. A selection naming one
    // they cannot reach would otherwise pin it, and the next read would show
    // them a connector they were never given.
    let reachable: std::collections::HashSet<String> = state
        .connectors
        .visible(&state.vault, me.id.as_str())
        .await?
        .into_iter()
        .map(|c| c.id.as_str().to_string())
        .collect();
    let chosen: Vec<String> = body
        .selected
        .into_iter()
        .filter(|id| reachable.contains(id))
        .collect();

    state
        .connectors
        .set_for_session(id.as_str(), me.id.as_str(), &chosen)
        .await?;

    // Out to the machine, resolved for the session's own owner — see
    // `for_session`, which is where "never somebody else's credential" is
    // enforced. Best effort and deliberately after the pins are written: a
    // worker that is asleep picks the set up when the agent is next started,
    // because that reads the same rows.
    if let Some(session) = state.db.session_of(me.id.as_str(), &id).await? {
        let resolved = state
            .connectors
            .for_session(&state.vault, &state.renewals, &id, session.owner.as_str())
            .await
            .unwrap_or_default();
        if let Err(e) = state
            .fleet
            .send(
                &session.host_id,
                ft_proto::ToWorker::SetConnectors {
                    session_id: id.clone(),
                    connectors: resolved,
                },
            )
            .await
        {
            tracing::warn!(session = %id, "telling the worker its connectors changed: {e:#}");
        }
    }

    session_connectors(State(state), Extension(principal), Path(id)).await
}

/// Where an authorization server sends the browser back to.
///
/// The control plane's own public address, because that is the only one an
/// authorization server can reach and the only one a redirect URI can be
/// registered against. A desktop client never receives the redirect itself.
fn redirect_uri(state: &AppState) -> String {
    format!(
        "{}/api/v1/connectors/callback",
        state.public_url.trim_end_matches('/')
    )
}

/// The page somebody sees in the tab the browser leg opened.
///
/// Plain, self-contained and styleless on purpose: it is on screen for two
/// seconds in a tab somebody is about to close, and loading anything from the
/// interface here would mean a redirect URI that depends on assets.
fn page(title: &str, body: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>{title} — Firetower</title></head>\
         <body style=\"margin:0;display:grid;place-items:center;min-height:100vh;\
         font:16px/1.6 system-ui,sans-serif;background:#0f1012;color:#e8e6e3\">\
         <main style=\"max-width:30rem;padding:2rem;text-align:center\">\
         <h1 style=\"font-size:1.25rem;font-weight:550;margin:0 0 .5rem\">{title}</h1>\
         <p style=\"margin:0;color:#a8a5a0\">{body}</p></main></body></html>"
    ))
}

/// The three characters that would let a server's own error text close a tag.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_servers_own_error_text_cannot_close_a_tag() {
        assert_eq!(
            escape("<script>alert(1)</script> & more"),
            "&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"
        );
    }

    /// The page says what happened and nothing about this installation. It is
    /// shown to whoever is holding the tab, who is not necessarily whoever
    /// started the sign-in.
    #[test]
    fn the_callback_page_names_no_connector_and_no_person() {
        let Html(html) = page(
            "Connected",
            "You can close this tab. Firetower has the authorization.",
        );
        assert!(html.contains("Connected"));
        assert!(!html.contains("http://"), "{html}");
    }
}
