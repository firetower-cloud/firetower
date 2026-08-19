//! Asking an agent to tell us when it stops.
//!
//! Firetower's whole claim is that it routes an agent's blocking to you. The
//! agent is the only thing that knows it has blocked — watching its terminal is
//! guesswork, and polling it is guesswork on a timer — so the agent is asked to
//! say so, through the hooks it already fires.
//!
//! What gets installed is one command per event: `firetower hook <Event>`. It
//! runs on this machine, writes one row into the worker's log, and exits. No
//! socket, no port, nothing listening. That is what makes it survive Firetower
//! being closed — the worker is gone by then, but the log is a file, and the
//! next connection replays whatever accumulated.
//!
//! **This file belongs to the agent, not to us.** On a laptop it is the same
//! `~/.claude/settings.json` that a person's own sessions read. So the same
//! rule as `first_run`: only ever add, never replace, and leave a file that
//! does not parse alone. The hook itself is the other half of that — it does
//! nothing at all unless `FIRETOWER_SESSION` is in the environment, which a
//! session somebody started for themselves has no reason to carry.

use anyhow::{Context, Result};
use ft_core::Agent;
use serde_json::{json, Map, Value};
use std::path::Path;

/// Install Firetower's hooks into an agent's configuration under `home`.
///
/// Best effort, like `first_run`: an agent that cannot report is worse than one
/// that can, and much better than a session that refuses to start.
pub async fn install(home: &Path, agent: Agent, exe: &Path) -> Result<()> {
    let (Some(file), events) = (agent.hooks_file(), agent.hooks()) else {
        return Ok(());
    };
    if events.is_empty() {
        return Ok(());
    }

    let path = home.join(file);

    let existing = match tokio::fs::read_to_string(&path).await {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let mut config: Map<String, Value> = match existing.as_deref() {
        None => Map::new(),
        Some(text) if text.trim().is_empty() => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            // Somebody's real settings, in a shape we do not understand.
            // Leaving it is the only safe move.
            _ => {
                tracing::warn!("{} is not an object; leaving it alone", path.display());
                return Ok(());
            }
        },
    };

    let hooks = config
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(hooks) = hooks.as_object_mut() else {
        tracing::warn!("`hooks` in {} is not an object; leaving it", path.display());
        return Ok(());
    };

    let command = format!("{} hook", exe.display());
    let mut changed = false;

    for event in events {
        let entry = hooks
            .entry(*event)
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(matchers) = entry.as_array_mut() else {
            continue;
        };

        // Drop any of ours that point somewhere else.
        //
        // The command is an absolute path to the binary that installed it, so
        // `cargo clean`, an upgrade, or a move leaves an entry pointing at
        // nothing — and a hook that cannot run is a session that silently stops
        // reporting, which looks exactly like the feature being broken. Ours
        // are recognised by the `hook` subcommand and replaced; anybody else's
        // are left alone.
        let before = matchers.len();
        matchers.retain(|m| !is_a_stale_firetower_hook(m, &command));
        changed |= matchers.len() != before;

        // Already ours, and current. Recognised by the command rather than by
        // position, because somebody may have added their own around it.
        if matchers.iter().any(|m| mentions(m, &command)) {
            continue;
        }

        // Alongside whatever else is configured for this event, never
        // replacing it. The agent runs every matcher that applies.
        matchers.push(json!({
            "hooks": [{
                "type": "command",
                // The event name is an argument rather than something read from
                // the payload, so one command serves every hook and a payload
                // we fail to parse still says which hook it was.
                "command": format!("{command} {event}"),
                // Long enough for an append to SQLite under contention, short
                // enough never to hold up the agent. SessionEnd hooks share a
                // 1.5s budget, so this has to be well inside it.
                "timeout": 5
            }]
        }));
        changed = true;
    }

    if !changed {
        return Ok(());
    }

    write_atomically(
        &path,
        &serde_json::to_string_pretty(&Value::Object(config))?,
    )
    .await
}

/// One of ours, from a binary that is no longer where it was.
fn is_a_stale_firetower_hook(matcher: &Value, command: &str) -> bool {
    matcher
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    // Ours by shape, but not the binary running now.
                    .is_some_and(|c| c.contains(" hook ") && !c.starts_with(command))
            })
        })
        .unwrap_or(false)
}

/// Whether this matcher already runs our command.
fn mentions(matcher: &Value, command: &str) -> bool {
    matcher
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .is_some_and(|c| c.starts_with(command))
            })
        })
        .unwrap_or(false)
}

/// Never a half-written settings file: somebody's own configuration is on the
/// other end of this.
async fn write_atomically(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    let temp = path.with_extension("json.firetower");
    tokio::fs::write(&temp, contents)
        .await
        .with_context(|| format!("writing {}", temp.display()))?;
    tokio::fs::rename(&temp, path)
        .await
        .with_context(|| format!("moving into {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn read(path: &Path) -> Value {
        serde_json::from_str(&tokio::fs::read_to_string(path).await.unwrap()).unwrap()
    }

    fn exe() -> std::path::PathBuf {
        std::path::PathBuf::from("/usr/local/bin/firetower")
    }

    #[tokio::test]
    async fn a_fresh_home_gets_every_hook_we_asked_for() {
        let home = tempfile::tempdir().unwrap();
        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();

        let config = read(&home.path().join(".claude/settings.json")).await;
        let hooks = config["hooks"].as_object().unwrap();

        for event in Agent::ClaudeCode.hooks() {
            let entry = &hooks[*event].as_array().unwrap()[0];
            let command = entry["hooks"][0]["command"].as_str().unwrap();
            assert_eq!(command, format!("/usr/local/bin/firetower hook {event}"));
        }
    }

    /// The one that would be a real bug: this is a person's own settings file.
    #[tokio::test]
    async fn what_was_already_there_is_kept() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude/settings.json");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "permissions": { "allow": ["Bash(ls:*)"] },
                "hooks": {
                    "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }]
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();

        let config = read(&path).await;
        assert_eq!(config["permissions"]["allow"][0], "Bash(ls:*)");

        let stop = config["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "theirs is kept and ours is added beside it");
        assert_eq!(stop[0]["hooks"][0]["command"], "say done");
        assert!(stop[1]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with("hook Stop"));
    }

    #[tokio::test]
    async fn running_it_twice_adds_nothing_the_second_time() {
        let home = tempfile::tempdir().unwrap();
        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();
        let once = read(&home.path().join(".claude/settings.json")).await;

        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();
        let twice = read(&home.path().join(".claude/settings.json")).await;

        assert_eq!(once, twice, "a session starting must not grow this file");
    }

    #[tokio::test]
    async fn a_file_that_does_not_parse_is_left_exactly_as_it_is() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude/settings.json");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, "{ this is not json").await.unwrap();

        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "{ this is not json"
        );
    }

    /// A binary that moved: `cargo clean`, an upgrade, a release install. The
    /// entry left behind cannot run, and a hook that cannot run is a session
    /// that stops reporting without saying so.
    #[tokio::test]
    async fn a_hook_pointing_at_a_binary_that_moved_is_replaced() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude/settings.json");

        install(
            home.path(),
            Agent::ClaudeCode,
            &std::path::PathBuf::from("/old/place/firetower"),
        )
        .await
        .unwrap();
        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();

        let config = read(&path).await;
        let stop = config["hooks"]["Stop"].as_array().unwrap();

        assert_eq!(
            stop.len(),
            1,
            "the one that moved is gone, not kept beside it"
        );
        assert_eq!(
            stop[0]["hooks"][0]["command"],
            "/usr/local/bin/firetower hook Stop"
        );
    }

    /// Somebody else's hook that happens to mention a path is not ours to
    /// remove, however much it looks like housekeeping.
    #[tokio::test]
    async fn hooks_that_are_not_ours_survive_the_tidy_up() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude/settings.json");
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "hooks": {
                    "Stop": [{ "hooks": [{ "type": "command", "command": "/usr/bin/say done" }] }]
                }
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();

        let stop = read(&path).await["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/bin/say done");
    }

    #[tokio::test]
    async fn an_agent_with_no_hooks_writes_no_file() {
        let home = tempfile::tempdir().unwrap();
        install(home.path(), Agent::Codex, &exe()).await.unwrap();
        assert!(!home.path().join(".claude/settings.json").exists());
    }
}
