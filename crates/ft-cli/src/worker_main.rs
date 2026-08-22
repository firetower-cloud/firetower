//! The worker, and nothing else.
//!
//! A separate binary because the name mattered. `firetower` is what a person
//! types — `@firetower/cli` installs its own `bin` under that name, to install
//! and upgrade workers — and the control plane was asking a machine for
//! `firetower worker --stdio`. On a host with the CLI on it, PATH answered with
//! the CLI, which knows nothing about `--stdio` and said so:
//!
//! ```text
//! error: unknown option '--stdio'
//! ```
//!
//! naming neither program. The fix is not to argue over the name: it is to stop
//! asking for a human's command. Nobody types this one.
//!
//! It is also the build the `server` feature was written for — no axum, no
//! database, no embedded web application — which the worker image had never
//! actually used. See `Dockerfile.worker`.
//!
//! `localhost` does not come through here. That worker is spawned from the
//! control plane's own executable by absolute path, so it has never been a
//! question of what PATH holds.

use anyhow::{Context, Result};
use clap::Parser;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "firetower-worker",
    about = "A Firetower worker. Speaks frames on stdin and stdout.",
    version
)]
struct Cli {
    /// The only mode there is, and required all the same.
    ///
    /// A worker that started a session because somebody ran it out of
    /// curiosity would be worse than one that refuses to start without being
    /// told how it is being spoken to.
    #[arg(long)]
    stdio: bool,

    /// Where this worker keeps its state: repository mirrors, worktrees, its
    /// event log, and the agent's own directory.
    #[arg(long)]
    root: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    anyhow::ensure!(cli.stdio, "the worker only speaks over stdio; pass --stdio");

    // Never to stdout. That stream carries frames, and a stray line would be
    // read as a malformed one.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let root = cli.root.unwrap_or_else(|| {
        directories::BaseDirs::new()
            .map(|d| d.home_dir().join(".firetower").join("worker"))
            .unwrap_or_else(|| PathBuf::from("/var/lib/firetower/worker"))
    });

    let worker = std::sync::Arc::new(
        ft_worker::Worker::open(&root)
            .await
            .with_context(|| format!("opening the worker at {}", root.display()))?,
    );

    tracing::info!(root = %root.display(), "worker ready");

    worker
        .serve(tokio::io::stdin(), tokio::io::stdout())
        .await
        .context("serving frames")?;

    Ok(())
}
