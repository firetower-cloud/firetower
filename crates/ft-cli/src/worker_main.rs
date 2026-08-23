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

// The ways the worker is run by something other than the control plane.
//
// Both are the worker calling itself back. git and the agents it starts know
// how to run *a program*, so the worker hands them its own path — which means
// this binary has to answer to more than `--stdio`, and answer identically to
// the way `firetower` always has.
//
// Deliberately not a doc comment: clap would take it as the whole command's
// `about` and print six lines of rationale above the usage.
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
    /// Supervise one session's agent, holding its pipes.
    ///
    /// Started by the worker under tmux, exactly where an interactive agent
    /// would have gone. Runs until the agent exits.
    AgentRun {
        /// The session this agent belongs to, and the identifier the agent is
        /// told to use for itself so it can be resumed later.
        #[arg(long)]
        session: String,
        /// The worktree the agent runs in. Its own files go in a directory
        /// underneath.
        #[arg(long)]
        workspace: PathBuf,
        /// Which agent to start.
        #[arg(long, default_value = "ClaudeCode")]
        agent: String,
    },
    /// Watch a running agent, as the control plane would see it.
    ///
    /// A debugging tool, and the quickest way to tell whether a session is
    /// producing anything worth drawing. Normalising here duplicates what the
    /// control plane does — that is the point: it answers "is the agent fine
    /// and the wiring broken, or the other way round" without a browser.
    AgentTail {
        #[arg(long)]
        session: String,
        /// Start from a line, for picking up where a previous look stopped.
        #[arg(long, default_value_t = 0)]
        from_line: u64,
        /// Show the lines as the agent wrote them instead of what we made of
        /// them.
        #[arg(long)]
        raw: bool,
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
            if let Err(e) = ft_worker::hooks::report(&event, &default_root()).await {
                tracing::debug!("hook {event}: {e:#}");
            }
            return Ok(());
        }
        Some(Command::AgentRun {
            session,
            workspace,
            agent,
        }) => {
            // This one *is* a daemon, and it is the only subcommand that keeps
            // running. Its logging goes to stderr like the worker's, which
            // under tmux is where somebody debugging a host will look.
            tracing_subscriber::fmt()
                .with_writer(std::io::stderr)
                .with_env_filter(
                    tracing_subscriber::EnvFilter::try_from_default_env()
                        .unwrap_or_else(|_| "info".into()),
                )
                .init();

            let agent = ft_core::Agent::from_name(&agent)
                .with_context(|| format!("no agent called {agent}"))?;
            let argv = agent
                .launch_headless(&session)
                .with_context(|| format!("{} cannot be driven this way yet", agent.label()))?;

            return ft_worker::agentd::run(ft_worker::agentd::Launch {
                session_id: session,
                workspace,
                argv,
                // Inherited from tmux, which was handed the session's
                // environment when it started this. Nothing to add.
                env: vec![],
            })
            .await
            .context("supervising the agent");
        }
        Some(Command::AgentTail {
            session,
            from_line,
            raw,
        }) => {
            return tail(&session, from_line, raw).await;
        }
        None => {}
    }

    anyhow::ensure!(cli.stdio, "the worker only speaks over stdio; pass --stdio");

    // Never to stdout. That stream carries frames, and a stray line would be
    // read as a malformed one.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
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

/// Print what a running agent is saying, one event per line.
async fn tail(session: &str, from_line: u64, raw: bool) -> Result<()> {
    use tokio::io::AsyncBufReadExt;

    let mut client = ft_worker::agentd::AgentClient::connect(session)
        .await
        .with_context(|| format!("no agent is listening for session {session}"))?;
    client
        .send(&ft_worker::agentd::ToAgent::Watch { from_line })
        .await?;

    let mut normaliser = ft_core::normalise::ClaudeNormaliser::new();
    let mut frames = tokio::io::BufReader::new(client.into_stream()).lines();

    while let Some(frame) = frames.next_line().await? {
        let Ok(frame) = serde_json::from_str::<ft_worker::agentd::FromAgent>(&frame) else {
            continue;
        };
        match frame {
            ft_worker::agentd::FromAgent::Line { line_no, line } => {
                if raw {
                    println!("{line_no:>5}  {line}");
                    continue;
                }
                for event in normaliser.push(&line) {
                    println!("{line_no:>5}  {}", summarise(&event));
                }
            }
            ft_worker::agentd::FromAgent::Exited { .. } => {
                println!("      the agent exited");
                break;
            }
            other => println!("      {other:?}"),
        }
    }
    Ok(())
}

/// One event, short enough to read a session by.
fn summarise(event: &ft_core::TurnEvent) -> String {
    use ft_core::turn::TurnEvent as E;
    match event {
        E::SessionConfigured { model, tools, .. } => {
            format!("session   {model}, {} tools", tools.len())
        }
        E::TurnStarted { turn } => format!("turn      {turn} started"),
        E::TurnCompleted { turn, status, .. } => format!("turn      {turn} {status:?}"),
        E::ItemStarted { kind, title, .. } => {
            format!("item      {kind:?} {}", title.as_deref().unwrap_or(""))
        }
        E::ItemUpdated { item, .. } => format!("item      {item} input"),
        E::ItemCompleted { item, status } => format!("item      {item} {status:?}"),
        E::ContentDelta { stream, delta, .. } => {
            format!("text      {stream:?} {:?}", trim(delta))
        }
        E::RequestOpened { kind, detail, .. } => format!("asks      {kind:?} {detail}"),
        E::RequestResolved { decision, .. } => format!("answered  {decision:?}"),
        E::UserInputRequested { questions, .. } => {
            format!("asks      {} question(s)", questions.len())
        }
        E::UserInputResolved { .. } => "answered  questions".into(),
        E::PlanUpdated { steps } => format!("plan      {} step(s)", steps.len()),
        E::TaskStarted { description, .. } => format!("subagent  {description}"),
        E::TaskProgress { detail, .. } => format!("subagent  {detail}"),
        E::TaskCompleted { status, .. } => format!("subagent  {status:?}"),
        E::Raw { payload, .. } => format!(
            "unnamed   {}",
            payload.get("type").and_then(|t| t.as_str()).unwrap_or("?")
        ),
    }
}

fn trim(text: &str) -> String {
    let flat = text.replace('\n', " ");
    if flat.chars().count() > 60 {
        format!("{}…", flat.chars().take(60).collect::<String>())
    } else {
        flat
    }
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
