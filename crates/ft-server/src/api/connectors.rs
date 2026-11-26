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
    /// Where the browser comes back to, for somebody registering an
    /// application by hand. **Said rather than guessed**: it is built from
    /// `api_url`, and the difference between that and the address a person
    /// types in the app is the mistake that loses an authorization at the
    /// last step with nothing to say why.
    pub redirect_uri: String,
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
                .holds(Key::of(
                    crate::vault::CONNECTOR,
                    &connectors::credential_key(state.skills.pool(), &id).await,
                    me.id.as_str(),
                ))
                .await
                .unwrap_or(false),
            None,
        ),
        _ => (true, None),
    };

    Ok(Json(ConnectorState {
        redirect_uri: redirect_uri(&state),
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

    // **The secret, when this application has one.** A client somebody
    // registered by hand is usually confidential — GitHub's OAuth apps have
    // no public mode at all — and a token request without it is refused with
    // `invalid_client`, which reads as a bad code rather than a missing
    // secret.
    let shared = connectors::credential_key(state.skills.pool(), &skill_id).await;
    let secret = state
        .vault
        .get(
            crate::vault::Key::of(crate::vault::CONNECTOR_CLIENT, &shared, ""),
            "authorizing a connector",
        )
        .await
        .ok()
        .flatten();

    let grant = connectors::exchange(
        &found,
        &client_id,
        secret.as_ref().map(|s| s.as_str()),
        &code,
        &redirect_uri(state),
        &verifier,
    )
    .await
    .map_err(|e| format!("{e:#}"))?;

    state
        .vault
        .put(
            Key::of(
                crate::vault::CONNECTOR,
                &connectors::credential_key(state.skills.pool(), &skill_id).await,
                &owner,
            ),
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
            Key::of(
                crate::vault::CONNECTOR,
                &connectors::credential_key(state.skills.pool(), &id).await,
                me.id.as_str(),
            ),
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
                    name: None,
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
    // **Says where the answer is, because there is one.** This sentence was
    // written before `set_client` existed and still ended "which Firetower
    // cannot do for you yet" — so somebody pressing Connect on one of the
    // eleven servers that register nothing was told the product could not
    // help, with the form that does it on the same screen.
    let at = found.register_url.clone().ok_or_else(|| {
        ApiError::new(
            ErrorCode::InvalidRequest,
            "this server does not hand out clients, so it needs an OAuth application you \
             create once. Open it and use Set it up — the form has the redirect URL to paste \
             and a link to the right page."
                .to_string(),
        )
    })?;
    let registered = match connectors::register(&at, &redirect_uri(state)).await {
        Ok(got) => got,
        // **A server that advertises registration and then refuses it is the
        // same problem as one that advertises none.** Figma publishes
        // `api.figma.com/v1/oauth/mcp/register` and answers `403 Forbidden`,
        // so the row offered a Connect button that could only ever fail, and
        // failed with somebody else's error text. `needs_a_client` records
        // what we just learned, which flips the row to "Set it up" — the
        // answer was always there, we were just taking the server's word for
        // what it could do instead of finding out.
        Err(e) => {
            tracing::info!(
                connector = %id, at = %at,
                "registration was refused, so this one needs an application by hand: {e:#}"
            );
            needs_a_client(state, id, &found).await;
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                "this server offers to hand out clients and then refuses, so it needs an \
                 OAuth application you create once. Open it and use Set it up — the form has \
                 the redirect URL to paste and a link to the right page."
                    .to_string(),
            ));
        }
    };

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

/// An address somebody pasted.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FromUrl {
    pub url: String,
}

/// What the server turned out to be, before anybody commits to it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Probed {
    /// The name the plugin will take, derived from the address.
    pub name: String,
    /// `oauth` or `none`, as the server itself answered.
    pub auth: String,
    /// What it will reach, which is the one fact worth reading before saying yes.
    pub host: String,
    /// What it publishes as its scopes, when it publishes any.
    pub scopes: Option<String>,
    /// Its own mark, as a data URI, when its site serves one.
    ///
    /// Inline rather than a URL: this is shown in a review before anything is
    /// stored, and the app must not be made to fetch from somebody else's
    /// origin to draw a row.
    pub logo: Option<String>,
}

/// A name from an address.
///
/// `mcp.linear.app` is Linear and `api.githubcopilot.com` is githubcopilot —
/// the subdomain everybody uses for this is noise, and the suffix is never the
/// name. Editable afterwards, because a guess from a hostname is a guess.
fn name_from(url: &str) -> String {
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
        .unwrap_or_default();
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    let middle = match parts.as_slice() {
        [] => "connector",
        // Drop a leading `mcp`/`api` and the public suffix, and take what is
        // left of the registrable name.
        [first, rest @ ..] if matches!(*first, "mcp" | "api") && rest.len() >= 2 => rest[0],
        [_, second, ..] if parts.len() >= 3 => second,
        [first, ..] => first,
    };
    as_name(middle)
}

/// Free text as a skill name.
///
/// **Not `slug_of`.** That one joins words with an underscore, because it
/// builds the segment of a placed path; a skill name forbids underscores, so
/// routing a typed name through it rejected every name with a space or a
/// hyphen in it — which is most of the names somebody would type.
fn as_name(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            out.extend(ch.to_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-');
    if out.is_empty() {
        "connector".into()
    } else {
        out.chars()
            .take(64)
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    }
}

/// The scheme and host of a URL, with nothing after it.
fn origin_of(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    Some(format!("{}://{}", u.scheme(), u.host_str()?))
}

/// Where a brand's mark is likely to be, best guess first.
///
/// **The authorization server is not reliably the brand's site.** Linear's
/// issuer is `mcp.linear.app`, which serves no page at all, while the mark is
/// one label up at `linear.app`. So each origin is also tried with its leading
/// label dropped, which turns `mcp.linear.app` into `linear.app` and
/// `mcp.sentry.dev` into `sentry.dev`. Two-label hosts are left alone, because
/// dropping a label there leaves a public suffix rather than a site.
fn brand_origins(issuer: Option<&str>, endpoint: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for from in [issuer, Some(endpoint)].into_iter().flatten() {
        let Some(origin) = origin_of(from) else {
            continue;
        };
        for at in [origin.clone()].into_iter().chain(parent_of(&origin)) {
            if !out.contains(&at) {
                out.push(at);
            }
        }
    }
    out
}

/// An origin with its leading hostname label removed, when there is one to spare.
fn parent_of(origin: &str) -> Option<String> {
    let (scheme, host) = origin.split_once("://")?;
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 3 {
        return None;
    }
    Some(format!("{scheme}://{}", labels[1..].join(".")))
}

/// A published name, as somebody would say it.
///
/// Measured: the two servers that publish one call themselves "Zernio MCP
/// Server" and "Notion MCP (Beta)". A library row is already a list of MCP
/// servers, so repeating it on every row is noise — and a release qualifier
/// belongs to a version rather than to a name.
fn tidy(said: &str) -> String {
    let mut out = said.trim().to_string();
    for tail in [" MCP Server", " MCP server", " (Beta)", " (beta)", " MCP"] {
        if let Some(rest) = out.strip_suffix(tail) {
            out = rest.trim().to_string();
        }
    }
    if out.is_empty() {
        said.trim().to_string()
    } else {
        out
    }
}

#[utoipa::path(
    post, path = "/api/v1/connectors/from-url", tag = "connectors",
    request_body = FromUrl,
    responses(
        (status = 200, body = Probed, description = "What that address turned out to be"),
        (status = 400, body = ApiError),
    ),
)]
pub(super) async fn probe_url(
    State(_state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<FromUrl>,
) -> ApiResult<Json<Probed>> {
    let _ = whoever(&principal)?;
    let url = body.url.trim().to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that is not an address — an MCP server is an https:// URL".to_string(),
        ));
    }

    // **Asked, not assumed.** The server says whether it wants authorizing;
    // a pasted address that turns out to need none is a connector that works
    // immediately, and one that does is a Connect button on the row.
    let found = connectors::discover(&url).await;
    let (auth, scopes, said, issuer) = match &found {
        Ok(d) => (
            "oauth".to_string(),
            d.scopes.clone(),
            d.name.clone(),
            Some(d.authorize_url.clone()),
        ),
        // Not an error. Plenty of servers are open, and the refusal to
        // discover is itself the answer: there is nothing to authorize.
        Err(e) => {
            tracing::info!("{url} published no authorization metadata: {e:#}");
            ("none".to_string(), None, None, None)
        }
    };

    // The brand's own site rather than the MCP endpoint's, when they differ.
    let logo = connectors::fetch_logo(&brand_origins(issuer.as_deref(), &url))
        .await
        .map(|(bytes, kind)| format!("data:{kind};base64,{}", ft_proto::encode(&bytes)));

    Ok(Json(Probed {
        // What the server calls itself, when it says so. Trimmed of the two
        // words every one of them appends, because a row already knows these
        // are MCP servers and "Notion MCP (Beta)" is not what somebody would
        // call it out loud.
        name: said.map(|n| tidy(&n)).unwrap_or_else(|| name_from(&url)),
        auth,
        host: reqwest::Url::parse(&url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_default(),
        scopes,
        logo,
    }))
}

/// What to make, after somebody has read what the probe found.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddFromUrl {
    pub url: String,
    /// Editable, because a name derived from a hostname is a guess.
    pub name: String,
}

#[utoipa::path(
    post, path = "/api/v1/connectors/add", tag = "connectors",
    request_body = AddFromUrl,
    responses(
        (status = 201, body = crate::skills::Skill),
        (status = 400, body = ApiError),
    ),
)]
pub(super) async fn add_from_url(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<AddFromUrl>,
) -> ApiResult<(StatusCode, Json<crate::skills::Skill>)> {
    let me = whoever(&principal)?;
    let url = body.url.trim().to_string();
    let name = as_name(&body.name);
    crate::skills::check_name(&name).map_err(|e| ApiError::new(ErrorCode::InvalidRequest, e.0))?;

    let found = connectors::discover(&url).await;
    let auth = if found.is_ok() { "oauth" } else { "none" };
    let description = format!(
        "Tools from {}, as an agent can call them.",
        reqwest::Url::parse(&url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| name.clone())
    );

    // **The wrapper is written here, never by a person.** A pasted address is
    // an entry path and not a concept: nobody should have to learn what a
    // manifest is to use an MCP server, and the one this writes is the same
    // one a published plugin ships.
    let manifest = serde_json::json!({
        "name": name,
        "description": description,
        "version": "1.0.0",
        "author": { "name": "Added here" },
    });
    let manifest = serde_json::to_string_pretty(&manifest)
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;

    let mut files = vec![crate::skills::IncomingFile {
        path: ".claude-plugin/plugin.json".into(),
        contents: ft_proto::encode(manifest.as_bytes()),
        executable: false,
    }];

    // **The mark ships inside the bundle**, which is where a published plugin
    // carries one. Stored rather than linked: a row must draw without
    // reaching somebody else's origin, and a logo that 404s later is a broken
    // image in a library rather than a monogram.
    let issuer = found.as_ref().ok().map(|d| d.authorize_url.clone());
    {
        if let Some((bytes, kind)) =
            connectors::fetch_logo(&brand_origins(issuer.as_deref(), &url)).await
        {
            let ext = if kind.contains("svg") {
                "svg"
            } else if kind.contains("icon") || kind.contains("ico") {
                "ico"
            } else if kind.contains("jpeg") || kind.contains("jpg") {
                "jpg"
            } else {
                "png"
            };
            files.push(crate::skills::IncomingFile {
                path: format!("assets/logo.{ext}"),
                contents: ft_proto::encode(&bytes),
                executable: false,
            });
        }
    }

    let new = crate::skills::NewSkill {
        name: name.clone(),
        // **What they typed, not what `as_name` had to make of it.** Somebody
        // writing "Cal.com" gets a folder called `cal-com` because that is
        // what a folder can be called, and has been shown `cal-com` ever
        // since. The typed string was right there.
        display_name: Some(body.name.trim().to_string()).filter(|n| !n.is_empty()),
        description: description.clone(),
        frontmatter: serde_json::json!({ "name": name, "description": description }),
        body: String::new(),
        files,
        notes: None,
        kind: Some("plugin".into()),
    };
    crate::skills::check(&new).map_err(|e| ApiError::new(ErrorCode::InvalidRequest, e.0))?;

    let id = state
        .skills
        .create(
            me.org_id.as_str(),
            me.id.as_str(),
            &me.slug,
            &new,
            // A connector ships no executable and no instructions. There is
            // nothing here for an owner to review that the probe did not
            // already report.
            false,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    // The server key the agent will call it by. Its own name, so a tool shows
    // up as `linear:…` rather than under a hostname.
    state
        .skills
        .set_connector(id.as_str(), &name, &url, auth)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    // What the probe already learned, kept so the row can say whether this
    // one can be connected at all before anybody presses anything.
    connectors::remember(state.skills.pool(), id.as_str(), &url).await;

    let made = state
        .skills
        .one(me.id.as_str(), id.as_str(), crate::access::Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("plugin"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

#[cfg(test)]
mod tests {
    use super::{as_name, brand_origins, console_for, name_from};

    /// Every server we ship that registers no client has somewhere to go.
    ///
    /// The list it is matched against is the eleven in the catalogue that
    /// publish metadata and register nothing. A row that tells somebody to
    /// create an OAuth application and then links nowhere is the wall this
    /// whole form exists to remove, so a missing one is a bug and not a gap.
    #[test]
    fn every_server_that_needs_an_application_says_where_to_make_one() {
        for host in [
            "api.githubcopilot.com",
            "mcp.slack.com",
            "mcp.asana.com",
            "mcp.hubspot.com",
            "mcp.discord.com",
            "mcp.twilio.com",
            "api.elevenlabs.io",
            "mcp.frontapp.com",
            "mcp.loops.so",
            "mcp.render.com",
            "mcp.steel.dev",
        ] {
            let at = console_for(host);
            assert!(at.is_some(), "{host} has nowhere to send anybody");
            assert!(
                at.unwrap().starts_with("https://"),
                "{host}: {:?} is not a link",
                at
            );
        }
        // And a server nobody has written down says so, rather than guessing.
        assert_eq!(console_for("mcp.linear.app"), None);
    }

    /// A name from a hostname, and the two prefixes that are noise.
    #[test]
    fn the_name_is_the_part_somebody_would_say_out_loud() {
        assert_eq!(name_from("https://mcp.linear.app/mcp"), "linear");
        assert_eq!(name_from("https://mcp.notion.com/mcp"), "notion");
        assert_eq!(name_from("https://mcp.sentry.dev/mcp"), "sentry");
        assert_eq!(
            name_from("https://api.githubcopilot.com/mcp/"),
            "githubcopilot"
        );
        // No subdomain to drop.
        assert_eq!(name_from("https://example.com/mcp"), "example");
        // And nothing usable at all still produces a folder name.
        assert_eq!(name_from("not a url"), "connector");
    }

    /// The name field is editable, so most of what arrives here is typed.
    ///
    /// This used to run through `slug_of`, which writes `_` between words —
    /// a character a skill name forbids. So "my linear" and "my-linear" were
    /// both refused with "a name holds lowercase letters, digits and
    /// hyphens", which is the one thing they already were.
    #[test]
    fn a_typed_name_becomes_one_a_skill_can_have() {
        assert_eq!(as_name("linear"), "linear");
        assert_eq!(as_name("my-linear"), "my-linear");
        assert_eq!(as_name("My Linear"), "my-linear");
        assert_eq!(as_name("Sentry (Beta)"), "sentry-beta");
        assert_eq!(as_name("  spaced  out  "), "spaced-out");
        assert_eq!(as_name("--trim--me--"), "trim-me");
        assert_eq!(as_name(""), "connector");
        assert_eq!(as_name("!!!"), "connector");
        assert_eq!(as_name(&"a".repeat(80)).len(), 64);
        // Every one of these passes the rule it is checked against next.
        for typed in ["My Linear", "Sentry (Beta)", "  spaced  out  ", "!!!"] {
            assert!(
                crate::skills::check_name(&as_name(typed)).is_ok(),
                "{typed}"
            );
        }
    }

    /// Where a brand's mark is, when the issuer is not the brand's site.
    #[test]
    fn the_logo_is_looked_for_one_label_up_as_well() {
        // Linear's issuer *is* `mcp.linear.app`, which serves no page at all.
        assert_eq!(
            brand_origins(
                Some("https://mcp.linear.app/authorize"),
                "https://mcp.linear.app/mcp"
            ),
            ["https://mcp.linear.app", "https://linear.app"]
        );
        // A two-label host has no parent worth asking: dropping a label
        // leaves `com`.
        assert_eq!(
            brand_origins(None, "https://example.com/mcp"),
            ["https://example.com"]
        );
        // An issuer elsewhere is tried first, and the endpoint still follows.
        assert_eq!(
            brand_origins(
                Some("https://auth.acme.io/authorize"),
                "https://mcp.acme.dev/mcp"
            ),
            [
                "https://auth.acme.io",
                "https://acme.io",
                "https://mcp.acme.dev",
                "https://acme.dev"
            ]
        );
    }
}

/// The OAuth application somebody created by hand for a server that registers
/// none of its own.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HandMade {
    pub client_id: String,
    /// Absent for a public client — one that authorizes with PKCE alone, which
    /// is what a desktop or native application registers as. Present for a
    /// confidential one, and then it is this installation's rather than
    /// anybody's.
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// Give a connector an application to authorize with.
///
/// **The wall this is on the other side of.** A server that registers no
/// clients could be added and never used: Connect had nothing to send, the
/// row said so, and that was the end of it. GitHub, Slack and Google are all
/// here — between them most of what anybody actually wants to connect — so
/// "we cannot do that yet" was most of the product missing.
///
/// Discovery is run first rather than trusted from the row, because the
/// addresses this needs — authorize, token — are the server's to change, and
/// pasting a client id is the moment somebody is waiting for an answer.
#[utoipa::path(
    put, path = "/api/v1/connectors/{id}/client", tag = "connectors",
    params(("id" = String, Path, description = "The connector")),
    request_body = HandMade,
    responses((status = 204), (status = 400, body = ApiError)),
)]
pub(super) async fn set_client(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<HandMade>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let client_id = body.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that application needs a client id".to_string(),
        ));
    }

    let found = state
        .skills
        .connector_of(&id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?
        .ok_or_else(|| ApiError::not_found("connector"))?;

    let d = connectors::discover(&found.url)
        .await
        .map_err(|e| ApiError::new(ErrorCode::ActionFailed, format!("{e:#}")))?;

    let secret = body
        .client_secret
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Shared by every connector naming the same address, the same way the
    // person's own grant is: two bundles pointing at Slack are one
    // application, not two.
    let key_for = connectors::credential_key(state.skills.pool(), &id).await;
    if let Some(secret) = &secret {
        state
            .vault
            .put(
                crate::vault::Key::of(crate::vault::CONNECTOR_CLIENT, &key_for, ""),
                secret,
                "an OAuth application for a connector",
            )
            .await
            .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;
    }

    sqlx::query(
        "INSERT INTO connector_clients \
           (skill_id, resource, authorize_url, token_url, register_url, client_id, \
            has_secret, scopes) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) \
         ON CONFLICT (skill_id) DO UPDATE SET \
           resource = excluded.resource, authorize_url = excluded.authorize_url, \
           token_url = excluded.token_url, register_url = excluded.register_url, \
           client_id = excluded.client_id, has_secret = excluded.has_secret, \
           scopes = excluded.scopes",
    )
    .bind(&key_for)
    .bind(&d.resource)
    .bind(&d.authorize_url)
    .bind(&d.token_url)
    .bind(&d.register_url)
    .bind(&client_id)
    .bind(secret.is_some())
    .bind(&d.scopes)
    .execute(state.skills.pool())
    .await
    .map_err(|e| ApiError::new(ErrorCode::ActionFailed, e.to_string()))?;

    tracing::info!(
        connector = %found.server, by = %me.username,
        "an OAuth application was supplied by hand"
    );
    Ok(StatusCode::NO_CONTENT)
}

/// Record that this server will not hand out a client, whatever it advertises.
///
/// `needs_client_id` on a library row is `client_id IS NULL AND register_url
/// IS NULL`, so clearing the registration address is what moves the row from
/// a Connect button that cannot work to the form that can. Only the address
/// is dropped — the resource, the endpoints and the scopes are all still the
/// ones discovery found, and a client somebody has already supplied is left
/// alone.
async fn needs_a_client(state: &AppState, id: &str, found: &Discovered) {
    let _ = sqlx::query(
        "INSERT INTO connector_clients \
           (skill_id, resource, authorize_url, token_url, register_url, scopes) \
         VALUES ($1,$2,$3,$4,NULL,$5) \
         ON CONFLICT (skill_id) DO UPDATE SET \
           resource = excluded.resource, authorize_url = excluded.authorize_url, \
           token_url = excluded.token_url, register_url = NULL, \
           scopes = excluded.scopes \
         WHERE connector_clients.client_id IS NULL",
    )
    .bind(id)
    .bind(&found.resource)
    .bind(&found.authorize_url)
    .bind(&found.token_url)
    .bind(&found.scopes)
    .execute(state.skills.pool())
    .await;
}

/// Where somebody goes to make one, and what it has to say.
///
/// Each of these consoles asks a different question for the same thing, and
/// getting the redirect wrong is the failure that wastes an afternoon — so
/// the screen shows the exact value rather than describing it.
///
/// **Every entry here was opened before it was written down.** A row that
/// says "create an application" and links nowhere leaves somebody searching a
/// vendor's documentation for the page, which is most of the work; a row that
/// links to a 404 is worse than linking nothing.
///
/// `host` is the **MCP server's**, which is the one the library row has to
/// hand — `mcp.discord.com`, `api.githubcopilot.com`, `mcp.frontapp.com`. So
/// the match is on a substring and not on a domain, and `frontapp` rather
/// than `front` because a substring is all this gets to be.
pub fn console_for(host: &str) -> Option<&'static str> {
    Some(match host {
        h if h.contains("github") => "https://github.com/settings/applications/new",
        h if h.contains("slack") => "https://api.slack.com/apps",
        h if h.contains("google") => "https://console.cloud.google.com/auth/clients",
        h if h.contains("asana") => "https://app.asana.com/0/my-apps",
        h if h.contains("atlassian") => "https://developer.atlassian.com/console/myapps/",
        h if h.contains("hubspot") => "https://app.hubspot.com/developer",
        h if h.contains("discord") => "https://discord.com/developers/applications",
        h if h.contains("twilio") => {
            "https://console.twilio.com/us1/account/keys-credentials/oauth-apps"
        }
        h if h.contains("elevenlabs") => "https://elevenlabs.io/app/developers",
        h if h.contains("frontapp") => "https://app.frontapp.com/settings/developers",
        h if h.contains("loops") => "https://app.loops.so/settings?page=api",
        h if h.contains("render") => "https://dashboard.render.com/settings/oauth",
        h if h.contains("steel") => "https://app.steel.dev/settings",
        h if h.contains("figma") => "https://www.figma.com/developers/apps",
        _ => return None,
    })
}
