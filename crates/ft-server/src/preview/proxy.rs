//! Serving a preview hostname.
//!
//! An ordinary reverse proxy. The only unusual part is that its socket is a
//! [`TunnelStream`] rather than a TCP connection, and that is hidden behind one
//! type — so everything here is the boring, well-understood shape, and hyper
//! does the HTTP rather than us doing it again and worse.
//!
//! **One tunnel per request.** A pool would save a round trip to the worker per
//! asset, and it is the first thing to reach for if a page load feels slow over
//! ssh. It is not here yet because a tunnel that is reused has to be proved
//! clean between requests, and one that is not reused cannot be dirty.

use super::{Names, Preview, TunnelStream};
use crate::AppState;
use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use hyper_util::rt::TokioIo;

/// How long to wait for the far end to answer at all.
///
/// A dev server rebuilding can take a while to reply, so this is generous. It
/// exists to stop a request hanging forever on a worker that has gone quiet,
/// not to police how slow an application is allowed to be.
const HEADERS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Answer a request addressed to a preview hostname.
pub async fn serve(state: AppState, preview: Preview, mut request: Request) -> Response {
    let session = match state.db.session(&preview.session).await {
        Ok(Some(session)) => session,
        // A signed name for a session that has been torn down. The signature
        // was valid; there is simply nothing behind it any more.
        Ok(None) => return gone("That session has been torn down."),
        Err(e) => {
            tracing::error!("looking up a preview's session: {e:#}");
            return gone("Firetower could not look up that session.");
        }
    };

    if session.status == ft_core::SessionStatus::Ended {
        return gone("That session has ended.");
    }

    let tunnel = match state
        .fleet
        .open_tunnel(&session.host_id, &preview.session, preview.port)
        .await
    {
        Ok(Ok(tunnel)) => tunnel,
        // Almost always "nothing is listening on 3000 in this workspace",
        // which is a sentence somebody can act on.
        Ok(Err(refused)) => return gone(&refused),
        Err(e) => {
            tracing::warn!(port = preview.port, "reaching a preview: {e:#}");
            return gone("The worker for this session isn't answering.");
        }
    };

    // The far end is a dev server on loopback that believes it is being
    // reached directly. Telling it our public hostname would have it write
    // that into its redirects and its generated links.
    let authority = format!("localhost:{}", preview.port);
    request.headers_mut().insert(
        header::HOST,
        HeaderValue::from_str(&authority).expect("a host and a port are always a valid header"),
    );

    // Whether this is a websocket, decided before the request is consumed.
    let upgrading = wants_upgrade(&request);
    let upgrade_from = upgrading.then(|| hyper::upgrade::on(&mut request));

    let (mut sender, connection) =
        match hyper::client::conn::http1::Builder::new()
            .preserve_header_case(true)
            .title_case_headers(true)
            .handshake(TokioIo::new(TunnelStream::new(tunnel)))
            .await
        {
            Ok(pair) => pair,
            Err(e) => {
                tracing::warn!(port = preview.port, "starting HTTP over a tunnel: {e}");
                return gone("Firetower could not speak HTTP to that port.");
            }
        };

    // Drives the connection while the request is in flight. `with_upgrades`
    // because a 101 hands the socket over afterwards, and without it hyper
    // closes the connection instead.
    tokio::spawn(async move {
        if let Err(e) = connection.with_upgrades().await {
            tracing::debug!("a preview connection ended: {e}");
        }
    });

    let sent = tokio::time::timeout(HEADERS_TIMEOUT, sender.send_request(request)).await;

    let mut answer = match sent {
        Ok(Ok(answer)) => answer,
        Ok(Err(e)) => {
            tracing::debug!(port = preview.port, "a preview request failed: {e}");
            return gone("The application closed the connection.");
        }
        Err(_) => return gone("The application did not answer."),
    };

    // A websocket, or any other upgrade: hand the two ends to each other and
    // stop being an HTTP proxy. This is what hot reload rides on.
    if answer.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(from_browser) = upgrade_from {
            let to_application = hyper::upgrade::on(&mut answer);
            tokio::spawn(async move {
                match tokio::try_join!(from_browser, to_application) {
                    Ok((browser, application)) => {
                        let mut browser = TokioIo::new(browser);
                        let mut application = TokioIo::new(application);
                        // Neither end speaks HTTP any more, so neither do we.
                        let _ =
                            tokio::io::copy_bidirectional(&mut browser, &mut application).await;
                    }
                    Err(e) => tracing::debug!("a preview upgrade did not complete: {e}"),
                }
            });
        }
    }

    answer.map(Body::new).into_response()
}

/// Whether the client asked to stop speaking HTTP.
fn wants_upgrade(request: &Request) -> bool {
    request
        .headers()
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        // `Connection: keep-alive, Upgrade` is legal, so this is a list.
        .is_some_and(|v| {
            v.split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
        })
        && request.headers().contains_key(header::UPGRADE)
}

/// A page, rather than a blank frame.
///
/// The worst outcome for a preview is white and silent, and it is the easiest
/// one to ship by accident. Whatever went wrong, it says so in a sentence — in
/// an `iframe` as readily as in a tab.
fn gone(why: &str) -> Response {
    let page = format!(
        "<!doctype html><meta charset=utf-8>\
         <title>No preview</title>\
         <style>\
           html{{background:#131313;color:#e8e4dc;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}}\
           div{{max-width:44ch;margin:18vh auto;padding:0 2rem}}\
           p{{color:#8b8681;margin:.5rem 0 0}}\
         </style>\
         <div><strong>{}</strong><p>Firetower is reaching this through the \
         session&rsquo;s worker. Nothing is published, so there is nothing to \
         open directly.</p></div>",
        html_escape(why)
    );

    (
        // Not 404: the address is right and the signature checked out. What is
        // missing is on the other side.
        StatusCode::BAD_GATEWAY,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        page,
    )
        .into_response()
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The scheme the browser used, for building a URL it can open.
///
/// Behind Caddy this process is always spoken to over plain HTTP, so its own
/// connection says nothing. `X-Forwarded-Proto` is what the proxy in front
/// sets, and it is the only thing that knows.
pub fn scheme_of(request: &Request) -> &'static str {
    let forwarded = request
        .headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if forwarded.eq_ignore_ascii_case("https") {
        "https"
    } else {
        "http"
    }
}

/// Whether a request is addressed to a preview rather than to Firetower.
pub fn addressed_to(names: &Names, request: &Request) -> Option<Preview> {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())?;

    names.resolve(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;

    fn names() -> Names {
        Names::new([7u8; 32], "localhost")
    }

    fn with_host(host: &str) -> Request {
        HttpRequest::builder()
            .header(header::HOST, host)
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn the_interfaces_own_requests_are_not_previews() {
        assert!(addressed_to(&names(), &with_host("localhost")).is_none());
        assert!(addressed_to(&names(), &with_host("localhost:4400")).is_none());
    }

    #[test]
    fn a_signed_hostname_is_a_preview() {
        let names = names();
        let preview = Preview {
            session: ft_core::SessionId::from_stored("s_01m1c0f9a3hgm99t4vfam429m3"),
            port: 3000,
        };

        let found = addressed_to(&names, &with_host(&names.host(&preview)));
        assert_eq!(found, Some(preview));
    }

    /// `Connection: keep-alive, Upgrade` is legal and common, so the header is
    /// a list rather than a word.
    #[test]
    fn an_upgrade_is_recognised_in_a_list() {
        let request = HttpRequest::builder()
            .header(header::CONNECTION, "keep-alive, Upgrade")
            .header(header::UPGRADE, "websocket")
            .body(Body::empty())
            .unwrap();
        assert!(wants_upgrade(&request));

        let request = HttpRequest::builder()
            .header(header::CONNECTION, "keep-alive")
            .body(Body::empty())
            .unwrap();
        assert!(!wants_upgrade(&request));

        // `Connection: Upgrade` with nothing to upgrade to is not an upgrade.
        let request = HttpRequest::builder()
            .header(header::CONNECTION, "Upgrade")
            .body(Body::empty())
            .unwrap();
        assert!(!wants_upgrade(&request));
    }

    #[test]
    fn the_scheme_comes_from_the_proxy_in_front() {
        let https = HttpRequest::builder()
            .header("x-forwarded-proto", "https")
            .body(Body::empty())
            .unwrap();
        assert_eq!(scheme_of(&https), "https");

        assert_eq!(scheme_of(&with_host("localhost")), "http");
    }

    /// The failure page is a page, and it does not carry text through unescaped.
    #[test]
    fn a_failure_says_so_in_a_sentence() {
        let response = gone("nothing is listening on 3000 <script>");
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn what_a_failure_says_is_escaped() {
        assert_eq!(html_escape("a <b> & c"), "a &lt;b&gt; &amp; c");
    }
}

/// The proxy against a real worker and a real HTTP server.
///
/// The unit tests above cover the parsing; this covers the thing that actually
/// has to work — a request arriving at a hostname and an answer coming back
/// from a port that is only reachable through the pipe.
#[cfg(test)]
mod end_to_end {
    use super::*;
    use crate::fleet::Fleet;
    use ft_core::SessionId;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Stands in for a dev server: answers with a fixed body and closes.
    async fn server(body: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut seen = [0u8; 2048];
                    let _ = socket.read(&mut seen).await;
                    let answer = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(answer.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        port
    }

    async fn tunnel_to(port: u16) -> (Fleet, ft_core::HostId, SessionId) {
        let (db, _owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local)
            .await
            .unwrap();
        let fleet = Fleet::new(db);
        fleet
            .supervise(host.id.clone(), crate::forward::testing::worker())
            .await;
        let _ = port;
        (fleet, host.id, SessionId::from_stored("s_abc"))
    }

    /// The whole path, minus the database lookup: a hostname, a tunnel, and an
    /// application's own bytes coming back through hyper.
    #[tokio::test]
    async fn a_request_over_a_tunnel_gets_the_applications_answer() {
        let port = server("hello from the session").await;
        let (fleet, host, session) = tunnel_to(port).await;

        let tunnel = fleet
            .open_tunnel(&host, &session, port)
            .await
            .expect("the host answered")
            .expect("something is listening");

        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(
            crate::preview::TunnelStream::new(tunnel),
        ))
        .await
        .expect("HTTP over a tunnel");

        tokio::spawn(connection);

        let request = axum::http::Request::builder()
            .uri("/")
            .header(header::HOST, format!("localhost:{port}"))
            .body(Body::empty())
            .unwrap();

        let answer = sender.send_request(request).await.expect("an answer");
        assert_eq!(answer.status(), StatusCode::OK);

        let body = axum::body::to_bytes(Body::new(answer.into_body()), 64 * 1024)
            .await
            .unwrap();
        assert_eq!(&body[..], b"hello from the session");
    }

    /// A port with nothing on it is a sentence, not a blank page.
    #[tokio::test]
    async fn a_port_with_nothing_on_it_refuses() {
        let (fleet, host, session) = tunnel_to(1).await;

        let refused = match fleet.open_tunnel(&host, &session, 1).await {
            Ok(Err(refused)) => refused,
            Ok(Ok(_)) => panic!("something answered on port 1"),
            Err(e) => panic!("the host did not answer: {e:#}"),
        };

        assert!(refused.contains("nothing is listening"), "{refused}");
    }

    /// Bodies larger than one frame arrive whole and in order — the read path
    /// has to carry what would not fit into the last buffer.
    #[tokio::test]
    async fn a_body_larger_than_one_frame_arrives_whole() {
        let body: &'static str = Box::leak("abcdefghij".repeat(20_000).into_boxed_str());
        let port = server(body).await;
        let (fleet, host, session) = tunnel_to(port).await;

        let tunnel = fleet
            .open_tunnel(&host, &session, port)
            .await
            .unwrap()
            .unwrap();

        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(
            crate::preview::TunnelStream::new(tunnel),
        ))
        .await
        .unwrap();
        tokio::spawn(connection);

        let request = axum::http::Request::builder()
            .uri("/")
            .header(header::HOST, "localhost")
            .body(Body::empty())
            .unwrap();

        let answer = sender.send_request(request).await.unwrap();
        let got = axum::body::to_bytes(Body::new(answer.into_body()), 4 * 1024 * 1024)
            .await
            .unwrap();

        assert_eq!(got.len(), body.len());
        assert_eq!(&got[..], body.as_bytes());
    }
}
