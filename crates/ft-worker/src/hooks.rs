//! Taking back what a previous version installed.
//!
//! Firetower used to ask an agent to report on itself, through the hooks it
//! already fires, because watching a terminal from outside is guesswork. An
//! agent driven through a protocol says what it is doing as part of saying
//! anything, so the hooks became a second mechanism writing the same field —
//! and two writers of one field is not redundancy, it is a race. What it looked
//! like was a session that had just been asked a question showing a sentence
//! scraped from the turn before it.
//!
//! So nothing here installs anything any more. What is left is the cleanup,
//! which runs when a session starts: an install from before this keeps firing
//! otherwise, and a hook pointing at a subcommand that has stopped doing
//! anything is noise in somebody's own sessions forever.
//!
//! **This file belongs to the agent, not to us.** On a laptop it is the same
//! `~/.claude/settings.json` that a person's own sessions read, so the rule is
//! unchanged from when we were adding to it: only ever our own entries, and a
//! file that does not parse is left exactly as it is.

use anyhow::{Context, Result};
use ft_core::Agent;
use serde_json::Value;
use std::path::Path;

/// Take Firetower's hooks back out of an agent's configuration.
///
/// For an agent that has since gained a protocol to speak. It reports its own
/// lifecycle now, so a hook doing the same job is a second writer of one field
/// — and leaving one installed is worse than never having added it, because it
/// keeps firing for sessions that have moved on.
///
/// The same rule as installing: only ever ours, only ever by the `hook`
/// subcommand, and a file we cannot parse is left exactly as it is. Somebody
/// else's hooks on the same event survive.
pub async fn remove(home: &Path, agent: Agent) -> Result<()> {
    let (Some(file), events) = (agent.hooks_file(), agent.hooks()) else {
        return Ok(());
    };
    let path = home.join(file);

    let Ok(text) = tokio::fs::read_to_string(&path).await else {
        // Nothing there is the desired state.
        return Ok(());
    };
    let Ok(Value::Object(mut config)) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };

    let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Ok(());
    };

    let mut changed = false;
    for event in events {
        let Some(matchers) = hooks.get_mut(*event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = matchers.len();
        matchers.retain(|m| !is_ours(m));
        changed |= matchers.len() != before;
    }
    // An event we emptied is left as an empty list rather than deleted: the
    // agent reads either the same way, and removing a key we did not create is
    // more than we were asked to do.

    if !changed {
        return Ok(());
    }

    write_atomically(
        &path,
        &serde_json::to_string_pretty(&Value::Object(config))?,
    )
    .await
}

/// One of ours, wherever the binary that installed it now lives.
///
/// Looser than [`is_a_stale_firetower_hook`], which only recognises entries
/// pointing somewhere other than the current binary. Removing has to catch
/// every one of ours, including the ones that still work.
fn is_ours(matcher: &Value) -> bool {
    matcher
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| {
                        let c = c.trim();
                        c.contains("firetower") && c.contains(" hook ")
                    })
                    .unwrap_or(false)
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

// ---------------------------------------------------------------------------
// Reporting: the other half of installing.
//
// This lives beside `install` because both binaries need it. An agent's hook
// configuration names whichever of ours started the session, so `firetower` and
// `firetower-worker` both get called back — and while this was a private
// function in `main.rs`, only one of them could answer.
// ---------------------------------------------------------------------------

/// Write down what the agent just did.
///
/// Reads the hook's JSON payload from stdin — that is the contract every agent
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    async fn read(path: &Path) -> Value {
        serde_json::from_str(&tokio::fs::read_to_string(path).await.unwrap()).unwrap()
    }

    /// What a previous version left in somebody's configuration.
    ///
    /// Written by hand rather than by calling the installer, because there is
    /// no installer any more — and this is the case that matters: a file
    /// somebody upgraded into, not one we just made.
    async fn as_an_older_version_would_have(home: &Path, extra: Option<Value>) -> PathBuf {
        let path = home.join(Agent::ClaudeCode.hooks_file().unwrap());
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();

        let mut stop = vec![json!({
            "hooks": [{
                "type": "command",
                "command": "/usr/local/bin/firetower hook Stop",
                "timeout": 5,
            }]
        })];
        if let Some(theirs) = extra {
            stop.push(theirs);
        }

        tokio::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({ "hooks": { "Stop": stop } })).unwrap(),
        )
        .await
        .unwrap();
        path
    }

    #[tokio::test]
    async fn what_an_older_version_installed_is_taken_back_out() {
        let home = tempfile::tempdir().unwrap();
        let path = as_an_older_version_would_have(home.path(), None).await;

        remove(home.path(), Agent::ClaudeCode).await.unwrap();

        let stop = read(&path).await["hooks"]["Stop"].as_array().unwrap().len();
        assert_eq!(stop, 0, "ours should be gone");
    }

    #[tokio::test]
    async fn removing_ours_leaves_somebody_elses_alone() {
        // The file belongs to the person, not to us. Theirs survives whatever
        // we do to our own — the same rule that applied when we were adding.
        let home = tempfile::tempdir().unwrap();
        let theirs = json!({
            "hooks": [{ "type": "command", "command": "/usr/bin/say done" }]
        });
        let path = as_an_older_version_would_have(home.path(), Some(theirs)).await;

        remove(home.path(), Agent::ClaudeCode).await.unwrap();

        let stop = read(&path).await["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/bin/say done");
    }

    #[tokio::test]
    async fn a_home_with_nothing_in_it_is_not_a_failure() {
        // The ordinary case from here on: nobody has our hooks any more.
        let home = tempfile::tempdir().unwrap();
        remove(home.path(), Agent::ClaudeCode).await.unwrap();
    }

    #[tokio::test]
    async fn a_file_that_does_not_parse_is_left_exactly_as_it_is() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(Agent::ClaudeCode.hooks_file().unwrap());
        tokio::fs::create_dir_all(path.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&path, "{ this is not json").await.unwrap();

        remove(home.path(), Agent::ClaudeCode).await.unwrap();

        let after = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(after, "{ this is not json", "not ours to repair");
    }
}
