//! Driving an agent that speaks a protocol instead of a terminal.
//!
//! The worker's half of [`agentd`](crate::agentd). Everything here is about
//! reaching a supervisor that is already running: connecting to its socket,
//! forwarding what it says up to the control plane, and passing turns and
//! answers back down.
//!
//! Nothing here reads what the agent said. A line goes up as it arrived, and
//! what it means is decided in the control plane — see [`ft_core::normalise`]
//! for why that boundary is where it is.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use ft_core::SessionId;
use ft_proto::ToServer;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::agentd::{socket_path, AgentClient, FromAgent, ToAgent};

/// How long to wait for a freshly launched supervisor to start listening.
///
/// Generous because the first thing it does is start an agent, and an agent's
/// own startup — reading a repository's configuration, connecting whatever MCP
/// servers it was given — is not quick and is not ours to hurry.
const STARTUP: Duration = Duration::from_secs(30);

/// The command that puts a supervised agent under tmux.
///
/// A shell line rather than argv because that is what tmux takes. Nothing here
/// is attacker-controlled — the session id is ours and the path is one we
/// built — but it is quoted anyway, because the day one of those becomes
/// user-named should not be the day this becomes a hole.
pub fn tmux_command(
    exe: &Path,
    session_id: &SessionId,
    workspace: &Path,
    agent: ft_core::Agent,
) -> String {
    format!(
        "{} agent-run --session {} --workspace {} --agent {}",
        quote(&exe.display().to_string()),
        quote(session_id.as_str()),
        quote(&workspace.display().to_string()),
        quote(&format!("{agent:?}")),
    )
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// Wait until the supervisor for this session is answering.
///
/// Polling rather than a signal because the thing we are waiting for is in
/// another process tree, started by tmux, which tells us nothing about how it
/// got on.
pub async fn wait_until_listening(session_id: &SessionId) -> Result<()> {
    let deadline = std::time::Instant::now() + STARTUP;
    let mut wait = Duration::from_millis(20);

    loop {
        if socket_path(session_id.as_str()).exists()
            && AgentClient::connect(session_id.as_str()).await.is_ok()
        {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            anyhow::bail!(
                "the agent for {session_id} did not start listening within {}s",
                STARTUP.as_secs()
            );
        }
        tokio::time::sleep(wait).await;
        // Backs off so a slow start is not a thousand connection attempts.
        wait = (wait * 2).min(Duration::from_millis(500));
    }
}

/// Wait until the agent has answered the request with this id.
///
/// An opening is a conversation, not a burst: an app-server refuses everything
/// with "Not initialized" until it has finished starting, and what it refuses
/// it does not come back to. Sending the next request only once the last has
/// been answered is the difference between a session that starts and one that
/// sits there.
///
/// Read from the log rather than from a socket because the log is where every
/// line already lands, written and flushed before anybody is offered it — so
/// there is no window in which an answer arrives and nothing sees it.
pub async fn wait_for_answer(workspace: &Path, id: u64) -> Result<()> {
    let log = crate::agentd::log_path(workspace);
    let deadline = std::time::Instant::now() + STARTUP;

    loop {
        if let Ok(text) = tokio::fs::read_to_string(&log).await {
            for line in text.lines() {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                // A request carries both; only an answer carries an id alone.
                if value.get("method").is_some() {
                    continue;
                }
                if value.get("id").and_then(serde_json::Value::as_u64) == Some(id) {
                    return Ok(());
                }
            }
        }

        if std::time::Instant::now() >= deadline {
            anyhow::bail!(
                "the agent did not answer request {id} within {}s",
                STARTUP.as_secs()
            );
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Send one frame to a running agent and hang up.
///
/// A new connection per message on purpose. These are rare — somebody typing —
/// and a held connection would be one more thing to notice had gone stale.
pub async fn tell(session_id: &SessionId, frame: &ToAgent) -> Result<()> {
    AgentClient::connect(session_id.as_str())
        .await
        .with_context(|| format!("no agent is listening for {session_id}"))?
        .send(frame)
        .await
}

/// Forward everything an agent says to the control plane, until it stops.
///
/// Returns when the agent exits or the connection drops. The caller runs this
/// off the serve loop; it is unbounded in time by nature.
pub async fn watch(
    session_id: SessionId,
    since_line: u64,
    out: mpsc::Sender<ToServer>,
) -> Result<()> {
    let mut client = AgentClient::connect(session_id.as_str())
        .await
        .with_context(|| format!("no agent is listening for {session_id}"))?;
    client
        .send(&ToAgent::Watch {
            from_line: since_line,
        })
        .await?;

    let mut frames = BufReader::new(client.into_stream()).lines();
    while let Some(frame) = frames.next_line().await? {
        let Ok(frame) = serde_json::from_str::<FromAgent>(&frame) else {
            tracing::debug!(session = %session_id, "ignoring a frame we could not read");
            continue;
        };
        let forwarded = match frame {
            FromAgent::Line { line_no, line } => ToServer::AgentLine {
                session_id: session_id.clone(),
                line_no,
                line,
            },
            FromAgent::Approval {
                req,
                tool_name,
                input,
            } => ToServer::AgentAsks {
                session_id: session_id.clone(),
                req,
                tool_name,
                input,
            },
            FromAgent::Exited { .. } => ToServer::AgentClosed {
                session_id: session_id.clone(),
            },
            // Ours went the other way; this is somebody else's answer.
            FromAgent::Decided { .. } => continue,
        };

        let closing = matches!(forwarded, ToServer::AgentClosed { .. });
        if out.send(forwarded).await.is_err() {
            // The control plane went away. The log has everything, so there is
            // nothing to rescue — whoever comes back asks from their cursor.
            return Ok(());
        }
        if closing {
            return Ok(());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_launch_line_survives_a_path_with_a_space_in_it() {
        let command = tmux_command(
            Path::new("/opt/my worker/firetower-worker"),
            &SessionId::from_stored("s_01test"),
            Path::new("/tmp/some workspace"),
            ft_core::Agent::ClaudeCode,
        );
        assert!(command.contains("'/opt/my worker/firetower-worker'"));
        assert!(command.contains("'/tmp/some workspace'"));
        assert!(command.contains("--agent 'ClaudeCode'"));
    }

    /// A request carries an id *and* a method; only an answer carries an id
    /// alone. Reading a request as the answer to itself would let the opening
    /// run on before the agent was ready, which is the bug this exists for.
    #[tokio::test]
    async fn an_answer_is_told_from_a_request_that_shares_its_id() {
        let dir = tempfile::TempDir::new().unwrap();
        let workspace = dir.path();
        tokio::fs::create_dir_all(crate::agentd::dir_for(workspace))
            .await
            .unwrap();

        let log = crate::agentd::log_path(workspace);
        tokio::fs::write(
            &log,
            concat!(
                // Something it asked us, which happens to carry the same id.
                r#"{"id":1,"method":"item/commandExecution/requestApproval","params":{}}"#,
                "\n",
            ),
        )
        .await
        .unwrap();

        let waited =
            tokio::time::timeout(Duration::from_millis(150), wait_for_answer(workspace, 1)).await;
        assert!(waited.is_err(), "a request is not an answer to itself");

        // And the real answer ends it.
        tokio::fs::write(&log, "{\"id\":1,\"result\":{}}\n")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), wait_for_answer(workspace, 1))
            .await
            .expect("should not have timed out")
            .expect("the answer is there");
    }

    #[tokio::test]
    async fn waiting_for_an_agent_that_never_starts_gives_up_and_says_so() {
        // Not a hang. A session whose supervisor died has to fail visibly, or
        // it sits in `Starting` with nothing recorded — the exact failure the
        // protocol version exists to prevent.
        let session = SessionId::from_stored("s_definitely-not-running-01");
        let waited =
            tokio::time::timeout(Duration::from_millis(200), wait_until_listening(&session)).await;
        // Either it is still trying when we stop it, or it already refused.
        match waited {
            Err(_) => {}
            Ok(result) => assert!(result.is_err(), "a missing agent is not a success"),
        }
    }
}
