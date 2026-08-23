//! `firetower` — the only command anyone types.
//!
//! One binary, three roles. The worker subcommand is what the control plane
//! spawns locally today and what SSH runs on a remote host tomorrow; nothing
//! about it changes between the two.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "firetower",
    version,
    about = "Run coding agents on your own servers.",
    long_about = None,
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Where Firetower keeps its state.
    #[arg(long, env = "FIRETOWER_HOME", global = true)]
    home: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the control plane and serve the interface. The default.
    Serve {
        #[arg(long, env = "FIRETOWER_PORT", default_value_t = 4400)]
        port: u16,

        /// What address to listen on.
        ///
        /// Loopback by default, which is the only safe default for a program
        /// holding every credential you own. A container has to say
        /// `0.0.0.0` — and if it does that with no authentication configured,
        /// Firetower refuses to start rather than serving the vault to whoever
        /// asks.
        #[arg(long, env = "FIRETOWER_BIND", default_value = "127.0.0.1")]
        bind: std::net::IpAddr,

        /// Serve the API only; the web application runs on its own dev server.
        ///
        /// A flag on the command line, and a value in the environment. Both,
        /// because `just dev` passes `--dev` while a compose file or a shell
        /// writes `FIRETOWER_DEV=1` — and clap's own bool parser accepts
        /// neither `1` nor a bare flag once it is told to read a value.
        #[arg(
            long,
            env = "FIRETOWER_DEV",
            default_value = "false",
            default_missing_value = "true",
            num_args = 0..=1,
            value_parser = truthy,
        )]
        dev: bool,

        /// Where the control plane keeps its state.
        ///
        /// Postgres, and not optional: everything the control plane owns lives
        /// there. `just dev` starts one; the compose file is the other way.
        #[arg(
            long,
            env = "DATABASE_URL",
            default_value = "postgres://firetower:firetower@localhost:5433/firetower"
        )]
        database_url: String,
    },

    /// Set someone's password, from the machine Firetower runs on.
    ///
    /// The only way back in when a password is forgotten. There is no email to
    /// send a link to and deliberately no second path — one supported way to do
    /// this is also one way to get it wrong.
    ///
    /// Every browser signed in as that person is signed out, which is the point
    /// as much as the new password is.
    Passwd {
        /// Who. `admin` unless somebody chose otherwise.
        username: String,

        /// Where the control plane keeps its state.
        #[arg(
            long,
            env = "DATABASE_URL",
            default_value = "postgres://firetower:firetower@localhost:5433/firetower"
        )]
        database_url: String,
    },

    /// Ask the control plane on this machine whether it is ready to work.
    ///
    /// Exists so the container image needs no curl: a health check is the one
    /// thing that has to work in an image stripped of everything else, and
    /// installing an HTTP client to ask one question of ourselves is a package
    /// to keep patched forever.
    ///
    /// Exit 0 means ready. Anything else means not, which is the whole
    /// contract Docker cares about.
    Healthcheck {
        #[arg(long, env = "FIRETOWER_PORT", default_value_t = 4400)]
        port: u16,
    },

    /// Run the worker daemon. Frames on stdin and stdout.
    Worker {
        /// Required, and the only supported mode: the worker never listens on a
        /// port. Who dials is the transport's business, not the daemon's.
        #[arg(long)]
        stdio: bool,

        /// Where this worker keeps repositories, worktrees and its event log.
        #[arg(long, env = "FIRETOWER_WORKER_ROOT")]
        root: Option<PathBuf>,
    },

    /// Report something an agent did. Run by the agent, never by a person.
    ///
    /// Installed into the agent's own hook configuration, so it fires when the
    /// agent needs permission, finishes a turn, or stops on an error. It writes
    /// one row into the worker's log on this machine and exits — no network, no
    /// socket, nothing to be listening.
    ///
    /// That is what makes it survive Firetower being closed: the worker only
    /// exists while a control plane is connected, but the log is a file, and
    /// the next connection replays whatever accumulated.
    ///
    /// Silent and successful when it has nothing to do. It is installed in a
    /// configuration shared with the agent's own sessions, and those are not
    /// Firetower's business.
    #[command(hide = true)]
    Hook {
        /// The hook that fired: `Notification`, `Stop`, `StopFailure`…
        event: String,
    },

    /// Answer git's credential prompt. Run by git, never by a person.
    ///
    /// Git calls whatever `GIT_ASKPASS` points at and reads one line from its
    /// stdout. That is the entire contract. The value comes from the worker
    /// that started the command, over a socket, so it is never on disk or in
    /// this process's arguments.
    #[command(hide = true)]
    Askpass {
        /// Git's prompt, verbatim — it says whether it wants the username or
        /// the password.
        prompt: Vec<String>,
    },

    /// Supervise one session's agent, holding its pipes. Run by tmux.
    ///
    /// Here as well as on `firetower-worker` because localhost's worker is
    /// this binary: the control plane spawns its own executable with a
    /// subcommand, so a session started on this machine asks this program for
    /// something only the other one used to answer.
    #[command(hide = true)]
    AgentRun {
        #[arg(long)]
        session: String,
        #[arg(long)]
        workspace: std::path::PathBuf,
        #[arg(long, default_value = "ClaudeCode")]
        agent: String,
    },

    /// Answer the agent's permission prompts. Run by the agent, never by hand.
    ///
    /// Here as well as on `firetower-worker` for the same reason `agent-run`
    /// is: localhost's worker is this binary, so a session on this machine
    /// starts this program to ask its questions.
    #[command(hide = true)]
    McpApprove {
        #[arg(long)]
        session: String,
        #[arg(long)]
        workspace: std::path::PathBuf,
    },

    /// Watch a running agent, as the control plane would see it.
    #[command(hide = true)]
    AgentTail {
        #[arg(long)]
        session: String,
        #[arg(long, default_value_t = 0)]
        from_line: u64,
        #[arg(long)]
        raw: bool,
    },
}

/// Settings that belong to an install rather than to the source.
///
/// Two locations, nearest first: `./.env` for a checkout you're working in,
/// then `~/.firetower/.env` for an installed copy that has no checkout. Real
/// environment variables beat both — `dotenvy` never overwrites what's already
/// set — so a one-off `FOO=bar firetower` still wins.
fn load_env() {
    dotenvy::dotenv().ok();
    dotenvy::from_path(default_home().join(".env")).ok();
}

#[tokio::main]
async fn main() -> Result<()> {
    // Before parsing: arguments that read the environment should see this too.
    load_env();

    let cli = Cli::parse();

    match cli.command {
        Some(Command::Askpass { prompt }) => {
            // No tracing: anything on stdout here is read by git as the answer.
            let value = ft_worker::askpass::respond_as_helper(&prompt.join(" ")).await?;
            println!("{value}");
            Ok(())
        }

        Some(Command::Hook { event }) => {
            // Never fatal, never noisy. A hook that fails must not become a
            // hook that interrupts the agent it is reporting on.
            // Nothing. Firetower no longer asks an agent to report on itself —
            // it says what it is doing as part of saying anything — and the
            // entries a previous version installed are removed when a session
            // next starts. This stays so that one firing in the window before
            // that does nothing, quietly, rather than failing in the middle of
            // somebody's own session.
            tracing::debug!("ignoring hook {event}: Firetower no longer uses them");
            Ok(())
        }

        Some(Command::AgentRun {
            session,
            workspace,
            agent,
        }) => {
            // A daemon, so it logs like one — to stderr, where tmux keeps it.
            init_tracing(true, false);
            ft_worker::entry::run_agent(&session, workspace, &agent).await
        }

        Some(Command::McpApprove { session, workspace }) => {
            // No tracing anywhere near this: stdout carries the protocol, and
            // a stray log line would be read as a malformed frame.
            ft_worker::approver::serve(&session, &workspace).await
        }

        Some(Command::AgentTail {
            session,
            from_line,
            raw,
        }) => ft_worker::entry::tail_agent(&session, from_line, raw).await,

        Some(Command::Passwd {
            username,
            database_url,
        }) => {
            init_tracing(true, true);
            set_password(&username, &database_url).await
        }

        Some(Command::Healthcheck { port }) => {
            // Loopback whatever the server is bound to: this only ever asks
            // the process in its own container.
            match ready(port).await {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!("not ready: {e:#}");
                    std::process::exit(1);
                }
            }
        }

        Some(Command::Worker { stdio, root }) => {
            // A worker's logs must never reach stdout — that stream carries
            // frames, and a stray line would be read as a malformed one.
            init_tracing(true, false);
            let root = root.unwrap_or_else(|| default_home().join("worker"));

            anyhow::ensure!(stdio, "the worker only speaks over stdio; pass --stdio");

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

        other => {
            // `firetower` with no subcommand serves. Rather than restating
            // every default here and drifting from the real ones — which is
            // how the bare command came to ignore FIRETOWER_PORT — ask clap
            // for what it would have parsed, environment and all.
            let serve = match other {
                Some(command @ Command::Serve { .. }) => command,
                _ => Cli::parse_from(["firetower", "serve"])
                    .command
                    .expect("parsing `serve` produces a subcommand"),
            };

            let Command::Serve {
                port,
                bind,
                dev,
                database_url,
            } = serve
            else {
                unreachable!("only Serve reaches here")
            };

            init_tracing(false, dev);
            let home = cli.home.unwrap_or_else(default_home);
            tokio::fs::create_dir_all(&home)
                .await
                .with_context(|| format!("creating {}", home.display()))?;

            // The banner belongs to the server, not to this: it is printed
            // once the checks that can refuse to start have passed. Printing
            // an address here and then failing to bind it announced a server
            // that was not running.
            ft_server::run(ft_server::Config {
                home,
                port,
                bind,
                dev,
                database_url,
            })
            .await
        }
    }
}

/// Ask twice, then replace it.
///
/// Read from the terminal rather than taken as an argument: an argument is in
/// the shell's history and in `ps` for as long as this runs.
async fn set_password(username: &str, database_url: &str) -> Result<()> {
    let db = ft_server::db::Db::open(database_url).await?;
    let accounts = ft_server::accounts::Accounts::new(db.pool().clone());

    let user = accounts
        .user_by_name(username)
        .await?
        .with_context(|| format!("there is no user called {username}"))?;

    let first = read_hidden(&format!("New password for {username}: "))?;
    ft_server::accounts::check_password(&first)?;
    let again = read_hidden("Again: ")?;
    anyhow::ensure!(first == again, "those didn't match");

    accounts.set_password(&user.id, &first).await?;

    eprintln!();
    eprintln!("  Done. Everywhere signed in as {username} has been signed out.");
    Ok(())
}

/// A line from the terminal, with echo off while it is typed.
///
/// `stty` rather than a crate: this is the one place in Firetower that reads a
/// password from a keyboard, and a dependency for it would be a dependency to
/// keep patched forever.
fn read_hidden(prompt: &str) -> Result<String> {
    use std::io::{BufRead, Write};

    eprint!("{prompt}");
    std::io::stderr().flush().ok();

    let hushed = std::process::Command::new("stty")
        .arg("-echo")
        .stdin(std::process::Stdio::inherit())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    let mut line = String::new();
    let read = std::io::stdin().lock().read_line(&mut line);

    if hushed {
        let _ = std::process::Command::new("stty")
            .arg("echo")
            .stdin(std::process::Stdio::inherit())
            .status();
        eprintln!();
    }

    read.context("reading from the terminal")?;
    Ok(line.trim_end_matches(['\n', '\r']).to_string())
}

/// One GET, by hand, because a dependency for this would be absurd.
///
/// `/readyz` rather than `/healthz`: a control plane whose database has gone is
/// running and unable to do anything, and a container that reports healthy in
/// that state is a container nothing will ever restart.
async fn ready(port: u16) -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await
    .context("nothing answered in time")?
    .with_context(|| format!("connecting to 127.0.0.1:{port}"))?;

    stream
        .write_all(b"GET /readyz HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .await
        .context("asking")?;

    // HTTP/1.0 with `Connection: close` so the far end hangs up when it is
    // done and there is no length to parse.
    let mut response = Vec::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        stream.read_to_end(&mut response),
    )
    .await
    .context("no answer in time")?
    .context("reading the answer")?;

    let head = String::from_utf8_lossy(&response);
    let status = head.lines().next().unwrap_or_default();
    anyhow::ensure!(status.contains(" 200"), "the control plane said: {status}");
    Ok(())
}

/// `1` and `true` mean the same thing to whoever writes an environment
/// variable, and clap's own bool parser accepts only one of them.
fn truthy(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" | "" => Ok(false),
        other => Err(format!("expected true or false, got {other:?}")),
    }
}

/// One obvious directory beats correctness about which of three system folders
/// a log belongs in. Override with `FIRETOWER_HOME`.
fn default_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".firetower")
}

fn init_tracing(to_stderr: bool, pretty: bool) {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_env("RUST_LOG").unwrap_or_else(|_| {
        EnvFilter::new(if pretty {
            "firetower=debug,ft_=debug,info"
        } else {
            "info"
        })
    });

    let builder = fmt().with_env_filter(filter);

    if to_stderr {
        builder.with_writer(std::io::stderr).init();
    } else if pretty {
        builder.init();
    } else {
        builder.json().init();
    }
}
