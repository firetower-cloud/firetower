//! The HTTP surface.
//!
//! Handlers carry `#[utoipa::path]`, types derive `ToSchema`, and the document
//! generated from them is the single contract the typed client is built from.
//! A field renamed here becomes a compile error in the web application rather
//! than a runtime surprise.
//!
//! One module per tag, which is also one module per screen. What lives here is
//! only what every one of them needs: the error type, the document, and the
//! router that puts them in order.

mod agents;
mod auth;
mod conversation;
mod events;
mod hosts;
mod providers;
mod repos;
mod secrets;
mod sessions;
mod setup;
mod terminal;

// `providers` on its own is the module below, which is this crate's git-host
// screen rather than the git hosts themselves.
use crate::oauth::RemoteRepo;
use crate::providers::{PendingAuth, ProviderStatus};
use crate::vault;
use crate::AppState;
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use ft_core::{Agent, AgentMode, AgentPresence, Event, SessionStatus};
use ft_proto::Credential;
use serde::Serialize;
use utoipa::{OpenApi, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

/// An authorization in flight, held by the control plane so that closing the
/// browser tab doesn't abandon it.
pub use providers::Pending;

/// Every non-success response, so failures are as typed as everything else.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: ErrorCode,
    /// For humans and logs. The interface should switch on `code` and write its
    /// own copy — only it knows the context and what to offer next.
    pub message: String,
}

/// The catalogue is the type, so there is no separate list to keep in sync.
#[derive(Debug, Clone, Copy, Serialize, ToSchema)]
pub enum ErrorCode {
    InvalidRequest,
    NotFound,
    NoCapacity,
    HostUnreachable,
    RepoNotConnected,
    SessionEnded,
    /// This build has no registered application for that git host.
    ProviderNotConfigured,
    /// Nobody has authorized that git host yet.
    ProviderNotConnected,
    /// We reached the repository's host and were refused.
    RepoAccessDenied,
    /// We could not reach the repository at all.
    RepoUnreachable,
    /// Reachable, but there is nothing there to work from.
    RepoUnusable,
    /// Disconnecting would orphan running work.
    RepoInUse,
    /// The host tried and it didn't work — nothing to commit, push rejected.
    ActionFailed,
    /// Nobody is signed in, or the session has ended. The interface shows the
    /// sign-in screen rather than reporting a fault.
    Unauthorized,
    /// Signed in, with a password that came from a file. Every other request
    /// is refused until it is replaced — the interface turns this into the
    /// wizard's first step rather than an error.
    PasswordChangeRequired,
    Internal,
}

impl ErrorCode {
    pub(crate) fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::NotFound | Self::RepoNotConnected => StatusCode::NOT_FOUND,
            Self::ProviderNotConfigured => StatusCode::NOT_IMPLEMENTED,
            Self::ProviderNotConnected | Self::RepoAccessDenied | Self::Unauthorized => {
                StatusCode::UNAUTHORIZED
            }
            // Not 401: the credential was accepted. It is 403 because this
            // account may do exactly one thing until it does it.
            Self::PasswordChangeRequired => StatusCode::FORBIDDEN,
            Self::RepoUnreachable | Self::RepoUnusable => StatusCode::BAD_REQUEST,
            Self::NoCapacity
            | Self::HostUnreachable
            | Self::SessionEnded
            | Self::RepoInUse
            | Self::ActionFailed => StatusCode::CONFLICT,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn not_found(what: &str) -> Self {
        Self::new(ErrorCode::NotFound, format!("no such {what}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.code.status(), Json(self)).into_response()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!("{e:#}");
        Self::new(ErrorCode::Internal, format!("{e:#}"))
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// What the web application needs before it can do anything else.
#[derive(Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub version: String,
    /// Where the event stream lives. Config, never assumed same-origin — which
    /// is what lets one bundle serve localhost and a hosted deployment alike.
    pub events_path: String,
}

#[utoipa::path(
    get, path = "/api/v1/bootstrap", tag = "meta",
    responses((status = 200, body = Bootstrap)),
)]
async fn bootstrap() -> Json<Bootstrap> {
    Json(Bootstrap {
        version: env!("CARGO_PKG_VERSION").to_string(),
        events_path: "/api/v1/events".to_string(),
    })
}

/// The token that applies to a remote, if we hold one.
///
/// A remote we have no token for isn't an error: local paths and self-hosted
/// git work off whatever credentials the worker already has.
///
/// `owner` is **whose** token, and the answer differs by caller: a repository
/// picker asks with the token of the person looking at it, while pushing a
/// session's branch asks with the token of whoever started that session. Those
/// are two different people the moment there are two people, and conflating
/// them is how one person's branch goes up under another's name.
async fn credential_for(
    state: &AppState,
    remote: &str,
    owner: &str,
    why: &str,
) -> Option<Credential> {
    let provider = crate::providers::for_remote(remote)?;
    let secret = state
        .vault
        .get(crate::vault::Key::of(vault::GIT, provider.id, owner), why)
        .await
        // A credential that will not open is a real failure, but not this
        // caller's to report: it is logged where it happens, and here it means
        // the same as having none.
        .ok()
        .flatten()?;
    Some(Credential {
        username: provider.git_username.to_string(),
        secret: secret.to_string(),
    })
}

/// Registered so the generated client gets a type and a validator for the
/// stream, even though no path returns one. The schema document doubles as a
/// type registry rather than only a list of paths.
#[derive(OpenApi)]
#[openapi(
    info(title = "Firetower", version = env!("CARGO_PKG_VERSION")),
    components(schemas(
        Event,
        Agent,
        SessionStatus,
        ft_core::EventKind,
        ft_core::HostState,
        ProviderStatus,
        PendingAuth,
        ft_core::controls::Control,
        ft_core::controls::Choice,
        ft_core::controls::ControlKind,
        RemoteRepo,
        AgentMode,
        AgentPresence,
        ft_core::WorkSummary,
        ft_core::CheckoutSummary,
        ft_core::CheckoutWork,
        ft_core::session::Checkout,
        ft_core::session::NewCheckout,
        ft_core::FileDiff,
        ft_core::Compute,
        ft_core::SshKey,
        crate::sshkey::PublicIdentity,
        hosts::Reached
    ))
)]
pub struct ApiDoc;

/// Every route, in the order the document should read.
///
/// Grouped by tag, because that is what the client generator splits on: one
/// file per group in the web application, matching one module per group here.
pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(bootstrap))
        .routes(routes!(auth::login))
        .routes(routes!(auth::logout))
        .routes(routes!(auth::me))
        .routes(routes!(auth::change_password))
        .routes(routes!(setup::setup_state))
        .routes(routes!(setup::name_organization))
        .routes(routes!(setup::complete_setup))
        .routes(routes!(hosts::list_hosts, hosts::create_host))
        .routes(routes!(hosts::delete_host))
        .routes(routes!(hosts::rename_host))
        .routes(routes!(hosts::connect_host))
        .routes(routes!(hosts::drain_host))
        .routes(routes!(hosts::ssh_key))
        .routes(routes!(hosts::probe_host))
        .routes(routes!(repos::list_repos, repos::create_repo))
        .routes(routes!(repos::delete_repo, repos::update_repo))
        .routes(routes!(repos::list_repo_env, repos::put_repo_env))
        .routes(routes!(repos::remove_repo_env))
        .routes(routes!(repos::repo_branches))
        .routes(routes!(repos::probe_repo))
        .routes(routes!(agents::list_agents))
        .routes(routes!(agents::configure_agent, agents::forget_agent))
        .routes(routes!(agents::check_agents))
        .routes(routes!(agents::sign_agent_in))
        .routes(routes!(secrets::list_secrets))
        .routes(routes!(secrets::replace_secret, secrets::remove_secret))
        .routes(routes!(secrets::reveal_secret))
        .routes(routes!(providers::list_providers))
        .routes(routes!(providers::set_client_id))
        .routes(routes!(
            providers::get_identity,
            providers::set_identity,
            providers::clear_identity
        ))
        .routes(routes!(providers::authorize_provider))
        .routes(routes!(providers::disconnect_provider))
        .routes(routes!(providers::list_provider_repos))
        .routes(routes!(sessions::list_sessions, sessions::create_session))
        .routes(routes!(sessions::end_all_sessions))
        .routes(routes!(sessions::get_session, sessions::destroy_session))
        .routes(routes!(events::list_events))
        .routes(routes!(events::stream_events))
        .routes(routes!(terminal::session_pty))
        .routes(routes!(sessions::list_files))
        .routes(routes!(sessions::download_file))
        .routes(routes!(sessions::stop_session))
        .routes(routes!(sessions::rename_session))
        .routes(routes!(sessions::push_session))
        .routes(routes!(sessions::commit_session))
        .routes(routes!(sessions::describe_session))
        .routes(routes!(sessions::session_diff))
        .routes(routes!(sessions::open_pull_request))
        .routes(routes!(sessions::session_work))
        .routes(routes!(sessions::add_repo))
        .routes(routes!(conversation::get_conversation))
        .routes(routes!(conversation::stream_conversation))
        .routes(routes!(conversation::send_turn))
        .routes(routes!(
            conversation::session_controls,
            conversation::choose_control
        ))
        .routes(routes!(conversation::interrupt_session))
        .routes(routes!(conversation::answer_request))
        .routes(routes!(conversation::attach_file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_map_to_sensible_statuses() {
        assert_eq!(ErrorCode::NotFound.status(), StatusCode::NOT_FOUND);
        assert_eq!(ErrorCode::HostUnreachable.status(), StatusCode::CONFLICT);
        assert_eq!(
            ErrorCode::Internal.status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn an_error_serialises_with_a_code_the_interface_can_switch_on() {
        let json = serde_json::to_string(&ApiError::new(
            ErrorCode::HostUnreachable,
            "fire-02 isn't responding",
        ))
        .unwrap();
        assert!(json.contains("\"code\":\"HostUnreachable\""), "{json}");
    }

    #[test]
    fn the_document_describes_every_route() {
        let doc = ApiDoc::openapi();
        let json = serde_json::to_string(&doc).unwrap();
        for path in [
            "/api/v1/bootstrap",
            "/api/v1/sessions",
            "/api/v1/hosts",
            "/api/v1/events",
        ] {
            assert!(
                json.contains(path) || router().split_for_parts().1.paths.paths.contains_key(path),
                "{path} is missing from the contract"
            );
        }
    }
}
