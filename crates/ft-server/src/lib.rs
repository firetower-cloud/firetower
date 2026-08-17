//! The Firetower control plane.
//!
//! Owns what *should* happen — the fleet, repositories, credentials, scheduling.
//! What actually happened belongs to the workers; everything here is a cache of
//! their event logs and can be rebuilt by reconnecting and replaying.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;

pub mod api;
pub mod auth;
mod container;
pub mod db;
pub mod diagnose;
pub mod dock;
pub mod fleet;
pub mod oauth;
pub mod providers;
pub mod transport;
pub mod vault;
mod web;

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
    /// Where workers that dial in arrive, and where the transports waiting for
    /// them are parked.
    pub dock: dock::Dock,
}

pub struct Config {
    pub home: PathBuf,
    /// Where the control plane's database lives.
    pub database_url: String,
    /// What to listen on. Loopback unless someone says otherwise — a default
    /// that is wrong in a container is better than one that is wrong on a
    /// laptop, because the container is configured deliberately and the laptop
    /// is not.
    pub bind: std::net::IpAddr,
    pub port: u16,
    /// Whether this machine is itself somewhere sessions can run.
    ///
    /// True on a workstation, where it is the whole point. False in a
    /// container, where the control plane holds every credential and agents
    /// belong somewhere that does not — an agent sharing a filesystem with the
    /// root key is the arrangement this project went out of its way to avoid.
    pub local_host: bool,
    /// What to call the worker that dials in, when one is configured.
    pub worker_name: String,
    /// In development the web application is served by its own dev server, so
    /// this process serves the API and permits its origin.
    pub dev: bool,
}

/// Start the control plane: open the cache, register `localhost` as a host,
/// connect its worker, and serve.
pub async fn run(config: Config) -> Result<()> {
    // Before the database, because this is the check that can refuse to start
    // and it should refuse before it has done anything.
    let (policy, token_source) = auth::load(&config.home).await?;

    if !config.bind.is_loopback() && policy.is_open() {
        anyhow::bail!(
            "refusing to listen on {} with no authentication. Anything that can reach that \
             address could read every credential in the vault.\n\n\
             Unset {} to have a token generated, supply one in {}, or put a proxy in front \
             that authenticates and name its header in {}.",
            config.bind,
            auth::MODE_ENV,
            auth::TOKEN_ENV,
            auth::HEADER_ENV,
        );
    }

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
    // This machine is registered on a workstation, where a fresh install then
    // has somewhere to run without anyone configuring anything. Not in a
    // container: there it would be an agent living beside the vault, and it
    // would come back every restart however often it was deleted.
    if config.local_host {
        db.ensure_host("localhost", ft_core::Compute::Local).await?;
    }

    // A worker this deployment was told to expect. The compose file's sidecar
    // is exactly this: no port opened towards it, no socket mounted, nothing
    // dialled out — it arrives on its own with a token they both hold.
    if let Some(token) = worker_token() {
        ensure_dialed_host(&db, &config.worker_name, &token).await?;
    }

    let dock = dock::Dock::new();

    // Every host, not just this one. A control plane that only reconnected to
    // itself would silently lose every server you added the moment it
    // restarted — and restarting is meant to cost nothing.
    for host in db.hosts().await? {
        let transport = match Fleet::transport_for(&host, &config.home, &dock).await {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(host = %host.name, "no transport: {e:#}");
                continue;
            }
        };

        // A host we can't reach isn't fatal: its sessions stay visible, marked
        // unreachable, and the interface still works. The supervisor keeps
        // trying in the background, so start-up waits for one attempt and no
        // more.
        fleet.supervise(host.id.clone(), transport).await;
        tracing::info!(host = %host.name, kind = host.compute.label(), "supervised");
    }

    let state = AppState {
        db,
        fleet,
        vault,
        key_source,
        home: config.home.clone(),
        pending: Default::default(),
        dock,
    };
    announce(&policy, &token_source, &config);

    let app = build_router(state, config.dev, policy);

    let addr = std::net::SocketAddr::new(config.bind, config.port);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr} — is Firetower already running?"))?;

    tracing::info!("listening on http://{addr}");

    // `into_make_service_with_connect_info` rather than the plain router: the
    // trusted-proxy header is only believed from certain addresses, and without
    // this there is no address to check it against.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .context("serving")?;
    Ok(())
}

/// The token a worker dials in with, if this deployment was given one.
pub const WORKER_TOKEN_ENV: &str = "FIRETOWER_WORKER_TOKEN";

fn worker_token() -> Option<String> {
    std::env::var(WORKER_TOKEN_ENV)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Make sure there is a host for the worker that will dial in, and that it
/// expects the token this deployment is configured with.
///
/// Rotating the token is therefore editing one variable and restarting: the
/// host keeps its identity, its history and its sessions, and only what it
/// authenticates with changes. Recreating it instead would orphan everything
/// that referred to it.
async fn ensure_dialed_host(db: &Db, name: &str, token: &str) -> Result<()> {
    let fingerprint = dock::fingerprint(token);

    let compute = ft_core::Compute::Dialed {
        token_hash: fingerprint.clone(),
        label: Some("dials in".to_string()),
    };

    let host = db.ensure_host(name, compute.clone()).await?;

    match &host.compute {
        ft_core::Compute::Dialed { token_hash, .. } if token_hash == &fingerprint => {}
        ft_core::Compute::Dialed { .. } => {
            tracing::info!(
                host = name,
                "the worker token changed; the host now expects the new one"
            );
            db.set_host_compute(&host.id, compute).await?;
        }
        other => {
            // Somebody added a host under this name by hand. Refusing beats
            // quietly converting a server they configured into something else.
            anyhow::bail!(
                "{WORKER_TOKEN_ENV} is set, but the host called {name} is a {} that was added \
                 another way. Rename one of them.",
                other.label()
            );
        }
    }

    Ok(())
}

/// Say how to get in, exactly once, at the only moment it is needed.
///
/// The token goes in a URL on the first start and never again: after that the
/// browser has it, and a credential printed on every restart ends up in
/// whatever collects the logs.
fn announce(policy: &auth::Policy, source: &auth::Source, config: &Config) {
    tracing::info!(source = %source, "authentication: {}", policy.describe());

    eprintln!();
    eprintln!("  Firetower");
    // What someone can actually type. A bound address of 0.0.0.0 is not a URL,
    // and printing it as one sends people to a page that never loads.
    if config.bind.is_loopback() {
        eprintln!("  http://localhost:{}", config.port);
    } else {
        eprintln!("  listening on {}:{}", config.bind, config.port);
    }
    if config.dev {
        eprintln!("  api only — the web application is on its own port");
    }
    eprintln!();

    let first_start = matches!(source, auth::Source::NewFile(_));
    if !first_start && !config.dev {
        return;
    }

    let Some(token) = policy.url_token() else {
        return;
    };

    // In development the interface is on its own port, so the URL that works is
    // the dev server's rather than this one's.
    let port = if config.dev { 3000 } else { config.port };

    eprintln!("  Open this once — it carries the token, and the browser keeps it:");
    eprintln!("  http://localhost:{port}/?t={token}");
    if first_start {
        eprintln!();
        eprintln!("  It is also in {}/token", config.home.display());
    }
    eprintln!();
}

fn build_router(state: AppState, dev: bool, policy: auth::Policy) -> axum::Router {
    let (router, _api) = api::router().with_state(state.clone()).split_for_parts();

    // Only the API. Whether the machine is up is not a secret, and a health
    // check that needs a credential is a health check that stops working the
    // day the credential is rotated.
    let api = router.layer(axum::middleware::from_fn_with_state(policy, auth::require));

    let mut app = axum::Router::new()
        .merge(api)
        .merge(operational(state))
        .layer(tower_http::trace::TraceLayer::new_for_http());

    if !dev {
        // The interface, from inside the binary. Deliberately outside the gate
        // above: the shell has to load before it can present the token, and
        // there is nothing in it worth protecting — every byte it shows comes
        // from an API call that is protected.
        app = app.fallback(web::serve);
    }

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

/// Liveness and readiness, deliberately outside the API contract.
///
/// They are for whatever restarts containers, not for the interface, and
/// putting them in the generated document would hand the web application two
/// operations it has no use for.
fn operational(state: AppState) -> axum::Router {
    use axum::routing::get;

    axum::Router::new()
        // Where a worker that dials in arrives. Outside `/api` and outside the
        // operator's gate: it is spoken by our own worker binary, which
        // authenticates with its own token and has never heard of the
        // interface's.
        .route("/workers/connect", get(dock::connect))
        // Up. Says nothing about whether it can work — that is the other one.
        .route("/healthz", get(|| async { "ok" }))
        // Up *and* able to answer. The distinction matters to a load balancer:
        // a control plane whose database has gone should stop being sent
        // requests without being killed and restarted into the same failure.
        .route(
            "/readyz",
            get(
                |axum::extract::State(state): axum::extract::State<AppState>| async move {
                    match state.db.ping().await {
                        Ok(()) => (axum::http::StatusCode::OK, "ready"),
                        Err(e) => {
                            tracing::warn!("not ready: {e:#}");
                            (axum::http::StatusCode::SERVICE_UNAVAILABLE, "database")
                        }
                    }
                },
            ),
        )
        .with_state(state)
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
