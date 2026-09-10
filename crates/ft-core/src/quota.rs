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
