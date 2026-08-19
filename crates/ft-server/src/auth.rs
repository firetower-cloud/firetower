//! Who is allowed in.
//!
//! Until accounts existed, the only thing protecting every credential Firetower
//! holds was that it listened on loopback. That is a defence on a laptop and
//! none at all on a server.
//!
//! Two ways to satisfy this, and a deployment picks one:
//!
//! 1. **Signing in.** A username and password produce a session, and the
//!    session's token is what every later request carries. This is the normal
//!    path and the one the interface uses.
//! 2. **A header a proxy sets.** `FIRETOWER_TRUSTED_PROXY_HEADER=X-Forwarded-Email`
//!    hands identity to whatever is already in front — Cloudflare Access,
//!    Authelia, oauth2-proxy, Caddy's `forward_auth`. Firetower does not learn
//!    to speak OIDC; it learns to believe something that already does. The
//!    header still has to name somebody who exists here.
//!
//! Both produce a [`Principal`] carrying the **user**, not a yes. A password
//! that only answered "somebody" would make every later question about who did
//! what unanswerable.
//!
//! **The trap this file exists to avoid.** A trusted header is only worth the
//! network in front of it. If a request can reach Firetower without passing the
//! proxy, anyone can set that header and be anyone — so it is believed only
//! from an address in `FIRETOWER_TRUSTED_PROXY`, and configuring the header
//! without that list stops start-up rather than quietly trusting the internet.

use crate::accounts::{Accounts, User};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderName},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

/// Set to `none` to serve with no authentication at all. Only honoured on
/// loopback, or behind a proxy that authenticates instead.
pub const MODE_ENV: &str = "FIRETOWER_AUTH";

/// The header a trusted proxy sets to say who the request is from.
pub const HEADER_ENV: &str = "FIRETOWER_TRUSTED_PROXY_HEADER";

/// Which addresses that header is believed from. Addresses or CIDR blocks,
/// comma separated.
pub const UPSTREAM_ENV: &str = "FIRETOWER_TRUSTED_PROXY";

/// Who made a request, once something has vouched for them.
///
/// Deliberately not a boolean. One administrator could get away with one, but
/// the moment a second person exists — or a proxy supplies a name — throwing it
/// away at the door means every later question about *who* has no answer to
/// reach for.
#[derive(Debug, Clone)]
pub struct Principal {
    /// A name for the log and, later, for an audit trail.
    pub subject: Arc<str>,
    pub via: Via,
    /// Absent only when authentication is off.
    pub user: Option<User>,
}

impl Principal {
    /// Whether this request may do anything beyond replacing its password.
    ///
    /// An administrator whose password came out of a file is signed in and
    /// almost entirely unable to act: the credential is in a file on disk, and
    /// treating that as a working login would make the file the real
    /// credential.
    pub fn must_change_password(&self) -> bool {
        self.user
            .as_ref()
            .map(|u| u.must_change_password)
            .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// Signed in with a password.
    Session,
    /// Named by a proxy we believe.
    Proxy,
    /// Authentication is off. Recorded rather than represented by an absent
    /// principal, so handlers never have to care which it was.
    Open,
}

/// What the deployment will accept.
#[derive(Clone)]
pub struct Policy {
    /// True when `FIRETOWER_AUTH=none`. Sessions are then not consulted.
    disabled: bool,
    header: Option<HeaderName>,
    upstreams: Arc<[Cidr]>,
}

impl Policy {
    /// Nothing is asked of anybody. Only reachable by asking for it.
    pub fn open() -> Self {
        Self {
            disabled: true,
            header: None,
            upstreams: Arc::from(Vec::new()),
        }
    }

    /// Whether anything at all stands in front of the API.
    ///
    /// The one question start-up asks before binding an address the rest of the
    /// world can reach.
    pub fn is_open(&self) -> bool {
        self.disabled && self.header.is_none()
    }

    /// In words, for the log line at start-up.
    pub fn describe(&self) -> String {
        match (self.disabled, &self.header) {
            (false, Some(h)) => format!("signing in, or {} from a trusted proxy", h.as_str()),
            (false, None) => "signing in".to_string(),
            (true, Some(h)) => format!("{} from a trusted proxy", h.as_str()),
            (true, None) => "nothing — anyone who can reach the port is in".to_string(),
        }
    }
}

/// Read the policy from the environment.
pub fn load() -> Result<Policy> {
    let header = match std::env::var(HEADER_ENV) {
        Ok(name) if !name.trim().is_empty() => Some(
            HeaderName::try_from(name.trim().to_ascii_lowercase())
                .with_context(|| format!("{HEADER_ENV} is not a valid header name"))?,
        ),
        _ => None,
    };

    let upstreams: Vec<Cidr> = match std::env::var(UPSTREAM_ENV) {
        Ok(list) if !list.trim().is_empty() => list
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(Cidr::parse)
            .collect::<Result<_>>()
            .with_context(|| format!("reading {UPSTREAM_ENV}"))?,
        _ => Vec::new(),
    };

    // Fail closed. A header configured with nothing to believe it from is a
    // deployment that thinks it is authenticated and is not — and it would work
    // perfectly in testing, because the tester also sets the header.
    if header.is_some() && upstreams.is_empty() {
        bail!(
            "{HEADER_ENV} is set but {UPSTREAM_ENV} is empty, so anything able to reach this \
             port could set that header and be anyone. Name the proxy: {UPSTREAM_ENV}=172.16.0.0/12 \
             for a container network, or the proxy's address."
        );
    }

    let disabled = matches!(
        std::env::var(MODE_ENV).map(|v| v.trim().to_ascii_lowercase()),
        Ok(ref v) if v == "none" || v == "off" || v == "disabled"
    );

    Ok(Policy {
        disabled,
        header,
        upstreams: Arc::from(upstreams),
    })
}

/// What the gate needs: the rules, and somewhere to look people up.
#[derive(Clone)]
pub struct Gate {
    pub policy: Policy,
    pub accounts: Accounts,
}

/// The gate itself.
pub async fn require(State(gate): State<Gate>, mut request: Request, next: Next) -> Response {
    // Read out of the extensions rather than extracted, so a request that
    // arrived without connection information is a stricter check instead of a
    // 500. Nobody asks for one only in tests — and there, an address that
    // matches no trusted block is the safe stand-in.
    let address = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(a)| a.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));

    // Signing in cannot require being signed in. This is the only hole in the
    // gate, it is one exact path, and what is behind it checks a password.
    if request.uri().path() == "/api/v1/auth/login" {
        return next.run(request).await;
    }

    let query = request.uri().query().map(str::to_owned);

    let principal = match admit(&gate, request.headers(), query.as_deref(), address).await {
        Ok(Some(principal)) => principal,
        Ok(None) => {
            tracing::debug!(%address, path = %request.uri().path(), "refused");
            return refusal(
                crate::api::ErrorCode::Unauthorized,
                "sign in to use this Firetower",
            );
        }
        Err(e) => {
            tracing::error!("could not check who this is: {e:#}");
            return refusal(
                crate::api::ErrorCode::Internal,
                "could not check the session",
            );
        }
    };

    // Signed in, and allowed to do exactly one thing.
    if principal.must_change_password() && !permitted_while_locked(&request) {
        return refusal(
            crate::api::ErrorCode::PasswordChangeRequired,
            "this password came from a file and has to be replaced before anything else",
        );
    }

    // Handlers read this to know who they are acting for. It is inserted even
    // where nothing reads it yet, because deciding who someone is and throwing
    // it away is what makes an audit trail impossible to add later.
    request.extensions_mut().insert(principal);
    next.run(request).await
}

/// What an account with a file-supplied password may still reach.
///
/// Replacing the password, leaving, and the two reads the screen that does it
/// is built from. Anything else would be acting on a credential that is sitting
/// in a file on the server.
fn permitted_while_locked(request: &Request) -> bool {
    matches!(
        request.uri().path(),
        "/api/v1/auth/password" | "/api/v1/auth/logout" | "/api/v1/auth/me" | "/api/v1/setup"
    )
}

fn refusal(code: crate::api::ErrorCode, message: &str) -> Response {
    let error = crate::api::ApiError::new(code, message);
    (code.status(), Json(error)).into_response()
}

/// Decide who this is, if anyone.
async fn admit(
    gate: &Gate,
    headers: &HeaderMap,
    query: Option<&str>,
    peer: IpAddr,
) -> Result<Option<Principal>> {
    // The proxy first: it knows a name, and a session only knows that whoever
    // holds the token signed in at some point.
    if let Some(name) = &gate.policy.header {
        if gate.policy.upstreams.iter().any(|c| c.contains(peer)) {
            if let Some(who) = headers.get(name).and_then(|v| v.to_str().ok()) {
                let who = who.trim();
                if !who.is_empty() {
                    // The header names somebody. They still have to be
                    // somebody here — otherwise a misconfigured proxy admits
                    // strangers as themselves.
                    return Ok(gate
                        .accounts
                        .user_by_name(who)
                        .await?
                        .map(|user| Principal {
                            subject: user.username.clone().into(),
                            via: Via::Proxy,
                            user: Some(user),
                        }));
                }
            }
        }
    }

    if gate.policy.disabled {
        return Ok(Some(Principal {
            subject: "anyone".into(),
            via: Via::Open,
            user: None,
        }));
    }

    let Some(token) = offered_token(headers, query) else {
        return Ok(None);
    };

    Ok(gate
        .accounts
        .session_user(&token)
        .await?
        .map(|user| Principal {
            subject: user.username.clone().into(),
            via: Via::Session,
            user: Some(user),
        }))
}

/// The session token, from wherever it can be.
fn offered_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some((scheme, rest)) = value.split_once(' ') {
            if scheme.eq_ignore_ascii_case("bearer") && !rest.trim().is_empty() {
                return Some(rest.trim().to_string());
            }
        }
    }

    // Two browser APIs cannot set a header — `WebSocket` and `EventSource` —
    // and both are load-bearing here: the terminal and the live event stream.
    // For those the token has nowhere to go but the query string.
    //
    // Still refused everywhere else, which is what this restriction is for: a
    // query string is copied into access logs and browser history, and a
    // credential should not be in either.
    //
    // This was websocket-only at first, which silently broke every live update
    // in the interface — the stream was refused, EventSource retried forever,
    // and nothing moved until somebody reloaded the page.
    if cannot_set_a_header(headers) {
        return query?
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| *k == "t")
            .map(|(_, v)| v.to_string())
            .filter(|v| !v.is_empty());
    }

    None
}

/// Whether this request comes from a browser API that has no way to send one.
fn cannot_set_a_header(headers: &HeaderMap) -> bool {
    let upgrading = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));

    // `EventSource` asks for exactly this, and nothing else does by accident.
    let streaming = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("text/event-stream"));

    upgrading || streaming
}

/// An address or a block of them.
///
/// Small enough to own rather than take a dependency for, and the only thing
/// asked of it is "is this address inside".
#[derive(Debug, Clone, Copy)]
pub struct Cidr {
    base: IpAddr,
    bits: u8,
}

impl Cidr {
    fn parse(text: &str) -> Result<Self> {
        let (address, bits) = match text.split_once('/') {
            Some((a, b)) => (
                a,
                Some(
                    b.parse::<u8>()
                        .with_context(|| format!("{text}: the part after / must be a number"))?,
                ),
            ),
            None => (text, None),
        };

        let base: IpAddr = address
            .parse()
            .with_context(|| format!("{text} is not an address"))?;

        let full = if base.is_ipv4() { 32 } else { 128 };
        let bits = bits.unwrap_or(full);
        if bits > full {
            bail!("{text}: /{bits} is wider than the address");
        }

        Ok(Self { base, bits })
    }

    fn contains(&self, address: IpAddr) -> bool {
        // A v4 address arriving on a dual-stack socket wears a v6 coat
        // (`::ffff:10.0.0.1`), and it has to be undressed or every v4 block
        // stops matching the moment the listener is `::`.
        let address = match address {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(address),
            other => other,
        };

        match (self.base, address) {
            (IpAddr::V4(base), IpAddr::V4(other)) => {
                prefix_matches(&base.octets(), &other.octets(), self.bits)
            }
            (IpAddr::V6(base), IpAddr::V6(other)) => {
                prefix_matches(&base.octets(), &other.octets(), self.bits)
            }
            _ => false,
        }
    }
}

fn prefix_matches(base: &[u8], other: &[u8], bits: u8) -> bool {
    let whole = (bits / 8) as usize;
    if base[..whole] != other[..whole] {
        return false;
    }
    let leftover = bits % 8;
    if leftover == 0 {
        return true;
    }
    let mask = 0xffu8 << (8 - leftover);
    base[whole] & mask == other[whole] & mask
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    async fn gate(policy: Policy) -> Gate {
        let db = Db::open_for_test().await.unwrap();
        Gate {
            policy,
            accounts: Accounts::new(db.pool().clone()),
        }
    }

    fn signing_in() -> Policy {
        Policy {
            disabled: false,
            header: None,
            upstreams: Arc::from(Vec::new()),
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(
                HeaderName::try_from(*k).unwrap(),
                v.parse().expect("a header value"),
            );
        }
        map
    }

    const SOMEWHERE: IpAddr = IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7));

    #[tokio::test]
    async fn a_session_token_gets_in_and_anything_else_does_not() {
        let gate = gate(signing_in()).await;
        let admin = gate
            .accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        let token = gate.accounts.open_session(&admin.id).await.unwrap();

        let bearer = format!("Bearer {token}");
        let who = admit(
            &gate,
            &headers(&[("authorization", &bearer)]),
            None,
            SOMEWHERE,
        )
        .await
        .unwrap()
        .expect("signed in");
        assert_eq!(&*who.subject, "kevin");
        assert_eq!(who.via, Via::Session);
        assert_eq!(who.user.unwrap().id, admin.id);

        assert!(admit(
            &gate,
            &headers(&[("authorization", "Bearer not-a-real-token")]),
            None,
            SOMEWHERE
        )
        .await
        .unwrap()
        .is_none());
        assert!(admit(&gate, &HeaderMap::new(), None, SOMEWHERE)
            .await
            .unwrap()
            .is_none());
    }

    /// The terminal's only option, and deliberately its only option.
    #[tokio::test]
    async fn a_query_token_works_for_a_websocket_and_nowhere_else() {
        let gate = gate(signing_in()).await;
        let admin = gate
            .accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        let token = gate.accounts.open_session(&admin.id).await.unwrap();
        let query = format!("cols=80&t={token}");

        assert!(
            admit(
                &gate,
                &headers(&[("upgrade", "websocket")]),
                Some(&query),
                SOMEWHERE
            )
            .await
            .unwrap()
            .is_some(),
            "a browser cannot put a header on a handshake"
        );

        assert!(
            admit(&gate, &HeaderMap::new(), Some(&query), SOMEWHERE)
                .await
                .unwrap()
                .is_none(),
            "an ordinary request must not carry its credential where logs keep it"
        );
    }

    /// The live event stream, which is the other thing in this interface that
    /// cannot send a header.
    ///
    /// This was websocket-only once, and the cost was that nothing in the
    /// interface ever updated by itself: the stream was refused, `EventSource`
    /// retried forever, and every screen showed whatever it had at page load.
    /// A reload hid it, because ordinary queries do send a header.
    #[tokio::test]
    async fn the_event_stream_may_carry_its_token_in_the_query_string() {
        let gate = gate(signing_in()).await;
        let admin = gate
            .accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        let token = gate.accounts.open_session(&admin.id).await.unwrap();
        let query = format!("t={token}");

        assert!(
            admit(
                &gate,
                &headers(&[("accept", "text/event-stream")]),
                Some(&query),
                SOMEWHERE
            )
            .await
            .unwrap()
            .is_some(),
            "EventSource cannot set a header, so this is the only way in"
        );

        // And everything else still has to.
        assert!(
            admit(
                &gate,
                &headers(&[("accept", "application/json")]),
                Some(&query),
                SOMEWHERE
            )
            .await
            .unwrap()
            .is_none(),
            "an ordinary request must not carry its credential where logs keep it"
        );
    }

    #[tokio::test]
    async fn a_proxy_header_is_believed_only_from_the_proxy_and_only_for_someone_real() {
        let policy = Policy {
            disabled: false,
            header: Some(HeaderName::from_static("x-forwarded-email")),
            upstreams: Arc::from(vec![Cidr::parse("172.16.0.0/12").unwrap()]),
        };
        let gate = gate(policy).await;
        gate.accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();

        let claim = headers(&[("x-forwarded-email", "kevin")]);
        let inside: IpAddr = "172.18.0.5".parse().unwrap();

        let who = admit(&gate, &claim, None, inside)
            .await
            .unwrap()
            .expect("the proxy is inside the trusted block");
        assert_eq!(who.via, Via::Proxy);
        assert_eq!(&*who.subject, "kevin");

        assert!(
            admit(&gate, &claim, None, SOMEWHERE)
                .await
                .unwrap()
                .is_none(),
            "the same header from anywhere else is a forgery"
        );

        assert!(
            admit(
                &gate,
                &headers(&[("x-forwarded-email", "somebody-else")]),
                None,
                inside
            )
            .await
            .unwrap()
            .is_none(),
            "a header naming nobody here must not admit a stranger"
        );
    }

    #[tokio::test]
    async fn an_open_policy_admits_everyone_and_says_so() {
        let gate = gate(Policy::open()).await;
        assert!(gate.policy.is_open());
        let who = admit(&gate, &HeaderMap::new(), None, SOMEWHERE)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(who.via, Via::Open);
        assert!(who.user.is_none());
    }

    #[tokio::test]
    async fn a_password_from_a_file_is_signed_in_and_stuck() {
        let gate = gate(signing_in()).await;
        let admin = gate
            .accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        let token = gate.accounts.open_session(&admin.id).await.unwrap();

        let bearer = format!("Bearer {token}");
        let who = admit(
            &gate,
            &headers(&[("authorization", &bearer)]),
            None,
            SOMEWHERE,
        )
        .await
        .unwrap()
        .unwrap();

        assert!(who.must_change_password());
    }

    #[test]
    fn blocks_contain_what_they_should() {
        let block = Cidr::parse("172.16.0.0/12").unwrap();
        assert!(block.contains("172.16.0.1".parse().unwrap()));
        assert!(block.contains("172.31.255.254".parse().unwrap()));
        assert!(!block.contains("172.32.0.1".parse().unwrap()));
        assert!(!block.contains("10.0.0.1".parse().unwrap()));

        let one = Cidr::parse("10.1.2.3").unwrap();
        assert!(one.contains("10.1.2.3".parse().unwrap()));
        assert!(!one.contains("10.1.2.4".parse().unwrap()));
    }

    /// The failure that would otherwise arrive as "it works on my machine and
    /// not in the container", because the container's listener is dual-stack.
    #[test]
    fn a_v4_address_inside_a_v6_coat_still_matches_a_v4_block() {
        let block = Cidr::parse("172.16.0.0/12").unwrap();
        assert!(block.contains("::ffff:172.18.0.5".parse().unwrap()));
    }

    #[test]
    fn nonsense_blocks_are_refused_rather_than_ignored() {
        assert!(Cidr::parse("172.16.0.0/33").is_err());
        assert!(Cidr::parse("not an address").is_err());
        assert!(Cidr::parse("172.16.0.0/wide").is_err());
    }
}
