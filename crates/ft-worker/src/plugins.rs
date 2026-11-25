//! Putting a session's plugins where its agent will find them.
//!
//! A plugin is a folder carrying any of skills, connectors, commands,
//! subagents and hooks. Two things make this module short.
//!
//! **One canonical copy, whatever the agent.** Every plugin is written into
//! `<agentd>/plugins-<session>/<name>/` on every agent, because that is the
//! directory Claude Code is handed on the command line *and* the place the
//! other three are decomposed from. There is one writer and one layout; what
//! differs is only what else is derived from it afterwards.
//!
//! **The connector's credential is already in the bytes.** The control plane
//! substitutes the token into the plugin's `.mcp.json` before the bundle is
//! sent, so this module writes a file and never learns what a token is. That
//! is what keeps the worker out of the authorization story entirely.
//!
//! Measured against the installed CLIs rather than their documentation:
//! Claude Code 2.1.273 loads every child of a `--plugin-dir` folder, lists its
//! skills as `plugin:skill` in the `init` frame, and dials the `.mcp.json`
//! inside it without being asked.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use ft_core::{Agent, PluginsHome, SessionId};
use ft_proto::SkillBundle;
use serde_json::{json, Value};

use crate::agentd;

/// The directory of plugins belonging to one session.
///
/// Its own session's, so two agents in one workspace cannot see each other's —
/// the same rule the skills root already follows, and for the same reason: a
/// workspace holds several sessions and anything shared by the workspace is
/// the wrong home.
pub fn root(workspace: &Path, id: &SessionId) -> PathBuf {
    agentd::dir_for(workspace).join(format!("plugins-{}", id.as_str()))
}

/// Make the set on disk be exactly `plugins`.
///
/// The directory is created even when the set is empty, for the reason the
/// skills root is: Claude Code watches a directory it already knows about and
/// needs a reload for one that appears later, so the first plugin somebody
/// turns on has to land somewhere that was already there.
pub async fn apply(
    workspace: &Path,
    id: &SessionId,
    agent: Agent,
    plugins: &[SkillBundle],
) -> Result<()> {
    let Some(home) = agent.plugins_home() else {
        return Ok(());
    };
    let root = root(workspace, id);
    tokio::fs::create_dir_all(&root)
        .await
        .with_context(|| format!("making {}", root.display()))?;

    // What is there now, so that what is gone can go.
    let mut present: Vec<String> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&root).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                present.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }

    for bundle in plugins {
        if !crate::skills::usable(&bundle.name) {
            tracing::warn!(plugin = %bundle.name, "not a usable folder name; skipped");
            continue;
        }
        let at = root.join(&bundle.name);
        // Rewritten every time rather than left alone, which is the one place
        // this differs from the skills root. A plugin's `.mcp.json` carries a
        // short-lived access token, so a bundle that is already there under
        // the same name is holding a token from the *last* session — leaving
        // it would hand this session a credential that has very likely
        // expired, and the failure would read as the connector being broken.
        if let Err(e) = crate::skills::write_bundle(&at, bundle).await {
            tracing::warn!(plugin = %bundle.name, "could not write it; skipped: {e:#}");
        }
    }

    for gone in present
        .iter()
        .filter(|p| !plugins.iter().any(|b| &&b.name == p))
    {
        if let Err(e) = tokio::fs::remove_dir_all(root.join(gone)).await {
            tracing::warn!(plugin = %gone, "could not take it back out: {e}");
        }
    }

    if home == PluginsHome::Decomposed {
        decompose(workspace, id, agent, plugins).await?;
    }

    tracing::info!(
        root = %root.display(),
        count = plugins.len(),
        home = ?home,
        "this session's plugins are in place"
    );
    Ok(())
}

/// Take a plugin apart for an agent that has no concept of one.
///
/// Its skills go where that agent reads skills from, under their own folder
/// names. Its connectors go into that agent's own MCP configuration — for
/// Codex a block in `config.toml`; for the two ACP agents nothing is written
/// at all, because there the servers travel in `session/new` and
/// [`mcp_servers`] is what reads them back out.
///
/// Commands, subagents and hooks are **not** delivered here and are not
/// silently dropped either: the interface names them at the point of
/// selection, which is the only place that information is any use.
async fn decompose(
    workspace: &Path,
    id: &SessionId,
    agent: Agent,
    plugins: &[SkillBundle],
) -> Result<()> {
    // The skills root this agent already has. `skills::apply` has run first
    // and created it, so this adds to a directory that exists.
    if let Some(skills_root) = crate::skills::root(workspace, id, agent) {
        tokio::fs::create_dir_all(&skills_root).await.ok();
        // **Written already, in this pass.** Everything a plugin unpacks into
        // lands in the same directory a lone skill already occupies, keyed on
        // the folder name alone — so a plugin carrying `code-review` replaced
        // somebody's own `code-review`, on every engine that decomposes, with
        // nothing logged. A name is only free the first time.
        let mut taken: Vec<String> = Vec::new();
        for bundle in plugins {
            for (name, files) in skills_inside(bundle) {
                if !crate::skills::usable(&name) {
                    continue;
                }
                let at = skills_root.join(&name);
                let clash = taken.iter().any(|t| t == &name)
                    || tokio::fs::try_exists(&at).await.unwrap_or(false);
                // Prefixed only when it would otherwise destroy something, so
                // the ordinary case keeps the name its author chose and the
                // collision is the only thing that reads differently.
                let folder = if clash {
                    let prefixed = format!("{}-{}", bundle.name, name);
                    tracing::info!(
                        plugin = %bundle.name, skill = %name,
                        "that name was already taken, so it is written as {prefixed}"
                    );
                    prefixed
                } else {
                    name.clone()
                };
                if !crate::skills::usable(&folder) {
                    continue;
                }
                let inner = SkillBundle {
                    name: folder.clone(),
                    files,
                    kind: ft_proto::BundleKind::Skill,
                };
                if let Err(e) =
                    crate::skills::write_bundle(&skills_root.join(&folder), &inner).await
                {
                    tracing::warn!(
                        plugin = %bundle.name, skill = %folder,
                        "could not take it out of the plugin: {e:#}"
                    );
                    continue;
                }
                taken.push(folder);
            }
        }
    }

    if agent == Agent::Codex {
        write_codex_mcp(workspace, id, plugins).await?;
    }
    Ok(())
}

/// The skills inside a plugin, as `(folder name, files relative to it)`.
///
/// `skills/<name>/…` is the standard's layout and both published catalogues
/// use it. A path that is not under `skills/` belongs to another component
/// kind and is left where it is.
fn skills_inside(bundle: &SkillBundle) -> Vec<(String, Vec<ft_proto::SkillFile>)> {
    let mut out: Vec<(String, Vec<ft_proto::SkillFile>)> = Vec::new();
    for file in &bundle.files {
        let Some(rest) = file.path.strip_prefix("skills/") else {
            continue;
        };
        let Some((name, inner)) = rest.split_once('/') else {
            continue;
        };
        let moved = ft_proto::SkillFile {
            path: inner.to_string(),
            contents: file.contents.clone(),
            executable: file.executable,
        };
        match out.iter_mut().find(|(n, _)| n == name) {
            Some((_, files)) => files.push(moved),
            None => out.push((name.to_string(), vec![moved])),
        }
    }
    out
}

/// Every MCP server declared by this session's plugins.
///
/// Read back off the disk rather than kept in memory, so the one place a
/// server is written down is the file the agent itself would have read. For
/// Claude Code that file *is* the configuration; for everybody else this is
/// where their own configuration is derived from.
pub async fn mcp_servers(workspace: &Path, id: &SessionId) -> Vec<(String, Value)> {
    let root = root(workspace, id);
    let mut out: Vec<(String, Value)> = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(&root).await else {
        return out;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path().join(".mcp.json");
        let Ok(text) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            tracing::warn!(at = %path.display(), "this .mcp.json is not JSON; skipped");
            continue;
        };
        let Some(servers) = value.get("mcpServers").and_then(Value::as_object) else {
            continue;
        };
        for (name, server) in servers {
            out.push((name.clone(), server.clone()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The same servers, in the shape ACP's `session/new` takes.
///
/// ACP carries an HTTP server as `{ type, name, url, headers: [{name, value}] }`
/// rather than as the object `.mcp.json` uses, so this is a translation and
/// not a pass-through. A stdio server keeps its command and arguments.
pub async fn acp_mcp_servers(workspace: &Path, id: &SessionId) -> Vec<Value> {
    mcp_servers(workspace, id)
        .await
        .into_iter()
        .filter_map(|(name, server)| {
            let url = server.get("url").and_then(Value::as_str);
            match url {
                Some(url) => {
                    let headers = server
                        .get("headers")
                        .and_then(Value::as_object)
                        .map(|h| {
                            h.iter()
                                .map(|(k, v)| json!({"name": k, "value": v.as_str().unwrap_or("")}))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Some(json!({
                        "type": "http",
                        "name": name,
                        "url": url,
                        "headers": headers,
                    }))
                }
                // A stdio server, which ACP takes in its own shape.
                None => server
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| {
                        json!({
                            "name": name,
                            "command": command,
                            "args": server.get("args").cloned().unwrap_or(json!([])),
                            "env": server.get("env").cloned().unwrap_or(json!({})),
                        })
                    }),
            }
        })
        .collect()
}

/// Split this session's MCP servers into what an ACP agent will take and what
/// it will not.
///
/// **ACP negotiates this.** The agent answers `initialize` with
/// `agentCapabilities.mcpCapabilities`, and a client that sends an HTTP server
/// to one which did not claim `http` is sending something the other end has no
/// contract to read. Measured against Kimi Code 2.1.1, which answers
/// `{"http": true, "sse": true}` — so the capability is real, and so is the
/// case where it is absent.
///
/// A stdio server needs no capability: it is the transport every ACP agent has
/// by construction, because the agent launches the process itself.
///
/// What is refused comes back rather than being discarded, so the caller can
/// name it. A connector that silently did not arrive is the failure this whole
/// design keeps trying to avoid.
pub fn deliverable_mcp(servers: Vec<Value>, http_ok: bool) -> (Vec<Value>, Vec<Value>) {
    servers
        .into_iter()
        .partition(|s| s["type"] != "http" || http_ok)
}

/// Codex's own MCP configuration, as a block in `$CODEX_HOME/config.toml`.
///
/// **Appended inside a marker, never written over the file.** A credential
/// this worker put there at sign-in lives in the same file, and one bad line
/// makes Codex fail to load its configuration at all and answer with nothing
/// — so the block is delimited, the old one is cut out, and the new one goes
/// on the end. A `[table]` header is always legal after any valid TOML, which
/// is what makes appending safe where appending a bare key would not be.
async fn write_codex_mcp(workspace: &Path, id: &SessionId, plugins: &[SkillBundle]) -> Result<()> {
    const OPEN: &str = "# >>> firetower plugins — written per session, do not edit";
    const CLOSE: &str = "# <<< firetower plugins";

    let home = agentd::dir_for(workspace).join(format!("agent-home-{}", id.as_str()));
    tokio::fs::create_dir_all(&home).await.ok();
    let at = home.join("config.toml");

    let existing = tokio::fs::read_to_string(&at).await.unwrap_or_default();
    let mut kept = String::new();
    let mut inside = false;
    for line in existing.lines() {
        if line.starts_with(OPEN) {
            inside = true;
        } else if line.starts_with(CLOSE) {
            inside = false;
        } else if !inside {
            kept.push_str(line);
            kept.push('\n');
        }
    }

    let mut block = String::new();
    for (name, server) in mcp_servers(workspace, id).await {
        let Some(url) = server.get("url").and_then(Value::as_str) else {
            continue;
        };
        block.push_str(&format!("\n[mcp_servers.{name}]\nurl = {}\n", quoted(url)));
        if let Some(headers) = server.get("headers").and_then(Value::as_object) {
            block.push_str(&format!("\n[mcp_servers.{name}.http_headers]\n"));
            for (k, v) in headers {
                block.push_str(&format!(
                    "{} = {}\n",
                    quoted(k),
                    quoted(v.as_str().unwrap_or(""))
                ));
            }
        }
    }

    let mut out = kept.trim_end().to_string();
    if !block.is_empty() {
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(OPEN);
        out.push('\n');
        out.push_str(&block);
        out.push_str(CLOSE);
    }
    out.push('\n');

    tokio::fs::write(&at, out)
        .await
        .with_context(|| format!("writing {}", at.display()))?;
    tracing::info!(
        at = %at.display(),
        plugins = plugins.len(),
        "codex's mcp servers are in place"
    );
    Ok(())
}

/// A TOML basic string. Only the two characters TOML gives meaning to inside
/// one need escaping, and a URL or a bearer token holds neither — but a token
/// is somebody else's bytes, so it is escaped rather than trusted.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> ft_proto::SkillFile {
        ft_proto::SkillFile {
            path: path.into(),
            contents: ft_proto::encode(b"x"),
            executable: false,
        }
    }

    #[test]
    fn a_plugins_skills_come_out_under_their_own_names() {
        let bundle = SkillBundle {
            name: "security-review".into(),
            kind: ft_proto::BundleKind::Plugin,
            files: vec![
                file(".claude-plugin/plugin.json"),
                file("skills/code-review/SKILL.md"),
                file("skills/code-review/references/rust.md"),
                file("skills/patch-verifier/SKILL.md"),
                file("commands/review.md"),
            ],
        };
        let out = skills_inside(&bundle);
        assert_eq!(out.len(), 2, "two skills, and the command is not one");
        assert_eq!(out[0].0, "code-review");
        assert_eq!(
            out[0].1.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            ["SKILL.md", "references/rust.md"],
            "paths are relative to the skill's own folder, not the plugin's"
        );
        assert_eq!(out[1].0, "patch-verifier");
    }

    #[test]
    fn an_agent_that_does_not_take_http_is_not_sent_one() {
        let http = json!({"type":"http","name":"github","url":"https://x/mcp"});
        let stdio = json!({"name":"postgres","command":"npx"});

        let (sent, refused) = deliverable_mcp(vec![http.clone(), stdio.clone()], true);
        assert_eq!(sent.len(), 2, "both, when it says it takes http");
        assert!(refused.is_empty());

        let (sent, refused) = deliverable_mcp(vec![http, stdio], false);
        assert_eq!(
            sent.len(),
            1,
            "stdio needs no capability — the agent launches it"
        );
        assert_eq!(sent[0]["name"], "postgres");
        assert_eq!(
            refused.len(),
            1,
            "and the one it cannot take comes back to be named"
        );
        assert_eq!(refused[0]["name"], "github");
    }

    #[test]
    fn a_quoted_string_survives_a_token_with_a_quote_in_it() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }
}
