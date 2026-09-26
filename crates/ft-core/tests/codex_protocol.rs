//! What we depend on Codex still doing.
//!
//! The app-server emits its own schema — `codex app-server generate-json-schema`
//! — so the contract can be checked against the exact binary a machine has,
//! rather than against a copy of somebody's repository pinned at a commit that
//! drifts from what actually runs.
//!
//! This does not generate types. Firetower uses a small corner of a large
//! protocol, and generating all of it would be several thousand lines of dead
//! code hiding the dozen names that matter. Instead the dozen names are listed
//! here, and this fails when one of them stops existing.
//!
//! **Skipped when Codex is not installed**, which is most machines and every
//! CI runner. A check that cannot run is reported as a skip rather than as a
//! pass — see the printed line.

use std::collections::BTreeSet;
use std::path::Path;
use std::process::Command;

/// Requests Firetower sends. See `ft_core::codex::opening` and friends.
const WE_SEND: &[&str] = &[
    "initialize",
    "thread/start",
    "turn/start",
    "turn/interrupt",
    "account/login/start",
];

/// Notifications Firetower reads. See `CodexNormaliser::push`.
const WE_READ: &[&str] = &[
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "turn/plan/updated",
    "account/rateLimits/updated",
    "thread/tokenUsage/updated",
    "account/login/completed",
];

/// Requests Codex sends us, which block it until they are answered.
const WE_ANSWER: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "item/permissions/requestApproval",
];

/// Item types that draw as something better than a generic card.
const WE_DRAW: &[&str] = &[
    "agentMessage",
    "userMessage",
    "reasoning",
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "webSearch",
    // Delegation. Both are drawn as one subagent card and its work; see
    // `CodexNormaliser::collab` and `subagent_activity`.
    "collabAgentToolCall",
    "subAgentActivity",
];

#[test]
fn the_protocol_still_says_what_we_depend_on_it_saying() {
    let Some(schema) = generate() else {
        println!("skipped: no `codex` on PATH — install one to check the protocol");
        return;
    };
    let dir = schema.path();

    let sent = methods(&dir.join("ClientRequest.json"));
    for method in WE_SEND {
        assert!(sent.contains(*method), "we send {method} and it is gone");
    }

    let notified = methods(&dir.join("ServerNotification.json"));
    for method in WE_READ {
        assert!(
            notified.contains(*method),
            "we read {method} and it is gone"
        );
    }

    let asked = methods(&dir.join("ServerRequest.json"));
    for method in WE_ANSWER {
        assert!(
            asked.contains(*method),
            "we answer {method} and it is gone — a request nothing answers \
             is a session that stops forever"
        );
    }

    let items = item_types(&dir.join("v2").join("ItemStartedNotification.json"));
    for kind in WE_DRAW {
        assert!(items.contains(*kind), "we draw {kind} and it is gone");
    }

    // Where the thread id is, which is the field the whole conversation
    // hangs off. Method names all existed while this was read from the wrong
    // place, and the session sat at "starting the agent" saying nothing — so
    // the shapes we reach into are checked too, not just the names.
    let answer = read(&dir.join("v2").join("ThreadStartResponse.json"));
    assert!(
        answer
            .get("properties")
            .and_then(|p| p.get("thread"))
            .is_some(),
        "thread/start stopped answering with a thread"
    );
    assert!(
        answer
            .get("properties")
            .and_then(|p| p.get("model"))
            .is_some(),
        "thread/start stopped saying which model it is using"
    );

    // What a turn is started with, and what stopping one names.
    for (file, fields) in [
        ("TurnStartParams.json", &["threadId", "input"][..]),
        ("TurnInterruptParams.json", &["threadId", "turnId"][..]),
    ] {
        let params = read(&dir.join("v2").join(file));
        for field in fields {
            assert!(
                params
                    .get("properties")
                    .and_then(|p| p.get(*field))
                    .is_some(),
                "{file} no longer takes {field}"
            );
        }
    }

    // ---- delegation ----------------------------------------------------
    //
    // Codex attributes a subagent's work by *thread*, not by the tool call
    // that spawned it: `spawnAgent` names the new agent in
    // `receiverThreadIds`, and every item notification says which `threadId`
    // it belongs to. Nothing else in the protocol connects the two, so if
    // either disappears the Agents panel silently goes back to drawing a
    // subagent's commands as the main agent's.
    let started = read(&dir.join("v2").join("ItemStartedNotification.json"));
    assert!(
        started
            .get("required")
            .and_then(|r| r.as_array())
            .is_some_and(|r| r.iter().any(|f| f.as_str() == Some("threadId"))),
        "item/started stopped saying which thread it belongs to — a \
         subagent's work can no longer be told from the main agent's"
    );

    let variants = item_variant(&dir.join("v2").join("ItemStartedNotification.json"));
    for (item_type, fields) in [
        (
            "collabAgentToolCall",
            &[
                "tool",
                "senderThreadId",
                "receiverThreadIds",
                "agentsStates",
            ][..],
        ),
        (
            "subAgentActivity",
            &["agentThreadId", "agentPath", "kind"][..],
        ),
    ] {
        let variant = variants
            .get(item_type)
            .unwrap_or_else(|| panic!("{item_type} is gone"));
        for field in fields {
            assert!(
                variant
                    .get("properties")
                    .and_then(|p| p.get(*field))
                    .is_some(),
                "{item_type} no longer carries {field}"
            );
        }
    }

    // The enum values the mapping switches on, rather than just the fields.
    let defs = read(&dir.join("v2").join("ItemStartedNotification.json"));
    let defs = defs.get("definitions").expect("definitions");
    for (name, wanted) in [
        ("CollabAgentTool", &["spawnAgent"][..]),
        (
            "SubAgentActivityKind",
            &["started", "interacted", "interrupted", "completed"][..],
        ),
        (
            "CollabAgentStatus",
            &["running", "completed", "errored", "interrupted"][..],
        ),
    ] {
        let values: BTreeSet<String> = defs
            .get(name)
            .and_then(|d| d.get("enum"))
            .and_then(|e| e.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_else(|| panic!("{name} is gone"));
        for value in wanted {
            assert!(values.contains(*value), "{name} no longer has {value}");
        }
    }

    // Where the text of a streamed message is, and which item it belongs to.
    let delta = read(&dir.join("v2").join("AgentMessageDeltaNotification.json"));
    for field in ["itemId", "delta"] {
        assert!(
            delta.get("properties").and_then(|p| p.get(field)).is_some(),
            "a message delta no longer carries {field}"
        );
    }

    // The three words a decision can be. Getting one wrong means an approval
    // somebody granted is refused by the agent as unreadable.
    let decisions = decisions(&dir.join("CommandExecutionRequestApprovalResponse.json"));
    for word in ["accept", "acceptForSession", "decline"] {
        assert!(
            decisions.contains(word),
            "we answer with {word} and it is gone"
        );
    }
}

/// Ask the installed Codex what its protocol is.
///
/// `None` when there is none to ask, which is not a failure.
fn generate() -> Option<tempfile::TempDir> {
    let out = tempfile::tempdir().ok()?;
    let ran = Command::new("codex")
        .args(["app-server", "generate-json-schema", "--out"])
        .arg(out.path())
        .output()
        .ok()?;

    ran.status.success().then_some(out)
}

/// Every method named in a request or notification union.
fn methods(file: &Path) -> BTreeSet<String> {
    let value = read(file);
    value
        .get("oneOf")
        .and_then(|v| v.as_array())
        .map(|variants| {
            variants
                .iter()
                .filter_map(|variant| {
                    variant
                        .get("properties")?
                        .get("method")?
                        .get("enum")?
                        .get(0)?
                        .as_str()
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Every kind of thing a transcript can hold.
/// Each `ThreadItem` variant, by the `type` it is discriminated on.
///
/// `item_types` answers "does this still exist"; this answers "does it still
/// carry what we reach into", which is the half that broke silently.
fn item_variant(file: &Path) -> std::collections::BTreeMap<String, serde_json::Value> {
    let value = read(file);
    let mut out = std::collections::BTreeMap::new();
    let Some(variants) = value
        .get("definitions")
        .and_then(|d| d.get("ThreadItem"))
        .and_then(|t| t.get("oneOf"))
        .and_then(|v| v.as_array())
    else {
        return out;
    };
    for variant in variants {
        if let Some(name) = variant
            .get("properties")
            .and_then(|p| p.get("type"))
            .and_then(|t| t.get("enum"))
            .and_then(|e| e.get(0))
            .and_then(|v| v.as_str())
        {
            out.insert(name.to_string(), variant.clone());
        }
    }
    out
}

fn item_types(file: &Path) -> BTreeSet<String> {
    let value = read(file);
    value
        .get("definitions")
        .and_then(|d| d.get("ThreadItem"))
        .and_then(|t| t.get("oneOf"))
        .and_then(|v| v.as_array())
        .map(|variants| {
            variants
                .iter()
                .filter_map(|variant| {
                    variant
                        .get("properties")?
                        .get("type")?
                        .get("enum")?
                        .get(0)?
                        .as_str()
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Every word an approval decision can be, however it is spelled.
fn decisions(file: &Path) -> BTreeSet<String> {
    fn walk(value: &serde_json::Value, found: &mut BTreeSet<String>) {
        match value {
            serde_json::Value::Object(fields) => {
                if let Some(serde_json::Value::Array(options)) = fields.get("enum") {
                    for option in options {
                        if let Some(word) = option.as_str() {
                            found.insert(word.to_string());
                        }
                    }
                }
                for nested in fields.values() {
                    walk(nested, found);
                }
            }
            serde_json::Value::Array(items) => {
                for nested in items {
                    walk(nested, found);
                }
            }
            _ => {}
        }
    }

    let mut found = BTreeSet::new();
    walk(&read(file), &mut found);
    found
}

fn read(file: &Path) -> serde_json::Value {
    let text =
        std::fs::read_to_string(file).unwrap_or_else(|e| panic!("reading {}: {e}", file.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parsing {}: {e}", file.display()))
}

/// The Codex subagent fixture is shaped like the protocol, not like a guess.
///
/// `tests/streams/codex_subagent.ndjson` drives the delegation tests, and a
/// fixture is only worth what its accuracy is worth: one invented field, and
/// the mapping is proved against a Codex that does not exist. So every item in
/// it is checked against the installed app-server's own schema — its `type`
/// has to be a real `ThreadItem` variant, and it has to carry everything that
/// variant says is required.
///
/// This caught three lines the first time it ran: `commandExecution`
/// completions written without `cwd` and `commandActions`.
#[test]
fn the_subagent_fixture_matches_the_protocol() {
    let Some(schema) = generate() else {
        println!("skipped: no `codex` on PATH — install one to check the fixture");
        return;
    };
    let variants = item_variant(
        &schema
            .path()
            .join("v2")
            .join("ItemStartedNotification.json"),
    );

    let fixture = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("streams")
            .join("codex_subagent.ndjson"),
    )
    .expect("the fixture should be readable");

    let mut checked = 0;
    for (n, line) in fixture.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let message: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("line {} is not json: {e}", n + 1));
        let Some(item) = message.pointer("/params/item") else {
            continue;
        };
        let item_type = item
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or_else(|| panic!("line {} has an item with no type", n + 1));

        let variant = variants
            .get(item_type)
            .unwrap_or_else(|| panic!("line {}: Codex has no item type {item_type}", n + 1));

        for field in variant
            .get("required")
            .and_then(|r| r.as_array())
            .into_iter()
            .flatten()
            .filter_map(|f| f.as_str())
        {
            assert!(
                item.get(field).is_some(),
                "line {}: a {item_type} must carry {field}, and this one does not",
                n + 1
            );
        }
        checked += 1;
    }

    assert!(checked > 0, "the fixture should contain items to check");
    println!("checked {checked} fixture items against Codex's own schema");
}
