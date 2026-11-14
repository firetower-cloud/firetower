//! Getting a token out of a server that refused, the way the specification
//! says to.
//!
//! One scheme, and that is the good news: the MCP specification sanctions
//! **OAuth 2.1 and nothing else** for a remote server, declares authorization
//! OPTIONAL, and says nothing about API keys. So the chain below is the
//! complete answer for any conformant server rather than one case of several.
//!
//! ```text
//!  401  WWW-Authenticate: Bearer resource_metadata="…"
//!   ↓   RFC 9728   protected-resource metadata  → authorization_servers, scopes
//!   ↓   RFC 8414   authorization-server metadata → authorize, token, register
//!   ↓   RFC 7591   dynamic client registration   → a client_id, where there is
//!   ↓                                              no static one
//!   ↓   RFC 7636   PKCE, S256, every time
//!   ↓   RFC 8707   resource=<the server>, mandated by MCP wherever auth is used
//!  code → token
//! ```
//!
//! **Every document in that chain resolves unauthenticated.** That is what
//! makes the scopes screen possible: Canva publishes sixteen scopes and Slack
//! thirty, in their own words, to anyone who asks — so the list somebody reads
//! before the browser opens comes from the server a moment earlier and is never
//! a table in Firetower that somebody has to keep true.
//!
//! **What the two real servers do differently, and why it matters.** Canva
//! publishes a `registration_endpoint` and accepts `token_endpoint_auth_method:
//! none` — so Firetower registers itself, holds a `client_id` and no secret,
//! and the whole flow needs nothing configured. Slack publishes no registration
//! endpoint and only `client_secret_post`, so connecting it needs a Slack app
//! somebody made. Both are handled; only one of them works with nothing set up,
//! and the screens say which.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const USER_AGENT: &str = concat!("firetower/", env!("CARGO_PKG_VERSION"));
const PATIENCE: Duration = Duration::from_secs(10);

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(PATIENCE)
        .build()
        .context("building the http client")
}

/// RFC 9728, the document a `401` points at.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProtectedResource {
    /// The canonical identifier of the resource — **this is what goes in the
    /// `resource` parameter**, not the URL somebody typed. Canva's `/mcp`
    /// address names `https://mcp.canva.com/mcp`; Slack's names
    /// `https://mcp.slack.com`, without the path.
    #[serde(default)]
    pub resource: Option<String>,
    #[serde(default)]
    pub authorization_servers: Vec<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub bearer_methods_supported: Vec<String>,
}

/// RFC 8414, the authorization server's own description of itself.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthorizationServer {
    #[serde(default)]
    pub issuer: Option<String>,
    pub authorization_endpoint: Option<String>,
    pub token_endpoint: Option<String>,
    /// RFC 7591. Present on Canva, absent on Slack — which is the whole
    /// difference between a connector that needs nothing set up and one that
    /// needs somebody to register an application.
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    #[serde(default)]
    pub token_endpoint_auth_methods_supported: Vec<String>,
    #[serde(default)]
    pub grant_types_supported: Vec<String>,
}

impl AuthorizationServer {
    /// Whether it will take a client with no secret, which is the only kind
    /// Firetower can be: there is nowhere in a self-hosted control plane to
    /// put a secret that the person running it did not put there.
    ///
    /// An empty list means the RFC 6749 default, `client_secret_basic`, so an
    /// absent field is not a yes.
    pub fn takes_a_public_client(&self) -> bool {
        self.token_endpoint_auth_methods_supported
            .iter()
            .any(|m| m == "none")
    }

    /// PKCE with S256, which MCP requires. A server advertising only `plain`
    /// is one to refuse rather than to downgrade for.
    pub fn does_s256(&self) -> bool {
        // Absent is taken as yes: OAuth 2.1 requires S256 of every server, and
        // plenty of conformant ones do not list the field. A server that
        // advertises methods and omits S256 is the case this catches.
        self.code_challenge_methods_supported.is_empty()
            || self
                .code_challenge_methods_supported
                .iter()
                .any(|m| m == "S256")
    }
}

/// Fetch the protected-resource document a `401` pointed at.
///
/// The header's pointer is used when there is one. When there is not — it is
/// OPTIONAL in RFC 9728, even though every server checked sends it — the
/// well-known path is derived from the address, both ways round: the
/// specification puts the resource's path *after* the well-known segment, and
/// enough servers put it before that trying both is cheaper than being wrong.
pub async fn protected_resource(
    url: &reqwest::Url,
    challenge: Option<&super::mcp::Challenge>,
) -> Result<ProtectedResource> {
    let http = client()?;

    let mut candidates: Vec<String> = Vec::new();
    if let Some(pointer) = challenge.and_then(|c| c.resource_metadata.as_deref()) {
        candidates.push(pointer.to_string());
    }
    let base = origin(url);
    let path = url.path().trim_end_matches('/');
    if !path.is_empty() {
        candidates.push(format!("{base}/.well-known/oauth-protected-resource{path}"));
    }
    candidates.push(format!("{base}/.well-known/oauth-protected-resource"));

    let mut last = String::new();
    for candidate in candidates {
        match http.get(&candidate).send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<ProtectedResource>().await {
                    Ok(document) => return Ok(document),
                    Err(e) => {
                        last = format!(
                            "{candidate} answered something that is not RFC 9728 metadata: {e}"
                        )
                    }
                }
            }
            Ok(response) => last = format!("{candidate} answered {}", response.status()),
            Err(e) => last = format!("couldn't reach {candidate}: {e}"),
        }
    }
    bail!("{last}")
}

/// Fetch an authorization server's metadata.
///
/// Both well-known paths, because the two specifications disagree about where
/// it lives and real servers are split: RFC 8414 puts the issuer's path after
/// `/.well-known/oauth-authorization-server`, OpenID Connect Discovery puts
/// `/.well-known/openid-configuration` at the end. Slack and Canva both answer
/// the first with no path, which is the simple case and is tried first.
pub async fn authorization_server(issuer: &str) -> Result<AuthorizationServer> {
    let http = client()?;
    let url = reqwest::Url::parse(issuer)
        .with_context(|| format!("{issuer} is not an address an authorization server can be at"))?;
    let base = origin(&url);
    let path = url.path().trim_end_matches('/');

    let mut candidates = vec![format!("{base}/.well-known/oauth-authorization-server")];
    if !path.is_empty() {
        candidates.insert(
            0,
            format!("{base}/.well-known/oauth-authorization-server{path}"),
        );
        candidates.push(format!("{base}{path}/.well-known/openid-configuration"));
    }
    candidates.push(format!("{base}/.well-known/openid-configuration"));

    let mut last = String::new();
    for candidate in candidates {
        match http.get(&candidate).send().await {
            Ok(response) if response.status().is_success() => {
                match response.json::<AuthorizationServer>().await {
                    Ok(document) => return Ok(document),
                    Err(e) => {
                        last = format!(
                            "{candidate} answered something that is not RFC 8414 metadata: {e}"
                        )
                    }
                }
            }
            Ok(response) => last = format!("{candidate} answered {}", response.status()),
            Err(e) => last = format!("couldn't reach {candidate}: {e}"),
        }
    }
    bail!("{last}")
}

/// A client registered on the fly, because there was no static one.
#[derive(Debug, Clone, Deserialize)]
pub struct Registered {
    pub client_id: String,
    /// Present when the server insists on a confidential client. Firetower
    /// stores it in the vault under the install's own name rather than beside
    /// the connector row.
    #[serde(default)]
    pub client_secret: Option<String>,
}

/// RFC 7591: ask the authorization server for a client of our own.
///
/// Registered as **public** — `token_endpoint_auth_method: none` — because a
/// self-hosted control plane has nowhere to keep a secret that whoever runs it
/// did not put there, and PKCE is what replaces one. A server that answers with
/// a secret anyway is honoured rather than argued with.
///
/// Once per connector per installation, not once per person: the client
/// identifies *Firetower*, and the grant it is used to obtain is the person's.
pub async fn register(endpoint: &str, redirect_uri: &str, scopes: &[String]) -> Result<Registered> {
    let http = client()?;
    let body = serde_json::json!({
        "client_name": "Firetower",
        "client_uri": "https://usefiretower.com",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": scopes.join(" "),
    });
    let response = http
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("couldn't reach {endpoint}"))?;

    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!(
            "{endpoint} would not register an application: {status} {}",
            first_line(&text)
        );
    }
    serde_json::from_str(&text).with_context(|| {
        format!("{endpoint} answered something that is not an RFC 7591 registration")
    })
}

/// One PKCE pair: what goes to the browser, and what is kept back.
pub struct Pkce {
    /// Held by Firetower and sent only with the code. Never leaves the server.
    pub verifier: String,
    /// `S256(verifier)`, which is what the authorization request carries.
    pub challenge: String,
}

impl Pkce {
    pub fn fresh() -> Pkce {
        use sha2::{Digest, Sha256};
        // 32 bytes is 43 base64url characters, the length RFC 7636 recommends
        // and the maximum entropy it allows for.
        let verifier = base64url(&random(32));
        let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
        Pkce {
            verifier,
            challenge,
        }
    }
}

/// `state`, which is what ties a browser coming back to the person who left.
pub fn fresh_state() -> String {
    base64url(&random(24))
}

fn random(n: usize) -> Vec<u8> {
    use chacha20poly1305::aead::rand_core::RngCore;
    let mut bytes = vec![0u8; n];
    chacha20poly1305::aead::OsRng.fill_bytes(&mut bytes);
    bytes
}

/// base64url without padding — the only encoding RFC 7636 accepts.
///
/// Written out rather than taken as a dependency, like `ft_proto::base64` and
/// for the same reason: it is ten lines, and the standard-alphabet one next
/// door is the wrong alphabet here.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6 & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(n & 63) as usize] as char);
        }
    }
    out
}

/// Everything the browser leg needs, settled before the browser opens.
#[derive(Debug, Clone, Serialize)]
pub struct Opening {
    /// Where to send the person.
    pub authorize: String,
    /// What they are about to grant, in the server's own words, read live.
    pub scopes: Vec<String>,
    /// Which host will show the consent screen, so somebody can tell it is the
    /// right one.
    pub at: String,
}

/// Build the authorization URL.
///
/// **`resource` is not optional here.** MCP mandates RFC 8707 wherever
/// authorization is used, and a missing one works against a lenient
/// authorization server and fails against a strict one — which is the worst
/// kind of bug, because it is found by whoever connects the strict server
/// months later. It is the canonical identifier out of the resource metadata,
/// not the address somebody typed.
pub fn authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
    resource: &str,
    scopes: &[String],
) -> Result<String> {
    let mut url =
        reqwest::Url::parse(endpoint).with_context(|| format!("{endpoint} is not an address"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", client_id);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("state", state);
        query.append_pair("code_challenge", challenge);
        query.append_pair("code_challenge_method", "S256");
        // RFC 8707. See the note above — this is the mandated one.
        query.append_pair("resource", resource);
        if !scopes.is_empty() {
            query.append_pair("scope", &scopes.join(" "));
        }
    }
    Ok(url.to_string())
}

/// Trade the authorization code for a grant.
///
/// The verifier goes in the body and never anywhere else; `resource` is sent
/// again, as RFC 8707 requires at the token endpoint as well as at the
/// authorization endpoint. A client secret is sent only where the server
/// registered us as confidential.
pub async fn exchange(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
    resource: &str,
) -> Result<crate::oauth::Grant> {
    let http = client()?;
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", client_id),
        ("code_verifier", verifier),
        ("resource", resource),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }

    let response = http
        .post(token_endpoint)
        .header("accept", "application/json")
        .form(&form)
        .send()
        .await
        .with_context(|| format!("couldn't reach {token_endpoint}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!(
            "{} would not issue a token: {status} {}",
            host_of(token_endpoint),
            first_line(&body)
        );
    }
    // Slack's token endpoint answers 200 with `{"ok":false,"error":…}`, which
    // is its own convention rather than OAuth's. Caught here because an
    // envelope with no `access_token` in it would otherwise read as a parse
    // failure and send somebody looking at Firetower.
    if let Ok(envelope) = serde_json::from_str::<serde_json::Value>(&body) {
        if envelope.get("ok") == Some(&serde_json::Value::Bool(false)) {
            bail!(
                "{} refused the authorization: {}",
                host_of(token_endpoint),
                envelope
                    .get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or("it did not say why")
            );
        }
    }

    // The same reader the git hosts' flows use, so an expiry and a refresh
    // token mean the same thing here as they do there — and so a connector's
    // grant goes into the vault in the shape `oauth::grant` already stores.
    crate::oauth::read_token_response(&body)
}

/// Spend a refresh token for a fresh grant.
///
/// A connector's renewal is the same shape as a git host's, so the only thing
/// this adds over `oauth::renew` is where the endpoint comes from — a document
/// discovered at connect rather than a field on a provider — and `resource`,
/// which MCP mandates on this request too.
pub async fn renew(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    resource: &str,
) -> Result<crate::oauth::Grant> {
    let http = client()?;
    let mut form: Vec<(&str, &str)> = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("resource", resource),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let response = http
        .post(token_endpoint)
        .header("accept", "application/json")
        .form(&form)
        .send()
        .await
        .with_context(|| format!("couldn't reach {token_endpoint}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!(
            "{} would not renew the authorization — sign in to it again",
            host_of(token_endpoint)
        );
    }
    crate::oauth::read_token_response(&body)
}

fn origin(url: &reqwest::Url) -> String {
    let mut base = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        base.push_str(&format!(":{port}"));
    }
    base
}

fn host_of(endpoint: &str) -> String {
    reqwest::Url::parse(endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| endpoint.to_string())
}

/// The first line of whatever a server said, for an error somebody reads.
///
/// Truncated, because a 401 body is sometimes an HTML page.
fn first_line(body: &str) -> String {
    let line = body.lines().next().unwrap_or_default().trim();
    if line.chars().count() > 200 {
        format!("{}…", line.chars().take(200).collect::<String>())
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verifier_is_long_enough_and_a_challenge_is_its_hash() {
        let a = Pkce::fresh();
        let b = Pkce::fresh();
        assert_eq!(a.verifier.len(), 43, "RFC 7636's recommended length");
        assert_ne!(a.verifier, b.verifier, "two of them are not the same one");
        assert!(!a.challenge.contains('='), "base64url carries no padding");
        assert!(
            !a.challenge.contains('+') && !a.challenge.contains('/'),
            "and not the standard alphabet either: {}",
            a.challenge
        );

        // The challenge is S256 of the verifier, which is the one thing the
        // authorization server checks.
        use sha2::{Digest, Sha256};
        assert_eq!(
            a.challenge,
            base64url(&Sha256::digest(a.verifier.as_bytes()))
        );
    }

    /// RFC 7636's own worked example, which is the only way to know the
    /// encoding is right rather than merely self-consistent.
    #[test]
    fn the_rfcs_own_example_round_trips() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        use sha2::{Digest, Sha256};
        assert_eq!(
            base64url(&Sha256::digest(verifier.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    /// **Criterion 18a.** The parameter MCP mandates and a lenient server
    /// lets you forget.
    #[test]
    fn the_authorization_url_carries_the_resource_parameter() {
        let url = authorize_url(
            "https://mcp.canva.com/authorize",
            "qmm7LQzoHc6S",
            "https://fire.example/api/v1/connectors/callback",
            "st4te",
            "ch4llenge",
            "https://mcp.canva.com/mcp",
            &["profile:read".into(), "design:meta:read".into()],
        )
        .unwrap();

        let parsed = reqwest::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
        assert_eq!(
            q.get("resource").map(|r| r.as_ref()),
            Some("https://mcp.canva.com/mcp"),
            "RFC 8707, mandated by MCP: {url}"
        );
        assert_eq!(
            q.get("code_challenge_method").map(|m| m.as_ref()),
            Some("S256")
        );
        assert_eq!(q.get("response_type").map(|r| r.as_ref()), Some("code"));
        assert_eq!(
            q.get("scope").map(|s| s.as_ref()),
            Some("profile:read design:meta:read")
        );
        assert!(!url.contains("code_verifier"), "that one stays here: {url}");
    }

    /// Canva's metadata, as a live fetch received it: a registration endpoint
    /// and a public client, which is the shape that needs nothing set up.
    #[test]
    fn canvas_metadata_says_it_will_register_a_public_client() {
        let document: AuthorizationServer = serde_json::from_str(
            r#"{"issuer":"https://mcp.canva.com",
                "authorization_endpoint":"https://mcp.canva.com/authorize",
                "token_endpoint":"https://mcp.canva.com/token",
                "registration_endpoint":"https://mcp.canva.com/register",
                "response_types_supported":["code"],
                "token_endpoint_auth_methods_supported":["client_secret_basic","client_secret_post","none"],
                "code_challenge_methods_supported":["plain","S256"]}"#,
        )
        .unwrap();
        assert!(document.registration_endpoint.is_some());
        assert!(document.takes_a_public_client());
        assert!(document.does_s256());
    }

    /// Slack's, which is the other shape — and the reason the screens have to
    /// be able to say "this one needs an application somebody registered".
    #[test]
    fn slacks_metadata_says_it_will_not() {
        let document: AuthorizationServer = serde_json::from_str(
            r#"{"issuer":"https://mcp.slack.com",
                "authorization_endpoint":"https://slack.com/oauth/v2_user/authorize",
                "token_endpoint":"https://slack.com/api/oauth.v2.user.access",
                "response_types_supported":["code"],
                "token_endpoint_auth_methods_supported":["client_secret_post"],
                "code_challenge_methods_supported":["S256"]}"#,
        )
        .unwrap();
        assert!(document.registration_endpoint.is_none());
        assert!(!document.takes_a_public_client());
        assert!(document.does_s256());
    }

    /// A server that advertises only `plain` is refused rather than downgraded
    /// for: OAuth 2.1 requires S256 and MCP requires OAuth 2.1.
    #[test]
    fn a_server_offering_only_plain_pkce_is_not_accommodated() {
        let document = AuthorizationServer {
            code_challenge_methods_supported: vec!["plain".into()],
            ..Default::default()
        };
        assert!(!document.does_s256());
        // And one that lists nothing is taken at the specification's word.
        assert!(AuthorizationServer::default().does_s256());
    }

    /// The identifier that goes in `resource` is the metadata's, not the URL
    /// somebody typed — Slack's `/mcp` address names the origin without the
    /// path, and sending the typed one would be sending the wrong audience.
    #[test]
    fn the_resource_identifier_is_the_documents_rather_than_the_typed_address() {
        let slack: ProtectedResource = serde_json::from_str(
            r#"{"resource":"https://mcp.slack.com",
                "authorization_servers":["https://mcp.slack.com"],
                "bearer_methods_supported":["header","form"],
                "scopes_supported":["chat:write","channels:read"]}"#,
        )
        .unwrap();
        assert_eq!(slack.resource.as_deref(), Some("https://mcp.slack.com"));
        assert_eq!(slack.scopes_supported.len(), 2);

        let canva: ProtectedResource = serde_json::from_str(
            r#"{"resource":"https://mcp.canva.com/mcp",
                "authorization_servers":["https://mcp.canva.com"],
                "scopes_supported":["profile:read"],
                "bearer_methods_supported":["header"]}"#,
        )
        .unwrap();
        assert_eq!(canva.resource.as_deref(), Some("https://mcp.canva.com/mcp"));
    }

    #[test]
    fn an_origin_keeps_its_port_and_drops_its_path() {
        let url = reqwest::Url::parse("https://mcp.example.com:8443/mcp/v1?x=1").unwrap();
        assert_eq!(origin(&url), "https://mcp.example.com:8443");
    }

    #[test]
    fn an_html_error_page_is_not_pasted_whole_into_a_message() {
        let page = format!("<!doctype html>{}", "x".repeat(500));
        assert!(first_line(&page).chars().count() <= 201);
    }
}
