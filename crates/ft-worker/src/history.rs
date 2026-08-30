//! What was said before, for an agent that has to start over.
//!
//! A relaunched session keeps its workspace, its branch and Firetower's whole
//! transcript. What it can lose is the agent's own memory of the conversation —
//! and then the first thing it says is that it does not know what you are
//! talking about.
//!
//! The log holds everything, and almost none of it is the conversation: of the
//! 737 lines in the session this was written for, 538 were streaming deltas and
//! 26 were tool results carrying 424 KB of file contents. What somebody typed
//! and what the agent said came to 14 KB. So this filters rather than
//! summarises, and [`ft_core::normalise`] already knows how.

use std::path::Path;

use anyhow::{Context, Result};
use ft_core::normalise::Reader;
use ft_core::turn::{ItemKind, StreamKind, TurnEvent};

/// Where the reconstruction lands, inside the workspace's own directory.
pub const FILE: &str = "conversation-so-far.md";

/// How many exchanges to carry. A week-old session is not 14 KB.
const KEEP: usize = 40;

/// One thing that happened, as it will be read back.
#[derive(Debug, PartialEq, Eq)]
enum Said {
    You(String),
    Agent(String),
    /// A question the agent asked, and what was chosen.
    Answered(Vec<(String, String)>),
    Did(String),
}

/// Write the conversation beside the log, and say whether there was one.
pub async fn write(workspace: &Path, session_id: &str, agent: ft_core::Agent) -> Result<bool> {
    let log = crate::agentd::readable_log(workspace, session_id);
    let Ok(text) = tokio::fs::read_to_string(&log).await else {
        return Ok(false);
    };

    let mut reader = Reader::for_agent(agent);
    let events: Vec<TurnEvent> = text.lines().flat_map(|line| reader.push(line)).collect();

    let Some(rendered) = render(&events) else {
        return Ok(false);
    };

    let dir = crate::agentd::dir_for(workspace);
    tokio::fs::create_dir_all(&dir).await?;
    let at = dir.join(FILE);
    tokio::fs::write(&at, rendered)
        .await
        .with_context(|| format!("writing {}", at.display()))?;

    point_at_it(workspace).await;
    Ok(true)
}

/// The marker around what this adds to `AGENTS.md`, so a second restart
/// replaces it rather than stacking another copy underneath.
const MARK: &str = "<!-- firetower:restarted -->";

/// Tell the agent the file is there, where it already reads.
async fn point_at_it(workspace: &Path) {
    let at = workspace.join("AGENTS.md");
    let existing = tokio::fs::read_to_string(&at).await.unwrap_or_default();
    let kept = match existing.split_once(MARK) {
        Some((before, _)) => before.trim_end().to_string(),
        None => existing.trim_end().to_string(),
    };

    let note = format!(
        "{kept}\n\n{MARK}\n\n## This session was restarted\n\n\
         You are picking up work already in progress and you do not remember \
         it. `.firetower/{FILE}` is what was said before — read it before \
         answering. The branch and the files are as they were left.\n"
    );

    if let Err(e) = tokio::fs::write(&at, note).await {
        tracing::warn!("could not write {}: {e:#}", at.display());
    }
}

/// Turn the events into something worth reading, or nothing.
fn render(events: &[TurnEvent]) -> Option<String> {
    let said = collect(events);
    let talk = said.iter().filter(|s| !matches!(s, Said::Did(_))).count();
    if talk == 0 {
        return None;
    }

    let over = said.len().saturating_sub(KEEP);
    let mut out = String::from("# The conversation so far\n\n");
    out.push_str(
        "This session was restarted and its agent no longer remembers it. \
         The workspace, the branch and the files are unchanged.\n\n",
    );
    if over > 0 {
        out.push_str(&format!("_The earliest {over} are left out._\n\n"));
    }

    for item in said.iter().skip(over) {
        match item {
            Said::You(text) => {
                out.push_str("## They said\n\n");
                for line in text.trim().lines() {
                    out.push_str(&format!("> {line}\n"));
                }
                out.push('\n');
            }
            Said::Agent(text) => {
                out.push_str("## You said\n\n");
                out.push_str(text.trim());
                out.push_str("\n\n");
            }
            Said::Answered(pairs) => {
                out.push_str("## You asked, and they chose\n\n");
                for (question, answer) in pairs {
                    out.push_str(&format!("- {question} → **{answer}**\n"));
                }
                out.push('\n');
            }
            Said::Did(what) => {
                out.push_str(&format!("- {what}\n"));
            }
        }
    }
    Some(out)
}

/// Fold the stream into the handful of things worth carrying.
fn collect(events: &[TurnEvent]) -> Vec<Said> {
    let mut out: Vec<Said> = Vec::new();
    // Which item each open card is, so its text lands in the right place and a
    // tool call can be named without quoting what it returned.
    let mut open: std::collections::HashMap<String, (ItemKind, Option<String>)> =
        std::collections::HashMap::new();
    let mut text: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut input: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();

    for event in events {
        match event {
            TurnEvent::ItemStarted {
                item, kind, title, ..
            } => {
                open.insert(item.to_string(), (*kind, title.clone()));
            }
            TurnEvent::ContentDelta {
                item,
                stream: StreamKind::AssistantText | StreamKind::UserText,
                delta,
            } => {
                text.entry(item.to_string()).or_default().push_str(delta);
            }
            TurnEvent::ItemUpdated { item, data } => {
                input.insert(item.to_string(), data.clone());
            }
            TurnEvent::ItemCompleted { item, .. } => {
                let Some((kind, title)) = open.remove(item.as_str()) else {
                    continue;
                };
                let body = text.remove(item.as_str()).unwrap_or_default();
                let args = input.remove(item.as_str());
                match kind {
                    ItemKind::UserMessage if !body.trim().is_empty() => out.push(Said::You(body)),
                    ItemKind::AssistantMessage if !body.trim().is_empty() => {
                        out.push(Said::Agent(body))
                    }
                    // Named, never quoted: the results are the bulk of the log
                    // and the files they came from have not moved.
                    ItemKind::CommandExecution
                    | ItemKind::FileChange
                    | ItemKind::FileRead
                    | ItemKind::McpToolCall
                    | ItemKind::WebSearch
                    | ItemKind::SubagentCall => {
                        // The command, not the tool that ran it: twenty-five
                        // lines of "ran Bash" say nothing anybody can use.
                        let what = args
                            .as_ref()
                            .and_then(subject)
                            .or(title)
                            .unwrap_or_else(|| "something".into());
                        let line = Said::Did(format!("{} `{}`", did(kind), trim(&what)));
                        if out.last() != Some(&line) {
                            out.push(line);
                        }
                    }
                    _ => {}
                }
            }
            // The answers to a question are in its result, not in anything
            // anybody typed — so without this the conversation loses every
            // decision that was made by choosing rather than by writing.
            TurnEvent::UserInputResolved { answers, .. } => {
                let pairs = chosen(answers);
                if !pairs.is_empty() {
                    out.push(Said::Answered(pairs));
                }
            }
            _ => {}
        }
    }
    out
}

/// `"the question"="what was chosen"`, which is how the answer comes back.
fn chosen(answers: &serde_json::Value) -> Vec<(String, String)> {
    let text = match answers {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    let mut out = Vec::new();
    let mut rest = text.as_str();
    while let Some(at) = rest.find("\\\"") {
        rest = &rest[at + 2..];
        let Some(end) = rest.find("\\\"") else { break };
        let question = rest[..end].to_string();
        rest = &rest[end + 2..];
        let Some(eq) = rest.find("=\\\"") else { break };
        rest = &rest[eq + 3..];
        let Some(end) = rest.find("\\\"") else { break };
        out.push((question, rest[..end].to_string()));
        rest = &rest[end + 2..];
    }
    if out.is_empty() {
        for (question, answer) in pairs_in(&text) {
            out.push((question, answer));
        }
    }
    out
}

/// The same pairs, unescaped — how they read when the value is already a string.
fn pairs_in(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find('"') {
        rest = &rest[at + 1..];
        let Some(end) = rest.find('"') else { break };
        let question = rest[..end].to_string();
        rest = &rest[end + 1..];
        if !rest.starts_with("=\"") {
            continue;
        }
        rest = &rest[2..];
        let Some(end) = rest.find('"') else { break };
        out.push((question, rest[..end].to_string()));
        rest = &rest[end + 1..];
    }
    out
}

/// What a tool call was actually about, from its arguments.
fn subject(args: &serde_json::Value) -> Option<String> {
    for key in [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "description",
    ] {
        if let Some(value) = args.get(key).and_then(serde_json::Value::as_str) {
            if !value.trim().is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// One line's worth, with the newlines taken out of a heredoc.
fn trim(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 90 {
        format!("{}…", flat.chars().take(90).collect::<String>())
    } else {
        flat
    }
}

fn did(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::CommandExecution => "ran",
        ItemKind::FileChange => "changed",
        ItemKind::FileRead => "read",
        ItemKind::WebSearch => "searched",
        ItemKind::SubagentCall => "delegated to",
        _ => "called",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from(lines: &[&str]) -> Option<String> {
        let mut reader = Reader::for_agent(ft_core::Agent::ClaudeCode);
        let events: Vec<TurnEvent> = lines.iter().flat_map(|l| reader.push(l)).collect();
        render(&events)
    }

    fn typed(text: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"u{text}","message":{{"content":[{{"type":"text","text":"{text}"}}]}}}}"#
        )
    }

    /// Prose reaches the log as deltas, not as the message that restates it —
    /// Firetower launches with `--include-partial-messages` — so a fixture that
    /// skipped them would prove nothing about a real session.
    fn replied(text: &str) -> Vec<String> {
        vec![
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}}"#.to_string(),
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}"#.to_string(),
            format!(
                r#"{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{text}"}}}}}}"#
            ),
            r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#.to_string(),
            r#"{"type":"stream_event","event":{"type":"message_stop"}}"#.to_string(),
        ]
    }

    #[test]
    fn both_halves_of_the_conversation_are_carried_in_order() {
        let mut lines = vec![typed("make it faster")];
        lines.extend(replied("done, it was the loop"));
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let out = from(&refs).expect("there was a conversation");

        let said = out.find("make it faster").expect("what they typed");
        let reply = out.find("done, it was the loop").expect("what it answered");
        assert!(said < reply, "in the order they happened:\n{out}");
    }

    /// The bulk of a log is tool output — 424 KB of it in the session this was
    /// written for. The files it came from are still there to be read again.
    #[test]
    fn what_a_tool_returned_is_never_quoted() {
        let huge = "x".repeat(5000);
        let out = from(&[
            &typed("read it"),
            r#"{"type":"assistant","uuid":"a2","message":{"id":"m2","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"src/main.rs"}}]}}"#,
            &format!(
                r#"{{"type":"user","uuid":"u2","message":{{"content":[{{"tool_use_id":"t1","type":"tool_result","content":"{huge}"}}]}}}}"#
            ),
        ])
        .expect("there was a conversation");

        assert!(!out.contains(&huge), "the result must not be in it");
        assert!(
            out.contains("read `src/main.rs`"),
            "but the call is named by what it touched:\n{out}"
        );
    }

    /// A decision made by choosing is still a decision. It lives in the result
    /// of the question, so dropping tool results would drop it.
    #[test]
    fn what_was_chosen_is_carried_as_well_as_what_was_typed() {
        let out = from(&[
            &typed("how should it look?"),
            r#"{"type":"assistant","uuid":"a3","message":{"id":"m3","content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[{"question":"Which colours?","header":"Colour","options":[{"label":"Per-language"},{"label":"One"}]}]}}]}}"#,
            r#"{"type":"user","uuid":"u3","message":{"content":[{"tool_use_id":"q1","type":"tool_result","content":"The user answered: \"Which colours?\"=\"Per-language\""}]}}"#,
        ])
        .expect("there was a conversation");

        assert!(out.contains("Which colours?"), "{out}");
        assert!(out.contains("Per-language"), "{out}");
    }

    #[test]
    fn a_log_with_no_conversation_in_it_is_not_worth_writing() {
        assert!(from(&[r#"{"type":"system","subtype":"init"}"#]).is_none());
        assert!(from(&[]).is_none());
    }

    #[test]
    fn half_a_line_does_not_bring_it_down() {
        assert!(from(&["{\"type\":\"assis", "not json at all", ""]).is_none());
    }

    #[test]
    fn a_long_session_is_capped_and_says_so() {
        let mut lines = Vec::new();
        for i in 0..(KEEP + 10) {
            lines.push(typed(&format!("message {i}")));
        }
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let out = from(&refs).expect("there was a conversation");

        assert!(out.contains("are left out"), "{out}");
        assert!(!out.contains("message 0"), "the earliest go first");
        assert!(
            out.contains(&format!("message {}", KEEP + 9)),
            "the latest stay"
        );
    }
}
