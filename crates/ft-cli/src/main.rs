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
        #[arg(long, env = "FIRETOWER_DEV")]
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
