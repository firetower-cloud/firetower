//! A token that expires, and the one that replaces it.
//!
//! **GitLab forces this.** Its OAuth access tokens last two hours, the figure
//! is not configurable — `access_token_expires_in 7200` in its own Doorkeeper
//! initializer, checked against a running 18.0 — and the per-application
//! opt-out was taken away in 15.0. So every GitLab authorized in a browser
//! stops working two hours later unless something renews it. A `refresh_token`
//! comes back beside the access token for exactly that, and spending it is the
//! only way to stay connected.
//!
//! GitHub is the other shape. An OAuth App's tokens do not expire unless
//! somebody ticks "Expire user authorization tokens", and refreshing one needs
//! the client *secret* — which a device-flow application has none of, by
//! design. There is nothing to renew with, so the instructions for registering
//! one say to leave that box alone. A pasted personal access token is the same
//! shape again: whoever made it chose its lifetime, and when it lapses they
//! make another.
//!
//! Which is why a grant is a *range* of shapes rather than one: a bare string
//! with no expiry at one end, and a rotating pair at the other.

use super::{client, Connection};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// How long before the stated expiry a token is treated as already gone.
///
/// A token that expires during the request it was chosen for fails the same way
/// as one that was already dead, and the clocks at the two ends are not the
/// same clock. A minute costs a renewal nobody would have noticed; the other
/// way costs a failure somebody will.
const MARGIN: i64 = 60;

/// A credential for a host, as Firetower holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub access: String,
    /// What to trade for the next one, where the host gave one.
    pub refresh: Option<String>,
    /// When `access` stops working. `None` means "as far as anyone knows,
    /// never" — a GitHub OAuth App token, or a personal one somebody pasted.
    pub expires_at: Option<DateTime<Utc>>,
}

/// The stored form of a grant that has something to renew.
///
/// Only ever written for those. A grant with no refresh and no expiry is stored
/// as the bare token — see [`Grant::to_stored`].
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Envelope {
    access: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<DateTime<Utc>>,
}

impl Grant {
    /// A token with nothing to renew it and no stated end.
    pub fn bare(access: impl Into<String>) -> Self {
        Self {
            access: access.into(),
            refresh: None,
            expires_at: None,
        }
    }

    /// Whether anything here would let us get a fresh token.
    pub fn renewable(&self) -> bool {
        self.refresh.as_deref().is_some_and(|r| !r.trim().is_empty())
    }

    /// How it goes into the vault.
    ///
    /// **A grant with nothing to renew is stored as the bare token** — byte for
    /// byte what was written before any of this existed. That is the whole of
    /// the backward compatibility story: every GitHub token already in a vault
    /// is a plain string, stays a plain string, and is read back by
    /// [`Grant::parse`] as one.
    ///
    /// The envelope is JSON, and a token is never JSON: no host issues one
    /// starting with `{`, so the two forms are told apart by their first byte
    /// without a version marker or a second vault row.
    pub fn to_stored(&self) -> String {
        if !self.renewable() && self.expires_at.is_none() {
            return self.access.clone();
        }
        serde_json::to_string(&Envelope {
            access: self.access.clone(),
            refresh: self.refresh.clone(),
            expires_at: self.expires_at,
        })
        // The fields are three strings and a timestamp; there is no input that
        // fails here, and a grant we cannot store is worse than one stored
        // without its renewal.
        .unwrap_or_else(|_| self.access.clone())
    }

    /// Read back whatever is at the key, in either form.
    pub fn parse(stored: &str) -> Self {
        let trimmed = stored.trim();
        if trimmed.starts_with('{') {
            if let Ok(e) = serde_json::from_str::<Envelope>(trimmed) {
                return Self {
                    access: e.access,
                    refresh: e.refresh,
                    expires_at: e.expires_at,
                };
            }
        }
        Self::bare(stored)
    }

    /// Whether to renew before using it.
    ///
    /// A grant with no expiry is never stale: nothing known about it says it
    /// has stopped working, and renewing on a guess would spend a single-use
    /// refresh token for nothing.
    pub fn stale(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .is_some_and(|at| now + Duration::seconds(MARGIN) >= at)
    }
}

/// Why a renewal did not produce a token.
#[derive(Debug, thiserror::Error)]
pub enum RenewError {
    /// The host refused the refresh token. It is spent, revoked, or was issued
    /// by an application that no longer exists — and no amount of retrying
    /// changes that, so the answer is to authorize again.
    #[error("{0}")]
    Rejected(String),
    /// Could not ask. The grant we have is still the grant we have.
    #[error("{0}")]
    Unreachable(String),
}

/// Trade a refresh token for a fresh grant.
///
/// **The refresh token this returns is not the one that went in.** GitLab
/// rotates them: spending one revokes it and issues another, and presenting a
/// spent one gets `invalid_grant` — both checked against a running instance.
/// So the answer has to be stored whole, and two renewals of the same grant at
/// the same moment would leave one of them holding a revoked token. That is
/// what [`Renewals`] is for.
///
/// No client secret is sent, and none is needed: the application is registered
/// as public, which for this flow it has to be.
pub async fn renew(
    conn: &Connection,
    client_id: &str,
    refresh_token: &str,
) -> Result<Grant, RenewError> {
    let response = client()
        .map_err(|e| RenewError::Unreachable(format!("{e:#}")))?
        .post(conn.device_token_url())
        .header("accept", "application/json")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
        ])
        .send()
        .await
        .map_err(|e| RenewError::Unreachable(format!("couldn't reach {}: {e}", conn.label)))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if status.is_client_error() {
        return Err(RenewError::Rejected(format!(
            "{} would not renew the authorization — sign in to it again.",
            conn.label
        )));
    }
    if !status.is_success() {
        return Err(RenewError::Unreachable(format!(
            "{} couldn't renew the authorization: {status}",
            conn.label
        )));
    }

    read(&body).map_err(|e| RenewError::Unreachable(format!("{e:#}")))
}

/// A grant out of a token endpoint's answer.
///
/// Shared with the device flow's final poll, which returns the same body.
pub(super) fn read(body: &str) -> Result<Grant> {
    #[derive(Deserialize)]
    struct Response {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: Option<i64>,
    }

    let r: Response = serde_json::from_str(body).context("reading the token the host sent back")?;
    Ok(Grant {
        access: r.access_token,
        refresh: r.refresh_token.filter(|s| !s.trim().is_empty()),
        // Relative, because that is what the host sends and it is the only
        // form that survives a clock the two ends disagree about.
        expires_at: r.expires_in.map(|s| Utc::now() + Duration::seconds(s)),
    })
}

/// One renewal at a time, per person per host.
///
/// Needed because a refresh token is single-use. Two requests that both find
/// the grant stale would both spend it, and the loser would be left holding a
/// token the host has already revoked — which looks exactly like being signed
/// out, for no reason anybody could see.
///
/// Holding the lock is not enough on its own: whoever waited has to re-read the
/// vault afterwards rather than renewing the grant it arrived with. The caller
/// does that — see `api::git_token`.
#[derive(Clone, Default)]
pub struct Renewals(
    std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, Gate>>>,
);

type Gate = std::sync::Arc<tokio::sync::Mutex<()>>;

impl Renewals {
    /// The queue for one key, joined.
    pub async fn at(&self, key: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let gate = {
            let mut held = self.0.lock().await;
            // Kept rather than dropped when nobody is waiting: there is one
            // entry per person per host, which is bounded by the number of
            // people, and an entry freed between the lookup and the lock is
            // how two callers end up on two different gates.
            held.entry(key.to_string()).or_default().clone()
        };
        gate.lock_owned().await
    }
}

impl std::fmt::Debug for Renewals {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Renewals")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The one that matters for everybody already running Firetower: a GitHub
    /// token stored as a plain string before any of this existed has to read
    /// back as itself, and write back as itself.
    #[test]
    fn a_token_stored_before_grants_existed_is_read_as_one() {
        let g = Grant::parse("gho_16C7e42F292c6912E7710c838347Ae178B4a");
        assert_eq!(g.access, "gho_16C7e42F292c6912E7710c838347Ae178B4a");
        assert!(g.refresh.is_none());
        assert!(g.expires_at.is_none());
        // And nothing about reading it turns it into an envelope.
        assert_eq!(g.to_stored(), "gho_16C7e42F292c6912E7710c838347Ae178B4a");
    }

    /// A pasted personal access token takes the same path — which is why the
    /// vault holds a readable secret for every host that connects that way.
    #[test]
    fn a_pasted_token_is_stored_bare() {
        assert_eq!(Grant::bare("glpat-xxx").to_stored(), "glpat-xxx");
    }

    #[test]
    fn a_renewable_grant_survives_the_round_trip() {
        let at = Utc::now() + Duration::hours(2);
        let g = Grant {
            access: "a".into(),
            refresh: Some("r".into()),
            expires_at: Some(at),
        };
        let back = Grant::parse(&g.to_stored());
        assert_eq!(back.access, "a");
        assert_eq!(back.refresh.as_deref(), Some("r"));
        assert_eq!(back.expires_at.map(|t| t.timestamp()), Some(at.timestamp()));
    }

    /// Half an envelope — hand-edited in the vault screen, or written by a
    /// version that kept a field this one does not — is still a token, and a
    /// host that refuses it says so better than a parse error here would.
    #[test]
    fn something_that_is_not_an_envelope_is_treated_as_the_token_it_might_be() {
        let g = Grant::parse("{not json");
        assert_eq!(g.access, "{not json");
    }

    #[test]
    fn a_token_with_no_stated_end_is_never_renewed_on_a_guess() {
        // The GitHub case. Renewing would spend nothing, because there is
        // nothing to spend — and it would do it on every request.
        assert!(!Grant::bare("gho_x").stale(Utc::now()));
    }

    /// The GitLab case, and the bug this file exists to fix: two hours after
    /// somebody connects, the token they were given is no longer any good.
    #[test]
    fn a_token_is_renewed_before_it_lapses_rather_than_after() {
        let now = Utc::now();
        let fresh = Grant {
            access: "a".into(),
            refresh: Some("r".into()),
            expires_at: Some(now + Duration::hours(2)),
        };
        assert!(!fresh.stale(now));

        // Inside the margin. Still valid, and valid is not long enough: the
        // request it would be chosen for outlives it.
        let nearly = Grant {
            expires_at: Some(now + Duration::seconds(MARGIN / 2)),
            ..fresh.clone()
        };
        assert!(nearly.stale(now), "a token that expires mid-request is spent");

        let gone = Grant {
            expires_at: Some(now - Duration::minutes(1)),
            ..fresh
        };
        assert!(gone.stale(now));
    }

    /// GitLab's answer, as a running 18.0 actually sends it.
    #[test]
    fn gitlabs_token_response_is_read_whole() {
        let g = read(
            r#"{"access_token":"5f58…","token_type":"Bearer","expires_in":7200,
                "refresh_token":"b40d…","scope":"api write_repository",
                "created_at":1792167294}"#,
        )
        .unwrap();
        assert_eq!(g.access, "5f58…");
        assert_eq!(g.refresh.as_deref(), Some("b40d…"));
        assert!(g.renewable());
        // Two hours, give or take the moment this ran.
        let left = (g.expires_at.unwrap() - Utc::now()).num_seconds();
        assert!((7100..=7200).contains(&left), "{left}");
    }

    /// GitHub's, which carries neither field — and must not be read as a grant
    /// that expires immediately.
    #[test]
    fn githubs_token_response_has_no_expiry_and_is_not_given_one() {
        let g = read(r#"{"access_token":"gho_x","token_type":"bearer","scope":"repo,workflow"}"#)
            .unwrap();
        assert_eq!(g.access, "gho_x");
        assert!(g.expires_at.is_none());
        assert!(!g.renewable());
        assert!(!g.stale(Utc::now()));
    }

    /// The vault holds one string per key, and a grant has to survive it in
    /// both shapes — which is the thing a round-trip in memory cannot prove.
    #[tokio::test]
    async fn both_shapes_survive_the_vault() {
        use crate::vault::{Key, Vault, GIT};
        let db = crate::db::Db::open_for_test().await.unwrap();
        let vault = Vault::new(db.pool().clone(), crate::vault::crypto::RootKey::generate());

        // What every existing installation has: a plain GitHub token, written
        // by a Firetower that had never heard of a grant.
        vault
            .put(Key::of(GIT, "github", "u_ana"), "gho_plain", "as it was")
            .await
            .unwrap();
        let read = Grant::parse(
            &vault
                .get(Key::of(GIT, "github", "u_ana"), "reading it back")
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(read.access, "gho_plain");
        assert!(!read.renewable());
        assert!(!read.stale(Utc::now()));

        // And what GitLab makes us keep.
        let gitlab = Grant {
            access: "glo_access".into(),
            refresh: Some("glo_refresh".into()),
            expires_at: Some(Utc::now() + Duration::hours(2)),
        };
        vault
            .put(
                Key::of(GIT, "gitlab", "u_ana"),
                &gitlab.to_stored(),
                "authorized in a browser",
            )
            .await
            .unwrap();
        let read = Grant::parse(
            &vault
                .get(Key::of(GIT, "gitlab", "u_ana"), "reading it back")
                .await
                .unwrap()
                .unwrap(),
        );
        assert_eq!(read.access, "glo_access");
        assert_eq!(read.refresh.as_deref(), Some("glo_refresh"));
        assert!(!read.stale(Utc::now()), "two hours is not stale yet");

        // The same row once the two hours are up, which is the state the
        // renewal exists for.
        let lapsed = Grant {
            expires_at: Some(Utc::now() - Duration::minutes(1)),
            ..read
        };
        vault
            .put(
                Key::of(GIT, "gitlab", "u_ana"),
                &lapsed.to_stored(),
                "two hours later",
            )
            .await
            .unwrap();
        let read = Grant::parse(
            &vault
                .get(Key::of(GIT, "gitlab", "u_ana"), "reading it back")
                .await
                .unwrap()
                .unwrap(),
        );
        assert!(read.stale(Utc::now()));
        assert!(read.renewable(), "and there is something to renew it with");
    }

    /// Two callers on the same key are serialized; two on different keys are
    /// not, because one person's renewal must not block another's request.
    #[tokio::test]
    async fn renewals_queue_per_key_and_not_across_them() {
        let renewals = Renewals::default();
        let held = renewals.at("gitlab:ana").await;

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), renewals.at("gitlab:ana"))
                .await
                .is_err(),
            "the same key has to wait"
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), renewals.at("gitlab:bob"))
                .await
                .is_ok(),
            "another person's is a different queue"
        );

        drop(held);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), renewals.at("gitlab:ana"))
                .await
                .is_ok(),
            "and it is released when the renewal finishes"
        );
    }
}
