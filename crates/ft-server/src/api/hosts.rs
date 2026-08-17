//! Where agents run: a container here, or a server you own.
//!
//! Adding one connects to it there and then, so a wrong address is a message
//! on the form rather than a host that quietly never works.

use super::{ApiError, ApiResult, ErrorCode};
use crate::{container, fleet, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use ft_core::Host;
use ft_proto::ToWorker;
use serde::Deserialize;
use utoipa::ToSchema;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewHost {
    /// What you'll call it. Defaults to something derived from the kind.
    pub name: Option<String>,
    pub compute: ft_core::Compute,
}

/// Add somewhere for agents to run.
///
/// Connecting happens straight away rather than on the next restart, so a
/// mistake in an address is a message here instead of a host that silently
/// never works.
///
/// A host that doesn't answer is still created, and comes back `Unreachable`
/// with a `diagnosis` saying why and what to run. That is not the same as the
/// request failing: what someone typed was accepted, and the machine at the
/// other end has something to fix. Only what we can rule out from here —
/// an empty address, a key that isn't a key, a name already taken — is a 400.
#[utoipa::path(
    post, path = "/api/v1/hosts", tag = "hosts",
    request_body = NewHost,
    responses((status = 201, body = Host), (status = 400, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn create_host(
    State(state): State<AppState>,
    Json(req): Json<NewHost>,
) -> ApiResult<(StatusCode, Json<Host>)> {
    // This machine is registered at start-up and always present. Adding a
    // second one would be two workers over the same directories.
    if req.compute == ft_core::Compute::Local {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this machine is always available and doesn't need adding",
        ));
    }

    // A host that dials in is configured where the deployment is configured,
    // not here. Accepting one over the API would mean taking the token's
    // fingerprint from whoever asked, which is a credential decided by the
    // caller — and the interface has nowhere to show the token afterwards,
    // since it is deliberately never stored.
    if matches!(req.compute, ft_core::Compute::Dialed { .. }) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a worker that dials in is set up with FIRETOWER_WORKER_TOKEN where the control \
             plane runs, and appears here on its own",
        ));
    }

    let compute = settled(req.compute)?;

    let name = match req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(given) => given.to_string(),
        None => match &compute {
            ft_core::Compute::Local => "localhost".to_string(),
            ft_core::Compute::Container { name, .. } => name.clone(),
            // The address is what it's called, now that the account and the
            // port are no longer buried in it.
            ft_core::Compute::Server { host, .. } => host.clone(),
            // Refused above; named here only because the compiler is right
            // that the match has to be complete.
            ft_core::Compute::Dialed { .. } => "worker".to_string(),
        },
    };

    if state.db.host_by_name(&name).await?.is_some() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("there is already a host called {name}"),
        ));
    }

    if let ft_core::Compute::Container { image, name } = &compute {
        container::start(image, name)
            .await
            .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;
    }

    let host = state.db.ensure_host(&name, compute).await?;

    // Connect now, so a bad address is a message rather than a silence.
    let transport = fleet::Fleet::transport_for(&host, &state.home, &state.dock)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    // A host that didn't answer is kept, not discarded. Most reasons a first
    // connection fails are fixable on the machine — no worker installed, no
    // container running, the wrong key — and deleting the row would mean
    // retyping the form to retry. It is stored `Unreachable` with a diagnosis,
    // and the supervisor keeps trying, so fixing the machine is enough.
    state.fleet.supervise(host.id.clone(), transport).await;

    let host = state
        .db
        .host_by_name(&name)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;

    Ok((StatusCode::CREATED, Json(seen(&state, host).await)))
}

/// Tidy what was typed into something worth storing, or say what is wrong with
/// it while the person who typed it is still looking at the form.
///
/// The address field takes a whole destination, because `root@fire-01:2222` is
/// what gets pasted and what every other tool accepts. Anything it carries only
/// fills a gap, though: a field somebody filled in deliberately wins over a
/// value parsed out of a different one.
fn settled(compute: ft_core::Compute) -> Result<ft_core::Compute, ApiError> {
    match compute {
        ft_core::Compute::Server {
            host,
            user,
            port,
            identity_file,
            host_key,
            container,
        } => {
            let typed = ft_core::parse_destination(&host);

            if typed.host.is_empty() {
                return Err(ApiError::new(
                    ErrorCode::InvalidRequest,
                    "a server needs an address to reach it at",
                ));
            }

            // Read now rather than at the first connection. A host that was
            // accepted should not then fail on something we could have learned
            // from the filesystem before saying yes.
            let identity_file = match given(identity_file) {
                Some(raw) => {
                    crate::transport::identity_path(&raw)
                        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
                    Some(raw)
                }
                None => None,
            };

            Ok(ft_core::Compute::Server {
                host: typed.host,
                user: given(user).or(typed.user),
                port: port.or(typed.port),
                identity_file,
                host_key: given(host_key),
                // Blank means the worker runs on the machine itself.
                container: given(container),
            })
        }
        other => Ok(other),
    }
}

/// A field the form left alone arrives as an empty string, which is not a value.
fn given(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Stop sending work here, or start again.
#[utoipa::path(
    post, path = "/api/v1/hosts/{id}/drain", tag = "hosts",
    params(("id" = String, Path, description = "Host id")),
    request_body = Drain,
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn drain_host(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<Drain>,
) -> ApiResult<StatusCode> {
    let id = ft_core::HostId::from_stored(id);
    state.db.set_drained(&id, req.drained).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct Drain {
    pub drained: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    /// Take the host with whatever is running on it.
    ///
    /// Off by default, so removing a host you forgot was busy asks first.
    #[serde(default)]
    pub force: bool,
}

/// Forget a host, and take its container with it.
///
/// Refuses while sessions are running unless `force`, in which case they are
/// told to end first — an agent that gets to shut down leaves its worktree and
/// tmux session behind cleanly, rather than having the floor pulled out.
///
/// A container Firetower started is Firetower's to stop. One it merely found
/// running is not, and start-up says as much when it adopts nothing.
#[utoipa::path(
    delete, path = "/api/v1/hosts/{id}", tag = "hosts",
    params(
        ("id" = String, Path, description = "Host id"),
        ("force" = Option<bool>, Query, description = "End running sessions instead of refusing"),
    ),
    responses((status = 204), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn delete_host(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(req): Query<Removal>,
) -> ApiResult<StatusCode> {
    let id = ft_core::HostId::from_stored(id);
    let hosts = state.db.hosts().await?;
    let host = hosts
        .iter()
        .find(|h| h.id == id)
        .ok_or_else(|| ApiError::not_found("host"))?;

    // Removing it would leave a fresh install with nowhere to run anything,
    // and it comes straight back on the next start anyway.
    if host.compute == ft_core::Compute::Local {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this machine is always available and can't be removed",
        ));
    }

    let live = state.db.live_sessions_on(&id).await?;
    if !live.is_empty() && !req.force {
        return Err(ApiError::new(
            ErrorCode::RepoInUse,
            format!(
                "{} still has {} running: {}. Remove it anyway to end {}.",
                host.name,
                if live.len() == 1 {
                    "a session".to_string()
                } else {
                    format!("{} sessions", live.len())
                },
                live.join(", "),
                if live.len() == 1 { "it" } else { "them" }
            ),
        ));
    }

    // Ask before taking the floor away. Each one gets to tear down its own
    // worktree and tmux session; a container about to be removed doesn't care,
    // but a server does — that host keeps running afterwards.
    for session in state.db.live_session_ids_on(&id).await? {
        if !state.fleet.is_connected(&id).await {
            break;
        }
        if let Err(e) = state
            .fleet
            .send(
                &id,
                ToWorker::Destroy {
                    session_id: session.clone(),
                    force: true,
                },
            )
            .await
        {
            tracing::warn!(%session, "ending before removing the host: {e:#}");
        }
    }

    // Ours on purpose: the transport is about to stop working, and an error
    // logged for something we did deliberately reads like a fault.
    state.fleet.stop_supervising(&id).await;

    if let ft_core::Compute::Container { name, .. } = &host.compute {
        if let Err(e) = container::remove(name).await {
            // The row still goes. A container we couldn't remove is a mess on
            // the Docker side, not a reason to keep a host nobody wants.
            tracing::warn!(container = %name, "removing: {e:#}");
        }
    }

    // Its sessions and events go with it — they are a record of what that
    // worker reported, and the worker is what is being removed.
    state.db.delete_host(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get, path = "/api/v1/hosts", tag = "hosts",
    responses((status = 200, body = Vec<Host>)),
)]
pub(super) async fn list_hosts(State(state): State<AppState>) -> ApiResult<Json<Vec<Host>>> {
    let mut hosts = Vec::new();
    for host in state.db.hosts().await? {
        hosts.push(seen(&state, host).await);
    }
    Ok(Json(hosts))
}

/// Fill in what only the live fleet knows.
///
/// Whether a host is being retried is not a fact about the row — it is a fact
/// about this process — so it is answered here rather than stored and left to
/// go stale across a restart.
async fn seen(state: &AppState, mut host: Host) -> Host {
    host.reconnecting =
        host.state != ft_core::HostState::Online && state.fleet.is_supervised(&host.id).await;
    host
}

/// Try a host again now, instead of waiting out the backoff.
///
/// The supervisor would get there on its own; this is for the moment just after
/// you have fixed the machine and would rather not wait.
#[utoipa::path(
    post, path = "/api/v1/hosts/{id}/connect", tag = "hosts",
    params(("id" = String, Path, description = "Host id")),
    responses((status = 202), (status = 404, body = ApiError)),
)]
pub(super) async fn connect_host(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = ft_core::HostId::from_stored(id);
    state
        .db
        .host_by_id(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;

    if !state.fleet.try_now(&id).await {
        return Err(ApiError::new(
            ErrorCode::Internal,
            "nothing is keeping that host connected",
        ));
    }

    // Accepted, not done: the attempt happens on the supervisor's own task and
    // its result arrives as the host's state changing.
    Ok(StatusCode::ACCEPTED)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What someone types into the address field, and what gets stored.
    fn server(host: &str, user: Option<&str>) -> ft_core::Compute {
        ft_core::Compute::Server {
            host: host.into(),
            user: user.map(Into::into),
            port: None,
            identity_file: None,
            host_key: None,
            container: None,
        }
    }

    #[test]
    fn a_destination_pasted_into_the_address_comes_apart() {
        // Muscle memory puts the whole thing in one box, and ssh takes it, so
        // refusing it here would be Firetower being the awkward one.
        assert_eq!(
            settled(server("root@203.0.113.44:2222", None)).unwrap(),
            ft_core::Compute::Server {
                host: "203.0.113.44".into(),
                user: Some("root".into()),
                port: Some(2222),
                identity_file: None,
                host_key: None,
                container: None,
            }
        );
    }

    #[test]
    fn a_field_someone_filled_in_beats_one_parsed_out_of_another() {
        // Both were typed, so the one typed deliberately into its own box is
        // the one that was meant.
        let ft_core::Compute::Server { user, .. } =
            settled(server("root@fire-01", Some("deploy"))).unwrap()
        else {
            panic!("a server stays a server");
        };
        assert_eq!(user.as_deref(), Some("deploy"));
    }

    #[test]
    fn a_box_left_empty_is_absent_rather_than_blank() {
        // A form sends "", and an empty user would become `@fire-01`.
        let ft_core::Compute::Server { user, .. } = settled(server("fire-01", Some("  "))).unwrap()
        else {
            panic!("a server stays a server");
        };
        assert!(user.is_none(), "ssh should be left to decide");
    }

    #[test]
    fn a_server_with_nowhere_to_dial_is_refused() {
        let e = settled(server("   ", None)).unwrap_err();
        assert!(matches!(e.code, ErrorCode::InvalidRequest), "{}", e.message);
    }

    #[test]
    fn a_key_that_cannot_work_is_refused_before_the_host_exists() {
        // Otherwise it is added, fails to connect, and the message is about
        // authentication rather than about the path being wrong.
        let e = settled(ft_core::Compute::Server {
            host: "fire-01".into(),
            user: None,
            port: None,
            identity_file: Some("~/.ssh/nothing-is-here".into()),
            host_key: None,
            container: None,
        })
        .unwrap_err();

        assert!(matches!(e.code, ErrorCode::InvalidRequest), "{}", e.message);
        assert!(e.message.contains("no key at"), "{}", e.message);
    }
}
