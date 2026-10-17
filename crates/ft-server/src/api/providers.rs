//! Authorizing a git host, so repositories can be listed and cloned — and
//! saying which git hosts there are.
//!
//! The waiting happens here rather than in the browser: an authorization is
//! approved on another device, and closing the tab shouldn't abandon it.
//!
//! **Two things are kept apart that read alike.** A *host* is the installation's
//! — its address, the application everybody authorizes against, whether it is
//! connected by browser or by token. A *token* is one person's, and two people
//! on one Firetower each hold their own for the same host. So adding a host is
//! an administrator's and connecting one is anybody's, and the endpoints below
//! are split on that line rather than on which screen calls them.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::oauth::{self, RemoteRepo};
use crate::providers::{self, AuthMode, Connection, KindInfo, PendingAuth, ProviderStatus};
use crate::vault::Key;
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

/// Whose git connection a request means.
///
/// Refused rather than defaulted when authentication is off: with nobody
/// signed in there is no account to authorize a git host as, and quietly using
/// the install's own would hand one person's token to whoever asked next.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "connecting a git host needs an account, and authentication is switched off",
        )
    })
}

/// Whether this caller may change what the whole installation points at.
///
/// Adding a host, editing its address, registering its application: all of it
/// is one answer, because all of it decides what everybody here authorizes
/// next. With authentication switched off there is nobody to be an
/// administrator and nothing to refuse.
fn may_administer(principal: &Principal) -> bool {
    principal
        .user
        .as_ref()
        .map(|u| u.role == "admin")
        .unwrap_or(true)
}

fn require_admin(principal: &Principal, what: &str) -> Result<(), ApiError> {
    match may_administer(principal) {
        true => Ok(()),
        false => Err(ApiError::new(
            ErrorCode::Forbidden,
            format!("{what} is an administrator's to change"),
        )),
    }
}

/// The host a request names, or a 404.
pub(super) async fn connection(state: &AppState, id: &str) -> Result<Arc<Connection>, ApiError> {
    state
        .connections
        .get(id)
        .await
        .ok_or_else(|| ApiError::not_found("provider"))
}

/// The identity this person's commits carry on this host.
///
/// What they set wins; what their token says is the default, kept the first
/// time it is asked for so a commit is never waiting on a request to the host;
/// and `None` means nobody knows, which the worker answers with an identity of
/// its own rather than refusing to commit.
pub(super) async fn identity_for(
    state: &AppState,
    conn: &Connection,
    owner: &str,
) -> Option<ft_proto::Author> {
    if let Ok(Some(set)) = state.db.git_identity(owner, &conn.id).await {
        return Some(set);
    }

    let token = super::git_token(state, conn, owner, "reading who commits belong to").await?;

    let account = match oauth::whoami(conn, &token).await {
        Ok(account) => account,
        Err(e) => {
            tracing::warn!("could not read the {} identity: {e:#}", conn.label);
            return None;
        }
    };

    if let Err(e) = state
        .db
        .remember_git_identity(owner, &conn.id, &account.author, "host")
        .await
    {
        // Worth a line, not worth failing: the commit is the point, and the
        // next one asks again.
        tracing::warn!("could not record the git identity: {e:#}");
    }

    Some(account.author)
}

/// What a person's commits are signed with, and where that came from.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: String,
    pub email: String,
    /// `host` — read from your token. `set` — you typed it, and nothing
    /// overwrites it.
    pub source: String,
}

/// Who this person's commits are authored as on this host.
#[utoipa::path(
    get, path = "/api/v1/providers/{id}/identity", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 200, body = GitIdentity),
        (status = 404, body = ApiError, description = "Nothing to derive one from"),
        (status = 409, body = ApiError, description = "That git host has not been authorized"),
    ),
)]
pub(super) async fn get_identity(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<GitIdentity>> {
    let conn = connection(&state, &id).await?;
    let owner = owner(&principal)?;

    // Asked before it is answered, so the screen can say which of the two this
    // is — a value you typed reads differently from one we guessed.
    let stored = state.db.git_identity(owner, &conn.id).await?.is_some();

    let author = identity_for(&state, &conn, owner).await.ok_or_else(|| {
        ApiError::new(
            ErrorCode::ProviderNotConnected,
            format!(
                "authorize {} first, or set a name and address yourself",
                conn.label
            ),
        )
    })?;

    let source = if stored {
        state
            .db
            .git_identity_source(owner, &conn.id)
            .await?
            .unwrap_or_else(|| "host".into())
    } else {
        "host".to_string()
    };

    Ok(Json(GitIdentity {
        name: author.name,
        email: author.email,
        source,
    }))
}

/// What to sign commits with, typed rather than derived.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetIdentity {
    pub name: String,
    pub email: String,
}

/// Say who your commits should be authored as.
///
/// Kept as `set`, which the derived answer never overwrites: the reason to
/// type one is that what the host said was not the address you wanted on your
/// branches.
#[utoipa::path(
    put, path = "/api/v1/providers/{id}/identity", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    request_body = SetIdentity,
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn set_identity(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<SetIdentity>,
) -> ApiResult<StatusCode> {
    let conn = connection(&state, &id).await?;
    let owner = owner(&principal)?;

    let name = req.name.trim();
    let email = req.email.trim();
    if name.is_empty() || email.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a commit needs both a name and an address",
        ));
    }
    // Not validated beyond this. Git accepts anything here, and a rule of our
    // own would be one more thing to be wrong about somebody's address.
    if !email.contains('@') {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that does not look like an email address",
        ));
    }

    state
        .db
        .remember_git_identity(
            owner,
            &conn.id,
            &ft_proto::Author {
                name: name.to_string(),
                email: email.to_string(),
            },
            "set",
        )
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

/// Go back to whatever the git host says you are called.
#[utoipa::path(
    delete, path = "/api/v1/providers/{id}/identity", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn clear_identity(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let conn = connection(&state, &id).await?;
    state
        .db
        .forget_git_identity(owner(&principal)?, &conn.id)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// An authorization in flight, and the task doing the waiting.
pub struct Pending {
    pub auth: PendingAuth,
    pub task: tokio::task::JoinHandle<()>,
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// One row of the git hosts list.
async fn status_of(
    state: &AppState,
    principal: &Principal,
    conn: &Connection,
    owner: &str,
) -> ApiResult<ProviderStatus> {
    let pending = state.pending.read().await;
    Ok(ProviderStatus {
        id: conn.id.clone(),
        label: conn.label.clone(),
        // The flag, not the token: reading the token is a blocking call the
        // operating system may put behind a prompt, and this endpoint only
        // renders a screen.
        connected: state
            .vault
            .holds(Key::of(vault::GIT, &conn.id, owner))
            .await?,
        configured: conn.configured(),
        pending: pending
            .get(&format!("{}:{owner}", conn.id))
            .map(|p| p.auth.clone()),
        client_id: conn.client_id(),
        may_set_application: may_administer(principal),
        kind: conn.kind.id.to_string(),
        base_url: conn.base_url.clone(),
        git_host: conn.git_host.clone(),
        auth: conn.auth,
        auth_modes: conn.kind.auth.to_vec(),
        change_noun: conn.kind.change_noun.to_string(),
        version: conn.version.clone(),
        builtin: conn.builtin,
        token_page: conn.token_page(),
        app_page: conn.app_page(),
        access_page: conn.access_page(),
        shared_application: conn.uses_shipped_application(),
    })
}

/// Every git host, and whether this person has connected it.
///
/// Built-in first, which is load-bearing rather than cosmetic: a desktop or
/// mobile build older than this change reads the first entry and ignores the
/// rest, so the first entry has to be the host it was already using.
#[utoipa::path(
    get, path = "/api/v1/providers", tag = "providers",
    responses((status = 200, body = Vec<ProviderStatus>)),
)]
pub(super) async fn list_providers(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<ProviderStatus>>> {
    // Whose connections these are. Two people on one Firetower each authorize
    // a host as themselves, and each sees only their own.
    let owner = owner(&principal)?;

    let mut out = Vec::new();
    for conn in state.connections.all().await.iter() {
        out.push(status_of(&state, &principal, conn, owner).await?);
    }
    Ok(Json(out))
}

/// What kinds of host can be added.
#[utoipa::path(
    get, path = "/api/v1/provider-kinds", tag = "providers",
    responses((status = 200, body = Vec<KindInfo>)),
)]
pub(super) async fn list_kinds() -> Json<Vec<KindInfo>> {
    Json(providers::kinds())
}

/// An address to reach before a git host is saved.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbeProvider {
    /// What somebody typed. A bare hostname is fine.
    pub base_url: String,
    /// `gitlab`, `gitea`, `github` — only when the caller already knows.
    ///
    /// Left off, and the kind is worked out from what answers. **Which is the
    /// point**: the add screen used to make somebody pick between three logos
    /// before typing anything, and that is a question the address itself
    /// answers. It also does not scale — three buttons already crowd the row,
    /// and a fourth and fifth kind would wrap it.
    #[serde(default)]
    pub kind: Option<String>,
}

/// What was at the other end.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProbedProvider {
    /// What answered: `github`, `gitlab`, `gitea`.
    pub kind: String,
    /// What that kind is called, for the sentence the screen writes.
    pub kind_label: String,
    /// A name to prefill, so the common case is one field and a press.
    ///
    /// The kind for the hosted instances — a second GitHub account is just
    /// "GitHub" until somebody renames it — and the hostname for everything
    /// else, which is the thing that tells two of a kind apart.
    pub suggested_label: String,
    /// The address as it will be stored, so the form can show what it made of
    /// what was typed.
    pub base_url: String,
    pub api_base: String,
    pub git_host: String,
    /// What it said it was, when it would say.
    pub version: Option<String>,
    /// Which ways of connecting are actually available here.
    ///
    /// The whole reason this endpoint exists. GitLab grew a device flow in
    /// 17.9, so on a 16.x instance the browser option has to be absent rather
    /// than present-and-doomed — otherwise somebody registers an application,
    /// presses Connect, and is told their client id was rejected.
    pub auth_modes: Vec<AuthMode>,
    /// Why a way of connecting is missing, when one is.
    pub note: Option<String>,
}

/// Reach a host and say what is there.
///
/// Run before one is saved. An address that cannot be reached is still savable
/// — a laptop off the VPN is not a reason to refuse to record a URL — but what
/// was found is worth putting on screen either way.
#[utoipa::path(
    post, path = "/api/v1/providers/probe", tag = "providers",
    request_body = ProbeProvider,
    responses(
        (status = 200, body = ProbedProvider),
        (status = 400, body = ApiError),
        (status = 403, body = ApiError),
        (status = 409, body = ApiError, description = "Nothing of that kind answered"),
    ),
)]
pub(super) async fn probe_provider(
    State(_state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<ProbeProvider>,
) -> ApiResult<Json<ProbedProvider>> {
    require_admin(&principal, "the git hosts this Firetower knows about")?;

    let (base_url, git_host) = providers::normalize_base(&req.base_url)
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;

    // Named, or worked out from what answers.
    let asked =
        match req.kind.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
            Some(named) => Some(providers::kind(named).ok_or_else(|| {
                ApiError::new(ErrorCode::InvalidRequest, "no such kind of git host")
            })?),
            None => None,
        };

    let (kind, reached) = match asked {
        Some(kind) => {
            let api_base = providers::api_base_for(kind, &base_url);
            let reached = oauth::probe(kind, &api_base).await.map_err(|e| {
                unreachable_at(&req.base_url, &base_url, Some(kind), &format!("{e:#}"))
            })?;
            (kind, reached)
        }
        None => identify(&base_url)
            .await
            .ok_or_else(|| unreachable_at(&req.base_url, &base_url, None, ""))?,
    };

    let api_base = providers::api_base_for(kind, &base_url);
    let (auth_modes, note) = available_auth(kind, reached.version.as_deref());

    Ok(Json(ProbedProvider {
        kind: kind.id.to_string(),
        kind_label: kind.label.to_string(),
        suggested_label: match kind.hosted.as_ref().map(|h| h.base_url) == Some(base_url.as_str()) {
            true => kind.label.to_string(),
            false => git_host.clone(),
        },
        base_url,
        api_base,
        git_host,
        version: reached.version,
        auth_modes,
        note,
    }))
}

/// Whether `https` was Firetower's assumption rather than somebody's choice.
fn scheme_was_guessed(typed: &str) -> bool {
    !typed.trim().contains("://")
}

fn trimmed(typed: &str) -> String {
    typed.trim().trim_end_matches('/').to_string()
}

/// Which ways in this instance actually has, and why one is missing.
///
/// The version comparison is the point. GitLab's device authorization grant is
/// generally available from 17.9 — it existed behind a flag from 17.2 — and an
/// instance older than that answers the attempt with a refusal indistinguishable
/// from a wrong client id. Reading the version here turns that into a sentence
/// somebody can act on.
fn available_auth(
    kind: &'static providers::Kind,
    version: Option<&str>,
) -> (Vec<AuthMode>, Option<String>) {
    let all = kind.auth.to_vec();

    if kind.id != "gitlab" {
        let note = (!all.contains(&AuthMode::Device)).then(|| {
            format!(
                "{} implements the authorization code grant and no device flow, so everybody \
                 connects it with a token of their own.",
                kind.label
            )
        });
        return (all, note);
    }

    let Some(version) = version else {
        // It would not say, which is the ordinary case for a GitLab that wants
        // a token on `/version`. Offer both and let the attempt be the test.
        return (
            all,
            Some(
                "This instance would not say which version it is, so the browser flow is \
                 offered on trust — it needs GitLab 17.9 or newer."
                    .into(),
            ),
        );
    };

    match semver_at_least(version, 17, 9) {
        true => (all, None),
        false => (
            vec![AuthMode::Token],
            Some(format!(
                "GitLab {version} has no device authorization flow — it arrived in 17.9 — so \
                 everybody connects this one with a token of their own."
            )),
        ),
    }
}

/// Which kind of git host is at an address, by asking each in turn.
///
/// Cheap and definitive: the three answer on paths none of the others have —
/// `/api/v1/version` is Gitea's, `/api/v4/version` is GitLab's, `/api/v3/meta`
/// is GitHub Enterprise's. A hosted instance is recognised by its address
/// before anything is asked at all, because github.com's API lives on another
/// hostname entirely and there is nothing to discover.
///
/// Tried in series rather than at once. It is three requests at the very worst,
/// it only runs while somebody is looking at a form, and running them together
/// would mean three connections to a host that may be refusing them.
async fn identify(base_url: &str) -> Option<(&'static providers::Kind, oauth::Reached)> {
    for kind in providers::KINDS {
        if kind.hosted.as_ref().map(|h| h.base_url) == Some(base_url) {
            let api_base = providers::api_base_for(kind, base_url);
            return oauth::probe(kind, &api_base).await.ok().map(|r| (kind, r));
        }
    }

    for kind in providers::KINDS {
        let api_base = providers::api_base_for(kind, base_url);
        if let Ok(reached) = oauth::probe(kind, &api_base).await {
            return Some((kind, reached));
        }
    }
    None
}

/// Why nothing useful was at an address.
///
/// The scheme is the usual reason and the hardest to guess from what TLS says:
/// meeting a plain-http server, rustls reports "received corrupt message of
/// type InvalidContentType", which reads as a broken instance rather than as a
/// scheme to correct.
fn unreachable_at(
    typed: &str,
    base_url: &str,
    kind: Option<&'static providers::Kind>,
    said: &str,
) -> ApiError {
    let what = match kind {
        Some(kind) => format!("couldn't reach a {} at {base_url}: {said}", kind.label),
        None => format!(
            "nothing answered at {base_url}. Firetower asked it as a GitHub, a GitLab and a \
             Gitea, and none of them replied"
        ),
    };
    let scheme = match scheme_was_guessed(typed) {
        true => format!(". If it is plain http, say so: http://{}", trimmed(typed)),
        false => String::new(),
    };
    ApiError::new(ErrorCode::HostUnreachable, format!("{what}{scheme}"))
}

/// How a host should be connected when nobody said.
///
/// **The usable one, not the nicer one.** Browser sign-in is better for the
/// people who use it — press a button, approve a code, never handle a token —
/// so it is tempting to default to it everywhere. The trouble is that on a host
/// Firetower ships no application for, browser sign-in needs an administrator
/// to go and register one *somewhere else* before anybody can connect at all.
/// Defaulting to it there does not produce a host with a nicer sign-in; it
/// produces a host that is added and unusable, and an Add button that silently
/// did not finish the job.
///
/// So: pick a way in that works the moment this returns.
///
///   * an application already applies — ours, for github.com and gitlab.com, or
///     one pasted into this very form — then browser, which is both zero-setup
///     *and* the nicer one;
///   * otherwise a token, which needs nothing registered anywhere;
///   * and only where the kind has no token path at all, browser, which will
///     say it needs an application rather than pretend otherwise.
///
/// Upgrading afterwards is safe, and is where the nicer flow comes from on a
/// self-hosted instance: moving a host from token to browser keeps every token
/// already in the vault, because what opens a repository is the secret at
/// `git/<id>/<owner>` and not the way it got there.
fn default_auth(
    available: &[AuthMode],
    client_id: Option<&str>,
    shipped_applies: bool,
) -> AuthMode {
    // Either one they supplied, or the one Firetower ships where this address
    // is entitled to it — see `Connections::would_be_builtin`. An earlier
    // version counted only the first, on the since-false reasoning that a row
    // being created is never `builtin`: taking the shipped GitHub out and
    // putting it back *is* builtin, and came back on the token path with a
    // working browser flow it never offered.
    let have_application =
        shipped_applies || client_id.map(str::trim).is_some_and(|c| !c.is_empty());

    if have_application && available.contains(&AuthMode::Device) {
        return AuthMode::Device;
    }
    if available.contains(&AuthMode::Token) {
        return AuthMode::Token;
    }
    available.first().copied().unwrap_or(AuthMode::Token)
}

/// Whether a version string is at least `major.minor`.
///
/// Compared rather than string-matched, and tolerant of the tail: GitLab
/// reports `17.4.1`, `17.4.1-ee` and occasionally `17.4.1-pre`, and all three
/// are the same answer to this question.
fn semver_at_least(version: &str, major: u64, minor: u64) -> bool {
    let mut parts = version
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+', ' ']);
    let Some(found_major) = parts.next().and_then(|p| p.parse::<u64>().ok()) else {
        return false;
    };
    let found_minor = parts
        .next()
        .and_then(|p| p.parse::<u64>().ok())
        .unwrap_or(0);
    (found_major, found_minor) >= (major, minor)
}

/// A git host to add.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewProvider {
    pub kind: String,
    /// What everybody here will see it called.
    pub label: String,
    /// Where it is. Left off for a kind with a hosted instance, which means
    /// that one.
    pub base_url: Option<String>,
    /// How people will connect it. The kind's first supported mode by default.
    pub auth: Option<AuthMode>,
    /// The application to authorize against, for the browser flow.
    pub client_id: Option<String>,
}

/// Add a git host.
///
/// **The installation's, so this is an administrator's.** The address and the
/// application decide what everybody here authorizes against next, which is the
/// same reason `set_client_id` is closed.
///
/// Reached before it is saved, and *not* refused when it cannot be: a control
/// plane that is temporarily off the network it shares with somebody's GitLab
/// should still be able to record where it is. What the probe buys is the
/// version, and therefore an honest answer about whether the browser flow is
/// available.
#[utoipa::path(
    post, path = "/api/v1/providers", tag = "providers",
    request_body = NewProvider,
    responses(
        (status = 201, body = ProviderStatus),
        (status = 400, body = ApiError),
        (status = 403, body = ApiError),
        (status = 409, body = ApiError, description = "Already connected under that name"),
    ),
)]
pub(super) async fn create_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<NewProvider>,
) -> ApiResult<(StatusCode, Json<ProviderStatus>)> {
    require_admin(&principal, "the git hosts this Firetower knows about")?;
    let owner = owner(&principal)?;

    let kind = providers::kind(&req.kind)
        .ok_or_else(|| ApiError::new(ErrorCode::InvalidRequest, "no such kind of git host"))?;

    let label = req.label.trim();
    if label.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "give it a name — it is how anybody tells two of these apart",
        ));
    }

    // The hosted instance when one was not named, which is the whole of what a
    // second GitHub account needs: a label and nothing else.
    let typed = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let (base_url, git_host) = match (typed, kind.hosted.as_ref()) {
        (Some(typed), _) => providers::normalize_base(typed)
            .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?,
        (None, Some(hosted)) => (hosted.base_url.to_string(), hosted.git_host.to_string()),
        (None, None) => {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "{} is always somewhere you host, so it needs an address",
                    kind.label
                ),
            ))
        }
    };
    let api_base = providers::api_base_for(kind, &base_url);

    if state
        .connections
        .address_taken(kind.id, &git_host, label)
        .await
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "there is already a {} called {label} at {git_host}",
                kind.label
            ),
        ));
    }

    // Asked, not insisted on. The version is what decides whether the browser
    // flow is honest to offer, and not being able to ask is not a reason to
    // refuse to write the row.
    let reached = oauth::probe(kind, &api_base).await.ok();
    let version = reached.and_then(|r| r.version);
    let (available, _) = available_auth(kind, version.as_deref());

    // Whether this address is entitled to the application Firetower ships,
    // which is what makes the browser flow usable with nothing registered.
    let shipped_applies = state
        .connections
        .would_be_builtin(kind, &base_url)
        .await
        && !kind.client_id.trim().is_empty();

    let auth = req.auth.unwrap_or_else(|| {
        default_auth(&available, req.client_id.as_deref(), shipped_applies)
    });
    if !kind.auth.contains(&auth) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} cannot be connected that way", kind.label),
        ));
    }

    let conn = state
        .connections
        .create(providers::NewConnection {
            kind,
            label: label.to_string(),
            base_url,
            api_base,
            git_host,
            auth,
            client_id: req.client_id,
            version,
        })
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    tracing::info!(provider = conn.id, kind = kind.id, "a git host was added");
    let status = status_of(&state, &principal, &conn, owner).await?;
    Ok((StatusCode::CREATED, Json(status)))
}

/// What may be changed about a host after it exists.
///
/// Not the address. A host whose address moves is a different host — the
/// repositories cloned from the old one still point at it, and the tokens
/// issued by it are still for it — so moving one is removing it and adding the
/// new one, which is at least honest about what happens to everything that
/// referred to it.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderChanges {
    pub label: Option<String>,
    pub auth: Option<AuthMode>,
    /// An empty string clears it, which is how somebody takes an application
    /// back off a host they would rather everybody connected with a token.
    pub client_id: Option<String>,
}

#[utoipa::path(
    patch, path = "/api/v1/providers/{id}", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    request_body = ProviderChanges,
    responses(
        (status = 200, body = ProviderStatus),
        (status = 400, body = ApiError),
        (status = 403, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn update_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<ProviderChanges>,
) -> ApiResult<Json<ProviderStatus>> {
    require_admin(&principal, "a git host")?;
    let owner = owner(&principal)?;
    let conn = connection(&state, &id).await?;

    if let Some(auth) = req.auth {
        if !conn.kind.auth.contains(&auth) {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!("{} cannot be connected that way", conn.kind.label),
            ));
        }
    }

    state
        .connections
        .update(
            &conn.id,
            req.label.as_deref(),
            req.auth,
            req.client_id.as_deref(),
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    // The built-in host's client id is also written to the setting it used to
    // live in. Never read back — the row is the answer — but a control plane
    // rolled back to before the migration reads that key and has to still find
    // a value there.
    if conn.builtin {
        if let Some(client_id) = req
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if let Err(e) = state
                .accounts
                .set_setting(&providers::setting_key(&conn.id), client_id)
                .await
            {
                tracing::warn!(
                    "could not leave the client id where an older build reads it: {e:#}"
                );
            }
        }
    }

    let conn = connection(&state, &id).await?;
    Ok(Json(status_of(&state, &principal, &conn, owner).await?))
}

/// Remove a git host.
///
/// **Any of them, including the one that ships.** It was exempt, which left a
/// row in the list with no Remove and no reason visible from outside this
/// crate — and an installation that does not use GitHub could never be rid of
/// it. The exemption was protecting an id rather than a user: re-adding gave a
/// fresh one and stranded whatever referred to the old. `Connections::create`
/// reuses the well-known id for a kind's hosted instance, so removing it is
/// reversible and the special case is gone.
///
/// Every token anybody held for it goes with it — they are that host's and
/// useless anywhere else. Repositories cloned from it are left alone and fall
/// back to being matched by hostname, which means they keep working if another
/// host at the same address is still connected and stop finding a token if not.
/// That is the right way round: a row pointing at a real remote is worth more
/// than a tidy database.
#[utoipa::path(
    delete, path = "/api/v1/providers/{id}/connection", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 204),
        (status = 400, body = ApiError, description = "The built-in host cannot be removed"),
        (status = 403, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn delete_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    require_admin(&principal, "a git host")?;
    let conn = connection(&state, &id).await?;

    // Everybody's, not only the asker's: the host is going, and a token for a
    // host that no longer exists is a credential nobody can account for.
    state
        .pending
        .write()
        .await
        .retain(|key, _| !key.starts_with(&format!("{}:", conn.id)));
    if let Err(e) = state
        .vault
        .forget_all(vault::GIT, &conn.id, "the git host was removed")
        .await
    {
        tracing::warn!("could not forget the tokens for {}: {e:#}", conn.label);
    }

    state
        .connections
        .delete(&conn.id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    tracing::info!(provider = conn.id, "a git host was removed");
    Ok(StatusCode::NO_CONTENT)
}

/// Start an authorization and begin waiting for it to be approved.
///
/// Returns immediately with the code to show. The waiting happens here rather
/// than in the browser so that closing the tab doesn't abandon it.
///
/// Asked again by somebody already connected, and deliberately so: the host's
/// approval screen is where organizations are granted, and it is shown once
/// per authorization. Somebody who skipped an organization the first time has
/// nowhere else to go. Nothing is given up by trying — the vault is written
/// only where the poll below approves, so a re-authorization that is abandoned
/// or declined leaves the token that is already there untouched, and the
/// insert at the end replaces any earlier attempt, whose `Drop` stops its
/// poller.
#[utoipa::path(
    post, path = "/api/v1/providers/{id}/authorize", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 200, body = PendingAuth),
        (status = 404, body = ApiError),
        (status = 501, body = ApiError),
    ),
)]
pub(super) async fn authorize_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<PendingAuth>> {
    let conn = connection(&state, &id).await?;
    let owner = owner(&principal)?.to_string();

    if conn.auth == AuthMode::Token {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} is connected by pasting a token. Make one at {} and paste it here.",
                conn.label,
                conn.token_page()
            ),
        ));
    }

    let client_id = conn.client_id();
    if client_id.is_none() {
        return Err(ApiError::new(
            ErrorCode::ProviderNotConfigured,
            format!(
                "no application is registered for {}. Add its client id — the connect screen \
                 asks for one and explains where to get it.",
                conn.label,
            ),
        ));
    }

    // Held for the polling task below, which needs it on every attempt.
    let polling_id = client_id.clone().expect("checked just above");

    let started = oauth::start(&conn, client_id).await.map_err(|e| match e {
        oauth::StartError::NotConfigured(m) => ApiError::new(ErrorCode::ProviderNotConfigured, m),
        oauth::StartError::Unreachable(m) => ApiError::new(ErrorCode::HostUnreachable, m),
        oauth::StartError::RateLimited(m) => ApiError::new(ErrorCode::ProviderBusy, m),
    })?;

    let auth = PendingAuth {
        user_code: started.user_code.clone(),
        // The page with the code already in it where the host offers one, and
        // the bare page otherwise. The code is shown either way.
        verification_uri: started
            .verification_uri_complete
            .clone()
            .filter(|u| !u.trim().is_empty())
            .unwrap_or_else(|| started.verification_uri.clone()),
    };

    // Keyed by person as well as host: two people authorizing the same host at
    // the same moment are two authorizations, and one map key would have the
    // second overwrite the first.
    let waiting_on = format!("{}:{owner}", conn.id);
    let pending = state.pending.clone();
    let vault = state.vault.clone();
    let device_code = started.device_code.clone();
    let mut interval = std::time::Duration::from_secs(started.interval.max(1));
    let waiting_key = waiting_on.clone();
    let conn = conn.clone();

    let task = tokio::spawn(async move {
        // The host tells us how often it will answer; asking faster earns a
        // slow_down and gets us nowhere.
        loop {
            tokio::time::sleep(interval).await;

            match oauth::poll(&conn, &polling_id, &device_code).await {
                Ok(oauth::Poll::Pending) => continue,
                Ok(oauth::Poll::SlowDown) => {
                    interval += std::time::Duration::from_secs(5);
                }
                Ok(oauth::Poll::Approved(grant)) => {
                    // Stored whole. On GitLab that means the refresh token and
                    // the two-hour expiry as well as the token itself — see
                    // `oauth::grant`, and `api::git_token` for what spends them.
                    match vault
                        .put(
                            Key::of(vault::GIT, &conn.id, &owner),
                            &grant.to_stored(),
                            &format!("{} authorized in a browser", conn.label),
                        )
                        .await
                    {
                        Ok(()) => tracing::info!("{} authorized", conn.label),
                        Err(e) => tracing::error!("storing the {} token: {e:#}", conn.label),
                    }
                    pending.write().await.remove(&waiting_key);
                    return;
                }
                Ok(oauth::Poll::Failed(why)) => {
                    tracing::warn!("{} authorization ended: {why}", conn.label);
                    pending.write().await.remove(&waiting_key);
                    return;
                }
                Err(e) => {
                    tracing::warn!("polling {}: {e:#}", conn.label);
                }
            }
        }
    });

    state.pending.write().await.insert(
        waiting_on,
        Pending {
            auth: auth.clone(),
            task,
        },
    );

    Ok(Json(auth))
}

/// A token somebody made on the host and pasted here.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderToken {
    pub token: String,
}

/// Who the token turned out to belong to, so the screen can say.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Authorized {
    pub account: String,
}

/// Connect a host with a token, for the hosts that connect that way.
///
/// Tried before it is kept, like a tracker's key: a token that does not work
/// stored anyway is an empty repository picker on another screen with nothing
/// saying why. And the answer to the attempt is the account it belongs to,
/// which is the identity its commits will carry and the username its pushes
/// will use — so one request does the check and fills both in.
#[utoipa::path(
    put, path = "/api/v1/providers/{id}/token", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    request_body = ProviderToken,
    responses(
        (status = 200, body = Authorized),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError, description = "The host refused the token"),
    ),
)]
pub(super) async fn set_provider_token(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<ProviderToken>,
) -> ApiResult<Json<Authorized>> {
    let conn = connection(&state, &id).await?;
    let owner = owner(&principal)?;

    let token = req.token.trim();
    if token.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a token is needed",
        ));
    }

    let account = oauth::whoami(&conn, token).await.map_err(|e| {
        ApiError::new(
            ErrorCode::ProviderNotConnected,
            format!("{} would not accept that token: {e:#}", conn.label),
        )
    })?;

    state
        .vault
        .put(
            Key::of(vault::GIT, &conn.id, owner),
            token,
            &format!("{} connected with a token", conn.label),
        )
        .await?;

    // What the host said about the account, kept now rather than on the first
    // push. It is already in hand, and the alternative is a commit waiting on a
    // request.
    if let Err(e) = state
        .db
        .remember_git_identity(owner, &conn.id, &account.author, "host")
        .await
    {
        tracing::warn!("could not record the git identity: {e:#}");
    }

    tracing::info!(provider = conn.id, "a git host was connected with a token");
    Ok(Json(Authorized {
        account: account.login,
    }))
}

/// Sign out: forget the token and stop any authorization still waiting.
///
/// The host stays. It is the installation's and somebody else here may be using
/// it; removing it is [`delete_provider`].
#[utoipa::path(
    delete, path = "/api/v1/providers/{id}", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn disconnect_provider(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let conn = connection(&state, &id).await?;
    let owner = owner(&principal)?;
    state
        .pending
        .write()
        .await
        .remove(&format!("{}:{owner}", conn.id));
    state
        .vault
        .forget(
            Key::of(vault::GIT, &conn.id, owner),
            "signed out of the git host",
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What the authorized account can see. This is the picker's data.
#[utoipa::path(
    get, path = "/api/v1/providers/{id}/repos", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    responses(
        (status = 200, body = Vec<RemoteRepo>),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError, description = "That git host has not been authorized"),
    ),
)]
pub(super) async fn list_provider_repos(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<RemoteRepo>>> {
    let conn = connection(&state, &id).await?;

    // Asked with this person's token: the picker must show what they can
    // clone, not what somebody else can.
    let token = super::git_token(
        &state,
        &conn,
        owner(&principal)?,
        "listing repositories to pick from",
    )
    .await
    .ok_or_else(|| {
        ApiError::new(
            ErrorCode::ProviderNotConnected,
            format!("{} hasn't been authorized yet", conn.label),
        )
    })?;

    oauth::list_repos(&conn, &token)
        .await
        .map(Json)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

/// The client id for a git host, supplied by whoever is setting this up.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClientId {
    /// GitHub's looks like `Ov23li…`. Public by design: a device-flow
    /// application has no paired secret.
    pub client_id: String,
}

/// Register an application to authorize against.
///
/// Asked twice on purpose: once in the setup wizard, where it is skippable,
/// and again on the connect-a-repository screen at the moment somebody wants
/// the thing it enables. Stored rather than configured, so it takes effect
/// without a restart.
///
/// **The application is the installation's, so changing it is an
/// administrator's.** The id itself is public — a device-flow application has
/// no paired secret — and it is shared by everybody here by construction,
/// which is the point: one application, and each person's own token under it.
/// That is also why this was worth closing. Anyone at all could point the
/// whole installation at an application they controlled, and the next person
/// to connect would authorize it.
///
/// Kept beside [`update_provider`], which can do this and more, because three
/// committed clients call this path and a removed endpoint is a broken app.
#[utoipa::path(
    post, path = "/api/v1/providers/{id}/client-id", tag = "providers",
    params(("id" = String, Path, description = "Provider id")),
    request_body = ClientId,
    responses(
        (status = 204, description = "Stored"),
        (status = 400, body = ApiError),
        (status = 403, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn set_client_id(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(request): Json<ClientId>,
) -> ApiResult<StatusCode> {
    require_admin(
        &principal,
        "the application this Firetower authorizes against",
    )?;
    let conn = connection(&state, &id).await?;

    let value = request.client_id.trim();
    if value.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a client id is needed, or leave it alone",
        ));
    }

    state
        .connections
        .update(&conn.id, None, None, Some(value))
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    // The breadcrumb for an older build. See `update_provider`.
    if conn.builtin {
        state
            .accounts
            .set_setting(&providers::setting_key(&conn.id), value)
            .await?;
    }

    tracing::info!(provider = conn.id, "a client id was registered");
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GitLab's device flow arrived in 17.9. An instance older than that
    /// answers an attempt with a refusal that reads exactly like a wrong client
    /// id, so the version is what turns "your client id was rejected" into
    /// "this GitLab is too old for that".
    #[test]
    fn an_old_gitlab_is_not_offered_a_browser_flow() {
        let gitlab = providers::kind("gitlab").unwrap();

        let (modes, note) = available_auth(gitlab, Some("16.11.3"));
        assert_eq!(modes, vec![AuthMode::Token]);
        assert!(note.unwrap().contains("17.9"));

        let (modes, note) = available_auth(gitlab, Some("17.9.0"));
        assert!(
            modes.contains(&AuthMode::Device),
            "17.9 is where it arrived"
        );
        assert!(note.is_none());

        let (modes, _) = available_auth(gitlab, Some("18.0.1-ee"));
        assert!(modes.contains(&AuthMode::Device));
    }

    /// An instance that would not say is offered both, with a sentence saying
    /// why. Refusing the browser flow on silence would deny it to every
    /// correctly-configured GitLab that keeps `/version` behind a token.
    #[test]
    fn a_gitlab_that_will_not_say_its_version_is_taken_on_trust() {
        let (modes, note) = available_auth(providers::kind("gitlab").unwrap(), None);
        assert!(modes.contains(&AuthMode::Device));
        assert!(note.unwrap().contains("17.9"));
    }

    /// Gitea has none at any version, so the note is about the software rather
    /// than about this instance.
    #[test]
    fn gitea_is_told_as_a_fact_about_gitea() {
        let (modes, note) = available_auth(providers::kind("gitea").unwrap(), Some("1.22.1"));
        assert_eq!(modes, vec![AuthMode::Token]);
        assert!(note.unwrap().contains("no device flow"));
    }

    /// The rule is "a way in that works now", not "the nicer way in".
    ///
    /// Browser sign-in is genuinely better for the people who use it. But on a
    /// host with no application registered at all it cannot be used by
    /// anybody, and defaulting to it added a host that reported itself
    /// unconfigured the moment it was created — an Add button that did not
    /// finish.
    ///
    /// "No application" means neither theirs nor ours. The second half is the
    /// one that was wrong: the earlier version reasoned that a row being
    /// created is never `builtin`, which stopped being true when the shipped
    /// host became removable. Remove github.com and add it back and it takes
    /// the well-known id *and* the `builtin` flag — so the shipped application
    /// does apply, and defaulting to a token hid a browser flow that worked.
    #[test]
    fn a_new_host_defaults_to_a_way_in_that_works_today() {
        let both = [AuthMode::Device, AuthMode::Token];

        // Nothing registered anywhere: a token, which works once it is saved.
        assert_eq!(default_auth(&both, None, false), AuthMode::Token);
        assert_eq!(default_auth(&both, Some(""), false), AuthMode::Token);
        // Whitespace is not an application.
        assert_eq!(default_auth(&both, Some("   "), false), AuthMode::Token);

        // One registered in the same breath: browser, which now works and is
        // the nicer of the two.
        assert_eq!(default_auth(&both, Some("abc"), false), AuthMode::Device);

        // And the one Firetower ships, where the address is entitled to it —
        // taking the built-in GitHub back has no client id of its own and
        // needs none.
        assert_eq!(default_auth(&both, None, true), AuthMode::Device);
        assert_eq!(default_auth(&both, Some(""), true), AuthMode::Device);

        // A GitLab too old for the device grant is offered only a token, so
        // that is what it gets whatever else is true.
        assert_eq!(
            default_auth(&[AuthMode::Token], Some("abc"), true),
            AuthMode::Token
        );
        // Gitea has no device flow at any version, and ships no application.
        assert_eq!(default_auth(&[AuthMode::Token], None, false), AuthMode::Token);
    }

    #[test]
    fn a_version_is_compared_rather_than_matched() {
        assert!(semver_at_least("17.9.0", 17, 9));
        assert!(semver_at_least("17.10.0", 17, 9));
        assert!(semver_at_least("18.0.0", 17, 9));
        assert!(!semver_at_least("17.8.9", 17, 9));
        assert!(!semver_at_least("16.11.3", 17, 9));
        // The tails GitLab actually sends.
        assert!(semver_at_least("17.9.1-ee", 17, 9));
        assert!(semver_at_least("v18.1.0", 17, 9));
        // Nonsense is not a version, and must not read as a new one.
        assert!(!semver_at_least("", 17, 9));
        assert!(!semver_at_least("unknown", 17, 9));
    }
}
