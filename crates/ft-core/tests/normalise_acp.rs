use ft_core::acp::{AcpNormaliser, Record};
use ft_core::turn::{StreamKind, TurnEvent, TurnStatus};
use serde_json::json;

#[test]
fn a_prompt_streams_and_only_its_own_response_completes_it() {
    let mut reader = AcpNormaliser::default();
    let records = [
        Record::Started {
            epoch: "run1".into(),
        },
        Record::Ready {
            session: "s".into(),
        },
        Record::Sent {
            message: json!({"id":3,"method":"session/prompt","params":{"sessionId":"s","prompt":[{"type":"text","text":"hello"}]}}),
        },
        Record::Received {
            message: json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}}}),
            replay: false,
        },
        Record::Received {
            message: json!({"id":99,"result":{}}),
            replay: false,
        },
    ];
    let mut events = Vec::new();
    for record in records {
        events.extend(reader.push(&serde_json::to_string(&record).unwrap()));
    }
    assert!(reader.working());
    assert!(events.iter().any(|e| matches!(e, TurnEvent::ContentDelta { stream: StreamKind::AssistantText, delta, .. } if delta == "Hi")));
    let end = reader.push(
        &serde_json::to_string(&Record::Received {
            message: json!({"id":3,"result":{"stopReason":"end_turn"}}),
            replay: false,
        })
        .unwrap(),
    );
    assert!(matches!(
        end.last(),
        Some(TurnEvent::TurnCompleted {
            status: TurnStatus::Completed,
            ..
        })
    ));
    assert!(!reader.working());
}

#[test]
fn permissions_use_the_offered_ids_and_never_upgrade_a_one_off_allow() {
    use ft_core::{acp::permission_outcome, turn::Decision};
    let options = json!([{"kind":"allow_always","optionId":"forever"},{"kind":"reject_once","optionId":"no"}]);
    assert_eq!(
        permission_outcome(&options, &Decision::Allow),
        json!({"outcome":"cancelled"})
    );
    assert_eq!(
        permission_outcome(&options, &Decision::Deny { reason: None }),
        json!({"outcome":"selected","optionId":"no"})
    );
    assert_eq!(
        permission_outcome(
            &json!([{"kind":"allow_once","optionId":"once"}]),
            &Decision::AllowAlways
        ),
        json!({"outcome":"cancelled"})
    );
}

#[test]
fn replay_does_not_duplicate_history_and_failed_start_is_visible() {
    let mut reader = AcpNormaliser::default();
    let replay = Record::Received {
        message: json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"old"}}}}),
        replay: true,
    };
    assert!(reader
        .push(&serde_json::to_string(&replay).unwrap())
        .is_empty());
    let failed = reader.push(
        &serde_json::to_string(&Record::Failed {
            detail: "Authentication required".into(),
        })
        .unwrap(),
    );
    assert!(
        matches!(failed.last(), Some(TurnEvent::TurnCompleted { status: TurnStatus::Failed, detail: Some(detail), .. }) if detail.contains("Authentication"))
    );
}

#[test]
fn tool_content_snapshots_do_not_repeat_partial_arguments_as_output() {
    let mut reader = AcpNormaliser::default();
    for record in [
        Record::Started { epoch: "e".into() },
        Record::Ready {
            session: "s".into(),
        },
        Record::Sent {
            message: json!({"id":4,"method":"session/prompt","params":{"prompt":[]}}),
        },
    ] {
        reader.push(&serde_json::to_string(&record).unwrap());
    }
    let mut output = String::new();
    for (kind, status, text) in [
        ("tool_call", "pending", "{"),
        ("tool_call_update", "in_progress", "{\"command\":"),
        ("tool_call_update", "completed", "done"),
    ] {
        let record = Record::Received {
            message: json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":kind,"toolCallId":"tool","status":status,"content":[{"type":"content","content":{"type":"text","text":text}}]}}}),
            replay: false,
        };
        for event in reader.push(&serde_json::to_string(&record).unwrap()) {
            if let TurnEvent::ContentDelta {
                stream: StreamKind::ToolOutput,
                delta,
                ..
            } = event
            {
                output.push_str(&delta);
            }
        }
    }
    assert_eq!(output, "done");
}
