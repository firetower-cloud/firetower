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
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "firetower-worker",
    about = "A Firetower worker. Speaks frames on stdin and stdout.",
    version
)]
struct Cli {
    /// Serving frames is the default, and saying so is required all the same.
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

    #[command(subcommand)]
    command: Option<Command>,
}

/// The ways the worker is run by something other than the control plane.
///
/// Both are the worker calling itself back. git and the agents it starts know
/// how to run *a program*, so the worker hands them its own path — which means
/// this binary has to answer to more than `--stdio`, and answer identically to
/// the way `firetower` always has.
#[derive(Subcommand)]
enum Command {
    /// Answer git's credential prompt.
    ///
    /// Run by the one-line bridge script `Askpass::start` writes, never by
    /// hand: git's contract is `$GIT_ASKPASS "<prompt>"` with no subcommand, so
    /// the script exists to add this word.
    Askpass {
        /// Git's prompt, verbatim — it says whether it wants the username or
        /// the password.
        prompt: Vec<String>,
    },
    /// Report that an agent stopped.
    ///
    /// Installed into the agent's own configuration as `<this binary> hook`.
    /// Without it nothing moves a session off `Working`: Firetower would know
    /// what it started and never what happened next.
    Hook {
        /// The hook that fired: `Notification`, `Stop`, `StopFailure`…
        event: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Neither of these is the daemon, and neither may write to stdout: git
    // reads the askpass answer from there, and a hook's output is the agent's.
    match cli.command {
        Some(Command::Askpass { prompt }) => {
            let value = ft_worker::askpass::respond_as_helper(&prompt.join(" ")).await?;
            println!("{value}");
            return Ok(());
        }
        Some(Command::Hook { event }) => {
            // Never fatal, never noisy. A hook that fails must not become a
            // hook that interrupts the agent it is reporting on.
            if let Err(e) =
                ft_worker::hooks::report(&event, &default_root()).await
            {
                tracing::debug!("hook {event}: {e:#}");
            }
            return Ok(());
        }
        None => {}
    }

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

    let root = cli.root.unwrap_or_else(default_root);

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

/// Where a worker keeps its state when nobody says.
///
/// The control plane always passes `--root`, so this is for the two callbacks
/// below — git's askpass and an agent's hook — which are started by something
/// that knows nothing about our arguments.
fn default_root() -> PathBuf {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().join(".firetower").join("worker"))
        .unwrap_or_else(|| PathBuf::from("/var/lib/firetower/worker"))
}
