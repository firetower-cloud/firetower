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

    let read = methods(&dir.join("ServerNotification.json"));
    for method in WE_READ {
        assert!(read.contains(*method), "we read {method} and it is gone");
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
