//! A port on this machine, standing in for one inside a session.
//!
//! The whole feature, and it does not know what HTTP is. A listener on
//! loopback, and for each connection a [`Tunnel`] carrying the bytes to a port
//! inside the worker's container. Nothing is parsed, nothing is rewritten,
//! nothing is injected.
//!
//! **Why a real port rather than a path under the interface.** Serving an
//! application at `/preview/<session>/3000/` means rewriting what it says: a
//! `<base>` tag for its relative URLs, its `Location` headers, and a guess from
//! the `Referer` for everything root-relative. The first client-side
//! `history.pushState("/dashboard")` then moves the page out of the prefix and
//! the guess stops working. A real port has an origin of its own, so there is
//! nothing to rewrite and nothing to break — client-side routers, service
//! workers and hot-reload sockets all work because none of them can tell.
//!
//! **And the port number is the same one.** A frontend that talks to its
//! backend at `http://localhost:8000` is normally unfixable from a remote
//! machine. Forward the worker's `:8000` onto this machine's `:8000` and the
//! hardcoded address is simply correct.
//!
//! **The one topology this does not serve** is a control plane that is not on
//! the machine holding the browser. The port would be opened next to the
//! control plane, where nobody is looking. [`Forwards::available_here`] is how
//! the interface knows not to offer it.

use crate::fleet::Fleet;
use anyhow::{Context, Result};
use ft_core::{HostId, SessionId};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, RwLock};

/// How much is read from a local socket at once.
///
/// Matches the tunnel's frame size, so a full buffer is one frame rather than
/// one frame and a remainder.
const READ: usize = 32 * 1024;

/// A port on this machine, and the one inside the session it stands for.
#[derive(Clone, Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Forwarded {
    /// The port inside the session's workspace.
    pub port: u16,
    /// What was actually bound here.
    ///
    /// The same number whenever it can be — see [`Forwards::start`]. When it
    /// is not, an application that hardcodes its own address will not find
    /// itself, and whoever is looking has to be told.
    pub local: u16,
    /// Ready to paste, because that is what it is for.
    pub url: String,
}

struct Live {
    forwarded: Forwarded,
    /// Dropping this stops the listener and every connection through it.
    _stop: oneshot::Sender<()>,
}

/// Every port this control plane is holding open on behalf of a session.
#[derive(Default)]
pub struct Forwards {
    live: RwLock<HashMap<(String, u16), Live>>,
}

impl Forwards {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind a local port for `port` inside `session`, and start accepting.
    ///
    /// Connects once before returning, so "nothing is listening on 3000" is an
    /// answer to the button press rather than a page that never loads.
    pub async fn start(
        &self,
        fleet: &Fleet,
        host: &HostId,
        session: &SessionId,
        port: u16,
    ) -> Result<Result<Forwarded, String>> {
        if let Some(live) = self.live.read().await.get(&(session.to_string(), port)) {
            return Ok(Ok(live.forwarded.clone()));
        }

        // Ask first. A listener bound before we know the far end exists is a
        // port on this machine that accepts connections and then fails them.
        match fleet.open_tunnel(host, session, port).await? {
            Ok(_probe) => {}
            Err(refused) => return Ok(Err(refused)),
        }

        // The same number, whenever this machine will give it. That is what
        // makes an application's own hardcoded `localhost:8000` correct rather
        // than merely reachable.
        let listener = match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => listener,
            // Taken here, which on a machine also running the dev server is
            // normal. Any port beats none, and the caller says which.
            Err(_) => TcpListener::bind(("127.0.0.1", 0))
                .await
                .context("no port on this machine could be bound")?,
        };

        let local = listener.local_addr()?.port();
        let (stop, stopped) = oneshot::channel();

        tokio::spawn(accept(
            listener,
            fleet.clone(),
            host.clone(),
            session.clone(),
            port,
            stopped,
        ));

        tracing::info!(
            session = %session,
            remote = port,
            local,
            "forwarding a port from this session"
        );

        let forwarded = Forwarded {
            port,
            local,
            // Loopback by name: what somebody pastes should look like what they
            // would have typed if the application were running here, because as
            // far as the browser is concerned it is.
            url: format!("http://localhost:{local}"),
        };

        self.live.write().await.insert(
            (session.to_string(), port),
            Live {
                forwarded: forwarded.clone(),
                _stop: stop,
            },
        );

        Ok(Ok(forwarded))
    }

    pub async fn list(&self, session: &SessionId) -> Vec<Forwarded> {
        let live = self.live.read().await;
        let mut open: Vec<Forwarded> = live
            .iter()
            .filter(|((id, _), _)| id == session.as_str())
            .map(|(_, live)| live.forwarded.clone())
            .collect();
        open.sort_by_key(|f| f.port);
        open
    }

    pub async fn stop(&self, session: &SessionId, port: u16) -> bool {
        self.live
            .write()
            .await
            .remove(&(session.to_string(), port))
            .is_some()
    }

    /// Everything belonging to a session that is going away.
    pub async fn stop_session(&self, session: &SessionId) {
        self.live
            .write()
            .await
            .retain(|(id, _), _| id != session.as_str());
    }

    /// Whether a forwarded port would be any use to whoever is looking.
    ///
    /// A port is opened beside the control plane. When that is also where the
    /// browser is, it is exactly what is wanted. When the control plane is on a
    /// team's server, the port is opened there — and telling somebody to visit
    /// `localhost:3000` would send them to their own machine, where there is
    /// either nothing or, worse, something else of theirs.
    ///
    /// So the interface asks, and the honest signal is the address the
    /// interface was loaded from: a page served from loopback came from a
    /// control plane on this machine.
    ///
    /// **Where this is wrong**, and knowingly: somebody reaching a remote
    /// control plane through `ssh -L 4400:localhost:4400` also sees a loopback
    /// address, and the port would be opened at the far end. Nothing in a
    /// request can tell that apart from a browser on this machine. It is left
    /// as a false positive rather than guessed at, because the recovery is the
    /// thing they are already doing — forward the application's port the same
    /// way — and a wrong guess in the other direction would hide the feature
    /// from everybody running Firetower on their own laptop.
    /// Whether this control plane is inside a container.
    ///
    /// It matters because a container's `127.0.0.1` is not the browser's, and
    /// a container cannot gain a published port while it is running — so a
    /// port bound in here reaches nobody, however local the request looked.
    ///
    /// Asked of the filesystem rather than guessed from a header: `/.dockerenv`
    /// is written by Docker into every container it creates, and the
    /// deployment knowing what it is beats us inferring it from how we were
    /// addressed. That inference is exactly what got this wrong.
    pub fn in_a_container() -> bool {
        std::path::Path::new("/.dockerenv").exists()
    }

    pub fn available_here(host_header: Option<&str>) -> bool {
        let Some(host) = host_header else {
            return false;
        };

        // `[::1]:4400`, `127.0.0.1:4400`, `localhost:4400`, or no port at all.
        let name = match host.rsplit_once(':') {
            Some((name, _)) if !name.is_empty() && !name.ends_with(']') => name,
            Some((name, _)) => name,
            None => host,
        };
        let name = name.trim_start_matches('[').trim_end_matches(']');

        name.eq_ignore_ascii_case("localhost")
            || name == "127.0.0.1"
            || name == "::1"
            || name.starts_with("127.")
    }
}

/// Accept until told to stop, giving every connection its own tunnel.
async fn accept(
    listener: TcpListener,
    fleet: Fleet,
    host: HostId,
    session: SessionId,
    port: u16,
    stopped: oneshot::Receiver<()>,
) {
    tokio::pin!(stopped);

    loop {
        tokio::select! {
            // Dropped, or told to stop. Either way the listener goes with it.
            _ = &mut stopped => return,

            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { return };
                let fleet = fleet.clone();
                let host = host.clone();
                let session = session.clone();

                tokio::spawn(async move {
                    match carry(socket, fleet, host, session, port).await {
                        Ok(()) => {}
                        // The far end is gone, or was never there. Said out
                        // loud: on a remote worker this is the difference
                        // between "the dev server stopped" and "the pipe
                        // broke", and a browser only shows an empty frame for
                        // both.
                        Err(Ended::Refused(why)) => {
                            tracing::warn!(port, "a preview connection could not be opened: {why}")
                        }
                        // A browser closing a tab mid-request is normal and
                        // constant. This is not news, it is a trace.
                        Err(Ended::Interrupted(e)) => {
                            tracing::debug!(port, "a preview connection ended: {e:#}")
                        }
                    }
                });
            }
        }
    }
}

/// Why one forwarded connection stopped.
///
/// Two cases and they are not alike: one is somebody closing a tab, the other
/// is the application or the pipe being gone. A browser draws an empty frame
/// for both, so the log has to tell them apart.
enum Ended {
    /// There was nothing to connect to, or no way to ask.
    Refused(String),
    /// It was carrying bytes and stopped.
    Interrupted(anyhow::Error),
}

impl From<anyhow::Error> for Ended {
    fn from(e: anyhow::Error) -> Self {
        Self::Interrupted(e)
    }
}

/// One local connection, one tunnel, bytes both ways until either ends.
async fn carry(
    socket: TcpStream,
    fleet: Fleet,
    host: HostId,
    session: SessionId,
    port: u16,
) -> Result<(), Ended> {
    // Nagle would hold a small write for up to 40ms hoping for company. Every
    // write here is a hop of a request somebody is waiting on.
    let _ = socket.set_nodelay(true);

    let tunnel = match fleet.open_tunnel(&host, &session, port).await {
        Ok(Ok(tunnel)) => tunnel,
        // The application stopped, or was restarted between one request and
        // the next — which during development is most of the time.
        Ok(Err(refused)) => return Err(Ended::Refused(refused)),
        // No way to ask at all: the host is not answering.
        Err(e) => return Err(Ended::Refused(format!("{e:#}"))),
    };

    let (mut incoming, outgoing) = tunnel.split();
    let (mut from_browser, mut to_browser) = socket.into_split();

    // Up and down at once, because a response can begin before a request has
    // finished arriving — which is what a websocket is, all the time.
    let up = async {
        let mut buffer = vec![0u8; READ];
        loop {
            let read = from_browser.read(&mut buffer).await?;
            if read == 0 {
                // The end of a request body, not a hang-up. The far end still
                // has an answer to write.
                outgoing.half_close().await?;
                return Ok::<(), anyhow::Error>(());
            }
            outgoing.send(&buffer[..read]).await?;
        }
    };

    let down = async {
        while let Some(bytes) = incoming.recv().await {
            to_browser.write_all(&bytes).await?;
        }
        let _ = to_browser.shutdown().await;
        Ok::<(), anyhow::Error>(())
    };

    // The response finishing is what ends this. A request half that is still
    // waiting on a browser that has gone quiet must not hold the connection
    // open behind it.
    tokio::pin!(up, down);
    tokio::select! {
        result = &mut down => result?,
        result = &mut up => {
            result?;
            down.await?;
        }
    }

    Ok(())
}

/// A worker that speaks the tunnel frames, for tests in this crate.
#[cfg(test)]
pub mod testing {
    use crate::transport::{Connection, Transport};
    use anyhow::{Context, Result};
    use ft_proto::{Codec, ToServer, ToWorker, PROTOCOL_VERSION};
    use std::sync::Arc;

    pub fn worker() -> Arc<Worker> {
        Worker::new()
    }

    /// Uses the real `ft_worker::tunnel`, not a stand-in that would only prove
    /// the stand-in works. Everything else a worker does is answered with
    /// silence.
    pub struct Worker {
        once: std::sync::Mutex<Option<Connection>>,
    }

    impl Worker {
        fn new() -> Arc<Self> {
            let (ours, theirs) = tokio::io::duplex(64 * 1024);

            tokio::spawn(async move {
                let tunnels = Arc::new(ft_worker::tunnel::Tunnels::new());
                let (r, w) = tokio::io::split(theirs);
                let (mut inbound, mut outbound) = Codec::new(r, w).split();
                let (out, mut pending) = tokio::sync::mpsc::channel::<ToServer>(256);

                loop {
                    tokio::select! {
                        Some(frame) = pending.recv() => {
                            if outbound.write(&frame).await.is_err() { return; }
                        }
                        incoming = inbound.read::<ToWorker>() => {
                            let Ok(frame) = incoming else { return };
                            match frame {
                                ToWorker::Hello { .. } => {
                                    let _ = out.send(ToServer::Hello {
                                        protocol: PROTOCOL_VERSION,
                                        worker_version: "0.1.0".into(),
                                        arch: "test".into(),
                                        cpus: 1,
                                        memory_mb: 0,
                                    }).await;
                                }
                                ToWorker::Ping => { let _ = out.send(ToServer::Pong).await; }
                                ToWorker::TunnelOpen { tunnel, session_id, port } => {
                                    tunnels.open(tunnel, session_id, port, &out).await;
                                }
                                ToWorker::TunnelData { tunnel, data } => {
                                    if let Some(bytes) = data.bytes() {
                                        tunnels.write(&tunnel, bytes).await;
                                    }
                                }
                                ToWorker::TunnelCredit { tunnel, bytes } => {
                                    tunnels.grant(&tunnel, bytes).await;
                                }
                                ToWorker::TunnelClose { tunnel, half } => {
                                    if half {
                                        tunnels.half_close(&tunnel).await;
                                    } else {
                                        tunnels.close(&tunnel).await;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            });

            let (r, w) = tokio::io::split(ours);
            Arc::new(Self {
                once: std::sync::Mutex::new(Some(Connection::piped(Box::new(r), Box::new(w)))),
            })
        }
    }

    #[async_trait::async_trait]
    impl Transport for Worker {
        fn describe(&self) -> String {
            "a worker that carries tunnels".to_string()
        }
        async fn connect(&self) -> Result<Connection> {
            self.once
                .lock()
                .unwrap()
                .take()
                .context("this worker can only be connected to once")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    /// A connected fleet and a host to ask things of.
    async fn fleet() -> (Fleet, HostId) {
        let (db, _owner) = Db::open_for_test_owned().await.unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local)
            .await
            .unwrap();
        let fleet = Fleet::new(db);
        fleet.supervise(host.id.clone(), super::testing::worker()).await;
        (fleet, host.id)
    }

    /// Stands in for the dev server: answers anything with a fixed body and
    /// closes, which is what makes the read side terminate.
    async fn server(body: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut seen = [0u8; 1024];
                    let _ = socket.read(&mut seen).await;
                    let answer = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(answer.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });

        port
    }

    /// The whole feature, end to end: a port inside a session, reached through
    /// the pipe, answered on a port of this machine.
    #[tokio::test]
    async fn a_forwarded_port_answers_what_the_session_is_serving() {
        let (fleet, host) = fleet().await;
        let session = SessionId::from_stored("s_abc");
        let port = server("hello from the session").await;

        let forwards = Forwards::new();
        let forwarded = forwards
            .start(&fleet, &host, &session, port)
            .await
            .expect("the host answered")
            .expect("something is listening");

        // Deliberately not asserting `local == port` here, and the reason is
        // the whole point of the feature: in this test the "dev server" is on
        // this machine's loopback, so the number it wants is the number it is
        // already using and the fallback takes over. On a real worker the
        // server is inside a container that publishes nothing, so the number is
        // free out here and gets reused. What is checkable in-process is that
        // the fallback happens and is reported — see the test below.

        let mut socket = TcpStream::connect(("127.0.0.1", forwarded.local))
            .await
            .unwrap();
        socket
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();

        let mut answer = Vec::new();
        socket.read_to_end(&mut answer).await.unwrap();
        let answer = String::from_utf8_lossy(&answer);

        assert!(answer.starts_with("HTTP/1.1 200 OK"), "{answer}");
        assert!(answer.ends_with("hello from the session"), "{answer}");
    }

    /// A port already spoken for here still gets forwarded, on another number,
    /// and the difference is visible.
    ///
    /// Silence would be the bad outcome: an application that hardcodes its own
    /// address will not find itself on a different one, and somebody has to be
    /// able to see why.
    #[tokio::test]
    async fn a_port_taken_on_this_machine_falls_back_and_says_so() {
        let (fleet, host) = fleet().await;
        let session = SessionId::from_stored("s_abc");
        // Bound here, which is exactly the collision: this stands in for
        // something else of yours already using that number.
        let port = server("hello").await;

        let forwards = Forwards::new();
        let forwarded = forwards
            .start(&fleet, &host, &session, port)
            .await
            .unwrap()
            .unwrap();

        assert_ne!(forwarded.local, forwarded.port);
        assert!(forwarded.url.contains(&forwarded.local.to_string()));
    }

    /// The common case, and the one that must not be a blank page.
    #[tokio::test]
    async fn a_port_with_nothing_on_it_refuses_before_anything_is_bound() {
        let (fleet, host) = fleet().await;
        let session = SessionId::from_stored("s_abc");

        // Port 1, rather than one bound and dropped to find a free number: the
        // free number comes from the ephemeral range that every other test here
        // is binding into, and one of them takes it before this connects.
        // Nothing takes port 1 without being root.
        let port = 1;

        let forwards = Forwards::new();
        let refused = forwards
            .start(&fleet, &host, &session, port)
            .await
            .expect("the host answered")
            .expect_err("nothing is listening");

        assert!(refused.contains("nothing is listening"), "{refused}");
        // And nothing was bound here either: a refusal that still left a
        // listener behind would accept connections and then fail them.
        assert!(forwards.list(&session).await.is_empty());
    }

    /// More than one at once, which is what a frontend and its backend are.
    #[tokio::test]
    async fn two_ports_are_two_forwards_and_no_configuration() {
        let (fleet, host) = fleet().await;
        let session = SessionId::from_stored("s_abc");
        let (front, back) = (server("the frontend").await, server("the backend").await);

        let forwards = Forwards::new();
        for port in [front, back] {
            forwards
                .start(&fleet, &host, &session, port)
                .await
                .unwrap()
                .unwrap();
        }

        let open = forwards.list(&session).await;
        assert_eq!(open.len(), 2);

        for (port, expected) in [(front, "the frontend"), (back, "the backend")] {
            let local = open.iter().find(|f| f.port == port).unwrap().local;
            let mut socket = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
            socket.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
            let mut answer = String::new();
            socket.read_to_string(&mut answer).await.unwrap();
            assert!(answer.ends_with(expected), "{answer}");
        }
    }

    /// Asking twice is the same port, not a second one. The tab does this on
    /// every mount.
    #[tokio::test]
    async fn opening_a_port_that_is_already_open_is_the_one_that_is_open() {
        let (fleet, host) = fleet().await;
        let session = SessionId::from_stored("s_abc");
        let port = server("hello").await;

        let forwards = Forwards::new();
        let first = forwards
            .start(&fleet, &host, &session, port)
            .await
            .unwrap()
            .unwrap();
        let again = forwards
            .start(&fleet, &host, &session, port)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(first.local, again.local);
        assert_eq!(forwards.list(&session).await.len(), 1);
    }

    /// A workspace being torn down takes its ports with it.
    #[tokio::test]
    async fn ending_a_session_closes_its_ports() {
        let (fleet, host) = fleet().await;
        let session = SessionId::from_stored("s_abc");
        let port = server("hello").await;

        let forwards = Forwards::new();
        let forwarded = forwards
            .start(&fleet, &host, &session, port)
            .await
            .unwrap()
            .unwrap();

        forwards.stop_session(&session).await;
        assert!(forwards.list(&session).await.is_empty());

        // The listener goes with it, so the number is free again.
        let freed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if TcpListener::bind(("127.0.0.1", forwarded.local)).await.is_ok() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        assert!(freed.is_ok(), "the forwarded port was still bound");
    }

    #[test]
    fn a_control_plane_on_this_machine_is_recognised() {
        for host in [
            "localhost:4400",
            "127.0.0.1:4400",
            "localhost",
            "127.0.0.1",
            "[::1]:4400",
            "LocalHost:4400",
            "127.0.1.1:4400",
        ] {
            assert!(Forwards::available_here(Some(host)), "{host}");
        }
    }

    /// The failure this exists to prevent: telling somebody at a team
    /// deployment to open `localhost:3000`, which is their own machine.
    #[test]
    fn a_control_plane_somewhere_else_is_not() {
        for host in [
            "firetower.team",
            "firetower.team:4400",
            "10.0.0.7:4400",
            "100.64.1.5:4400",
            "notlocalhost.com",
        ] {
            assert!(!Forwards::available_here(Some(host)), "{host}");
        }

        assert!(!Forwards::available_here(None));
    }
}
