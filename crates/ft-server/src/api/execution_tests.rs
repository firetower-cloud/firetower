//! API checks with a protocol-speaking worker and a real PostgreSQL database.
use super::*;
use crate::{
    transport::{Connection, Transport},
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    Extension, Json,
};
use ft_core::{Agent, Compute, Host, HostId, Readiness, Requirement};
use ft_proto::{Codec, ToServer, ToWorker, PROTOCOL_VERSION};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct Worker {
    ready: Arc<AtomicBool>,
    /// What this worker says when asked to read a remote.
    ///
    /// `None` is "that is not a repository", which is what most tests here
    /// want: they are about a host, and a repository that cannot be read is
    /// one less thing happening. A test about repositories sets it.
    probe: Option<ft_proto::RemoteInfo>,
    /// Every agent this worker was told to start, in order.
    ///
    /// The point of a protocol-speaking fake is that it can be asked what it
    /// was sent. `StartAgent` carries the skill bundles — the folders the
    /// worker writes — so a test can assert on those rather than stopping at
    /// `skill_pins` and inferring the rest.
    launched: Launches,
    /// What a launch answers with.
    ///
    /// A machine can refuse one — an `index.lock` in the worktree, a directory
    /// that is not there any more — and what the control plane does with a
    /// refusal is as much the feature as what it does with a success.
    launch_refuses: Arc<std::sync::Mutex<Option<String>>>,
    /// Every turn this worker was handed, and for which session.
    ///
    /// A child's finished work reaches its lead as an ordinary turn, so this
    /// is the only place "the lead was told" can be observed.
    turns: Turns,
    /// Frames this worker sends without being asked.
    ///
    /// Which is half of what a worker does: an agent closing, an event
    /// replayed from its own log after a reconnect. A test holds the sender,
    /// so it can make the machine say the thing the incident said.
    says: tokio::sync::broadcast::Sender<ToServer>,
}

/// What the control plane told the worker to start.
type Launches = Arc<std::sync::Mutex<Vec<ft_proto::StartAgent>>>;
/// What the control plane told the worker to say to an agent.
type Turns = Arc<std::sync::Mutex<Vec<(ft_core::SessionId, String)>>>;
#[async_trait::async_trait]
impl Transport for Worker {
    fn describe(&self) -> String {
        "readiness fixture".into()
    }
    async fn connect(&self) -> anyhow::Result<Connection> {
        let (ours, theirs) = tokio::io::duplex(65536);
        let ready = self.ready.clone();
        let probe = self.probe.clone();
        let launched = self.launched.clone();
        let launch_refuses = self.launch_refuses.clone();
        let turns = self.turns.clone();
        let mut unprompted = self.says.subscribe();
        tokio::spawn(async move {
            let (r, w) = tokio::io::split(theirs);
            let mut codec = Codec::new(r, w);
            loop {
                // Both directions, because a worker is not a request/response
                // service: the frames this feature turns on are the ones it
                // sends on its own.
                let frame = tokio::select! {
                    frame = codec.read::<ToWorker>() => match frame {
                        Ok(frame) => frame,
                        Err(_) => break,
                    },
                    said = unprompted.recv() => {
                        match said {
                            Ok(said) => {
                                if codec.write(&said).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                            // Lagged or closed: nothing a fixture can do about
                            // it, and nothing it should hide either.
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                };
                let response = match frame {
                    ToWorker::Hello { .. } => Some(ToServer::Hello {
                        protocol: PROTOCOL_VERSION,
                        worker_version: "test".into(),
                        arch: "test".into(),
                        cpus: 2,
                        memory_mb: 0,
                        docker: Default::default(),
                    }),
                    ToWorker::Ping => Some(ToServer::Pong),
                    ToWorker::CheckReadiness { req, .. } => Some(ToServer::ReadinessChecked {
                        req,
                        readiness: Readiness {
                            user: Some("editor".into()),
                            checks: vec![Requirement {
                                name: "tmux".into(),
                                available: ready.load(Ordering::SeqCst),
                                required: true,
                                detail: "fixture".into(),
                                remedy: Some("Install tmux yourself".into()),
                            }],
                        },
                    }),
                    ToWorker::ProbeAgents { req } => Some(ToServer::AgentsProbed {
                        req,
                        agents: vec![],
                    }),
                    // Answered, so a handler that launches runs to the end
                    // rather than waiting out `run_action`'s two-minute
                    // timeout. A worker that cannot be launched on is a
                    // different test from a worker that can.
                    ToWorker::RunAction { req, action, .. } => {
                        if let ft_proto::Action::StartAgent { spec } = action {
                            launched.lock().unwrap().push(*spec);
                        }
                        let refused = launch_refuses.lock().unwrap().clone();
                        Some(ToServer::ActionDone {
                            req,
                            result: match refused {
                                Some(why) => Err(why),
                                None => Ok("started".into()),
                            },
                        })
                    }
                    ToWorker::SendTurn {
                        ref session_id,
                        ref message,
                    } => {
                        turns
                            .lock()
                            .unwrap()
                            .push((session_id.clone(), message.to_string()));
                        None
                    }
                    ToWorker::ProbeRemote { req, .. } => Some(ToServer::RemoteProbed {
                        req,
                        result: match probe.clone() {
                            Some(info) => Ok(info),
                            None => Err(ft_proto::ProbeFailure::NotARepository),
                        },
                    }),
                    _ => None,
                };
                if let Some(response) = response {
                    if codec.write(&response).await.is_err() {
                        break;
                    }
                }
            }
        });
        let (r, w) = tokio::io::split(ours);
        Ok(Connection::piped(Box::new(r), Box::new(w)))
    }
}

async fn fixture() -> (
    AppState,
    crate::auth::Principal,
    Host,
    Arc<AtomicBool>,
    String,
) {
    let it = a_machine().await;
    (it.state, it.principal, it.host, it.ready, it.owner)
}

/// The same fixture, and what the worker was told to start.
///
/// Separate only so the twenty tests that do not care keep their five-element
/// tuple; there is one fixture, and this is it.
async fn watched_fixture() -> (
    AppState,
    crate::auth::Principal,
    Host,
    Arc<AtomicBool>,
    String,
    Launches,
) {
    let it = a_machine().await;
    (
        it.state,
        it.principal,
        it.host,
        it.ready,
        it.owner,
        it.launched,
    )
}

/// One machine, with every handle on it a test might pull.
///
/// The two tuples above are views of this; anything that needs the machine to
/// *say* something — an agent gone, an event replayed — takes the whole thing.
struct Machine {
    state: AppState,
    principal: crate::auth::Principal,
    host: Host,
    ready: Arc<AtomicBool>,
    owner: String,
    launched: Launches,
    /// Every turn an agent on it was handed.
    turns: Turns,
    /// What the worker sends of its own accord.
    says: tokio::sync::broadcast::Sender<ToServer>,
    /// Set it, and every launch is refused with this reason.
    launch_refuses: Arc<std::sync::Mutex<Option<String>>>,
}

async fn a_machine() -> Machine {
    let (db, owner) = crate::db::Db::open_for_test_owned().await.unwrap();
    let accounts = crate::accounts::Accounts::new(db.pool().clone());
    let principal = crate::auth::Principal {
        subject: "admin".into(),
        via: crate::auth::Via::Session,
        user: accounts.user_by_name("admin").await.unwrap(),
    };
    let host = db.ensure_host("native", native(), &owner).await.unwrap();
    let ready = Arc::new(AtomicBool::new(false));
    let launched: Launches = Default::default();
    let turns: Turns = Default::default();
    let says = tokio::sync::broadcast::Sender::new(16);
    let launch_refuses: Arc<std::sync::Mutex<Option<String>>> = Default::default();
    let fleet = crate::fleet::Fleet::new(db.clone());
    fleet
        .supervise(
            host.id.clone(),
            Arc::new(Worker {
                ready: ready.clone(),
                probe: None,
                launched: launched.clone(),
                turns: turns.clone(),
                says: says.clone(),
                launch_refuses: launch_refuses.clone(),
            }),
        )
        .await;
    let vault = Arc::new(crate::vault::Vault::new(
        db.pool().clone(),
        crate::vault::crypto::RootKey::generate(),
    ));
    let names = crate::preview::Names::from_vault(&vault);
    let connections = crate::providers::Connections::opened(db.pool().clone())
        .await
        .unwrap();
    let state = AppState {
        updates: crate::updates::Updates::new(db.pool().clone()),
        policy: crate::auth::Policy::open(),
        access: crate::access::Access::new(db.pool().clone()),
        skills: crate::skills::Skills::new(db.pool().clone()),
        roles: crate::roles::Roles::new(db.pool().clone()),
        connections,
        db,
        accounts,
        fleet,
        vault,
        names,
        key_source: "test".into(),
        home: std::env::temp_dir(),
        pending: Default::default(),
        renewals: Default::default(),
        forwards: Default::default(),
        previews: Default::default(),
        public_url: "http://localhost".into(),
    };
    Machine {
        state,
        principal,
        host,
        ready,
        owner,
        launched,
        turns,
        says,
        launch_refuses,
    }
}

fn native() -> Compute {
    Compute::Server {
        host: "vm".into(),
        user: Some("editor".into()),
        port: None,
        key: ft_core::SshKey::Default,
        host_key: None,
    }
}

#[tokio::test]
async fn launch_is_rejected_before_creating_a_workspace_when_requirements_are_missing() {
    let (state, principal, host, _, _) = fixture().await;
    let req = serde_json::from_value(
        serde_json::json!({ "name": "test", "agent": "ClaudeCode", "hostId": host.id }),
    )
    .unwrap();
    let error = sessions::create_session(State(state.clone()), Extension(principal), Json(req))
        .await
        .unwrap_err();
    assert!(error.message.contains("tmux"), "{}", error.message);
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(count, 0);
    state.fleet.stop_supervising(&host.id).await;
}

#[tokio::test]
async fn recheck_observes_manual_repairs_and_reports_the_execution_account() {
    let (state, principal, host, ready, _) = fixture().await;
    let read = || {
        hosts::host_readiness(
            State(state.clone()),
            Extension(principal.clone()),
            Path(host.id.to_string()),
            Query(hosts::ReadinessQuery {
                agent: Some(Agent::ClaudeCode),
            }),
        )
    };
    let first = read().await.unwrap().0;
    assert!(!first.ready());
    assert_eq!(first.user.as_deref(), Some("editor"));
    ready.store(true, Ordering::SeqCst);
    assert!(read().await.unwrap().0.ready());
    state.fleet.stop_supervising(&host.id).await;
}

#[tokio::test]
async fn missing_native_worker_has_native_setup_instructions_and_stays_unready() {
    let (state, principal, host, _, _) = fixture().await;
    state.fleet.stop_supervising(&host.id).await;
    let report = hosts::host_readiness(
        State(state),
        Extension(principal),
        Path(host.id.to_string()),
        Query(hosts::ReadinessQuery { agent: None }),
    )
    .await
    .unwrap()
    .0;
    assert!(!report.ready());
    // Two rows: whether ssh got in, and whether a worker is there. With no
    // diagnosis yet, ssh has not been seen to get in, so the worker is not a
    // question yet.
    let names: Vec<&str> = report.checks.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, vec!["SSH", "Worker"]);
    let worker = report.checks.iter().find(|c| c.name == "Worker").unwrap();
    assert!(!worker.available);
    assert!(!worker.required, "not asked until ssh gets in");
}

/// The machine Firetower used to run everything on is still in `hosts` — the
/// sessions that ran in that container are the record of it — and it is in no
/// list, so nothing can put work there by either route.
#[tokio::test]
async fn a_retired_machine_is_readable_and_unreachable() {
    let (state, principal, host, _ready, owner) = fixture().await;
    let retired = state
        .db
        .ensure_host("localhost", Compute::Local, &owner)
        .await
        .unwrap();

    // Readable, which is the whole reason the kind still decodes: this is what
    // resolves the machine of a session that ran there.
    assert!(
        state.db.host_by_id(&retired.id).await.unwrap().is_some(),
        "a session that ran there has to still open"
    );

    // And in no list: not the fleet's, and not the one every picker is drawn
    // from.
    assert!(
        !state
            .db
            .hosts()
            .await
            .unwrap()
            .iter()
            .any(|h| h.id == retired.id),
        "nothing supervises or sweeps it"
    );
    let Json(listed) = hosts::list_hosts(State(state.clone()), Extension(principal.clone()))
        .await
        .unwrap();
    assert!(
        !listed.iter().any(|h| h.id == retired.id),
        "and no picker offers it"
    );
    assert!(
        listed.iter().any(|h| h.id == host.id),
        "while the machines somebody added are all there"
    );

    // And one place says it existed, so the sessions that ran there can be
    // found from the screen the row used to be on.
    let Json(gone) = hosts::retired_hosts(State(state.clone()), Extension(principal.clone()))
        .await
        .unwrap();
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].name, "localhost");
    assert_eq!(gone[0].id, retired.id);

    // Naming it is the same answer as naming a machine that does not exist,
    // which is what it is now.
    let req = serde_json::from_value(
        serde_json::json!({ "name": "t", "agent": "ClaudeCode", "hostId": retired.id }),
    )
    .unwrap();
    let error = sessions::create_session(State(state.clone()), Extension(principal), Json(req))
        .await
        .unwrap_err();
    assert!(
        error.message.contains("no host is available"),
        "{}",
        error.message
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// The record of what ran in that container, against the one thing that would
/// delete it.
///
/// The sessions on the retired machine are left as they are, deliberately.
/// Ending them — in the migration, at start-up, anywhere — would make
/// `Db::workspaces_to_purge` select their workspaces, and `reclaim::sweep`
/// purges a workspace by deleting it: the cascade takes the sessions and with
/// them `agent_lines`, the agent's raw log, which is the evidence of what
/// happened in that container. The sweep runs every sixty seconds and needs no
/// host, so that deletion would happen within a minute of deploying and could
/// not be undone.
#[tokio::test]
async fn what_ran_on_the_retired_machine_survives_the_reclaim_sweep() {
    let (state, _principal, host, _ready, owner) = fixture().await;
    let retired = state
        .db
        .ensure_host("localhost", Compute::Local, &owner)
        .await
        .unwrap();

    let session = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &session,
            &retired.id,
            &owner,
            Some("acme/backend"),
            "What it was doing to the database",
            "do a thing",
            Some("agent/x"),
            Some("main"),
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &ft_core::Step::plan(true, false),
            None,
        )
        .await
        .unwrap();
    state
        .db
        .record_agent_line(&session, 1, r#"{"type":"assistant"}"#)
        .await
        .unwrap();

    // The migration, exactly as it ships.
    sqlx::raw_sql(include_str!(
        "../../../../migrations/server/20261106120000_retire_local_host.sql"
    ))
    .execute(state.db.pool())
    .await
    .unwrap();

    assert!(
        state.db.workspaces_to_purge(10).await.unwrap().is_empty(),
        "a session that has not ended is not a workspace to reclaim"
    );
    assert_eq!(
        crate::reclaim::sweep(&state).await.unwrap(),
        0,
        "and a pass of the sweep takes nothing"
    );

    assert!(
        state.db.session(&session).await.unwrap().is_some(),
        "the session is still there to open"
    );
    let lines: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_lines WHERE session_id = $1")
        .bind(session.as_str())
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(lines, 1, "and so is what the agent actually said");

    state.fleet.stop_supervising(&host.id).await;
}

/// A fresh install, and the one an upgrade leaves behind: nothing in the fleet
/// but the machine that was removed. The refusal has to send somebody to add
/// one rather than describe a machine that is not coming back.
#[tokio::test]
async fn an_empty_fleet_refuses_the_work_and_says_what_is_missing() {
    let (state, principal, host, _ready, owner) = fixture().await;
    state.fleet.stop_supervising(&host.id).await;
    state.db.delete_host(&host.id).await.unwrap();
    state
        .db
        .ensure_host("localhost", Compute::Local, &owner)
        .await
        .unwrap();

    let req =
        serde_json::from_value(serde_json::json!({ "name": "t", "agent": "ClaudeCode" })).unwrap();
    let error = sessions::create_session(State(state.clone()), Extension(principal), Json(req))
        .await
        .unwrap_err();
    assert!(
        error.message.contains("No machine is connected yet"),
        "{}",
        error.message
    );

    let workspaces: i64 = sqlx::query_scalar("SELECT count(*) FROM workspaces")
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    assert_eq!(workspaces, 0, "and nothing was started anyway");
}

/// Adding or probing a machine whose address is an ssh option.
///
/// `-oProxyCommand=…` reaches ssh as an option rather than a destination, and
/// ssh runs it through a shell — here, in the control plane's container, as
/// the control plane. Both doors are shut, and nothing runs on the way past.
#[tokio::test]
async fn an_address_that_is_an_ssh_option_is_refused_at_the_api() {
    let (state, principal, host, _ready, _owner) = fixture().await;
    let dir = tempfile::tempdir().unwrap();
    let proof = dir.path().join("pwned");
    let payload = serde_json::json!({
        "compute": {
            "type": "Server",
            "host": format!("-oProxyCommand=touch {}", proof.display()),
            "key": { "type": "Default" },
        },
    });
    // The account as well, because the destination is assembled from both.
    let as_the_account = serde_json::json!({
        "compute": {
            "type": "Server",
            "host": "fire-01",
            "user": format!("-oProxyCommand=touch {}", proof.display()),
            "key": { "type": "Default" },
        },
    });

    let created = hosts::create_host(
        State(state.clone()),
        Extension(principal.clone()),
        Json(serde_json::from_value(payload.clone()).unwrap()),
    )
    .await
    .unwrap_err();
    assert!(matches!(created.code, ErrorCode::InvalidRequest));

    let probed = hosts::probe_host(
        State(state.clone()),
        Json(serde_json::from_value(payload).unwrap()),
    )
    .await
    .unwrap_err();
    assert!(matches!(probed.code, ErrorCode::InvalidRequest));

    for door in [
        hosts::create_host(
            State(state.clone()),
            Extension(principal.clone()),
            Json(serde_json::from_value(as_the_account.clone()).unwrap()),
        )
        .await
        .map(|_| ())
        .unwrap_err(),
        hosts::probe_host(
            State(state.clone()),
            Json(serde_json::from_value(as_the_account).unwrap()),
        )
        .await
        .map(|_| ())
        .unwrap_err(),
    ] {
        assert!(
            matches!(door.code, ErrorCode::InvalidRequest),
            "{}",
            door.message
        );
    }

    assert!(!proof.exists(), "nothing was run");
    let Json(listed) = hosts::list_hosts(State(state.clone()), Extension(principal))
        .await
        .unwrap();
    assert_eq!(listed.len(), 1, "and nothing was written down");

    state.fleet.stop_supervising(&host.id).await;
}

/// Firetower refuses to be a machine in its own fleet, on both doors.
#[tokio::test]
async fn firetower_refuses_to_add_itself() {
    let (state, principal, host, _ready, _owner) = fixture().await;
    let payload = serde_json::json!({ "compute": { "type": "Local" } });

    let created = hosts::create_host(
        State(state.clone()),
        Extension(principal),
        Json(serde_json::from_value(payload.clone()).unwrap()),
    )
    .await
    .unwrap_err();
    assert!(matches!(created.code, ErrorCode::InvalidRequest));
    assert!(
        created.message.contains("does not run agents on itself"),
        "{}",
        created.message
    );

    let probed = hosts::probe_host(
        State(state.clone()),
        Json(serde_json::from_value(payload).unwrap()),
    )
    .await
    .unwrap_err();
    assert!(matches!(probed.code, ErrorCode::InvalidRequest));

    state.fleet.stop_supervising(&host.id).await;
}

#[tokio::test]
async fn connecting_a_host_path_defers_validation_to_the_execution_machine() {
    let (state, principal, host, ready, owner) = fixture().await;
    let local = state
        .db
        .ensure_test_host("localhost", &owner)
        .await
        .unwrap();
    state
        .fleet
        .supervise(
            local.id.clone(),
            Arc::new(Worker {
                ready,
                probe: None,
                launched: Default::default(),
                turns: Default::default(),
                says: tokio::sync::broadcast::Sender::new(1),
                launch_refuses: Default::default(),
            }),
        )
        .await;
    let remote = "/home/editor/media-app";
    // The local worker would reject this repository; it exists only on the VM
    // that will be chosen at launch, so querying the control plane is wrong.
    let (_, Json(repo)) = repos::create_repo(
        State(state.clone()),
        Extension(principal),
        Json(repos::NewRepo {
            provider: None,
            slug: "media-app".into(),
            remote: remote.into(),
            setup: None,
            default_branch: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(repo.remote, remote);
    assert_eq!(repo.default_branch, None);
    state.fleet.stop_supervising(&local.id).await;
    state.fleet.stop_supervising(&host.id).await;
}

#[tokio::test]
async fn workspace_keeps_its_environment_and_refuses_a_different_host_on_resume() {
    let (state, principal, host, _, owner) = fixture().await;
    sqlx::query("UPDATE hosts SET machine = 'local' WHERE id = $1")
        .bind(host.id.as_str())
        .execute(state.db.pool())
        .await
        .unwrap();
    let id = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &id,
            &host.id,
            &owner,
            None,
            "test",
            "",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
    let saved = state.db.session(&id).await.unwrap().unwrap();
    assert_eq!(saved.host_id, host.id);
    let saved_host = state.db.host_by_id(&saved.host_id).await.unwrap().unwrap();
    assert_eq!(saved_host.machine.as_deref(), Some("local"));
    assert_eq!(saved_host.compute, native());
    let req = serde_json::from_value(serde_json::json!({ "workspaceId": saved.workspace_id, "agent": "ClaudeCode", "hostId": HostId::new() })).unwrap();
    let error = sessions::create_session(State(state.clone()), Extension(principal), Json(req))
        .await
        .unwrap_err();
    assert!(
        error.message.contains("keeps its execution environment"),
        "{}",
        error.message
    );
    state.fleet.stop_supervising(&host.id).await;
}

#[test]
fn both_machine_locations_use_the_ssh_transport() {
    for same_machine in [false, true] {
        let host: Host = serde_json::from_value(serde_json::json!({
            "id": "h_transport", "name": "video", "state": "Online", "compute": native(),
            "path": "u/editor/video",
            "machine": if same_machine { Some("local") } else { None },
        }))
        .unwrap();
        let transport =
            crate::fleet::Fleet::transport_for(&host, std::path::Path::new("/tmp"), None).unwrap();
        assert_eq!(transport.describe(), "ssh editor@vm");
    }
}

/// What a grant to *look* at somebody's work does not include.
///
/// Every one of these was reachable by a viewer. Answering a permission prompt
/// is the worst of them — the agent stops and asks before doing something it
/// thinks is dangerous, and whoever answers decides what runs on the owner's
/// machine. Interrupting stops their work; choosing a model picks how much of
/// their subscription the next turn spends; committing, pushing and opening a
/// pull request all act on the world outside using the owner's identity.
///
/// Called through the handlers rather than through `Db`, because the gap was
/// never in the database: `session_to_work_in` has always refused a viewer.
/// The handlers simply asked the other question.
#[tokio::test]
async fn a_viewer_may_look_and_may_not_steer() {
    let (state, owner_principal, host, _ready, owner) = fixture().await;

    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let bob = state
        .accounts
        .create_user(&org, "bob", "bob@example.test", "member")
        .await
        .unwrap()
        .0;
    let viewer = crate::auth::Principal {
        subject: "bob".into(),
        via: crate::auth::Via::Session,
        user: Some(bob.clone()),
    };

    let id = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &id,
            &host.id,
            &owner,
            None,
            "Mine",
            "do a thing",
            Some("agent/x"),
            Some("main"),
            "Shell",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &ft_core::Step::plan(true, false),
            None,
        )
        .await
        .unwrap();

    // Shared as a viewer, by name, on the workspace itself.
    let workspace = state
        .db
        .session(&id)
        .await
        .unwrap()
        .unwrap()
        .workspace_id
        .unwrap();
    state
        .access
        .set_exception(
            crate::access::FiledKind::Workspace,
            workspace.as_str(),
            bob.id.as_str(),
            crate::access::Level::Viewer,
        )
        .await
        .unwrap();

    // He can see it. That is what was shared.
    assert!(
        state
            .db
            .session_of(bob.id.as_str(), &id)
            .await
            .unwrap()
            .is_some(),
        "a viewer can read the session"
    );

    let refused = |label: &str, out: ApiResult<()>| match out {
        Err(e) => assert!(
            matches!(e.code, ErrorCode::NotFound),
            "{label} refused a viewer, but with {:?} rather than NotFound — what \
             somebody may not touch, they are not told is there",
            e.code
        ),
        Ok(()) => panic!("{label} let a viewer through"),
    };

    refused(
        "answering a permission prompt",
        super::conversation::answer_request(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({
                    "req": "r_1",
                    "decision": { "decision": "Allow" }
                }))
                .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "interrupting the agent",
        super::conversation::interrupt_session(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "choosing the model",
        super::conversation::choose_control(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({
                    "kind": "model",
                    "value": "something-expensive"
                }))
                .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "pushing the branch",
        super::sessions::push_session(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            None,
        )
        .await
        .map(|_| ()),
    );

    refused(
        "committing",
        super::sessions::commit_session(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({ "message": "theirs, signed by them" }))
                    .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "opening a pull request",
        super::sessions::open_pull_request(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(
                    serde_json::json!({ "title": "x", "body": "y", "draft": false }),
                )
                .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "attaching another repository",
        super::sessions::add_repo(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({ "repoId": "r_1", "branch": null }))
                    .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "sending preview notes",
        super::annotations::send_annotations(
            State(state.clone()),
            Extension(viewer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({
                    "notes": [{ "id": "a_1", "revision": 1 }]
                }))
                .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    // And the owner is unaffected: the same call, by the person whose work it
    // is, gets past the gate and fails later on the fixture's worker.
    let mine = super::conversation::interrupt_session(
        State(state.clone()),
        Extension(owner_principal),
        Path(id.as_str().to_string()),
    )
    .await;
    assert!(
        !matches!(mine, Err(ref e) if matches!(e.code, ErrorCode::NotFound)),
        "the owner is not refused their own session"
    );
}

/// Writer on the room is not writer on the conversation.
///
/// This is the one that is easy to get wrong, because every session-level
/// permission used to be read off the workspace. A colleague given writer
/// could type into somebody's agent — which runs on *their* subscription — and
/// push the branch with *their* git token, under their name. Sharing a place
/// was never meant to hand over an account.
///
/// What a writer may do instead is start their own agent beside it, which is a
/// second session with their own credentials in it. That path is untouched.
#[tokio::test]
async fn a_writer_may_work_in_the_place_and_not_speak_for_its_owner() {
    let (state, _owner_principal, host, _ready, owner) = fixture().await;

    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let kevin = state
        .accounts
        .create_user(&org, "kevin", "kevin@example.test", "member")
        .await
        .unwrap()
        .0;
    let writer = crate::auth::Principal {
        subject: "kevin".into(),
        via: crate::auth::Via::Session,
        user: Some(kevin.clone()),
    };

    let id = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &id,
            &host.id,
            &owner,
            None,
            "Mine",
            "do a thing",
            Some("agent/x"),
            Some("main"),
            "Shell",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &ft_core::Step::plan(true, false),
            None,
        )
        .await
        .unwrap();

    let workspace = state
        .db
        .session(&id)
        .await
        .unwrap()
        .unwrap()
        .workspace_id
        .unwrap();

    // Writer on the workspace, by name. The most access anybody short of the
    // owner can be given.
    state
        .access
        .set_exception(
            crate::access::FiledKind::Workspace,
            workspace.as_str(),
            kevin.id.as_str(),
            crate::access::Level::Writer,
        )
        .await
        .unwrap();

    // He may work here — that is what the grant said.
    let seen = state
        .db
        .session_to_work_in(kevin.id.as_str(), &id)
        .await
        .unwrap()
        .expect("writer on the workspace");
    assert!(seen.may_write, "the place is his to work in");
    assert!(!seen.may_speak, "the conversation is not his to speak in");

    assert!(
        state
            .db
            .session_to_speak_in(kevin.id.as_str(), &id)
            .await
            .unwrap()
            .is_none(),
        "and the predicate that enforces it agrees"
    );

    let refused = |label: &str, out: ApiResult<()>| match out {
        Err(e) => assert!(
            matches!(e.code, ErrorCode::NotFound),
            "{label} refused a writer, but with {:?}",
            e.code
        ),
        Ok(()) => panic!("{label} let a writer speak for the owner"),
    };

    refused(
        "sending a turn",
        super::conversation::send_turn(
            State(state.clone()),
            Extension(writer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({ "text": "do as I say", "images": [] }))
                    .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "answering a permission prompt",
        super::conversation::answer_request(
            State(state.clone()),
            Extension(writer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({
                    "req": "r_1", "decision": { "decision": "Allow" }
                }))
                .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "choosing the model, which spends their subscription",
        super::conversation::choose_control(
            State(state.clone()),
            Extension(writer.clone()),
            Path(id.as_str().to_string()),
            Json(
                serde_json::from_value(serde_json::json!({
                    "kind": "model", "value": "something-expensive"
                }))
                .unwrap(),
            ),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "pushing with their git token",
        super::sessions::push_session(
            State(state.clone()),
            Extension(writer.clone()),
            Path(id.as_str().to_string()),
            None,
        )
        .await
        .map(|_| ()),
    );

    // Ending the workspace is disposal, and this workspace sits in the
    // administrator's own space — so it is not a writer's to end.
    refused(
        "ending the whole workspace",
        super::sessions::destroy_session(
            State(state.clone()),
            Extension(writer.clone()),
            Path(id.as_str().to_string()),
            axum::extract::Query(Default::default()),
        )
        .await
        .map(|_| ())
        .map_err(|e| ApiError::new(ErrorCode::NotFound, e.message)),
    );
}

/// Ending an agent ends that agent, including the one that is also the place.
///
/// A workspace is named by the session that cut it, so that session's id is
/// also the workspace's id. The control plane used to read that coincidence as
/// an instruction and take every sibling down with it — so the person who
/// started a workspace could not finish their own first agent without ending
/// everybody's work, and in a directory they did not administer, could not end
/// it at all.
///
/// The worker has always known when a place is finished: "the worktree belongs
/// to the workspace, not to this agent — the last agent out reclaims it". So a
/// single teardown was already safe; what was wrong was the control plane
/// pre-empting it.
#[tokio::test]
async fn ending_the_first_agent_leaves_the_others_running() {
    let (state, principal, host, _ready, owner) = fixture().await;

    let first = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &first,
            &host.id,
            &owner,
            None,
            "The one that cut it",
            "do a thing",
            Some("agent/x"),
            Some("main"),
            "Shell",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &ft_core::Step::plan(true, false),
            None,
        )
        .await
        .unwrap();

    let workspace = state
        .db
        .session(&first)
        .await
        .unwrap()
        .unwrap()
        .workspace_id
        .unwrap();
    assert_eq!(
        workspace.as_str(),
        first.as_str(),
        "the workspace is named by the session that cut it"
    );

    let second = ft_core::SessionId::new();
    state
        .db
        .insert_run(crate::db::NewRun {
            id: &second,
            workspace_id: &workspace,
            owner: &owner,
            title: "The one that joined",
            prompt: "and another thing",
            agent: "Shell",
            steps: &ft_core::Step::plan(true, false),
        })
        .await
        .unwrap();

    // Ending the first one, without asking for the workspace.
    super::sessions::destroy_session(
        State(state.clone()),
        Extension(principal.clone()),
        Path(first.as_str().to_string()),
        axum::extract::Query(Default::default()),
    )
    .await
    .expect("its owner may end their own agent");

    let left = state.db.live_sessions(&owner).await.unwrap();
    assert!(
        left.iter().any(|s| s.id.as_str() == second.as_str()),
        "the agent that joined is still running"
    );
}

/// A machine is somebody's, and the endpoints that act on one now know it.
///
/// Eight of the ten handlers in `hosts.rs` took no principal at all. A machine
/// became personal when paths arrived — `u/<whoever added it>/…` — and these
/// did not notice, so any member could rename, drain, forget or install onto
/// any machine in the organisation, including a colleague's own.
#[tokio::test]
async fn a_machine_is_not_every_members_to_change() {
    let (state, _principal, host, _ready, _owner) = fixture().await;

    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    let member = crate::auth::Principal {
        subject: "ana".into(),
        via: crate::auth::Via::Session,
        user: Some(ana.clone()),
    };

    // The fixture's machine was added by the administrator, so it is filed in
    // their own space and nobody else's to touch.
    let refused = |label: &str, out: ApiResult<()>| match out {
        Err(e) => assert!(
            matches!(e.code, ErrorCode::Forbidden | ErrorCode::NotFound),
            "{label} refused a member, but with {:?}",
            e.code
        ),
        Ok(()) => panic!("{label} let a member change somebody else's machine"),
    };

    refused(
        "renaming it",
        super::hosts::rename_host(
            State(state.clone()),
            Extension(member.clone()),
            Path(host.id.as_str().to_string()),
            Json(serde_json::from_value(serde_json::json!({ "name": "mine now" })).unwrap()),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "draining it",
        super::hosts::drain_host(
            State(state.clone()),
            Extension(member.clone()),
            Path(host.id.as_str().to_string()),
            Json(serde_json::from_value(serde_json::json!({ "drained": true })).unwrap()),
        )
        .await
        .map(|_| ()),
    );

    refused(
        "forgetting it",
        super::hosts::delete_host(
            State(state.clone()),
            Extension(member.clone()),
            Path(host.id.as_str().to_string()),
            axum::extract::Query(super::hosts::Removal { force: false }),
        )
        .await
        .map(|_| ()),
    );

    // And it is not even in their list, which is what `list_hosts` has always
    // said. The two answers have to agree.
    let seen = super::hosts::list_hosts(State(state.clone()), Extension(member))
        .await
        .unwrap();
    assert!(
        seen.0.is_empty(),
        "a member sees none of the administrator's machines"
    );
}

/// Updating an agent on a machine is the machine's question, not the agent's.
///
/// `update_agent` moves every host that is behind onto the published version.
/// Read as "every host in the organisation" it would let one member reinstall
/// Claude Code under a colleague's running sessions — the same hole
/// [`a_machine_is_not_every_members_to_change`] closed for renaming and
/// draining, arriving by a different door.
///
/// What the screen is told and what the endpoint does come from one predicate,
/// so this pins the flag: a button offered to somebody the action would skip is
/// the failure worth catching.
#[tokio::test]
async fn an_agent_is_only_updated_on_machines_somebody_administers() {
    let (state, owner_principal, host, _ready, _owner) = fixture().await;

    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    let member = crate::auth::Principal {
        subject: "ana".into(),
        via: crate::auth::Via::Session,
        user: Some(ana.clone()),
    };

    // Installed, and behind: the pair that puts a button on the row.
    state
        .db
        .record_presence(
            &host.id,
            &[ft_core::AgentPresence {
                kind: Agent::ClaudeCode,
                installed: true,
                version: Some("2.1.273 (Claude Code)".into()),
                logged_in: Some(true),
                account: None,
            }],
        )
        .await
        .unwrap();

    let claude = |views: Vec<super::agents::AgentView>| {
        views
            .into_iter()
            .find(|v| v.kind == Agent::ClaudeCode)
            .expect("Claude Code is always listed")
    };

    // The fixture's machine was added by the administrator, so it sits in their
    // own space. Ana may be told it is stale; it is not hers to move.
    let hers = claude(
        super::agents::list_agents(State(state.clone()), Extension(member.clone()))
            .await
            .unwrap()
            .0,
    );
    let row = hers
        .hosts
        .iter()
        .find(|h| h.host_id == host.id.as_str())
        .expect("she can see the machine exists");
    assert!(
        !row.may_update,
        "a member was offered an update on somebody else's machine"
    );

    // And its owner is offered it, or the flag would be saying no to everybody.
    let theirs = claude(
        super::agents::list_agents(State(state.clone()), Extension(owner_principal))
            .await
            .unwrap()
            .0,
    );
    let row = theirs
        .hosts
        .iter()
        .find(|h| h.host_id == host.id.as_str())
        .expect("their own machine");
    assert!(
        row.may_update,
        "the machine's owner was refused their own machine"
    );

    // And the per-host button behind the same flag, or the fleet-wide gate is
    // decoration: both fetch the same binary onto the same machine.
    match super::agents::install_agent(
        State(state.clone()),
        Extension(member),
        Path("ClaudeCode".to_string()),
        Json(serde_json::from_value(serde_json::json!({ "hostId": host.id.as_str() })).unwrap()),
    )
    .await
    {
        Err(e) => assert!(
            matches!(e.code, ErrorCode::Forbidden | ErrorCode::NotFound),
            "installing onto somebody else's machine was refused, but with {:?}",
            e.code
        ),
        Ok(_) => panic!("a member installed an agent onto somebody else's machine"),
    }
}

/// A repository with no commits in it.
///
/// Connecting one was refused outright — "has no commits yet, so there's
/// nothing to branch from" — so no row was ever written and it never appeared
/// in the list. That is the repository somebody most wants to put an agent on:
/// they have just made it, and the agent is what will fill it.
#[tokio::test]
async fn an_empty_repository_is_connected_rather_than_refused() {
    let (state, principal, host, ready, _owner) = fixture().await;
    // The fixture's own machine, answering the probe. One host rather than a
    // second one beside it: a probe is answered by whichever machine is up, so
    // a test about the answer needs exactly one that is.
    state.fleet.stop_supervising(&host.id).await;
    state
        .fleet
        .supervise(
            host.id.clone(),
            Arc::new(Worker {
                ready,
                // What `ls-remote` answers for a repository nobody has pushed
                // to: no refs at all, and so no name for the trunk either —
                // the `main` here is the worker's own fallback, not a fact.
                probe: Some(ft_proto::RemoteInfo {
                    default_branch: "main".into(),
                    branches: vec![],
                    empty: true,
                }),
                launched: Default::default(),
                turns: Default::default(),
                says: tokio::sync::broadcast::Sender::new(1),
                launch_refuses: Default::default(),
            }),
        )
        .await;

    let remote = "https://example.invalid/acme/fresh.git";
    let Json(probed) = repos::probe_repo(
        State(state.clone()),
        Extension(principal.clone()),
        Json(repos::ProbeRequest {
            remote: remote.into(),
        }),
    )
    .await
    .expect("an empty repository is a state to report, not an error");
    assert!(
        probed.empty,
        "and the form is told so it can say what happens"
    );

    let (status, Json(repo)) = repos::create_repo(
        State(state.clone()),
        Extension(principal.clone()),
        Json(repos::NewRepo {
            provider: None,
            slug: "acme/fresh".into(),
            remote: remote.into(),
            setup: None,
            // The host's own API knows what the trunk will be called even when
            // the remote cannot say. The picker sends it for this case alone.
            default_branch: Some("trunk".into()),
        }),
    )
    .await
    .unwrap();

    assert_eq!(status, axum::http::StatusCode::CREATED);
    assert_eq!(
        repo.default_branch.as_deref(),
        Some("trunk"),
        "the name the host gave, not the probe's guess at main"
    );

    // The symptom, from the screen's point of view.
    let Json(listed) = repos::list_repos(State(state.clone()), Extension(principal))
        .await
        .unwrap();
    assert!(
        listed.iter().any(|r| r.slug == "acme/fresh"),
        "a connected repository is in the list"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A second agent in a profile's workspace is that profile; a delegated child
/// in the same workspace is not.
///
/// The first half is what went wrong in the field: an agent added to an
/// Orchestrator's workspace came up with no profile and no persona, could not
/// delegate, and said nothing about why — which reads as the profile having
/// stopped working rather than as a run that was never given one.
///
/// The second half is what must not happen now: a child's instructions are in
/// its brief already, and the lead's persona on top of them would tell it that
/// it is the lead.
#[tokio::test]
async fn a_second_agent_takes_the_workspaces_profile_and_a_child_does_not() {
    let (state, _principal, host, _ready, owner) = fixture().await;
    let org = state.db.org().await.unwrap();
    let slug = state.access.personal_root(&owner).await.unwrap();
    let new: crate::roles::NewRole = serde_json::from_value(serde_json::json!({
        "name": "Orchestrator",
        "does": "Leads a feature end to end",
        "placement": "here",
        "instructions": "Scope it, hand it out, say when it is ready.",
        "canDelegate": true,
    }))
    .unwrap();
    let profile = state.roles.create(&org, &owner, &slug, &new).await.unwrap();

    let lead = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &lead,
            &host.id,
            &owner,
            None,
            "The one that cut it",
            "do a thing",
            Some("agent/x"),
            Some("main"),
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &ft_core::Step::plan(true, false),
            None,
        )
        .await
        .unwrap();
    state.db.set_profile(&lead, profile.as_str()).await.unwrap();
    let workspace = state
        .db
        .session(&lead)
        .await
        .unwrap()
        .unwrap()
        .workspace_id
        .unwrap();

    let taken = super::sessions::profile_for_run(&state, &owner, &workspace, None, false)
        .await
        .unwrap();
    assert_eq!(
        taken.map(|p| p.name).as_deref(),
        Some("Orchestrator"),
        "an agent added by hand is the workspace's profile"
    );

    let child = super::sessions::profile_for_run(&state, &owner, &workspace, None, true)
        .await
        .unwrap();
    assert!(
        child.is_none(),
        "a delegated child carries its brief, not the lead's persona"
    );
}

// ── What a workspace's `gh` is handed ───────────────────────────────────
//
// `gh_vars` is checked without a database in `sessions::gh_tests`. These are
// the three lookups in front of it, which that test cannot reach and which are
// where this would go wrong in a way nobody would notice until a workspace
// started: that a remote finds its connection, that the connection's *kind*
// decides whether `gh` is handed anything at all, and that the token comes
// back out of the vault under the right person's name.

/// Both shapes of remote, because `host_of` parses them differently and only
/// one of them is what a clone URL copied out of GitHub looks like.
#[tokio::test]
async fn a_github_remote_is_handed_its_vault_token() {
    let (state, _, _, _, owner) = fixture().await;
    state
        .vault
        .put(
            crate::vault::Key::of(crate::vault::GIT, "github", &owner),
            "gho_from_the_vault",
            "test",
        )
        .await
        .unwrap();

    for remote in [
        "git@github.com:acme/backend.git",
        "https://github.com/acme/backend.git",
    ] {
        let env = super::sessions::gh_env(&state, remote, &owner, "test").await;

        assert_eq!(
            env,
            [("GH_TOKEN".to_string(), "gho_from_the_vault".to_string())],
            "{remote}"
        );
    }
}

/// The kind gate, against a real GitLab row rather than a string. A GitLab
/// token in `GH_TOKEN` authenticates nothing and blames GitHub for it.
#[tokio::test]
async fn a_gitlab_remote_is_handed_nothing_even_holding_a_token() {
    let (state, _, _, _, owner) = fixture().await;
    state
        .vault
        .put(
            crate::vault::Key::of(crate::vault::GIT, "gitlab", &owner),
            "glpat_from_the_vault",
            "test",
        )
        .await
        .unwrap();

    let env =
        super::sessions::gh_env(&state, "git@gitlab.com:acme/backend.git", &owner, "test").await;

    assert!(env.is_empty(), "{env:?}");
}

/// Holding nothing is not an error — it is a workspace whose `gh` is no worse
/// off than it was before any of this existed.
#[tokio::test]
async fn holding_no_token_hands_nothing_over() {
    let (state, _, _, _, owner) = fixture().await;

    let env =
        super::sessions::gh_env(&state, "git@github.com:acme/backend.git", &owner, "test").await;

    assert!(env.is_empty(), "{env:?}");
}

/// A remote on a host nobody connected resolves to no connection at all, which
/// is the ordinary case for a local path or somebody's private git server.
#[tokio::test]
async fn a_remote_on_no_connected_host_hands_nothing_over() {
    let (state, _, _, _, owner) = fixture().await;

    let env =
        super::sessions::gh_env(&state, "git@git.example.invalid:acme/x.git", &owner, "test").await;

    assert!(env.is_empty(), "{env:?}");
}

/// The vault is per person, and so is this. Handing one person's token to
/// another person's session is the failure the vault's own key shape exists to
/// prevent, so it is worth asserting on the way out as well as on the way in.
#[tokio::test]
async fn one_persons_token_is_not_handed_to_another() {
    let (state, _, _, _, owner) = fixture().await;
    state
        .vault
        .put(
            crate::vault::Key::of(crate::vault::GIT, "github", &owner),
            "gho_mine",
            "test",
        )
        .await
        .unwrap();

    let env = super::sessions::gh_env(
        &state,
        "git@github.com:acme/backend.git",
        "somebody-else",
        "test",
    )
    .await;

    assert!(env.is_empty(), "{env:?}");
}

/// The three sources a profile adds together, for an agent put into a
/// workspace that already exists — which is the default placement, and the
/// one path that resolved the repository's defaults against a **slug**.
///
/// Driven through `create_session` with a `workspaceId`: the handler a second
/// agent and a delegated child at `placement: "here"` both arrive through. The
/// assertion is on the bundles the worker is *told to write*, because that is
/// what puts a folder on its disk — a pin that never becomes a bundle is the
/// same silence this whole feature is about.
///
/// What this would have caught: `skills_at_spawn` was handed
/// `WorkspacePlace::repo`, the first checkout's caption, where
/// `skill_defaults.repo_id` is an id. Nothing matched, nothing was logged, and
/// `include_repo_defaults` read on while delivering none of them. The unit
/// tests over `skills_for` could not see it — they are handed ids — and the
/// test for the arm that was missing only asserts which arm is chosen.
#[tokio::test]
async fn a_profile_hands_a_second_agent_the_repositorys_defaults_too() {
    use crate::skills::{IncomingFile, NewSkill};

    let (state, principal, host, ready, owner, launched) = watched_fixture().await;
    ready.store(true, Ordering::SeqCst);
    let org = state.db.org().await.unwrap();

    let repo = state
        .db
        .ensure_repo(
            "acme/backend",
            "git@example.test:acme/backend.git",
            Some("main"),
            None,
            &owner,
            None,
        )
        .await
        .unwrap();

    let skill = |name: &'static str| {
        let skills = state.skills.clone();
        let org = org.clone();
        let owner = owner.clone();
        async move {
            skills
                .create(
                    &org,
                    &owner,
                    "admin",
                    &NewSkill {
                        name: name.into(),
                        description: format!("Does {name}."),
                        frontmatter: serde_json::json!({ "name": name }),
                        body: "body".into(),
                        files: vec![IncomingFile {
                            path: "SKILL.md".into(),
                            contents: ft_proto::encode(b"body"),
                            executable: false,
                        }],
                        notes: None,
                    },
                    false,
                )
                .await
                .unwrap()
                .as_str()
                .to_string()
        }
    };
    let always = skill("qa-always").await;
    let in_repo = skill("qa-repo").await;
    let ticked = skill("qa-ticked").await;
    state
        .skills
        .set_default(&owner, &always, None, true)
        .await
        .unwrap();
    state
        .skills
        .set_default(&owner, &in_repo, Some(repo.id.as_str()), true)
        .await
        .unwrap();

    // One source each, so a missing one is unmistakable in the names.
    let slug: String = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
        .bind(&owner)
        .fetch_one(state.db.pool())
        .await
        .unwrap();
    let profile: crate::roles::NewRole = serde_json::from_value(serde_json::json!({
        "name": "reviewer",
        "does": "reviews",
        "placement": "here",
        "agent": "ClaudeCode",
        "skillScope": [ticked],
    }))
    .unwrap();
    let role = state
        .roles
        .create(&org, &owner, &slug, &profile)
        .await
        .unwrap();

    // The workspace the second agent is added to, checked out on that
    // repository — `workspaces.repo` is the slug, and `workspace_repos` is
    // where the id is.
    let lead = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &lead,
            &host.id,
            &owner,
            Some("acme/backend"),
            "The lead",
            "",
            Some("agent/x"),
            Some("main"),
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
    state
        .db
        .record_checkouts(
            &lead,
            &[ft_core::session::Checkout {
                repo_id: Some(repo.id.clone()),
                slug: "acme/backend".into(),
                base: "main".into(),
                branch: "agent/x".into(),
                path: String::new(),
                trouble: None,
                pull_request: None,
                pull_state: None,
            }],
        )
        .await
        .unwrap();

    let req = serde_json::from_value(serde_json::json!({
        "workspaceId": lead.as_str(),
        "agent": "ClaudeCode",
        "prompt": "have a look",
        "profile": role.as_str(),
    }))
    .unwrap();
    let (_, Json(child)) =
        sessions::create_session(State(state.clone()), Extension(principal), Json(req))
            .await
            .unwrap();
    assert_ne!(child.id, lead, "a second run, not the lead");

    let mut pinned = state.skills.of_session(child.id.as_str()).await.unwrap();
    pinned.sort();
    let mut expected = vec![always, in_repo, ticked];
    expected.sort();
    assert_eq!(
        pinned, expected,
        "all three sources, including the repository's defaults"
    );

    // And through to what the worker is told to write, which is the folder on
    // its disk.
    let spec = launched
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.session_id == child.id)
        .cloned()
        .expect("the child was launched");
    let mut folders: Vec<&str> = spec.skills.iter().map(|b| b.name.as_str()).collect();
    folders.sort();
    assert_eq!(folders, vec!["qa-always", "qa-repo", "qa-ticked"]);
    state.fleet.stop_supervising(&host.id).await;
}

// ── Delegation: what a child is given, and what it is not ───────────────
//
// `delegate::handle` is the one door a session's own tool call comes through,
// and everything below drives it exactly as the fleet does: an `AgentRequest`
// naming a tool, against a lead that may use it. Built here because nothing in
// this suite had ever started a child — the delegation tests that existed were
// of pure functions, and the thing worth testing is the resolution: which
// engine a child runs, on which machine, with whose subscription, and which of
// those a profile is allowed to decide.

/// A profile, saved the way the API saves one.
///
/// Through `crate::roles::check` rather than straight to `Roles::create`,
/// because what a profile may leave open *is* the validation — a test that
/// bypasses it passes today and proves nothing.
async fn saved_profile(state: &AppState, owner: &str, fields: serde_json::Value) -> String {
    let new: crate::roles::NewRole = serde_json::from_value(fields).unwrap();
    crate::roles::check(&new).expect("a profile the server accepts");
    let org = state.db.org().await.unwrap();
    let slug = state.access.personal_root(owner).await.unwrap();
    state
        .roles
        .create(&org, owner, &slug, &new)
        .await
        .unwrap()
        .as_str()
        .to_string()
}

/// A lead that may delegate: a session of this owner's, started as a profile.
async fn lead_running(
    state: &AppState,
    host: &Host,
    owner: &str,
    agent: Agent,
    profile: &str,
) -> ft_core::SessionId {
    let id = ft_core::SessionId::new();
    state
        .db
        .insert_session(
            &id,
            &host.id,
            owner,
            None,
            "The one that hands work out",
            "lead a feature",
            None,
            None,
            &format!("{agent:?}"),
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &ft_core::Step::plan(false, false),
            Some("lead"),
        )
        .await
        .unwrap();
    state.db.set_profile(&id, profile).await.unwrap();
    id
}

/// The Manager every spawn test delegates from, and a machine that can take
/// work: online, and answering the readiness probe.
async fn a_lead_that_delegates(
    state: &AppState,
    host: &Host,
    ready: &Arc<AtomicBool>,
    owner: &str,
    agent: Agent,
) -> ft_core::SessionId {
    ready.store(true, Ordering::SeqCst);
    state
        .db
        .mark_host_online(
            &host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let manager = saved_profile(
        state,
        owner,
        serde_json::json!({
            "name": "Ada, the lead",
            "does": "Breaks work up and hands it out",
            "placement": "here",
            "canDelegate": true,
        }),
    )
    .await;
    lead_running(state, host, owner, agent, &manager).await
}

/// One call, as the fleet hands it over. `req` is the agent's own id for it,
/// and is what a repeated call is recognised by, so each test gives its own.
fn asks(
    host: &Host,
    lead: &ft_core::SessionId,
    req: &str,
    tool: &str,
    input: serde_json::Value,
) -> crate::delegate::AgentRequest {
    crate::delegate::AgentRequest {
        host_id: host.id.clone(),
        session_id: lead.clone(),
        req: req.into(),
        tool: tool.into(),
        input,
    }
}

/// What a `spawn` left behind: the child's own session row.
async fn child_of(state: &AppState, lead: &ft_core::SessionId, req: &str) -> ft_core::Session {
    state
        .db
        .child_by_req(lead, req)
        .await
        .unwrap()
        .expect("spawn said it started a child")
}

/// The subscription a child was pinned to, which is a column rather than a
/// field on `Session` — and which a trigger fills in from the owner's default
/// when nothing named one.
async fn account_of(state: &AppState, child: &ft_core::SessionId) -> Option<String> {
    sqlx::query_scalar("SELECT agent_account_id FROM sessions WHERE id=$1")
        .bind(child.as_str())
        .fetch_one(state.db.pool())
        .await
        .unwrap()
}

/// What the worker was told to run this child with, as the agent will read it.
///
/// Off the wire rather than out of the database: a run's settings are an
/// environment variable on the frame that starts it and are on no row anywhere.
fn settings_told_to(launched: &Launches, child: &ft_core::SessionId) -> String {
    launched
        .lock()
        .unwrap()
        .iter()
        .find(|spec| &spec.session_id == child)
        .expect("the worker was asked to start it")
        .env
        .iter()
        .find(|(name, _)| name == ft_core::PREFERRED_ENV)
        .map(|(_, value)| value.clone())
        .unwrap_or_default()
}

/// Criterion 1: the three open values, through the route that validates them.
///
/// Routed through `POST /api/v1/roles` on purpose: `Roles::create` does not
/// call `check`, so a test that saved the row directly passed before any of
/// this and said nothing about whether the server would take it.
#[tokio::test]
async fn a_profile_may_be_saved_with_its_engine_machine_and_placement_open() {
    let (state, principal, host, _ready, _owner) = fixture().await;
    let (code, Json(made)) = super::roles::create_role(
        State(state.clone()),
        Extension(principal.clone()),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": "Reviewer",
                "does": "Reads the diff and argues with it; after a hand-back",
                "placement": "lead",
                "agent": null,
                "machine": null,
                "account": null,
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(code, StatusCode::CREATED);
    assert_eq!(made.placement, "lead");
    assert_eq!(made.agent, None);
    assert_eq!(made.machine, None);

    // And it reads back the same way, with both fields absent from the JSON
    // rather than present and null — which is what every client already
    // expects of them.
    let Json(listed) = super::roles::list_roles(State(state.clone()), Extension(principal))
        .await
        .unwrap();
    let read = listed
        .iter()
        .find(|r| r.id == made.id)
        .expect("in the list");
    let json = serde_json::to_value(read).unwrap();
    assert_eq!(json["placement"], "lead");
    assert!(json.get("agent").is_none(), "{json}");
    assert!(json.get("machine").is_none(), "{json}");

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 2: open is not unvalidated.
#[tokio::test]
async fn an_engine_by_a_name_firetower_does_not_run_is_still_refused() {
    let (state, principal, host, _ready, _owner) = fixture().await;
    let error = super::roles::create_role(
        State(state.clone()),
        Extension(principal),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": "Reviewer",
                "does": "Reads the diff and argues with it",
                "placement": "here",
                "agent": "Claude",
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap_err();
    assert!(
        error
            .message
            .contains("Claude is not an agent Firetower runs"),
        "{}",
        error.message
    );
    state.fleet.stop_supervising(&host.id).await;
}

/// A machine id no machine answers to, which QA found returning a 500 with a
/// Postgres constraint in the message.
///
/// Pre-existing on both branches, and more reachable since `spawn` and the
/// editor started handling machines more freely: `create_profile` and
/// `update_profile` take one from a Manager by hand. The point of criterion 26
/// is that a machine this server cannot honour is *named* rather than dumped,
/// and a write path that dumps it undoes that on the other side of the same
/// feature.
#[tokio::test]
async fn a_machine_id_no_machine_has_is_refused_by_name_rather_than_dumped() {
    let (state, principal, host, _ready, owner) = fixture().await;
    let error = super::roles::create_role(
        State(state.clone()),
        Extension(principal.clone()),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": "Load tester",
                "does": "Hammers a branch until something gives",
                "placement": "new",
                "machine": "h_nope",
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(error.code, super::ErrorCode::InvalidRequest),
        "a refusal, not a 500: {error:?}"
    );
    assert!(
        error.message.contains("h_nope"),
        "and it names the machine: {}",
        error.message
    );
    assert!(
        !error.message.contains("foreign key"),
        "without the constraint it came from: {}",
        error.message
    );

    // The same on the way through `PUT`, which is the one the editor uses.
    let (_, Json(real)) = super::roles::create_role(
        State(state.clone()),
        Extension(principal.clone()),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": "Load tester two",
                "does": "Hammers a branch until something gives",
                "placement": "new",
                "machine": host.id.as_str(),
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    let error = super::roles::update_role(
        State(state.clone()),
        Extension(principal),
        Path(real.id.clone()),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": real.name,
                "does": real.does,
                "placement": "new",
                "machine": "h_gone",
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(error.code, super::ErrorCode::InvalidRequest) && error.message.contains("h_gone"),
        "{error:?}"
    );

    /* And through `create_profile`, which is where a machine id is typed by
    hand rather than picked from a list — the reachable one. It is here to
    show the mapping is at the write and not at the route: these three
    callers get it from one site, which is why no handler has a copy of the
    check. */
    let lead = lead_running(
        &state,
        &host,
        &owner,
        Agent::ClaudeCode,
        &saved_profile(
            &state,
            &owner,
            serde_json::json!({
                "name": "Ada, the lead",
                "does": "Breaks work up and hands it out",
                "placement": "here",
                "canDelegate": true,
            }),
        )
        .await,
    )
    .await;
    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "mk",
            "create_profile",
            serde_json::json!({
                "name": "QA",
                "does": "Runs it and tries to break it; after a hand-back",
                "placement": "new",
                "machine": "h_nope",
            }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        said.contains("h_nope") && !said.contains("foreign key"),
        "{said}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 3: the Unpin button on the Machines screen, which has never
/// worked for the only profiles that can appear in its list.
///
/// `Machines.tsx` sends the whole profile back with `machine: null` and
/// `placement` as it was — so for every profile pinned to a machine, which is
/// to say every profile in that list, the request was refused and the refusal
/// rendered in brick beside the button.
#[tokio::test]
async fn unpinning_a_machine_from_an_its_own_workspace_profile_succeeds() {
    let (state, principal, host, _ready, _owner) = fixture().await;
    let (_, Json(pinned)) = super::roles::create_role(
        State(state.clone()),
        Extension(principal.clone()),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": "Load tester",
                "does": "Hammers a branch until something gives",
                "placement": "new",
                "agent": "ClaudeCode",
                "machine": host.id.as_str(),
            }))
            .unwrap(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(pinned.machine.as_deref(), Some(host.id.as_str()));

    // Exactly what the screen sends: the whole profile, with the machine
    // cleared and the placement left alone.
    let Json(unpinned) = super::roles::update_role(
        State(state.clone()),
        Extension(principal),
        Path(pinned.id.clone()),
        Json(
            serde_json::from_value(serde_json::json!({
                "name": pinned.name,
                "does": pinned.does,
                "placement": "new",
                "agent": pinned.agent,
                "machine": null,
                "account": null,
            }))
            .unwrap(),
        ),
    )
    .await
    .expect("unpinning is what that button is for");
    assert_eq!(unpinned.machine, None);
    assert_eq!(unpinned.placement, "new");

    state.fleet.stop_supervising(&host.id).await;
}

/// Criteria 4, 5 and 6: who decides the engine.
///
/// The resolution itself already worked — this is the branch the scope warns
/// nobody may invert — but it was unreachable, because a profile with no engine
/// could not be saved. Asserted together because the three answers are one
/// decision read three ways.
#[tokio::test]
async fn an_open_engine_is_the_leads_to_choose_and_a_pinned_one_is_not() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let open = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "here",
        }),
    )
    .await;
    let pinned = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Claude reviewer",
            "does": "Reads the diff on Claude Code, always",
            "placement": "here",
            "agent": "ClaudeCode",
        }),
    )
    .await;
    let _ = (open, pinned);

    // 4 — the engine the lead names.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "r1",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it", "agent": "Codex" }),
        ),
    )
    .await
    .expect("a profile that pins no engine takes the lead's argument");
    assert_eq!(child_of(&state, &lead, "r1").await.agent, Agent::Codex);

    // 5 — nothing named, so the lead's own.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "r2",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it" }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(child_of(&state, &lead, "r2").await.agent, Agent::ClaudeCode);

    // 6 — pinned stays binding, whatever the lead passes.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "r3",
            "spawn",
            serde_json::json!({ "role": "Claude reviewer", "goal": "read it", "agent": "Codex" }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        child_of(&state, &lead, "r3").await.agent,
        Agent::ClaudeCode,
        "the pin is the point of pinning"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// Criteria 8 and 9: the feature's own motivating bug, one layer down.
///
/// A subscription and a set of run settings belong to one engine. A profile
/// that leaves the engine open and still holds either would hand Claude Code's
/// model to Codex, and a Claude Code subscription to `accounts::validate` —
/// which refuses it with "that account is not connected for this agent", an
/// error about a field the lead never set. Both come off.
#[tokio::test]
async fn an_open_engine_carries_neither_its_subscription_nor_its_run_settings() {
    let (state, _principal, host, ready, owner, launched) = watched_fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::Codex).await;

    // A Claude Code subscription the profile pins, and the owner's default for
    // Codex — which is what the child should end up on instead.
    for (id, kind, default) in [
        ("a_claude", "ClaudeCode", false),
        ("a_codex", "Codex", true),
    ] {
        sqlx::query(
            "INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state,enabled,is_default,path)
             VALUES($1,$2,$3,$1,'Subscription',$1,'connected',true,$4,
                    ('u.' || (SELECT slug FROM principals WHERE id=$2) || '.' || $1)::ltree)",
        )
        .bind(id)
        .bind(&owner)
        .bind(kind)
        .bind(default)
        .execute(state.db.pool())
        .await
        .unwrap();
    }

    let profile = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "here",
            "agent": null,
            "account": "a_claude",
            "settings": { "model": "opus[1m]" },
        }),
    )
    .await;
    // Saved as it would be by somebody who opened an engine on a profile that
    // already pinned both — the row the guard exists for.
    sqlx::query("UPDATE roles SET agent_account_id='a_claude', pref_model='opus[1m]' WHERE id=$1")
        .bind(&profile)
        .execute(state.db.pool())
        .await
        .unwrap();

    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "leak",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it" }),
        ),
    )
    .await
    .expect("a Codex lead can delegate to a profile that pins no engine");

    let child = child_of(&state, &lead, "leak").await;
    assert_eq!(child.agent, Agent::Codex, "the lead's own engine");

    // 8 — a Claude Code model never reaches Codex's command line.
    let told = settings_told_to(&launched, &child.id);
    assert!(
        !told.contains("opus[1m]"),
        "the profile's model belongs to the engine it pinned: {told}"
    );

    // 9 — and the subscription resolves to the owner's default for the engine
    // the child actually runs, rather than failing validation.
    assert_eq!(
        account_of(&state, &child.id).await.as_deref(),
        Some("a_codex"),
        "the owner's default for the engine it got"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 10: an agent can author a profile that leaves fields open, and
/// the acknowledgement says so rather than describing it as `here`.
#[tokio::test]
async fn create_profile_may_leave_the_engine_and_the_placement_open() {
    let (state, _principal, host, _ready, owner) = fixture().await;
    let lead = lead_running(
        &state,
        &host,
        &owner,
        Agent::ClaudeCode,
        &saved_profile(
            &state,
            &owner,
            serde_json::json!({
                "name": "Ada, the lead",
                "does": "Breaks work up and hands it out",
                "placement": "here",
                "canDelegate": true,
            }),
        )
        .await,
    )
    .await;

    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "mk",
            "create_profile",
            serde_json::json!({
                "name": "QA",
                "does": "Runs it and tries to break it; after a hand-back",
            }),
        ),
    )
    .await
    .expect("a profile that settles neither is still a profile");
    assert!(
        said.contains("whichever engine its lead is running"),
        "{said}"
    );
    assert!(said.contains("wherever its lead puts it"), "{said}");
    assert!(
        !said.contains("sharing the lead's workspace"),
        "an open placement is not `here`: {said}"
    );

    let made = state.roles.by_name(&owner, "QA").await.unwrap().unwrap();
    assert_eq!(made.agent, None);
    assert_eq!(made.placement, "lead");

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 11: `update_profile` can clear a pin.
///
/// Absent cannot mean "clear": absent is what every field a call does not
/// mention looks like, and `.or(existing)` keeps it. So an explicit `null`
/// does it, and nothing else does — a tool that silently kept the old value
/// would be reporting a change it did not make, which is the exact thing that
/// tool's own description was written to prevent.
#[tokio::test]
async fn update_profile_clears_a_pin_when_it_is_passed_null() {
    let (state, _principal, host, _ready, owner) = fixture().await;
    let lead = lead_running(
        &state,
        &host,
        &owner,
        Agent::ClaudeCode,
        &saved_profile(
            &state,
            &owner,
            serde_json::json!({
                "name": "Ada, the lead",
                "does": "Breaks work up and hands it out",
                "placement": "here",
                "canDelegate": true,
            }),
        )
        .await,
    )
    .await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "QA",
            "does": "Runs it and tries to break it",
            "placement": "new",
            "agent": "Codex",
            "machine": host.id.as_str(),
        }),
    )
    .await;

    // Naming nothing changes nothing, which is what keeps every other field.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "u1",
            "update_profile",
            serde_json::json!({ "name": "QA", "does": "Runs it and tries hard to break it" }),
        ),
    )
    .await
    .unwrap();
    let kept = state.roles.by_name(&owner, "QA").await.unwrap().unwrap();
    assert_eq!(kept.agent.as_deref(), Some("Codex"));
    assert_eq!(kept.machine.as_deref(), Some(host.id.as_str()));

    // And null clears, on both.
    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "u2",
            "update_profile",
            serde_json::json!({ "name": "QA", "agent": null, "machine": null }),
        ),
    )
    .await
    .expect("\"stop pinning QA to Codex\" is a thing somebody says");
    let open = state.roles.by_name(&owner, "QA").await.unwrap().unwrap();
    assert_eq!(open.agent, None);
    assert_eq!(open.machine, None);
    assert!(
        said.contains("no subscription"),
        "with the engine open there is none to point at: {said}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 12: the open placement, which the earlier scope had no test for
/// at all.
#[tokio::test]
async fn an_open_placement_is_the_leads_to_choose() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "lead",
        }),
    )
    .await;
    let lead_workspace = state
        .db
        .session(&lead)
        .await
        .unwrap()
        .unwrap()
        .workspace_id
        .unwrap();

    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "p1",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it", "placement": "new" }),
        ),
    )
    .await
    .unwrap();
    assert_ne!(
        child_of(&state, &lead, "p1").await.workspace_id,
        Some(lead_workspace.clone()),
        "the lead asked for a workspace of its own"
    );

    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "p2",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it" }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        child_of(&state, &lead, "p2").await.workspace_id,
        Some(lead_workspace),
        "and nothing named means here, as it does for a profile with no role at all"
    );

    state.fleet.stop_supervising(&host.id).await;
}

// ── Where a child lands, and what it is told when nowhere will do ───────

/// A second machine, supervised and online, so a test can prove *which* of two
/// a child went to rather than that it went somewhere.
async fn another_machine(state: &AppState, owner: &str, name: &str) -> Host {
    let host = state
        .db
        .ensure_host(
            name,
            Compute::Server {
                host: name.into(),
                user: Some("editor".into()),
                port: None,
                key: ft_core::SshKey::Default,
                host_key: None,
            },
            owner,
        )
        .await
        .unwrap();
    state
        .fleet
        .supervise(
            host.id.clone(),
            Arc::new(Worker {
                ready: Arc::new(AtomicBool::new(true)),
                probe: None,
                launched: Default::default(),
                turns: Default::default(),
                says: tokio::sync::broadcast::Sender::new(1),
                launch_refuses: Default::default(),
            }),
        )
        .await;
    state
        .db
        .mark_host_online(
            &host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    host
}

/// What a machine has told us it has, for a test that is about the choosing
/// rather than about the probing.
async fn says_it_has(state: &AppState, host: &Host, found: &[(Agent, bool)]) {
    let reported: Vec<ft_core::AgentPresence> = found
        .iter()
        .map(|(kind, installed)| ft_core::AgentPresence {
            kind: *kind,
            installed: *installed,
            version: installed.then(|| "1.0.0".to_string()),
            logged_in: Some(*installed),
            account: None,
        })
        .collect();
    state.db.record_presence(&host.id, &reported).await.unwrap();
}

/// Criterion 21: the machine is picked for the engine, not taken in order.
///
/// Two machines, both up, and only the second has Codex. The first is the one
/// `hosts_for` returns first and the one every start used to take.
#[tokio::test]
async fn a_child_lands_on_a_machine_that_can_run_the_engine_it_was_given() {
    let (state, _principal, first, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &first, &ready, &owner, Agent::ClaudeCode).await;
    let second = another_machine(&state, &owner, "build-02").await;
    says_it_has(
        &state,
        &first,
        &[(Agent::ClaudeCode, true), (Agent::Codex, false)],
    )
    .await;
    says_it_has(&state, &second, &[(Agent::Codex, true)]).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Load tester",
            "does": "Hammers a branch until something gives",
            "placement": "new",
        }),
    )
    .await;

    crate::delegate::handle(
        &state,
        &asks(
            &first,
            &lead,
            "fit",
            "spawn",
            serde_json::json!({ "role": "Load tester", "goal": "hammer it", "agent": "Codex" }),
        ),
    )
    .await
    .expect("one of the two machines has Codex");
    let child = child_of(&state, &lead, "fit").await;
    assert_eq!(child.agent, Agent::Codex);
    assert_eq!(
        child.host_id, second.id,
        "the machine that has it, not the first one in the list"
    );

    state.fleet.stop_supervising(&first.id).await;
    state.fleet.stop_supervising(&second.id).await;
}

/// Criterion 22: nowhere can run it, said now and said why.
///
/// The error **code** as well as the message: today's refusal is an
/// `InvalidRequest` from the readiness check after a machine has already been
/// chosen, so a test matching only on a substring would pass against the old
/// behaviour.
#[tokio::test]
async fn no_machine_that_can_run_the_engine_is_refused_with_no_capacity() {
    let (state, principal, host, ready, owner) = fixture().await;
    ready.store(true, Ordering::SeqCst);
    state
        .db
        .mark_host_online(
            &host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    says_it_has(
        &state,
        &host,
        &[(Agent::ClaudeCode, true), (Agent::Codex, false)],
    )
    .await;

    let error = sessions::create_session(
        State(state.clone()),
        Extension(principal),
        Json(serde_json::from_value(serde_json::json!({ "name": "t", "agent": "Codex" })).unwrap()),
    )
    .await
    .unwrap_err();
    assert!(
        matches!(error.code, ErrorCode::NoCapacity),
        "{:?}: {}",
        error.code,
        error.message
    );
    assert!(
        error.message.contains("No machine can run Codex"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("has Claude Code"),
        "and what the machines it has can run: {}",
        error.message
    );

    // The same answer a lead gets, through the tool rather than the route.
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Load tester",
            "does": "Hammers a branch until something gives",
            "placement": "new",
        }),
    )
    .await;
    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "nope",
            "spawn",
            serde_json::json!({ "role": "Load tester", "goal": "hammer it", "agent": "Codex" }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("No machine can run Codex"), "{refused}");

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 23: a machine named by hand is refused as named, not swapped.
///
/// The one thing engine-aware placement must not break — the comment at the
/// selection says so, and a silent swap is the whole class of bug this feature
/// is about.
#[tokio::test]
async fn a_drained_machine_named_by_hand_is_refused_rather_than_swapped() {
    let (state, principal, host, ready, owner) = fixture().await;
    ready.store(true, Ordering::SeqCst);
    let second = another_machine(&state, &owner, "build-02").await;
    says_it_has(&state, &second, &[(Agent::ClaudeCode, true)]).await;
    sqlx::query("UPDATE hosts SET drained=true WHERE id=$1")
        .bind(host.id.as_str())
        .execute(state.db.pool())
        .await
        .unwrap();

    let error = sessions::create_session(
        State(state.clone()),
        Extension(principal),
        Json(
            serde_json::from_value(
                serde_json::json!({ "name": "t", "agent": "ClaudeCode", "hostId": host.id }),
            )
            .unwrap(),
        ),
    )
    .await
    .unwrap_err();
    assert!(
        error.message.contains("draining"),
        "the machine that was named, not the one that would have worked: {}",
        error.message
    );

    state.fleet.stop_supervising(&host.id).await;
    state.fleet.stop_supervising(&second.id).await;
}

/// Criteria 24 and 25: the lead may name a machine, and a pin still wins.
#[tokio::test]
async fn a_lead_may_name_a_machine_unless_the_profile_pinned_one() {
    let (state, _principal, first, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &first, &ready, &owner, Agent::ClaudeCode).await;
    let second = another_machine(&state, &owner, "build-02").await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Load tester",
            "does": "Hammers a branch until something gives",
            "placement": "new",
        }),
    )
    .await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Pinned tester",
            "does": "Hammers a branch on one machine, always",
            "placement": "new",
            "machine": first.id.as_str(),
        }),
    )
    .await;

    // 24 — the profile pins none, so the lead's argument decides.
    crate::delegate::handle(
        &state,
        &asks(
            &first,
            &lead,
            "m1",
            "spawn",
            serde_json::json!({
                "role": "Load tester", "goal": "hammer it", "machine": second.id.as_str(),
            }),
        ),
    )
    .await
    .expect("a machine the owner may use");
    assert_eq!(child_of(&state, &lead, "m1").await.host_id, second.id);

    // 25 — the profile pins one, so the argument loses, as it does for the
    // engine. A pin is the point of pinning.
    crate::delegate::handle(
        &state,
        &asks(
            &first,
            &lead,
            "m2",
            "spawn",
            serde_json::json!({
                "role": "Pinned tester", "goal": "hammer it", "machine": second.id.as_str(),
            }),
        ),
    )
    .await
    .unwrap();
    assert_eq!(child_of(&state, &lead, "m2").await.host_id, first.id);

    state.fleet.stop_supervising(&first.id).await;
    state.fleet.stop_supervising(&second.id).await;
}

/// Criterion 26: a machine the owner may not use is named rather than reported
/// as no capacity.
///
/// The pre-check is here rather than in `create_session_as`, which keeps its
/// deliberately vague "no host is available" — there, somebody may be typing
/// an id they were never given, and confirming it exists is the leak. Here the
/// caller is a session of the owner's own and there is no third party.
#[tokio::test]
async fn a_machine_the_owner_may_not_use_is_named_in_the_refusal() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    let hers = state
        .db
        .ensure_host("anas-laptop", native(), ana.id.as_str())
        .await
        .unwrap();
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Load tester",
            "does": "Hammers a branch until something gives",
            "placement": "new",
        }),
    )
    .await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "nothers",
            "spawn",
            serde_json::json!({
                "role": "Load tester", "goal": "hammer it", "machine": hers.id.as_str(),
            }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains(hers.id.as_str()),
        "the machine it named: {refused}"
    );
    assert!(
        refused.contains("Machines you can use"),
        "and the ones it may: {refused}"
    );
    assert!(
        !refused.contains("no host is available"),
        "which is the message for somebody typing an id, not for a lead: {refused}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 7: an engine name no engine has.
///
/// Discarded without a word until now — `agent: "Claude"` ran the child on the
/// lead's own engine and the lead reported a build that never happened. The
/// same silent discard the whole feature is about, one layer down, and the one
/// it would have survived.
#[tokio::test]
async fn an_engine_name_no_engine_has_is_refused_by_name() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "here",
        }),
    )
    .await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "oops",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it", "agent": "Claude" }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("there is no engine called \"Claude\""),
        "{refused}"
    );
    assert!(
        refused.contains("ClaudeCode"),
        "and the ones it may use: {refused}"
    );
    assert!(
        state
            .db
            .child_by_req(&lead, "oops")
            .await
            .unwrap()
            .is_none(),
        "and no child was started on the lead's own engine instead"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A subscription that belongs to another engine, named rather than refused as
/// "that account is not connected for this agent" — which is one string for
/// five causes and names neither the account nor the engine.
#[tokio::test]
async fn a_subscription_for_another_engine_is_refused_saying_which() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    sqlx::query(
        "INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state,enabled,path)
         VALUES('a_codex',$1,'Codex','Codex team','Subscription','a_codex','connected',true,
                ('u.' || (SELECT slug FROM principals WHERE id=$1) || '.a_codex')::ltree)",
    )
    .bind(&owner)
    .execute(state.db.pool())
    .await
    .unwrap();
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "here",
        }),
    )
    .await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "wrongacct",
            "spawn",
            serde_json::json!({ "role": "Reviewer", "goal": "read it", "account": "a_codex" }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("Codex"),
        "which engine it belongs to: {refused}"
    );
    assert!(
        refused.contains("Claude Code"),
        "and which engine this child runs: {refused}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

// ── What can run this, and where ────────────────────────────────────────

/// Criteria 28, 29 and 33: one join, with its age, offering only what could
/// actually be spent.
///
/// Three lists the lead has to correlate is where it pairs a machine with an
/// engine that is not installed on it — so the test is that each half names the
/// other, that nothing is reported without saying how old it is, and that a
/// subscription it could not spend is not on the list at all.
#[tokio::test]
async fn list_compute_answers_machines_engines_and_subscriptions_together() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let second = another_machine(&state, &owner, "build-02").await;
    says_it_has(
        &state,
        &host,
        &[(Agent::ClaudeCode, true), (Agent::Codex, false)],
    )
    .await;
    says_it_has(&state, &second, &[(Agent::Codex, true)]).await;

    // Three subscriptions, of which exactly one can be spent: a connected one
    // with a portable credential, a disconnected one, and one whose credential
    // never left the machine it was made on.
    for (id, kind, state_text) in [
        ("a_good", "ClaudeCode", "connected"),
        ("a_pending", "ClaudeCode", "pending"),
        ("a_local", "ClaudeCode", "connected"),
    ] {
        sqlx::query(
            "INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state,enabled,is_default,path)
             VALUES($1,$2,$3,$1,'Subscription',$1,$4,true,($1='a_good'),
                    ('u.' || (SELECT slug FROM principals WHERE id=$2) || '.' || $1)::ltree)",
        )
        .bind(id)
        .bind(&owner)
        .bind(kind)
        .bind(state_text)
        .execute(state.db.pool())
        .await
        .unwrap();
    }
    // Only two of them have anything in the vault; `a_local` is the one whose
    // credential is on a machine and cannot travel.
    for id in ["a_good", "a_pending"] {
        state
            .vault
            .put(
                crate::vault::Key::of(crate::vault::AGENT, id, &owner),
                "token",
                "test",
            )
            .await
            .unwrap();
    }
    /* Eleven and a half minutes, not eleven — and the half is the whole
    point. `how_long_ago` floors `seconds / 60` on *this process's* clock
    while `observed_at` is written by `now()` on *Postgres'*, so a reading
    placed exactly on a minute boundary reports 10 or 11 depending on which
    of the two is a fraction ahead at the moment the test runs. That made
    this assertion fail about one run in a hundred under load.

    The flake is in the fixture, so that is what moves: placing the reading
    in the middle of its minute leaves thirty seconds of slack in either
    direction and keeps the assertion exact. The rounding itself is not
    touched — a cause inferred from one failure's output is not grounds for
    changing what every reader of this tool is told. */
    sqlx::query(
        "INSERT INTO agent_account_limits(account_id,scope,status,used_percent,observed_at)
         VALUES('a_good','five_hour','allowed',24,now() - interval '11 minutes 30 seconds')",
    )
    .execute(state.db.pool())
    .await
    .unwrap();

    let said = crate::delegate::handle(
        &state,
        &asks(&host, &lead, "lc", "list_compute", serde_json::json!({})),
    )
    .await
    .expect("a lead may ask what it can run");

    // The join: a machine with an id to pass back and enough to choose by, and
    // each engine against the machines it is actually ready on.
    assert!(
        said.contains(host.id.as_str()),
        "an id it can pass back: {said}"
    );
    assert!(said.contains("build-02"), "{said}");
    assert!(said.contains("4 cores"), "enough to choose by: {said}");
    assert!(
        said.contains("Codex") && said.contains("ready on build-02"),
        "the engine against the machine that has it: {said}"
    );

    // 29 — observed, not authoritative, and said so.
    assert!(
        said.contains("last thing each machine reported"),
        "the tool's own words: {said}"
    );
    assert!(said.contains("5h 24% used"), "{said}");
    assert!(
        said.contains("11 minutes ago"),
        "a percentage without its age buys worse decisions than none: {said}"
    );

    // 33 — only what it could spend. The other two would be refused by
    // `validate`, so offering them offers a choice that was never there.
    assert!(said.contains("a_good"), "{said}");
    assert!(!said.contains("a_pending"), "not connected: {said}");
    assert!(
        !said.contains("a_local"),
        "host-local, so it cannot travel to the machine the child gets: {said}"
    );
    assert!(said.contains("your default"), "{said}");

    // 31 — the anti-trigger travels with the answer, not only in the schema.
    assert!(
        said.contains("Firetower picks are the right answers"),
        "{said}"
    );

    state.fleet.stop_supervising(&host.id).await;
    state.fleet.stop_supervising(&second.id).await;
}

/// Criterion 33, the half a `Level::Viewer` listing would get wrong.
///
/// A colleague's subscription that this person can *see* and may not *spend* —
/// which is what `GET /api/v1/agent-accounts` lists, and the obvious thing to
/// have reached for.
#[tokio::test]
async fn list_compute_leaves_out_a_subscription_this_person_may_only_see() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    // Filed in ana's own space, so the admin can neither see nor spend it —
    // the simplest shape of "not yours", and the one a Viewer listing of a
    // shared directory would get wrong in the other direction.
    sqlx::query(
        "INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state,enabled,path)
         VALUES('a_anas',$1,'ClaudeCode','anas plan','Subscription','a_anas','connected',true,
                ('u.' || (SELECT slug FROM principals WHERE id=$1) || '.a_anas')::ltree)",
    )
    .bind(ana.id.as_str())
    .execute(state.db.pool())
    .await
    .unwrap();
    state
        .vault
        .put(
            crate::vault::Key::of(crate::vault::AGENT, "a_anas", ana.id.as_str()),
            "token",
            "test",
        )
        .await
        .unwrap();

    let said = crate::delegate::handle(
        &state,
        &asks(&host, &lead, "lc2", "list_compute", serde_json::json!({})),
    )
    .await
    .unwrap();
    assert!(!said.contains("a_anas"), "{said}");
    assert!(!said.contains("anas plan"), "{said}");

    state.fleet.stop_supervising(&host.id).await;
}

/// Criterion 30: where the placement settles the machine, the answer is about
/// that machine.
#[tokio::test]
async fn list_compute_is_scoped_when_the_placement_settles_the_machine() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let second = another_machine(&state, &owner, "build-02").await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "here",
        }),
    )
    .await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Pinned tester",
            "does": "Hammers a branch on one machine, always",
            "placement": "new",
            "machine": second.id.as_str(),
        }),
    )
    .await;

    // Nothing said: the fleet, because nothing has settled anything.
    let whole = crate::delegate::handle(
        &state,
        &asks(&host, &lead, "s0", "list_compute", serde_json::json!({})),
    )
    .await
    .unwrap();
    assert!(whole.contains("Machines you can use — 2"), "{whole}");

    // `here`: a child in the lead's own workspace runs on the lead's own
    // machine, whatever anybody names.
    let here = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "s1",
            "list_compute",
            serde_json::json!({ "role": "Reviewer" }),
        ),
    )
    .await
    .unwrap();
    assert!(here.contains("Machines you can use — 1"), "{here}");
    assert!(here.contains("the placement settles it"), "{here}");
    assert!(!here.contains("build-02"), "{here}");

    // `new` with a machine pinned: that machine, and not the one the lead is on.
    let pinned = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "s2",
            "list_compute",
            serde_json::json!({ "role": "Pinned tester" }),
        ),
    )
    .await
    .unwrap();
    assert!(pinned.contains("Machines you can use — 1"), "{pinned}");
    assert!(pinned.contains("build-02"), "{pinned}");

    state.fleet.stop_supervising(&host.id).await;
    state.fleet.stop_supervising(&second.id).await;
}

/// Criterion 32: a team list marks which profiles leave a field open.
///
/// So a Manager can tell before it is refused which of its team will take an
/// `agent` argument and which will ignore it.
#[tokio::test]
async fn a_team_list_says_which_profiles_leave_a_field_open() {
    let (state, _principal, host, _ready, owner) = fixture().await;
    let manager = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Ada, the lead",
            "does": "Breaks work up and hands it out",
            "placement": "here",
            "agent": "ClaudeCode",
            "canDelegate": true,
        }),
    )
    .await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "lead",
        }),
    )
    .await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Committed",
            "does": "Runs on one engine in one place, always",
            "placement": "here",
            "agent": "Codex",
        }),
    )
    .await;
    let profile = state
        .roles
        .one(&owner, &manager, crate::access::Level::Viewer)
        .await
        .unwrap()
        .unwrap();

    // The persona's own list, which is what a Manager reads before it spawns.
    let persona = super::sessions::persona_for(&state, &owner, &profile)
        .await
        .unwrap();
    assert!(
        persona.contains("**Reviewer** — Reads the diff and argues with it — you choose its engine and placement"),
        "{persona}"
    );
    assert!(
        persona.contains("**Committed** — Runs on one engine in one place, always\n"),
        "a committed profile spends no words on it: {persona}"
    );

    // And the tool's list, which is the same fact asked for directly.
    let lead = lead_running(&state, &host, &owner, Agent::ClaudeCode, &manager).await;
    let listed = crate::delegate::handle(
        &state,
        &asks(&host, &lead, "lp", "list_profiles", serde_json::json!({})),
    )
    .await
    .unwrap();
    assert!(
        listed.contains("you choose its engine and placement"),
        "{listed}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

// ─── A lead re-routing a child that ran out ──────────────────────────────────

/// A subscription of this owner's, connected and with a credential the vault
/// actually holds — which `switch_for` checks and `spawn`'s path does not.
async fn a_subscription(state: &AppState, owner: &str, id: &str, kind: Agent) -> String {
    sqlx::query(
        "INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state,enabled,path)
         VALUES($1,$2,$3,$1,'Subscription',$1,'connected',true,
                ('u.' || (SELECT slug FROM principals WHERE id=$2) || '.' || $1)::ltree)",
    )
    .bind(id)
    .bind(owner)
    .bind(format!("{kind:?}"))
    .execute(state.db.pool())
    .await
    .unwrap();
    state
        .vault
        .put(
            crate::vault::Key::of(crate::vault::AGENT, id, owner),
            "{\"token\":\"t\"}",
            "fixture",
        )
        .await
        .unwrap();
    id.to_string()
}

/// A child of `lead`, started as a profile by name, sitting where a spent one
/// sits.
///
/// Spawned rather than inserted: `children_of` joins through `workspaces`, so
/// a row written by hand is not a child as far as the lead is concerned — and
/// the scoping this feature leans on is exactly that join.
async fn a_child_that_ran_out(
    state: &AppState,
    host: &Host,
    lead: &ft_core::SessionId,
    req: &str,
    profile: &str,
) -> ft_core::Session {
    crate::delegate::handle(
        state,
        &asks(
            host,
            lead,
            req,
            "spawn",
            serde_json::json!({ "role": profile, "goal": "write the change" }),
        ),
    )
    .await
    .expect("the child starts");
    let child = child_of(state, lead, req).await;
    state
        .fleet
        .set_status(&child.id, ft_core::SessionStatus::HandedBack, None)
        .await;
    child
}

/// What a lead may do to a spent child is its **profile's** decision, and it
/// is checked here rather than drawn.
///
/// `wait` is what every profile is until somebody says otherwise, so this is
/// also the regression guard on the whole feature arriving switched on. A
/// field only the editor enforced would be advice, and the point of it is that
/// it is a grant.
#[tokio::test]
async fn a_child_whose_profile_says_to_wait_is_not_the_leads_to_move() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let account = a_subscription(&state, &owner, "a_other", Agent::ClaudeCode).await;
    let waits = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests",
            "placement": "here",
            "agent": "ClaudeCode",
        }),
    )
    .await;
    // Not stated, so it is the column default — the shape every profile that
    // exists today already has.
    assert_eq!(
        state
            .roles
            .one(&owner, &waits, crate::access::Level::Viewer)
            .await
            .unwrap()
            .unwrap()
            .on_usage_limit,
        "wait"
    );
    let child = a_child_that_ran_out(&state, &host, &lead, "sp1", "Engineer").await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sw1",
            "children",
            serde_json::json!({ "action": "switch", "id": child.id.as_str(), "account": account }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("wait for human action"),
        "it says what the profile decided: {refused}"
    );
    assert!(
        refused.contains(child.name.as_str()),
        "and which child it is about: {refused}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// The second rung allows a subscription change and not an engine change, and
/// the refusal names the engine the account belongs to.
///
/// This is the gate that keeps `accept_permission_change` honest. The flag is
/// an acknowledgement a person gives in advance by choosing the third rung; a
/// lead cannot give one, so an account on another engine has to be refused
/// here rather than quietly accepted with the flag set.
#[tokio::test]
async fn an_account_on_another_engine_is_refused_unless_the_profile_allows_it() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let codex = a_subscription(&state, &owner, "a_codex", Agent::Codex).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests",
            "placement": "here",
            "agent": "ClaudeCode",
            "onUsageLimit": "same",
        }),
    )
    .await;
    let child = a_child_that_ran_out(&state, &host, &lead, "sp2", "Engineer").await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sw2",
            "children",
            serde_json::json!({ "action": "switch", "id": child.id.as_str(), "account": codex }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("Codex") && refused.contains("Claude Code"),
        "it names the engine it belongs to and the one the child runs: {refused}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A child started as no profile granted nothing, because there was nothing
/// to grant it with — and the refusal says that rather than reading as a bug.
#[tokio::test]
async fn a_child_started_as_no_profile_cannot_be_moved() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let account = a_subscription(&state, &owner, "a_other", Agent::ClaudeCode).await;
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sp3",
            "spawn",
            serde_json::json!({ "goal": "a one-off nobody wrote a profile for" }),
        ),
    )
    .await
    .expect("an ad-hoc child starts");
    let child = child_of(&state, &lead, "sp3").await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sw3",
            "children",
            serde_json::json!({ "action": "switch", "id": child.id.as_str(), "account": account }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("not started as a profile"), "{refused}");

    state.fleet.stop_supervising(&host.id).await;
}

/// Somebody else's child is not reachable by id, which is the same rule
/// `steer` and `stop` already keep — reused rather than written again.
#[tokio::test]
async fn a_session_that_is_not_this_leads_child_cannot_be_switched() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let account = a_subscription(&state, &owner, "a_other", Agent::ClaudeCode).await;
    // A session that exists and is not this lead's child — its own, which is
    // the nearest thing to hand and the one id a lead certainly knows.
    let stranger = lead.clone();

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sw4",
            "children",
            serde_json::json!({ "action": "switch", "id": stranger.as_str(), "account": account }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("is not a child of this session"),
        "{refused}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A cross-engine continuation keeps the lineage of what it continues.
///
/// Both directions, because the bug was the asymmetry. `continue_with_account`
/// starts a new session when the engine changes — one engine cannot resume
/// another's conversation — and it passed no lineage at all. That was right
/// for every caller it had, a person switching a session of their own, and
/// silently wrong for the one this feature adds: a lead moving a spent child
/// across engines would have ended the delegation, losing the child from
/// `children_of` and never being told when it handed back.
///
/// The second half is the guard on the person-facing switcher, which must go
/// on producing a root from a root.
#[tokio::test]
async fn a_cross_engine_continuation_stays_the_child_it_was() {
    let (state, _principal, host, ready, owner) = fixture().await;
    says_it_has(
        &state,
        &host,
        &[(Agent::ClaudeCode, true), (Agent::Codex, true)],
    )
    .await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let codex = a_subscription(&state, &owner, "a_codex", Agent::Codex).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests",
            "placement": "new",
            "agent": "ClaudeCode",
            // The third rung: the person acknowledged in advance that another
            // engine brings its own default permissions.
            "onUsageLimit": "engine",
        }),
    )
    .await;
    let child = a_child_that_ran_out(&state, &host, &lead, "spx", "Engineer").await;

    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "swx",
            "children",
            serde_json::json!({ "action": "switch", "id": child.id.as_str(), "account": codex }),
        ),
    )
    .await
    .expect("the third rung allows it");

    // A session of its own, because the engine changed — and still this
    // lead's child, which is the whole point.
    let now: Vec<_> = state.db.children_of(&lead).await.unwrap();
    let carried = now
        .iter()
        .find(|c| c.id != child.id)
        .expect("the continuation is a child of the same lead");
    assert_eq!(carried.parent_id.as_ref(), Some(&lead));
    assert_eq!(carried.agent, Agent::Codex);
    assert!(
        said.contains(carried.id.as_str()),
        "and the lead is given the id it has to steer from now on: {said}"
    );

    // The other direction: a root switched across engines is still a root.
    let alone = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "spy",
            "spawn",
            serde_json::json!({ "goal": "something else", "placement": "new" }),
        ),
    )
    .await;
    assert!(alone.is_ok(), "{alone:?}");
    let plain = child_of(&state, &lead, "spy").await;
    // Detach it, so what is continued is a root like a person's own session.
    sqlx::query("UPDATE sessions SET parent_id=NULL WHERE id=$1")
        .bind(plain.id.as_str())
        .execute(state.db.pool())
        .await
        .unwrap();
    let detached = state.db.session(&plain.id).await.unwrap().unwrap();
    let next = crate::api::sessions::continue_with_account(
        &state,
        &owner,
        &detached,
        &codex,
        Agent::Codex,
    )
    .await
    .expect("a person switching their own session across engines");
    assert_ne!(next, plain.id, "a different engine gets its own session");
    assert_eq!(
        state.db.session(&next).await.unwrap().unwrap().parent_id,
        None,
        "a root continues as a root"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// **A spawned child carries the profile it was started as.**
///
/// Asserted on its own, because nothing read `Session::profile_id` on a child
/// until this feature and so nothing noticed it was never written. A profile
/// now says what a lead may do about a child of its that runs out, and that
/// grant is read off the *child* at the moment it is spent — so a null here
/// is a feature that passes every unit test above and refuses every switch in
/// the product.
///
/// Both placements, because they build two different `NewSession` bodies and
/// only one of them was ever going to be the one somebody checked.
#[tokio::test]
async fn a_spawned_child_carries_the_profile_it_was_started_as() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let engineer = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests",
            "placement": "here",
            "agent": "ClaudeCode",
            "onUsageLimit": "same",
        }),
    )
    .await;
    let own = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Prospector",
            "does": "Goes off and looks at something",
            "placement": "new",
            "agent": "ClaudeCode",
        }),
    )
    .await;

    for (req, name, expected) in [("c1", "Engineer", &engineer), ("c2", "Prospector", &own)] {
        crate::delegate::handle(
            &state,
            &asks(
                &host,
                &lead,
                req,
                "spawn",
                serde_json::json!({ "role": name, "goal": "do the thing" }),
            ),
        )
        .await
        .expect("the child starts");
        let child = child_of(&state, &lead, req).await;
        assert_eq!(
            child.profile_id.as_deref(),
            Some(expected.as_str()),
            "{name} should carry its profile"
        );
    }

    // And the grant is reachable through it, which is the only reason the id
    // matters: a lead asking what it may do reads the child's profile.
    let child = child_of(&state, &lead, "c1").await;
    let grant = state
        .roles
        .one(
            &owner,
            child.profile_id.as_deref().unwrap(),
            crate::access::Level::Viewer,
        )
        .await
        .unwrap()
        .expect("the profile a child names is one its owner can read");
    assert_eq!(grant.on_usage_limit, "same");

    // An ad-hoc child names no profile and carries none, which is a real
    // answer rather than a gap — there was nothing to grant it with.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "c3",
            "spawn",
            serde_json::json!({ "goal": "a one-off" }),
        ),
    )
    .await
    .expect("an ad-hoc child starts");
    assert_eq!(child_of(&state, &lead, "c3").await.profile_id, None);

    state.fleet.stop_supervising(&host.id).await;
}

/// A Manager told to re-route still cannot move a child told to wait.
///
/// **It is refused by construction today, and that is exactly why this is
/// here.** `reroute` never reads the lead's `on_child_limit`, because that
/// setting says whether a Manager asks the person first and asking ends in
/// the same call once they have answered — so there is nothing to check. A
/// property that holds because nobody wrote the branch is stronger than a
/// test today and weaker than one tomorrow: this fails the moment somebody
/// adds a lead-side branch that reads the Manager's own setting as
/// permission, which is the plausible mistake.
///
/// The grant is the child's and only the child's. Both halves are asserted:
/// the `wait` child is refused however the Manager is set, and the `same`
/// child is not refused *for this reason* — the engine check beyond it is a
/// different test.
#[tokio::test]
async fn a_manager_set_to_reroute_still_cannot_move_a_child_told_to_wait() {
    let (state, _principal, host, ready, owner) = fixture().await;
    ready.store(true, Ordering::SeqCst);
    state
        .db
        .mark_host_online(
            &host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    // A Manager that re-routes on its own, rather than the fixture's default.
    let manager = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Ada, the lead",
            "does": "Breaks work up and hands it out",
            "placement": "here",
            "canDelegate": true,
            "onChildLimit": "reroute",
        }),
    )
    .await;
    let lead = lead_running(&state, &host, &owner, Agent::ClaudeCode, &manager).await;
    assert_eq!(
        state
            .roles
            .one(&owner, &manager, crate::access::Level::Viewer)
            .await
            .unwrap()
            .unwrap()
            .on_child_limit,
        "reroute",
        "the lead really is set to the permissive answer"
    );
    let account = a_subscription(&state, &owner, "a_other", Agent::ClaudeCode).await;

    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Careful",
            "does": "Does work nobody may move",
            "placement": "here",
            "agent": "ClaudeCode",
            "onUsageLimit": "wait",
        }),
    )
    .await;
    let waits = a_child_that_ran_out(&state, &host, &lead, "r1", "Careful").await;

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "rw",
            "children",
            serde_json::json!({ "action": "switch", "id": waits.id.as_str(), "account": account }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("wait for human action"),
        "the Manager's own setting does not widen the child's grant: {refused}"
    );

    // And the other half: the same Manager against a child that does allow
    // it gets past this gate. Whatever happens after is another test's.
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Movable",
            "does": "Does work a lead may move",
            "placement": "here",
            "agent": "ClaudeCode",
            "onUsageLimit": "same",
        }),
    )
    .await;
    let movable = a_child_that_ran_out(&state, &host, &lead, "r2", "Movable").await;
    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "rm",
            "children",
            serde_json::json!({ "action": "switch", "id": movable.id.as_str(), "account": account }),
        ),
    )
    .await;
    let told = match &said {
        Ok(ok) => ok.clone(),
        Err(e) => e.to_string(),
    };
    assert!(
        !told.contains("wait for human action"),
        "a child that allows it is not refused by the grant: {told}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

// ─── Reading a whole profile, and copying it ────────────────────────────────

/// A skill of this owner's, live, so `skill_scope` has something real to name.
async fn a_skill(state: &AppState, owner: &str, name: &str) -> String {
    let org = state.db.org().await.unwrap();
    let slug = state.access.personal_root(owner).await.unwrap();
    state
        .skills
        .create(
            &org,
            owner,
            &slug,
            &crate::skills::NewSkill {
                name: name.into(),
                description: format!("what {name} is for"),
                frontmatter: serde_json::json!({}),
                body: "# Do the thing\n".into(),
                files: vec![],
                notes: None,
            },
            false,
        )
        .await
        .unwrap()
        .as_str()
        .to_string()
}

/// **The feature, as one test: can an agent reproduce a profile it can see?**
///
/// Not "does the tool print more fields". A profile is configured every way a
/// profile can be, `get_profile` is asked for it, and the values it reports
/// are handed straight back to `create_profile` — which is exactly the round
/// trip somebody means by "make me one like that one". Every copyable field
/// has to survive it.
///
/// Both halves are asserted, because either alone passes while the feature is
/// broken. A copy that matches proves the write side and says nothing about
/// whether an agent could have *read* those values; text naming them proves
/// the read side and says nothing about whether they can be written back. So
/// the text is checked for every value the copy is built from.
///
/// The two that deliberately do not travel are asserted too, as **reported and
/// defaulted** rather than silently dropped — a copy that quietly loses
/// somebody's subscription, or quietly steals the default, is the failure this
/// whole body of work exists to remove.
#[tokio::test]
async fn an_agent_can_read_a_whole_profile_and_copy_it() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    a_skill(&state, &owner, "changelog").await;
    let teammate = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Reviewer",
            "does": "Reads the diff and argues with it",
            "placement": "here",
        }),
    )
    .await;
    let account = a_subscription(&state, &owner, "a_pinned", Agent::ClaudeCode).await;

    // Every field a profile has, set to something it would not be by
    // accident — the same discipline `role-draft.test.ts` keeps, and for the
    // same reason: a fixture that matches the defaults passes while the copy
    // drops everything.
    let original = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests; after a scope is agreed",
            "placement": "new",
            "agent": "ClaudeCode",
            "machine": host.id.as_str(),
            "account": account,
            "instructions": "# Engineer\n\nWrite the change. Do not review it.",
            "onUsageLimit": "engine",
            "onChildLimit": "reroute",
            "canDelegate": true,
            "delegateScope": [teammate],
            "skillScope": [],
            "includeAlwaysOn": false,
            "includeRepoDefaults": false,
            "settings": { "model": "opus[1m]", "mode": "plan" },
        }),
    )
    .await;
    // The skill by name, which is how an agent sees one — `list_skills` shows
    // names and shows no ids at all.
    let found = state
        .skills
        .visible(&owner, crate::access::Level::Viewer)
        .await
        .unwrap();
    let changelog = found.iter().find(|s| s.name == "changelog").unwrap();
    sqlx::query("UPDATE roles SET skill_scope=$2 WHERE id=$1")
        .bind(&original)
        .bind(vec![changelog.id.as_str().to_string()])
        .execute(state.db.pool())
        .await
        .unwrap();
    // And the one field no tool may write, set behind the tools' back so the
    // read has something true to report.
    state
        .roles
        .set_default(&owner, &original, true)
        .await
        .unwrap();

    // ── read ──────────────────────────────────────────────────────────────
    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "g1",
            "get_profile",
            serde_json::json!({ "name": "Engineer" }),
        ),
    )
    .await
    .expect("a profile its owner can see is one they can read");

    for expected in [
        "Engineer",
        "Writes the change and the tests",
        "Claude Code",
        "its own workspace",
        "Write the change. Do not review it.",
        "Reviewer",
        "changelog",
        // The two grants, by the words the editor uses rather than by their
        // stored codes — an agent reads prose, and `engine` alone says nothing.
        "another subscription and engine",
        "Re-route",
        "Manager",
    ] {
        assert!(
            said.contains(expected),
            "the read has to carry {expected:?} for a copy to be possible: {said}"
        );
    }
    // What cannot be copied has to be *said*, not omitted.
    assert!(
        said.to_lowercase().contains("subscription"),
        "the subscription is named: {said}"
    );
    assert!(
        said.contains("default"),
        "and that it is the owner's default profile: {said}"
    );

    // ── copy ──────────────────────────────────────────────────────────────
    let copied = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "g2",
            "create_profile",
            serde_json::json!({
                "name": "Engineer (copy)",
                "does": "Writes the change and the tests; after a scope is agreed",
                "placement": "new",
                "agent": "ClaudeCode",
                "machine": host.id.as_str(),
                "instructions": "# Engineer\n\nWrite the change. Do not review it.",
                "on_usage_limit": "engine",
                "on_child_limit": "reroute",
                "can_delegate": true,
                "delegate_scope": ["Reviewer"],
                "skill_scope": ["changelog"],
                "include_always_on": false,
                "include_repo_defaults": false,
                "settings": { "model": "opus[1m]", "mode": "plan" },
            }),
        ),
    )
    .await
    .expect("everything the read reported can be written back");
    assert!(copied.contains("Engineer (copy)"), "{copied}");

    let before = state
        .roles
        .one(&owner, &original, crate::access::Level::Viewer)
        .await
        .unwrap()
        .unwrap();
    let after = state
        .roles
        .by_name(&owner, "Engineer (copy)")
        .await
        .unwrap()
        .expect("the copy exists");

    assert_eq!(after.does, before.does);
    assert_eq!(after.placement, before.placement);
    assert_eq!(after.agent, before.agent);
    assert_eq!(after.machine, before.machine);
    assert_eq!(after.instructions, before.instructions);
    assert_eq!(after.on_usage_limit, before.on_usage_limit);
    assert_eq!(after.on_child_limit, before.on_child_limit);
    assert_eq!(after.can_delegate, before.can_delegate);
    assert_eq!(after.delegate_scope, before.delegate_scope);
    assert_eq!(after.skill_scope, before.skill_scope);
    assert_eq!(after.include_always_on, before.include_always_on);
    assert_eq!(after.include_repo_defaults, before.include_repo_defaults);
    assert_eq!(after.settings, before.settings);

    // And the two that do not travel, which is the point of saying so.
    assert_eq!(
        after.account, None,
        "a copy runs on the owner's default, not somebody's pinned subscription"
    );
    assert!(
        !after.is_default,
        "and copying a profile does not take the default off the one it copied"
    );
    assert!(
        state
            .roles
            .one(&owner, &original, crate::access::Level::Viewer)
            .await
            .unwrap()
            .unwrap()
            .is_default,
        "which is still where it was"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// Every new field refuses an unknown value **by name**.
///
/// One test over all of them, because the discipline is one discipline: an
/// agent that mistyped gets told which value was wrong, the way a mistyped
/// engine already does. A refusal that only lists the legal values leaves the
/// agent to diff two lists and guess which of its arguments was at fault.
#[tokio::test]
async fn a_value_no_profile_can_hold_is_refused_by_name() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;

    let base = |extra: serde_json::Value| {
        let mut input = serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests",
            "agent": "ClaudeCode",
        });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        input
    };
    for (n, extra, expected) in [
        (
            "a skill nobody has",
            serde_json::json!({ "skill_scope": ["no-such-skill"] }),
            "no-such-skill",
        ),
        (
            "a profile nobody has",
            serde_json::json!({ "delegate_scope": ["No Such Profile"], "can_delegate": true }),
            "No Such Profile",
        ),
        (
            "a model the engine does not offer",
            serde_json::json!({ "settings": { "model": "gpt-9" } }),
            "gpt-9",
        ),
        (
            "a rung that is not one",
            serde_json::json!({ "on_usage_limit": "whenever" }),
            "whenever",
        ),
        (
            "a Manager answer that is not one",
            serde_json::json!({ "on_child_limit": "sometimes" }),
            "sometimes",
        ),
    ] {
        let refused = crate::delegate::handle(
            &state,
            &asks(&host, &lead, n, "create_profile", base(extra)),
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(
            refused.contains(expected),
            "{n}: the refusal has to name {expected:?}, not just list the legal values: {refused}"
        );
    }

    // Run settings belong to an engine, so a profile that pins none cannot
    // carry any — the editor does not draw the field there either.
    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "nosettings",
            "create_profile",
            serde_json::json!({
                "name": "Open",
                "does": "Runs on whatever its lead runs",
                "settings": { "mode": "plan" },
            }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("belong to an engine"), "{refused}");

    state.fleet.stop_supervising(&host.id).await;
}

/// `update_profile` keeps its discipline over the new fields too.
///
/// Absent leaves a field alone; an explicit empty list clears one. That
/// distinction is the whole of why `update_profile` is safe to call with one
/// argument, and adding seven fields is exactly when it gets lost.
#[tokio::test]
async fn an_update_changes_only_what_it_names() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    a_skill(&state, &owner, "changelog").await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({ "name": "Reviewer", "does": "Reads the diff", "placement": "here" }),
    )
    .await;
    let id = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change",
            "placement": "new",
            "agent": "ClaudeCode",
            "canDelegate": true,
            "onUsageLimit": "same",
            "onChildLimit": "reroute",
            "includeAlwaysOn": false,
            "settings": { "model": "opus[1m]" },
        }),
    )
    .await;
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "u1",
            "update_profile",
            serde_json::json!({
                "name": "Engineer",
                "skill_scope": ["changelog"],
                "delegate_scope": ["Reviewer"],
            }),
        ),
    )
    .await
    .expect("naming two fields changes two fields");

    let after = state
        .roles
        .one(&owner, &id, crate::access::Level::Viewer)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.skill_scope.len(), 1, "the one it named");
    assert_eq!(after.delegate_scope.len(), 1);
    // And everything it did not name is exactly as it was.
    assert_eq!(after.on_usage_limit, "same");
    assert_eq!(after.on_child_limit, "reroute");
    assert!(!after.include_always_on);
    assert_eq!(after.settings.model.as_deref(), Some("opus[1m]"));
    assert_eq!(after.placement, "new");
    assert_eq!(after.does, "Writes the change");

    // An explicit empty list is a real answer: this profile names nobody.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "u2",
            "update_profile",
            serde_json::json!({ "name": "Engineer", "delegate_scope": [] }),
        ),
    )
    .await
    .expect("clearing a team is a thing to be able to say");
    let after = state
        .roles
        .one(&owner, &id, crate::access::Level::Viewer)
        .await
        .unwrap()
        .unwrap();
    assert!(after.delegate_scope.is_empty(), "cleared");
    assert_eq!(after.skill_scope.len(), 1, "and the other one left alone");

    state.fleet.stop_supervising(&host.id).await;
}

/// A profile cannot be put on its own team.
///
/// `Roles.tsx` filters the profile being edited out of its own delegate
/// picker; a tool resolving by name has to do the same, or "copy the Engineer
/// and let it hand work to the Engineer" writes a profile that can delegate
/// to itself — which the flat-hierarchy rule then refuses at spawn, far from
/// where the mistake was made.
#[tokio::test]
async fn a_profile_is_not_put_on_its_own_team() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({ "name": "Reviewer", "does": "Reads the diff", "placement": "here" }),
    )
    .await;
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "s1",
            "create_profile",
            serde_json::json!({
                "name": "Engineer",
                "does": "Writes the change",
                "can_delegate": true,
                "delegate_scope": ["Engineer", "Reviewer"],
            }),
        ),
    )
    .await
    .expect("naming itself is dropped, not refused — the rest of the team is the ask");
    let made = state
        .roles
        .by_name(&owner, "Engineer")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(made.delegate_scope.len(), 1, "only the Reviewer");

    state.fleet.stop_supervising(&host.id).await;
}

/// One name, two things: **neither, and say which name was ambiguous.**
///
/// `d34336c8`'s rule one layer up. There, two skills sharing a name collapsed
/// into a single bundle and the survivor ran under the loser's name carrying
/// the loser's executable; the fix was to send neither rather than pick a
/// winner by a rule nobody wrote down. A scope resolved by name inherits the
/// problem exactly — `skills_one_name_per_owner` only stops *one* person
/// owning two, and a shared skill brings a second owner's name into the set.
///
/// The whole call is refused rather than the entry dropped: a scope that
/// quietly loses one is a profile that silently does less than was asked for,
/// and on `skill_scope` that is a skill not loaded, invisible until something
/// behaves oddly much later.
#[tokio::test]
async fn a_name_two_things_answer_to_is_refused_rather_than_guessed() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    a_skill(&state, &owner, "changelog").await;

    // A colleague's skill of the same name, shared so this owner can see
    // both — which is the only way one person reaches two of one name.
    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    let hers = a_skill(&state, ana.id.as_str(), "changelog").await;
    state
        .access
        .set_exception(
            crate::access::FiledKind::Skill,
            &hers,
            &owner,
            crate::access::Level::Viewer,
        )
        .await
        .unwrap();
    assert_eq!(
        state
            .skills
            .visible(&owner, crate::access::Level::Viewer)
            .await
            .unwrap()
            .iter()
            .filter(|s| s.name == "changelog")
            .count(),
        2,
        "the fixture has to actually produce the collision"
    );

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "amb",
            "create_profile",
            serde_json::json!({
                "name": "Engineer",
                "does": "Writes the change",
                "skill_scope": ["changelog"],
            }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("changelog") && refused.contains("more than one"),
        "it names the ambiguous name rather than picking one: {refused}"
    );
    assert!(
        state
            .roles
            .by_name(&owner, "Engineer")
            .await
            .unwrap()
            .is_none(),
        "and nothing was written — the whole call is refused, not part of it"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A scope entry that no longer resolves is **reported, not omitted**.
///
/// Hiding it would make the read look tidier than the profile is, and an
/// agent would copy the tidier thing and report the copy faithful. The id is
/// all that is left of a deleted skill and is what somebody needs to clear
/// it.
#[tokio::test]
async fn get_profile_says_when_a_scope_entry_is_gone() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let id = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change",
            "placement": "here",
        }),
    )
    .await;
    // A skill that was ticked and has since been deleted — the row keeps the
    // id, because nothing sweeps a scope when a skill goes.
    sqlx::query("UPDATE roles SET skill_scope=$2 WHERE id=$1")
        .bind(&id)
        .bind(vec!["sk_longgone".to_string()])
        .execute(state.db.pool())
        .await
        .unwrap();

    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "gone",
            "get_profile",
            serde_json::json!({ "name": "Engineer" }),
        ),
    )
    .await
    .unwrap();
    assert!(
        said.contains("sk_longgone") && said.contains("no longer exists"),
        "the read owns up to it rather than quietly tidying: {said}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// **Two profiles of one name: neither is read, and neither is overwritten.**
///
/// The worst thing this surface can do. `Roles::by_name` takes the first
/// match and `visible()` orders by name, so `update_profile` rewrote
/// whichever Postgres returned first and reported success — a wrong profile
/// silently overwritten, which is the failure this whole body of work exists
/// to remove, on the tool whose purpose is making a second profile like an
/// existing one.
///
/// All three tools that take a profile by name, because the fault was in the
/// resolution rather than in any one of them.
#[tokio::test]
async fn two_profiles_of_one_name_are_read_and_written_by_neither() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;

    let mine = saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Mine, and the one that is not to be clobbered",
            "placement": "here",
        }),
    )
    .await;
    // A colleague's of the same name, shared — the only way one person
    // reaches two, and exactly what copying a profile tends to produce.
    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    let hers = saved_profile(
        &state,
        ana.id.as_str(),
        serde_json::json!({ "name": "Engineer", "does": "Hers", "placement": "here" }),
    )
    .await;
    state
        .access
        .set_exception(
            crate::access::FiledKind::Role,
            &hers,
            &owner,
            crate::access::Level::Writer,
        )
        .await
        .unwrap();

    for (tool, input) in [
        ("get_profile", serde_json::json!({ "name": "Engineer" })),
        (
            "update_profile",
            serde_json::json!({ "name": "Engineer", "does": "clobbered" }),
        ),
    ] {
        let refused = crate::delegate::handle(&state, &asks(&host, &lead, tool, tool, input))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            refused.contains("Engineer") && refused.contains("more than one"),
            "{tool}: it names the ambiguity rather than picking one: {refused}"
        );
    }
    // And neither was touched.
    assert_eq!(
        state
            .roles
            .one(&owner, &mine, crate::access::Level::Viewer)
            .await
            .unwrap()
            .unwrap()
            .does,
        "Mine, and the one that is not to be clobbered"
    );
    assert_eq!(
        state
            .roles
            .one(&owner, &hers, crate::access::Level::Viewer)
            .await
            .unwrap()
            .unwrap()
            .does,
        "Hers"
    );

    // `list_compute`'s `role` is the third, and it is scoped by whichever
    // profile settles the machine — so a guess there is a confident wrong
    // answer about the fleet.
    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "lc",
            "list_compute",
            serde_json::json!({ "role": "Engineer" }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("more than one"), "{refused}");

    // A name nothing answers to still leaves `list_compute` unscoped, as it
    // always has — that half is not what was wrong.
    assert!(crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "lc2",
            "list_compute",
            serde_json::json!({ "role": "No Such Profile" }),
        ),
    )
    .await
    .is_ok());

    state.fleet.stop_supervising(&host.id).await;
}

/// Dropping a profile from its own team is right; doing it in silence is not.
#[tokio::test]
async fn dropping_a_profile_from_its_own_team_is_said_out_loud() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({ "name": "Reviewer", "does": "Reads the diff", "placement": "here" }),
    )
    .await;

    let said = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "self",
            "create_profile",
            serde_json::json!({
                "name": "Engineer",
                "does": "Writes the change",
                "can_delegate": true,
                "delegate_scope": ["Engineer", "Reviewer"],
            }),
        ),
    )
    .await
    .expect("the rest of the team is still the ask");
    assert!(
        said.contains("not on its own team") && said.contains("Engineer"),
        "an argument accepted and not applied has to be said: {said}"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A placement that is not one is refused by name, like the other two.
#[tokio::test]
async fn a_placement_that_is_not_one_is_refused_by_name() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "pl",
            "create_profile",
            serde_json::json!({
                "name": "Engineer",
                "does": "Writes the change",
                "placement": "somewhere",
            }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(refused.contains("somewhere"), "{refused}");

    state.fleet.stop_supervising(&host.id).await;
}

/// **`spawn` is the fourth site, and the one that costs most to get wrong.**
///
/// A read that picks the wrong one of two profiles wastes a call. A spawn
/// that picks wrong starts work on the wrong profile and spends somebody's
/// allowance doing it — QA demonstrated exactly that, a child running with
/// `profile_id` pointing at whichever row came back first.
///
/// And the list in the not-found refusal, which said `Engineer, Engineer`:
/// the truth, and it reads as a bug. One entry per name with the collision
/// marked says both — the name is still the handle, and there is something
/// to go and fix.
#[tokio::test]
async fn spawning_a_name_two_profiles_answer_to_starts_neither() {
    let (state, _principal, host, ready, owner) = fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({ "name": "Engineer", "does": "Mine", "placement": "here" }),
    )
    .await;
    let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
    let ana = state
        .accounts
        .create_user(&org, "ana", "ana@example.test", "member")
        .await
        .unwrap()
        .0;
    let hers = saved_profile(
        &state,
        ana.id.as_str(),
        serde_json::json!({ "name": "Engineer", "does": "Hers", "placement": "here" }),
    )
    .await;
    state
        .access
        .set_exception(
            crate::access::FiledKind::Role,
            &hers,
            &owner,
            crate::access::Level::Viewer,
        )
        .await
        .unwrap();

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sp",
            "spawn",
            serde_json::json!({ "role": "Engineer", "goal": "do the thing" }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("Engineer") && refused.contains("more than one"),
        "it names the ambiguity rather than starting one of them: {refused}"
    );
    assert!(
        state.db.children_of(&lead).await.unwrap().is_empty(),
        "and no child was started — allowance is spent on a spawn that picks wrong"
    );

    // The team list in the *not-found* refusal: one entry per name, the
    // collision marked rather than printed twice.
    let listed = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sp2",
            "spawn",
            serde_json::json!({ "role": "Nobody", "goal": "do the thing" }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        listed.contains("Engineer (2 profiles share this name)"),
        "the collision is marked: {listed}"
    );
    assert!(
        !listed.contains("Engineer, Engineer"),
        "and not printed twice, which reads as a bug: {listed}"
    );

    // An unambiguous name still spawns, which is the half not to break.
    crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sp3",
            "spawn",
            serde_json::json!({ "role": "Ada, the lead", "goal": "do the thing" }),
        ),
    )
    .await
    .expect("a name only one profile answers to is still a handle");

    state.fleet.stop_supervising(&host.id).await;
}

// ── A machine that restarted under the work ──────────────────────────────
//
// The incident: a Mac mini rebooted with four leads and eight team agents on
// it, came back, and left all twelve under "Working — nothing heard for
// 18000s". Everything below is one of the things that has to be true for that
// not to happen again, driven through the real wire protocol and the real
// database.

/// One session on this machine, mid-turn, with a line of transcript behind it.
///
/// The line matters: the worker only reports a session stranded once the
/// control plane has heard something from its agent, because a session nothing
/// has ever been heard from is one that is still being built.
async fn an_agent_at_work(it: &Machine, title: &str) -> ft_core::SessionId {
    let id = ft_core::SessionId::new();
    it.state
        .db
        .insert_session(
            &id,
            &it.host.id,
            &it.owner,
            None,
            title,
            "do the work",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
    it.state
        .db
        .record_agent_line(&id, 1, r#"{"type":"assistant"}"#)
        .await
        .unwrap();
    it.state
        .fleet
        .set_status(&id, ft_core::SessionStatus::Working, None)
        .await;
    id
}

/// A stranded session belonging to somebody else, in the same lead's family.
///
/// Its own account, so the caller has writer on nothing of theirs — which is
/// the shape of the escalation: a lead is shared, its children are not, and a
/// child carries the subscription its own owner pinned to it.
async fn someone_elses_child(it: &Machine, title: &str) -> ft_core::SessionId {
    let org = ft_core::OrgId::from_stored(it.state.db.org().await.unwrap());
    // Named for the session, so a test that needs two of these gets two
    // people rather than a collision.
    let who = format!("ana{}", ft_core::SessionId::new().as_str().to_lowercase());
    let ana = it
        .state
        .accounts
        .create_user(&org, &who, &format!("{who}@example.test"), "member")
        .await
        .unwrap()
        .0;
    let id = ft_core::SessionId::new();
    it.state
        .db
        .insert_session(
            &id,
            &it.host.id,
            ana.id.as_str(),
            None,
            title,
            "do the work",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
    it.state
        .db
        .record_agent_line(&id, 1, r#"{"type":"assistant"}"#)
        .await
        .unwrap();
    it.state
        .fleet
        .set_status(&id, ft_core::SessionStatus::Working, None)
        .await;
    id
}

/// How many times the worker has been told to start this session's agent.
///
/// Off the wire, because that is the only place the answer is: a refusal that
/// happens after the launch frame has gone is not a refusal. Counted rather
/// than asked as a yes or no, because a child is started once when it is
/// spawned — so what a test about *not* starting it has to show is that the
/// number did not move.
fn starts_of(launched: &Launches, id: &ft_core::SessionId) -> usize {
    launched
        .lock()
        .unwrap()
        .iter()
        .filter(|s| &s.session_id == id)
        .count()
}

fn it_started(launched: &Launches, id: &ft_core::SessionId) -> bool {
    starts_of(launched, id) > 0
}

async fn status_of(state: &AppState, id: &ft_core::SessionId) -> ft_core::SessionStatus {
    state
        .db
        .session_status(id)
        .await
        .unwrap()
        .expect("the session is there")
}

/// Wait for a status the worker is about to report.
///
/// A poll rather than a sleep, because what is being waited for is a frame
/// crossing a duplex stream and a row being written — microseconds in
/// practice, and a fixed sleep would be either flaky or slow.
async fn settles_at(state: &AppState, id: &ft_core::SessionId, want: ft_core::SessionStatus) {
    for _ in 0..200 {
        if status_of(state, id).await == want {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!(
        "{id} stayed {:?} instead of reaching {want:?}",
        status_of(state, id).await
    );
}

/// Wait until an event the worker sent has been *recorded*, whatever it did to
/// the status.
///
/// This is what makes "it did not change" a fact rather than a guess:
/// `write_event` writes the row and applies the status change in one
/// transaction, so once the row is there, whatever the predicate decided about
/// the status has already been decided.
async fn recorded(state: &AppState, id: &ft_core::SessionId, events: usize) {
    for _ in 0..200 {
        let seen = state
            .db
            .events_since(0)
            .await
            .unwrap()
            .iter()
            .filter(|e| &e.session_id == id)
            .count();
        if seen >= events {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("{id} never recorded {events} events");
}

/// Criterion 1 and criterion 2, which are one test because they are one
/// decision: the control plane has to act on the worker's verdict, and only on
/// the worker's verdict.
///
/// The frames are the real ones. `AgentClosed { Stranded }` is what a worker
/// sends when there was no agent socket to connect to *and* tmux has no
/// session for it; `AgentUnwatched` is what it sends in every other case,
/// including the three that must leave a live agent alone — a worker process
/// that restarted, a dropped network, and a tmux probe that could not be read.
#[tokio::test]
async fn a_machine_that_restarted_strands_its_work_and_nothing_else_does() {
    let it = a_machine().await;
    let stranded = an_agent_at_work(&it, "mid-turn when the machine went").await;
    let alive = an_agent_at_work(&it, "on a machine that never went").await;

    it.says
        .send(ToServer::AgentClosed {
            session_id: stranded.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &stranded, ft_core::SessionStatus::Stranded).await;

    // "Machine restarted", and said without anybody opening the session: this
    // is the reconnect path, and nothing in it waits for a browser.
    assert_eq!(
        ft_core::SessionStatus::Stranded.label(),
        "Machine restarted"
    );
    let note = it
        .state
        .db
        .session(&stranded)
        .await
        .unwrap()
        .unwrap()
        .note
        .unwrap_or_default();
    assert_eq!(note, "The machine restarted. The workspace is still there.");

    // And it is still a session the next reconnect asks the worker to watch.
    // `Failed` is excluded from that list, which is why this is not `Failed`:
    // marked wrong once, an agent would never be followed again.
    assert!(
        it.state
            .db
            .live_session_ids_on(&it.host.id)
            .await
            .unwrap()
            .contains(&stranded),
        "a stranded session is still watched, so a mistake here is recoverable"
    );

    // The watcher stopping is not the agent going. This is the frame a worker
    // sends for a session whose agent it cannot read but whose tmux is still
    // there, and the only right answer to it is nothing at all.
    it.says
        .send(ToServer::AgentUnwatched {
            session_id: alive.clone(),
        })
        .unwrap();
    // And then the one frame that does mean its process ended, on the same
    // ordered stream. Reaching `Failed` is what proves the unwatch above was
    // handled and did nothing: a session wrongly stranded by it could not get
    // here, because `Stranded` is not a state an exit moves.
    it.says
        .send(ToServer::AgentClosed {
            session_id: alive.clone(),
            gone: ft_proto::Gone::Exited,
        })
        .unwrap();
    settles_at(&it.state, &alive, ft_core::SessionStatus::Failed).await;
    assert_eq!(
        it.state
            .db
            .session(&alive)
            .await
            .unwrap()
            .unwrap()
            .note
            .unwrap_or_default(),
        "The agent exited. Any permission questions were cancelled.",
        "an agent that really did exit still says so in its own words"
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// Criterion 4, both ways round. The riskiest line in this change.
///
/// A worker that reconnects replays what the control plane missed, and after a
/// reboot that includes the last `StatusChanged { Working }` from before the
/// crash. It is new to this database, so nothing dedupes it; applied, it would
/// put the spinner back with nothing left to correct it. And the guard has to
/// be narrow enough that a real recovery still works, because the recovery
/// ends in the agent reporting exactly the same status.
#[tokio::test]
async fn a_stale_replay_cannot_un_strand_and_a_real_recovery_still_can() {
    let it = a_machine().await;
    let session = an_agent_at_work(&it, "cut off mid-sentence").await;

    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;

    // The replay. Written from the worker's own log, with the sequence number
    // it had before the machine went down.
    it.says
        .send(ToServer::Event {
            seq: 1,
            session_id: session.clone(),
            kind: ft_core::EventKind::StatusChanged {
                status: ft_core::SessionStatus::Working,
                note: None,
            },
            at: chrono::Utc::now() - chrono::TimeDelta::minutes(5),
        })
        .unwrap();
    recorded(&it.state, &session, 3).await;
    assert_eq!(
        status_of(&it.state, &session).await,
        ft_core::SessionStatus::Stranded,
        "a pre-crash event must not put a stranded session back to work"
    );

    // And not through the doorway either. `Starting` is the one status that
    // leaves `Stranded`, so a worker saying it — a relaunch that was in flight
    // when the machine went, replayed — would walk the session out and leave
    // the `Working` behind it in the same replay an ordinary legal move.
    it.says
        .send(ToServer::Event {
            seq: 2,
            session_id: session.clone(),
            kind: ft_core::EventKind::StatusChanged {
                status: ft_core::SessionStatus::Starting,
                note: None,
            },
            at: chrono::Utc::now() - chrono::TimeDelta::minutes(4),
        })
        .unwrap();
    recorded(&it.state, &session, 4).await;
    assert_eq!(
        status_of(&it.state, &session).await,
        ft_core::SessionStatus::Stranded,
        "only the control plane may say a stranded session is starting"
    );

    // Now the recovery somebody pressed, which is the only way out: the
    // control plane sets `Starting` itself, and the agent's own `Working`
    // arrives against that.
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let Json(done) = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(session.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({})).unwrap()),
    )
    .await
    .expect("a stranded session can be started again");
    assert!(done.detail.contains("starting again"), "{}", done.detail);
    assert_eq!(
        status_of(&it.state, &session).await,
        ft_core::SessionStatus::Starting
    );

    it.says
        .send(ToServer::Event {
            seq: 3,
            session_id: session.clone(),
            kind: ft_core::EventKind::StatusChanged {
                status: ft_core::SessionStatus::Working,
                note: None,
            },
            at: chrono::Utc::now(),
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Working).await;

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// Criteria 5 and 6: a lead that comes back takes a turn on its own, out of
/// what its children finished while it was down.
///
/// Nothing types anything here, which is the point. `relaunch` sends the agent
/// an empty prompt — it is being picked up, not opened — so without a drain
/// the lead comes back, reads its history, and sits in front of results it is
/// never handed.
#[tokio::test]
async fn recovering_a_lead_brings_its_team_back_and_hands_it_their_work() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();

    let lead = an_agent_at_work(&it, "the lead").await;
    let child = an_agent_at_work(&it, "one of its team").await;
    let elsewhere = an_agent_at_work(&it, "somebody else's agent").await;
    it.state
        .db
        .set_lineage(&child, &lead, Some("split the work"), None)
        .await
        .unwrap();

    // What the child finished before the machine went, durable in `deliveries`
    // and unread.
    it.state
        .db
        .queue_delivery(&lead, Some(&child), "what the child found")
        .await
        .unwrap();

    for session in [&lead, &child, &elsewhere] {
        it.says
            .send(ToServer::AgentClosed {
                session_id: session.clone(),
                gone: ft_proto::Gone::Stranded,
            })
            .unwrap();
    }
    for session in [&lead, &child, &elsewhere] {
        settles_at(&it.state, session, ft_core::SessionStatus::Stranded).await;
    }

    let Json(done) = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(lead.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({ "family": true })).unwrap()),
    )
    .await
    .expect("the family comes back");
    assert_eq!(done.detail, "2 agents are starting again");

    // The team first and the lead last, so a lead that comes back finds its
    // children running rather than missing.
    let order: Vec<ft_core::SessionId> = it
        .launched
        .lock()
        .unwrap()
        .iter()
        .map(|spec| spec.session_id.clone())
        .collect();
    assert_eq!(order, vec![child.clone(), lead.clone()]);
    assert!(
        !order.contains(&elsewhere),
        "a family is the family: nothing else on the machine is touched"
    );
    assert_eq!(
        status_of(&it.state, &elsewhere).await,
        ft_core::SessionStatus::Stranded
    );

    // And the child's report reaches the lead with nobody typing. The drain is
    // spawned behind the pause the agent's socket needs, so this is the one
    // thing here worth waiting for.
    let told = |text: &str| {
        it.turns
            .lock()
            .unwrap()
            .iter()
            .any(|(session, said)| session == &lead && said.contains(text))
    };
    for _ in 0..400 {
        if told("what the child found") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        told("what the child found"),
        "a lead brought back is handed what its team finished while it was down"
    );
    assert!(
        it.state.db.take_deliveries(&lead).await.unwrap().is_empty(),
        "and the queue is empty afterwards, because it was read"
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// Criterion 9: a recovery that will not start leaves the session stranded,
/// with the reason in its note.
///
/// `Failed` would be wrong twice over: it tells the control plane the session
/// holds nothing — while the worktree, the branch and the uncommitted edits
/// are all still on the machine — and it makes the next keystroke restart the
/// agent, which is the auto-recovery this feature deliberately does not have.
#[tokio::test]
async fn a_recovery_that_will_not_start_leaves_it_stranded_with_the_reason() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let session = an_agent_at_work(&it, "a worktree with a lock in it").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;

    *it.launch_refuses.lock().unwrap() = Some("git: index.lock exists in the worktree".to_string());

    let error = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(session.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({})).unwrap()),
    )
    .await
    .expect_err("the machine refused it");
    assert!(error.message.contains("index.lock"), "{}", error.message);

    assert_eq!(
        status_of(&it.state, &session).await,
        ft_core::SessionStatus::Stranded,
        "the attempt did not take; nothing about the workspace changed"
    );
    let note = it
        .state
        .db
        .session(&session)
        .await
        .unwrap()
        .unwrap()
        .note
        .unwrap_or_default();
    assert!(note.starts_with("Didn’t restart:"), "{note}");
    assert!(note.contains("index.lock"), "{note}");

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// Criterion 10: ending a stranded workspace does not take its conversation
/// with it inside the minute.
///
/// Both copies go at once otherwise — `purge_workspace` deletes the row and
/// the cascade takes `agent_lines`, while the transcript in the workspace goes
/// with the worktree. For a session somebody ends *because* its machine
/// restarted, that is the whole record of the work deleted in the same minute
/// as the decision to let the directory go.
#[tokio::test]
async fn ending_a_stranded_workspace_keeps_its_conversation() {
    let it = a_machine().await;
    let session = an_agent_at_work(&it, "not worth bringing back").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;

    // Letting it go. The one move out of `Stranded` other than a restart.
    it.state
        .fleet
        .set_status(&session, ft_core::SessionStatus::Ended, None)
        .await;
    assert_eq!(
        crate::reclaim::sweep(&it.state).await.unwrap(),
        0,
        "the sweep runs every sixty seconds; it must not take this one"
    );
    let lines: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_lines WHERE session_id = $1")
        .bind(session.as_str())
        .fetch_one(it.state.db.pool())
        .await
        .unwrap();
    assert_eq!(lines, 1, "the conversation is still there to read");

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// The consent model, through the side door a lead already has a key to.
///
/// `children` with `switch` moves a child onto another subscription, and the
/// switch stops the agent and starts it again — through `switch_for`,
/// `continue_with_account` and then `relaunch`. Stopping an agent that is
/// already absent *succeeds*, so a child whose machine restarted would have
/// come back with no person anywhere in the operation: the lead survived
/// somewhere else, read its own history, and rerouted quota.
///
/// Prior permission to move somebody's allowance is not permission to recover
/// from a machine failure, and the second is the one this release made a
/// decision about. Refused at the switch so the answer says what to do, and
/// refused again at the launch, which is where it is enforced.
#[tokio::test]
async fn a_lead_cannot_bring_a_stranded_child_back_by_switching_its_subscription() {
    let (state, _principal, host, ready, owner, launched) = watched_fixture().await;
    let lead = a_lead_that_delegates(&state, &host, &ready, &owner, Agent::ClaudeCode).await;
    let account = a_subscription(&state, &owner, "a_other", Agent::ClaudeCode).await;
    saved_profile(
        &state,
        &owner,
        serde_json::json!({
            "name": "Engineer",
            "does": "Writes the change and the tests",
            "placement": "here",
            "agent": "ClaudeCode",
            // The rung that lets a lead reroute without asking anybody.
            "onUsageLimit": "same",
        }),
    )
    .await;
    let child = a_child_that_ran_out(&state, &host, &lead, "sp1", "Engineer").await;
    // Everything else about this switch is in order: the machine has the
    // agent, the account is usable, the profile allows the reroute. The one
    // thing wrong with it is the thing under test.
    says_it_has(&state, &host, &[(Agent::ClaudeCode, true)]).await;

    // And then the machine under it restarted.
    state
        .fleet
        .set_status(&child.id, ft_core::SessionStatus::Stranded, None)
        .await;
    // It was started once, when it was spawned. That is the number that must
    // not move.
    let started_once = starts_of(&launched, &child.id);

    let refused = crate::delegate::handle(
        &state,
        &asks(
            &host,
            &lead,
            "sw1",
            "children",
            serde_json::json!({ "action": "switch", "id": child.id.as_str(), "account": account }),
        ),
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(
        refused.contains("Bring it back first"),
        "it says what a person has to do, and that the lead cannot: {refused}"
    );
    assert_eq!(
        status_of(&state, &child.id).await,
        ft_core::SessionStatus::Stranded,
        "nothing started, and the state that holds the consent still holds it"
    );
    assert_eq!(
        starts_of(&launched, &child.id),
        started_once,
        "no second agent was launched for it"
    );

    state.fleet.stop_supervising(&host.id).await;
}

/// A stranded child this person may see and may not start.
///
/// Shared with them at viewer, which is the one case where saying "1 isn't
/// yours to start" tells them nothing they did not already know.
async fn a_child_they_may_only_watch(
    it: &Machine,
    lead: &ft_core::SessionId,
) -> ft_core::SessionId {
    let id = someone_elses_child(it, "a child shared with me").await;
    it.state
        .db
        .set_lineage(&id, lead, Some("split the work"), None)
        .await
        .unwrap();
    let workspace = it
        .state
        .db
        .session(&id)
        .await
        .unwrap()
        .unwrap()
        .workspace_id
        .unwrap();
    // A viewer grant on the place it lives in, which is how one is shared.
    it.state
        .access
        .set_exception(
            crate::access::FiledKind::Workspace,
            workspace.as_str(),
            &it.owner,
            crate::access::Level::Viewer,
        )
        .await
        .unwrap();
    id
}

/// Criterion 1 of the security review: one press on a lead reaches exactly as
/// far as the person pressing it can.
///
/// `children_of` answers for the control plane acting on a lead's behalf — its
/// own doc says it is never for a handler acting for a person — so a family
/// recovery that trusted it started children the caller had no business
/// starting, on the subscriptions pinned to them. The endpoint had checked one
/// session: the one they named.
#[tokio::test]
async fn a_family_recovery_only_starts_the_children_the_caller_may_operate() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();

    let lead = an_agent_at_work(&it, "the lead").await;
    let mine = an_agent_at_work(&it, "a child of mine").await;
    let theirs = someone_elses_child(&it, "a child somebody else owns").await;
    for child in [&mine, &theirs] {
        it.state
            .db
            .set_lineage(child, &lead, Some("split the work"), None)
            .await
            .unwrap();
    }
    for session in [&lead, &mine, &theirs] {
        it.says
            .send(ToServer::AgentClosed {
                session_id: session.clone(),
                gone: ft_proto::Gone::Stranded,
            })
            .unwrap();
        settles_at(&it.state, session, ft_core::SessionStatus::Stranded).await;
    }

    let Json(done) = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(lead.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({ "family": true })).unwrap()),
    )
    .await
    .expect("the family comes back");

    assert!(
        it_started(&it.launched, &mine),
        "the child this person may operate came back"
    );
    assert!(
        !it_started(&it.launched, &theirs),
        "and the one they may not was not started on somebody else's subscription"
    );
    assert_eq!(
        status_of(&it.state, &theirs).await,
        ft_core::SessionStatus::Stranded,
        "it is left exactly where it was"
    );
    // Nothing said about it, because this person cannot see it exists.
    //
    // `session_of` answers absent rather than refused for exactly that
    // reason, and a count would hand back what the 404 withheld.
    assert_eq!(done.detail, "2 agents are starting again");

    // One they *can* see and still may not start is a different matter: they
    // know it is there, so saying it was left alone tells them nothing new and
    // stops the button lying about what it did.
    let watched = a_child_they_may_only_watch(&it, &lead).await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: watched.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &watched, ft_core::SessionStatus::Stranded).await;
    it.state
        .fleet
        .set_status(&lead, ft_core::SessionStatus::Stranded, None)
        .await;

    let Json(again) = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(lead.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({ "family": true })).unwrap()),
    )
    .await
    .expect("the family comes back");
    assert_eq!(again.detail, "1 starting again. 1 isn’t yours to start.");
    assert!(
        !it_started(&it.launched, &watched),
        "and watching it is still not starting it"
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// The consent survives a stale snapshot, which is the shape the check used to
/// have and the reason it was not enough.
///
/// Every handler works from a `Session` it fetched. A switch validates an
/// account, stops an agent and replays its controls before anything launches,
/// and a machine can go under it in that time — so the status being checked
/// was true when it was read and false when it was used. The guard is at the
/// launch now, under the claim that serialises it, and reads the row rather
/// than the argument.
#[tokio::test]
async fn a_session_stranded_after_it_was_read_is_still_refused_at_the_launch() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let id = an_agent_at_work(&it, "fine when it was read").await;

    // What a handler is holding: a snapshot taken while it was working.
    let stale = it.state.db.session(&id).await.unwrap().unwrap();
    assert_eq!(stale.status, ft_core::SessionStatus::Working);

    // And the machine goes, after that read and before the launch.
    it.says
        .send(ToServer::AgentClosed {
            session_id: id.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &id, ft_core::SessionStatus::Stranded).await;

    let refused = sessions::relaunch(&it.state, &stale, &it.owner, crate::fleet::Recovering::No)
        .await
        .expect_err("the row says stranded, whatever the argument says");
    assert!(
        refused.message.contains("Bring it back first"),
        "{}",
        refused.message
    );
    assert!(
        !it_started(&it.launched, &id),
        "nothing was launched for it"
    );
    assert_eq!(
        status_of(&it.state, &id).await,
        ft_core::SessionStatus::Stranded
    );

    // And the recovery somebody pressed still works from the same stale
    // snapshot: what is refused is the claim, not the fetch.
    sessions::relaunch(&it.state, &stale, &it.owner, crate::fleet::Recovering::Yes)
        .await
        .expect("a recovery is the one thing that may");
    assert!(it_started(&it.launched, &id), "it came back");

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// Two recoveries of one session, where the second arrives while the first is
/// still starting.
///
/// The worker's launch takes the tmux session named for a session id, so the
/// second start does not make a second agent — it takes the first one's place
/// while it is still coming up, and the workspace is left with whichever won.
///
/// Asserted against the claim being held rather than by racing two requests:
/// with an instant worker there is no window to race *into*, and what has to
/// be true is that a launch is refused for as long as one is in flight.
#[tokio::test]
async fn a_second_start_is_refused_while_one_is_in_flight() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let id = an_agent_at_work(&it, "pressed twice").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: id.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &id, ft_core::SessionStatus::Stranded).await;

    let press = async || {
        sessions::relaunch_session(
            State(it.state.clone()),
            Extension(it.principal.clone()),
            Path(id.as_str().to_string()),
            Query(serde_json::from_value(serde_json::json!({})).unwrap()),
        )
        .await
    };

    // One in flight, as it is for as long as the worker takes to answer.
    let held = it
        .state
        .fleet
        .claim_start(&id, crate::fleet::Recovering::Yes)
        .await
        .expect("nothing is starting it yet");

    let refused = press().await.expect_err("while one is already starting");
    assert!(
        refused.message.contains("already starting"),
        "{}",
        refused.message
    );
    assert!(
        !it_started(&it.launched, &id),
        "and nothing reached the worker"
    );

    // And when that one is done — this is a drop; in a launch it is the end
    // of the launch, whichever way it ended — the way back is open again.
    drop(held);
    let _ = press().await.expect("the next press may start it");
    assert_eq!(
        starts_of(&it.launched, &id),
        1,
        "the worker was asked exactly once"
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// QA's bug 2: a recovery that fails tells the person the reason, **and**
/// writes it down.
///
/// It did one or the other. The failures before the launch — the agent not
/// installed, the host not answering, the host gone — returned through `?`
/// above the note, so the reason was on the screen of whoever pressed and
/// nowhere else: a reload, another screen, or a colleague opening the
/// conversation saw "The machine restarted" and no sign that anything had been
/// tried. The note is the only part of a refusal that outlives the request.
#[tokio::test]
async fn a_recovery_refused_before_it_launches_still_writes_down_why() {
    let it = a_machine().await;
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let session = an_agent_at_work(&it, "on a machine with no agent on it").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;

    // The machine is up and has no Claude Code on it, which is `require_ready`
    // refusing — before anything is launched and before anything used to be
    // written.
    it.ready.store(false, Ordering::SeqCst);

    let refused = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(session.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({})).unwrap()),
    )
    .await
    .expect_err("the machine cannot run it");

    let note = it
        .state
        .db
        .session(&session)
        .await
        .unwrap()
        .unwrap()
        .note
        .unwrap_or_default();
    assert!(
        note.starts_with("Didn’t restart:"),
        "the reason outlives the request. refused with: {} / note: {note}",
        refused.message
    );
    assert!(
        note.contains("not ready") || note.contains("Claude Code"),
        "and it is the reason, not a shrug: {note}"
    );
    assert_eq!(
        status_of(&it.state, &session).await,
        ft_core::SessionStatus::Stranded,
        "nothing about the workspace changed, so nothing about the state does"
    );
    assert!(
        refused.message.contains("not ready") || refused.message.contains("Claude Code"),
        "and the person who pressed it is told the same thing: {}",
        refused.message
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// And a launch the machine refuses is not a 500.
///
/// `anyhow::Error` into `ApiError` is `Internal`, which is a 500, which an
/// interface draws as nothing — because there is nothing in a 500 worth
/// drawing. A machine refusing to start an agent is not a fault in this
/// control plane: it is the answer to the thing we asked it to do, in its own
/// words, and it has a code of its own.
#[tokio::test]
async fn a_launch_the_machine_refuses_is_the_machines_answer_not_a_server_fault() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let session = an_agent_at_work(&it, "whose worktree was removed").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;

    *it.launch_refuses.lock().unwrap() =
        Some("the workspace at /home/agent/work is not there any more".to_string());

    let refused = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(session.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({})).unwrap()),
    )
    .await
    .expect_err("the machine refused it");

    assert_eq!(
        refused.code.status(),
        axum::http::StatusCode::CONFLICT,
        "not a 500: a page with nothing on it is what an interface draws for one"
    );
    let note = it
        .state
        .db
        .session(&session)
        .await
        .unwrap()
        .unwrap()
        .note
        .unwrap_or_default();
    assert!(note.contains("not there any more"), "{note}");
    assert_eq!(
        status_of(&it.state, &session).await,
        ft_core::SessionStatus::Stranded
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// A second press while the first is still starting writes nothing down.
///
/// The note belongs to the attempt that was made. A press that was refused
/// *before* anything was attempted has nothing to say about the workspace, and
/// writing one would overwrite the reason belonging to the launch that is
/// still in flight — on a row that is `Starting` because that launch moved it.
#[tokio::test]
async fn a_press_that_never_got_the_claim_leaves_the_note_alone() {
    let it = a_machine().await;
    it.ready.store(true, Ordering::SeqCst);
    it.state
        .db
        .mark_host_online(
            &it.host.id,
            "test",
            4,
            8192,
            &ft_core::DockerState::running("27.0.3"),
        )
        .await
        .unwrap();
    let session = an_agent_at_work(&it, "pressed twice").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;
    let before = it.state.db.session(&session).await.unwrap().unwrap().note;

    let held = it
        .state
        .fleet
        .claim_start(&session, crate::fleet::Recovering::Yes)
        .await
        .expect("nothing is starting it yet");
    let refused = sessions::relaunch_session(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(session.as_str().to_string()),
        Query(serde_json::from_value(serde_json::json!({})).unwrap()),
    )
    .await
    .expect_err("one is already starting");
    assert!(refused.message.contains("already starting"));
    assert_eq!(
        it.state.db.session(&session).await.unwrap().unwrap().note,
        before,
        "nothing was attempted, so nothing is written down about it"
    );
    drop(held);

    it.state.fleet.stop_supervising(&it.host.id).await;
}

/// QA's bug 3: a message to a stranded session is refused rather than dropped.
///
/// It answered 200 `{"sent":true}` and the text appeared in the transcript as
/// a user bubble read by nobody. The desktop cannot reach it — the composer is
/// replaced by the recovery card — but the phone has the label and the beat
/// and no gate, so on a phone it is reachable by typing. A rule held in one
/// interface is a rule the next surface has not been told about.
#[tokio::test]
async fn a_message_to_a_stranded_session_is_refused_rather_than_swallowed() {
    let it = a_machine().await;
    let session = an_agent_at_work(&it, "nobody is listening").await;
    it.says
        .send(ToServer::AgentClosed {
            session_id: session.clone(),
            gone: ft_proto::Gone::Stranded,
        })
        .unwrap();
    settles_at(&it.state, &session, ft_core::SessionStatus::Stranded).await;

    let refused = conversation::send_turn(
        State(it.state.clone()),
        Extension(it.principal.clone()),
        Path(session.as_str().to_string()),
        Json(serde_json::from_value(serde_json::json!({ "text": "hello?" })).unwrap()),
    )
    .await
    .expect_err("there is nothing to say it to");
    assert!(
        refused.message.contains("Bring it back first"),
        "and it says what to do instead: {}",
        refused.message
    );
    assert!(
        it.turns
            .lock()
            .unwrap()
            .iter()
            .all(|(said_to, _)| said_to != &session),
        "nothing reached the machine"
    );

    it.state.fleet.stop_supervising(&it.host.id).await;
}
