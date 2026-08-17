//! Who is allowed in.
//!
//! Until this existed, the only thing protecting every credential Firetower
//! holds was that it listened on loopback. That is a real defence on a laptop
//! and no defence at all on a server, so there are two ways to satisfy this and
//! the deployment picks one:
//!
//! 1. **A token.** One shared secret, generated on first start if nobody
//!    supplied one, kept at `~/.firetower/token` the way the root key is kept.
//!    The command line prints a URL carrying it, so the first visit costs no
//!    typing. This is the single-operator case, which is most of them.
//! 2. **A header a proxy sets.** `FIRETOWER_TRUSTED_PROXY_HEADER=X-Forwarded-Email`
//!    hands identity to whatever is already in front — Cloudflare Access,
//!    Authelia, oauth2-proxy, Caddy's `forward_auth`. Firetower does not learn
//!    to speak OIDC; it learns to believe something that already does.
//!
//! Both produce a [`Principal`] rather than a yes. A header that says *who*
//! is worth more than a token that says *someone*, and the difference has to
//! survive the middleware or it may as well not have been asked for.
//!
//! **The trap this file exists to avoid.** A trusted header is only worth the
//! network in front of it. If a request can reach Firetower without passing the
//! proxy, anyone can set that header and be anyone — so it is believed only
//! from an address in `FIRETOWER_TRUSTED_PROXY`, and configuring the header
//! without that list stops start-up rather than quietly trusting the internet.

use anyhow::{bail, Context, Result};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderName, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// A token supplied rather than generated. For containers, and anything with a
/// secret manager in front of it.
pub const TOKEN_ENV: &str = "FIRETOWER_TOKEN";

/// Set to `none` to serve with no authentication at all. Only honoured on
/// loopback, or behind a proxy that authenticates instead.
pub const MODE_ENV: &str = "FIRETOWER_AUTH";

/// The header a trusted proxy sets to say who the request is from.
pub const HEADER_ENV: &str = "FIRETOWER_TRUSTED_PROXY_HEADER";

/// Which addresses that header is believed from. Addresses or CIDR blocks,
/// comma separated.
pub const UPSTREAM_ENV: &str = "FIRETOWER_TRUSTED_PROXY";

const FILE: &str = "token";

/// Where the token came from, so start-up can say so without saying what it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Environment,
    File(PathBuf),
    /// Made just now — the one case where the log should print the URL.
    NewFile(PathBuf),
    /// Nobody is being asked for anything.
    Disabled,
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Environment => write!(f, "{TOKEN_ENV}"),
            Self::File(p) | Self::NewFile(p) => write!(f, "{}", p.display()),
            Self::Disabled => write!(f, "disabled"),
        }
    }
}

/// Who made a request, once something has vouched for them.
///
/// Deliberately not a boolean. Self-hosting has one operator and could get away
/// with one, but the moment a proxy supplies an email address, throwing it away
/// at the door means every later question about *who* has no answer to reach
/// for.
#[derive(Debug, Clone)]
pub struct Principal {
    /// A name for the log and, later, for an audit trail. `"operator"` for the
    /// shared token; whatever the proxy said otherwise.
    pub subject: Arc<str>,
    pub via: Via,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Token,
    Proxy,
    /// Authentication is off. Recorded rather than represented by an absent
    /// principal, so handlers never have to care which it was.
    Open,
}

/// What the deployment will accept.
#[derive(Clone)]
pub struct Policy {
    /// `None` when authentication is off.
    token: Option<Arc<str>>,
    header: Option<HeaderName>,
    upstreams: Arc<[Cidr]>,
}

impl Policy {
    /// Nothing is asked of anybody. Only reachable by asking for it.
    pub fn open() -> Self {
        Self {
            token: None,
            header: None,
            upstreams: Arc::from(Vec::new()),
        }
    }

    /// Whether anything at all stands in front of the API.
    ///
    /// The one question start-up asks before binding an address the rest of the
    /// world can reach.
    pub fn is_open(&self) -> bool {
        self.token.is_none() && self.header.is_none()
    }

    /// The token, for the one line at start-up that puts it in a URL.
    ///
    /// The only way out of this module, and it exists because a token nobody
    /// can find is a locked door with the key in another building. Callers are
    /// expected to use it once, on the first start, and never log it again.
    pub fn url_token(&self) -> Option<&str> {
        self.token.as_deref()
    }

    /// In words, for the log line at start-up.
    pub fn describe(&self) -> String {
        match (&self.token, &self.header) {
            (Some(_), Some(h)) => format!("a token, or {} from a trusted proxy", h.as_str()),
            (Some(_), None) => "a token".to_string(),
            (None, Some(h)) => format!("{} from a trusted proxy", h.as_str()),
            (None, None) => "nothing — anyone who can reach the port is in".to_string(),
        }
    }

    /// Decide who this is, if anyone.
    fn admit(&self, headers: &HeaderMap, query: Option<&str>, peer: IpAddr) -> Option<Principal> {
        if self.is_open() {
            return Some(Principal {
                subject: "anyone".into(),
                via: Via::Open,
            });
        }

        // The proxy first: it knows a name, and the token only knows that
        // somebody had it.
        if let Some(name) = &self.header {
            if self.upstreams.iter().any(|c| c.contains(peer)) {
                if let Some(who) = headers.get(name).and_then(|v| v.to_str().ok()) {
                    let who = who.trim();
                    if !who.is_empty() {
                        return Some(Principal {
                            subject: who.into(),
                            via: Via::Proxy,
                        });
                    }
                }
            }
        }

        let expected = self.token.as_ref()?;

        if let Some(offered) = bearer(headers) {
            if constant_time_eq(offered.as_bytes(), expected.as_bytes()) {
                return Some(Principal {
                    subject: "operator".into(),
                    via: Via::Token,
                });
            }
        }

        // A browser cannot set a header on a websocket handshake, so the
        // terminal has nowhere to put the token but the query string. Accepted
        // only there: a query string is copied into access logs and browser
        // history, which is exactly what a credential should not be in.
        if is_upgrade(headers) {
            if let Some(offered) = query_token(query) {
                if constant_time_eq(offered.as_bytes(), expected.as_bytes()) {
                    return Some(Principal {
                        subject: "operator".into(),
                        via: Via::Token,
                    });
                }
            }
        }

        None
    }
}

/// Read the policy from the environment, making a token if that is what's left.
///
/// Mirrors [`crate::vault::root::load`] on purpose: an operator who has met one
/// of them already knows how the other behaves.
pub async fn load(home: &Path) -> Result<(Policy, Source)> {
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

    if disabled {
        return Ok((
            Policy {
                token: None,
                header,
                upstreams: Arc::from(upstreams),
            },
            Source::Disabled,
        ));
    }

    if let Ok(text) = std::env::var(TOKEN_ENV) {
        let text = text.trim();
        if !text.is_empty() {
            return Ok((
                Policy {
                    token: Some(text.into()),
                    header,
                    upstreams: Arc::from(upstreams),
                },
                Source::Environment,
            ));
        }
    }

    let path = home.join(FILE);
    let (token, source) = match tokio::fs::read_to_string(&path).await {
        Ok(text) if !text.trim().is_empty() => {
            tighten(&path).await?;
            (text.trim().to_string(), Source::File(path))
        }
        Ok(_) => {
            // An empty file is a half-finished first start, not a decision.
            let fresh = mint();
            write_new(&path, &fresh).await?;
            (fresh, Source::NewFile(path))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let fresh = mint();
            write_new(&path, &fresh).await?;
            (fresh, Source::NewFile(path))
        }
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };

    Ok((
        Policy {
            token: Some(token.into()),
            header,
            upstreams: Arc::from(upstreams),
        },
        source,
    ))
}

/// 32 bytes of randomness, in the alphabet that survives a URL.
///
/// The same source the vault's keys come from — there is no second-tier
/// randomness here for the thing that guards all of it.
fn mint() -> String {
    use chacha20poly1305::aead::{AeadCore, OsRng};
    use chacha20poly1305::XChaCha20Poly1305;

    // Two nonces rather than a key: 48 bytes of the same OS randomness, and
    // nothing that could ever be mistaken for something that decrypts.
    let a = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let b = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut bytes = Vec::with_capacity(48);
    bytes.extend_from_slice(&a);
    bytes.extend_from_slice(&b);

    // Base64 with `+` and `/` in it would need escaping in the URL the log
    // prints, and a token that has to be escaped gets copied wrong.
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    bytes
        .iter()
        .take(40)
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

async fn write_new(path: &Path, token: &str) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("creating {}", parent.display()))?;

    // Restricted before there is anything in it, for the same reason the root
    // key is: the gap between writing and narrowing is a window.
    let temp = path.with_extension("token.new");
    restrict(&temp).await?;
    tokio::fs::write(&temp, format!("{token}\n"))
        .await
        .with_context(|| format!("writing {}", temp.display()))?;
    tokio::fs::rename(&temp, path)
        .await
        .with_context(|| format!("moving the new token into {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
async fn restrict(path: &Path) -> Result<()> {
    use tokio::fs::OpenOptions;
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .await
        .with_context(|| format!("creating {}", path.display()))?;
    Ok(())
}

#[cfg(unix)]
async fn tighten(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = tokio::fs::metadata(path).await?.permissions().mode() & 0o777;
    if mode != 0o600 {
        tracing::warn!(
            path = %path.display(),
            "the token was readable beyond this account (mode {mode:o}); tightening it"
        );
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .with_context(|| format!("restricting {}", path.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
async fn restrict(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
async fn tighten(_path: &Path) -> Result<()> {
    Ok(())
}

/// The gate itself.
pub async fn require(State(policy): State<Policy>, mut request: Request, next: Next) -> Response {
    // Read out of the extensions rather than extracted, so a request that
    // arrived without connection information is a stricter check instead of a
    // 500. Nobody asks for one only in tests — and there, an address that
    // matches no trusted block is the safe stand-in: the token still works,
    // the header is not believed.
    let address = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ConnectInfo(a)| a.ip())
        .unwrap_or(IpAddr::from([0, 0, 0, 0]));

    let query = request.uri().query().map(str::to_owned);

    match policy.admit(request.headers(), query.as_deref(), address) {
        Some(principal) => {
            // Handlers do not read this yet. It is here because the alternative
            // — deciding who someone is and throwing it away — is the thing
            // that makes an audit trail impossible to add later.
            request.extensions_mut().insert(principal);
            next.run(request).await
        }
        None => {
            tracing::debug!(%address, path = %request.uri().path(), "refused");
            (
                StatusCode::UNAUTHORIZED,
                Json(crate::api::ApiError::new(
                    crate::api::ErrorCode::Unauthorized,
                    "this Firetower needs a token. It was printed when the server started; \
                     open the URL from that line, or set the token in the interface.",
                )),
            )
                .into_response()
        }
    }
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, rest) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| rest.trim())
        .filter(|s| !s.is_empty())
}

/// `t` rather than `token`: it is what the web application already sends, and
/// the terminal is the only thing that sends it.
fn query_token(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == "t")
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty())
}

fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// Compare without letting the clock say how much of it matched.
///
/// A `==` on the token would return at the first differing byte, which over
/// enough attempts is how someone guesses one byte at a time. The cost of not
/// doing that is this function.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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

    fn policy_with_token(token: &str) -> Policy {
        Policy {
            token: Some(token.into()),
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

    #[test]
    fn the_right_token_gets_in_and_the_wrong_one_does_not() {
        let policy = policy_with_token("secret");

        assert!(policy
            .admit(&headers(&[("authorization", "Bearer secret")]), None, SOMEWHERE)
            .is_some());
        assert!(policy
            .admit(&headers(&[("authorization", "Bearer secrer")]), None, SOMEWHERE)
            .is_none());
        assert!(policy.admit(&HeaderMap::new(), None, SOMEWHERE).is_none());
    }

    #[test]
    fn the_scheme_is_read_loosely_because_clients_disagree_about_case() {
        let policy = policy_with_token("secret");
        assert!(policy
            .admit(&headers(&[("authorization", "bearer secret")]), None, SOMEWHERE)
            .is_some());
    }

    /// The terminal's only option, and deliberately its only option.
    #[test]
    fn a_query_token_works_for_a_websocket_and_nowhere_else() {
        let policy = policy_with_token("secret");

        assert!(
            policy
                .admit(
                    &headers(&[("upgrade", "websocket")]),
                    Some("cols=80&t=secret"),
                    SOMEWHERE
                )
                .is_some(),
            "a browser cannot put a header on a handshake"
        );

        assert!(
            policy
                .admit(&HeaderMap::new(), Some("t=secret"), SOMEWHERE)
                .is_none(),
            "an ordinary request must not carry its credential where logs keep it"
        );
    }

    #[test]
    fn a_proxy_header_is_believed_only_from_the_proxy() {
        let policy = Policy {
            token: None,
            header: Some(HeaderName::from_static("x-forwarded-email")),
            upstreams: Arc::from(vec![Cidr::parse("172.16.0.0/12").unwrap()]),
        };

        let claim = headers(&[("x-forwarded-email", "kevin@example.com")]);

        let principal = policy
            .admit(&claim, None, "172.18.0.5".parse().unwrap())
            .expect("the proxy is inside the trusted block");
        assert_eq!(&*principal.subject, "kevin@example.com");
        assert_eq!(principal.via, Via::Proxy);

        assert!(
            policy.admit(&claim, None, SOMEWHERE).is_none(),
            "the same header from anywhere else is a forgery"
        );
    }

    #[test]
    fn a_principal_says_who_rather_than_yes() {
        let policy = policy_with_token("secret");
        let principal = policy
            .admit(&headers(&[("authorization", "Bearer secret")]), None, SOMEWHERE)
            .unwrap();
        assert_eq!(principal.via, Via::Token);
        assert_eq!(&*principal.subject, "operator");
    }

    #[test]
    fn an_open_policy_admits_everyone_and_says_so() {
        let policy = Policy::open();
        assert!(policy.is_open());
        let principal = policy.admit(&HeaderMap::new(), None, SOMEWHERE).unwrap();
        assert_eq!(principal.via, Via::Open);
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

    #[test]
    fn a_minted_token_is_long_and_url_safe() {
        let token = mint();
        assert_eq!(token.len(), 40);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(token, mint(), "two starts must not produce the same token");
    }

    #[test]
    fn comparing_is_length_safe() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"a"));
    }
}
