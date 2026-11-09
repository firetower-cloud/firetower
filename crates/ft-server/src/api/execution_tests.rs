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
}

/// What the control plane told the worker to start.
type Launches = Arc<std::sync::Mutex<Vec<ft_proto::StartAgent>>>;
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
        tokio::spawn(async move {
            let (r, w) = tokio::io::split(theirs);
            let mut codec = Codec::new(r, w);
            while let Ok(frame) = codec.read::<ToWorker>().await {
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
                        Some(ToServer::ActionDone {
                            req,
                            result: Ok("started".into()),
                        })
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
    let (state, principal, host, ready, owner, _) = watched_fixture().await;
    (state, principal, host, ready, owner)
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
    let fleet = crate::fleet::Fleet::new(db.clone());
    fleet
        .supervise(
            host.id.clone(),
            Arc::new(Worker {
                ready: ready.clone(),
                probe: None,
                launched: launched.clone(),
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
    (state, principal, host, ready, owner, launched)
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
    sqlx::query(
        "INSERT INTO agent_account_limits(account_id,scope,status,used_percent,observed_at)
         VALUES('a_good','five_hour','allowed',24,now() - interval '11 minutes')",
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
