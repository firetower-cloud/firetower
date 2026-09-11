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
    let host = db.ensure_host("native", native()).await.unwrap();
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
        container: None,
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
    let (state, _, host, ready, _) = fixture().await;
    let read = || {
        hosts::host_readiness(
            State(state.clone()),
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
    let (state, _, host, _, _) = fixture().await;
    state.fleet.stop_supervising(&host.id).await;
    let report = hosts::host_readiness(
        State(state),
        Path(host.id.to_string()),
        Query(hosts::ReadinessQuery { agent: None }),
    )
    .await
    .unwrap()
    .0;
    assert!(!report.ready());
    let remedy = report.checks[0].remedy.as_ref().unwrap();
    assert!(remedy.contains("Docker is not required"));
    assert!(!remedy.contains("firetower worker install"));
}

#[tokio::test]
async fn connecting_a_host_path_defers_validation_to_the_execution_machine() {
    let (state, principal, host, ready, _) = fixture().await;
    let local = state
        .db
        .ensure_host("localhost", Compute::Local)
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
fn both_machine_locations_use_the_selected_execution_transport() {
    for same_machine in [false, true] {
        for container in [None, Some("video-worker".to_string())] {
            let mut compute = native();
            if let Compute::Server {
                container: configured,
                ..
            } = &mut compute
            {
                *configured = container.clone();
            }
            let host: Host = serde_json::from_value(serde_json::json!({
                "id": "h_transport", "name": "video", "state": "Online", "compute": compute,
                "machine": if same_machine { Some("local") } else { None },
            }))
            .unwrap();
            let transport =
                crate::fleet::Fleet::transport_for(&host, std::path::Path::new("/tmp"), None)
                    .unwrap();
            let expected = if container.is_some() {
                "ssh editor@vm docker exec video-worker"
            } else {
                "ssh editor@vm"
            };
            assert_eq!(transport.describe(), expected);
        }
    }
}
