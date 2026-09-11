//! The Firetower updater.
//!
//! A side container with one privilege — the machine's Docker socket — and one
//! job: recreate the control plane, and itself, when the control plane asks.
//! It holds no key, no password and no database connection, and it decides
//! nothing on its own. See `jobs.rs` for what a request actually does.

mod api;
mod docker;
mod jobs;
mod redact;
mod site;

use anyhow::{Context, Result};

#[tokio::main]
async fn main() -> Result<()> {
    // `firetower-updater openapi` prints the contract and exits: what
    // `just gen` runs.
    if std::env::args().nth(1).as_deref() == Some("openapi") {
        println!("{}", api::openapi().to_pretty_json()?);
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .init();

    let docker = docker::Docker::new();
    let version = docker
        .version()
        .await
        .context("the updater needs the Docker socket mounted at /var/run/docker.sock")?;
    let site = site::Site::discover(&docker).await?;
    tracing::info!(
        docker = %version,
        project = %site.project,
        deploy = %site.deploy_dir,
        "updater {} ready",
        env!("CARGO_PKG_VERSION")
    );

    let jobs = jobs::Jobs::new(docker.clone(), site);
    // A previous updater's own recreate leaves the helper that did it.
    jobs.sweep_helpers().await;

    let token = api::App::token_from_env();
    if token.is_none() {
        tracing::warn!(
            "{} is not set; every request will be refused until it is",
            ft_updater_api::TOKEN_ENV
        );
    }

    let app = api::app(api::App {
        jobs,
        docker,
        token,
    });

    // All interfaces inside the container, which is the compose network and
    // nothing else: the port is not published.
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], ft_updater_api::PORT));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!("listening on {addr}");
    axum::serve(listener, app).await.context("serving")
}
