//! Recognize explicit quota failures, never arbitrary assistant or tool text.
use crate::TurnEvent;
use serde_json::Value;

pub fn blocked(status: &str) -> bool {
    matches!(status, "rejected" | "blocked")
}

pub(crate) fn failure(error: &Value) -> Option<TurnEvent> {
    let code = error
        .get("codexErrorInfo")
        .and_then(Value::as_str)
        .or_else(|| error.get("code").and_then(Value::as_str))
        .or_else(|| error.get("type").and_then(Value::as_str))?;
    if !matches!(
        code,
        "usageLimitExceeded" | "insufficient_quota" | "usage_limit_reached"
    ) {
        return None;
    }
    Some(TurnEvent::Limited {
        window: "account".into(),
        status: "blocked".into(),
        resets_at: None,
        used_percent: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_events_are_detected_through_the_agent_reader() {
        for (agent, line, expected_window, expected_reset) in [
            (
                crate::Agent::ClaudeCode,
                r#"{"type":"rate_limit_event","rate_limit_info":{"rateLimitType":"five_hour","status":"rejected","resetsAt":1893456000}}"#,
                "five_hour",
                Some(1893456000),
            ),
            (
                crate::Agent::Codex,
                r#"{"method":"error","params":{"error":{"codexErrorInfo":"usageLimitExceeded","message":"Usage limit reached"}}}"#,
                "account",
                None,
            ),
        ] {
            let mut reader = crate::normalise::Reader::for_agent(agent);
            let events = reader.push(line);
            assert_eq!(events.len(), 1, "{agent:?}: {events:?}");
            match &events[0] {
                TurnEvent::Limited {
                    window,
                    status,
                    resets_at,
                    used_percent,
                } => {
                    assert_eq!(window, expected_window);
                    assert!(blocked(status), "{agent:?}: quota rejection must block");
                    assert_eq!(*resets_at, expected_reset);
                    assert_eq!(*used_percent, None, "do not invent a quota balance");
                }
                other => panic!("{agent:?}: expected quota detection, got {other:?}"),
            }
        }
    }

    #[test]
    fn temporary_throttling_is_not_detected_as_quota_exhaustion() {
        for (agent, line) in [
            (
                crate::Agent::ClaudeCode,
                r#"{"type":"error","error":{"type":"rate_limit_exceeded","message":"Usage limit reached"}}"#,
            ),
            (
                crate::Agent::Codex,
                r#"{"method":"error","params":{"error":{"code":"429","message":"Usage limit reached"}}}"#,
            ),
        ] {
            let mut reader = crate::normalise::Reader::for_agent(agent);
            assert!(
                !reader
                    .push(line)
                    .iter()
                    .any(|event| matches!(event, TurnEvent::Limited { .. })),
                "{agent:?}: throttling is not account exhaustion"
            );
        }
    }

    #[test]
    fn only_explicit_exhaustion_is_a_block() {
        for code in [
            "usageLimitExceeded",
            "insufficient_quota",
            "usage_limit_reached",
        ] {
            assert!(failure(&serde_json::json!({"code":code})).is_some());
        }
        for code in [
            "rate_limit_exceeded",
            "429",
            "authentication_error",
            "server_error",
        ] {
            assert!(failure(&serde_json::json!({"code":code})).is_none());
        }
        assert!(failure(&serde_json::json!({"message":"out of credits"})).is_none());
        assert!(!blocked("allowed_warning"));
        assert!(!blocked("reached")); // a meter alone is not an execution failure
    }
}
