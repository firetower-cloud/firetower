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
enum AgentsCommand {
    /// Fetch one, or replace it with another version.
    Add {
        /// `claude-code` or `codex`.
        kind: String,
        /// Which version. The newest published one by default.
        #[arg(long)]
        version: Option<String>,
    },
    /// Remove every copy of one from this machine.
    Remove {
        /// `claude-code` or `codex`.
        kind: String,
    },
}

#[derive(Subcommand)]
enum Command {
    /// The agents this machine can run.
    ///
    /// They are not in the image: each is a few hundred megabytes and they are
    /// published on their own schedules, so a new one would otherwise mean a
    /// new Firetower before anybody could use it. They go on the volume, which
    /// survives recreating the container to upgrade the worker.
    ///
    /// Nothing here signs anything in. Installing a binary and authenticating
    /// it are separate acts, and what an agent authenticates with is held by
    /// the control plane and handed over per session.
    Agents {
        #[command(subcommand)]
        what: Option<AgentsCommand>,
    },

    /// Sign Codex in on this machine, with a code instead of a browser.
    ///
    /// Codex's ordinary login expects a browser on the same machine. A server
    /// has none, so this asks OpenAI for a short code and prints it: approve it
    /// from wherever you are, and the credential is delivered here.
    ///
    /// By hand this is a way to check a host can reach OpenAI at all. The
    /// control plane drives the same thing and keeps what comes back.
    CodexLogin {
        /// Where the credential should land. A scratch directory by default,
        /// printed when it is done.
        #[arg(long)]
        home: Option<std::path::PathBuf>,
    },

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
    /// Answer the agent's permission prompts. Run by the agent, never by hand.
    ///
    /// An MCP server the agent starts for itself, from the configuration the
    /// supervisor wrote. Its stdout is the protocol, so nothing else may be
    /// written there.
    McpApprove {
        #[arg(long)]
        session: String,
        /// The worktree, named rather than inherited: this process is started
        /// by the agent, so its working directory is the agent's business.
        #[arg(long)]
        workspace: PathBuf,
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
        Some(Command::Agents { what }) => {
            let root = cli.root.clone().unwrap_or_else(default_root);
            return agents(&root, what).await;
        }
        Some(Command::CodexLogin { home }) => {
            let root = cli.root.clone().unwrap_or_else(default_root);
            return codex_login(&root, home).await;
        }
        Some(Command::Hook { event }) => {
            // Nothing. See the same arm on the `firetower` binary: hooks are
            // gone, and this remains only so that a stale one does nothing
            // instead of failing inside somebody's own session.
            tracing::debug!("ignoring hook {event}: Firetower no longer uses them");
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

            return ft_worker::entry::run_agent(&session, workspace, &agent).await;
        }
        Some(Command::McpApprove { session, workspace }) => {
            return ft_worker::approver::serve(&session, &workspace).await;
        }
        Some(Command::AgentTail {
            session,
            from_line,
            raw,
        }) => {
            return ft_worker::entry::tail_agent(&session, from_line, raw).await;
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

/// Where a worker keeps its state when nobody says.
///
/// The control plane always passes `--root`, so this is for the two callbacks
/// below — git's askpass and an agent's hook — which are started by something
/// that knows nothing about our arguments.
/// List, add or remove the agents this machine can run.
///
/// Written for somebody watching a terminal: what is here, or what changed,
/// and nothing else. The control plane reads the same directory through
/// `runtime::installed`, so this and the Agents screen never disagree.
async fn agents(root: &std::path::Path, what: Option<AgentsCommand>) -> anyhow::Result<()> {
    use ft_worker::runtime;

    match what {
        // Bare `agents` lists, because that is what somebody types first.
        None => {
            let here = runtime::installed(root).await;
            if here.is_empty() {
                println!("none installed");
                println!();
                println!("  firetower-worker agents add claude-code");
                return Ok(());
            }
            for one in here {
                println!("{:<14} {}", directory_name(one.kind), one.version);
            }
            Ok(())
        }

        Some(AgentsCommand::Add { kind, version }) => {
            let kind = agent_named(&kind)?;
            let installed = runtime::install(root, kind, version.as_deref()).await?;
            println!("{} {}", kind.label(), installed.version);
            Ok(())
        }

        Some(AgentsCommand::Remove { kind }) => {
            let kind = agent_named(&kind)?;
            runtime::remove(root, kind).await?;
            println!("removed {}", kind.label());
            Ok(())
        }
    }
}

/// Sign Codex in, printing the code for somebody to approve.
///
/// Prints to stdout because a person is reading it. Everything it says is
/// public — a code that is useless without an account, and a URL — and the
/// credential itself is only ever written to `home`.
async fn codex_login(
    root: &std::path::Path,
    home: Option<std::path::PathBuf>,
) -> anyhow::Result<()> {
    let home = home.unwrap_or_else(|| root.join("codex-home"));

    let (pending, waiting) = ft_worker::codex::start(root, &home).await?;

    println!("Open {}", pending.verification_url);
    println!("Enter {}", pending.user_code);
    println!();
    println!("Waiting. Ctrl-C to give up.");

    let credential = waiting.finish().await?;
    println!(
        "Signed in. {} holds {} bytes.",
        home.join(ft_worker::codex::AUTH).display(),
        credential.len()
    );
    Ok(())
}

/// The name somebody types, which is the directory name rather than the label.
fn agent_named(name: &str) -> anyhow::Result<ft_core::Agent> {
    let wanted = name.trim().to_ascii_lowercase().replace('_', "-");
    ft_core::Agent::all()
        .into_iter()
        .find(|k| directory_name(*k) == wanted)
        .ok_or_else(|| {
            let known: Vec<_> = ft_core::Agent::all()
                .into_iter()
                .map(directory_name)
                .collect();
            anyhow::anyhow!("no agent called {name}. Try: {}", known.join(", "))
        })
}

fn directory_name(kind: ft_core::Agent) -> &'static str {
    match kind {
        ft_core::Agent::ClaudeCode => "claude-code",
        ft_core::Agent::Codex => "codex",
        ft_core::Agent::Shell => "shell",
    }
}

/// Where this worker keeps its state, when nobody said.
///
/// `/var/lib/firetower/worker` first, because that is what the image creates
/// and what the control plane passes when it runs a worker in a container.
/// Without this check the two disagree: `HOME` inside the image is redirected
/// to the volume, so the home-directory answer would be
/// `/var/lib/firetower/home/.firetower/worker` — a second state directory
/// beside the real one, and agents installed by hand would land somewhere no
/// session looks.
///
/// On a machine that is not a worker container it does not exist, and the
/// home-directory answer is the right one.
fn default_root() -> PathBuf {
    let in_image = PathBuf::from("/var/lib/firetower/worker");
    if in_image.is_dir() {
        return in_image;
    }

    directories::BaseDirs::new()
        .map(|d| d.home_dir().join(".firetower").join("worker"))
        .unwrap_or(in_image)
}
