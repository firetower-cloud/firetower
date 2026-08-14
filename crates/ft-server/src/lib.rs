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
pub mod transport;
pub mod vault;

pub use api::ApiDoc;
use db::Db;
use fleet::Fleet;
use vault::Vault;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub fleet: Fleet,
    /// Every credential Firetower holds, encrypted, with a log of every read.
    ///
    /// Shared rather than cloned: it holds the root key, and one copy of that
    /// in memory is enough.
    pub vault: Arc<Vault>,
    /// Which of the two places the root key came from, in words. Where it is,
    /// not what it is — someone has to be able to answer "what do I back up?".
    pub key_source: Arc<str>,
    /// Where this machine's own worker keeps its state. Only the local kind
    /// needs it; the others keep theirs on the far side.
    pub home: PathBuf,
    /// Authorizations waiting for someone to approve a code in a browser.
    ///
    /// In memory on purpose: an authorization nobody finished should not
    /// survive a restart, and there is nothing here worth persisting.
    pub pending: Arc<tokio::sync::RwLock<std::collections::HashMap<String, api::Pending>>>,
}

pub struct Config {
    pub home: PathBuf,
    /// Where the control plane's database lives.
    pub database_url: String,
    pub port: u16,
    /// In development the web application is served by its own dev server, so
    /// this process serves the API and permits its origin.
    pub dev: bool,
}

/// Start the control plane: open the cache, register `localhost` as a host,
/// connect its worker, and serve.
pub async fn run(config: Config) -> Result<()> {
    let db = Db::open(&config.database_url).await?;
    let fleet = Fleet::new(db.clone());

    // Before anything that might need a credential. A control plane that came
    // up without its key would look healthy and then fail at the first clone.
    let (root, source) = vault::root::load(&config.home).await?;
    if let vault::root::Source::NewFile(path) = &source {
        tracing::info!(
            "wrote a new root key to {}. Every credential is sealed with it: back it up \
             separately from the database, and losing it means adding them again",
            path.display()
        );
    } else {
        tracing::info!(source = %source, "root key");
    }

    let vault = Arc::new(Vault::new(db.pool().clone(), root));
    let key_source: Arc<str> = match source {
        vault::root::Source::Environment => "the FIRETOWER_ROOT_KEY variable".into(),
        vault::root::Source::File(_) | vault::root::Source::NewFile(_) => {
            "a file on this machine, outside the database".into()
        }
    };

    // localhost is a real host. It appears in the fleet, runs sessions, and can
    // be drained — the only thing it skips is the network.
    // This machine is always registered. A fresh install has somewhere to run
    // without anyone configuring anything; it can be removed deliberately.
    db.ensure_host("localhost", ft_core::Compute::Local).await?;

    // Every host, not just this one. A control plane that only reconnected to
    // itself would silently lose every server you added the moment it
    // restarted — and restarting is meant to cost nothing.
    for host in db.hosts().await? {
        let transport = match Fleet::transport_for(&host, &config.home) {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(host = %host.name, "no transport: {e:#}");
                continue;
            }
        };

        // A host we can't reach isn't fatal: its sessions stay visible, marked
        // unreachable, and the interface still works.
        if let Err(e) = fleet.connect(host.id.clone(), transport).await {
            tracing::warn!(host = %host.name, "not reachable at start-up: {e:#}");
        } else {
            tracing::info!(host = %host.name, kind = host.compute.label(), "connected");
        }
    }

    let state = AppState {
        db,
        fleet,
        vault,
        key_source,
        home: config.home.clone(),
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
        let db = Db::open_for_test().await.unwrap();
        let host = db
            .ensure_host("localhost", ft_core::Compute::Local)
            .await
            .unwrap();
        assert_eq!(host.name, "localhost");
        assert_eq!(host.compute, ft_core::Compute::Local);
    }
}
