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

pub mod proxy;

use ft_core::SessionId;

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
        let domain =
            std::env::var(DOMAIN_ENV).unwrap_or_else(|_| DEFAULT_DOMAIN.to_string());
        Self::new(vault.derive(PURPOSE), domain)
    }

    pub fn domain(&self) -> &str {
        &self.domain
    }

    /// The whole address, ready to put in an `iframe`.
    ///
    /// Scheme included, and it is the caller's: a deployment behind Caddy with
    /// a domain is on https, a laptop is not, and only the request that asked
    /// knows which.
    pub fn url(&self, scheme: &str, preview: &Preview) -> String {
        format!("{scheme}://{}/", self.host(preview))
    }

    /// The hostname for a session's port.
    pub fn host(&self, preview: &Preview) -> String {
        format!(
            "{}-{}-{}.{}",
            label_of(&preview.session),
            preview.port,
            self.sign(preview),
            self.domain,
        )
    }

    /// What a `Host` header names, if it names a preview of ours.
    ///
    /// `None` for the interface's own address and for anything that does not
    /// verify — a name that is not signed is not a preview, and saying which of
    /// those it was would tell somebody guessing whether they were close.
    pub fn resolve(&self, host_header: &str) -> Option<Preview> {
        let host = host_header.split(':').next()?;
        let label = host.strip_suffix(&format!(".{}", self.domain))?;

        // From the right: the signature, then the port, then whatever is left
        // is the session. Splitting from the left would break the day an id
        // contains a hyphen.
        let (rest, signature) = label.rsplit_once('-')?;
        let (session, port) = rest.rsplit_once('-')?;

        let preview = Preview {
            session: session_of(session),
            port: port.parse().ok()?,
        };

        // Constant time: this is a credential on a public deployment, and a
        // comparison that returns early is a comparison that can be measured.
        let expected = self.sign(&preview);
        if constant_time_eq(expected.as_bytes(), signature.as_bytes()) {
            Some(preview)
        } else {
            None
        }
    }

    fn sign(&self, preview: &Preview) -> String {
        use hmac::Mac;

        let mut mac = <hmac::Hmac<sha2::Sha256>>::new_from_slice(&self.key)
            .expect("HMAC accepts any key length");
        // Length-prefixed, so ("s_ab", 1) and ("s_a", 91) cannot collide into
        // one digest.
        for part in [preview.session.as_str().as_bytes(), &preview.port.to_be_bytes()] {
            mac.update(&(part.len() as u64).to_be_bytes());
            mac.update(part);
        }

        base32(&mac.finalize().into_bytes()[..SIGNATURE_BYTES])
    }
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

    #[test]
    fn a_name_survives_the_round_trip() {
        let names = names();
        let host = names.host(&preview());
        assert_eq!(names.resolve(&host), Some(preview()));
    }

    /// The browser sends the port it connected to along with the name.
    #[test]
    fn a_name_resolves_with_a_port_on_it() {
        let names = names();
        let host = format!("{}:8080", names.host(&preview()));
        assert_eq!(names.resolve(&host), Some(preview()));
    }

    /// A hostname is a hostname: no underscores, nothing over 63 characters,
    /// and nothing a resolver would refuse.
    #[test]
    fn a_name_is_a_legal_hostname() {
        let host = names().host(&preview());
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
        assert_eq!(names.resolve(&host), Some(preview()));
        // And a name for the wrong domain is not ours, however well signed.
        assert_eq!(Names::new([7u8; 32], "localhost").resolve(&host), None);
    }

    #[test]
    fn the_url_carries_the_callers_scheme() {
        let names = names();
        assert!(names.url("https", &preview()).starts_with("https://"));
        assert!(names.url("http", &preview()).ends_with("/"));
    }
}
