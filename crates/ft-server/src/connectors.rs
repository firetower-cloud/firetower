//! Authorizing a connector, as the person who asked.
//!
//! A connector is an MCP server a plugin declares. Every engine can log into
//! one by itself, and none of that survives here: Firetower's agent homes are
//! made per session and thrown away, so **Firetower holds the credential or
//! nobody does.**
//!
//! Two halves, shared two different ways, and separating them is what makes
//! the rest simple. The *connector* is configuration — which server, which
//! URL, which tools — and that travels with a plugin through a directory or a
//! profile. The *token* is an identity, and an identity is never a team
//! decision: it lives in the vault at `connector/<skill id>/<owner>`, beside
//! `git/<id>/<owner>` and `tracker/linear`, so revocation, the access log and
//! offboarding all arrive with it.
//!
//! ## The specification's musts, and which line each one is
//!
//! The MCP authorization spec is a set of requirements rather than a
//! suggestion, and a client that implements only the happy path fails on real
//! servers. Four bind us:
//!
//! - **PKCE on every flow** — [`Pkce`], `S256` only.
//! - **Discovery through the resource, then its authorization server**, with
//!   the well-known fallback — [`discover`].
//! - **The `resource` parameter on authorize *and* token** (RFC 8707), so the
//!   token is audience-bound to one server. Without it a token minted for one
//!   MCP server is replayable against another, and it is a security property
//!   that does not survive being retrofitted — see [`authorize_url`] and
//!   [`exchange`].
//! - **The bearer in the header**, never a query string. That one belongs to
//!   the worker, which writes `.mcp.json`.
//!
//! ## Measured
//!
//! Against the live endpoints on 22 November 2026: Linear, Notion and Sentry
//! all advertise a `registration_endpoint` with PKCE `S256` and
//! `refresh_token`, so dynamic registration genuinely works and nobody has to
//! register an application. GitHub is the exception — its authorization server
//! is `github.com/login/oauth`, which has none — and it is also the one
//! Firetower already holds a token for, so it never reaches this module.

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::oauth::client;

/// base64url without padding, which is what PKCE is specified in.
///
/// Built on `ft_proto`'s base64 rather than on a new dependency: the alphabet
/// differs in two characters and the padding is dropped, and that is the whole
/// of the difference. RFC 7636's own worked example is a test below, so a
/// mistake here fails loudly rather than producing a challenge a server
/// quietly rejects.
fn b64url(bytes: &[u8]) -> String {
    ft_proto::encode(bytes)
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_string()
}

/// Where an authorization server is, and what it will accept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Discovered {
    /// RFC 9728 §3 — what the resource calls itself, which is what goes back
    /// as `resource` to bind a token to it.
    pub resource: String,
    pub authorize_url: String,
    pub token_url: String,
    /// RFC 7591. `None` is a server that registers no clients dynamically, and
    /// means somebody has to supply a client id by hand.
    pub register_url: Option<String>,
    /// What the resource says it wants. Asking for what it published is
    /// narrower than asking for everything.
    pub scopes: Option<String>,
    /// What the server calls itself, when it says.
    pub name: Option<String>,
}

#[derive(Deserialize)]
struct ProtectedResource {
    resource: Option<String>,
    authorization_servers: Option<Vec<String>>,
    scopes_supported: Option<Vec<String>>,
    /// RFC 9728 §3.2 — what the server calls itself.
    ///
    /// Measured: 2 of the 4 servers checked publish one ("Zernio MCP Server",
    /// "Notion MCP (Beta)"), and it is better than anything derivable from a
    /// hostname. Where it is absent the name still comes from the address.
    resource_name: Option<String>,
}

#[derive(Deserialize)]
struct AuthServer {
    authorization_endpoint: Option<String>,
    token_endpoint: Option<String>,
    registration_endpoint: Option<String>,
    code_challenge_methods_supported: Option<Vec<String>>,
}

/// Ask a server what it is and how it wants to be authorized.
///
/// Three steps, and the first is the one people skip: **the unauthorized
/// request is the discovery mechanism.** An MCP server answers `401` with a
/// `WWW-Authenticate` naming where its metadata is, and guessing that address
/// instead works until it does not.
pub async fn discover(url: &str) -> Result<Discovered> {
    let http = client()?;

    // 1. The pointer, out of the refusal.
    let refusal = http
        .post(url)
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#)
        .send()
        .await
        .with_context(|| format!("asking {url} what it is"))?;

    let pointer = refusal
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .and_then(resource_metadata_of)
        // The well-known address, for a server that answers without the
        // pointer. RFC 9728's own fallback, and worth keeping: a 401 with a
        // bare `Bearer` is still a server that may publish metadata.
        .unwrap_or_else(|| well_known(url));

    // 2. What the resource says about itself.
    let pr: ProtectedResource = http
        .get(&pointer)
        .send()
        .await
        .with_context(|| format!("reading {pointer}"))?
        .json()
        .await
        .with_context(|| format!("{pointer} is not the metadata document it should be"))?;

    let server = pr
        .authorization_servers
        .unwrap_or_default()
        .into_iter()
        .next()
        .context("that server names no authorization server, so there is nothing to connect to")?;

    // 3. What the authorization server will accept. The trailing-slash form
    // first, because an issuer with a path puts the well-known segment *after*
    // the origin — and plenty of servers answer both.
    let meta = fetch_auth_server(&http, &server).await?;

    let challenge_ok = meta
        .code_challenge_methods_supported
        .as_deref()
        .map(|m| m.iter().any(|s| s == "S256"))
        // Absent is not a refusal: PKCE is required of us either way, and a
        // server that does not advertise the field often still honours it.
        .unwrap_or(true);
    if !challenge_ok {
        bail!("that authorization server does not offer PKCE, which Firetower requires");
    }

    Ok(Discovered {
        resource: pr.resource.unwrap_or_else(|| url.to_string()),
        authorize_url: meta
            .authorization_endpoint
            .context("that authorization server publishes no authorization endpoint")?,
        token_url: meta
            .token_endpoint
            .context("that authorization server publishes no token endpoint")?,
        register_url: meta.registration_endpoint,
        scopes: pr
            .scopes_supported
            .map(|s| s.join(" "))
            .filter(|s| !s.is_empty()),
        name: pr
            .resource_name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty()),
    })
}

/// Both spellings of the authorization-server document, at both of the
/// addresses an issuer with a path can publish it, in the order a reader
/// should try them.
///
/// **The spec's address is not the obvious one.** RFC 8414 §3.1 inserts the
/// well-known segment between the host and the issuer's path, so the issuer
/// `https://access.stripe.com/mcp` publishes at
/// `https://access.stripe.com/.well-known/oauth-authorization-server/mcp`;
/// OpenID Connect Discovery appends instead. Stripe answers only the first
/// form, and appending alone read it as a server with no metadata — a
/// connector that is perfectly reachable, reported as dead. For an issuer
/// without a path the two forms are the same string, which `dedup` drops.
async fn fetch_auth_server(http: &reqwest::Client, issuer: &str) -> Result<AuthServer> {
    let base = issuer.trim_end_matches('/');
    let mut candidates = Vec::with_capacity(4);
    for leaf in ["oauth-authorization-server", "openid-configuration"] {
        candidates.push(inserted(base, leaf));
        candidates.push(format!("{base}/.well-known/{leaf}"));
    }
    candidates.dedup();
    let mut last = None;
    for at in &candidates {
        match http.get(at).send().await {
            Ok(r) if r.status().is_success() => match r.json::<AuthServer>().await {
                Ok(meta) => return Ok(meta),
                Err(e) => last = Some(anyhow::anyhow!("{at}: {e}")),
            },
            Ok(r) => last = Some(anyhow::anyhow!("{at}: {}", r.status())),
            Err(e) => last = Some(anyhow::anyhow!("{at}: {e}")),
        }
    }
    Err(last.unwrap_or_else(|| anyhow::anyhow!("no metadata at {issuer}")))
}

/// RFC 8414's address for a document belonging to `issuer`: the well-known
/// segment goes after the origin and the issuer's own path follows it.
fn inserted(issuer: &str, leaf: &str) -> String {
    match issuer.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/') {
            Some((host, path)) => format!("{scheme}://{host}/.well-known/{leaf}/{path}"),
            None => format!("{scheme}://{rest}/.well-known/{leaf}"),
        },
        None => format!("{issuer}/.well-known/{leaf}"),
    }
}

/// `resource_metadata="…"` out of a `WWW-Authenticate` header.
///
/// Parsed rather than pattern-matched on the whole header: the parameters may
/// arrive in any order and a `realm` holding the word is not the pointer.
fn resource_metadata_of(header: &str) -> Option<String> {
    header.split(',').find_map(|part| {
        let (k, v) = part.split_once('=')?;
        // **The scheme is glued to the first parameter.** `WWW-Authenticate`
        // is `Bearer resource_metadata="…"` — a space after the scheme, a
        // comma only *between* parameters. So the first key arrives as
        // "Bearer resource_metadata", and matching it whole silently missed
        // every server that puts this parameter first. Slack does, and we
        // read it as a server wanting no authorization at all.
        let k = k.trim();
        let k = k.rsplit_once(char::is_whitespace).map_or(k, |(_, name)| name);
        (k.eq_ignore_ascii_case("resource_metadata"))
            .then(|| v.trim().trim_matches('"').to_string())
    })
}

/// RFC 9728's fallback address: the well-known segment goes after the origin
/// and the resource's own path follows it.
fn well_known(url: &str) -> String {
    match url.split_once("://") {
        Some((scheme, rest)) => match rest.split_once('/') {
            Some((host, path)) => {
                format!("{scheme}://{host}/.well-known/oauth-protected-resource/{path}")
            }
            None => format!("{scheme}://{rest}/.well-known/oauth-protected-resource"),
        },
        None => format!("{url}/.well-known/oauth-protected-resource"),
    }
}

/// What dynamic registration gave back.
#[derive(Debug, Clone)]
pub struct Registered {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// Register Firetower with an authorization server, per RFC 7591.
///
/// **This is the difference between a connector and a git host.** A git host
/// needs an administrator to create an application because the instance is
/// theirs; a public MCP server does not, so pasting a URL is the whole of the
/// setup and nobody has to be an administrator to use one.
pub async fn register(at: &str, redirect: &str) -> Result<Registered> {
    #[derive(Deserialize)]
    struct Out {
        client_id: String,
        client_secret: Option<String>,
    }
    let body = serde_json::json!({
        "client_name": "Firetower",
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        // Public client: there is no secret we could keep on a control plane
        // somebody else installs, and PKCE is what stands in for one.
        "token_endpoint_auth_method": "none",
        "application_type": "native",
    });
    let r = client()?
        .post(at)
        .json(&body)
        .send()
        .await
        .with_context(|| format!("registering with {at}"))?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("{at} refused the registration: {status} {}", text.trim());
    }
    let out: Out = serde_json::from_str(&text)
        .with_context(|| format!("{at} answered something that is not a registration"))?;
    Ok(Registered {
        client_id: out.client_id,
        client_secret: out.client_secret,
    })
}


/// How big a stored mark may be.
///
/// An apple-touch-icon is a 180×180 PNG and runs 5–15 KB; this is room for a
/// generous one and a refusal for anything that is really a photograph. It is
/// inlined into a library row, so the cap is what stops one server making the
/// whole list slow to load.
const BIGGEST_LOGO: usize = 96 * 1024;

/// The mark a server's own site serves, as bytes and a content type.
///
/// **No MCP server publishes a logo.** Measured against Linear, Notion, Sentry
/// and Zernio: not one carries `logo_uri` in its protected-resource document
/// or in its authorization-server metadata, so there is nothing in the
/// protocol to read. What every one of them *does* serve is an
/// `apple-touch-icon` — a square PNG meant to be shown at size, which is
/// exactly the shape a row wants.
///
/// Tried in the order of how much it is worth: the touch icon, then the
/// ordinary `icon` link, then `/favicon.ico`. **`og:image` is deliberately
/// not in that list** — it is a wide social card, and a 1200×630 banner
/// squeezed into a 30px square is worse than a monogram.
///
/// Fetched from the *authorization server's* origin rather than the MCP
/// endpoint's: `mcp.linear.app` is a subdomain that serves no site, and
/// `linear.app` is the brand.
pub async fn fetch_logo(origins: &[String]) -> Option<(Vec<u8>, String)> {
    for origin in origins {
        if let Some(found) = logo_at(origin).await {
            return Some(found);
        }
    }
    None
}

/// Every mark one origin offers, best first, and the first that downloads.
async fn logo_at(origin: &str) -> Option<(Vec<u8>, String)> {
    let http = client().ok()?;
    let page = http
        .get(origin)
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success())?
        .text()
        .await
        .unwrap_or_default();
    let page: String = page.chars().take(200_000).collect();

    let mut tries: Vec<String> = Vec::new();
    for pattern in [r#"apple-touch-icon"#, r#"icon"#] {
        if let Some(href) = link_href(&page, pattern) {
            tries.push(absolute(origin, &href));
        }
    }
    tries.push(format!("{}/favicon.ico", origin.trim_end_matches('/')));

    for at in tries {
        let Ok(r) = http.get(&at).send().await else {
            continue;
        };
        if !r.status().is_success() {
            continue;
        }
        let kind = r
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .to_string();
        if !kind.starts_with("image/") {
            continue;
        }
        let Ok(bytes) = r.bytes().await else { continue };
        if bytes.is_empty() || bytes.len() > BIGGEST_LOGO {
            continue;
        }
        return Some((bytes.to_vec(), kind));
    }
    None
}

/// The `href` of the first `<link rel="…pattern…">` in a page.
///
/// Deliberately a scan and not a parser: this reads one attribute out of a
/// document nobody controls, and a parser is a dependency and an attack
/// surface for something a row shows a picture from.
fn link_href(page: &str, pattern: &str) -> Option<String> {
    for tag in page.split('<') {
        let lower = tag.to_ascii_lowercase();
        if !lower.starts_with("link") {
            continue;
        }
        let rel = attr(&lower, "rel")?;
        if !rel.contains(pattern) {
            continue;
        }
        // `shortcut icon` and `icon` both match "icon"; `mask-icon` is a
        // monochrome SVG stencil and is not a logo.
        if rel.contains("mask-icon") {
            continue;
        }
        if let Some(href) = attr(tag, "href") {
            return Some(href);
        }
    }
    None
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let at = tag.find(&format!("{name}="))?;
    let rest = &tag[at + name.len() + 1..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let rest = &rest[1..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

/// A possibly-relative href, against the origin it came from.
fn absolute(origin: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    let base = origin.trim_end_matches('/');
    if let Some(rest) = href.strip_prefix("//") {
        return format!("https://{rest}");
    }
    if href.starts_with('/') {
        format!("{base}{href}")
    } else {
        format!("{base}/{href}")
    }
}

/// A PKCE pair. `S256` only — `plain` is in the specification and is not a
/// protection, and offering it would mean a server could choose it for us.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Self {
        // The same CSPRNG the vault seals with. A verifier is the only thing
        // standing in for a client secret here, so it is not somewhere to
        // reach for a cheaper source of bytes.
        use chacha20poly1305::aead::rand_core::RngCore;
        let mut raw = [0u8; 32];
        chacha20poly1305::aead::OsRng.fill_bytes(&mut raw);
        let verifier = b64url(&raw);
        let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// Where to send somebody's browser.
///
/// **`resource` is on this request and on the token request both**, which is
/// RFC 8707 and is what audience-binds the token. A token minted for one MCP
/// server is then useless at another, which is the property that does not
/// survive being added later.
pub fn authorize_url(
    d: &Discovered,
    client_id: &str,
    redirect: &str,
    state: &str,
    pkce: &Pkce,
) -> String {
    let Ok(mut url) = reqwest::Url::parse(&d.authorize_url) else {
        // Discovery produced it, so this is a server publishing something that
        // is not an address. Handing the string back unchanged lets the caller
        // report what it actually got rather than a fabricated URL.
        return d.authorize_url.clone();
    };
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code");
        q.append_pair("client_id", client_id);
        q.append_pair("redirect_uri", redirect);
        q.append_pair("state", state);
        q.append_pair("code_challenge", &pkce.challenge);
        q.append_pair("code_challenge_method", "S256");
        q.append_pair("resource", &d.resource);
        if let Some(scopes) = &d.scopes {
            q.append_pair("scope", scopes);
        }
    }
    url.to_string()
}

/// Turn the code the browser came back with into a grant.
pub async fn exchange(
    d: &Discovered,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    redirect: &str,
    pkce_verifier: &str,
) -> Result<crate::oauth::Grant> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client_id),
        ("code_verifier", pkce_verifier),
        // Again, and deliberately. The specification requires it on both, and
        // a server that only sees it once may bind the token to nothing.
        ("resource", &d.resource),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let r = client()?
        .post(&d.token_url)
        .form(&form)
        .send()
        .await
        .context("exchanging the code")?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("the authorization server refused: {status} {}", text.trim());
    }
    grant_from(&text)
}

/// Spend a refresh token for a new access token.
pub async fn refresh(
    d: &Discovered,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<crate::oauth::Grant> {
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("resource", &d.resource),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret));
    }
    let r = client()?
        .post(&d.token_url)
        .form(&form)
        .send()
        .await
        .context("renewing the authorization")?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!(
            "the authorization server refused the renewal: {status} {}",
            text.trim()
        );
    }
    grant_from(&text)
}

/// A token response, as the shape the vault already stores.
///
/// Reuses [`crate::oauth::Grant`] rather than inventing a second envelope, so
/// expiry, renewability and `to_stored`/`parse` are the ones `git_token`
/// already uses — and a connector's credential ages the same way a git token
/// does.
fn grant_from(text: &str) -> Result<crate::oauth::Grant> {
    #[derive(Deserialize)]
    struct Token {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: Option<i64>,
    }
    let t: Token = serde_json::from_str(text).context("that is not a token response")?;
    Ok(crate::oauth::Grant {
        access: t.access_token,
        refresh: t.refresh_token,
        expires_at: t
            .expires_in
            .map(|s| chrono::Utc::now() + chrono::Duration::seconds(s)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pointer_is_read_out_of_the_header_whatever_order_it_is_in() {
        let h = r#"Bearer error="invalid_request", error_description="No access token was provided in this request", resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/""#;
        assert_eq!(
            resource_metadata_of(h).as_deref(),
            Some("https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/")
        );
        // A realm that merely contains the word is not the pointer.
        assert_eq!(resource_metadata_of(r#"Bearer realm="OAuth""#), None);
        // And the shape Linear actually answers with.
        let linear = r#"Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", scope="read write""#;
        assert_eq!(
            resource_metadata_of(linear).as_deref(),
            Some("https://mcp.linear.app/.well-known/oauth-protected-resource/mcp")
        );
    }

    /// RFC 8414 does the same for the authorization server's own document,
    /// and the difference only shows on an issuer that has a path.
    ///
    /// Stripe's issuer is `https://access.stripe.com/mcp` and it answers the
    /// inserted address alone. Appending was all we tried, so a live
    /// one-click server read as one publishing no metadata at all.
    #[test]
    fn the_well_known_segment_goes_after_the_origin_for_an_issuer_with_a_path() {
        assert_eq!(
            inserted("https://access.stripe.com/mcp", "oauth-authorization-server"),
            "https://access.stripe.com/.well-known/oauth-authorization-server/mcp"
        );
        // No path, so there is nothing to insert ahead of and the two forms
        // agree — which is why appending alone passed for everybody else.
        assert_eq!(
            inserted("https://auth.exa.ai", "oauth-authorization-server"),
            "https://auth.exa.ai/.well-known/oauth-authorization-server"
        );
        assert_eq!(
            inserted("https://fly.io/mcp/oauth", "openid-configuration"),
            "https://fly.io/.well-known/openid-configuration/mcp/oauth"
        );
    }

    /// RFC 9728 puts the well-known segment after the origin, with the
    /// resource's own path after it — not at the end of the path, which is
    /// what a naive join produces and what returns 404.
    #[test]
    fn the_fallback_address_puts_the_well_known_segment_after_the_origin() {
        assert_eq!(
            well_known("https://api.githubcopilot.com/mcp/"),
            "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"
        );
        assert_eq!(
            well_known("https://mcp.sentry.dev"),
            "https://mcp.sentry.dev/.well-known/oauth-protected-resource"
        );
    }

    /// The challenge is the SHA-256 of the verifier, base64url without
    /// padding. RFC 7636's own worked example, so this fails if the encoding
    /// drifts rather than if the output merely changes.
    #[test]
    fn pkce_matches_the_specification_worked_example() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            b64url(&Sha256::digest(verifier.as_bytes())),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_pair_is_random_and_its_challenge_is_of_its_own_verifier() {
        let a = Pkce::new();
        let b = Pkce::new();
        assert_ne!(a.verifier, b.verifier, "a fixed verifier is no protection");
        assert_eq!(a.challenge, b64url(&Sha256::digest(a.verifier.as_bytes())));
        assert!(
            !a.challenge.contains(['+', '/', '=']),
            "base64url has neither of the two characters nor the padding"
        );
    }

    /// The pointer, when the parameter comes first.
    ///
    /// Measured against four servers: Linear, Notion and Sentry send
    /// `Bearer error="…", resource_metadata="…"`, so the parameter follows a
    /// comma and parsed. Slack sends it first, with only a space after the
    /// scheme — and that one case is the difference between discovering an
    /// OAuth server and recording it as needing no authorization.
    #[test]
    fn the_pointer_is_found_even_when_the_scheme_is_glued_to_it() {
        let slack = r#"Bearer resource_metadata="https://mcp.slack.com/.well-known/oauth-protected-resource""#;
        assert_eq!(
            resource_metadata_of(slack).as_deref(),
            Some("https://mcp.slack.com/.well-known/oauth-protected-resource")
        );
        let after_a_comma = r#"Bearer error="invalid_token", resource_metadata="https://x.dev/.well-known/oauth-protected-resource""#;
        assert_eq!(
            resource_metadata_of(after_a_comma).as_deref(),
            Some("https://x.dev/.well-known/oauth-protected-resource")
        );
        // A bare challenge names nothing, and the caller falls back.
        assert_eq!(resource_metadata_of("Bearer"), None);
        assert_eq!(resource_metadata_of(r#"Bearer error="invalid_token""#), None);
    }

    /// **`resource` is the one that has to be there.** Without it the token is
    /// bound to nothing and is replayable at another MCP server, which is the
    /// failure this parameter exists to prevent.
    #[test]
    fn the_authorize_url_carries_pkce_and_the_audience() {
        let d = Discovered {
            resource: "https://mcp.linear.app/mcp".into(),
            authorize_url: "https://mcp.linear.app/authorize".into(),
            token_url: "https://mcp.linear.app/token".into(),
            register_url: None,
            scopes: Some("read write".into()),
            name: None,
        };
        let pkce = Pkce::new();
        let url = authorize_url(&d, "client-1", "http://localhost:14400/cb", "st", &pkce);
        let parsed = reqwest::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = parsed.query_pairs().collect();
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["client_id"], "client-1");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], pkce.challenge.as_str());
        assert_eq!(q["resource"], "https://mcp.linear.app/mcp");
        assert_eq!(q["scope"], "read write");
        assert_eq!(q["state"], "st");
        assert!(
            !url.contains(&pkce.verifier),
            "the verifier never leaves here"
        );
    }
}

/// Which connector's key a credential for this one is stored under.
///
/// **The credential belongs to the server, not to the folder that mentioned
/// it.** Two bundles can declare the same address — Anthropic's own catalogue
/// has a `slack` plugin and a `business` plugin that both point at
/// `mcp.slack.com` — and keying the vault on the bundle made that two
/// authorizations, two registered OAuth clients and two tokens for one
/// account. Adding the second one showed "Connect" on a server you had just
/// connected.
///
/// So everything that reads or writes a connector credential resolves through
/// here first: the lowest skill id among the connectors sharing an address.
/// Deterministic, so it does not move when a row is added, and it needs no
/// migration — the first bundle anybody connected is usually the lowest.
pub async fn credential_key(pool: &sqlx::PgPool, skill_id: &str) -> String {
    let same: Option<String> = sqlx::query_scalar(
        "SELECT min(o.skill_id) \
           FROM connectors c JOIN connectors o ON o.url = c.url \
          WHERE c.skill_id = $1",
    )
    .bind(skill_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    same.unwrap_or_else(|| skill_id.to_string())
}


/// Write down what discovery found, before anybody presses Connect.
///
/// **A row here with no `client_id` is the useful case.** It means the server
/// was asked and said it registers no clients — GitHub, Slack, Google — so
/// the screen can say "this one needs a client id made by hand" instead of
/// drawing a Connect button that fails the moment it is pressed. Firetower
/// swallowed that failure for a while, which made adding GitHub look like
/// nothing had happened at all.
///
/// Best effort: a server that cannot be reached leaves no row, and the row is
/// then written the first time somebody connects, as before.
pub async fn remember(pool: &sqlx::PgPool, skill_id: &str, url: &str) {
    let Ok(found) = discover(url).await else {
        return;
    };
    let _ = sqlx::query(
        "INSERT INTO connector_clients \
           (skill_id, resource, authorize_url, token_url, register_url, scopes) \
         VALUES ($1,$2,$3,$4,$5,$6) \
         ON CONFLICT (skill_id) DO UPDATE SET \
           resource = excluded.resource, authorize_url = excluded.authorize_url, \
           token_url = excluded.token_url, register_url = excluded.register_url, \
           scopes = excluded.scopes \
         WHERE connector_clients.client_id IS NULL",
    )
    .bind(skill_id)
    .bind(&found.resource)
    .bind(&found.authorize_url)
    .bind(&found.token_url)
    .bind(&found.register_url)
    .bind(&found.scopes)
    .execute(pool)
    .await;
}
