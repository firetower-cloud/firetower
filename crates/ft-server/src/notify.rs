//! Telling somebody a session has stopped.
//!
//! Firetower's claim is that it routes an agent's blocking to you wherever you
//! are. Everything before this delivers it as far as a browser that happens to
//! be open, which is not the same thing — the case that matters is the one
//! where nobody is looking.
//!
//! ## What this is, and what it is not
//!
//! One HTTP POST to a URL somebody configured. That covers a phone today, via
//! any of the services that turn a POST into a notification, and it needs
//! nothing from us that could go wrong quietly: no keys to manage, no service
//! worker, no encryption to get subtly wrong.
//!
//! It is deliberately not Web Push. Web Push is the better answer — no third
//! party in the middle — and it is also a VAPID keypair, a subscription store,
//! a service worker, and an encryption path none of which can be tested from
//! here. Shipping that untested would be worse than shipping this, and this
//! leaves the shape right: the trigger, the payload and the deployment
//! requirement are the same either way, so Web Push becomes a second sender
//! rather than a rewrite.
//!
//! ## The control plane has to be somewhere
//!
//! This runs where the control plane runs. Notifying a phone about a laptop
//! that is asleep is not possible from a program on that laptop, so a person
//! who wants to be told while away from their desk has to run Firetower
//! somewhere that stays up. That is a deployment note, not a feature.
//!
//! The worker still never dials out. This is the control plane, which already
//! reaches the internet to push branches and open pull requests.

use ft_core::SessionId;
use serde::Serialize;

/// Where to say it, if anywhere.
///
/// Absent is the ordinary case and not a misconfiguration: a laptop with the
/// browser open needs none of this.
#[derive(Clone)]
pub struct Notifier {
    to: Option<String>,
    http: reqwest::Client,
}

/// What somebody is told.
///
/// Flat and plain, so it survives whatever is on the other end. Most services
/// that turn a POST into a notification read `title` and `message`; the rest is
/// there for something doing its own formatting.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting<'a> {
    pub title: &'a str,
    pub message: &'a str,
    pub session_id: &'a str,
    pub session: &'a str,
    /// Where to go to deal with it, when the control plane knows its own
    /// address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl Notifier {
    /// Read from the environment, because this belongs to an install rather
    /// than to an account.
    pub fn from_env() -> Self {
        let to = std::env::var("FIRETOWER_NOTIFY_URL")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());

        // Said once at startup, because the failure this prevents is silent:
        // somebody sets the variable, waits for a notification that never
        // comes, and has nothing to look at to find out why.
        match &to {
            Some(_) => tracing::info!("notifications on: FIRETOWER_NOTIFY_URL is set"),
            None => tracing::debug!("notifications off: set FIRETOWER_NOTIFY_URL to turn them on"),
        }

        Self {
            to,
            http: reqwest::Client::new(),
        }
    }

    pub fn configured(&self) -> bool {
        self.to.is_some()
    }

    /// Say that a session stopped and needs somebody.
    ///
    /// Never fails loudly and never blocks the thing that called it: an agent
    /// waiting for an answer is already the urgent problem, and a notification
    /// that could not be delivered must not become a second one.
    pub fn stopped(&self, id: &SessionId, name: &str, about: &str, at: Option<&str>) {
        let Some(to) = self.to.clone() else {
            return;
        };

        let body = serde_json::to_value(Waiting {
            title: &format!("{name} needs you"),
            message: about,
            session_id: id.as_str(),
            session: name,
            url: at.map(|base| format!("{}/sessions/{id}", base.trim_end_matches('/'))),
        });
        let Ok(body) = body else { return };

        let http = self.http.clone();
        let id = id.clone();
        tracing::debug!(session = %id, to = %to, "sending a notification");
        tokio::spawn(async move {
            match http
                .post(&to)
                .json(&body)
                // Long enough for a service having a slow moment, short enough
                // that a dead URL does not leave a task hanging around.
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
            {
                Ok(answered) if answered.status().is_success() => {}
                Ok(answered) => {
                    tracing::warn!(session = %id, status = %answered.status(), "the notification was refused")
                }
                Err(e) => tracing::warn!(session = %id, "could not send the notification: {e:#}"),
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_configured_means_nothing_is_sent() {
        // The ordinary case: somebody at a desk with the page open.
        let quiet = Notifier {
            to: None,
            http: reqwest::Client::new(),
        };
        assert!(!quiet.configured());
        // No panic, no task, no complaint.
        quiet.stopped(
            &SessionId::from_stored("s_1"),
            "Agent 3",
            "Write: /tmp/x",
            None,
        );
    }

    #[test]
    fn what_gets_sent_says_which_session_and_where_to_go() {
        let told = Waiting {
            title: "Agent 3 needs you",
            message: "Write: /tmp/x",
            session_id: "s_1",
            session: "Agent 3",
            url: Some("https://firetower.example/sessions/s_1".into()),
        };
        let json = serde_json::to_value(&told).unwrap();
        assert_eq!(json["title"], "Agent 3 needs you");
        assert_eq!(json["message"], "Write: /tmp/x");
        assert_eq!(json["sessionId"], "s_1");
        assert_eq!(json["url"], "https://firetower.example/sessions/s_1");
    }

    #[test]
    fn a_url_is_left_out_when_nobody_knows_this_install_s_address() {
        let told = Waiting {
            title: "t",
            message: "m",
            session_id: "s_1",
            session: "Agent 3",
            url: None,
        };
        let json = serde_json::to_value(&told).unwrap();
        assert!(json.get("url").is_none(), "better absent than wrong");
    }
}
