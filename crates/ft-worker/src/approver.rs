//! Answering the question "may I run this?".
//!
//! An agent running headless has nobody at a keyboard, so it is given a tool to
//! ask instead. This is that tool: a small MCP server the agent starts for
//! itself, which does nothing but carry one question to somebody who can answer
//! it and carry the answer back.
//!
//! It is a separate process because the agent spawns it — we do not get to
//! choose. What it has that nothing else in that process tree does is the
//! session's socket, which is how a question reaches a browser and how an
//! answer comes back. The wait has no timeout on purpose: the person being
//! asked may be asleep, and an agent that gave up and denied would be worse
//! than one that waited.
//!
//! ## What the agent expects
//!
//! Verified against a real run rather than inferred. The call arrives as an
//! ordinary MCP `tools/call`:
//!
//! ```json
//! { "name": "approve",
//!   "arguments": { "tool_name": "Write",
//!                  "input": { "file_path": "…", "content": "…" },
//!                  "tool_use_id": "toolu_…" } }
//! ```
//!
//! and the reply is a tool result whose text is a JSON-encoded decision —
//! `{"behavior":"allow","updatedInput":{…}}` or
//! `{"behavior":"deny","message":"…"}`. A denial reaches the agent verbatim,
//! which is why it is worth asking somebody for a reason.
//!
//! ## One thing to know when it seems not to fire
//!
//! Permission *rules* are evaluated before this tool is consulted, so a call
//! already covered by an allow rule in the host's own configuration never
//! arrives here at all. That is correct — somebody allowed it — but it does
//! mean a card that never appears is not necessarily a card that is broken.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::agentd::{AgentClient, FromAgent, ToAgent};

/// What the agent calls this server. Must match the launch flags.
pub const SERVER: &str = "firetower";
pub const TOOL: &str = "approve";

/// The full name the agent uses, which is how MCP addresses any tool.
pub fn tool_name() -> String {
    format!("mcp__{SERVER}__{TOOL}")
}

/// The configuration file that tells an agent to start this.
pub fn mcp_config(exe: &std::path::Path, session_id: &str, workspace: &std::path::Path) -> Value {
    json!({
        "mcpServers": {
            SERVER: {
                "command": exe.display().to_string(),
                // The workspace is named rather than inherited. This process is
                // started by the agent, so its working directory is the agent's
                // business and not something to build a file path on.
                "args": [
                    "mcp-approve",
                    "--session", session_id,
                    "--workspace", workspace.display().to_string(),
                ],
            }
        }
    })
}

/// Serve the permission tool until the agent closes our input.
///
/// Speaks JSON-RPC over stdin and stdout, which is what MCP is. Nothing may be
/// written to stdout except a response: that stream is the protocol.
pub async fn serve(session_id: &str, workspace: &std::path::Path) -> Result<()> {
    // What somebody has stopped being asked about.
    //
    // Held here rather than only written to the workspace's settings, because
    // an agent reads those once when it starts: a rule written half way through
    // a session has no effect on it, so "always" would have meant "from the
    // next session onwards" — and the second identical call would have asked
    // again, which is precisely the thing the button says it is for.
    let settled: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        let Some(response) = answer(&request, session_id, workspace, &settled).await else {
            // A notification. No reply, by definition.
            continue;
        };

        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        stdout.write_all(&bytes).await?;
        stdout.flush().await?;
    }
    Ok(())
}

/// One request, answered. `None` for a notification, which takes no reply.
async fn answer(
    request: &Value,
    session_id: &str,
    workspace: &std::path::Path,
    settled: &Arc<Mutex<HashSet<String>>>,
) -> Option<Value> {
    let method = request.get("method")?.as_str()?;
    let id = request.get("id").cloned();

    match method {
        "initialize" => Some(reply(
            id?,
            json!({
                // Echoed rather than asserted: the agent picks the version and
                // we have nothing to say about it.
                "protocolVersion": request
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
            }),
        )),

        "tools/list" => Some(reply(
            id?,
            json!({
                "tools": [{
                    "name": TOOL,
                    "description": "Decide whether a tool call may proceed.",
                    // Deliberately open. The shape is the agent's to choose and
                    // it has changed before; refusing an argument we did not
                    // expect would block the call rather than ask about it.
                    "inputSchema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": true,
                    },
                }]
            }),
        )),

        "tools/call" => {
            let id = id?;
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));
            let decision = ask(session_id, workspace, settled, &arguments).await;
            Some(reply(
                id,
                json!({
                    "content": [{
                        "type": "text",
                        // The decision travels as text because that is what a
                        // tool result carries. The agent parses it back.
                        "text": decision.to_string(),
                    }]
                }),
            ))
        }

        // Notifications, and anything a newer agent invented. An empty result
        // is a better answer than an error for something we simply do not act
        // on.
        _ => id.map(|id| reply(id, json!({}))),
    }
}

/// Put the question to whoever is watching this session, and wait.
async fn ask(
    session_id: &str,
    workspace: &std::path::Path,
    settled: &Arc<Mutex<HashSet<String>>>,
    arguments: &Value,
) -> Value {
    let tool_name = arguments
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("a tool")
        .to_string();
    let input = arguments.get("input").cloned().unwrap_or(json!({}));
    // The agent's own id for the call it is blocked on, which is what makes an
    // answer match a question even if several are open at once.
    let req = arguments
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{tool_name}-{}", input.to_string().len()));

    // Already settled, so nobody is asked twice. This is what makes "always"
    // mean now rather than from the next session onwards.
    if settled.lock().await.contains(&tool_name) {
        return settle(json!({ "behavior": "allow" }), &input);
    }

    match wait_for_a_decision(session_id, &req, &tool_name, &input).await {
        Ok(decision) => {
            if decision.get("firetowerAlways").and_then(Value::as_bool) == Some(true) {
                settled.lock().await.insert(tool_name.clone());
                if let Err(e) = allow_from_now_on(workspace, &tool_name).await {
                    // This half only matters if the agent is restarted in the
                    // same workspace, and it has already been remembered above
                    // either way. Worth a line, not worth failing the call
                    // somebody just approved.
                    tracing::warn!("could not write the rule about {tool_name}: {e:#}");
                }
            }
            settle(decision, &input)
        }
        Err(e) => {
            // Nobody can be reached. Denying is the safe answer and the message
            // reaches the agent, so the transcript says why rather than showing
            // a tool that mysteriously did nothing.
            tracing::warn!("could not ask about {tool_name}: {e:#}");
            json!({
                "behavior": "deny",
                "message": format!("Firetower could not ask anyone about this: {e:#}"),
            })
        }
    }
}

/// Finish a decision into something the agent will accept.
///
/// An allow must carry the tool's arguments back, and they must be the real
/// ones: an allow without `updatedInput` is refused outright, and the session
/// reports a permission error rather than the thing anybody actually asked
/// about. Only this end reliably has them — the browser sees a copy, this sees
/// what the agent sent — so the echo is added here rather than travelling the
/// full round trip and back.
///
/// Nothing rewrites them. Firetower shows a command and asks about it; showing
/// one and running another would make every card a lie.
fn settle(mut decision: Value, input: &Value) -> Value {
    // Ours, not the agent's: it says what to do about the *next* call like this
    // one, and the agent has no field for that. Removed first, so no path out
    // of here can carry it.
    if let Some(object) = decision.as_object_mut() {
        object.remove("firetowerAlways");
    }
    if decision.get("behavior").and_then(Value::as_str) != Some("allow") {
        return decision;
    }
    let Some(object) = decision.as_object_mut() else {
        return decision;
    };

    match object.get_mut("updatedInput") {
        // Nothing to say about the arguments, so they are the ones that came.
        None | Some(Value::Null) => {
            object.insert("updatedInput".into(), input.clone());
        }
        // Something to say, but only about part of it. An answer to a question
        // carries the answers and not the questions, and the agent matches on
        // both — so whatever was not spoken for is filled in from what it sent.
        Some(Value::Object(given)) => {
            if let Some(original) = input.as_object() {
                for (key, value) in original {
                    given.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
        _ => {}
    }
    decision
}

async fn wait_for_a_decision(
    session_id: &str,
    req: &str,
    tool_name: &str,
    input: &Value,
) -> Result<Value> {
    let mut client = AgentClient::connect(session_id)
        .await
        .context("connecting to the session")?;

    client
        .send(&ToAgent::Ask {
            req: req.to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
        })
        .await
        .context("asking")?;

    let mut frames = BufReader::new(client.into_stream()).lines();
    while let Some(frame) = frames.next_line().await? {
        let Ok(frame) = serde_json::from_str::<FromAgent>(&frame) else {
            continue;
        };
        // The echo of our own question comes back first; the answer follows.
        if let FromAgent::Decided { result } = frame {
            return Ok(result);
        }
    }
    anyhow::bail!("the session closed before this was answered")
}

/// Write the rule down, for an agent that starts again in this workspace.
///
/// The second half of remembering, and the weaker one. An agent reads its
/// settings when it starts, so this does nothing for the session in progress —
/// that is what the in-memory set above is for. It matters when the supervisor
/// restarts the agent and the workspace is still there.
///
/// Composed here rather than echoed back because the agent never offered the
/// choice: the callback its own SDK gives a host arrives with ready-made rules
/// to hand back, and the tool call this arrives through does not carry them.
///
/// Scoped to the tool rather than to these exact arguments, which is the
/// coarser of the two readings of "always". A narrower rule would need the
/// argument syntax for every tool, and getting that subtly wrong means a button
/// that silently does nothing.
///
/// Scoped to the workspace, so it lasts as long as the session does and goes
/// when the workspace does. Nothing here touches anybody's own configuration.
async fn allow_from_now_on(workspace: &std::path::Path, tool_name: &str) -> Result<()> {
    let dir = workspace.join(".claude");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join("settings.local.json");

    let mut settings: serde_json::Map<String, Value> = match tokio::fs::read_to_string(&path).await
    {
        Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => map,
            // Somebody's real settings in a shape we do not understand.
            // Leaving them is the only safe move.
            _ => anyhow::bail!("{} is not an object", path.display()),
        },
        _ => serde_json::Map::new(),
    };

    let permissions = settings
        .entry("permissions")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(permissions) = permissions.as_object_mut() else {
        anyhow::bail!("`permissions` is not an object");
    };
    let allow = permissions
        .entry("allow")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(allow) = allow.as_array_mut() else {
        anyhow::bail!("`permissions.allow` is not a list");
    };

    let rule = Value::String(tool_name.to_string());
    if allow.contains(&rule) {
        return Ok(());
    }
    allow.push(rule);

    tokio::fs::write(&path, serde_json::to_vec_pretty(&Value::Object(settings))?).await?;
    Ok(())
}

fn reply(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nowhere() -> &'static std::path::Path {
        std::path::Path::new("/tmp/firetower-approver-test")
    }

    fn none() -> Arc<Mutex<HashSet<String>>> {
        Arc::new(Mutex::new(HashSet::new()))
    }

    #[tokio::test]
    async fn it_introduces_itself_with_the_version_the_agent_asked_for() {
        let request = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" },
        });
        let response = answer(&request, "s_test", nowhere(), &none())
            .await
            .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(response["result"]["serverInfo"]["name"], SERVER);
    }

    #[tokio::test]
    async fn it_offers_exactly_one_tool_and_the_agent_is_told_its_full_name() {
        let request = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let response = answer(&request, "s_test", nowhere(), &none())
            .await
            .unwrap();
        let tools = response["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], TOOL);
        assert_eq!(tool_name(), "mcp__firetower__approve");
    }

    #[tokio::test]
    async fn a_notification_gets_no_reply() {
        let request = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(answer(&request, "s_test", nowhere(), &none())
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_call_nobody_can_answer_is_denied_with_a_reason() {
        // Denying is the safe end of a failure, and the message is what stops
        // this reading as a tool that silently did nothing.
        let request = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": TOOL, "arguments": {
                "tool_name": "Write", "input": {}, "tool_use_id": "toolu_x" } },
        });
        let response = answer(&request, "s_no-such-session-at-all", nowhere(), &none())
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "deny");
        assert!(decision["message"].as_str().unwrap().contains("Firetower"));
    }

    #[test]
    fn an_allow_carries_the_arguments_the_agent_actually_sent() {
        // Without this the agent refuses the allow and reports a permission
        // error, which reads as Firetower being broken rather than as a
        // decision having been made.
        let input = json!({ "file_path": "/tmp/x", "content": "banana" });
        let settled = settle(json!({ "behavior": "allow", "updatedInput": null }), &input);
        assert_eq!(settled["updatedInput"], input);
    }

    #[test]
    fn an_answer_keeps_the_questions_it_answers() {
        // The agent matches an answer to its question by the question's own
        // text. Allowing without them hands it a result that says nothing.
        let input = json!({ "questions": [{ "question": "Which?", "options": [] }] });
        let settled = settle(
            json!({ "behavior": "allow", "updatedInput": { "answers": { "Which?": "A" } } }),
            &input,
        );
        assert_eq!(settled["updatedInput"]["answers"]["Which?"], "A");
        assert_eq!(settled["updatedInput"]["questions"], input["questions"]);
    }

    #[test]
    fn what_the_decision_says_beats_what_the_agent_sent() {
        let settled = settle(
            json!({ "behavior": "allow", "updatedInput": { "answers": "mine" } }),
            &json!({ "answers": "theirs", "questions": [] }),
        );
        assert_eq!(settled["updatedInput"]["answers"], "mine");
    }

    #[test]
    fn our_own_marker_never_reaches_the_agent() {
        for behavior in ["allow", "deny"] {
            let settled = settle(
                json!({ "behavior": behavior, "message": "x", "firetowerAlways": true }),
                &json!({}),
            );
            assert!(
                settled.get("firetowerAlways").is_none(),
                "{behavior}: the agent has no field for this"
            );
        }
    }

    #[tokio::test]
    async fn a_tool_already_settled_is_never_asked_about_again() {
        // The whole point of the button: the next identical call goes straight
        // through, in this session, without anybody being interrupted twice.
        let settled = none();
        settled.lock().await.insert("Write".into());

        let request = json!({
            "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": TOOL, "arguments": {
                "tool_name": "Write",
                "input": { "file_path": "/w/two.txt" },
                "tool_use_id": "toolu_second" } },
        });
        // No session is listening, so anything that actually asked would be
        // denied — which is what makes this assertion mean something.
        let response = answer(&request, "s_nobody-home", nowhere(), &settled)
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["file_path"], "/w/two.txt");
    }

    #[tokio::test]
    async fn always_writes_a_rule_the_agent_reads_before_asking_again() {
        let workspace = tempfile::tempdir().unwrap();
        allow_from_now_on(workspace.path(), "Write").await.unwrap();
        allow_from_now_on(workspace.path(), "Write").await.unwrap();

        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(workspace.path().join(".claude/settings.local.json")).unwrap(),
        )
        .unwrap();
        let allow = written["permissions"]["allow"].as_array().unwrap();
        assert_eq!(allow, &[json!("Write")], "asked twice, written once");
    }

    #[tokio::test]
    async fn remembering_a_decision_leaves_other_settings_alone() {
        let workspace = tempfile::tempdir().unwrap();
        let dir = workspace.path().join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.local.json"),
            r#"{"env":{"KEEP":"me"},"permissions":{"deny":["Bash(rm *)"]}}"#,
        )
        .unwrap();

        allow_from_now_on(workspace.path(), "Read").await.unwrap();

        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("settings.local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(written["env"]["KEEP"], "me");
        assert_eq!(written["permissions"]["deny"][0], "Bash(rm *)");
        assert_eq!(written["permissions"]["allow"][0], "Read");
    }

    #[test]
    fn a_denial_is_left_exactly_as_it_was_decided() {
        let denied = settle(
            json!({ "behavior": "deny", "message": "not on production" }),
            &json!({ "command": "rm -rf /" }),
        );
        assert_eq!(denied["behavior"], "deny");
        assert_eq!(denied["message"], "not on production");
        assert!(denied.get("updatedInput").is_none());
    }

    #[test]
    fn the_configuration_names_this_binary_and_this_session() {
        let config = mcp_config(
            std::path::Path::new("/usr/bin/firetower"),
            "s_01abc",
            std::path::Path::new("/w"),
        );
        let server = &config["mcpServers"][SERVER];
        assert_eq!(server["command"], "/usr/bin/firetower");
        assert_eq!(server["args"][0], "mcp-approve");
        assert_eq!(server["args"][2], "s_01abc");
    }
}
