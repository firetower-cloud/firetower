//! Where agents run: this machine, or a server you own.
//!
//! Adding one connects to it there and then, so a wrong address is a message
//! on the form rather than a host that quietly never works.

use super::{ApiError, ApiResult, ErrorCode};
use crate::{fleet, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use ft_core::Host;
use ft_proto::ToWorker;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewHost {
    /// What you'll call it. Defaults to something derived from the kind.
    pub name: Option<String>,
    pub compute: ft_core::Compute,
    /// This SSH connection reaches the machine hosting Firetower.
    #[serde(default)]
    pub same_machine: bool,
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

    let compute = settled(req.compute)?;

    let name = called(req.name.as_deref(), &compute);

    if state.db.host_by_name(&name).await?.is_some() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("there is already a host called {name}"),
        ));
    }

    if state
        .db
        .hosts()
        .await?
        .iter()
        .any(|host| host.compute == compute)
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "That machine is already added.",
        ));
    }

    let host = state.db.ensure_host(&name, compute).await?;
    if req.same_machine {
        sqlx::query("UPDATE hosts SET machine = 'local' WHERE id = $1")
            .bind(host.id.as_str())
            .execute(state.db.pool())
            .await?;
    }

    // Connect now, so a bad address is a message rather than a silence.
    let transport = fleet::Fleet::transport_for(&host, &state.home, Some(&state.vault))
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    // A host that didn't answer is kept, not discarded. Most reasons a first
    // connection fails are fixable on the machine — no worker installed, the
    // wrong key — and deleting the row would mean retyping the form to retry.
    // It is stored `Unreachable` with a diagnosis, and the supervisor keeps
    // trying, so fixing the machine is enough.
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
            key,
            host_key,
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
            //
            // Only a path can be checked here. A key the vault holds is not a
            // question about this filesystem, and whether the *other* machine
            // has been given the public half is not something any amount of
            // validation here can answer — that is what the first connection is
            // for, and what its diagnosis says.
            if let ft_core::SshKey::File { path } = &key {
                crate::transport::identity_path(path)
                    .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;
            }

            Ok(ft_core::Compute::Server {
                host: typed.host,
                user: given(user).or(typed.user),
                port: port.or(typed.port),
                key,
                host_key: given(host_key),
            })
        }
        other => Ok(other),
    }
}

/// What this machine is called.
///
/// A server is called what you call it, and if you called it nothing it is
/// called where it is. Refusing the form until a name was typed made the
/// address field a trick question: the answer most people want for `10.0.4.7`
/// is `10.0.4.7`, and whoever wants `build-box` types it. Either way there is
/// one label, and every screen uses it — nothing shows a bare address on its
/// own.
fn called(given: Option<&str>, compute: &ft_core::Compute) -> String {
    match given.map(str::trim).filter(|n| !n.is_empty()) {
        Some(given) => given.to_string(),
        None => match compute {
            ft_core::Compute::Local => "localhost".to_string(),
            ft_core::Compute::Server { host, .. } => host.clone(),
        },
    }
}

/// A field the form left alone arrives as an empty string, which is not a value.
fn given(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Call it something else.
///
/// The name and nothing else: what a host *is* was settled when it was added,
/// and pointing it somewhere different is removing it and adding another.
#[utoipa::path(
    patch, path = "/api/v1/hosts/{id}", tag = "hosts",
    params(("id" = String, Path, description = "Host id")),
    request_body = Rename,
    responses(
        (status = 200, body = Host),
        (status = 400, body = ApiError, description = "Empty, or already taken"),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn rename_host(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<Rename>,
) -> ApiResult<Json<Host>> {
    let id = ft_core::HostId::from_stored(id);

    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a host needs a name",
        ));
    }

    state
        .db
        .host_by_id(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;

    // Checked rather than caught, so the message names the host instead of
    // repeating a constraint.
    if let Some(existing) = state.db.host_by_name(name).await? {
        if existing.id != id {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!("there is already a host called {name}"),
            ));
        }
    }

    state.db.rename_host(&id, name).await?;

    let host = state
        .db
        .host_by_id(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;

    Ok(Json(seen(&state, host).await))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct Rename {
    pub name: String,
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

/// Forget a host.
///
/// Refuses while sessions are running unless `force`, in which case they are
/// told to end first — an agent that gets to shut down leaves its worktree and
/// tmux session behind cleanly, rather than having the floor pulled out.
///
/// Nothing on the machine is touched: the worker installed there is the
/// account's, and removing a host is forgetting it, not uninstalling it.
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
    // worktree and tmux session — that machine keeps running afterwards.
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
    // For the same reason, and from the same place: what a machine has is what
    // it last said it has, which no row can hold and no restart should invent.
    host.capacity = state.fleet.capacity_of(&host.id).await;
    host
}

/// What answered after a worker was put there.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    /// What `firetower-worker --version` said on the machine.
    ///
    /// Absent when the install ran and the probe did not answer. The install
    /// still happened; the supervisor's next connection is the verdict.
    pub version: Option<String>,
}

/// Put a worker on this machine.
///
/// Runs the installer script over the ssh connection Firetower already has —
/// the same script a person runs with `curl | sh` — pinned to this control
/// plane's version. It fetches the build for *that* machine, so a Linux
/// control plane installs onto a Mac. No sudo, nothing outside the account's
/// home, and nothing touched that somebody else installed.
#[utoipa::path(
    post, path = "/api/v1/hosts/{id}/worker", tag = "hosts",
    params(("id" = String, Path, description = "Host id")),
    responses(
        (status = 200, body = Installed),
        (status = 400, body = ApiError, description = "Not a machine reached over ssh"),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn install_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Installed>> {
    let id = ft_core::HostId::from_stored(id);
    let host = state
        .db
        .host_by_id(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;

    let ssh = fleet::Fleet::ssh_transport_for(&host, &state.home, Some(&state.vault))
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::InvalidRequest,
                "this machine's worker is the control plane's own, and is upgraded with it",
            )
        })?;

    let version = crate::install::install(&ssh)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    // There is a worker there now, and the supervisor is holding a backoff from
    // when there was not. Nobody should have to wait it out to see the machine
    // come up.
    state.fleet.try_now(&id).await;

    Ok(Json(Installed { version }))
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
            key: ft_core::SshKey::Default,
            host_key: None,
        }
    }

    #[test]
    fn a_machine_nobody_named_is_called_where_it_is() {
        let compute = settled(server("editor@10.0.4.7:2222", None)).unwrap();
        assert_eq!(called(None, &compute), "10.0.4.7");
        assert_eq!(called(Some("   "), &compute), "10.0.4.7");
        assert_eq!(called(Some(" build-box "), &compute), "build-box");
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
                key: ft_core::SshKey::Default,
                host_key: None,
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
            key: ft_core::SshKey::File {
                path: "~/.ssh/nothing-is-here".into(),
            },
            host_key: None,
        })
        .unwrap_err();

        assert!(matches!(e.code, ErrorCode::InvalidRequest), "{}", e.message);
        assert!(e.message.contains("no key at"), "{}", e.message);
    }
}

/// The public half of Firetower's own ssh key, and the one line that installs
/// a worker with it.
///
/// Read before adding a server, because the machine has to be given this before
/// it will let Firetower in — and that is a step on the *other* machine, which
/// nothing here can do.
///
/// There is no companion endpoint for the private half, and there should never
/// be one. It goes from the vault to a file ssh reads and no further.
#[utoipa::path(
    get, path = "/api/v1/ssh-key", tag = "hosts",
    responses((status = 200, body = crate::sshkey::PublicIdentity)),
)]
pub(super) async fn ssh_key(
    State(state): State<AppState>,
) -> ApiResult<Json<crate::sshkey::PublicIdentity>> {
    // `ensure` rather than `public`: start-up makes the pair, and an
    // installation upgraded while running has not been through start-up since.
    // Asking for it is a reasonable moment to make it.
    let identity = crate::sshkey::ensure(&state.vault)
        .await
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))?;

    Ok(Json(identity))
}

/// What a machine would say, before anything is written down.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reached {
    /// Whether ssh got onto the machine.
    ///
    /// Not the same as "everything is fine". A machine with no worker on it has
    /// been reached — the address, the account and the key are all right — and
    /// is worth adding, because what is left is a command to run over there.
    pub reached: bool,
    /// Why not, or what is still wrong once we were in.
    pub diagnosis: Option<ft_core::Diagnosis>,
}

/// Try a machine without adding it.
///
/// Adding used to create the row and then connect, which left a host behind
/// whenever the first attempt failed — and with Firetower's own key, the first
/// attempt failing is the ordinary path rather than the exception: a machine has
/// not been told about the key yet.
///
/// So the interface asks this first. Nothing is stored, so a mistyped address
/// leaves nothing to delete, and retrying is a button rather than a form to fill
/// in again.
#[utoipa::path(
    post, path = "/api/v1/hosts/probe", tag = "hosts",
    request_body = NewHost,
    responses((status = 200, body = Reached), (status = 400, body = ApiError)),
)]
pub(super) async fn probe_host(
    State(state): State<AppState>,
    Json(req): Json<NewHost>,
) -> ApiResult<Json<Reached>> {
    if req.compute == ft_core::Compute::Local {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this machine is always available and doesn't need adding",
        ));
    }

    // The same tidying and the same refusals as adding, so what is tried here
    // is what would be stored.
    let compute = settled(req.compute)?;

    // A probe needs a transport, and building one wants a host. This one is
    // never saved: it exists for the length of the attempt.
    let pretend = ft_core::Host {
        machine: None,
        id: ft_core::HostId::from_stored("probe".to_string()),
        name: "probe".to_string(),
        state: ft_core::HostState::Unreachable,
        compute: compute.clone(),
        drained: false,
        cpus: None,
        memory_mb: None,
        worker_version: None,
        diagnosis: None,
        // Nothing has been asked, and a probe never asks: it only wants to
        // know whether the machine answers as a worker at all.
        docker: ft_core::DockerState::default(),
        capacity: None,
        reconnecting: false,
    };

    let transport = fleet::Fleet::transport_for(&pretend, &state.home, Some(&state.vault))
        .map_err(|e| ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}")))?;

    let diagnosis = fleet::Fleet::probe_host(transport, &compute).await;

    Ok(Json(Reached {
        // No diagnosis at all means it answered as a worker.
        reached: diagnosis
            .as_ref()
            .is_none_or(|d| d.cause.reached_the_machine()),
        diagnosis,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ReadinessQuery {
    pub agent: Option<ft_core::Agent>,
}

/// Check requirements on the selected worker. This never installs anything.
#[utoipa::path(
    get, path = "/api/v1/hosts/{id}/readiness", tag = "hosts",
    params(("id" = String, Path), ("agent" = Option<ft_core::Agent>, Query)),
    responses((status = 200, body = ft_core::Readiness), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn host_readiness(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<ReadinessQuery>,
) -> ApiResult<Json<ft_core::Readiness>> {
    let id = ft_core::HostId::from_stored(id);
    let host = state
        .db
        .host_by_id(&id)
        .await?
        .ok_or_else(|| ApiError::not_found("host"))?;
    if !state.fleet.is_connected(&id).await {
        // The one line that fixes a machine with nothing on it, with the key
        // in it so the machine is reachable the moment it finishes. Best
        // effort: a key that cannot be read is a line without one, not a
        // readiness check that fails for a second reason.
        let key = crate::sshkey::ensure(&state.vault)
            .await
            .ok()
            .map(|identity| identity.public_key);
        return Ok(Json(ft_core::Readiness {
            user: None,
            checks: vec![ft_core::Requirement {
                name: "Worker connection".into(),
                available: false,
                required: true,
                detail: host
                    .diagnosis
                    .as_ref()
                    .map(|d| d.summary.clone())
                    .unwrap_or_else(|| {
                        "The worker is not connected. Check the connection and try again.".into()
                    }),
                remedy: Some(setup_instructions(&host.compute, key.as_deref())),
            }],
        }));
    }
    let readiness = state
        .fleet
        .check_readiness(&id, query.agent)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;
    if let Ok(agents) = state.fleet.probe_agents(&id).await {
        state.db.record_presence(&id, &agents).await?;
    }
    Ok(Json(readiness))
}

/// What to run to get a worker onto a machine that has none.
pub(crate) fn setup_instructions(compute: &ft_core::Compute, key: Option<&str>) -> String {
    match compute {
        ft_core::Compute::Local => {
            "Install Git, tmux and a POSIX shell on the machine running Firetower.".into()
        }
        ft_core::Compute::Server { .. } => crate::install::one_liner(key),
    }
}
