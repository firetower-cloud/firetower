//! The Codex app-server's own output, read the way a session reads it.
//!
//! The fixture is checked against the installed binary's schema by
//! `codex_protocol::the_subagent_fixture_matches_the_protocol`, so what is
//! replayed here is the protocol rather than somebody's memory of it.

use ft_core::codex::CodexNormaliser;
use ft_core::turn::{ItemKind, ItemStatus, TaskId, TurnEvent};

fn replay(name: &str) -> Vec<TurnEvent> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("streams")
        .join(format!("{name}.ndjson"));
    let text = std::fs::read_to_string(&path).expect("the fixture should be readable");
    let mut reader = CodexNormaliser::new();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .flat_map(|line| reader.push(line))
        .collect()
}

fn the_task(events: &[TurnEvent]) -> TaskId {
    events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TaskStarted { task, .. } => Some(task.clone()),
            _ => None,
        })
        .expect("spawning an agent should start a task")
}

/// Codex delegates by thread. A spawn names the new agent's thread, and that
/// is what its work is labelled with when it arrives.
#[test]
fn a_spawned_agent_becomes_a_task() {
    let events = replay("codex_subagent");
    let task = the_task(&events);
    assert_eq!(task.as_str(), "th_sub");

    let started = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TaskStarted {
                item,
                description,
                agent,
                ..
            } => Some((item.clone(), description.clone(), agent.clone())),
            _ => None,
        })
        .unwrap();
    // The collab call that spawned it, which is the card the work hangs under.
    assert_eq!(started.0.as_str(), "c1");
    assert_eq!(started.1, "Audit subagent UI surfaces");
    assert_eq!(started.2.as_deref(), Some("gpt-5.6-sol"));
}

/// The whole point: three commands the subagent ran, all attributed to it and
/// none of them looking like the main agent's work.
#[test]
fn the_agents_own_commands_are_attributed_to_it() {
    let events = replay("codex_subagent");
    let task = the_task(&events);

    let delegated: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ItemStarted {
                item,
                kind: ItemKind::CommandExecution,
                task: Some(owner),
                ..
            } if *owner == task => Some(item.as_str().to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(delegated, ["d1", "d2", "d3"]);

    // And nothing on the main thread was swept up with them.
    let mine: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ItemStarted {
                item, task: None, ..
            } => Some(item.as_str().to_string()),
            _ => None,
        })
        .collect();
    assert!(
        mine.contains(&"u1".to_string()),
        "the prompt is the person's"
    );
    assert!(
        mine.contains(&"c1".to_string()),
        "the spawn is the main agent's"
    );
    assert!(
        !mine.iter().any(|i| i.starts_with('d')),
        "no delegated command should be unattributed, got {mine:?}"
    );
}

/// `agentsStates` is the only place a running Codex subagent says anything.
#[test]
fn a_running_agent_reports_what_it_is_doing() {
    let events = replay("codex_subagent");
    let detail = events.iter().find_map(|e| match e {
        TurnEvent::TaskProgress { task, detail } if task.as_str() == "th_sub" => {
            Some(detail.clone())
        }
        _ => None,
    });
    assert!(
        events.iter().any(|e| matches!(
            e,
            TurnEvent::TaskProgress { detail, .. } if detail == "Reading desktop/src/island/state.ts"
        )),
        "the agent's own message should reach the card, got {detail:?}"
    );
}

/// The turn ends with the agent still going — which is the case the session
/// state machine now keeps `Working` for.
#[test]
fn the_turn_can_end_with_the_agent_still_running() {
    let events = replay("codex_subagent");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, TurnEvent::TurnCompleted { .. })),
        "the turn should complete"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, TurnEvent::TaskCompleted { .. })),
        "and the subagent should not have reported yet"
    );
}

/// Reading the same log twice names the same things — a replayed transcript
/// must not start the task again.
#[test]
fn replaying_does_not_spawn_the_agent_twice() {
    let events = replay("codex_subagent");
    let starts = events
        .iter()
        .filter(|e| matches!(e, TurnEvent::TaskStarted { .. }))
        .count();
    assert_eq!(starts, 1, "one spawn, one task");
}

/// An ending is announced once, however many times Codex restates it.
#[test]
fn an_ending_is_reported_once() {
    let mut reader = CodexNormaliser::new();
    let spawn = r#"{"method":"item/started","params":{"threadId":"th_main","turnId":"u1","startedAtMs":0,"item":{"id":"c1","type":"collabAgentToolCall","tool":"spawnAgent","senderThreadId":"th_main","receiverThreadIds":["th_sub"],"agentsStates":{},"status":"inProgress","prompt":"p","model":"m"}}}"#;
    let done = r#"{"method":"item/completed","params":{"threadId":"th_main","turnId":"u1","completedAtMs":1,"item":{"id":"c2","type":"collabAgentToolCall","tool":"wait","senderThreadId":"th_main","receiverThreadIds":["th_sub"],"agentsStates":{"th_sub":{"status":"completed","message":"all done"}},"status":"completed"}}}"#;

    reader.push(spawn);
    let first = reader.push(done);
    let again = reader.push(done);

    assert_eq!(
        first
            .iter()
            .filter(|e| matches!(e, TurnEvent::TaskCompleted { .. }))
            .count(),
        1
    );
    assert!(
        !again
            .iter()
            .any(|e| matches!(e, TurnEvent::TaskCompleted { .. })),
        "a restated ending is not a second ending"
    );
}

/// A closed or lost agent did not succeed, whatever the card would rather say.
#[test]
fn an_agent_that_was_shut_down_is_not_a_success() {
    for (status, expected) in [
        ("completed", ItemStatus::Completed),
        ("errored", ItemStatus::Failed),
        ("interrupted", ItemStatus::Failed),
        ("shutdown", ItemStatus::Failed),
        ("notFound", ItemStatus::Failed),
    ] {
        let mut reader = CodexNormaliser::new();
        reader.push(r#"{"method":"item/started","params":{"threadId":"th_main","turnId":"u1","startedAtMs":0,"item":{"id":"c1","type":"collabAgentToolCall","tool":"spawnAgent","senderThreadId":"th_main","receiverThreadIds":["th_sub"],"agentsStates":{},"status":"inProgress","prompt":"p","model":"m"}}}"#);
        let seen = reader.push(&format!(
            r#"{{"method":"item/completed","params":{{"threadId":"th_main","turnId":"u1","completedAtMs":1,"item":{{"id":"c2","type":"collabAgentToolCall","tool":"wait","senderThreadId":"th_main","receiverThreadIds":["th_sub"],"agentsStates":{{"th_sub":{{"status":"{status}"}}}},"status":"completed"}}}}}}"#
        ));
        let got = seen.iter().find_map(|e| match e {
            TurnEvent::TaskCompleted { status, .. } => Some(*status),
            _ => None,
        });
        assert_eq!(got, Some(expected), "{status} should be {expected:?}");
    }
}

/// One delegation, one card.
///
/// Three item types carry delegation and all three classified as
/// `SubagentCall`, so the `wait` call and the `subAgentActivity` each drew
/// their own rail — two extra "sent a subagent" cards with nothing under
/// them, sitting beside the real one. Caught by looking at it, not by a test,
/// which is why there is now a test.
#[test]
fn only_the_spawn_draws_a_card() {
    let events = replay("codex_subagent");
    let cards: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ItemStarted {
                item,
                kind: ItemKind::SubagentCall,
                ..
            } => Some(item.as_str().to_string()),
            _ => None,
        })
        .collect();
    assert_eq!(
        cards,
        ["c1"],
        "only the spawnAgent call is a card; `wait` and `subAgentActivity` \
         are bookkeeping and reach the card as task events"
    );
}

/// And the bookkeeping still says everything it had to say.
#[test]
fn suppressing_those_items_loses_nothing() {
    let events = replay("codex_subagent");
    assert!(
        events.iter().any(|e| matches!(
            e,
            TurnEvent::TaskProgress { detail, .. } if detail == "Reading desktop/src/island/state.ts"
        )),
        "the `wait` call's agentsStates message still reaches the card"
    );
}
