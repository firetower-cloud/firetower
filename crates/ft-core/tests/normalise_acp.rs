use ft_core::acp::{AcpNormaliser, Record};
use ft_core::turn::{StreamKind, TurnEvent, TurnStatus};
use serde_json::json;

#[test]
fn session_configuration_is_discovered_on_load_and_replaced_while_idle() {
    use ft_core::controls::ControlKind;
    let mut reader = AcpNormaliser::default();
    let options = json!([
        {"id":"provider-model","category":"model","name":"Model","type":"select","currentValue":"a","options":[{"value":"a","name":"Alpha"},{"value":"b","name":"Beta"}]},
        {"id":"thinking","category":"thought_level","name":"Thinking","type":"select","currentValue":"high","options":[{"value":"high","name":"High"}]},
        {"id":"permissions","category":"mode","name":"Mode","type":"select","currentValue":"auto","options":[{"value":"auto","name":"Auto"}]}
    ]);
    for record in [
        Record::Started { epoch: "e".into() },
        Record::Sent {
            message: json!({"id":2,"method":"session/load","params":{"sessionId":"s"}}),
        },
        Record::Received {
            message: json!({"id":2,"result":{"configOptions":options}}),
            replay: true,
        },
        Record::Ready {
            session: "s".into(),
        },
    ] {
        reader.push(&serde_json::to_string(&record).unwrap());
    }
    let controls = reader.controls();
    assert_eq!(
        controls.len(),
        3,
        "model, effort and the permission mode are all pickers we have"
    );
    assert_eq!(controls[0].kind, ControlKind::Model);
    assert_eq!(controls[0].choices[1].label, "Beta");
    assert_eq!(controls[0].current.as_deref(), Some("a"));
    assert_eq!(controls[1].kind, ControlKind::Effort);
    assert_eq!(controls[2].kind, ControlKind::Mode);
    let change = reader.configure(ControlKind::Effort, "high").unwrap();
    assert_eq!(
        change["config_id"], "thinking",
        "route by the advertised ID, not category"
    );
    // The mode is routed the same way, by the ID the agent gave it rather
    // than by the category it fell under.
    let mode = reader.configure(ControlKind::Mode, "auto").unwrap();
    assert_eq!(mode["config_id"], "permissions");
    assert!(reader.configure(ControlKind::Model, "invented").is_none());
    assert!(reader.configure(ControlKind::Mode, "invented").is_none());
    reader.push(
        &serde_json::to_string(&Record::Sent {
            message: json!({"id":"change","method":"session/set_config_option"}),
        })
        .unwrap(),
    );
    reader.push(
        &serde_json::to_string(&Record::Received {
            message: json!({"id":"change","error":{"code":-32602,"message":"unavailable"}}),
            replay: false,
        })
        .unwrap(),
    );
    assert_eq!(
        reader.controls(),
        controls,
        "a refusal keeps the accepted configuration"
    );
    let update = Record::Received {
        message: json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"config_option_update","configOptions":[]}}}),
        replay: false,
    };
    reader.push(&serde_json::to_string(&update).unwrap());
    assert!(
        reader.controls().is_empty(),
        "the full list replaces stale choices"
    );
    assert!(
        !reader.working(),
        "configuration must not start a conversation turn"
    );
}

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

#[test]
fn accepted_model_change_replaces_efforts_without_starting_or_finishing_a_turn() {
    use ft_core::controls::ControlKind;
    let mut reader = AcpNormaliser::default();
    let mut feed = |record| reader.push(&serde_json::to_string(&record).unwrap());
    feed(Record::Started { epoch: "e".into() });
    feed(Record::Ready {
        session: "s".into(),
    });
    feed(Record::Sent {
        message: json!({"id":4,"method":"session/prompt","params":{"prompt":[]}}),
    });
    feed(Record::Sent {
        message: json!({"id":"choice","method":"session/set_config_option"}),
    });
    let events = feed(Record::Received {
        message: json!({"id":"choice","result":{"configOptions":[
            {"id":"model-id","category":"model","name":"Model","type":"select","currentValue":"b","options":[{"group":"family","name":"Family","options":[{"value":"b","name":"Beta"}]}]},
            {"id":"effort-id","category":"thought_level","name":"Effort","type":"select","currentValue":"low","options":[{"value":"low","name":"Low"}]}
        ]}}),
        replay: false,
    });
    assert!(reader.working());
    assert!(!events.iter().any(|e| matches!(
        e,
        TurnEvent::TurnCompleted { .. } | TurnEvent::TurnStarted { .. }
    )));
    assert_eq!(reader.controls()[0].current.as_deref(), Some("b"));
    assert_eq!(reader.controls()[0].choices[0].label, "Beta");
    assert!(reader.configure(ControlKind::Effort, "high").is_none());
    assert!(reader.configure(ControlKind::Effort, "low").is_some());
    reader.push(&serde_json::to_string(&Record::Received { message:json!({"method":"session/update","params":{"sessionId":"other","update":{"sessionUpdate":"config_option_update","configOptions":[]}}}), replay:false }).unwrap());
    assert_eq!(reader.controls().len(), 2);
    reader.push(
        &serde_json::to_string(&Record::Started {
            epoch: "restarted".into(),
        })
        .unwrap(),
    );
    assert!(
        reader.controls().is_empty(),
        "do not advertise stale choices during restart"
    );
}
