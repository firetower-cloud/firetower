//! The Firetower control plane.
//!
//! Owns what *should* happen — the fleet, repositories, credentials, scheduling.
//! What actually happened belongs to the workers; everything here is a cache of
//! their event logs and can be rebuilt by reconnecting and replaying.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;

pub mod api;
pub mod db;
pub mod fleet;
pub mod oauth;
pub mod providers;
pub mod secrets;
pub mod transport;

pub use api::ApiDoc;
use db::Db;
use fleet::Fleet;
use transport::LocalTransport;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub fleet: Fleet,
    /// Authorizations waiting for someone to approve a code in a browser.
    ///
    /// In memory on purpose: an authorization nobody finished should not
    /// survive a restart, and there is nothing here worth persisting.
    pub pending: Arc<tokio::sync::RwLock<std::collections::HashMap<String, api::Pending>>>,
}

pub struct Config {
    pub home: PathBuf,
    pub port: u16,
    /// In development the web application is served by its own dev server, so
    /// this process serves the API and permits its origin.
    pub dev: bool,
}

/// Start the control plane: open the cache, register `localhost` as a host,
/// connect its worker, and serve.
pub async fn run(config: Config) -> Result<()> {
    let db = Db::open(&config.home.join("firetower.db")).await?;
    let fleet = Fleet::new(db.clone());

    // localhost is a real host. It appears in the fleet, runs sessions, and can
    // be drained — the only thing it skips is the network.
    let host = db.ensure_host("localhost", None).await?;
    let transport = Arc::new(LocalTransport::new(config.home.join("worker"))?);

    if let Err(e) = fleet.connect(host.id.clone(), transport).await {
        // A host we can't reach isn't fatal: its sessions stay visible, marked
        // unreachable, and the interface still works.
        tracing::error!("could not start the local worker: {e:#}");
    }

    let state = AppState {
        db,
        fleet,
        pending: Default::default(),
    };
    let app = build_router(state, config.dev);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr} — is Firetower already running?"))?;

    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app).await.context("serving")?;
    Ok(())
}

fn build_router(state: AppState, dev: bool) -> axum::Router {
    let (router, _api) = api::router().with_state(state).split_for_parts();

    let mut app = router.layer(tower_http::trace::TraceLayer::new_for_http());

    if dev {
        // The web application is on its own port while developing.
        app = app.layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        );
    }

    app
}

#[cfg(test)]
mod tests {
    use super::*;
    use utoipa::OpenApi as _;

    #[tokio::test]
    async fn the_contract_is_generated_from_the_handlers() {
        let doc = serde_json::to_string(&ApiDoc::openapi()).unwrap();
        assert!(doc.contains("Firetower"));
    }

    #[tokio::test]
    async fn a_fresh_control_plane_registers_localhost() {
        let db = Db::open_ephemeral().await.unwrap();
        let host = db.ensure_host("localhost", None).await.unwrap();
        assert_eq!(host.name, "localhost");
        assert!(host.ssh_target.is_none());
    }
}
