//! Answering an agent's first-run questions before it asks them.
//!
//! Agents are CLIs written for a person at a keyboard, so they have a first
//! run: pick a theme, pick how you sign in, confirm you trust this folder.
//! Nobody is watching the pane when a session starts, and the sign-in screen
//! appears even when the token was handed over and works — which reads as
//! broken authentication and isn't.
//!
//! So the worker writes the answers into the agent's own configuration, on
//! whatever host it is about to launch on. Not into the image: a server added
//! over ssh has an equally fresh home and would ask the same questions.
//!
//! **The rule that matters is that this only ever adds.** On this machine that
//! file is your real configuration, with your real settings in it. A key that
//! is already there is left exactly as it is, whatever its value — you having
//! answered differently is an answer. A file that doesn't parse is left alone
//! entirely rather than replaced with one that does.

use anyhow::{Context, Result};
use ft_core::FirstRun;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Answer what this agent would otherwise ask, in `home`.
///
/// Nothing here is fatal. A configuration we couldn't write means the agent
/// asks a question someone can answer in the terminal, which is worse than not
/// asking but much better than refusing to start the session.
pub async fn settle(home: &Path, first_run: &FirstRun) -> Result<()> {
    let path = home.join(first_run.file);

    let existing = match tokio::fs::read_to_string(&path).await {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    let mut config = match existing.as_deref() {
        None => Map::new(),
        Some(text) if text.trim().is_empty() => Map::new(),
        Some(text) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            // Not ours to repair. Rewriting a file we can't read is how a tool
            // destroys settings someone spent an afternoon on.
            _ => {
                anyhow::bail!(
                    "{} isn't a JSON object, so it was left alone",
                    path.display()
                )
            }
        },
    };

    let mut added = 0;
    for (keys, value) in &first_run.answers {
        if put_if_absent(&mut config, keys, Value::Bool(*value)) {
            added += 1;
        }
    }

    if added == 0 {
        return Ok(());
    }

    write_atomically(
        &path,
        &serde_json::to_string_pretty(&Value::Object(config))?,
    )
    .await?;
    tracing::debug!(path = %path.display(), "answered {added} first-run question(s)");
    Ok(())
}

/// Walk `keys`, creating objects on the way, and set the last one — but only if
/// nothing is there. Returns whether anything changed.
///
/// A key on the path that exists and *isn't* an object stops the walk. That
/// belongs to whoever put it there.
fn put_if_absent(config: &mut Map<String, Value>, keys: &[String], value: Value) -> bool {
    let Some((last, parents)) = keys.split_last() else {
        return false;
    };

    let mut here = config;
    for key in parents {
        let entry = here
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        match entry {
            Value::Object(map) => here = map,
            _ => return false,
        }
    }

    if here.contains_key(last) {
        return false;
    }
    here.insert(last.clone(), value);
    true
}

/// Into a neighbouring file, then rename. A crash halfway through writing
/// someone's configuration in place would leave them with neither the old one
/// nor a valid new one.
async fn write_atomically(path: &Path, contents: &str) -> Result<()> {
    let temp: PathBuf = path.with_extension("firetower-new");

    tokio::fs::write(&temp, contents)
        .await
        .with_context(|| format!("writing {}", temp.display()))?;

    // Config can carry credentials, so it is nobody else's business.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600)).await?;
    }

    tokio::fs::rename(&temp, path)
        .await
        .with_context(|| format!("replacing {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ft_core::Agent;

    async fn read(path: &Path) -> Value {
        serde_json::from_str(&tokio::fs::read_to_string(path).await.unwrap()).unwrap()
    }

    fn claude(workspace: &str) -> FirstRun {
        Agent::ClaudeCode.first_run(workspace).unwrap()
    }

    #[tokio::test]
    async fn a_home_that_has_never_run_the_agent_gets_every_answer() {
        let home = tempfile::tempdir().unwrap();
        settle(home.path(), &claude("/work/agent-hello"))
            .await
            .unwrap();

        let config = read(&home.path().join(".claude.json")).await;
        assert_eq!(config["hasCompletedOnboarding"], Value::Bool(true));
        assert_eq!(
            config["projects"]["/work/agent-hello"]["hasTrustDialogAccepted"],
            Value::Bool(true)
        );
    }

    /// The one that would be a real bug: this file is a person's own settings
    /// on the machine they use.
    #[tokio::test]
    async fn nothing_already_in_the_file_is_touched() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude.json");

        tokio::fs::write(
            &path,
            serde_json::json!({
                "theme": "light",
                "hasCompletedOnboarding": false,
                "projects": {
                    "/somewhere/else": { "hasTrustDialogAccepted": false }
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

        settle(home.path(), &claude("/work/agent-hello"))
            .await
            .unwrap();

        let config = read(&path).await;
        assert_eq!(config["theme"], "light");
        assert_eq!(
            config["hasCompletedOnboarding"],
            Value::Bool(false),
            "answered already, even though the answer was no"
        );
        assert_eq!(
            config["projects"]["/somewhere/else"]["hasTrustDialogAccepted"],
            Value::Bool(false),
            "another project's trust is not ours to change"
        );
        assert_eq!(
            config["projects"]["/work/agent-hello"]["hasTrustDialogAccepted"],
            Value::Bool(true),
            "and the new worktree is added beside it"
        );
    }

    #[tokio::test]
    async fn running_it_twice_changes_nothing_the_second_time() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude.json");

        settle(home.path(), &claude("/work/one")).await.unwrap();
        let once = tokio::fs::read_to_string(&path).await.unwrap();

        settle(home.path(), &claude("/work/one")).await.unwrap();
        assert_eq!(tokio::fs::read_to_string(&path).await.unwrap(), once);
    }

    #[tokio::test]
    async fn each_workspace_is_trusted_separately() {
        let home = tempfile::tempdir().unwrap();
        settle(home.path(), &claude("/work/one")).await.unwrap();
        settle(home.path(), &claude("/work/two")).await.unwrap();

        let config = read(&home.path().join(".claude.json")).await;
        for workspace in ["/work/one", "/work/two"] {
            assert_eq!(
                config["projects"][workspace]["hasTrustDialogAccepted"],
                Value::Bool(true)
            );
        }
    }

    #[tokio::test]
    async fn a_file_we_cannot_read_is_left_exactly_as_it_was() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude.json");
        tokio::fs::write(&path, "{ this is not json").await.unwrap();

        assert!(settle(home.path(), &claude("/work/one")).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "{ this is not json"
        );
    }

    #[tokio::test]
    async fn an_empty_file_is_treated_as_no_file() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude.json");
        tokio::fs::write(&path, "").await.unwrap();

        settle(home.path(), &claude("/work/one")).await.unwrap();
        assert_eq!(
            read(&path).await["hasCompletedOnboarding"],
            Value::Bool(true)
        );
    }

    /// If a key on the way is something else, it belongs to whoever put it
    /// there and the walk stops rather than replacing it.
    #[tokio::test]
    async fn a_conflicting_shape_is_not_overwritten() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".claude.json");
        tokio::fs::write(&path, r#"{"projects": "not an object"}"#)
            .await
            .unwrap();

        settle(home.path(), &claude("/work/one")).await.unwrap();
        assert_eq!(read(&path).await["projects"], "not an object");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_file_is_written_for_this_account_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();

        settle(home.path(), &claude("/work/one")).await.unwrap();

        let mode = std::fs::metadata(home.path().join(".claude.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn an_agent_with_nothing_to_answer_says_so() {
        assert!(Agent::Shell.first_run("/work/one").is_none());
    }
}
