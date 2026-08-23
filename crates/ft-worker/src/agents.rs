//! What agents this machine has.
//!
//! Only the host knows, so the control plane asks rather than assuming. Being
//! absent is an ordinary answer here, not an error — most hosts will have some
//! of these and not others.

use ft_core::{Agent, AgentPresence};
use tokio::process::Command;

/// Ask every kind for its version. Missing binaries simply report absent.
pub async fn probe() -> Vec<AgentPresence> {
    let mut out = Vec::new();
    for kind in Agent::all() {
        let version = version_of(kind.command()).await;
        let installed = version.is_some();

        // Only worth asking if it's there at all.
        let (logged_in, account) = if installed {
            signed_in(kind).await
        } else {
            (None, None)
        };

        out.push(AgentPresence {
            kind,
            installed,
            version,
            logged_in,
            account,
        });
    }
    out
}

/// Whether an agent is signed in, and as whom.
///
/// `(None, None)` means it offers no way to ask — the honest answer then is
/// that nobody knows until a session runs.
async fn signed_in(kind: Agent) -> (Option<bool>, Option<String>) {
    let Some(args) = kind.auth_status_command() else {
        return (None, None);
    };

    let Ok(output) = Command::new(kind.command()).args(args).output().await else {
        return (None, None);
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(status) = serde_json::from_str::<serde_json::Value>(&text) else {
        // It answered in a shape we don't recognise, which is not the same as
        // answering "no". Saying we can't tell is the truthful reading.
        return (None, None);
    };

    let logged_in = status.get("loggedIn").and_then(|v| v.as_bool());

    // Enough to tell which account a host will spend against, without copying
    // the whole payload into our own model.
    let account = match (
        status.get("email").and_then(|v| v.as_str()),
        status.get("subscriptionType").and_then(|v| v.as_str()),
    ) {
        (Some(email), Some(plan)) => Some(format!("{email} · {plan}")),
        (Some(email), None) => Some(email.to_string()),
        _ => None,
    };

    (logged_in, account.filter(|_| logged_in == Some(true)))
}

/// `claude --version` and friends. `None` means it isn't on the path.
///
/// Deliberately does not say whether the agent is *authenticated*: none of
/// these offer a non-interactive way to ask, and inferring it from their
/// credential files means depending on a format that is theirs to change.
async fn version_of(program: &str) -> Option<String> {
    let output = Command::new(program).arg("--version").output().await.ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_binary_is_an_answer_not_a_failure() {
        assert!(version_of("firetower-definitely-not-installed")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn probing_reports_every_kind_whether_present_or_not() {
        // Absent is an ordinary answer: a row for every kind, whether or not
        // this machine has it. That is what lets the agents page say "not
        // installed here" rather than leaving a gap somebody has to interpret.
        let found = probe().await;
        assert_eq!(found.len(), Agent::all().len());
        for kind in Agent::all() {
            let seen = found.iter().find(|a| a.kind == kind).unwrap();
            assert_eq!(
                seen.installed,
                seen.version.is_some(),
                "{kind:?} should report a version exactly when it is installed"
            );
        }
    }
}
