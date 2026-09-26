//! Normalise the Codex subagent fixture into conversation events.
//!
//! What the desktop mock serves for its `codex` scenes, so the screenshots are
//! of the real reader's output rather than of a drawing of it. The fixture
//! itself is checked against the installed app-server's schema by
//! `tests/codex_protocol.rs`.
//!
//!     cargo run -p ft-core --example dump-codex       > desktop/scripts/codex-events.json
//!     cargo run -p ft-core --example dump-codex done  > desktop/scripts/codex-events-done.json
//!
//! `done` appends the agent's report, which is the difference between a
//! session still working and one that has come to rest.
use ft_core::codex::CodexNormaliser;

/// The agent reporting back, which the fixture stops just short of so that it
/// can stand for both states.
const REPORTED: &str = r#"{"method":"item/completed","params":{"threadId":"th_main","turnId":"turn_1","completedAtMs":13,"item":{"id":"c2","type":"collabAgentToolCall","tool":"wait","senderThreadId":"th_main","receiverThreadIds":["th_sub"],"agentsStates":{"th_sub":{"status":"completed","message":"Seven surfaces read SessionStatus. Two of them — Signal and the island's blocks — draw the resting tick, and neither consults in-flight tasks."}},"status":"completed"}}}"#;

fn main() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/streams/codex_subagent.ndjson");
    let mut text = std::fs::read_to_string(path).expect("the fixture should be readable");
    if std::env::args().nth(1).as_deref() == Some("done") {
        text.push('\n');
        text.push_str(REPORTED);
    }

    let mut reader = CodexNormaliser::new();
    let mut out = Vec::new();
    for (n, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        for event in reader.push(line) {
            let mut value = serde_json::to_value(&event).expect("an event should serialise");
            if let Some(object) = value.as_object_mut() {
                object.insert("lineNo".into(), serde_json::json!(n));
            }
            out.push(value);
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&out).expect("events should serialise")
    );
}
