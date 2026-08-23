//! Asking an agent to tell us when it stops.
//!
//! Firetower's whole claim is that it routes an agent's blocking to you. The
//! agent is the only thing that knows it has blocked — watching its terminal is
//! guesswork, and polling it is guesswork on a timer — so the agent is asked to
//! say so, through the hooks it already fires.
//!
//! What gets installed is one command per event: `<this binary> hook <Event>`.
//! Which binary depends on where the session runs — `firetower` for this
//! machine, `firetower-worker` on a host — so both have to answer to it. It
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
use std::path::{Path, PathBuf};

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
/// hook uses — and appends an event to the worker's log on this machine.
pub async fn report(event: &str, default_root: &Path) -> Result<()> {
    // Not ours. The agent's hook configuration is shared with whatever else
    // somebody runs on this machine, and a session of their own has no
    // Firetower environment around it.
    let Ok(session) = std::env::var(ft_core::hooks::SESSION_ENV) else {
        return Ok(());
    };
    let session = ft_core::SessionId::from_stored(session);

    let root = std::env::var(ft_core::hooks::ROOT_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_root.to_path_buf());

    // Whatever the agent sent us, if anything. A hook with no payload is still
    // worth a status.
    let payload: serde_json::Value = {
        use tokio::io::AsyncReadExt;
        let mut raw = String::new();
        let _ = tokio::io::stdin().read_to_string(&mut raw).await;
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null)
    };

    let notification_type = payload.get("notification_type").and_then(|v| v.as_str());

    let Some(status) = ft_core::hooks::status_for(event, notification_type) else {
        // An event we asked for and have no status for. Nothing to record.
        return Ok(());
    };

    let (note, rank) = note_for(&payload, status);
    let note = note.map(|n| ft_core::hooks::plain(&n));

    let store = crate::store::Store::open(&root.join("worker.db")).await?;

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
        && !ft_core::hooks::worth_replacing(rank_from(said_rank), rank)
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
) -> (Option<String>, ft_core::hooks::Detail) {
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
fn rank_from(stored: i64) -> ft_core::hooks::Detail {
    use ft_core::hooks::Detail;
    match stored {
        3 => Detail::Question,
        2 => Detail::Tool,
        1 => Detail::Said,
        _ => Detail::Message,
    }
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
fn last_thing_said(path: &str) -> Option<(String, ft_core::hooks::Detail)> {
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
    async fn hooks_are_taken_back_out_when_the_agent_gains_a_protocol() {
        let home = tempfile::tempdir().unwrap();
        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();
        let path = home.path().join(Agent::ClaudeCode.hooks_file().unwrap());
        assert!(!read(&path).await["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .is_empty());

        remove(home.path(), Agent::ClaudeCode).await.unwrap();
        let stop = read(&path).await["hooks"]["Stop"].as_array().unwrap().len();
        assert_eq!(stop, 0, "our own hook should be gone");
    }

    #[tokio::test]
    async fn removing_ours_leaves_somebody_elses_alone() {
        // The file belongs to the person, not to us. Theirs survives whatever
        // we do to our own.
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(Agent::ClaudeCode.hooks_file().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_string_pretty(&json!({
                "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "/usr/bin/say done" }] }] }
            }))
            .unwrap(),
        )
        .unwrap();

        install(home.path(), Agent::ClaudeCode, &exe())
            .await
            .unwrap();
        remove(home.path(), Agent::ClaudeCode).await.unwrap();

        let stop = read(&path).await["hooks"]["Stop"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/bin/say done");
    }

    #[tokio::test]
    async fn removing_from_a_home_that_has_nothing_is_not_a_failure() {
        let home = tempfile::tempdir().unwrap();
        remove(home.path(), Agent::ClaudeCode).await.unwrap();
    }

    #[tokio::test]
    async fn an_agent_with_no_hooks_writes_no_file() {
        let home = tempfile::tempdir().unwrap();
        install(home.path(), Agent::Codex, &exe()).await.unwrap();
        assert!(!home.path().join(".claude/settings.json").exists());
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
