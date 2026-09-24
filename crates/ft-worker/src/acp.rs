//! A durable stdio connection to an ACP agent, hosted underneath agentd/tmux.
//! No UI projection lives here: both wire directions are journalled for core's
//! normaliser. The agent performs file and terminal work using its own tools;
//! this client deliberately advertises neither optional host capability.
use anyhow::{bail, Context, Result};
use ft_core::acp::{permission_outcome, request_key, Input, Record};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout, Command};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize)]
struct Saved {
    session: String,
    carry: Option<String>,
}

pub async fn run(session: &str, workspace: &Path) -> Result<()> {
    let mut command = Command::new("kimi");
    command.arg("acp");
    serve(
        command,
        session,
        workspace,
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    )
    .await
}

/// The process/stdio seam also lets integration tests drive a real fixture
/// subprocess without installing an agent or borrowing somebody's credentials.
pub async fn serve<R, W>(
    mut command: Command,
    session: &str,
    workspace: &Path,
    input: R,
    mut output: W,
) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let epoch = ft_core::SessionId::new().to_string();
    record(
        &mut output,
        Record::Started {
            epoch: epoch.clone(),
        },
    )
    .await?;
    let result = async {
        let mut child = command
            .current_dir(workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("starting Kimi ACP; install kimi and run kimi login as the worker user")?;
        let mut stdin = child.stdin.take().context("ACP stdin")?;
        let mut stdout = BufReader::new(child.stdout.take().context("ACP stdout")?).lines();
        let result = connection(
            session,
            workspace,
            &epoch,
            &mut stdin,
            &mut stdout,
            input,
            &mut output,
        )
        .await;
        // Ending the bridge must not leave an agent holding credentials and
        // working after its supervisor has gone away.
        let _ = child.kill().await;
        let _ = child.wait().await;
        result
    }
    .await;
    if let Err(error) = &result {
        record(
            &mut output,
            Record::Failed {
                detail: format!("{error:#}"),
            },
        )
        .await?;
    }
    result
}

async fn record<W: AsyncWrite + Unpin>(out: &mut W, value: Record) -> Result<()> {
    write(out, &serde_json::to_value(value)?).await
}
async fn write<W: AsyncWrite + Unpin>(out: &mut W, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    out.write_all(&bytes).await?;
    out.flush().await?;
    Ok(())
}
async fn send<W: AsyncWrite + Unpin>(
    stdin: &mut ChildStdin,
    out: &mut W,
    message: Value,
) -> Result<()> {
    // Record intent before execution. A failed write is reported, never retried.
    record(
        out,
        Record::Sent {
            message: message.clone(),
        },
    )
    .await?;
    write(stdin, &message).await
}
fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
}

async fn next(stdout: &mut Lines<BufReader<ChildStdout>>) -> Result<Value> {
    let line = stdout
        .next_line()
        .await?
        .context("ACP agent exited or closed stdout")?;
    let message: Value =
        serde_json::from_str(&line).context("ACP agent returned malformed JSON")?;
    anyhow::ensure!(
        message["jsonrpc"] == "2.0" && message.is_object(),
        "ACP agent returned an invalid JSON-RPC envelope"
    );
    Ok(message)
}

async fn exchange<W: AsyncWrite + Unpin>(
    stdin: &mut ChildStdin,
    stdout: &mut Lines<BufReader<ChildStdout>>,
    out: &mut W,
    request: Value,
    replay: bool,
) -> Result<Value> {
    let id = request["id"].clone();
    let method = request["method"].as_str().unwrap_or("").to_owned();
    send(stdin, out, request).await?;
    tokio::time::timeout(STARTUP_TIMEOUT, async {
        loop {
            let message = next(stdout).await?;
            record(
                out,
                Record::Received {
                    message: message.clone(),
                    replay,
                },
            )
            .await?;
            if message.get("method").is_none() && message["id"] == id {
                return Ok(message);
            }
            if message.get("method").is_some() && message.get("id").is_some() {
                // Startup and history replay never authorize tools.
                reject_request(stdin, out, &message).await?;
            }
        }
    })
    .await
    .with_context(|| format!("ACP {method} timed out; no prompt was replayed"))?
}
fn result(message: &Value) -> Result<&Value> {
    if let Some(error) = message.get("error") {
        bail!("ACP request failed: {error}; check the agent login and quota on this worker");
    }
    message.get("result").context("ACP response has no result")
}
async fn reject_request<W: AsyncWrite + Unpin>(
    stdin: &mut ChildStdin,
    out: &mut W,
    message: &Value,
) -> Result<()> {
    let reply = if message["method"] == "session/request_permission" {
        json!({"jsonrpc":"2.0", "id":message["id"], "result":{"outcome":{"outcome":"cancelled"}}})
    } else {
        json!({"jsonrpc":"2.0", "id":message["id"], "error":{"code":-32601, "message":"Client capability not supported"}})
    };
    send(stdin, out, reply).await
}
async fn save(path: &Path, value: &Saved) -> Result<()> {
    let staging = path.with_extension("tmp");
    tokio::fs::write(&staging, serde_json::to_vec(value)?).await?;
    tokio::fs::rename(staging, path).await?;
    Ok(())
}

async fn connection<R, W>(
    session: &str,
    workspace: &Path,
    epoch: &str,
    stdin: &mut ChildStdin,
    stdout: &mut Lines<BufReader<ChildStdout>>,
    input: R,
    out: &mut W,
) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let dir = crate::agentd::dir_for(workspace);
    tokio::fs::create_dir_all(&dir).await?;
    let state_path = dir.join(format!("acp-{session}.json"));
    let previous: Option<Saved> = match tokio::fs::read(&state_path).await {
        Ok(bytes) => Some(serde_json::from_slice(&bytes).context("reading saved ACP session")?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let init = exchange(stdin, stdout, out, rpc(1, "initialize", json!({"protocolVersion":1, "clientCapabilities":{}, "clientInfo":{"name":"firetower", "version":env!("CARGO_PKG_VERSION")}})), false).await?;
    let init = result(&init)?;
    anyhow::ensure!(
        init["protocolVersion"] == 1,
        "ACP agent did not negotiate protocol version 1"
    );
    let can_load = init["agentCapabilities"]["loadSession"] == true;
    let cwd = workspace.canonicalize()?.to_string_lossy().into_owned();
    let mut loaded = false;
    if let Some(saved) = &previous {
        if can_load {
            let response = exchange(
                stdin,
                stdout,
                out,
                rpc(
                    2,
                    "session/load",
                    json!({"sessionId":saved.session, "cwd":cwd, "mcpServers":[]}),
                ),
                true,
            )
            .await?;
            // Kimi 2.0.2's explicit missing-session response, verified against
            // the binary. Do not classify arbitrary invalid params as loss.
            let missing = response["error"]["code"] == -32602
                && response["error"]["data"]["sessionId"] == saved.session
                && response["error"]["message"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("Invalid params: Unknown sessionId:"));
            if !missing {
                result(&response)?;
                loaded = true;
            }
        }
    }
    let mut saved = if loaded {
        previous.context("loaded session missing its record")?
    } else {
        let response = exchange(
            stdin,
            stdout,
            out,
            rpc(3, "session/new", json!({"cwd":cwd, "mcpServers":[]})),
            false,
        )
        .await?;
        let id = result(&response)?["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("ACP session/new returned no sessionId")?
            .to_owned();
        let carry = crate::history::carry(workspace, session, ft_core::Agent::KimiCode).await?;
        Saved { session: id, carry }
    };
    save(&state_path, &saved).await?;
    record(
        out,
        Record::Ready {
            session: saved.session.clone(),
        },
    )
    .await?;

    let mut input = input.lines();
    let mut next_id = 4;
    let mut active: Option<u64> = None;
    let mut configuring: Option<Value> = None;
    let mut pending: HashMap<String, Value> = HashMap::new();
    let mut cancel_deadline = None;
    let mut queued = VecDeque::new();
    loop {
        if active.is_none() {
            if let Some(text) = queued.pop_front() {
                let text = if let Some(history) = saved.carry.take() {
                    save(&state_path, &saved).await?;
                    format!("Previous conversation, for context only. Do not repeat completed actions:\n{history}\n\nNew user request:\n{text}")
                } else {
                    text
                };
                let id = next_id;
                next_id += 1;
                active = Some(id);
                send(
                    stdin,
                    out,
                    rpc(
                        id,
                        "session/prompt",
                        json!({"sessionId":saved.session, "prompt":[{"type":"text", "text":text}]}),
                    ),
                )
                .await?;
            }
        }
        tokio::select! {
            line = input.next_line() => {
                let Some(line) = line? else { return Ok(()) };
                let command: Input = serde_json::from_str(&line).context("invalid Firetower ACP command")?;
                match command {
                    Input::Prompt { text } => {
                        if text.trim().is_empty() { continue; }
                        anyhow::ensure!(queued.len() < 64, "ACP prompt queue is full; pending prompts were not replayed");
                        queued.push_back(text);
                    }
                    Input::Cancel => {
                        if active.is_some() {
                            for (_, message) in pending.drain() { reject_request(stdin, out, &message).await?; }
                            send(stdin, out, json!({"jsonrpc":"2.0", "method":"session/cancel", "params":{"sessionId":saved.session}})).await?;
                            cancel_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(10));
                        }
                    }
                    Input::Decide { req, decision } => {
                        if let Some(message) = pending.remove(&req) {
                            let outcome = permission_outcome(&message["params"]["options"], &decision);
                            send(stdin, out, json!({"jsonrpc":"2.0", "id":message["id"], "result":{"outcome":outcome}})).await?;
                        }
                        // Stale answers cannot authorize a reused wire ID.
                    }
                    Input::Configure { id, config_id, value } => {
                        if configuring.is_some() {
                            record(out, Record::ConfigurationRejected { id, detail: "Another setting change is still awaiting Kimi's response".into() }).await?;
                            continue;
                        }
                        configuring = Some(json!(id));
                        // A configuration response is journalled like every
                        // other RPC. Keep reading prompts and permissions while
                        // it is outstanding; it is not a conversation turn.
                        send(stdin, out, json!({"jsonrpc":"2.0", "id":id, "method":"session/set_config_option", "params":{"sessionId":saved.session, "configId":config_id, "value":value}})).await?;
                    }
                }
            }
            message = next(stdout) => {
                let message = message?;
                if message.get("method").is_some() && message.get("id").is_some() {
                    if message["method"] == "session/request_permission" && message["params"]["sessionId"] == saved.session && active.is_some() && cancel_deadline.is_none() {
                        let key = request_key(epoch, &message["id"]);
                        anyhow::ensure!(!pending.contains_key(&key), "ACP agent reused an outstanding permission ID");
                        pending.insert(key, message.clone());
                    } else {
                        reject_request(stdin, out, &message).await?;
                        continue;
                    }
                }
                record(out, Record::Received { message: message.clone(), replay: false }).await?;
                if message.get("method").is_none() && configuring.as_ref().is_some_and(|id| *id == message["id"]) {
                    configuring = None;
                }
                if message.get("method").is_none() && active.is_some_and(|id| message["id"] == id) {
                    active = None;
                    cancel_deadline = None;
                    for (_, request) in pending.drain() { reject_request(stdin, out, &request).await?; }
                }
            }
            _ = async { if let Some(deadline) = cancel_deadline { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } } => {
                bail!("ACP agent did not acknowledge cancellation; its connection was stopped");
            }
        }
    }
}
