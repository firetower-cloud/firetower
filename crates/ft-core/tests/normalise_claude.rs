//! The normaliser, against recordings of Claude Code actually running.
//!
//! The files in `streams/` are real sessions captured from `claude -p
//! --output-format stream-json`, with machine paths scrubbed. They are here
//! rather than hand-written because every interesting thing in this normaliser
//! is a fact about someone else's output format, and a fixture we invented
//! would only ever prove that we agree with ourselves.
//!
//! Re-record them when Claude Code changes shape. The capture is one command,
//! and a broken expectation here is the cheapest possible place to find out.

use ft_core::normalise::{classify, ClaudeNormaliser};
use ft_core::turn::{ItemKind, ItemStatus, StreamKind, TurnEvent, TurnStatus};

fn replay(name: &str) -> Vec<TurnEvent> {
    let path = format!("{}/tests/streams/{name}.ndjson", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
    let mut normaliser = ClaudeNormaliser::new();
    text.lines()
        .flat_map(|line| normaliser.push(line))
        .collect()
}

/// The text of every item, in order, joined per item.
fn text_of(events: &[TurnEvent], want: StreamKind) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ContentDelta { stream, delta, .. } if *stream == want => {
                Some(delta.as_str())
            }
            _ => None,
        })
        .collect()
}

fn started(events: &[TurnEvent]) -> Vec<(ItemKind, Option<String>)> {
    events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ItemStarted { kind, title, .. } => Some((*kind, title.clone())),
            _ => None,
        })
        .collect()
}

// ---- the shape of a session --------------------------------------------

#[test]
fn a_session_reports_what_it_can_do_before_it_does_anything() {
    let events = replay("plain");
    let TurnEvent::SessionConfigured {
        model, mode, tools, ..
    } = &events[0]
    else {
        panic!(
            "expected the first event to be SessionConfigured, got {:?}",
            events[0]
        );
    };
    assert!(!model.is_empty(), "a session should name its model");
    assert!(
        !mode.is_empty(),
        "and what it may do without asking, so a control can show it"
    );
    assert!(
        tools.iter().any(|t| t == "Bash"),
        "the tool list should be real, got {tools:?}"
    );
}

#[test]
fn a_turn_opens_once_and_closes_once() {
    for name in ["plain", "edit", "bash", "failure", "subagent"] {
        let events = replay(name);
        let opened = events
            .iter()
            .filter(|e| matches!(e, TurnEvent::TurnStarted { .. }))
            .count();
        let closed = events
            .iter()
            .filter(|e| matches!(e, TurnEvent::TurnCompleted { .. }))
            .count();
        assert_eq!(opened, 1, "{name}: expected one turn to open");
        assert_eq!(closed, 1, "{name}: expected one turn to close");
    }
}

#[test]
fn a_turn_that_worked_says_so_and_says_what_it_cost() {
    let events = replay("edit");
    let completed = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TurnCompleted { status, usage, .. } => Some((status, usage)),
            _ => None,
        })
        .expect("the turn should complete");
    assert_eq!(*completed.0, TurnStatus::Completed);
    let usage = completed.1.as_ref().expect("a finished turn reports usage");
    assert!(usage.output_tokens > 0, "output tokens should be counted");
}

#[test]
fn a_turn_says_how_much_room_is_left() {
    // Read from the per-model breakdown, because a turn can involve a second,
    // smaller model and adding their tokens together describes nothing.
    let events = replay("edit");
    let usage = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TurnCompleted { usage, .. } => usage.clone(),
            _ => None,
        })
        .expect("the turn should complete");

    let window = usage.context_window.expect("the agent reports its window");
    let used = usage.context_used.expect("and how much of it went");
    assert!(window >= 200_000, "a real window, got {window}");
    assert!(used > 0 && used < window, "{used} of {window}");

    let full = usage.context_fullness().expect("both halves are known");
    assert!((0.0..=1.0).contains(&full), "{full}");
}

#[test]
fn context_counts_what_the_model_saw_not_what_was_billed() {
    // Caching means `input_tokens` can be single digits on a turn that had a
    // hundred thousand in front of it. Reporting that as the context used
    // would say a full session was empty.
    let events = replay("edit");
    let usage = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TurnCompleted { usage, .. } => usage.clone(),
            _ => None,
        })
        .expect("usage");
    assert!(
        usage.context_used.unwrap() > usage.input_tokens * 100,
        "cached tokens are still tokens the model read"
    );
}

#[test]
fn what_we_sent_comes_back_as_part_of_the_conversation() {
    // `--replay-user-messages` is why the stored log is the whole exchange
    // rather than half of it. If this stops holding, the transcript loses
    // every prompt anybody typed.
    let events = replay("plain");
    assert!(
        started(&events)
            .iter()
            .any(|(kind, _)| *kind == ItemKind::UserMessage),
        "the prompt we sent should appear in the transcript"
    );
}

#[test]
fn a_picture_somebody_sent_is_in_the_transcript() {
    // Hand-built rather than recorded: none of the captured sessions has an
    // attachment, and the shape is the one the agent echoes back.
    let mut normaliser = ClaudeNormaliser::new();
    let events = normaliser.push(
        r#"{"type":"user","uuid":"u1","message":{"role":"user","content":[
             {"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}},
             {"type":"text","text":"what colour?"}]}}"#,
    );

    let carried = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::ItemUpdated { data, .. } => data.get("images").cloned(),
            _ => None,
        })
        .expect("the picture should travel with the message");

    assert_eq!(carried[0]["mediaType"], "image/png");
    assert_eq!(carried[0]["data"], "AAAA");
    assert!(text_of(&events, StreamKind::UserText).contains("what colour?"));
}

#[test]
fn a_picture_from_somebody_elses_server_is_not_drawn() {
    // Nothing here sends a URL source, but an agent could echo one back, and
    // turning that into an image tag is how a transcript starts making requests
    // nobody asked for.
    let mut normaliser = ClaudeNormaliser::new();
    let events = normaliser.push(
        r#"{"type":"user","uuid":"u2","message":{"role":"user","content":[
             {"type":"image","source":{"type":"url","url":"https://elsewhere/x.png"}},
             {"type":"text","text":"hello"}]}}"#,
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, TurnEvent::ItemUpdated { .. })),
        "a remote source is not carried"
    );
}

#[test]
fn what_we_typed_is_not_mistaken_for_what_the_agent_said() {
    // They shared a stream kind once, and the inbox note for a finished
    // session came out as the prompt with the reply stuck on the end.
    let events = replay("plain");
    assert!(
        !text_of(&events, StreamKind::UserText).is_empty(),
        "our own message should carry its text"
    );
    assert!(
        !text_of(&events, StreamKind::AssistantText).contains("What is 2+2"),
        "the prompt should not appear in the assistant's own stream"
    );
}

// ---- items --------------------------------------------------------------

#[test]
fn prose_streams_rather_than_arriving_whole() {
    let events = replay("plain");
    let text = text_of(&events, StreamKind::AssistantText);
    assert!(
        text.contains('4'),
        "expected the answer in the text, got {text:?}"
    );

    // Streamed, not delivered once: a chat that only paints on completion is
    // the thing this whole change exists to stop.
    let deltas = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                TurnEvent::ContentDelta {
                    stream: StreamKind::AssistantText,
                    ..
                }
            )
        })
        .count();
    assert!(deltas >= 1, "assistant text should arrive as deltas");
}

#[test]
fn a_tool_call_is_drawn_as_what_it_does_not_as_its_name() {
    let kinds: Vec<ItemKind> = started(&replay("edit"))
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    assert!(
        kinds.contains(&ItemKind::FileRead),
        "reading a file before editing it is a read, got {kinds:?}"
    );
    assert!(
        kinds.contains(&ItemKind::FileChange),
        "an Edit is a file change, got {kinds:?}"
    );

    let kinds: Vec<ItemKind> = started(&replay("bash"))
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    assert!(
        kinds.contains(&ItemKind::CommandExecution),
        "a Bash call is a command, got {kinds:?}"
    );
}

#[test]
fn a_tool_call_ends_when_it_has_run_not_when_the_model_stops_describing_it() {
    // The block closes long before the command does. Completing the item on
    // `content_block_stop` would show every command as finished the instant it
    // was proposed.
    let events = replay("bash");
    let command = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::ItemStarted {
                item,
                kind: ItemKind::CommandExecution,
                ..
            } => Some(item),
            _ => None,
        })
        .expect("a command should start");

    let position_of = |want: &dyn Fn(&TurnEvent) -> bool| events.iter().position(want);
    let started =
        position_of(&|e| matches!(e, TurnEvent::ItemStarted { item, .. } if item == command))
            .unwrap();
    let output = position_of(&|e| {
        matches!(e, TurnEvent::ContentDelta { item, stream: StreamKind::ToolOutput, .. }
            if item == command)
    })
    .expect("a command should report what it printed");
    // This command's completion, not the first completion in the log — the
    // prompt we sent completes before the agent has done anything at all.
    let completed =
        position_of(&|e| matches!(e, TurnEvent::ItemCompleted { item, .. } if item == command))
            .expect("a command should complete");

    assert!(started < output, "output should follow the call");
    assert!(
        output <= completed,
        "a command completes once its output is back"
    );
}

#[test]
fn a_tool_learns_its_arguments_once_they_parse() {
    // They arrive as JSON fragments that are not valid JSON until the last one,
    // so the card is filled in from the whole message rather than the stream.
    let events = replay("bash");
    let update = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::ItemUpdated { data, .. } => Some(data),
            _ => None,
        })
        .expect("a tool call should report its input");
    assert!(
        update.get("command").is_some(),
        "a Bash call's input should carry its command, got {update}"
    );
}

#[test]
fn a_command_that_failed_is_not_reported_as_having_worked() {
    let events = replay("failure");
    assert!(
        events.iter().any(|e| matches!(
            e,
            TurnEvent::ItemCompleted {
                status: ItemStatus::Failed,
                ..
            }
        )),
        "a command that failed should complete as failed"
    );
}

#[test]
fn thinking_is_kept_but_kept_separate() {
    let events = replay("edit");
    assert!(
        started(&events)
            .iter()
            .any(|(kind, _)| *kind == ItemKind::Reasoning),
        "reasoning should be its own item, not folded into the reply"
    );
}

#[test]
fn reasoning_arrives_empty_unless_the_launch_asks_for_it() {
    // Not a bug here, and worth pinning so it isn't mistaken for one: current
    // models default to omitting the text of their reasoning, so the blocks
    // stream with nothing in them. The item still exists, and the transcript
    // correctly shows that the agent thought — but a UI that wants the words
    // needs the session launched with summarised thinking display, which is a
    // question for the launch flags rather than for this normaliser.
    let events = replay("edit");
    assert!(
        text_of(&events, StreamKind::Reasoning).is_empty(),
        "if this starts failing, reasoning text is now being sent and the \
         transcript should start showing it"
    );
}

// ---- plans and subagents ------------------------------------------------

#[test]
fn a_todo_list_is_a_plan_rather_than_a_tool_call() {
    let events = replay("plan");
    let steps = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::PlanUpdated { steps } => Some(steps),
            _ => None,
        })
        .expect("writing todos should produce a plan");
    assert!(!steps.is_empty(), "a plan should have steps");
}

#[test]
fn a_subagents_work_is_attributed_to_it_rather_than_to_the_main_thread() {
    // Without this every subagent's tool calls interleave into the transcript
    // and read as though the agent you are talking to made them.
    let events = replay("subagent");
    let task = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TaskStarted { task, .. } => Some(task.clone()),
            _ => None,
        })
        .expect("delegating should start a task");

    assert!(
        events.iter().any(|e| matches!(
            e,
            TurnEvent::ItemStarted { task: Some(owner), .. } if *owner == task
        )),
        "the subagent's own tool calls should name it as their owner"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, TurnEvent::TaskCompleted { .. })),
        "a task should report back"
    );
}

// ---- classification -----------------------------------------------------

#[test]
fn tools_we_have_a_shape_for_get_it() {
    assert_eq!(classify("Bash"), ItemKind::CommandExecution);
    assert_eq!(classify("Edit"), ItemKind::FileChange);
    assert_eq!(classify("Write"), ItemKind::FileChange);
    assert_eq!(classify("Read"), ItemKind::FileRead);
    assert_eq!(classify("Grep"), ItemKind::FileRead);
    assert_eq!(classify("WebSearch"), ItemKind::WebSearch);
    assert_eq!(classify("mcp__linear__create_issue"), ItemKind::McpToolCall);
    assert_eq!(classify("AskUserQuestion"), ItemKind::Question);
}

#[test]
fn a_question_is_not_a_command() {
    // It carries no path and runs nothing, so every generic branch below would
    // have drawn it as a mystery tool with the answer folded away inside it.
    assert_eq!(classify("AskUserQuestion"), ItemKind::Question);
    assert_eq!(classify("ask_user_question"), ItemKind::Question);
    assert_eq!(classify("user_question"), ItemKind::Question);
    // Except from a server, where which server asked is the more useful thing
    // to draw — the MCP check comes first for exactly that reason.
    assert_eq!(
        classify("mcp__something__ask_question"),
        ItemKind::McpToolCall
    );
}

#[test]
fn both_names_for_delegation_are_understood() {
    // It was `Task`; it is `Agent` now. Somewhere a host is running the other
    // one, and neither should land in the transcript as a mystery tool.
    assert_eq!(classify("Task"), ItemKind::SubagentCall);
    assert_eq!(classify("Agent"), ItemKind::SubagentCall);
}

#[test]
fn a_tool_we_have_never_heard_of_still_draws() {
    // The fallback is the whole reason guessing from names is acceptable: a
    // wrong guess costs a nicer card, never the event.
    assert_eq!(classify("SomeToolShippedLastTuesday"), ItemKind::Unknown);
}

// ---- robustness ---------------------------------------------------------

#[test]
fn a_line_we_cannot_read_does_not_take_the_session_with_it() {
    let mut normaliser = ClaudeNormaliser::new();
    assert!(normaliser.push("this is not json").is_empty());
    assert!(normaliser.push("").is_empty());
    // Still working afterwards.
    let events = normaliser.push(r#"{"type":"system","subtype":"init","model":"m","tools":[]}"#);
    assert!(matches!(events[0], TurnEvent::SessionConfigured { .. }));
}

#[test]
fn a_message_shape_we_do_not_know_is_kept_rather_than_dropped() {
    let mut normaliser = ClaudeNormaliser::new();
    let events = normaliser.push(r#"{"type":"something_new_entirely","detail":1}"#);
    assert!(
        matches!(events.as_slice(), [TurnEvent::Raw { .. }]),
        "an unrecognised line should survive as Raw, got {events:?}"
    );
}

#[test]
fn resuming_a_session_does_not_invent_a_turn_that_never_happened() {
    // A resumed session replays its handshake, ending in a result reporting no
    // turns. Treating that as a completed turn lands a spurious "finished" in
    // the inbox — which is exactly the kind of thing the old hooks got wrong.
    let mut normaliser = ClaudeNormaliser::new();
    normaliser.push(r#"{"type":"system","subtype":"init","model":"m","tools":[]}"#);
    let events = normaliser.push(r#"{"type":"result","subtype":"success","num_turns":0}"#);
    assert!(
        events.is_empty(),
        "the resume handshake is not a turn, got {events:?}"
    );
}

#[test]
fn no_two_things_on_screen_share_an_identifier() {
    // A list keyed by these has to be able to tell them apart. It could not:
    // the instruction handed to a subagent arrives in the same shape as the
    // message somebody typed, and both were keyed by the turn they were in.
    for name in ["plain", "edit", "bash", "plan", "failure", "subagent"] {
        let mut seen = std::collections::HashMap::new();
        for event in replay(name) {
            let TurnEvent::ItemStarted { item, kind, .. } = event else {
                continue;
            };
            if let Some(before) = seen.insert(item.clone(), kind) {
                panic!("{name}: {item} is both {before:?} and {kind:?}");
            }
        }
    }
}

#[test]
fn a_subagents_own_instruction_is_not_drawn_as_somebody_typing() {
    let events = replay("subagent");
    let task = events
        .iter()
        .find_map(|e| match e {
            TurnEvent::TaskStarted { task, .. } => Some(task.clone()),
            _ => None,
        })
        .expect("delegating should start a task");

    let typed: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::ItemStarted {
                kind: ItemKind::UserMessage,
                task,
                ..
            } => Some(task.clone()),
            _ => None,
        })
        .collect();

    assert_eq!(typed.len(), 2, "the prompt, and the subagent's instruction");
    assert!(typed.contains(&None), "one of them is the person");
    assert!(
        typed.contains(&Some(task)),
        "and one belongs to the subagent"
    );
}

#[test]
fn reading_the_same_log_twice_names_the_same_things() {
    // The point of derived identifiers. If this fails, re-deriving history
    // after fixing a mapping produces a different history.
    assert_eq!(replay("edit"), replay("edit"));
}

// ---- a question, and the moment it stops being one ----------------------

/// Two lines rather than a recording, deliberately.
///
/// The recordings cover what Claude Code's output *looks* like. This covers
/// correlating two of its lines, which is our own bookkeeping — and there is no
/// captured session with a question in it, because capturing one means
/// answering it by hand.
fn asked_then_answered(answer: Option<&str>) -> Vec<TurnEvent> {
    let ask = r#"{"type":"assistant","uuid":"u1","message":{"id":"m1","content":[
        {"type":"tool_use","id":"toolu_ask","name":"AskUserQuestion","input":{"questions":[
            {"question":"Which environment?","header":"Deploy","options":[
                {"label":"staging","description":"safe"},
                {"label":"production","description":"not"}]}]}}]}}"#;

    let mut normaliser = ClaudeNormaliser::new();
    let mut events = normaliser.push(ask);
    if let Some(chosen) = answer {
        let result = format!(
            r#"{{"type":"user","uuid":"u2","message":{{"content":[
                {{"tool_use_id":"toolu_ask","type":"tool_result","content":{},"is_error":false}}]}}}}"#,
            serde_json::to_string(chosen).unwrap()
        );
        events.extend(normaliser.push(&result));
    }
    events
}

fn resolved(events: &[TurnEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::UserInputResolved { req, .. } => Some(req.to_string()),
            _ => None,
        })
        .collect()
}

fn requested(events: &[TurnEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::UserInputRequested { req, .. } => Some(req.to_string()),
            _ => None,
        })
        .collect()
}

/// The whole transcript is replayed every time a browser attaches, so a
/// question that was answered an hour ago must not come back as one still
/// waiting. The `tool_result` is the only thing that says which it is.
#[test]
fn an_answered_question_is_reported_as_resolved() {
    let events = asked_then_answered(Some(r#""Which environment?"="staging""#));

    assert_eq!(
        requested(&events),
        vec!["toolu_ask"],
        "the question is still asked"
    );
    assert_eq!(
        resolved(&events),
        vec!["toolu_ask"],
        "and answering it says so, under the same request"
    );
}

/// It goes after the item, so the transcript entry is whole before the card
/// asking for an answer is taken off the screen.
#[test]
fn a_question_is_resolved_only_once_its_item_has_finished() {
    let events = asked_then_answered(Some("staging"));

    let completed = events
        .iter()
        .position(|e| matches!(e, TurnEvent::ItemCompleted { .. }))
        .expect("the tool call finishes");
    let resolved_at = events
        .iter()
        .position(|e| matches!(e, TurnEvent::UserInputResolved { .. }))
        .expect("the question resolves");

    assert!(
        completed < resolved_at,
        "the card must not go before the transcript entry is complete"
    );
}

/// The agent really is blocked until the result arrives, and until then the
/// question is the one thing the session needs somebody for.
#[test]
fn an_unanswered_question_stays_open() {
    let events = asked_then_answered(None);

    assert_eq!(requested(&events), vec!["toolu_ask"]);
    assert!(
        resolved(&events).is_empty(),
        "nothing answered it, so nothing may say it was"
    );
}

/// Only questions. Every other tool call finishes the same way and must not
/// produce an event that takes a card off the screen.
#[test]
fn an_ordinary_tool_result_resolves_no_question() {
    let events = replay("bash");
    assert!(
        resolved(&events).is_empty(),
        "a command's result is not an answer to anything"
    );
}
