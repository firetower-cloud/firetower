//! The agent's permission rules, in the workspace.
//!
//! One file: `<workspace>/.claude/settings.local.json`. Two writers used to
//! touch it — the approver, when somebody presses *always allow*, and now the
//! launch, writing the rules that make a connector's tools ask at all — and
//! two writers of one `permissions` object is how one of them loses an entry.
//! So both live here and share the read-modify-write below.
//!
//! **Why this file and not the machine account's own.** It is the workspace's,
//! so it lasts exactly as long as the session does and goes when the workspace
//! does; and it outranks the machine account's `~/.claude/settings.json`, which
//! is the half that matters. A host-level `permissions.allow` entry for a tool
//! was demonstrated to bypass the approver entirely, in `default` mode as well
//! as in `auto` — an `ask` rule here overrides it.
//!
//! **Two live facts about this file, both worth knowing before changing it.**
//! Claude Code 2.1.273 refuses `permissions.allow` entries from project
//! settings in a workspace nobody has trusted — it says so on stderr — and
//! does *not* refuse `permissions.ask`. So the rule written here holds in the
//! state where a widening rule would not, which is the direction to want. And
//! a file that does not parse is left exactly as it is: it may be somebody's.

use anyhow::{Context, Result};
use serde_json::Value;
use std::path::Path;

/// Stop asking about this tool, for an agent that starts again here.
///
/// The second half of remembering, and the weaker one. An agent reads its
/// settings when it starts, so this does nothing for the session in progress —
/// the approver's in-memory set is what covers that. It matters when the
/// supervisor restarts the agent and the workspace is still there.
///
/// Composed here rather than echoed back because the agent never offered the
/// choice: the callback its own SDK gives a host arrives with ready-made rules
/// to hand back, and the tool call this arrives through does not carry them.
///
/// Scoped to the tool rather than to these exact arguments, which is the
/// coarser of the two readings of "always". A narrower rule would need the
/// argument syntax for every tool, and getting that subtly wrong means a button
/// that silently does nothing.
pub async fn allow_from_now_on(workspace: &Path, tool_name: &str) -> Result<()> {
    amend(workspace, |permissions| {
        add_to(permissions, "allow", &[tool_name.to_string()])
    })
    .await
}

/// Make every one of these tools reach the approver, whatever else says.
///
/// **The whole of Phase A's fix.** Firetower passes `--permission-mode auto` to
/// every session, and under it an MCP *write* tool executes with the approver
/// never consulted — no allow rule needed, nothing on anybody's screen. An
/// `ask` entry forces the escalation, and because this file outranks the
/// machine account's own it also overrides a host-level `allow` for the same
/// tool.
///
/// Both spellings are written for each server, and they are not redundant:
///
/// * `mcp__<server>__<tool>` is the name an agent evaluates a rule against, and
///   is what was verified live. One per tool the control plane saw.
/// * `mcp__<server>` covers the server as a whole — the tools it has grown
///   since the last probe, and every tool of a server that would not list them
///   to a stranger at all, which is most of the authenticated ones.
///
/// Additive, and only ever ours: anything already in `ask` stays, and a rule
/// somebody wrote by hand survives. Rules are never removed, because a
/// connector going away does not make its tools safe — it makes them absent,
/// and an `ask` rule for a tool that no longer exists costs nothing.
pub async fn ask_about(workspace: &Path, servers: &[ft_proto::McpServer]) -> Result<()> {
    let rules = rules_for(servers);
    if rules.is_empty() {
        return Ok(());
    }
    amend(workspace, |permissions| add_to(permissions, "ask", &rules)).await
}

/// Every permission rule a set of connectors needs, in the order written.
///
/// Separate from the write so it can be asserted on its own: what this returns
/// is the claim Phase A makes, and the file is only where it is put.
pub fn rules_for(servers: &[ft_proto::McpServer]) -> Vec<String> {
    let mut rules = Vec::new();
    for server in servers {
        if !usable(&server.name) {
            // A name with a separator in it would write a rule naming a
            // different server. The control plane refuses these, and this is
            // the second check, for the same reason `skills::apply` has one.
            tracing::warn!(connector = %server.name, "not a usable MCP server name; no rule written");
            continue;
        }
        rules.push(format!("mcp__{}", server.name));
        for tool in &server.tools {
            if !usable(tool) {
                continue;
            }
            rules.push(format!("mcp__{}__{}", server.name, tool));
        }
    }
    rules
}

/// One label and nothing else — no separators, no spaces, nothing to escape.
///
/// A permission rule is matched by text, so a name carrying `__` or a bracket
/// is a rule about something other than what it says.
fn usable(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !name.contains("__")
}

/// Add each rule to one list under `permissions`, keeping what is there.
///
/// `true` when the file needs writing, so an amend that changes nothing does
/// not rewrite somebody's settings for no reason.
fn add_to(
    permissions: &mut serde_json::Map<String, Value>,
    list: &str,
    rules: &[String],
) -> Result<bool> {
    let entry = permissions
        .entry(list)
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(entry) = entry.as_array_mut() else {
        anyhow::bail!("`permissions.{list}` is not a list");
    };
    let mut changed = false;
    for rule in rules {
        let rule = Value::String(rule.clone());
        if entry.contains(&rule) {
            continue;
        }
        entry.push(rule);
        changed = true;
    }
    Ok(changed)
}

/// Read, change, write back — the one path that touches the file.
///
/// A file that is not an object is left alone and the change refused: those are
/// somebody's real settings in a shape we do not understand, and overwriting
/// them is worse than not applying a rule.
async fn amend(
    workspace: &Path,
    change: impl FnOnce(&mut serde_json::Map<String, Value>) -> Result<bool>,
) -> Result<()> {
    let dir = workspace.join(".claude");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join("settings.local.json");

    let mut settings: serde_json::Map<String, Value> = match tokio::fs::read_to_string(&path).await
    {
        Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => map,
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

    if !change(permissions)? {
        return Ok(());
    }

    // Never a half-written settings file: the agent reads this at launch, and
    // a truncated one is a session that starts with no rules at all.
    let temp = path.with_extension("json.firetower");
    tokio::fs::write(&temp, serde_json::to_vec_pretty(&Value::Object(settings))?)
        .await
        .with_context(|| format!("writing {}", temp.display()))?;
    tokio::fs::rename(&temp, &path)
        .await
        .with_context(|| format!("moving into {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn server(name: &str, tools: &[&str]) -> ft_proto::McpServer {
        ft_proto::McpServer {
            name: name.into(),
            url: format!("https://{name}.example/mcp"),
            headers: vec![("Authorization".into(), "Bearer secret".into())],
            tools: tools.iter().map(|t| t.to_string()).collect(),
        }
    }

    async fn read(workspace: &Path) -> Value {
        let path = workspace.join(".claude/settings.local.json");
        serde_json::from_str(&tokio::fs::read_to_string(path).await.unwrap()).unwrap()
    }

    fn asks(settings: &Value) -> Vec<String> {
        settings["permissions"]["ask"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    /// **Criterion 1.** Every connector a session loads has a rule, in the
    /// spelling an agent evaluates — the server as a whole, and each tool by
    /// name.
    #[tokio::test]
    async fn every_connector_gets_an_ask_rule_for_the_server_and_each_tool() {
        let ws = tempfile::tempdir().unwrap();
        let servers = [
            server("slack", &["slack_post_message", "slack_read_channel"]),
            server("gdrive", &["search_files"]),
        ];

        ask_about(ws.path(), &servers).await.unwrap();

        assert_eq!(
            asks(&read(ws.path()).await),
            [
                "mcp__slack",
                "mcp__slack__slack_post_message",
                "mcp__slack__slack_read_channel",
                "mcp__gdrive",
                "mcp__gdrive__search_files",
            ]
        );
    }

    /// A server that would not list its tools to a stranger still gets the one
    /// rule that covers all of them. This is most authenticated servers, so a
    /// per-tool-only implementation would have left the common case bypassed.
    #[tokio::test]
    async fn a_server_that_listed_no_tools_is_still_covered() {
        let ws = tempfile::tempdir().unwrap();
        ask_about(ws.path(), &[server("canva", &[])]).await.unwrap();
        assert_eq!(asks(&read(ws.path()).await), ["mcp__canva"]);
    }

    /// **Criterion 3.** The state demonstrated to bypass approval: the machine
    /// account carries `permissions.allow` for the tool. This file outranks
    /// that one, so the `ask` rule written here is the rule that applies —
    /// what is asserted is that we write it *as well as* leaving whatever is
    /// already here, because the host's own file is not ours to edit.
    #[tokio::test]
    async fn an_allow_rule_already_in_this_file_does_not_stop_the_ask_rule() {
        let ws = tempfile::tempdir().unwrap();
        let dir = ws.path().join(".claude");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(
            dir.join("settings.local.json"),
            serde_json::to_vec_pretty(&json!({
                "permissions": { "allow": ["mcp__slack__slack_post_message", "Bash(git *)"] }
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        ask_about(ws.path(), &[server("slack", &["slack_post_message"])])
            .await
            .unwrap();

        let after = read(ws.path()).await;
        assert_eq!(
            asks(&after),
            ["mcp__slack", "mcp__slack__slack_post_message"],
            "the ask rule is written whatever allow says"
        );
        assert_eq!(
            after["permissions"]["allow"].as_array().unwrap().len(),
            2,
            "and nothing of theirs is removed"
        );
    }

    /// Applying the same set twice costs nothing and duplicates nothing — the
    /// launch does this on every restart of an agent in a workspace that
    /// survives.
    #[tokio::test]
    async fn writing_the_same_set_twice_leaves_one_of_each() {
        let ws = tempfile::tempdir().unwrap();
        let servers = [server("slack", &["slack_post_message"])];
        ask_about(ws.path(), &servers).await.unwrap();
        let first = tokio::fs::read_to_string(ws.path().join(".claude/settings.local.json"))
            .await
            .unwrap();
        ask_about(ws.path(), &servers).await.unwrap();
        let second = tokio::fs::read_to_string(ws.path().join(".claude/settings.local.json"))
            .await
            .unwrap();
        assert_eq!(first, second, "byte for byte, so nothing was rewritten");
    }

    /// The two writers of this file do not take each other's entries out.
    #[tokio::test]
    async fn an_always_allow_and_a_connector_rule_coexist() {
        let ws = tempfile::tempdir().unwrap();
        ask_about(ws.path(), &[server("slack", &["slack_post_message"])])
            .await
            .unwrap();
        allow_from_now_on(ws.path(), "Bash").await.unwrap();

        let after = read(ws.path()).await;
        assert_eq!(
            asks(&after),
            ["mcp__slack", "mcp__slack__slack_post_message"]
        );
        assert_eq!(after["permissions"]["allow"][0], "Bash");
    }

    /// A rule is matched by text, so a name that carries the separator is a
    /// rule about a server other than the one it names. Refused rather than
    /// written — and the other servers in the set still get theirs.
    #[tokio::test]
    async fn a_name_that_could_forge_a_rule_is_refused() {
        let ws = tempfile::tempdir().unwrap();
        ask_about(
            ws.path(),
            &[
                server("slack__evil", &["x"]),
                server("has space", &["x"]),
                server("gdrive", &["ok_tool"]),
            ],
        )
        .await
        .unwrap();
        assert_eq!(
            asks(&read(ws.path()).await),
            ["mcp__gdrive", "mcp__gdrive__ok_tool"]
        );
    }

    /// Somebody's settings, in a shape this does not understand. Left alone,
    /// and the launch is told rather than quietly carrying on with no rules.
    #[tokio::test]
    async fn a_file_that_is_not_an_object_is_left_exactly_as_it_is() {
        let ws = tempfile::tempdir().unwrap();
        let dir = ws.path().join(".claude");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("settings.local.json");
        tokio::fs::write(&path, "[\"not an object\"]")
            .await
            .unwrap();

        assert!(ask_about(ws.path(), &[server("slack", &["x"])])
            .await
            .is_err());
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "[\"not an object\"]"
        );
    }

    #[tokio::test]
    async fn no_connectors_writes_no_file_at_all() {
        let ws = tempfile::tempdir().unwrap();
        ask_about(ws.path(), &[]).await.unwrap();
        assert!(!ws.path().join(".claude/settings.local.json").exists());
    }
}
