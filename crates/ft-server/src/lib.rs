//! The Firetower control plane.
//!
//! Owns what *should* happen — the fleet, repositories, credentials, scheduling.
//! What actually happened belongs to the workers; everything here is a cache of
//! their event logs and can be rebuilt by reconnecting and replaying.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;

pub mod accounts;
pub mod api;
pub mod auth;
mod container;
pub mod db;
pub mod diagnose;
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
    /// Organisations, users, sessions and settings.
    pub accounts: accounts::Accounts,
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
    /// In development the web application is served by its own dev server, so
    /// this process serves the API and permits its origin.
    pub dev: bool,
}

/// Start the control plane: open the cache, register `localhost` as a host,
/// connect its worker, and serve.
pub async fn run(config: Config) -> Result<()> {
    // Before the database, because this is the check that can refuse to start
    // and it should refuse before it has done anything.
    let policy = auth::load()?;

    if !config.bind.is_loopback() && policy.is_open() {
        anyhow::bail!(
            "refusing to listen on {} with authentication turned off. Anything that can reach \
             that address could read every credential in the vault.\n\n\
             Unset {}, or put a proxy in front that authenticates and name its header in {}.",
            config.bind,
            auth::MODE_ENV,
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

    let accounts = accounts::Accounts::new(db.pool().clone());

    // Before the listener binds. A control plane that answered before it had an
    // owner would be claimable by whoever reached it first, which is how
    // self-hosted software gets taken over on its first boot.
    let admin = ensure_admin(&accounts).await?;

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
        accounts: accounts.clone(),
    };
    announce(&policy, admin.as_ref(), &config);

    let app = build_router(state, config.dev, policy, accounts);

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

/// Where to open a browser, as far as this process can tell.
///
/// Behind a proxy, it cannot tell: the control plane listens on 4400 inside a
/// container while the address people type is a domain on 443. So the answer is
/// configuration when there is any, and a guess only when there is not —
/// printing `localhost:4400` to someone whose Firetower is behind Caddy sends
/// them to a port nothing is published on.
pub const PUBLIC_URL_ENV: &str = "FIRETOWER_PUBLIC_URL";

fn public_url(config: &Config) -> String {
    if let Ok(url) = std::env::var(PUBLIC_URL_ENV) {
        let url = url.trim().trim_end_matches('/');
        if !url.is_empty() {
            return url.to_string();
        }
    }

    // In development the interface is on its own port, so the URL that works
    // is the dev server's rather than this one's.
    let port = if config.dev { 3000 } else { config.port };
    format!("http://localhost:{port}")
}

/// The variables that seed the first administrator.
pub const ADMIN_USERNAME_ENV: &str = "ADMIN_USERNAME";
pub const ADMIN_PASSWORD_ENV: &str = "ADMIN_INITIAL_PASSWORD";

/// What was created just now, so start-up can say it out loud once.
struct FirstAdmin {
    username: String,
    /// Only when we invented it. A password somebody supplied is theirs to
    /// know, and repeating it into the log would put it wherever the logs go.
    password: Option<String>,
}

/// Make sure somebody can sign in, before anything is listening.
///
/// From the environment when it says so, and otherwise invented and printed
/// once. Refusing to start would be the safer-looking answer and the wrong one:
/// `cargo run` and a bare `docker run` both have to work with no configuration
/// at all, and an operator who reads one line of output is better served than
/// one who has to go and find out what to set.
///
/// Either way the account is marked as needing a new password, so a credential
/// that came out of a file cannot quietly become the permanent one.
async fn ensure_admin(accounts: &accounts::Accounts) -> Result<Option<FirstAdmin>> {
    if accounts.any_user().await? {
        // Once somebody has signed in and chosen a password, the variables are
        // ignored — never re-applied, never compared. Editing an unrelated line
        // of a `.env` must not silently reset the administrator's password to
        // whatever is still written above it.
        return Ok(None);
    }

    let username = std::env::var(ADMIN_USERNAME_ENV)
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "admin".to_string());

    let supplied = std::env::var(ADMIN_PASSWORD_ENV)
        .ok()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());

    if let Some(password) = &supplied {
        // Refused rather than ignored. Quietly generating a password instead
        // would leave somebody who set one unable to sign in with it, and
        // unsure whether the variable was even read.
        accounts::check_password(password).with_context(|| {
            format!(
                "{ADMIN_PASSWORD_ENV} needs at least {} characters — it is the way into this \
                 Firetower. Lengthen it, or leave it empty and one will be generated and \
                 printed here.",
                accounts::MINIMUM_PASSWORD
            )
        })?;
    }

    let password = supplied.clone().unwrap_or_else(invent_password);
    accounts.create_first_admin(&username, &password).await?;

    Ok(Some(FirstAdmin {
        username,
        password: supplied.is_none().then_some(password),
    }))
}

/// Three words and a number: long enough to be a real password, and shaped to
/// survive being read off a terminal and typed into a browser once.
fn invent_password() -> String {
    use chacha20poly1305::aead::{AeadCore, OsRng};
    use chacha20poly1305::XChaCha20Poly1305;

    const WORDS: &[&str] = &[
        "amber", "anchor", "beacon", "cedar", "cobalt", "copper", "ember", "harbor", "hollow",
        "ivory", "kestrel", "lantern", "meadow", "onyx", "quarry", "quiet", "ridge", "river",
        "saffron", "silver", "summit", "thicket", "timber", "velvet", "walnut", "willow",
    ];

    let noise = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let pick = |i: usize| WORDS[noise[i] as usize % WORDS.len()];

    format!(
        "{}-{}-{}-{}",
        pick(0),
        pick(1),
        pick(2),
        100 + (u16::from(noise[3]) % 900)
    )
}

/// Say where it is and, on the very first start, how to get in.
fn announce(policy: &auth::Policy, admin: Option<&FirstAdmin>, config: &Config) {
    tracing::info!("authentication: {}", policy.describe());

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

    let Some(admin) = admin else {
        return;
    };

    match &admin.password {
        // We invented it, so this is the only time anybody will see it.
        Some(password) => {
            eprintln!("  There was no administrator, so one was made:");
            eprintln!();
            eprintln!("    username  {}", admin.username);
            eprintln!("    password  {password}");
            eprintln!();
            eprintln!("  It is not written down anywhere you can read it back, and Firetower");
            eprintln!("  will ask you to replace it as soon as you sign in.");
        }
        // It came from a file. Saying it again would only spread it.
        None => {
            eprintln!(
                "  The administrator `{}` was created from {ADMIN_PASSWORD_ENV}.",
                admin.username
            );
            eprintln!("  Sign in and replace that password — then remove it from the file.");
        }
    }
    eprintln!();
    eprintln!("  {}", public_url(config));
    eprintln!();
}

fn build_router(
    state: AppState,
    dev: bool,
    policy: auth::Policy,
    accounts: accounts::Accounts,
) -> axum::Router {
    let (router, _api) = api::router().with_state(state.clone()).split_for_parts();

    // Only the API. Whether the machine is up is not a secret, and a health
    // check that needs a credential is a health check that stops working the
    // day the credential is rotated.
    let gate = auth::Gate { policy, accounts };
    let api = router.layer(axum::middleware::from_fn_with_state(gate, auth::require));

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
