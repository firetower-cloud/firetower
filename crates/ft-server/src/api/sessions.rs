//! Sessions, and what you do with the work one produced.
//!
//! Starting one is the only place the control plane decides anything on its
//! own: it is what sees every host, so it is what picks. Everything after that
//! is asking the worker that holds the workspace.

use super::agents::{agent_env, agent_home};
use super::repos::is_local_path;
use super::{credential_for, ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::oauth;
use crate::providers;
use crate::vault;
use crate::vault::Key;
use crate::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use ft_core::{
    session::{title_from, Checkout},
    NewSession, Session, SessionId, SessionStatus,
};
use ft_proto::{CreateWorkspace, ToWorker};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// How long a launch will wait for a host that is on its way back.
///
/// Long enough for a network to change hands or a laptop to wake, short enough
/// that "it didn't work" arrives while you still remember asking for it.
const RECONNECT_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// Sessions, newest first.
///
/// Without `limit` this returns everything, which is what the dashboard wants —
/// it has to see every running session to say anything true about the fleet.
/// With one, it pages.
#[utoipa::path(
    get, path = "/api/v1/sessions", tag = "sessions",
    params(
        ("limit" = Option<u32>, Query, description = "How many to return"),
        ("before" = Option<String>, Query, description = "Continue after this id"),
    ),
    responses((status = 200, body = Vec<Session>)),
)]
pub(super) async fn list_sessions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(page): Query<Page>,
) -> ApiResult<Json<Vec<Session>>> {
    Ok(Json(
        state
            .db
            .sessions_page(owner(&principal)?, page.limit, page.before.as_deref())
            .await?,
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct Page {
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before: Option<String>,
}

/// End every workspace that is still running.
///
/// Destructive in the same way as ending one, multiplied — every workspace goes
/// and anything unpushed with it. The count comes back so the interface can say
/// what it did rather than guess.
///
/// Counted in workspaces rather than sessions. A workspace holds any number of
/// agents now, so "48 ended" was a number nobody recognised: what somebody is
/// about to lose is six places, not forty-eight processes.
#[utoipa::path(
    post, path = "/api/v1/sessions/end-all", tag = "sessions",
    request_body = EndAll,
    responses((status = 200, body = EndedAll)),
)]
pub(super) async fn end_all_sessions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<EndAll>,
) -> ApiResult<Json<EndedAll>> {
    // Yours. "End all" has never meant anybody else's, and with two people on
    // one Firetower it would be a button that ends a colleague's work.
    let live = state.db.live_sessions(owner(&principal)?).await?;

    // By the place rather than by the process. Every agent in a workspace shares
    // its worktree, so they go together or the directory is pulled out from
    // under whichever is left — and one unreachable host should skip a
    // workspace whole rather than half of it.
    let mut places: Vec<(String, Vec<Session>)> = Vec::new();
    for session in live {
        let key = session
            .workspace_id
            .as_ref()
            .map(|w| w.as_str().to_string())
            .unwrap_or_else(|| session.id.as_str().to_string());
        match places.iter_mut().find(|(id, _)| id == &key) {
            Some((_, held)) => held.push(session),
            None => places.push((key, vec![session])),
        }
    }

    // What was asked for, if anything was. Filtered after grouping because a
    // workspace is what goes: naming one is naming every agent in it, which is
    // the same promise the button makes.
    places.retain(|(id, _)| asked_for(id, req.workspaces.as_deref()));

    let mut ended = 0;
    let mut unreachable = 0;

    for (_, sessions) in places {
        let host = &sessions[0].host_id;

        // A host we can't talk to keeps its workspaces; marking them ended here
        // would be a lie the next reconnect corrects.
        if !state.fleet.is_connected(host).await {
            unreachable += 1;
            continue;
        }

        let mut lost = false;
        for session in &sessions {
            if let Err(e) = state
                .fleet
                .send(
                    &session.host_id,
                    ToWorker::Destroy {
                        session_id: session.id.clone(),
                        force: true,
                    },
                )
                .await
            {
                tracing::warn!(session = %session.id, "ending: {e:#}");
                lost = true;
            }
        }

        // The worktree is reclaimed by whichever of them finishes last, which
        // the worker decides for itself — so the order these go out in does not
        // matter, only that they all do.
        if lost {
            unreachable += 1;
        } else {
            ended += 1;
        }
    }

    Ok(Json(EndedAll { ended, unreachable }))
}

/// Whether this workspace is one of the ones asked for.
///
/// No list means every one of them, which is what `end-all` meant before it
/// could be narrowed. An *empty* list is not the same thing and must never be
/// read as one: it names nothing, so nothing goes.
fn asked_for(id: &str, wanted: Option<&[String]>) -> bool {
    match wanted {
        None => true,
        Some(ids) => ids.iter().any(|w| w == id),
    }
}

/// Which workspaces to end.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EndAll {
    /// The workspaces to end, by id. Every one of yours when omitted — which
    /// is what this endpoint did before it could be narrowed, and what an
    /// empty body still means.
    #[serde(default)]
    pub workspaces: Option<Vec<String>>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct EndedAll {
    /// Workspaces ended, not sessions: a workspace is what somebody loses.
    pub ended: u32,
    /// Left alone because their host wasn't answering.
    pub unreachable: u32,
}

#[utoipa::path(
    get, path = "/api/v1/sessions/{id}", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Session), (status = 404, body = ApiError)),
)]
pub(super) async fn get_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Session>> {
    state
        .db
        .session_of(owner(&principal)?, &SessionId::from_stored(id))
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("session"))
}

#[utoipa::path(
    post, path = "/api/v1/sessions", tag = "sessions",
    request_body = NewSession,
    responses(
        (status = 201, body = Session),
        (status = 404, body = ApiError, description = "repository is not connected"),
        (status = 409, body = ApiError, description = "no host can take it"),
    ),
)]
pub(super) async fn create_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(req): Json<NewSession>,
) -> ApiResult<(StatusCode, Json<Session>)> {
    // Whose session this is. Written down at the moment it is created, because
    // everything afterwards — who may open it, whose token pushes its branch,
    // whose name goes on its commits — is answered from here.
    let owner = owner(&principal)?.to_string();

    // Another agent in a place that already exists, which is a different job
    // from making one: the host, the repositories, the branch and the directory
    // are all decided, and everything below about choosing them does not apply.
    if let Some(workspace_id) = req.workspace_id.clone() {
        return start_another_agent(state, owner, workspace_id, req).await;
    }

    // What was actually asked for, if anything. A workspace may be created
    // empty — a branch, a checkout and an agent waiting in it — so the only
    // thing genuinely required is something to call it by.
    let prompt = req.prompt.as_deref().map(str::trim).unwrap_or_default();
    let asked_name = req.name.as_deref().map(str::trim).unwrap_or_default();

    if prompt.is_empty() && asked_name.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a workspace needs a name, or something to do",
        ));
    }

    // An agent Firetower cannot hold a conversation with cannot be started.
    //
    // There used to be a second way — run it in a terminal and let somebody
    // attach and type — and that is gone. Refusing here says why; starting one
    // and showing an empty conversation would not. This is the control plane's
    // question rather than the worker's: a worker does what it is told, and
    // what is allowed is policy.
    if !req.agent.speaks_a_protocol() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "Firetower has no driver for {} yet, so it cannot run one",
                req.agent.label()
            ),
        ));
    }

    // Every repository this session checks out, in order. `repoId` is the
    // one-repository form and goes first; `repos` is the list. Naming the same
    // one twice is a mistake rather than two checkouts.
    let mut wanted: Vec<ft_core::session::NewCheckout> = Vec::new();
    if let Some(repo_id) = req.repo_id.clone() {
        wanted.push(ft_core::session::NewCheckout {
            repo_id,
            base: req.base.clone(),
        });
    }
    for asked in &req.repos {
        if wanted.iter().any(|w| w.repo_id == asked.repo_id) {
            continue;
        }
        wanted.push(asked.clone());
    }

    // No repository at all is a bare agent: a workspace with nothing checked
    // out, which is still a workspace and still a session.
    let mut repos: Vec<(ft_core::Repo, Option<String>)> = Vec::new();
    for asked in &wanted {
        let found = state.db.repo(&asked.repo_id).await?.ok_or_else(|| {
            ApiError::new(
                ErrorCode::RepoNotConnected,
                "that repository isn't connected",
            )
        })?;
        repos.push((found, asked.base.clone()));
    }

    // The first one, for everything that wants a single name: the workspace
    // directory, the session row, a caption.
    let repo = repos.first().map(|(r, _)| r.clone());

    // Scheduling is the control plane's job — it is the only thing that sees
    // every host. Today there is one, so this is the whole scheduler.
    let hosts = state.db.hosts().await?;
    let host = match &req.host_id {
        // Named explicitly, so a drained one is still refused below rather
        // than silently swapped for another.
        Some(id) => hosts.iter().find(|h| &h.id == id),
        None => hosts
            .iter()
            .find(|h| h.state == ft_core::HostState::Online && !h.drained),
    }
    .ok_or_else(|| ApiError::new(ErrorCode::NoCapacity, "no host is available to take this"))?;

    if host.drained {
        return Err(ApiError::new(
            ErrorCode::NoCapacity,
            format!("{} is draining and isn't taking new work", host.name),
        ));
    }

    // A host that has just dropped is usually seconds from being back — a wifi
    // handover, a laptop waking, a container restarting. Refusing the work in
    // that window is refusing it for a reason that has already stopped being
    // true by the time the message is read.
    //
    // So we wait, but only for a host something is actively trying to reach. A
    // host nobody is reconnecting is not coming back on its own, and waiting on
    // it would be a promise rather than a delay.
    if !state.fleet.is_connected(&host.id).await {
        let coming_back = state.fleet.is_supervised(&host.id).await
            && state
                .fleet
                .wait_until_connected(&host.id, RECONNECT_GRACE)
                .await;

        if !coming_back {
            let why = state
                .db
                .host_by_id(&host.id)
                .await?
                .and_then(|h| h.diagnosis)
                .map(|d| d.summary)
                .unwrap_or_else(|| format!("{} isn't responding", host.name));

            return Err(ApiError::new(ErrorCode::HostUnreachable, why));
        }
    }

    // The binary has to be on the machine that will run it.
    //
    // Asked here, where there is somewhere to say it, rather than found out at
    // the launch step — which is what used to happen, and it arrived as the
    // agent never becoming ready. That reads as a broken agent and is a
    // missing one. The worker checks again before it launches, because this
    // answer is only as fresh as the last probe.
    let installed_here = state
        .db
        .presence()
        .await?
        .into_iter()
        .any(|p| p.host == host.id && p.found.kind == req.agent && p.found.installed);

    if !installed_here {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} isn't installed on {}. Install it from the Agents page and try again.",
                req.agent.label(),
                host.name
            ),
        ));
    }

    // A path is a path on *this* machine. Anywhere else it is a directory that
    // doesn't exist, and the session would fail several steps later with a git
    // error that says nothing about why.
    if let Some((local, _)) = repos
        .iter()
        .find(|(r, _)| is_local_path(&r.remote) && host.compute != ft_core::Compute::Local)
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} is a folder on this machine, so it can only run on this machine. \
                 Connect it by URL to use it on {}.",
                local.remote, host.name
            ),
        ));
    }

    // The trunk, for a repository nobody has read yet.
    //
    // A repository can be connected while no worker is reachable, so its trunk
    // may still be unknown. Here it is knowable: this host is connected by now,
    // and it is the machine about to do the cloning. Learned once and written
    // back, so the next session doesn't ask again.
    // One name for the session's branch, cut in every repository. That is what
    // makes a change across two of them reviewable: the same branch in both,
    // and two pull requests that can point at each other.
    let branch = ft_core::sanitize_branch(
        &req.branch
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                // The name first: it is what somebody chose, and the prompt is
                // only a fallback for the case where they typed a task and let
                // everything else be worked out.
                format!(
                    "agent/{}",
                    ft_core::slugify(if asked_name.is_empty() {
                        prompt
                    } else {
                        asked_name
                    })
                )
            }),
    );

    // The base is per repository, because each has its own trunk and they are
    // not always called the same thing.
    let mut checkouts: Vec<Checkout> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    for (repo, asked_base) in &repos {
        let base = match asked_base
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
        {
            Some(named) => named.to_string(),
            None => match repo.default_branch.clone() {
                Some(known) => known,
                // A repository can be connected while no worker is reachable,
                // so its trunk may still be unknown. Here it is knowable: this
                // host is connected and is the machine about to clone it.
                // Learned once and written back, so the next session doesn't
                // ask again.
                None => {
                    let found = state
                        .fleet
                        .probe(
                            &host.id,
                            &repo.remote,
                            credential_for(
                                &state,
                                &repo.remote,
                                &owner,
                                &format!("reading {}", repo.slug),
                            )
                            .await,
                        )
                        .await
                        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
                        .map_err(|f| {
                            ApiError::new(
                                ErrorCode::RepoUnreachable,
                                format!("{} couldn't read {}: {f:?}", host.name, repo.remote),
                            )
                        })?;

                    state
                        .db
                        .set_default_branch(&repo.id, &found.default_branch)
                        .await?;
                    found.default_branch
                }
            },
        };

        // Every checkout gets a directory inside the workspace, including when
        // there is only one. Uniform because a session can gain a repository
        // later, and a first checkout that *is* the workspace would have to
        // move to make room for a second.
        let dir = ft_core::session::checkout_dir(&repo.slug, &dirs);
        dirs.push(dir.clone());

        checkouts.push(Checkout {
            repo_id: Some(repo.id.clone()),
            slug: repo.slug.clone(),
            base,
            branch: branch.clone(),
            path: dir,
            trouble: None,
            pull_request: None,
            pull_state: None,
        });
    }

    let id = SessionId::new();
    // What the work is called in a list. The prompt says it best when there is
    // one; otherwise the name is all there is, and it was chosen for this.
    let title = if prompt.is_empty() {
        asked_name.to_string()
    } else {
        title_from(prompt)
    };

    // Named after the branch when there is a checkout; after the session
    // otherwise. One name for the whole workspace, whatever is inside it.
    //
    // The session is part of that name even when the branch is, because a
    // branch name is not unique: two sessions started from the same prompt ask
    // for the same one, and this used to hand them the same directory.
    let workspace = if checkouts.is_empty() {
        id.as_str().to_string()
    } else {
        ft_core::workspace_name(&branch, id.as_str())
    };
    let agent_name = format!("{:?}", req.agent);

    // Decided here, before the worker has been asked to do any of it, so the
    // session page has the whole shape of the work the moment it loads.
    let steps = ft_core::Step::plan(
        !checkouts.is_empty(),
        repos
            .iter()
            .any(|(r, _)| r.setup.as_deref().is_some_and(|s| !s.trim().is_empty())),
    );

    state
        .db
        .insert_session(
            &id,
            &host.id,
            &owner,
            repo.as_ref().map(|r| r.slug.as_str()),
            &title,
            prompt,
            checkouts.first().map(|c| c.branch.as_str()),
            checkouts.first().map(|c| c.base.as_str()),
            &agent_name,
            req.size,
            &steps,
            // What it is called, and what it is: the branch without the
            // `agent/` that every one of them carries, which would be four
            // characters of nothing repeated down the whole rail.
            Some(
                req.name
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| branch.strip_prefix("agent/").unwrap_or(&branch)),
            ),
        )
        .await?;

    // What this worktree is for, when it was started from a task. Recorded
    // after the place exists rather than inside its insert: a failure here
    // costs the `#5138` on its row and nothing else, which is not worth
    // threading two more arguments through every caller of `insert_session`.
    if let (Some(key), Some(url)) = (&req.task_key, &req.task_url) {
        state.db.bind_task(&id, key, url).await?;
    }

    state.db.record_checkouts(&id, &checkouts).await?;

    // Each repository's own variables, opened once. Every read is a line in the
    // vault's log naming the session it was for.
    let mut per_repo_env: Vec<Vec<ft_core::dotenv::Variable>> = Vec::new();
    for (repo, _) in &repos {
        per_repo_env.push(repo_env(&state, repo, &id).await?);
    }

    // The repositories first, the agent's own token last. A repository that
    // sets `ANTHROPIC_API_KEY` for its own reasons must not be able to stop the
    // agent from starting — whoever wrote that variable was thinking about
    // their application, not about us.
    //
    // Where two repositories set the same variable, the later one wins and
    // there is nothing better to do: one process, one environment. What each
    // repository asked for in a *file* stays its own, inside its own checkout.
    let mut env: Vec<(String, String)> = Vec::new();
    for vars in &per_repo_env {
        for v in vars {
            env.retain(|(existing, _)| *existing != v.name);
            env.push((v.name.clone(), v.value.clone()));
        }
    }
    for (name, value) in agent_env(&state, req.agent, &id, &owner).await? {
        env.retain(|(existing, _)| *existing != name);
        env.push((name, value));
    }

    // The same credential, for the agents that read one out of a file rather
    // than out of the environment.
    let agent_home = agent_home(&state, req.agent, &id, &owner).await?;

    // The identity the agent's *own* commits carry.
    //
    // `Action::Commit` covers what Firetower commits for you and reaches the
    // worker process; this covers `git commit` typed in the session's own
    // shell, which no frame ever reaches. Both are needed, and without this
    // one an agent committing its own work gets "Author identity unknown" —
    // a container has no `user.email` anywhere.
    //
    // One environment per process, so a session spanning two git hosts gets
    // the first checkout's identity for anything the agent commits by hand.
    // Firetower's own commits stay per checkout.
    if let Some(remote) = repos.first().map(|(r, _)| r.remote.clone()) {
        if let Some(author) = author_for(&state, &remote, &owner).await {
            for (name, value) in [
                ("GIT_AUTHOR_NAME", &author.name),
                ("GIT_AUTHOR_EMAIL", &author.email),
                ("GIT_COMMITTER_NAME", &author.name),
                ("GIT_COMMITTER_EMAIL", &author.email),
            ] {
                env.retain(|(existing, _)| existing != name);
                env.push((name.to_string(), value.clone()));
            }
        }
    }

    let mut specs = Vec::new();
    for ((repo, _), checkout) in repos.iter().zip(&checkouts) {
        let vars = &per_repo_env[specs.len()];
        specs.push(ft_proto::RepoSpec {
            remote: repo.remote.clone(),
            slug: repo.slug.clone(),
            base: checkout.base.clone(),
            branch: checkout.branch.clone(),
            path: checkout.path.clone(),
            setup: repo.setup.clone(),
            // Only the repository's own variables go in a file, and the file
            // goes inside that repository's checkout. The agent's token is
            // ours, and belongs in neither.
            env_file: repo
                .env_file
                .clone()
                .filter(|path| !path.trim().is_empty() && !vars.is_empty())
                .map(|path| ft_proto::EnvFile {
                    path,
                    variables: vars
                        .iter()
                        .map(|v| (v.name.clone(), v.value.clone()))
                        .collect(),
                }),
            // Sent with the work rather than held by the host: the worker keeps
            // it in memory for this session and writes it nowhere.
            credential: credential_for(
                &state,
                &repo.remote,
                &owner,
                &format!("starting {id} on {}", repo.slug),
            )
            .await,
        });
    }

    state
        .fleet
        .send(
            &host.id,
            ToWorker::CreateWorkspace(Box::new(CreateWorkspace {
                session_id: id.clone(),
                repos: specs,
                workspace,
                prompt: prompt.to_string(),
                agent: req.agent,
                size: req.size,
                env,
                agent_home,
            })),
        )
        .await?;

    let session = state
        .db
        .session_of(&owner, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    Ok((StatusCode::CREATED, Json(session)))
}

/// Start this session's agent again, in the workspace it already has.
///
/// A session outlives the process running it. The worktree, the branch, the
/// commits and everything said so far are on the volume; the agent is a child
/// process with a socket in `/tmp`, and recreating the container to upgrade
/// Firetower ends every one of them at once. Without this, an upgrade turned
/// every workspace on the machine into a page that could be typed into and
/// would never answer, and the only way on was to start again somewhere else.
///
/// Not [`start_another_agent`]: that one makes a *second* run in the same
/// place, with its own conversation. This is the same run coming back — same
/// id, and therefore the same `--session-id`, which is what lets the agent pick
/// the conversation up rather than begin one.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/relaunch", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses(
        (status = 200, body = Done),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn relaunch_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Done>> {
    let id = SessionId::from_stored(id);
    let owner = owner(&principal)?.to_string();
    let session = state
        .db
        .session_of(&owner, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    relaunch(&state, &session, &owner).await?;

    Ok(Json(Done {
        detail: format!("{} is starting again", session.agent.label()),
    }))
}

/// The work behind [`relaunch_session`], so a turn can do it without a request.
///
/// Everything is resolved fresh rather than remembered: the credential comes
/// out of the vault against this session, and the directory is derived the way
/// it was when the workspace was built. Nothing about a relaunch may depend on
/// state the restarted process was holding, because there isn't any.
pub(crate) async fn relaunch(
    state: &AppState,
    session: &Session,
    owner: &str,
) -> Result<(), ApiError> {
    if session.forgotten_at.is_some() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that workspace has been removed",
        ));
    }

    let host = state
        .db
        .host_by_id(&session.host_id)
        .await?
        .ok_or_else(|| ApiError::new(ErrorCode::NoCapacity, "that session's host is gone"))?;

    // The same grace the other launch path gives: a host that has just dropped
    // is usually seconds from being back, and after an upgrade that is exactly
    // where everything is.
    let reachable = state.fleet.is_connected(&host.id).await
        || (state.fleet.is_supervised(&host.id).await
            && state
                .fleet
                .wait_until_connected(&host.id, RECONNECT_GRACE)
                .await);

    if !reachable {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            format!("{} isn't responding", host.name),
        ));
    }

    // Derived the same way it was when the workspace was built — see
    // `start_another_agent`, which reads it from the same two facts.
    let directory = match session.branch.as_deref() {
        Some(branch) if session.repo.is_some() => {
            let workspace = session
                .workspace_id
                .as_ref()
                .map(|w| w.as_str().to_string())
                .unwrap_or_else(|| session.id.as_str().to_string());
            ft_core::workspace_name(branch, &workspace)
        }
        _ => session
            .workspace_id
            .as_ref()
            .map(|w| w.as_str().to_string())
            .unwrap_or_else(|| session.id.as_str().to_string()),
    };

    let mut env: Vec<(String, String)> = Vec::new();
    for (name, value) in agent_env(state, session.agent, &session.id, owner).await? {
        env.retain(|(existing, _)| *existing != name);
        env.push((name, value));
    }
    let agent_home = agent_home(state, session.agent, &session.id, owner).await?;

    state
        .fleet
        .send(
            &host.id,
            ToWorker::StartAgent(Box::new(ft_proto::StartAgent {
                session_id: session.id.clone(),
                workspace: directory,
                // Nothing to ask for. The conversation is being picked up, not
                // opened, and a prompt here would be a turn nobody typed.
                prompt: String::new(),
                agent: session.agent,
                title: session.title.clone(),
                repo: session.repo.clone(),
                branch: session.branch.clone(),
                base: session.base.clone(),
                size: session.size,
                env,
                agent_home,
            })),
        )
        .await?;

    if let Err(e) = state
        .db
        .set_session_state(&session.id, ft_core::SessionStatus::Starting, None)
        .await
    {
        tracing::warn!(session = %session.id, "recording a relaunch: {e:#}");
    }

    Ok(())
}

/// Another agent, in a workspace that is already there.
///
/// The place is not made again: its host, its repositories, its branch and its
/// directory are what they were, and a second agent shares all of them. What is
/// created is a session — a second run — with its own conversation, its own
/// socket on the host and its own tmux.
///
/// Deliberately not a flag on the path above. That one decides where to put a
/// workspace and then builds it; this one decides nothing and builds nothing,
/// and the two share only the launch at the end.
async fn start_another_agent(
    state: AppState,
    owner: String,
    workspace_id: ft_core::WorkspaceId,
    req: NewSession,
) -> ApiResult<(StatusCode, Json<Session>)> {
    if !req.agent.speaks_a_protocol() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "Firetower has no driver for {} yet, so it cannot run one",
                req.agent.label()
            ),
        ));
    }

    let place = state
        .db
        .workspace_for(&owner, &workspace_id)
        .await?
        .ok_or_else(|| ApiError::not_found("workspace"))?;

    // Removed here while its host was away. The directory may or may not still
    // be on that machine, and starting an agent in one we have already given up
    // on is how a workspace comes back from the dead.
    if place.forgotten {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that workspace has been removed",
        ));
    }

    // The agent has to be on the machine the workspace is on. There is no
    // choosing here: a workspace is one directory on one host, and an agent
    // anywhere else could not see it.
    let host = state
        .db
        .host_by_id(&place.host_id)
        .await?
        .ok_or_else(|| ApiError::new(ErrorCode::NoCapacity, "that workspace's host is gone"))?;

    let installed_here = state
        .db
        .presence()
        .await?
        .into_iter()
        .any(|p| p.host == host.id && p.found.kind == req.agent && p.found.installed);

    if !installed_here {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} isn't installed on {}, which is where this workspace is.",
                req.agent.label(),
                host.name
            ),
        ));
    }

    // A host that has just dropped is usually seconds from being back, so wait
    // for one something is actively reconnecting. One nobody is reconnecting is
    // not coming back on its own, and waiting would be a promise rather than a
    // delay.
    let reachable = state.fleet.is_connected(&host.id).await
        || (state.fleet.is_supervised(&host.id).await
            && state
                .fleet
                .wait_until_connected(&host.id, RECONNECT_GRACE)
                .await);

    if !reachable {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            format!("{} isn't responding", host.name),
        ));
    }

    let prompt = req.prompt.as_deref().map(str::trim).unwrap_or_default();
    let id = SessionId::new();
    let title = if prompt.is_empty() {
        req.agent.label().to_string()
    } else {
        title_from(prompt)
    };

    // The directory the workspace occupies, derived the same way it was when it
    // was built. A workspace carries the id of the session it was split from,
    // so this is that session's name for it — see `a_workspace_keeps_its_first
    // _sessions_id`, which is what stops this being a guess.
    let directory = match place.branch.as_deref() {
        Some(branch) if place.repo.is_some() => ft_core::workspace_name(branch, place.id.as_str()),
        _ => place.id.as_str().to_string(),
    };

    // One step. A second agent does not fetch, does not cut a worktree and does
    // not run setup, and drawing those as skipped would say something happened.
    let steps = vec![ft_core::Step::Launch];
    let agent_name = format!("{:?}", req.agent);

    state
        .db
        .insert_run(crate::db::NewRun {
            id: &id,
            workspace_id: &place.id,
            owner: &owner,
            title: &title,
            prompt,
            agent: &agent_name,
            steps: &steps,
        })
        .await?;

    // Its own credential and its own environment, resolved against this session
    // so the vault's log names the run that spent it.
    let mut env: Vec<(String, String)> = Vec::new();
    for (name, value) in agent_env(&state, req.agent, &id, &owner).await? {
        env.retain(|(existing, _)| *existing != name);
        env.push((name, value));
    }
    let agent_home = agent_home(&state, req.agent, &id, &owner).await?;

    state
        .fleet
        .send(
            &host.id,
            ToWorker::StartAgent(Box::new(ft_proto::StartAgent {
                session_id: id.clone(),
                workspace: directory,
                prompt: prompt.to_string(),
                agent: req.agent,
                title: title.clone(),
                repo: place.repo.clone(),
                branch: place.branch.clone(),
                base: place.base.clone(),
                size: place.size,
                env,
                agent_home,
            })),
        )
        .await?;

    let session = state
        .db
        .session_of(&owner, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    Ok((StatusCode::CREATED, Json(session)))
}

#[utoipa::path(
    delete, path = "/api/v1/sessions/{id}", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("force" = Option<bool>, Query, description = "Remove it here even though its host isn't answering"),
    ),
    responses((status = 202), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn destroy_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(req): Query<Removal>,
) -> ApiResult<StatusCode> {
    let id = SessionId::from_stored(id);
    let session = state
        .db
        .session_of(owner(&principal)?, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    if session.status == SessionStatus::Ended {
        return Err(ApiError::new(ErrorCode::SessionEnded, "already ended"));
    }

    // Ending is normally the worker's word: it tears the workspace down and
    // reports it, and the row follows. With nobody listening there is no such
    // word, and this used to fail as an internal error — a 500 for a machine
    // being off, and a session nobody could get rid of.
    if !state.fleet.is_connected(&session.host_id).await {
        if !req.force {
            let host = state
                .db
                .host_by_id(&session.host_id)
                .await?
                .map(|h| h.name)
                .unwrap_or_else(|| "its host".to_string());

            return Err(ApiError::new(
                ErrorCode::HostUnreachable,
                format!(
                    "{host} isn't answering, so the workspace can't be torn down. \
                     Remove it here anyway to stop it filling the inbox — it keeps \
                     running there until that machine comes back."
                ),
            ));
        }

        // Removed here, and owed a teardown there. The debt is paid the next
        // time that host connects; see `Fleet`'s reconnect.
        state.db.forget_session(&id).await?;
        return Ok(StatusCode::ACCEPTED);
    }

    // Ending the workspace's own session ends the workspace, so the other
    // agents in it go too. They share its directory, and it is about to be
    // reclaimed; left running they would be working in a place that no longer
    // exists, and nothing would list them, because a session is only reachable
    // through the workspace it belongs to.
    //
    // Ending one of the others is just that one agent — the place and its
    // neighbours carry on.
    let workspace = session.workspace_id.clone();
    if workspace
        .as_ref()
        .is_some_and(|w| w.as_str() == session.id.as_str())
    {
        for run in state
            .db
            .live_runs_beside(
                owner(&principal)?,
                workspace.as_ref().expect("checked just above"),
                &id,
            )
            .await?
        {
            state
                .fleet
                .send(
                    &session.host_id,
                    ToWorker::Destroy {
                        session_id: run,
                        force: false,
                    },
                )
                .await?;
        }
    }

    state
        .fleet
        .send(
            &session.host_id,
            ToWorker::Destroy {
                session_id: id,
                force: false,
            },
        )
        .await?;

    Ok(StatusCode::ACCEPTED)
}

/// Removing a session whose host has stopped answering.
#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
pub(super) struct Removal {
    /// Take it off the inbox without the machine being told.
    #[serde(default)]
    force: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub detail: String,
}

/// What is in a directory of a session's workspace.
///
/// Paths are relative to the workspace and stay there: the worker refuses
/// anything with a `..` in it, and describes a symbolic link rather than
/// following it.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/files", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("path" = Option<String>, Query, description = "Directory, relative to the workspace"),
    ),
    responses((status = 200, body = Vec<ft_core::FileEntry>), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn list_files(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(req): Query<FilePath>,
) -> ApiResult<Json<Vec<ft_core::FileEntry>>> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &principal, &id).await?;

    state
        .fleet
        .list_files(&host, &id, req.path.as_deref().unwrap_or(""))
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map(Json)
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused))
}

/// Files in a session's workspace whose path matches a query.
///
/// Loose matching, best first: nobody types a path, they type the letters they
/// remember in the order they remember them. The list is capped — a search
/// nobody scrolls past twenty results of should not cost a megabyte on a pipe
/// shared with every terminal on the host.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/files/search", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("q" = String, Query, description = "What to look for, matched loosely against the whole path"),
        ("limit" = Option<usize>, Query, description = "The most paths to send back. 200 by default."),
    ),
    responses((status = 200, body = Vec<String>), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn find_files(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(req): Query<FileQuery>,
) -> ApiResult<Json<Vec<String>>> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &principal, &id).await?;

    // Capped whatever the caller asks for: the limit is there to protect the
    // pipe, and a limit a caller can raise is not a limit.
    let limit = req.limit.unwrap_or(200).clamp(1, 500);

    state
        .fleet
        .find_files(&host, &id, req.q.trim(), limit)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map(Json)
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused))
}

/// A file out of the workspace, streamed.
///
/// Chunked all the way through: the worker reads it in pieces, the pieces cross
/// one pipe shared with every terminal on that machine, and they go straight
/// out to the browser rather than being collected here first.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/file", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("path" = String, Query, description = "File, relative to the workspace"),
    ),
    responses((status = 200, description = "The file"), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn download_file(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(req): Query<FilePath>,
) -> Result<axum::response::Response, ApiError> {
    let id = SessionId::from_stored(id);
    let (_, host) = session_context(&state, &principal, &id).await?;

    let path = req.path.unwrap_or_default();
    if path.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "which file? `path` is relative to the workspace",
        ));
    }

    let (size, chunks) = state
        .fleet
        .read_file(&host, &id, &path)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|refused| ApiError::new(ErrorCode::InvalidRequest, refused))?;

    let name = path.rsplit('/').next().unwrap_or("download").to_string();
    use futures::StreamExt;
    let body = axum::body::Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(chunks).map(Ok::<_, std::io::Error>),
    );

    axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .header(axum::http::header::CONTENT_LENGTH, size)
        // Quoted, because a filename can contain a space and a header cannot
        // pretend otherwise.
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", name.replace('"', "")),
        )
        .body(body)
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub(super) struct FileQuery {
    /// What somebody typed.
    #[serde(default)]
    q: String,
    /// The most paths to send back.
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub(super) struct FilePath {
    /// Relative to the workspace. Absent means the workspace itself.
    #[serde(default)]
    path: Option<String>,
}

/// Everything a repository holds, decrypted for one session.
///
/// Names come from the vault's index; each value is a separate open, and each
/// open is logged with the session it was for. A variable that has gone missing
/// between listing and reading is skipped rather than fatal — a session that
/// won't start because one variable was removed a second ago is a worse answer
/// than one that starts without it.
async fn repo_env(
    state: &AppState,
    repo: &ft_core::Repo,
    session: &SessionId,
) -> Result<Vec<ft_core::dotenv::Variable>, ApiError> {
    let scope = super::repos::env_scope(&repo.id);
    let reason = format!("starting {session} on {}", repo.slug);

    let mut out = Vec::new();
    for name in state
        .vault
        .names()
        .await?
        .into_iter()
        .filter(|held| held.scope == scope && held.owner.is_empty())
        .map(|held| held.name)
    {
        if let Some(value) = state.vault.get(Key::shared(&scope, &name), &reason).await? {
            // Out of its zeroizing wrapper here, as the agent's own token
            // already is: from this point it is going into a frame, over a
            // pipe, and into a tmux environment.
            out.push(ft_core::dotenv::Variable {
                name,
                value: value.to_string(),
            });
        }
    }

    Ok(out)
}

/// The session, its host, and the credential its remote needs.
async fn session_context(
    state: &AppState,
    principal: &Principal,
    id: &SessionId,
) -> Result<(Session, ft_core::HostId), ApiError> {
    // Somebody else's is not found rather than refused: saying "you may not"
    // confirms it exists, which is the one thing the asker had no way to know.
    let session = state
        .db
        .session_of(owner(principal)?, id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    if session.status == SessionStatus::Ended {
        return Err(ApiError::new(
            ErrorCode::SessionEnded,
            "that session has ended",
        ));
    }

    let host = session.host_id.clone();
    if !state.fleet.is_connected(&host).await {
        return Err(ApiError::new(
            ErrorCode::HostUnreachable,
            "the host running this session isn't responding",
        ));
    }
    Ok((session, host))
}

async fn act(
    state: &AppState,
    principal: &Principal,
    id: &SessionId,
    action: ft_proto::Action,
) -> ApiResult<Json<Done>> {
    let (session, host) = session_context(state, principal, id).await?;

    // Committing and pushing are about a checkout. Stopping isn't.
    if session.repo.is_none() && !matches!(action, ft_proto::Action::Stop) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to commit or push",
        ));
    }

    // Only the remote needs one, and only some of these touch it. A bare agent
    // has no remote at all.
    let credential = match session.repo.as_deref() {
        Some(slug) => match state.db.repo_by_slug(slug).await? {
            // The session's owner, not whoever asked. It is their branch and
            // their token that has to be able to push it.
            Some(repo) => {
                credential_for(
                    state,
                    &repo.remote,
                    session.owner.as_str(),
                    &format!("{action:?} on {id}"),
                )
                .await
            }
            None => None,
        },
        None => None,
    };

    match state
        .fleet
        .run_action(&host, id, action, credential)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
    {
        Ok(detail) => Ok(Json(Done { detail })),
        Err(why) => Err(ApiError::new(ErrorCode::ActionFailed, why)),
    }
}

/// Call it something else.
///
/// The name only. A session's number is what other things point at, so it is
/// fixed for as long as the session exists — renaming is for the half a person
/// reads.
#[utoipa::path(
    patch, path = "/api/v1/sessions/{id}", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = RenameSession,
    responses(
        (status = 200, body = Session),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn rename_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<RenameSession>,
) -> ApiResult<Json<Session>> {
    let id = SessionId::from_stored(id);

    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a session needs a name — `Agent 3` if you want the one it started with",
        ));
    }

    // Checked before renaming, so somebody else's session cannot be renamed by
    // guessing its id.
    let owner = owner(&principal)?;
    state
        .db
        .session_of(owner, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;

    state.db.rename_session(&id, name).await?;

    state
        .db
        .session_of(owner, &id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("session"))
}

#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
pub struct RenameSession {
    pub name: String,
}

/// Stop the agent. The workspace and its branch stay.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/stop", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Done), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn stop_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Done>> {
    act(
        &state,
        &principal,
        &SessionId::from_stored(id),
        ft_proto::Action::Stop,
    )
    .await
}

/// Push every branch, so the work outlives the workspace.
///
/// Each repository is pushed to its own remote. One that has nothing new is
/// skipped rather than refused: it is a repository this change did not touch.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/push", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Done), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn push_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Done>> {
    let id = SessionId::from_stored(id);
    let (session, _) = session_context(&state, &principal, &id).await?;

    let mut done = Vec::new();
    let mut refused = Vec::new();
    for c in known_checkouts(&session) {
        // Per checkout, not per session: a session can hold repositories on
        // different remotes, and the token that opens one opens neither the
        // other nor a self-hosted git that needs none. The session's owner
        // rather than whoever pressed the button — it is their branch going up
        // under their name.
        let credential = match state.db.repo_by_slug(&c.slug).await? {
            Some(repo) => {
                credential_for(
                    &state,
                    &repo.remote,
                    session.owner.as_str(),
                    &format!("pushing {} for {id}", c.branch),
                )
                .await
            }
            None => None,
        };

        match one(
            &state,
            &principal,
            &id,
            ft_proto::Action::Push {
                checkout: c.path.clone(),
            },
            credential,
        )
        .await
        {
            Ok(detail) => done.push(format!("{}: {detail}", c.slug)),
            Err(why) if nothing_to_do(&why) => {}
            // Said rather than thrown, because one repository refusing a push
            // must not hide that the other one worked.
            Err(why) => refused.push(format!("{}: {why}", c.slug)),
        }
    }

    if done.is_empty() && !refused.is_empty() {
        return Err(ApiError::new(ErrorCode::ActionFailed, refused.join(" · ")));
    }

    Ok(Json(Done {
        detail: if done.is_empty() {
            "everything was already pushed".to_string()
        } else if refused.is_empty() {
            done.join(" · ")
        } else {
            format!(
                "{} · {} refused: {}",
                done.join(" · "),
                refused.len(),
                refused.join(" · ")
            )
        },
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    /// The commit message. Falls back to what the agent proposed.
    #[serde(default)]
    pub message: Option<String>,
    /// Which files to include. Empty means everything that changed.
    #[serde(default)]
    pub paths: Vec<String>,
}

/// Commit the work, or the part of it somebody kept.
///
/// Everything by default, because that is what an unattended session wants.
/// Naming files is for the review sheet, where somebody has just looked at each
/// one and unticked the lockfile.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/commit", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = Commit,
    responses((status = 200, body = Done), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn commit_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<Commit>,
) -> ApiResult<Json<Done>> {
    let id = SessionId::from_stored(id);
    let (session, _) = session_context(&state, &principal, &id).await?;

    let message = req
        .message
        .clone()
        .or_else(|| session.proposed_title.clone())
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .ok_or_else(|| ApiError::new(ErrorCode::InvalidRequest, "a commit needs a message"))?;

    // Paths arrive workspace-relative, because that is what the review sheet
    // shows — `firetower/crates/…` beside `sandbox/README.md`. Each checkout is
    // committed with its own share of them, made relative to itself.
    //
    // One message for all of them: a change that spans two repositories is one
    // piece of work, and two commits saying the same sentence is the honest
    // record of it.
    let held = known_checkouts(&session);

    // The session's owner, not whoever pressed the button — the work is
    // theirs. Resolved per checkout below, because two checkouts can be on two
    // different hosts and the identity is the host's answer.
    let owner = session.owner.as_str().to_string();

    // The review sheet only puts a checkout's directory in front of a file
    // when the session holds more than one — so with a single checkout the
    // paths arrive bare, `hello.sh` rather than `sandbox-firetower/hello.sh`.
    //
    // This is what silently committed nothing: `within` looked for a prefix
    // that was never there, every path was dropped, the checkout was skipped,
    // and the caller went on to push and open a pull request for a branch that
    // had gained no commits. With one checkout there is nowhere else a path
    // could belong, so a bare one belongs here.
    let single = held.len() == 1;

    // Whether any checkout claimed a path the caller named.
    let mut claimed = false;

    let mut done = Vec::new();
    for c in &held {
        let paths: Vec<String> = if req.paths.is_empty() {
            Vec::new()
        } else {
            let kept: Vec<String> = req
                .paths
                .iter()
                .filter_map(|p| within(&c.path, p).or_else(|| single.then(|| p.clone())))
                .collect();
            // Named files, none of them here. Nothing to commit in this one.
            if kept.is_empty() {
                continue;
            }
            claimed = true;
            kept
        };

        match one(
            &state,
            &principal,
            &id,
            ft_proto::Action::Commit {
                checkout: c.path.clone(),
                message: message.clone(),
                paths,
                // By the remote, so two checkouts on two hosts each get the
                // identity that host expects. `Held` carries the slug, and
                // the remote is what `for_remote` matches on.
                author: match state.db.repo_by_slug(&c.slug).await? {
                    Some(repo) => author_for(&state, &repo.remote, &owner).await,
                    None => None,
                },
            },
            // A commit is local. The remote is not touched until the push,
            // which is the one that needs a token.
            None,
        )
        .await
        {
            Ok(detail) => done.push(format!("{}: {detail}", c.slug)),
            // A repository with nothing staged is not a failure — it is a
            // repository this change did not touch.
            Err(why) if nothing_to_do(&why) => {}
            Err(why) => {
                return Err(ApiError::new(
                    ErrorCode::ActionFailed,
                    format!("{}: {why}", c.slug),
                ))
            }
        }
    }

    // Files were named and none of them landed anywhere. Saying "nothing to
    // commit" here is what let a commit that committed nothing report success,
    // and the caller pushed and opened a pull request on the strength of it.
    if !req.paths.is_empty() && !claimed {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "none of those files are in this session's checkouts",
        ));
    }

    Ok(Json(Done {
        detail: if done.is_empty() {
            "nothing to commit".to_string()
        } else {
            done.join(" · ")
        },
    }))
}

/// Who to record as the author of a commit.
///
/// Chosen by the hostname of the remote, through `providers::for_remote` — the
/// same lookup that picks the credential — so a session holding a GitHub
/// checkout and a checkout somewhere else gets the right identity for each.
///
/// Deliberately not `users.email`. That is a login: somebody signs in with a
/// work address whose GitHub account is under a different one entirely, and a
/// commit authored with the wrong address is at best confusing and at worst
/// refused by the host at push time.
async fn author_for(state: &AppState, remote: &str, owner: &str) -> Option<ft_proto::Author> {
    let provider = providers::for_remote(remote)?;
    super::providers::identity_for(state, provider, owner).await
}

/// Whether a path is inside a checkout, and what it is called from there.
///
/// The empty checkout is the workspace, so everything is inside it.
fn within(checkout: &str, path: &str) -> Option<String> {
    if checkout.is_empty() {
        return Some(path.to_string());
    }
    path.strip_prefix(checkout)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(str::to_string)
}

/// Whether a refusal means "there was nothing here", which is not a failure.
fn nothing_to_do(why: &str) -> bool {
    let why = why.to_ascii_lowercase();
    why.contains("nothing to commit")
        || why.contains("no changes")
        || why.contains("nothing added")
        || why.contains("up to date")
        || why.contains("everything up-to-date")
}

/// Run one action and give back what it said.
async fn one(
    state: &AppState,
    principal: &Principal,
    id: &SessionId,
    action: ft_proto::Action,
    credential: Option<ft_proto::Credential>,
) -> Result<String, String> {
    let (_, host) = session_context(state, principal, id)
        .await
        .map_err(|e| e.message.clone())?;
    match state.fleet.run_action(&host, id, action, credential).await {
        Ok(Ok(detail)) => Ok(detail),
        Ok(Err(why)) => Err(why),
        Err(e) => Err(format!("{e:#}")),
    }
}

/// How stale an answer has to be before it is worth asking again.
///
/// Every refresh here is a call to somebody else's API against one shared
/// token. At this cadence one watched request costs 720 calls an hour against
/// GitHub's 5000, and only while a page is open on it — so the ceiling is the
/// number of workspaces somebody is looking at, which is one.
const PULL_STATE_MAX_AGE: chrono::Duration = chrono::Duration::seconds(5);

/// Ask the git host what became of this session's pull requests.
///
/// Only the ones still believed open: merged and closed do not change back, so
/// asking again spends a call on an answer that cannot differ. A host that
/// cannot be reached leaves the last answer standing rather than failing the
/// request — the panel is drawn either way, and being unable to check is not
/// something to put in front of somebody who is trying to work.
pub(crate) async fn refresh_pull_state(state: &AppState, session: &Session, owner: &str) {
    let Some(workspace) = session.workspace_id.clone() else {
        return;
    };
    let Ok(waiting) = state.db.pull_requests_to_check(&workspace).await else {
        return;
    };

    let now = chrono::Utc::now();
    for (path, url, checked) in waiting {
        if checked.is_some_and(|at| now - at < PULL_STATE_MAX_AGE) {
            continue;
        }
        let Some(provider) = crate::providers::for_remote(&url) else {
            continue;
        };
        let Ok(Some(token)) = state
            .vault
            .get(
                crate::vault::Key::of(vault::GIT, provider.id, owner),
                "checking a pull request",
            )
            .await
        else {
            continue;
        };

        match oauth::pull_request_state(provider, &token, &url).await {
            Ok(went) => {
                if let Err(e) = state
                    .db
                    .set_checkout_pull_state(&workspace, &path, went)
                    .await
                {
                    tracing::warn!(session = %session.id, "recording a pull request state: {e:#}");
                }
            }
            Err(e) => tracing::debug!(session = %session.id, "asking about {url}: {e:#}"),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub title: String,
    pub body: String,
}

/// What the agent would call this work.
///
/// Runs on the host, where the code is — a short-lived agent reading the diff,
/// not a turn in the session. A hidden turn is still a turn: it would land in
/// the transcript, spend the session's tokens and move its context meter, and a
/// session somebody is about to carry on working in should not be closer to
/// full because something wanted a sentence for a form.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/describe", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Proposal), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn describe_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Proposal>> {
    let id = SessionId::from_stored(id);
    let proposal = propose(&state, &principal, &id).await?;
    Ok(Json(proposal))
}

/// Ask the host what this work should be called, and remember the answer.
///
/// Shared with the moment a session hands back, which is when this happens
/// without anybody asking.
pub(crate) async fn propose(
    state: &AppState,
    principal: &Principal,
    id: &SessionId,
) -> ApiResult<Proposal> {
    let (session, host) = session_context(state, principal, id).await?;
    if session.repo.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to describe",
        ));
    }

    let answer = state
        .fleet
        .run_action(&host, id, ft_proto::Action::Describe, None)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|why| ApiError::new(ErrorCode::ActionFailed, why))?;

    // Title, blank line, body — the shape the worker sends it in.
    let (title, body) = answer.split_once("\n\n").unwrap_or((answer.as_str(), ""));
    let proposal = Proposal {
        title: title.trim().to_string(),
        body: body.trim().to_string(),
    };

    if let Err(e) = state
        .db
        .record_proposal(id, &proposal.title, &proposal.body)
        .await
    {
        tracing::warn!(session = %id, "could not keep the proposal: {e:#}");
    }
    Ok(proposal)
}

/// Check another repository into a session that is already running.
///
/// The same work as bring-up, done once more. The agent is told afterwards,
/// because an agent that is not told has no reason to look.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/repos", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = ft_core::session::NewCheckout,
    responses((status = 200, body = Done), (status = 404, body = ApiError), (status = 409, body = ApiError)),
)]
pub(super) async fn add_repo(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<ft_core::session::NewCheckout>,
) -> ApiResult<Json<Done>> {
    let id = SessionId::from_stored(id);
    let (session, host) = session_context(&state, &principal, &id).await?;

    let repo = state.db.repo(&req.repo_id).await?.ok_or_else(|| {
        ApiError::new(
            ErrorCode::RepoNotConnected,
            "that repository isn't connected",
        )
    })?;

    if session.checkouts.iter().any(|c| c.slug == repo.slug) {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("{} is already checked out in this session", repo.slug),
        ));
    }

    // The session's branch, so a change spanning it and what was already here
    // is one branch name in both.
    let branch = session
        .branch
        .clone()
        .unwrap_or_else(|| format!("agent/{}", ft_core::slugify(&session.prompt)));

    let base = req
        .base
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .or_else(|| repo.default_branch.clone())
        .unwrap_or_else(|| "main".to_string());

    let taken: Vec<String> = session.checkouts.iter().map(|c| c.path.clone()).collect();
    let path = ft_core::session::checkout_dir(&repo.slug, &taken);

    let vars = repo_env(&state, &repo, &id).await?;
    let spec = ft_proto::RepoSpec {
        remote: repo.remote.clone(),
        slug: repo.slug.clone(),
        base: base.clone(),
        branch: branch.clone(),
        path: path.clone(),
        setup: repo.setup.clone(),
        env_file: repo
            .env_file
            .clone()
            .filter(|p| !p.trim().is_empty() && !vars.is_empty())
            .map(|p| ft_proto::EnvFile {
                path: p,
                variables: vars
                    .iter()
                    .map(|v| (v.name.clone(), v.value.clone()))
                    .collect(),
            }),
        credential: credential_for(
            &state,
            &repo.remote,
            session.owner.as_str(),
            &format!("adding {} to {id}", repo.slug),
        )
        .await,
    };

    let detail = match state
        .fleet
        .run_action(
            &host,
            &id,
            ft_proto::Action::AddRepo {
                repo: Box::new(spec),
                env: vars
                    .iter()
                    .map(|v| (v.name.clone(), v.value.clone()))
                    .collect(),
            },
            None,
        )
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
    {
        Ok(detail) => detail,
        Err(why) => return Err(ApiError::new(ErrorCode::ActionFailed, why)),
    };

    state
        .db
        .add_checkout(
            &id,
            &Checkout {
                repo_id: Some(repo.id.clone()),
                slug: repo.slug.clone(),
                base,
                branch: branch.clone(),
                path: path.clone(),
                trouble: None,
                pull_request: None,
                pull_state: None,
            },
        )
        .await?;

    // Said to the agent, not just recorded. It is mid-conversation and has no
    // reason to go looking at the filesystem again.
    let told = format!(
        "I've checked out `{}` at `./{}`, on branch `{}`. It is a separate \
         repository — a change there is committed and pushed on its own.",
        repo.slug, path, branch
    );
    if let Err(e) = state.fleet.send_turn(&host, &id, &told, &[]).await {
        tracing::warn!(session = %id, "checked out {} but could not tell the agent: {e:#}", repo.slug);
    }

    Ok(Json(Done { detail }))
}

/// What is in this workspace that isn't safely elsewhere.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/work", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Vec<ft_core::CheckoutWork>), (status = 404, body = ApiError)),
)]
pub(super) async fn session_work(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<ft_core::CheckoutWork>>> {
    let id = SessionId::from_stored(id);
    let (session, host) = session_context(&state, &principal, &id).await?;

    if session.checkouts.is_empty() && session.repo.is_none() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to summarise",
        ));
    }

    // Before the checkouts are read back, so what this returns is the answer
    // that was just fetched rather than the one from the refresh before it.
    // Throttled inside, and it asks about nothing once every request is
    // settled — which is the state a workspace spends most of its life in.
    refresh_pull_state(&state, &session, owner(&principal)?).await;
    // Read back, because the refresh writes to the database and the copy
    // loaded above still holds what was true before it.
    let session = state
        .db
        .session_of(owner(&principal)?, &id)
        .await?
        .unwrap_or(session);

    let summaries = state
        .fleet
        .summarize(&host, &id)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?;

    // The host says what is unsaved; the control plane says where it went. A
    // checkout the worker could not read still gets a row, because a repository
    // that is missing is something to say rather than something to omit.
    let mut out = Vec::new();
    for c in known_checkouts(&session) {
        let found = summaries
            .iter()
            .find(|s| s.path == c.path && (s.slug == c.slug || s.slug.is_empty()));
        out.push(ft_core::CheckoutWork {
            path: c.path.clone(),
            slug: c.slug.clone(),
            branch: found.map(|s| s.summary.branch.clone()).unwrap_or(c.branch),
            base: c.base,
            uncommitted: found.map(|s| s.summary.uncommitted).unwrap_or(0),
            ahead: found.map(|s| s.summary.ahead).unwrap_or(0),
            pushed: found.is_some_and(|s| s.summary.pushed),
            // Absent, not zero, when the worker is too old to say — the
            // interface treats those differently on purpose.
            commits: found.and_then(|s| s.summary.commits),
            pull_request: c.pull_request,
            pull_state: c.pull_state,
            trouble: c.trouble,
        });
    }

    Ok(Json(out))
}

/// Whose sessions a request means.
///
/// A session belongs to somebody: it is their branch, their agent, and their
/// token that pushes it. Refused rather than defaulted when authentication is
/// off, because a session owned by nobody is one nobody can be shown.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal.owner().ok_or_else(|| {
        ApiError::new(
            ErrorCode::Unauthorized,
            "a session belongs to an account, and authentication is switched off",
        )
    })
}

/// One row per repository this session holds.
///
/// From the checkouts when there are any, and from the session's own columns
/// when there are not — which is every session made before a session could hold
/// more than one.
fn known_checkouts(session: &Session) -> Vec<Held> {
    if !session.checkouts.is_empty() {
        return session
            .checkouts
            .iter()
            .map(|c| Held {
                path: c.path.clone(),
                slug: c.slug.clone(),
                branch: c.branch.clone(),
                base: c.base.clone(),
                pull_request: c.pull_request.clone(),
                pull_state: c.pull_state,
                trouble: c.trouble.clone(),
            })
            .collect();
    }

    match (&session.repo, &session.branch, &session.base) {
        (Some(slug), Some(branch), Some(base)) => vec![Held {
            path: String::new(),
            slug: slug.clone(),
            branch: branch.clone(),
            base: base.clone(),
            pull_request: session.pull_request.clone(),
            trouble: None,
            pull_state: None,
        }],
        _ => Vec::new(),
    }
}

struct Held {
    path: String,
    slug: String,
    branch: String,
    base: String,
    pull_request: Option<String>,
    pull_state: Option<ft_core::session::PullState>,
    trouble: Option<String>,
}

/// What this session changed, file by file.
///
/// Split on the server: it is a pure function over text that is easy to get
/// subtly wrong, and doing it once here beats doing it in every client.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/diff", tag = "sessions",
    params(
        ("id" = String, Path, description = "Session id"),
        ("checkout" = Option<String>, Query, description = "Which checkout, by its path in the workspace. Every one when omitted."),
    ),
    responses((status = 200, body = Vec<ft_core::FileDiff>), (status = 404, body = ApiError)),
)]
pub(super) async fn session_diff(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Query(which): Query<Which>,
) -> ApiResult<Json<Vec<ft_core::FileDiff>>> {
    let id = SessionId::from_stored(id);
    let (session, host) = session_context(&state, &principal, &id).await?;

    // Every checkout unless one is named. Each file keeps the repository it
    // came from in front of its path, because two repositories can both have a
    // `src/index.ts` and a list that does not say which is a list you cannot
    // act on.
    let wanted: Vec<Held> = match &which.checkout {
        Some(at) => known_checkouts(&session)
            .into_iter()
            .filter(|c| &c.path == at)
            .collect(),
        None => known_checkouts(&session),
    };

    let many = wanted.len() > 1;
    let mut files = Vec::new();
    for c in wanted {
        let diff = match state
            .fleet
            .run_action(
                &host,
                &id,
                ft_proto::Action::Diff {
                    checkout: c.path.clone(),
                },
                None,
            )
            .await
            .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        {
            Ok(diff) => diff,
            // One unreadable checkout should not empty the sheet.
            Err(_) => continue,
        };

        for mut file in ft_core::split_diff(&diff) {
            if many && !c.path.is_empty() {
                file.path = format!("{}/{}", c.path, file.path);
            }
            files.push(file);
        }
    }

    Ok(Json(files))
}

/// Which checkout an action means.
#[derive(Debug, Default, Deserialize, utoipa::IntoParams)]
pub(super) struct Which {
    /// The checkout's path inside the workspace. Absent means all of them.
    #[serde(default)]
    pub checkout: Option<String>,
}

/// Open a pull request for this session's branch.
///
/// An API call to the git host rather than a git operation, so it happens here
/// with the token we already hold — the same shape as listing repositories.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/pull-request", tag = "sessions",
    params(("id" = String, Path, description = "Session id")),
    request_body = NewPullRequest,
    responses(
        (status = 200, body = PullRequest),
        (status = 401, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn open_pull_request(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(req): Json<NewPullRequest>,
) -> ApiResult<Json<PullRequest>> {
    let id = SessionId::from_stored(id);
    let (session, _) = session_context(&state, &principal, &id).await?;

    // Written, or proposed by the agent when it finished — never derived from
    // the prompt. A title cut from the opening sentence of a request reads like
    // "I would like remove", and it is the first thing a reviewer sees.
    let title = req
        .title
        .clone()
        .or_else(|| session.proposed_title.clone())
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| ApiError::new(ErrorCode::InvalidRequest, "a pull request needs a title"))?;

    let body = req
        .body
        .as_deref()
        .or(session.proposed_body.as_deref())
        .unwrap_or(&session.prompt)
        .to_string();

    // Every repository this session changed, and one pull request in each.
    //
    // Not one pull request spanning two repositories, because no git host has
    // such an object. Two that point at each other is what the platform can
    // represent, and what a reviewer will actually see.
    let held = known_checkouts(&session);
    if held.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "this session has no repository, so there is nothing to open",
        ));
    }

    let mut opened: Vec<(String, String)> = Vec::new();
    let mut refused: Vec<String> = Vec::new();

    for c in &held {
        // Already open. Pushing again amends it, so there is nothing to do.
        if let Some(url) = &c.pull_request {
            opened.push((c.slug.clone(), url.clone()));
            continue;
        }

        match open_one(
            &state,
            session.owner.as_str(),
            &c.slug,
            &c.branch,
            &c.base,
            &title,
            &body,
            req.draft,
        )
        .await
        {
            Ok(url) => {
                if let Err(e) = state.db.set_checkout_pull_request(&id, &c.path, &url).await {
                    tracing::warn!(session = %id, "opened a pull request but could not record it: {e:#}");
                }
                opened.push((c.slug.clone(), url));
            }
            // A repository with nothing pushed has nothing to open, which is
            // not a reason to refuse the ones that do.
            Err(why) if nothing_to_do(&why) => {}
            Err(why) => refused.push(format!("{}: {why}", c.slug)),
        }
    }

    let Some((_, first)) = opened.first().cloned() else {
        return Err(ApiError::new(
            ErrorCode::ActionFailed,
            if refused.is_empty() {
                "nothing is pushed yet, so there is nothing to open".to_string()
            } else {
                refused.join(" · ")
            },
        ));
    };

    // Each one gets a line pointing at the others. Done afterwards because none
    // of them has a URL until all of them have been opened.
    if opened.len() > 1 {
        for (slug, url) in &opened {
            let others: Vec<String> = opened
                .iter()
                .filter(|(other, _)| other != slug)
                .map(|(other, link)| format!("- {other}: {link}"))
                .collect();

            let with_links = format!(
                "{body}\n\n---\n\nPart of one change across {} repositories:\n{}\n",
                opened.len(),
                others.join("\n")
            );

            if let Err(e) = link_up(&state, session.owner.as_str(), slug, url, &with_links).await {
                tracing::warn!(%slug, "could not cross-link the pull request: {e:#}");
            }
        }
    }

    // The session's own field still names one, for a caption that wants one.
    if let Err(e) = state.db.record_pull_request(&id, &first).await {
        tracing::warn!(session = %id, "recording the pull request: {e:#}");
    }

    let url = first;
    Ok(Json(PullRequest { url }))
}

/// Open one, in one repository.
#[allow(clippy::too_many_arguments)]
async fn open_one(
    state: &AppState,
    owner: &str,
    slug: &str,
    head: &str,
    base: &str,
    title: &str,
    body: &str,
    draft: bool,
) -> Result<String, String> {
    let repo = state
        .db
        .repo_by_slug(slug)
        .await
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("{slug} isn't connected any more"))?;

    let provider = providers::for_remote(&repo.remote)
        .ok_or_else(|| format!("{slug} isn't on a host Firetower can open pull requests on"))?;

    let token = state
        .vault
        .get(
            Key::of(vault::GIT, provider.id, owner),
            &format!("opening a pull request for {}", repo.slug),
        )
        .await
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("authorize {} first", provider.label))?;

    oauth::open_pull_request(
        provider,
        &token,
        oauth::Opening {
            slug: &repo.slug,
            head,
            base,
            title,
            body,
            draft,
        },
    )
    .await
    .map_err(|e| format!("{e:#}"))
}

/// Put the links to its siblings into a pull request that is already open.
async fn link_up(
    state: &AppState,
    owner: &str,
    slug: &str,
    url: &str,
    body: &str,
) -> anyhow::Result<()> {
    let repo = state
        .db
        .repo_by_slug(slug)
        .await?
        .ok_or_else(|| anyhow::anyhow!("{slug} isn't connected"))?;
    let provider = providers::for_remote(&repo.remote)
        .ok_or_else(|| anyhow::anyhow!("no provider for {slug}"))?;
    let token = state
        .vault
        .get(
            Key::of(vault::GIT, provider.id, owner),
            "cross-linking a pull request",
        )
        .await?
        .ok_or_else(|| anyhow::anyhow!("not authorized"))?;

    oauth::amend_pull_request(provider, &token, url, body).await
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewPullRequest {
    /// Written by whoever opens it, or what the agent proposed.
    pub title: Option<String>,
    /// Falls back to what the agent proposed, then to the session's prompt.
    pub body: Option<String>,
    /// Open it as a draft.
    #[serde(default)]
    pub draft: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub url: String,
}

#[cfg(test)]
mod tests {
    use super::{asked_for, nothing_to_do, within};

    /// Ending a filtered list must end that list and nothing beside it.
    #[test]
    fn only_the_workspaces_named_are_ended() {
        let wanted = ["s_two".to_string(), "s_three".to_string()];

        assert!(!asked_for("s_one", Some(&wanted)));
        assert!(asked_for("s_two", Some(&wanted)));
        assert!(asked_for("s_three", Some(&wanted)));

        // No list at all is the whole fleet — what the button did before it
        // could be narrowed, and what an empty body still means.
        assert!(asked_for("s_one", None));

        // An empty list names nothing. Reading it as "everything" would turn a
        // press meant for a filtered-to-nothing list into ending the fleet.
        assert!(!asked_for("s_one", Some(&[])));
    }

    #[test]
    fn a_path_belongs_to_the_checkout_it_is_under() {
        // The review sheet shows workspace-relative paths, so each checkout is
        // committed with its own share of them, named from inside itself.
        assert_eq!(
            within("backend", "backend/src/main.rs").as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(within("backend", "web/app/page.tsx"), None);
        // A checkout that *is* the workspace holds everything.
        assert_eq!(within("", "README.md").as_deref(), Some("README.md"));
        // Not a prefix match on the string: `backend-2` is a different
        // repository, and committing its files into `backend` would be wrong
        // in the quietest possible way.
        assert_eq!(within("backend", "backend-2/src/main.rs"), None);
    }

    /// The asymmetry that committed nothing and said it had.
    ///
    /// `session_changes` puts a checkout's directory in front of a file only
    /// when the session holds more than one. So a single-repo session — which
    /// still has a real subdirectory on disk — sends `hello.sh`, `within`
    /// looked for `sandbox-firetower/hello.sh`, found nothing, and the commit
    /// skipped the only checkout there was. The push that followed was a
    /// no-op and the pull request came back "No commits between".
    #[test]
    fn a_single_checkout_claims_the_bare_paths_the_sheet_sends() {
        let checkout = "sandbox-firetower";
        let sent = "hello.sh";

        // What the prefix rule alone does with it: nothing.
        assert_eq!(within(checkout, sent), None);

        // What the commit handler does now, when there is exactly one place a
        // path could possibly belong.
        let single = true;
        let kept = within(checkout, sent).or_else(|| single.then(|| sent.to_string()));
        assert_eq!(kept.as_deref(), Some("hello.sh"));

        // And with two checkouts the sheet prefixes, so the prefix rule is the
        // only one that may apply — a bare path must not be swept into the
        // first checkout that happens to be looked at.
        let single = false;
        assert_eq!(
            within("backend", sent).or_else(|| single.then(|| sent.to_string())),
            None
        );
    }

    #[test]
    fn a_repository_this_change_did_not_touch_is_not_a_failure() {
        // Pushing a session that changed one of its two repositories must not
        // report the other one as broken.
        assert!(nothing_to_do("nothing to commit, working tree clean"));
        assert!(nothing_to_do("Everything up-to-date"));
        assert!(!nothing_to_do("permission denied (publickey)"));
    }
}
