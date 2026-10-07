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

/// Replays a captured ACP connection, line for line, as the worker journalled it.
fn replay(name: &str) -> (AcpNormaliser, Vec<TurnEvent>) {
    let path = format!("{}/tests/streams/{name}.ndjson", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {path}: {e}"));
    let mut reader = AcpNormaliser::default();
    let events = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .flat_map(|line| reader.push(line))
        .collect();
    (reader, events)
}

/// What a real Kimi connection actually says about what it spent.
///
/// Recorded from one, because the protocol and the build disagree: ACP defines
/// a per-turn breakdown and Kimi does not send it. The parser is written for
/// the one that is specified; this holds the line on what today's agent gives.
#[test]
fn a_kimi_turn_reports_a_context_gauge_and_no_bill() {
    let (reader, events) = replay("kimi_acp");

    // The model is known before any turn runs — it is a `configOptions` entry
    // in the answer to `session/new`, which is why a billed row can be named at
    // all when the usage block carries no model.
    assert_eq!(reader.model(), Some("kimi-code/kimi-for-coding"));

    // `usage_update` arrives *after* the reply that ends the turn, so a reader
    // that only looked at it while a turn was open would never see one.
    assert_eq!(reader.context(), Some((20_237, 1_048_576)));

    let ended: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TurnEvent::TurnCompleted { usage, status, .. } => Some((usage, status)),
            _ => None,
        })
        .collect();
    assert_eq!(ended.len(), 1, "one prompt, one turn");
    let (usage, status) = ended[0];
    assert_eq!(*status, TurnStatus::Completed);

    // And the turn itself is billed nothing at all — not zero tokens, nothing.
    // The gauge is a message later than the reply that ends the turn, so the
    // first turn of a connection has neither a bill nor a gauge to carry, and
    // inventing one of either would be the page's first wrong number.
    assert!(
        usage.is_none(),
        "a turn whose agent said nothing about tokens reports nothing: {usage:?}",
    );
}

/// The gauge is a message behind, so it rides on the turn after it arrives.
///
/// Kimi sends `usage_update` once the prompt has been answered. Nothing can put
/// it on the turn that is already over — but it is a standing fact about the
/// session rather than about one turn, so the next turn carries what is by then
/// known, and the session view is a turn fresher rather than permanently empty.
#[test]
fn a_gauge_that_arrives_late_rides_on_the_turn_after_it() {
    let (mut reader, _) = replay("kimi_acp");
    assert_eq!(reader.context(), Some((20_237, 1_048_576)));

    reader.push(
        &serde_json::to_string(&Record::Sent {
            message: json!({"id":9,"method":"session/prompt","params":{"sessionId":"session_kimi"}}),
        })
        .unwrap(),
    );
    let usage = reader
        .push(
            &serde_json::to_string(&Record::Received {
                message: json!({"id":9,"result":{"stopReason":"end_turn"}}),
                replay: false,
            })
            .unwrap(),
        )
        .into_iter()
        .find_map(|e| match e {
            TurnEvent::TurnCompleted { usage, .. } => usage,
            _ => None,
        })
        .expect("the gauge is known by now");

    assert_eq!(usage.context_used, Some(20_237));
    assert_eq!(usage.context_window, Some(1_048_576));
    // Still nothing billable, and still no price. A gauge is not a bill.
    assert_eq!(usage.input_tokens, 0);
    assert_eq!(usage.output_tokens, 0);
    assert_eq!(usage.cost_usd, None, "ACP states no price on a turn");
}

/// ACP's totals are the session's, so a turn is the difference between two.
///
/// Every field is documented "across session" / "across all turns". Read as a
/// turn's own figures they bill turn one again on every turn after it — the
/// bug that was found in Claude Code's `modelUsage` and corrected the same way.
#[test]
fn an_acp_turn_is_billed_the_difference_rather_than_the_running_total() {
    let mut reader = AcpNormaliser::default();
    let mut feed = |record: Record| reader.push(&serde_json::to_string(&record).unwrap());

    feed(Record::Started { epoch: "e".into() });
    feed(Record::Ready {
        session: "s".into(),
    });

    let turn = |reader: &mut AcpNormaliser, id: u64, usage: serde_json::Value| {
        reader.push(
            &serde_json::to_string(&Record::Sent {
                message: json!({"id":id,"method":"session/prompt","params":{"sessionId":"s"}}),
            })
            .unwrap(),
        );
        reader
            .push(
                &serde_json::to_string(&Record::Received {
                    message: json!({"id":id,"result":{"stopReason":"end_turn","usage":usage}}),
                    replay: false,
                })
                .unwrap(),
            )
            .into_iter()
            .find_map(|e| match e {
                TurnEvent::TurnCompleted { usage, .. } => usage,
                _ => None,
            })
            .expect("a finished turn is billed")
    };

    let first = turn(
        &mut reader,
        1,
        json!({"totalTokens":11_600,"inputTokens":1_000,"outputTokens":100,
               "cachedReadTokens":10_000,"cachedWriteTokens":500,"thoughtTokens":40}),
    );
    assert_eq!(first.input_tokens, 1_000, "the first turn is all of it");
    assert_eq!(first.cache_read_tokens, Some(10_000));

    // The agent restates the session's totals. Only the growth is this turn's.
    let second = turn(
        &mut reader,
        2,
        json!({"totalTokens":34_300,"inputTokens":1_200,"outputTokens":400,
               "cachedReadTokens":32_000,"cachedWriteTokens":700,"thoughtTokens":90}),
    );
    assert_eq!(second.input_tokens, 200, "1,200 cumulative less 1,000");
    assert_eq!(second.output_tokens, 300, "400 less 100");
    assert_eq!(second.cache_read_tokens, Some(22_000), "32,000 less 10,000");
    assert_eq!(second.cache_write_tokens, Some(200));
    assert_eq!(second.thinking_tokens, Some(50));

    // And the two together are what the agent last said the session came to,
    // which is the property the differencing exists to keep.
    assert_eq!(first.input_tokens + second.input_tokens, 1_200);
    assert_eq!(
        first.cache_read_tokens.unwrap() + second.cache_read_tokens.unwrap(),
        32_000,
    );
}
