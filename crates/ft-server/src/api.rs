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

pub(crate) mod access;
pub(crate) mod accounts;
pub(crate) mod agents;
mod annotations;
mod auth;
mod consumption;
mod conversation;
mod events;
mod forwards;
pub(crate) mod hosts;
mod providers;
mod repos;
mod secrets;
mod sessions;
mod setup;
mod skills;
mod stream;
mod tasks;
mod telemetry;
mod terminal;
mod trackers;
mod updates;
mod users;
mod voice;

// `providers` on its own is the module below, which is this crate's git-host
// screen rather than the git hosts themselves.
use crate::oauth::{Grant, RemoteRepo};
use crate::providers::{PendingAuth, ProviderStatus};
use crate::vault;
use crate::AppState;
use axum::{
    extract::State,
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
    /// The git host's application has had too many authorizations this hour.
    ///
    /// Its own code because the interface answers it differently: nothing is
    /// misconfigured and nothing is unreachable, so the screen offers the two
    /// ways round it rather than a correction or a retry.
    ProviderBusy,
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
    /// Signed in, with a password somebody else chose. Every other request is
    /// refused until it is replaced, which happens in a browser: the web
    /// interface turns this into its one remaining step, and the desktop and
    /// phone apps turn it into a panel pointing at that address.
    PasswordChangeRequired,
    /// Signed in, and not allowed to do this. Not `Unauthorized`, which the
    /// interface reads as a session that has ended — being refused one thing
    /// must not sign somebody out of everything.
    Forbidden,
    Internal,
}

impl ErrorCode {
    pub(crate) fn status(self) -> StatusCode {
        match self {
            Self::InvalidRequest => StatusCode::BAD_REQUEST,
            Self::NotFound | Self::RepoNotConnected => StatusCode::NOT_FOUND,
            Self::ProviderNotConfigured => StatusCode::NOT_IMPLEMENTED,
            // The only thing that means "we do not know who you are". Anything
            // else answering 401 signs the person out: the interface reads a
            // 401 as a session that has ended, forgets the token and goes to
            // the sign-in screen.
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            // Not 401: the credential was accepted. It is 403 because this
            // account may do exactly one thing until it does it.
            Self::PasswordChangeRequired | Self::Forbidden => StatusCode::FORBIDDEN,
            Self::RepoUnreachable | Self::RepoUnusable => StatusCode::BAD_REQUEST,
            // Not 401 either, for the same reason, and these two used to be —
            // which meant a GitHub authorization that had never been done, or a
            // private repository the token could not see, signed the person out
            // of Firetower. They are about a credential we hold for somebody
            // else's host, not about theirs: whoever asked is signed in, and
            // this deployment is not in a state where the request can be
            // answered yet.
            Self::NoCapacity
            | Self::HostUnreachable
            | Self::SessionEnded
            | Self::RepoInUse
            | Self::ProviderNotConnected
            | Self::RepoAccessDenied
            | Self::ActionFailed => StatusCode::CONFLICT,
            Self::ProviderBusy => StatusCode::TOO_MANY_REQUESTS,
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
    /// Which Firetower this is, independent of the address it answers on.
    ///
    /// The installation's organisation id, which already exists, is already
    /// unique and is already stable. A client pins its token to this rather
    /// than to a URL, so the same server on a new address is still the same
    /// server — and a different server on a familiar address is not, which is
    /// the case worth catching.
    ///
    /// `None` before the setup wizard has been finished, because until then
    /// there is nothing here to be trusted yet.
    pub server_id: Option<String>,
    /// What the people who run it call it. For a client that is about to ask
    /// somebody to hand over a password, and should say whose.
    pub organization: Option<String>,
    /// How to sign in here: `password`, `proxy`, or `open`.
    ///
    /// A native client cannot see the deployment's configuration and must not
    /// guess: a password form shown to an SSO deployment is a dead end, and a
    /// browser round trip demanded of a laptop install is rude.
    pub auth_modes: Vec<&'static str>,
}

#[utoipa::path(
    get, path = "/api/v1/bootstrap", tag = "meta",
    responses((status = 200, body = Bootstrap)),
)]
async fn bootstrap(State(state): State<AppState>) -> Json<Bootstrap> {
    // Unauthenticated, and deliberately says almost nothing: a name, a version
    // and how to knock. Enough for a client to tell one Firetower from another
    // before it hands anything over, and nothing that is worth reading if you
    // are not meant to be here.
    let org = state.accounts.organization().await.ok().flatten();

    Json(Bootstrap {
        version: env!("CARGO_PKG_VERSION").to_string(),
        events_path: "/api/v1/events".to_string(),
        server_id: org.as_ref().map(|o| o.id.as_str().to_string()),
        organization: org.map(|o| o.name),
        auth_modes: state.policy.modes(),
    })
}

/// Which git host a repository is on.
///
/// The row first, the remote's hostname second. Both are needed and neither is
/// redundant: a repository picked from a host has its id written down and is
/// unambiguous, while one whose remote was pasted has no row and has to be
/// matched on the hostname — which is also every row written before there was
/// more than one host.
///
/// The row is what makes two accounts on one hostname work. With a personal and
/// a work GitHub both connected, `github.com` names two hosts and the remote
/// alone cannot say which token opens this repository.
pub(crate) async fn connection_for_repo(
    state: &AppState,
    repo: &ft_core::Repo,
    owner: &str,
) -> Option<std::sync::Arc<crate::providers::Connection>> {
    if let Some(id) = repo.connection_id.as_deref() {
        // A host that has since been removed falls through rather than failing.
        // The remote is still a real address and may still be reachable by
        // another host at the same name.
        if let Some(conn) = state.connections.get(id).await {
            return Some(conn);
        }
    }
    connection_for_remote(state, &repo.remote, owner).await
}

/// Which git host a bare remote is on, preferring one this person can use.
///
/// Where two hosts share a hostname and there is no row to disambiguate, the
/// one they hold a token for is the better guess by a wide margin — the other
/// answer is a credential that opens nothing. Where they hold tokens for both,
/// the first in the list wins, which is the built-in one.
/// The same, reachable from the submodules that need it by name.
pub(crate) async fn connection_for_remote_pub(
    state: &AppState,
    remote: &str,
    owner: &str,
) -> Option<std::sync::Arc<crate::providers::Connection>> {
    connection_for_remote(state, remote, owner).await
}

async fn connection_for_remote(
    state: &AppState,
    remote: &str,
    owner: &str,
) -> Option<std::sync::Arc<crate::providers::Connection>> {
    let candidates = state.connections.all_for_remote(remote).await;
    if candidates.len() <= 1 {
        return candidates.into_iter().next();
    }

    for conn in &candidates {
        if state
            .vault
            .holds(crate::vault::Key::of(vault::GIT, &conn.id, owner))
            .await
            .unwrap_or(false)
        {
            return Some(conn.clone());
        }
    }
    candidates.into_iter().next()
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
    let conn = connection_for_remote(state, remote, owner).await?;
    credential_on(state, &conn, owner, why).await
}

/// The same, for a repository that knows which host it is on.
pub(crate) async fn credential_for_repo(
    state: &AppState,
    repo: &ft_core::Repo,
    owner: &str,
    why: &str,
) -> Option<Credential> {
    let conn = connection_for_repo(state, repo, owner).await?;
    credential_on(state, &conn, owner, why).await
}

/// This person's working token for one host, renewed if it was about to lapse.
///
/// **Everything that reads a git token goes through here.** A GitLab access
/// token lasts two hours and the figure cannot be changed, so "read the vault
/// and use what is in it" is only correct for the first two hours after
/// somebody signs in. What is in the vault is a [`Grant`] — usually just the
/// token, and on GitLab a token with a refresh token and an expiry beside it.
///
/// `None` means we hold nothing for this person on this host, which is not an
/// error: a local path or a host nobody has authorized works off whatever
/// credentials the worker already has.
///
/// A renewal that *fails* also answers `None`, and logs why. The alternative is
/// every caller growing a second error path for a case whose only remedy is the
/// one the connect screen already offers.
pub(crate) async fn git_token(
    state: &AppState,
    conn: &crate::providers::Connection,
    owner: &str,
    why: &str,
) -> Option<zeroize::Zeroizing<String>> {
    let key = || crate::vault::Key::of(vault::GIT, &conn.id, owner);
    let held = Grant::parse(&state.vault.get(key(), why).await.ok().flatten()?);

    if !held.stale(chrono::Utc::now()) {
        return Some(zeroize::Zeroizing::new(held.access));
    }

    // Past here we are spending a single-use refresh token, so only one task
    // per person per host may be in flight — and whoever waited has to look
    // again rather than renew the grant it arrived with, because the one that
    // went first has already replaced it.
    let _queued = state.renewals.at(&format!("{}:{owner}", conn.id)).await;
    let held = Grant::parse(&state.vault.get(key(), "renewing the authorization").await.ok().flatten()?);
    if !held.stale(chrono::Utc::now()) {
        return Some(zeroize::Zeroizing::new(held.access));
    }

    let (Some(refresh), Some(client_id)) = (held.refresh.as_deref(), conn.client_id()) else {
        // Expired with nothing to renew it: a token somebody pasted with an end
        // date on it, or one stored before grants were kept whole. Handing it
        // over anyway is right — the host is the authority on whether it still
        // works, and our copy of the expiry may be the thing that is wrong.
        return Some(zeroize::Zeroizing::new(held.access));
    };

    match crate::oauth::grant::renew(conn, &client_id, refresh).await {
        Ok(fresh) => {
            if let Err(e) = state
                .vault
                .put(
                    key(),
                    &fresh.to_stored(),
                    &format!("{} renewed the authorization", conn.label),
                )
                .await
            {
                // The host has already rotated the refresh token, so the one in
                // the vault is now spent and this person will have to sign in
                // again. Worth a loud line: it is the only failure here that
                // loses a credential rather than just failing a request.
                tracing::error!("storing the renewed {} token: {e:#}", conn.label);
            }
            Some(zeroize::Zeroizing::new(fresh.access))
        }
        Err(e) => {
            tracing::warn!("renewing the {} authorization: {e:#}", conn.label);
            None
        }
    }
}

/// This person's token for one host, as git wants it.
async fn credential_on(
    state: &AppState,
    conn: &crate::providers::Connection,
    owner: &str,
    why: &str,
) -> Option<Credential> {
    let secret = git_token(state, conn, owner, why).await?;

    Some(Credential {
        // All three hosts read the token out of the password and ignore this,
        // which was checked against a real Gitea rather than assumed — see
        // `Kind::git_username`.
        username: conn.kind.git_username.to_string(),
        secret: secret.to_string(),
    })
}

/// Registered so the generated client gets a type and a validator for the
/// stream, even though no path returns one. The schema document doubles as a
/// type registry rather than only a list of paths.
#[derive(OpenApi)]
#[openapi(
    // Deliberately not the crate version. This number is written into the
    // committed contract, so tying it to the release means every release makes
    // `api/openapi.json` stale without a single handler having changed — which
    // is how `api/updater.json` came to sit three minor versions behind. The
    // contract moves when the handlers move, and nothing else should move it.
    //
    // A client asking which Firetower it is talking to reads `version` off
    // /bootstrap, which is the real answer and is always current.
    info(title = "Firetower", version = "0"),
    components(schemas(
        crate::db::Bucket,
        crate::db::Dimension,
        crate::db::Direction,
        crate::db::Sort,
        Event,
        Agent,
        SessionStatus,
        ft_core::EventKind,
        ft_core::HostState,
        ProviderStatus,
        PendingAuth,
        crate::providers::AuthMode,
        crate::providers::KindInfo,
        ft_core::controls::Control,
        ft_core::controls::Choice,
        ft_core::controls::ControlKind,
        RemoteRepo,
        AgentMode,
        AgentPresence,
        agents::Updated,
        ft_core::WorkSummary,
        ft_core::CheckoutSummary,
        ft_core::CheckoutWork,
        ft_core::session::Checkout,
        ft_core::session::NewCheckout,
        ft_core::FileDiff,
        ft_core::DiffSince,
        users::OrganizationName,
        users::NewUser,
        crate::access::Team,
        crate::access::Directory,
        crate::access::Grant,
        ft_core::Level,
        ft_core::SubjectKind,
        access::Colleague,
        access::NewTeam,
        access::TeamName,
        access::NewDirectory,
        access::DirectoryName,
        access::NewGrant,
        access::Placement,
        access::FiledRef,
        crate::access::Filed,
        crate::access::FiledKind,
        users::CreatedUser,
        users::UserChange,
        users::TemporaryPassword,
        ft_core::Compute,
        ft_core::SshKey,
        crate::sshkey::PublicIdentity,
        hosts::Reached,
        hosts::Installed,
        forwards::Ports,
        forwards::PreviewAddress,
        forwards::NewForward,
        crate::forward::Forwarded,
        stream::Topic,
        stream::ChangedWhat,
        stream::ClientFrame,
        stream::ServerFrame,
        crate::tasks::Task,
        crate::tasks::Page,
        crate::tasks::TaskKind,
        crate::tasks::TaskState,
        crate::tasks::Person,
        crate::tasks::Label,
        trackers::TrackerStatus,
        trackers::TaskScope,
        trackers::Connected,
        crate::trackers::Auth,
        crate::trackers::ScopeKind,
        crate::updates::RunState,
        crate::updates::StepState,
        crate::updates::deploy::FileVerdict,
        crate::updates::deploy::FilePlan,
        crate::updates::store::Targets
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
        .routes(routes!(consumption::consumption))
        .routes(routes!(telemetry::pending))
        .routes(routes!(telemetry::delivered))
        .routes(routes!(telemetry::preview))
        .routes(routes!(
            telemetry::telemetry_settings,
            telemetry::set_telemetry_settings
        ))
        .routes(routes!(auth::login))
        .routes(routes!(auth::logout))
        .routes(routes!(auth::me))
        .routes(routes!(auth::change_password))
        .routes(routes!(setup::setup_state))
        .routes(routes!(setup::name_organization))
        .routes(routes!(setup::complete_setup))
        .routes(routes!(users::rename_organization))
        .routes(routes!(users::list_users, users::create_user))
        .routes(routes!(users::change_user, users::delete_user))
        .routes(routes!(users::user_reach))
        .routes(routes!(users::offboard_user))
        .routes(routes!(users::reset_user_password))
        .routes(routes!(access::list_colleagues))
        .routes(routes!(access::list_teams, access::create_team))
        .routes(routes!(access::rename_team, access::delete_team))
        .routes(routes!(access::list_team_members))
        .routes(routes!(access::add_team_member, access::remove_team_member))
        .routes(routes!(access::list_directories, access::create_directory))
        .routes(routes!(access::rename_directory, access::delete_directory))
        .routes(routes!(access::list_grants, access::set_grant))
        .routes(routes!(access::revoke_grant))
        .routes(routes!(access::access_of))
        .routes(routes!(access::set_exception, access::drop_exception))
        .routes(routes!(
            access::list_items,
            access::file_items,
            access::unfile_items
        ))
        .routes(routes!(hosts::list_hosts, hosts::create_host))
        .routes(routes!(hosts::delete_host))
        .routes(routes!(hosts::rename_host))
        .routes(routes!(hosts::connect_host))
        .routes(routes!(hosts::host_readiness))
        .routes(routes!(hosts::install_worker))
        .routes(routes!(hosts::drain_host))
        .routes(routes!(hosts::ssh_key))
        .routes(routes!(hosts::probe_host))
        .routes(routes!(repos::list_repos, repos::create_repo))
        .routes(routes!(repos::delete_repo, repos::update_repo))
        .routes(routes!(repos::list_repo_env, repos::put_repo_env))
        .routes(routes!(repos::remove_repo_env))
        .routes(routes!(repos::repo_branches))
        .routes(routes!(repos::probe_repo))
        .routes(routes!(accounts::list_accounts, accounts::create_account))
        .routes(routes!(accounts::update_account))
        .routes(routes!(accounts::session_account))
        .routes(routes!(accounts::switch_account))
        .routes(routes!(accounts::get_fallback, accounts::set_fallback))
        .routes(routes!(agents::list_agents))
        .routes(routes!(agents::configure_agent, agents::forget_agent))
        .routes(routes!(agents::check_agents))
        .routes(routes!(agents::sign_agent_in))
        .routes(routes!(agents::install_agent))
        .routes(routes!(agents::update_agent))
        .routes(routes!(skills::list_skills, skills::create_skill))
        .routes(routes!(skills::match_skills))
        .routes(routes!(skills::rename_skill, skills::delete_skill))
        .routes(routes!(skills::skill_detail))
        .routes(routes!(skills::list_versions, skills::add_version))
        .routes(routes!(skills::set_default))
        .routes(routes!(skills::session_skills, skills::choose_skills))
        .routes(routes!(skills::skill_collisions))
        .routes(routes!(skills::share_skills))
        .routes(routes!(skills::set_repo_defaults))
        .routes(routes!(secrets::list_secrets))
        .routes(routes!(secrets::replace_secret, secrets::remove_secret))
        .routes(routes!(secrets::reveal_secret))
        .routes(routes!(
            providers::list_providers,
            providers::create_provider
        ))
        .routes(routes!(providers::list_kinds))
        .routes(routes!(providers::probe_provider))
        .routes(routes!(providers::set_client_id))
        .routes(routes!(providers::set_provider_token))
        .routes(routes!(providers::delete_provider))
        .routes(routes!(
            providers::get_identity,
            providers::set_identity,
            providers::clear_identity
        ))
        .routes(routes!(providers::authorize_provider))
        .routes(routes!(
            providers::disconnect_provider,
            providers::update_provider
        ))
        .routes(routes!(providers::list_provider_repos))
        .routes(routes!(sessions::list_sessions, sessions::create_session))
        .routes(routes!(sessions::end_all_sessions))
        .routes(routes!(sessions::get_session, sessions::destroy_session))
        .routes(routes!(events::list_events))
        .routes(routes!(events::stream_events))
        .routes(routes!(terminal::session_pty))
        .routes(routes!(voice::voice_state))
        .routes(routes!(voice::set_voice_key))
        .routes(routes!(voice::voice_ticket))
        .routes(routes!(sessions::list_files))
        .routes(routes!(sessions::find_files))
        .routes(routes!(sessions::download_file))
        .routes(routes!(forwards::list_forwards, forwards::create_forward))
        .routes(routes!(forwards::delete_forward))
        .routes(routes!(forwards::preview_address))
        .routes(routes!(
            annotations::list_annotations,
            annotations::keep_annotation,
            annotations::drop_annotations
        ))
        .routes(routes!(annotations::send_annotations))
        .routes(routes!(sessions::stop_session))
        .routes(routes!(sessions::relaunch_session))
        .routes(routes!(sessions::rename_session))
        .routes(routes!(sessions::set_share))
        .routes(routes!(sessions::push_session))
        .routes(routes!(sessions::commit_session))
        .routes(routes!(sessions::describe_session))
        .routes(routes!(sessions::session_diff))
        .routes(routes!(sessions::open_pull_request))
        .routes(routes!(sessions::session_work))
        .routes(routes!(sessions::add_repo))
        .routes(routes!(conversation::get_conversation))
        .routes(routes!(conversation::stream_conversation))
        .routes(routes!(stream::stream))
        .routes(routes!(tasks::list_tasks))
        .routes(routes!(updates::get_updates))
        .routes(routes!(updates::check_updates))
        .routes(routes!(updates::plan_update))
        .routes(routes!(updates::list_runs, updates::create_run))
        .routes(routes!(updates::get_run))
        .routes(routes!(updates::cancel_run))
        .routes(routes!(updates::continue_run))
        .routes(routes!(updates::back_up_now))
        .routes(routes!(tasks::get_task))
        .routes(routes!(trackers::list_trackers))
        .routes(routes!(trackers::set_tracker_key))
        .routes(routes!(trackers::disconnect_tracker))
        .routes(routes!(trackers::list_tracker_scopes))
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

    /// Every other code answering 401 would sign somebody out.
    ///
    /// The interface treats a 401 as "this session has ended": it forgets the
    /// token and goes to the sign-in screen. `ProviderNotConnected` and
    /// `RepoAccessDenied` were both 401 once, so a GitHub authorization nobody
    /// had done yet — asked for by the tasks list, the repository picker, and
    /// the issue chips while somebody was typing — logged them out of Firetower
    /// instead of saying which git host needed connecting.
    #[test]
    fn only_not_knowing_who_somebody_is_answers_401() {
        for code in [
            ErrorCode::InvalidRequest,
            ErrorCode::NotFound,
            ErrorCode::NoCapacity,
            ErrorCode::HostUnreachable,
            ErrorCode::RepoNotConnected,
            ErrorCode::SessionEnded,
            ErrorCode::ProviderNotConfigured,
            ErrorCode::ProviderNotConnected,
            ErrorCode::RepoAccessDenied,
            ErrorCode::RepoUnreachable,
            ErrorCode::RepoUnusable,
            ErrorCode::RepoInUse,
            ErrorCode::ActionFailed,
            ErrorCode::PasswordChangeRequired,
            ErrorCode::Forbidden,
            ErrorCode::Internal,
        ] {
            assert_ne!(
                code.status(),
                StatusCode::UNAUTHORIZED,
                "{code:?} answers 401, which the interface reads as a session that has ended"
            );
        }

        assert_eq!(ErrorCode::Unauthorized.status(), StatusCode::UNAUTHORIZED);
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

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        Self::from(anyhow::Error::from(error))
    }
}

#[cfg(test)]
mod execution_tests;
