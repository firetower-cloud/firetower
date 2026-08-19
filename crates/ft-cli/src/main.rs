//! `firetower` — the only command anyone types.
//!
//! One binary, three roles. The worker subcommand is what the control plane
//! spawns locally today and what SSH runs on a remote host tomorrow; nothing
//! about it changes between the two.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use ft_core::hooks;
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
            if let Err(e) = report_hook(&event).await {
                tracing::debug!("hook {event}: {e:#}");
            }
            Ok(())
        }

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

/// Write down what the agent just did.
///
/// Reads the hook's JSON payload from stdin — that is the contract every agent
/// hook uses — and appends an event to the worker's log on this machine.
async fn report_hook(event: &str) -> Result<()> {
    use ft_core::hooks;

    // Not ours. The agent's hook configuration is shared with whatever else
    // somebody runs on this machine, and a session of their own has no
    // Firetower environment around it.
    let Ok(session) = std::env::var(hooks::SESSION_ENV) else {
        return Ok(());
    };
    let session = ft_core::SessionId::from_stored(session);

    let root = std::env::var(hooks::ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_home().join("worker"));

    // Whatever the agent sent us, if anything. A hook with no payload is still
    // worth a status.
    let payload: serde_json::Value = {
        use tokio::io::AsyncReadExt;
        let mut raw = String::new();
        let _ = tokio::io::stdin().read_to_string(&mut raw).await;
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null)
    };

    let notification_type = payload.get("notification_type").and_then(|v| v.as_str());

    let Some(status) = hooks::status_for(event, notification_type) else {
        // An event we asked for and have no status for. Nothing to record.
        return Ok(());
    };

    let (note, rank) = note_for(&payload, status);
    let note = note.map(|n| hooks::plain(&n));

    let store = ft_worker::store::Store::open(&root.join("worker.db")).await?;

    // Nothing to say. `PreToolUse` fires before every tool call — hundreds a
    // session — and without this each one would write a row, stream a frame to
    // the browser, and bury the log in copies of "Working".
    //
    // It also stops a blocked agent repeating itself: a permission prompt
    // notifies more than once while it waits, and those were three identical
    // rows before this.
    let was = store.status_of(&session).await?;
    let said = store.note_of(&session).await?;
    let said_rank = store.note_rank_of(&session).await?;

    // Finishing a sentence in order to ask a question is not handing back.
    //
    // `Stop` fires when the agent stops talking, which is exactly what it does
    // before it waits for you — so it arrived seconds after `NeedsYou` and
    // demoted it. Both land in the same inbox, so this was only ever wrong on
    // the card, but it was wrong.
    if was == Some(ft_core::SessionStatus::NeedsYou) && status == ft_core::SessionStatus::HandedBack
    {
        return Ok(());
    }

    // Keep the better sentence.
    //
    // Notes arrive from several hooks within seconds and not best-first: the
    // question, then a stale paragraph out of the transcript. Only something at
    // least as good may replace what is already there.
    let note = if was == Some(status)
        && said.is_some()
        && !hooks::worth_replacing(rank_from(said_rank), rank)
    {
        said.clone()
    } else {
        note
    };

    if was == Some(status) && said == note {
        return Ok(());
    }

    // The status the session is in, and the event that says so. Both, because
    // the first is what every screen reads and the second is what reaches a
    // control plane that was not connected when this happened.
    store.set_status(&session, status).await?;
    store
        .set_note(&session, note.as_deref(), rank as i64)
        .await?;
    store
        .append(
            &session,
            &ft_core::EventKind::StatusChanged { status, note },
        )
        .await?;

    Ok(())
}

/// What to show on the card, in the agent's own terms.
///
/// In order of how much it actually tells you:
///
/// 1. the tool it is asking to use, which `PermissionRequest` carries
/// 2. the last thing it said, out of the transcript — the question, the menu,
///    the thing it is waiting on
/// 3. whatever message the hook came with, which for a permission prompt is
///    the constant "Claude needs your permission" however specific the question
///
/// Nothing at all once it is working again: a question that has been answered
/// should not still be on the screen.
fn note_for(
    payload: &serde_json::Value,
    status: ft_core::SessionStatus,
) -> (Option<String>, hooks::Detail) {
    use ft_core::hooks::{self, Detail};

    if status == ft_core::SessionStatus::Working {
        // A question that has been answered is not news. Highest rank so it
        // always clears whatever was there.
        return (None, Detail::Question);
    }

    // 1. The question, when the agent asked one outright.
    if let Some(asked) = question_in(payload.get("tool_input")) {
        return (hooks::trim_note(&asked), Detail::Question);
    }

    // 2. What it wants to do.
    if let Some(tool) = payload.get("tool_name").and_then(|v| v.as_str()) {
        let detail = payload.get("tool_input").and_then(|input| {
            hooks::TOOL_DETAIL_KEYS
                .iter()
                .find_map(|key| input.get(key).and_then(|v| v.as_str()))
        });
        return (
            hooks::trim_note(&hooks::note_for_tool(tool, detail)),
            Detail::Tool,
        );
    }

    // 3. Whatever the transcript ends on — a question if it asked one, and
    //    otherwise the last thing it said.
    if let Some((said, rank)) = payload
        .get("transcript_path")
        .and_then(|v| v.as_str())
        .and_then(last_thing_said)
    {
        if let Some(note) = hooks::trim_note(&said) {
            return (Some(note), rank);
        }
    }

    // 4. Better than silence, and nothing more. The same sentence whatever is
    //    being asked, so it may fill a gap and never replace anything.
    (
        hooks::NOTE_KEYS
            .iter()
            .find_map(|key| payload.get(key).and_then(|v| v.as_str()))
            .and_then(hooks::trim_note),
        Detail::Message,
    )
}

/// A rank as it came out of the database.
///
/// Anything unrecognised counts as the weakest, so a row written by an older
/// build cannot block a better note from landing.
fn rank_from(stored: i64) -> hooks::Detail {
    use ft_core::hooks::Detail;
    match stored {
        3 => Detail::Question,
        2 => Detail::Tool,
        1 => Detail::Said,
        _ => Detail::Message,
    }
}

/// The question inside an `AskUserQuestion` call, with its options.
///
/// This is the one tool whose arguments *are* the question. Without reading it,
/// a card that could have said "What would you like to work on next? — Continue
/// prior task / Something new" says "wants to use AskUserQuestion".
fn question_in(input: Option<&serde_json::Value>) -> Option<String> {
    let first = input?.get("questions")?.as_array()?.first()?;
    let question = first.get("question")?.as_str()?;

    let options: Vec<String> = first
        .get("options")
        .and_then(|o| o.as_array())
        .map(|options| {
            options
                .iter()
                .filter_map(|o| o.get("label").and_then(|l| l.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    Some(ft_core::hooks::note_for_question(question, &options))
}

/// Whatever the agent's transcript ends on.
///
/// Newline-delimited JSON, one row per message, read from the end. The last
/// assistant row is what matters — and what it holds may be a question rather
/// than a sentence, because an agent asking you something does it through a
/// tool call. Reading only the prose walked straight past the question and
/// reported the paragraph before it.
///
/// The format belongs to the agent and can change under us — the same bargain
/// `first_run` makes with its configuration. If it ever stops parsing, the note
/// falls back to the hook's own message rather than breaking.
///
/// The documentation warns this file "may lag behind the current turn", so a
/// stale line is possible. Still more than the alternative says.
fn last_thing_said(path: &str) -> Option<(String, hooks::Detail)> {
    use ft_core::hooks::Detail;

    let text = std::fs::read_to_string(path).ok()?;

    for line in text.lines().rev() {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if row.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }

        let Some(blocks) = row
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
        else {
            continue;
        };

        // A question first, whatever else this row holds.
        if let Some(asked) = blocks
            .iter()
            .filter(|b| b.get("name").and_then(|n| n.as_str()) == Some("AskUserQuestion"))
            .find_map(|b| question_in(b.get("input")))
        {
            return Some((asked, Detail::Question));
        }

        let said = blocks
            .iter()
            .filter(|block| block.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|block| block.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(" ");

        if !said.trim().is_empty() {
            return Some((said, Detail::Said));
        }
    }

    None
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

#[cfg(test)]
mod hook_note_tests {
    use super::{note_for, question_in};
    use ft_core::hooks::Detail;
    use ft_core::SessionStatus;
    use serde_json::json;

    /// The one from the screenshot: the agent asked through a tool call, and
    /// the card showed the paragraph before it.
    #[test]
    fn a_question_asked_through_a_tool_is_the_question() {
        let (note, rank) = note_for(
            &json!({
                "tool_name": "AskUserQuestion",
                "tool_input": { "questions": [{
                    "question": "What would you like to work on next?",
                    "options": [
                        { "label": "Continue prior task" },
                        { "label": "Something new" },
                    ],
                }]},
            }),
            SessionStatus::NeedsYou,
        );

        assert_eq!(
            note.as_deref(),
            Some("What would you like to work on next? — Continue prior task / Something new")
        );
        assert_eq!(rank, Detail::Question, "nothing outranks being asked");
    }

    #[test]
    fn a_tool_call_beats_the_message_that_came_with_it() {
        let (note, rank) = note_for(
            &json!({
                "tool_name": "Bash",
                "tool_input": { "command": "git push --force" },
                "notification_message": "Claude needs your permission",
            }),
            SessionStatus::NeedsYou,
        );

        assert_eq!(note.as_deref(), Some("wants to run git push --force"));
        assert_eq!(rank, Detail::Tool);
    }

    /// "Claude needs your permission" is what a permission prompt says however
    /// specific the question, so it may fill a gap and never replace anything.
    #[test]
    fn the_generic_message_is_a_last_resort() {
        let (note, rank) = note_for(
            &json!({ "notification_message": "Claude needs your permission" }),
            SessionStatus::NeedsYou,
        );

        assert_eq!(note.as_deref(), Some("Claude needs your permission"));
        assert_eq!(rank, Detail::Message);
        assert!(!ft_core::hooks::worth_replacing(Detail::Tool, rank));
        assert!(!ft_core::hooks::worth_replacing(Detail::Question, rank));
    }

    #[test]
    fn a_newer_question_replaces_an_older_one() {
        assert!(ft_core::hooks::worth_replacing(
            Detail::Question,
            Detail::Question
        ));
    }

    #[test]
    fn working_again_clears_it() {
        let (note, rank) = note_for(
            &json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }),
            SessionStatus::Working,
        );

        assert_eq!(note, None, "a question that was answered is not news");
        assert_eq!(rank, Detail::Question, "and nothing may put it back");
    }

    /// The exact shape read off a real transcript, options and all.
    #[test]
    fn the_question_shape_is_the_one_agents_actually_write() {
        let asked = question_in(Some(&json!({
            "questions": [{
                "question": "Which one do you want?",
                "header": "Next task",
                "options": [
                    { "label": "Option A", "description": "the first" },
                    { "label": "Option B", "description": "the second" },
                ],
                "multiSelect": false,
            }]
        })));

        assert_eq!(
            asked.as_deref(),
            Some("Which one do you want? — Option A / Option B")
        );
    }

    #[test]
    fn markdown_is_not_shown_as_characters() {
        assert_eq!(
            ft_core::hooks::plain("Got it — you picked **Option A**."),
            "Got it — you picked Option A."
        );
        assert_eq!(ft_core::hooks::plain("run `ls -la` now"), "run ls -la now");
    }
}
