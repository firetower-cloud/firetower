//! The application a session is running, at an address of its own.
//!
//! A preview is a hostname. `<session>-<port>-<signature>.firetower.team`
//! reaches the control plane like any other request, and the control plane
//! reads the name to learn what it is being asked for. Nothing is published,
//! no port is bound, and the browser talks to the front door it already
//! trusts.
//!
//! **Why a hostname rather than a path.** Serving an application under
//! `/preview/s_abc/3000/` means rewriting what it says — a `<base>` tag for its
//! relative URLs, its `Location` headers, and a guess from the `Referer` for
//! everything root-relative — and the first client-side
//! `history.pushState("/dashboard")` moves the page out of the prefix and
//! breaks the guess. A hostname is a real origin, so there is nothing to
//! rewrite: client-side routers, service workers and hot-reload sockets all
//! work because none of them can tell.
//!
//! **Why a signature rather than a stored token.** The name carries everything
//! needed to check it, so there is no table to keep, nothing to expire, and an
//! open tab survives a restart of the control plane. Revocation is free
//! because the request still has to resolve the session, and a session that has
//! ended resolves to nothing.
//!
//! **What the signature is for.** Reaching the preview at all. On a laptop,
//! where the front door is bound to loopback, that question is already answered
//! by the network and this is belt and braces. On a deployment with a real
//! domain the hostname is publicly resolvable, and then the name *is* the
//! credential — which is worth saying out loud in the documentation rather than
//! leaving somebody to work out.

pub mod pool;
pub mod proxy;

use ft_core::{ArtifactId, SessionId};

/// What the signing key is scoped to. Changing this invalidates every hostname
/// in flight, which is the only revocation this design has.
const PURPOSE: &str = "preview-hostname-v1";

/// How much of the digest goes in the name.
///
/// Eighty bits. Long enough that guessing is not a strategy against a public
/// deployment, short enough to leave room in a label that also holds a session
/// id — a DNS label is 63 characters and a ULID is already 26 of them.
const SIGNATURE_BYTES: usize = 10;

/// The environment variable naming what previews hang off.
///
/// Unset means `localhost`, which is what a laptop wants and needs no DNS: the
/// browser resolves anything under it to 127.0.0.1 on its own.
pub const DOMAIN_ENV: &str = "FIRETOWER_PREVIEW_DOMAIN";

/// One session's port, as an address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    pub session: SessionId,
    pub port: u16,
}

/// What a signed hostname turned out to name.
///
/// Two shapes share this door, and the difference between them is one hyphen.
/// A session label is a lowercased ULID, which has none — so a preview's
/// `<session>-<port>-<signature>` has exactly two and an artifact's
/// `<artifact>-<signature>` has exactly one. They cannot be read as each
/// other, and the parser that predates artifacts already returned `None` for
/// the one-hyphen form rather than guessing.
///
/// What they are *not* is one kind with a flag. A preview is a live port that
/// stops existing when its session does; an artifact is stored bytes that
/// outlive the workspace. Only the address is shared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Addressed {
    Preview(Preview),
    Artifact(ArtifactId),
}

/// Signs and checks preview hostnames.
#[derive(Clone)]
pub struct Names {
    key: [u8; 32],
    /// What previews hang off. `localhost`, or a domain.
    domain: String,
}

impl Names {
    pub fn new(key: [u8; 32], domain: impl Into<String>) -> Self {
        Self {
            key,
            domain: domain.into(),
        }
    }

    /// From the vault's root key and the environment.
    pub fn from_vault(vault: &crate::vault::Vault) -> Self {
        let domain = std::env::var(DOMAIN_ENV).unwrap_or_else(|_| DEFAULT_DOMAIN.to_string());
        Self::new(vault.derive(PURPOSE), domain)
    }

    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// The whole address, ready to put in an `iframe`.
    ///
    /// Scheme and port are both the caller's, because only the request that
    /// asked knows either: a deployment behind Caddy with a certificate is
    /// https on 443, and a control plane reached through an ssh tunnel is http
    /// on whatever the operator forwarded.
    ///
    /// The port has to be here. A preview is a link the browser follows on its
    /// own, so leaving it out of `localhost:8080` does not mean "the port I
    /// came in on" — it means port 80, on the machine holding the browser,
    /// where there is either nothing or something else of theirs.
    ///
    /// It is left out when it *is* the default for the scheme, so the ordinary
    /// case does not grow a `:443` that nobody typed.
    pub fn url(&self, scheme: &str, port: Option<u16>, preview: &Preview) -> String {
        let host = self.host(preview);

        match port {
            Some(port) if !default_port(scheme, port) => format!("{scheme}://{host}:{port}/"),
            _ => format!("{scheme}://{host}/"),
        }
    }

    /// The hostname for a session's port.
    pub fn host(&self, preview: &Preview) -> String {
        format!(
            "{}-{}-{}.{}",
            label_of(&preview.session),
            preview.port,
            self.sign_preview(preview),
            self.domain,
        )
    }

    /// The hostname an artifact is served at.
    ///
    /// No port and no session in it. The session that produced it is
    /// provenance, not part of the address — the artifact outlives it, and a
    /// name that carried a dead session id would read as though it had not.
    pub fn artifact_host(&self, artifact: &ArtifactId) -> String {
        format!(
            "{}-{}.{}",
            artifact_label_of(artifact),
            self.sign_artifact(artifact),
            self.domain,
        )
    }

    /// The whole address of an artifact, ready for an `iframe` or a tab.
    pub fn artifact_url(&self, scheme: &str, port: Option<u16>, artifact: &ArtifactId) -> String {
        let host = self.artifact_host(artifact);
        match port {
            Some(port) if !default_port(scheme, port) => format!("{scheme}://{host}:{port}/"),
            _ => format!("{scheme}://{host}/"),
        }
    }

    /// What a `Host` header names, if it names a preview of ours.
    ///
    /// `None` for the interface's own address and for anything that does not
    /// verify — a name that is not signed is not a preview, and saying which of
    /// those it was would tell somebody guessing whether they were close.
    pub fn resolve(&self, host_header: &str) -> Option<Addressed> {
        let host = host_header.split(':').next()?;
        let label = host.strip_suffix(&format!(".{}", self.domain))?;

        // From the right: the signature first, then whatever is left decides
        // which shape this is. Splitting from the left would break the day an
        // id contains a hyphen.
        let (rest, signature) = label.rsplit_once('-')?;

        // Constant time throughout: these are credentials on a public
        // deployment, and a comparison that returns early can be measured.
        match rest.rsplit_once('-') {
            // `<session>-<port>-<signature>` — a live port.
            Some((session, port)) => {
                let preview = Preview {
                    session: session_of(session),
                    port: port.parse().ok()?,
                };
                constant_time_eq(self.sign_preview(&preview).as_bytes(), signature.as_bytes())
                    .then_some(Addressed::Preview(preview))
            }
            // `<artifact>-<signature>` — stored bytes.
            None => {
                let artifact = artifact_of(rest);
                constant_time_eq(
                    self.sign_artifact(&artifact).as_bytes(),
                    signature.as_bytes(),
                )
                .then_some(Addressed::Artifact(artifact))
            }
        }
    }

    fn sign_preview(&self, preview: &Preview) -> String {
        self.sign(&[
            PREVIEW_TAG,
            preview.session.as_str().as_bytes(),
            &preview.port.to_be_bytes(),
        ])
    }

    fn sign_artifact(&self, artifact: &ArtifactId) -> String {
        self.sign(&[ARTIFACT_TAG, artifact.as_str().as_bytes()])
    }

    /// Where an artifact's picture is, as a path on the interface's own origin.
    ///
    /// **A path, deliberately, when everything else here is a hostname.** An
    /// artifact needs an origin of its own because it is a document that
    /// resolves its own relative links and must not share a cookie jar with
    /// anything. A poster is one immutable image referenced by exactly one
    /// `<img>`, and giving each one its own hostname would put the library
    /// right back to opening a connection per tile — which is the thing being
    /// fixed. On the interface's origin they share the connection that is
    /// already open.
    ///
    /// Still signed, so it needs no session and no token: an `<img>` cannot
    /// carry an `Authorization` header, and a capability in the name is the
    /// scheme this module already is.
    pub fn poster_path(&self, artifact: &ArtifactId) -> String {
        format!(
            "{POSTER_PREFIX}{}-{}.png",
            artifact_label_of(artifact),
            self.sign(&[POSTER_TAG, artifact.as_str().as_bytes()]),
        )
    }

    /// Which artifact a poster path names, if it names one of ours.
    pub fn poster_of(&self, path: &str) -> Option<ArtifactId> {
        let label = path.strip_prefix(POSTER_PREFIX)?.strip_suffix(".png")?;
        // From the right, for the reason `resolve` gives: an id may hold a
        // hyphen and splitting from the left would break the day one does.
        let (rest, signature) = label.rsplit_once('-')?;
        let artifact = artifact_of(rest);
        constant_time_eq(
            self.sign(&[POSTER_TAG, artifact.as_str().as_bytes()])
                .as_bytes(),
            signature.as_bytes(),
        )
        .then_some(artifact)
    }

    /// One keyed digest over length-prefixed parts.
    ///
    /// Length-prefixed, so ("s_ab", 1) and ("s_a", 91) cannot collide into one
    /// digest. Tagged, so that even if a future shape made two inputs
    /// identical, a signature minted for one could not be replayed as the
    /// other — the kind is part of what was signed rather than something the
    /// parser decides afterwards.
    fn sign(&self, parts: &[&[u8]]) -> String {
        use hmac::Mac;

        let mut mac = <hmac::Hmac<sha2::Sha256>>::new_from_slice(&self.key)
            .expect("HMAC accepts any key length");
        for part in parts {
            mac.update(&(part.len() as u64).to_be_bytes());
            mac.update(part);
        }

        base32(&mac.finalize().into_bytes()[..SIGNATURE_BYTES])
    }
}

/// What each shape is signed as. Changing either invalidates its names.
const PREVIEW_TAG: &[u8] = b"preview";
const ARTIFACT_TAG: &[u8] = b"artifact";
/// Its own tag, so a poster's signature cannot be lifted into a hostname.
///
/// Both names grant a read of the same artifact today, so this buys nothing
/// immediately — but the whole point of tagging in [`Names::sign`] is that the
/// kind is decided by what was signed rather than by whichever parser read it
/// afterwards, and a path and a hostname are parsed by different ones.
const POSTER_TAG: &[u8] = b"poster";

/// The one path on the interface's origin that answers without a token.
///
/// Under `__firetower/` with the annotation runtime, which is the existing
/// place for "ours, not the application's".
pub const POSTER_PREFIX: &str = "/__firetower/poster/";

/// Whether a browser would have assumed this port from the scheme alone.
///
/// Only these two: a URL is not improved by `:8080` becoming implicit anywhere
/// else, and guessing wrong here produces a link to the wrong port rather than
/// an ugly one.
fn default_port(scheme: &str, port: u16) -> bool {
    matches!((scheme, port), ("http", 80) | ("https", 443))
}

/// Previews hang off this when nothing says otherwise.
///
/// Every browser resolves anything under `localhost` to the loopback address
/// with no DNS entry and no configuration, which is what makes the laptop case
/// cost nothing at all.
const DEFAULT_DOMAIN: &str = "localhost";

/// A session id as something that can live in a hostname.
///
/// Ids are `s_` and a lowercase ULID, and an underscore is not allowed in a
/// hostname. The prefix is dropped rather than translated, because translating
/// it would need a character that the rest of the label also uses as a
/// separator.
fn label_of(session: &SessionId) -> String {
    session
        .as_str()
        .strip_prefix("s_")
        .unwrap_or(session.as_str())
        .to_string()
}

fn session_of(label: &str) -> SessionId {
    SessionId::from_stored(format!("s_{label}"))
}

/// The same trick for an artifact id, whose prefix is two characters.
fn artifact_label_of(artifact: &ArtifactId) -> String {
    artifact
        .as_str()
        .strip_prefix("ar_")
        .unwrap_or(artifact.as_str())
        .to_string()
}

fn artifact_of(label: &str) -> ArtifactId {
    ArtifactId::from_stored(format!("ar_{label}"))
}

/// Crockford-ish base32, lowercase: a hostname is case-insensitive and cannot
/// hold the padding or the `+/` of base64.
fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";

    let mut out = String::new();
    let mut buffer: u16 = 0;
    let mut bits = 0;

    for byte in bytes {
        buffer = (buffer << 8) | *byte as u16;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0b11111) as usize] as char);
        }
    }

    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0b11111) as usize] as char);
    }

    out
}

/// Compares without telling anyone how far it got.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |seen, (x, y)| seen | (x ^ y)) == 0
}

/// A tunnel, as a socket.
///
/// The seam, and the reason the proxy above it is ordinary code. Everything
/// that knows what a tunnel is stops here; hyper is handed one of these and
/// does HTTP/1.1 framing, chunked bodies, keep-alive and upgrades exactly as it
/// would over TCP, because as far as it can tell that is what this is.
pub struct TunnelStream {
    incoming: crate::fleet::TunnelIn,
    outgoing: crate::fleet::TunnelOut,
    /// What a chunk had left over when the reader's buffer filled.
    spare: Vec<u8>,
    /// A write in flight. `poll_write` cannot await, so the future is held.
    writing: Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>>,
    /// Set once the far end has been told there is nothing more coming.
    shut: bool,
}

impl TunnelStream {
    pub fn new(tunnel: crate::fleet::Tunnel) -> Self {
        let (incoming, outgoing) = tunnel.split();
        Self {
            incoming,
            outgoing,
            spare: Vec::new(),
            writing: None,
            shut: false,
        }
    }
}

impl tokio::io::AsyncRead for TunnelStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::task::Poll;

        // Whatever last time could not fit, first and in order.
        if !self.spare.is_empty() {
            let take = self.spare.len().min(buf.remaining());
            buf.put_slice(&self.spare[..take]);
            self.spare.drain(..take);
            return Poll::Ready(Ok(()));
        }

        match self.incoming.poll_recv(cx) {
            Poll::Pending => Poll::Pending,
            // The far end closed. End of stream, not an error: a response that
            // ends is how HTTP/1.0 and `Connection: close` say they are done.
            Poll::Ready(None) => Poll::Ready(Ok(())),
            Poll::Ready(Some(bytes)) => {
                let take = bytes.len().min(buf.remaining());
                buf.put_slice(&bytes[..take]);
                if take < bytes.len() {
                    self.spare.extend_from_slice(&bytes[take..]);
                }
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl tokio::io::AsyncWrite for TunnelStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        use std::task::Poll;

        // Finish the one already going before starting another, or the bytes
        // arrive at the far end out of order.
        if let Some(writing) = self.writing.as_mut() {
            match writing.as_mut().poll(cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(()) => self.writing = None,
            }
        }

        let out = self.outgoing.clone();
        let bytes = buf.to_vec();
        let taken = bytes.len();
        let mut writing: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
            Box::pin(async move {
                // A failure here is the host going away, which the read side
                // reports as the stream ending. Two errors for one event would
                // only race each other.
                let _ = out.send(&bytes).await;
            });

        // Poll once: a tunnel with credit to spare takes it immediately, and
        // returning Pending for something already finished costs a wake-up.
        match writing.as_mut().poll(cx) {
            Poll::Ready(()) => {}
            Poll::Pending => self.writing = Some(writing),
        }

        Poll::Ready(Ok(taken))
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::task::Poll;

        match self.writing.as_mut() {
            None => Poll::Ready(Ok(())),
            Some(writing) => match writing.as_mut().poll(cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(()) => {
                    self.writing = None;
                    Poll::Ready(Ok(()))
                }
            },
        }
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::task::Poll;

        if self.as_mut().poll_flush(cx).is_pending() {
            return Poll::Pending;
        }

        if !self.shut {
            self.shut = true;
            // Half-close: the request body is over, and the far end still has
            // an answer to write. A server reading to end-of-input never
            // replies without this.
            let out = self.outgoing.clone();
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move {
                    let _ = out.half_close().await;
                });
            }
        }

        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Names {
        Names::new([7u8; 32], "localhost")
    }

    fn preview() -> Preview {
        Preview {
            session: SessionId::from_stored("s_01m1c0f9a3hgm99t4vfam429m3"),
            port: 3000,
        }
    }

    fn artifact() -> ArtifactId {
        ArtifactId::from_stored("ar_01m1c0f9a3hgm99t4vfam429m3")
    }

    #[test]
    fn a_poster_path_survives_the_round_trip() {
        let names = names();
        let path = names.poster_path(&artifact());
        assert!(path.starts_with(POSTER_PREFIX), "{path}");
        assert!(path.ends_with(".png"), "{path}");
        assert_eq!(names.poster_of(&path), Some(artifact()));
    }

    /// The whole reason it is signed: the id is in the name, so without this
    /// anybody could read any artifact's picture by editing the path.
    #[test]
    fn a_poster_path_with_a_forged_signature_is_refused() {
        let names = names();
        let forged = format!(
            "{POSTER_PREFIX}{}-aaaaaaaaaaaaaaaa.png",
            artifact_label_of(&artifact())
        );
        assert_eq!(names.poster_of(&forged), None);
    }

    /// Another key is another installation, and a path minted there means
    /// nothing here.
    #[test]
    fn a_poster_path_from_another_key_is_refused() {
        let path = Names::new([9u8; 32], "localhost").poster_path(&artifact());
        assert_eq!(names().poster_of(&path), None);
    }

    /// `POSTER_TAG` earning its place: the same artifact signs differently for
    /// a hostname and for a path, so neither signature can be lifted into the
    /// other parser.
    #[test]
    fn a_hostname_signature_is_not_a_poster_signature() {
        let names = names();
        let host = names.artifact_host(&artifact());
        let from_host = host.split('.').next().unwrap().rsplit_once('-').unwrap().1;
        let lifted = format!(
            "{POSTER_PREFIX}{}-{from_host}.png",
            artifact_label_of(&artifact())
        );
        assert_eq!(names.poster_of(&lifted), None);
    }

    /// Nothing that is not a poster path is read as one, including the
    /// prefix on its own and a path with the extension missing.
    #[test]
    fn something_that_is_not_a_poster_is_not_one() {
        let names = names();
        assert_eq!(names.poster_of("/api/v1/artifacts"), None);
        assert_eq!(names.poster_of(POSTER_PREFIX), None);
        let no_extension = names.poster_path(&artifact()).replace(".png", "");
        assert_eq!(names.poster_of(&no_extension), None);
    }

    #[test]
    fn a_name_survives_the_round_trip() {
        let names = names();
        let host = names.host(&preview());
        assert_eq!(names.resolve(&host), Some(Addressed::Preview(preview())));
    }

    #[test]
    fn an_artifact_name_survives_the_round_trip() {
        let names = names();
        let host = names.artifact_host(&artifact());
        assert_eq!(names.resolve(&host), Some(Addressed::Artifact(artifact())));
    }

    /// The whole reason the two can share a door: one hyphen against two.
    #[test]
    fn the_two_shapes_cannot_be_read_as_each_other() {
        let names = names();

        let preview_host = names.host(&preview());
        let artifact_host = names.artifact_host(&artifact());
        assert_eq!(
            preview_host.split('.').next().unwrap().matches('-').count(),
            2
        );
        assert_eq!(
            artifact_host
                .split('.')
                .next()
                .unwrap()
                .matches('-')
                .count(),
            1
        );

        // And neither resolves to the other's kind.
        assert!(matches!(
            names.resolve(&preview_host),
            Some(Addressed::Preview(_))
        ));
        assert!(matches!(
            names.resolve(&artifact_host),
            Some(Addressed::Artifact(_))
        ));
    }

    /// A preview signature lifted onto an artifact name, and the reverse.
    /// Neither verifies, because the kind is inside what was signed.
    #[test]
    fn a_signature_cannot_be_replayed_across_shapes() {
        let names = names();

        // The same id, signed as a preview, pasted into an artifact name.
        let stolen = names
            .host(&preview())
            .split('.')
            .next()
            .unwrap()
            .rsplit_once('-')
            .unwrap()
            .1
            .to_string();
        let forged = format!("{}-{}.localhost", "01m1c0f9a3hgm99t4vfam429m3", stolen);
        assert_eq!(names.resolve(&forged), None);
    }

    /// The browser sends the port it connected to along with the name.
    #[test]
    fn a_name_resolves_with_a_port_on_it() {
        let names = names();
        let host = format!("{}:8080", names.host(&preview()));
        assert_eq!(names.resolve(&host), Some(Addressed::Preview(preview())));
    }

    /// A hostname is a hostname: no underscores, nothing over 63 characters,
    /// and nothing a resolver would refuse.
    #[test]
    fn a_name_is_a_legal_hostname() {
        for host in [names().host(&preview()), names().artifact_host(&artifact())] {
            let label = host.split('.').next().unwrap();

            assert!(label.len() <= 63, "{} characters: {label}", label.len());
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{label}"
            );
            assert!(!label.starts_with('-') && !label.ends_with('-'), "{label}");
        }
    }

    #[test]
    fn the_interfaces_own_address_is_not_a_preview() {
        let names = names();
        assert_eq!(names.resolve("localhost"), None);
        assert_eq!(names.resolve("localhost:4400"), None);
        assert_eq!(names.resolve("firetower.team"), None);
    }

    /// The point of signing.
    #[test]
    fn a_name_nobody_signed_is_not_a_preview() {
        let names = names();

        // Right shape, invented signature.
        assert_eq!(
            names.resolve("01m1c0f9a3hgm99t4vfam429m3-3000-aaaaaaaaaaaaaaaa.localhost"),
            None
        );
        // A real name with the port changed, which is the interesting attack:
        // one preview should not be a key to every port in the workspace.
        let host = names.host(&preview());
        let moved = host.replacen("-3000-", "-8000-", 1);
        assert_eq!(names.resolve(&moved), None);

        // And an artifact id nobody signed.
        assert_eq!(
            names.resolve("01m1c0f9a3hgm99t4vfam429m3-aaaaaaaaaaaaaaaa.localhost"),
            None
        );
    }

    /// A name signed by one installation means nothing to another.
    #[test]
    fn another_installation_cannot_sign_ours() {
        let host = Names::new([9u8; 32], "localhost").host(&preview());
        assert_eq!(names().resolve(&host), None);
    }

    #[test]
    fn a_domain_other_than_localhost_works_the_same() {
        let names = Names::new([7u8; 32], "firetower.team");
        let host = names.host(&preview());

        assert!(host.ends_with(".firetower.team"), "{host}");
        assert_eq!(names.resolve(&host), Some(Addressed::Preview(preview())));
        // And a name for the wrong domain is not ours, however well signed.
        assert_eq!(Names::new([7u8; 32], "localhost").resolve(&host), None);
    }

    #[test]
    fn the_url_carries_the_callers_scheme() {
        let names = names();
        assert!(names.url("https", None, &preview()).starts_with("https://"));
        assert!(names.url("http", None, &preview()).ends_with("/"));
    }

    #[test]
    fn the_url_carries_the_callers_port() {
        let names = names();
        let host = names.host(&preview());

        // The tunnel case, and the whole reason the port is threaded through:
        // without it this link goes to port 80 of the browser's own machine.
        assert_eq!(
            names.url("http", Some(8080), &preview()),
            format!("http://{host}:8080/")
        );
        assert_eq!(
            names.url("https", Some(8443), &preview()),
            format!("https://{host}:8443/")
        );
    }

    #[test]
    fn a_default_port_is_left_out() {
        let names = names();
        let host = names.host(&preview());

        assert_eq!(
            names.url("http", Some(80), &preview()),
            format!("http://{host}/")
        );
        assert_eq!(
            names.url("https", Some(443), &preview()),
            format!("https://{host}/")
        );

        // Default for the *other* scheme is still a port worth printing.
        assert_eq!(
            names.url("http", Some(443), &preview()),
            format!("http://{host}:443/")
        );
    }

    #[test]
    fn a_ported_url_still_resolves_back() {
        let names = names();
        let url = names.url("http", Some(8080), &preview());

        // What the browser will put in `Host` for that link, which is what
        // `preview_first` has to recognise on the way back in.
        let authority = url.trim_start_matches("http://").trim_end_matches('/');
        assert_eq!(
            names.resolve(authority),
            Some(Addressed::Preview(preview()))
        );

        // The artifact URL does the same.
        let url = names.artifact_url("http", Some(8080), &artifact());
        let authority = url.trim_start_matches("http://").trim_end_matches('/');
        assert_eq!(
            names.resolve(authority),
            Some(Addressed::Artifact(artifact()))
        );
    }
}

pub mod annotations;
