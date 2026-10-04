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
}
#[async_trait::async_trait]
impl Transport for Worker {
    fn describe(&self) -> String {
        "readiness fixture".into()
    }
    async fn connect(&self) -> anyhow::Result<Connection> {
        let (ours, theirs) = tokio::io::duplex(65536);
        let ready = self.ready.clone();
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
                    ToWorker::ProbeRemote { req, .. } => Some(ToServer::RemoteProbed {
                        req,
                        result: Err(ft_proto::ProbeFailure::NotARepository),
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
    let (db, owner) = crate::db::Db::open_for_test_owned().await.unwrap();
    let accounts = crate::accounts::Accounts::new(db.pool().clone());
    let principal = crate::auth::Principal {
        subject: "admin".into(),
        via: crate::auth::Via::Session,
        user: accounts.user_by_name("admin").await.unwrap(),
    };
    let host = db.ensure_host("native", native(), &owner).await.unwrap();
    let ready = Arc::new(AtomicBool::new(false));
    let fleet = crate::fleet::Fleet::new(db.clone());
    fleet
        .supervise(
            host.id.clone(),
            Arc::new(Worker {
                ready: ready.clone(),
            }),
        )
        .await;
    let vault = Arc::new(crate::vault::Vault::new(
        db.pool().clone(),
        crate::vault::crypto::RootKey::generate(),
    ));
    let names = crate::preview::Names::from_vault(&vault);
    let state = AppState {
        updates: crate::updates::Updates::new(db.pool().clone()),
        policy: crate::auth::Policy::open(),
        access: crate::access::Access::new(db.pool().clone()),
        db,
        accounts,
        fleet,
        vault,
        names,
        key_source: "test".into(),
        home: std::env::temp_dir(),
        pending: Default::default(),
        forwards: Default::default(),
        previews: Default::default(),
        public_url: "http://localhost".into(),
    };
    (state, principal, host, ready, owner)
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

#[tokio::test]
async fn connecting_a_host_path_defers_validation_to_the_execution_machine() {
    let (state, principal, host, ready, owner) = fixture().await;
    let local = state
        .db
        .ensure_host("localhost", Compute::Local, &owner)
        .await
        .unwrap();
    state
        .fleet
        .supervise(local.id.clone(), Arc::new(Worker { ready }))
        .await;
    let remote = "/home/editor/media-app";
    // The local worker would reject this repository; it exists only on the VM
    // that will be chosen at launch, so querying the control plane is wrong.
    let (_, Json(repo)) = repos::create_repo(
        State(state.clone()),
        Extension(principal),
        Json(repos::NewRepo {
            slug: "media-app".into(),
            remote: remote.into(),
            setup: None,
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
