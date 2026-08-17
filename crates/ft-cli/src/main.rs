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
            // `firetower` with no subcommand serves, so the defaults have to
            // match what clap would have produced for `serve`.
            let (port, bind, dev, database_url) = match other {
                Some(Command::Serve {
                    port,
                    bind,
                    dev,
                    database_url,
                }) => (port, bind, dev, database_url),
                _ => (
                    4400,
                    std::env::var("FIRETOWER_BIND")
                        .ok()
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(std::net::IpAddr::from([127, 0, 0, 1])),
                    std::env::var("FIRETOWER_DEV").is_ok(),
                    std::env::var("DATABASE_URL").unwrap_or_else(|_| {
                        "postgres://firetower:firetower@localhost:5433/firetower".to_string()
                    }),
                ),
            };

            init_tracing(false, dev);
            let home = cli.home.unwrap_or_else(default_home);
            tokio::fs::create_dir_all(&home)
                .await
                .with_context(|| format!("creating {}", home.display()))?;

            eprintln!();
            eprintln!("  Firetower");
            // What someone can actually type. A bound address of 0.0.0.0 is
            // not a URL, and printing it as one sends people to a page that
            // never loads.
            if bind.is_loopback() {
                eprintln!("  http://localhost:{port}");
            } else {
                eprintln!("  listening on {bind}:{port}");
            }
            if dev {
                eprintln!("  api only — the web application is on its own port");
            }
            eprintln!();

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
