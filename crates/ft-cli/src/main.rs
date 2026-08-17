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

        /// Whether this machine is itself somewhere sessions can run.
        ///
        /// On by default, which is what a workstation wants. A container
        /// should turn it off: the control plane holds every credential, and
        /// an agent belongs somewhere that does not.
        #[arg(
            long,
            env = "FIRETOWER_LOCAL_HOST",
            default_value = "true",
            value_parser = truthy,
        )]
        local_host: bool,

        /// What to call the worker that dials in.
        ///
        /// Only used when `FIRETOWER_WORKER_TOKEN` is set. The machine that
        /// connects with that token appears in the fleet under this name.
        #[arg(long, env = "FIRETOWER_WORKER_NAME", default_value = "worker")]
        worker_name: String,

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
        /// Frames on stdin and stdout, for a caller that started this process.
        ///
        /// The worker still never listens on a port. Who opens the connection
        /// is the transport's business, not the daemon's.
        #[arg(long)]
        stdio: bool,

        /// Dial a control plane instead of waiting to be started by one.
        ///
        /// For a machine the control plane cannot reach: behind a firewall, on
        /// a home network, or simply not something it is allowed to connect to.
        /// The frames are identical — only the direction the connection is
        /// opened in changes.
        ///
        /// A URL, e.g. `wss://firetower.example.com`.
        #[arg(long, env = "FIRETOWER_URL", conflicts_with = "stdio")]
        connect: Option<String>,

        /// What to authenticate as, when dialling in. The same value the
        /// control plane was given.
        #[arg(long, env = "FIRETOWER_WORKER_TOKEN", requires = "connect")]
        token: Option<String>,

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

        Some(Command::Worker {
            stdio,
            connect,
            token,
            root,
        }) => {
            // A worker's logs must never reach stdout — that stream carries
            // frames, and a stray line would be read as a malformed one.
            init_tracing(true, false);
            let root = root.unwrap_or_else(|| default_home().join("worker"));

            anyhow::ensure!(
                stdio || connect.is_some(),
                "the worker either speaks over stdio or dials a control plane; \
                 pass --stdio or --connect"
            );

            let worker = std::sync::Arc::new(
                ft_worker::Worker::open(&root)
                    .await
                    .with_context(|| format!("opening the worker at {}", root.display()))?,
            );

            tracing::info!(root = %root.display(), "worker ready");

            match connect {
                Some(url) => dial(worker, &url, token.as_deref()).await,
                None => worker
                    .serve(tokio::io::stdin(), tokio::io::stdout())
                    .await
                    .context("serving frames"),
            }
        }

        other => {
            // `firetower` with no subcommand serves, so the defaults have to
            // match what clap would have produced for `serve`.
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
                local_host,
                worker_name,
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
                local_host,
                worker_name,
                database_url,
            })
            .await
        }
    }
}

/// Keep a connection to a control plane, opening it from this side.
///
/// Never returns while it can help it. A worker is a daemon on a machine that
/// may lose its network, be suspended, or come up before the control plane
/// does, and exiting on any of those would make the container's restart policy
/// responsible for something this loop does better — the process keeps its
/// state, and the tmux sessions holding live agents are never at risk.
async fn dial(
    worker: std::sync::Arc<ft_worker::Worker>,
    url: &str,
    token: Option<&str>,
) -> Result<()> {
    let token = token.context("dialling in needs a token: pass --token")?;
    let endpoint = endpoint(url, token)?;

    // Said once, not on every attempt: a machine that is offline overnight
    // should not write a thousand identical lines about it.
    tracing::info!(url, "dialling the control plane");

    let mut attempt: u32 = 0;
    loop {
        match session(&worker, &endpoint).await {
            Ok(()) => {
                tracing::info!("the control plane closed the connection");
                attempt = 0;
            }
            Err(e) => {
                if attempt == 0 {
                    tracing::warn!("{e:#}");
                } else {
                    tracing::debug!("still not connected: {e:#}");
                }
                attempt = attempt.saturating_add(1);
            }
        }

        // Doubling to a minute, which is the same shape the control plane uses
        // when it is the one dialling.
        let wait = std::time::Duration::from_secs(1)
            * 2u32.saturating_pow(attempt.min(6).saturating_sub(1));
        tokio::time::sleep(wait.min(std::time::Duration::from_secs(60))).await;
    }
}

/// One connection, from opening it to it ending.
async fn session(worker: &std::sync::Arc<ft_worker::Worker>, endpoint: &str) -> Result<()> {
    use futures::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_tungstenite::tungstenite::Message;

    let (socket, _) = tokio_tungstenite::connect_async(endpoint)
        .await
        .context("the control plane did not accept the connection")?;

    tracing::info!("connected");

    // The worker speaks to a stream of bytes and knows nothing about
    // websockets, so the socket is turned into one — the same arrangement the
    // control plane makes on its side.
    let (worker_side, socket_side) = tokio::io::duplex(64 * 1024);
    let (reader, writer) = tokio::io::split(worker_side);
    let (mut outbound, mut inbound) = socket.split();
    let (mut from_worker, mut to_worker) = tokio::io::split(socket_side);

    let sending = tokio::spawn(async move {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match from_worker.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if outbound
                        .send(Message::Binary(buffer[..read].to_vec().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        let _ = outbound.send(Message::Close(None)).await;
    });

    let receiving = tokio::spawn(async move {
        while let Some(message) = inbound.next().await {
            match message {
                Ok(Message::Binary(bytes)) => {
                    if to_worker.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                // The transport keeping itself alive. The protocol has its own
                // heartbeat and the two need not know about each other.
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => continue,
            }
        }
        drop(to_worker);
    });

    // Cloned rather than borrowed: `serve` takes the Arc, and this loop needs
    // the worker again for the next connection.
    let result = worker
        .clone()
        .serve(reader, writer)
        .await
        .context("serving frames");

    sending.abort();
    receiving.abort();
    result
}

/// The URL to open, with the token on it.
///
/// A worker's token is a credential in a query string, which is normally worth
/// avoiding — but a websocket handshake carries no body, and a header would
/// mean building the request by hand for no gain over one hop to a server we
/// already trust. It is never logged: only `url` is, which is what was passed
/// in.
fn endpoint(url: &str, token: &str) -> Result<String> {
    let base = url.trim_end_matches('/');

    // `http` is what people type and `ws` is what the library needs. Accepting
    // both means the same value works in a browser and here.
    let base = match base.split_once("://") {
        Some(("http", rest)) => format!("ws://{rest}"),
        Some(("https", rest)) => format!("wss://{rest}"),
        Some(("ws" | "wss", _)) => base.to_string(),
        _ => anyhow::bail!("{url} is not a URL. It should start with https:// or wss://"),
    };

    Ok(format!("{base}/workers/connect?token={}", escaped(token)))
}

/// Percent-encode everything that is not plainly safe in a query string.
///
/// Generated tokens are letters and digits, so this does nothing to them. A
/// token someone chose themselves may be anything at all, and the failure it
/// prevents — a `+` silently becoming a space — is the kind that presents as
/// "the right token is refused".
fn escaped(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
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

/// `0` and `false` mean the same thing to a person writing a compose file, and
/// clap's own bool parser accepts only one of them.
fn truthy(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
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
