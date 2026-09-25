use ft_core::acp::{Input, Record};
use ft_core::turn::Decision;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines};

struct Peer {
    input: DuplexStream,
    output: Lines<BufReader<DuplexStream>>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
    _workspace: tempfile::TempDir,
}
impl Peer {
    async fn start(scenario: &str, saved: bool) -> Self {
        let workspace = tempfile::tempdir().unwrap();
        if saved {
            std::fs::create_dir(workspace.path().join(".firetower")).unwrap();
            std::fs::write(
                workspace.path().join(".firetower/acp-test.json"),
                r#"{"session":"old-session","carry":null}"#,
            )
            .unwrap();
        }
        if saved {
            let history = [
                Record::Started {
                    epoch: "old".into(),
                },
                Record::Ready {
                    session: "old-session".into(),
                },
                Record::Sent {
                    message: json!({"id":4,"method":"session/prompt","params":{"prompt":[{"type":"text","text":"remember the blue door"}]}}),
                },
                Record::Received {
                    message: json!({"id":4,"result":{"stopReason":"end_turn"}}),
                    replay: false,
                },
            ];
            std::fs::write(
                workspace.path().join(".firetower/agent-test.ndjson"),
                history
                    .iter()
                    .map(|r| format!("{}\n", serde_json::to_string(r).unwrap()))
                    .collect::<String>(),
            )
            .unwrap();
        }
        let mut command = tokio::process::Command::new("python3");
        command
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/acp.py"
            ))
            .arg(scenario);
        let (input, reader) = tokio::io::duplex(65536);
        let (writer, output) = tokio::io::duplex(65536);
        let path = workspace.path().to_owned();
        let task = tokio::spawn(async move {
            ft_worker::acp::serve(command, "test", &path, BufReader::new(reader), writer).await
        });
        Self {
            input,
            output: BufReader::new(output).lines(),
            task,
            _workspace: workspace,
        }
    }
    async fn record(&mut self) -> Record {
        let line = tokio::time::timeout(std::time::Duration::from_secs(5), self.output.next_line())
            .await
            .unwrap()
            .unwrap()
            .expect("bridge output");
        serde_json::from_str(&line).unwrap()
    }
    async fn ready(&mut self) -> Vec<Record> {
        let mut seen = Vec::new();
        loop {
            let record = self.record().await;
            let ready = matches!(record, Record::Ready { .. });
            assert!(!matches!(record, Record::Failed { .. }), "{record:?}");
            seen.push(record);
            if ready {
                return seen;
            }
        }
    }
    async fn send(&mut self, input: Input) {
        self.input
            .write_all(format!("{}\n", serde_json::to_string(&input).unwrap()).as_bytes())
            .await
            .unwrap();
    }
    async fn sent(&mut self, method: &str) -> Value {
        loop {
            if let Record::Sent { message } = self.record().await {
                if message["method"] == method {
                    return message;
                }
            }
        }
    }
    async fn finish(mut self) {
        self.input.shutdown().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn startup_precedes_prompts_and_followups_keep_the_session() {
    let mut peer = Peer::start("normal", false).await;
    peer.send(Input::Prompt {
        text: "first".into(),
    })
    .await;
    let records = peer.ready().await;
    assert!(!records
        .iter()
        .any(|r| matches!(r, Record::Sent { message } if message["method"] == "session/prompt")));
    let first = peer.sent("session/prompt").await;
    assert_eq!(first["params"]["sessionId"], "fixture-session");
    loop {
        if let Record::Received { message, .. } = peer.record().await {
            if message["id"] == first["id"] {
                break;
            }
        }
    }
    peer.send(Input::Prompt {
        text: "second".into(),
    })
    .await;
    let second = peer.sent("session/prompt").await;
    assert_eq!(second["params"]["sessionId"], "fixture-session");
    assert_ne!(first["id"], second["id"]);
    peer.finish().await;
}

#[tokio::test]
async fn load_replays_are_marked_and_missing_sessions_can_start_fresh() {
    for scenario in ["normal", "no-load", "missing"] {
        let mut peer = Peer::start(scenario, true).await;
        let records = peer.ready().await;
        let methods: Vec<_> = records
            .iter()
            .filter_map(|r| match r {
                Record::Sent { message } => message["method"].as_str(),
                _ => None,
            })
            .collect();
        if scenario == "normal" {
            assert_eq!(methods, ["initialize", "session/load"]);
            assert!(records.iter().any(|r| matches!(r, Record::Received { replay: true, message } if message["method"] == "session/update")));
        } else if scenario == "no-load" {
            assert_eq!(methods, ["initialize", "session/new"]);
        } else {
            assert_eq!(methods, ["initialize", "session/load", "session/new"]);
        }
        peer.finish().await;
    }
}

#[tokio::test]
async fn authentication_failure_is_not_retried_as_a_fresh_session() {
    let mut peer = Peer::start("load-auth", true).await;
    loop {
        match peer.record().await {
            Record::Sent { message } => assert_ne!(message["method"], "session/new"),
            Record::Failed { detail } => {
                assert!(detail.contains("Authentication required"));
                break;
            }
            _ => {}
        }
    }
    assert!(peer.task.await.unwrap().is_err());
}

#[tokio::test]
async fn decisions_preserve_string_ids_and_stale_answers_cannot_authorize() {
    for (decision, option) in [
        (Decision::Allow, "yes"),
        (Decision::Deny { reason: None }, "no"),
    ] {
        let mut peer = Peer::start("permission", false).await;
        let records = peer.ready().await;
        let epoch = records
            .iter()
            .find_map(|r| match r {
                Record::Started { epoch } => Some(epoch.clone()),
                _ => None,
            })
            .unwrap();
        peer.send(Input::Prompt {
            text: "read".into(),
        })
        .await;
        loop {
            if let Record::Received { message, .. } = peer.record().await {
                if message["method"] == "session/request_permission" {
                    break;
                }
            }
        }
        peer.send(Input::Decide {
            req: "old-epoch:\"permit-1\"".into(),
            decision: Decision::Allow,
        })
        .await;
        peer.send(Input::Decide {
            req: ft_core::acp::request_key(&epoch, &json!("permit-1")),
            decision,
        })
        .await;
        loop {
            if let Record::Sent { message } = peer.record().await {
                if message.get("method").is_none() {
                    assert_eq!(message["id"], "permit-1");
                    assert_eq!(message["result"]["outcome"]["optionId"], option);
                    break;
                }
            }
        }
        peer.finish().await;
    }
}

#[tokio::test]
async fn cancellation_uses_the_protocol_and_keeps_the_connection() {
    let mut peer = Peer::start("cancel", false).await;
    peer.ready().await;
    peer.send(Input::Prompt {
        text: "work".into(),
    })
    .await;
    peer.sent("session/prompt").await;
    peer.send(Input::Cancel).await;
    let cancel = peer.sent("session/cancel").await;
    assert!(cancel.get("id").is_none());
    loop {
        if let Record::Received { message, .. } = peer.record().await {
            if message["result"]["stopReason"] == "cancelled" {
                break;
            }
        }
    }
    peer.send(Input::Prompt {
        text: "continue".into(),
    })
    .await;
    peer.sent("session/prompt").await;
    peer.finish().await;
}

#[tokio::test]
async fn carried_history_is_sent_once_without_reexecuting_the_old_prompt() {
    let mut peer = Peer::start("no-load", true).await;
    peer.ready().await;
    peer.send(Input::Prompt {
        text: "new request".into(),
    })
    .await;
    let first = peer.sent("session/prompt").await;
    let text = first["params"]["prompt"][0]["text"].as_str().unwrap();
    assert!(text.contains("blue door") && text.contains("new request"));
    loop {
        if let Record::Received { message, .. } = peer.record().await {
            if message["id"] == first["id"] {
                break;
            }
        }
    }
    peer.send(Input::Prompt {
        text: "follow up".into(),
    })
    .await;
    let second = peer.sent("session/prompt").await;
    assert_eq!(second["params"]["prompt"][0]["text"], "follow up");
    peer.finish().await;
}

#[tokio::test]
async fn malformed_output_and_process_exit_are_visible_failures_not_retries() {
    for scenario in ["malformed", "exit"] {
        let mut peer = Peer::start(scenario, false).await;
        peer.ready().await;
        peer.send(Input::Prompt {
            text: "work".into(),
        })
        .await;
        peer.sent("session/prompt").await;
        loop {
            match peer.record().await {
                Record::Failed { detail } => {
                    assert!(!detail.is_empty());
                    break;
                }
                Record::Sent { message } => assert_ne!(message["method"], "session/prompt"),
                _ => {}
            }
        }
        assert!(peer.task.await.unwrap().is_err());
    }
}

#[tokio::test]
async fn configuration_replies_keep_their_ids_and_refusal_does_not_end_the_session() {
    let mut peer = Peer::start("normal", false).await;
    peer.ready().await;
    for value in ["refused", "low"] {
        peer.send(Input::Configure {
            id: format!("setting-{value}"),
            config_id: "thinking".into(),
            value: value.into(),
        })
        .await;
        let sent = peer.sent("session/set_config_option").await;
        assert_eq!(sent["params"]["configId"], "thinking");
        assert_eq!(sent["params"]["sessionId"], "fixture-session");
        loop {
            if let Record::Received { message, .. } = peer.record().await {
                if message["id"] == sent["id"] {
                    if value == "refused" {
                        assert_eq!(message["error"]["code"], -32602);
                    } else {
                        assert_eq!(message["result"]["configOptions"][0]["currentValue"], "low");
                    }
                    break;
                }
            }
        }
    }
    peer.send(Input::Prompt {
        text: "still usable".into(),
    })
    .await;
    assert_eq!(
        peer.sent("session/prompt").await["params"]["sessionId"],
        "fixture-session"
    );
    peer.finish().await;
}

#[tokio::test]
async fn a_second_configuration_is_rejected_until_the_first_has_a_response() {
    let mut peer = Peer::start("configure-hold", false).await;
    peer.ready().await;
    for id in ["first", "second"] {
        peer.send(Input::Configure {
            id: id.into(),
            config_id: "model".into(),
            value: "a".into(),
        })
        .await;
    }
    assert_eq!(peer.sent("session/set_config_option").await["id"], "first");
    match peer.record().await {
        Record::ConfigurationRejected { id, detail } => {
            assert_eq!(id, "second");
            assert!(detail.contains("awaiting"));
        }
        other => panic!("second setting must not reach the agent: {other:?}"),
    }
    peer.send(Input::Prompt {
        text: "still responsive".into(),
    })
    .await;
    peer.sent("session/prompt").await;
    peer.finish().await;
}
