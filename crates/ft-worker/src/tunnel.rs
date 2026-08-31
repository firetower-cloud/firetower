//! Raw TCP, over the connection that already exists.
//!
//! A session runs a dev server on a port inside this container. Nothing is
//! published, there is no route to it, and that is the property the whole
//! product rests on — so the bytes travel the way everything else does: as
//! frames, up the pipe the control plane is already holding.
//!
//! **The worker connects to `127.0.0.1` and only ever to `127.0.0.1`.**
//! [`ft_proto::ToWorker::TunnelOpen`] carries a port and no host, so a bug in a
//! URL somewhere upstream cannot ask a worker to reach anything but itself.
//! That is one line of code and it makes a class of mistake unrepresentable
//! rather than merely unlikely.
//!
//! **Why credit.** One pipe carries every terminal, every conversation and now
//! every page load on this machine. A dev server answers faster than a browser
//! reads, so without a limit the frames pile up in the control plane's memory
//! or stall the single loop that also carries the terminals. A tunnel may send
//! [`WINDOW`] bytes before the control plane says it has drained some; out of
//! credit, the reader stops reading its socket and the dev server feels it
//! through TCP, which is where backpressure is supposed to end up.

use ft_core::SessionId;
use ft_proto::{Payload, ToServer, TunnelId};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex, Notify};

/// How much a tunnel may send before hearing that any of it was drained.
///
/// Eight chunks. Enough that a fast response is not sending one frame per
/// round trip, small enough that ten tunnels at once are megabytes rather than
/// tens of them.
const WINDOW: u32 = 256 * 1024;

/// How much goes in one frame.
///
/// An eighth of [`super::CHUNK`], because a download is one stream and a page
/// load is hundreds — the thing being protected here is somebody else's
/// terminal getting a turn between the pieces.
const CHUNK: usize = 32 * 1024;

/// How long to wait for a port to answer.
///
/// A connection to loopback either works immediately or is refused
/// immediately. Anything slower is a port being filtered, and waiting on it
/// only delays the sentence that says so.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);



/// Every tunnel this worker is holding open.
#[derive(Default)]
pub struct Tunnels {
    live: Mutex<HashMap<TunnelId, Live>>,
}

struct Live {
    /// Which session asked, so destroying it takes its tunnels with it.
    session: SessionId,
    /// Bytes from the control plane, on their way into the socket. Dropping
    /// this is the half-close: the socket's write half shuts down and its read
    /// half carries on.
    ///
    /// Unbounded, and safe to be: the control plane holds a window of its own
    /// and will not send more than [`WINDOW`] bytes before this end says it has
    /// written some. A bounded channel here would instead make a far end that
    /// stopped reading stall the serve loop — and with it every terminal and
    /// every agent on this machine.
    inbound: Option<mpsc::UnboundedSender<Vec<u8>>>,
    credit: Arc<Credit>,
    /// Stops the task reading the socket.
    reader: tokio::task::AbortHandle,
    /// Stops the task writing to it.
    writer: tokio::task::AbortHandle,
}

/// How many bytes this tunnel may still send.
struct Credit {
    left: Mutex<u32>,
    /// Woken when the control plane grants more.
    granted: Notify,
}

impl Credit {
    fn new() -> Self {
        Self {
            left: Mutex::new(WINDOW),
            granted: Notify::new(),
        }
    }

    /// Wait until there is room, then claim up to `most` bytes of it.
    ///
    /// Claimed rather than spent: a read that returns less than the budget
    /// gives the difference back, so a trickle of one-byte responses does not
    /// burn the window.
    async fn claim(&self, most: usize) -> usize {
        loop {
            {
                let mut left = self.left.lock().await;
                if *left > 0 {
                    let take = (*left as usize).min(most);
                    *left -= take as u32;
                    return take;
                }
            }
            self.granted.notified().await;
        }
    }

    async fn give_back(&self, bytes: u32) {
        if bytes == 0 {
            return;
        }
        *self.left.lock().await += bytes;
        self.granted.notify_waiters();
    }
}

impl Tunnels {
    pub fn new() -> Self {
        Self::default()
    }

    /// Connect to a port in this container and start pumping.
    ///
    /// Answers [`ToServer::TunnelOpened`] before any bytes, so a control plane
    /// can tell a browser "nothing is listening on 3000" instead of leaving it
    /// on a page that never loads.
    pub async fn open(
        self: &Arc<Self>,
        tunnel: TunnelId,
        session: SessionId,
        port: u16,
        out: &mpsc::Sender<ToServer>,
    ) {
        // Never a host. See the module comment.
        let connecting = TcpStream::connect(("127.0.0.1", port));

        let socket = match tokio::time::timeout(CONNECT_TIMEOUT, connecting).await {
            Ok(Ok(socket)) => socket,
            // The common case by far: the agent has not started the dev server
            // yet. It gets a sentence, not a stack trace.
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                let _ = out
                    .send(ToServer::TunnelOpened {
                        tunnel,
                        result: Err(format!("nothing is listening on {port} in this workspace")),
                    })
                    .await;
                return;
            }
            Ok(Err(e)) => {
                let _ = out
                    .send(ToServer::TunnelOpened {
                        tunnel,
                        result: Err(format!("reaching {port} in this workspace: {e}")),
                    })
                    .await;
                return;
            }
            Err(_) => {
                let _ = out
                    .send(ToServer::TunnelOpened {
                        tunnel,
                        result: Err(format!("{port} in this workspace did not answer")),
                    })
                    .await;
                return;
            }
        };

        // Every byte here is one hop of a request somebody is waiting on, and
        // Nagle holds a small write back for up to 40ms hoping for company.
        let _ = socket.set_nodelay(true);

        if out
            .send(ToServer::TunnelOpened {
                tunnel: tunnel.clone(),
                result: Ok(()),
            })
            .await
            .is_err()
        {
            return;
        }

        let (mut from_socket, mut to_socket) = socket.into_split();
        let credit = Arc::new(Credit::new());
        let (inbound, mut arriving) = mpsc::unbounded_channel::<Vec<u8>>();

        let writer = tokio::spawn({
            let out = out.clone();
            let tunnel = tunnel.clone();
            async move {
            while let Some(bytes) = arriving.recv().await {
                let wrote = bytes.len() as u32;
                if to_socket.write_all(&bytes).await.is_err() {
                    return;
                }
                // Only once the bytes are in the socket. Granting on arrival
                // would let the window run ahead of a far end that is not
                // reading, which is the thing it exists to prevent.
                let granted = ToServer::TunnelCredit {
                    tunnel: tunnel.clone(),
                    bytes: wrote,
                };
                if out.send(granted).await.is_err() {
                    return;
                }
            }
            // The channel closed, which is the control plane saying it has
            // nothing more to send. Half-close rather than hang up: the far end
            // still has an answer to finish writing, and that is exactly what
            // the end of a request body looks like.
            let _ = to_socket.shutdown().await;
            }
        });

        let reader = tokio::spawn({
            let out = out.clone();
            let tunnel = tunnel.clone();
            let credit = credit.clone();
            let tunnels = self.clone();
            async move {
                let mut buffer = vec![0u8; CHUNK];
                let reason = loop {
                    let budget = credit.claim(CHUNK).await;

                    match from_socket.read(&mut buffer[..budget]).await {
                        Ok(0) => {
                            credit.give_back(budget as u32).await;
                            break None;
                        }
                        Ok(read) => {
                            // Only what was actually sent is spent.
                            credit.give_back((budget - read) as u32).await;
                            let frame = ToServer::TunnelData {
                                tunnel: tunnel.clone(),
                                data: Payload::of(&buffer[..read]),
                            };
                            if out.send(frame).await.is_err() {
                                return;
                            }
                        }
                        Err(e) => {
                            credit.give_back(budget as u32).await;
                            break Some(format!("{e}"));
                        }
                    }
                };

                tunnels.forget(&tunnel).await;
                let _ = out.send(ToServer::TunnelClosed { tunnel, reason }).await;
            }
        });

        self.live.lock().await.insert(
            tunnel,
            Live {
                session,
                inbound: Some(inbound),
                credit,
                reader: reader.abort_handle(),
                writer: writer.abort_handle(),
            },
        );
    }

    /// Bytes from the control plane, into the socket.
    ///
    /// Never waits. What bounds this is the control plane's window, granted
    /// back by the writer task once the bytes are actually in the socket —
    /// waiting here would stall the loop that serves every session on this
    /// machine.
    pub async fn write(&self, tunnel: &str, bytes: Vec<u8>) {
        let live = self.live.lock().await;
        // A tunnel that ended while these bytes were in flight is common and
        // uninteresting: the far end hung up mid-request.
        if let Some(sender) = live.get(tunnel).and_then(|t| t.inbound.as_ref()) {
            let _ = sender.send(bytes);
        }
    }

    /// The control plane has drained some of what this tunnel sent.
    pub async fn grant(&self, tunnel: &str, bytes: u32) {
        let credit = {
            let live = self.live.lock().await;
            match live.get(tunnel) {
                Some(t) => t.credit.clone(),
                None => return,
            }
        };
        credit.give_back(bytes).await;
    }

    /// Nothing more is coming from the control plane.
    ///
    /// A half-close. The socket's read half stays open, so the answer to the
    /// request that just finished arriving can still come back.
    pub async fn half_close(&self, tunnel: &str) {
        if let Some(t) = self.live.lock().await.get_mut(tunnel) {
            t.inbound = None;
        }
    }

    /// Drop a tunnel and stop both its tasks.
    pub async fn close(&self, tunnel: &str) {
        if let Some(t) = self.live.lock().await.remove(tunnel) {
            t.reader.abort();
            t.writer.abort();
        }
    }

    /// Forget a tunnel whose socket ended on its own.
    ///
    /// Distinct from [`Self::close`]: the reader is the caller here, and
    /// aborting it would be aborting itself.
    async fn forget(&self, tunnel: &str) {
        if let Some(t) = self.live.lock().await.remove(tunnel) {
            t.writer.abort();
        }
    }

    /// Every tunnel belonging to a session that is going away.
    ///
    /// A workspace being torn down takes its ports with it, and a tunnel left
    /// pointing at one is a page that hangs rather than one that says so.
    pub async fn close_session(&self, session: &SessionId) {
        let mine: Vec<TunnelId> = {
            let live = self.live.lock().await;
            live.iter()
                .filter(|(_, t)| &t.session == session)
                .map(|(id, _)| id.clone())
                .collect()
        };

        for tunnel in mine {
            self.close(&tunnel).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn session() -> SessionId {
        SessionId::from_stored("s_abc")
    }

    /// Bind on loopback and hand back the port, so a test never guesses one.
    async fn echo() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = socket.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                    let _ = w.shutdown().await;
                });
            }
        });

        port
    }

    async fn next(rx: &mut mpsc::Receiver<ToServer>) -> ToServer {
        tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("a frame within five seconds")
            .expect("the sender is still up")
    }

    /// The next frame that is not the far end refunding the window.
    ///
    /// Credit is granted as bytes reach the socket, so it interleaves with
    /// everything else. A test about what came back should not have to know
    /// how many refunds happened to land first.
    async fn next_but_credit(rx: &mut mpsc::Receiver<ToServer>) -> ToServer {
        loop {
            match next(rx).await {
                ToServer::TunnelCredit { .. } => continue,
                other => return other,
            }
        }
    }

    #[tokio::test]
    async fn a_tunnel_carries_bytes_both_ways() {
        let port = echo().await;
        let tunnels = Arc::new(Tunnels::new());
        let (out, mut rx) = mpsc::channel(64);

        tunnels
            .open("t_1".into(), session(), port, &out)
            .await;

        assert!(matches!(
            next(&mut rx).await,
            ToServer::TunnelOpened { result: Ok(()), .. }
        ));

        tunnels.write("t_1", b"hello".to_vec()).await;

        match next_but_credit(&mut rx).await {
            ToServer::TunnelData { data, .. } => assert_eq!(data.bytes().unwrap(), b"hello"),
            other => panic!("{other:?}"),
        }
    }

    /// The control plane is told when bytes actually reached the far socket,
    /// so it knows it may send more.
    #[tokio::test]
    async fn writing_refunds_the_window() {
        let port = echo().await;
        let tunnels = Arc::new(Tunnels::new());
        let (out, mut rx) = mpsc::channel(64);

        tunnels.open("t_1".into(), session(), port, &out).await;
        let _ = next(&mut rx).await;

        tunnels.write("t_1", b"hello".to_vec()).await;

        let refunded = loop {
            if let ToServer::TunnelCredit { bytes, .. } = next(&mut rx).await {
                break bytes;
            }
        };
        assert_eq!(refunded, 5);
    }

    /// The common case: the agent has not started the dev server yet.
    #[tokio::test]
    async fn a_port_with_nothing_on_it_is_a_sentence() {
        // Port 1, rather than one bound and dropped to find a free number.
        // The free number comes from the ephemeral range, which is exactly
        // where every other test in this file is binding — so between dropping
        // it and connecting, one of them takes it and this fails claiming
        // something answered. Nothing can take port 1 without being root.
        let port = 1;

        let tunnels = Arc::new(Tunnels::new());
        let (out, mut rx) = mpsc::channel(64);

        tunnels.open("t_1".into(), session(), port, &out).await;

        match next(&mut rx).await {
            ToServer::TunnelOpened {
                result: Err(why), ..
            } => assert!(why.contains("nothing is listening"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    /// Half-closing is what tells a server the request is over. An echo server
    /// reading to end-of-input never answers without it.
    #[tokio::test]
    async fn a_half_close_ends_the_far_ends_read_but_not_its_answer() {
        let port = echo().await;
        let tunnels = Arc::new(Tunnels::new());
        let (out, mut rx) = mpsc::channel(64);

        tunnels.open("t_1".into(), session(), port, &out).await;
        let _ = next(&mut rx).await;

        tunnels.write("t_1", b"hello".to_vec()).await;
        tunnels.half_close("t_1").await;

        // The echo still comes back, and then the tunnel ends on its own.
        let mut seen = Vec::new();
        loop {
            match next(&mut rx).await {
                ToServer::TunnelCredit { .. } => continue,
                ToServer::TunnelData { data, .. } => seen.extend(data.bytes().unwrap()),
                ToServer::TunnelClosed { reason, .. } => {
                    assert!(reason.is_none(), "{reason:?}");
                    break;
                }
                other => panic!("{other:?}"),
            }
        }

        assert_eq!(seen, b"hello");
    }

    #[tokio::test]
    async fn destroying_a_session_takes_its_tunnels() {
        let port = echo().await;
        let tunnels = Arc::new(Tunnels::new());
        let (out, mut rx) = mpsc::channel(64);

        tunnels.open("t_1".into(), session(), port, &out).await;
        let _ = next(&mut rx).await;

        tunnels.close_session(&session()).await;

        assert!(tunnels.live.lock().await.is_empty());
        // Writing to a tunnel that is gone is ignored rather than a panic: the
        // bytes were in flight when it went.
        tunnels.write("t_1", b"hello".to_vec()).await;
    }

    /// A tunnel may not send more than the window before hearing back.
    #[tokio::test]
    async fn a_tunnel_stops_sending_when_it_runs_out_of_credit() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // Far more than the window, as fast as it will go.
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let block = vec![b'x'; 64 * 1024];
            loop {
                if socket.write_all(&block).await.is_err() {
                    return;
                }
            }
        });

        let tunnels = Arc::new(Tunnels::new());
        let (out, mut rx) = mpsc::channel(1024);

        tunnels.open("t_1".into(), session(), port, &out).await;
        let _ = next(&mut rx).await;

        // Drain what is offered until it stops coming. Without a window this
        // never settles, because the far end never stops writing.
        let mut sent = 0usize;
        while let Ok(Some(frame)) =
            tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await
        {
            if let ToServer::TunnelData { data, .. } = frame {
                sent += data.bytes().unwrap().len();
            }
        }

        assert!(sent > 0, "nothing came through at all");
        assert!(
            sent <= WINDOW as usize,
            "sent {sent} bytes without being asked for more; the window is {WINDOW}"
        );

        // And granting credit starts it again.
        tunnels.grant("t_1", WINDOW).await;
        match next(&mut rx).await {
            ToServer::TunnelData { .. } => {}
            other => panic!("{other:?}"),
        }
    }
}
