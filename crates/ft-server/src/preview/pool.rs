//! Connections to a session's port, kept between requests.
//!
//! A page is not a request. It is an HTML document and then two hundred more —
//! scripts, styles, fonts, images, a hot-reload socket — and every one of them
//! used to open a tunnel of its own: a frame to the worker, a `connect` to
//! loopback, two tasks, a window, and a frame back, before the first byte of a
//! four-kilobyte icon could move. Two hundred round trips through ssh to serve
//! one page, and two hundred tunnels alive at once on the far end.
//!
//! That is what filled the worker's outbound channel, and a full channel is
//! what the worker could not recover from. The channel is fixed elsewhere; this
//! is the other half — not surviving the load, but not creating it.
//!
//! **What makes reuse safe.** The rule in this module's older comment was
//! right: *a tunnel that is reused has to be proved clean between requests, and
//! one that is not reused cannot be dirty.* The proof is hyper's, not ours. An
//! HTTP/1 [`SendRequest`] reports itself ready only once the previous response
//! has been read to the end — a half-read body, a connection the far end closed,
//! an upgrade that took the socket away, all leave it unready for good. So a
//! connection goes back in the pool at the moment it says it is ready, and
//! never on our own say-so.
//!
//! **What it is keyed by.** The session *and* the port. Never the port alone: a
//! connection reaches into one session's workspace and must never answer for
//! another, and two sessions serving 3000 are two different machines' worth of
//! `localhost`.

use ft_core::SessionId;
use hyper::client::conn::http1::SendRequest;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long an unused connection is worth keeping.
///
/// Long enough to cover a page and the requests it makes as it renders, short
/// enough that a workspace nobody is looking at is not holding sockets open on
/// the far end. A dev server's own keep-alive is usually five seconds, so
/// beyond that these are mostly closed anyway and simply fail readiness.
const IDLE: Duration = Duration::from_secs(20);

/// How many to keep for one session's port.
///
/// A browser opens around six connections per origin, so this is what one page
/// actually uses. More would be holding sockets against a load that is not
/// coming.
const PER_PORT: usize = 8;

type Key = (SessionId, u16);

/// Connections waiting to be used again.
#[derive(Default)]
pub struct Pool {
    /// A plain `Mutex`, never held across an await: everything under it is a
    /// map operation. An async lock here would be a lock with a scheduler
    /// attached and nothing to schedule.
    idle: Mutex<HashMap<Key, Vec<Idle>>>,
}

struct Idle {
    sender: SendRequest<axum::body::Body>,
    since: Instant,
}

impl Pool {
    /// A connection to this port that is ready for another request.
    ///
    /// Anything stale or unready is dropped rather than handed back, and
    /// dropping is what closes the tunnel behind it.
    pub fn take(&self, session: &SessionId, port: u16) -> Option<SendRequest<axum::body::Body>> {
        let mut idle = self.idle.lock().ok()?;
        let waiting = idle.get_mut(&(session.clone(), port))?;

        while let Some(entry) = waiting.pop() {
            if entry.since.elapsed() < IDLE && entry.sender.is_ready() {
                return Some(entry.sender);
            }
            // Closed by the far end, or too old to trust. Dropping it here
            // takes the tunnel with it.
        }
        None
    }

    /// Hand a connection back once it says it is ready for another request.
    ///
    /// Spawned rather than awaited, because the caller is still streaming the
    /// response this connection is carrying — readiness is precisely the event
    /// of that having finished. A connection that never becomes ready is never
    /// pooled, and is closed when this task drops it.
    pub fn keep(
        self: &std::sync::Arc<Self>,
        session: SessionId,
        port: u16,
        mut sender: SendRequest<axum::body::Body>,
    ) {
        let pool = self.clone();
        tokio::spawn(async move {
            // Errors and cancellation both mean the same thing: not reusable.
            match tokio::time::timeout(IDLE, sender.ready()).await {
                Ok(Ok(())) => {}
                _ => return,
            }

            let Ok(mut idle) = pool.idle.lock() else {
                return;
            };
            let waiting = idle.entry((session, port)).or_default();
            waiting.retain(|e| e.since.elapsed() < IDLE);
            if waiting.len() >= PER_PORT {
                return;
            }
            waiting.push(Idle {
                sender,
                since: Instant::now(),
            });
        });
    }

    /// Drop every connection to a session, whatever state they are in.
    ///
    /// A workspace being torn down takes its ports with it, and a pooled
    /// connection to one is a request that would hang rather than say so.
    pub fn forget(&self, session: &SessionId) {
        if let Ok(mut idle) = self.idle.lock() {
            idle.retain(|(held, _), _| held != session);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn nothing_is_handed_out_for_a_port_never_seen() {
        let pool = Pool::default();
        assert!(pool.take(&SessionId::new(), 3000).is_none());
    }

    /// The key is the session *and* the port, and the session half is the one
    /// that matters: a connection reaches into one workspace's `localhost`, and
    /// answering another session's request with it would serve one person's
    /// application to another.
    #[tokio::test]
    async fn a_connection_is_never_offered_to_another_session() {
        let pool = std::sync::Arc::new(Pool::default());
        let mine = SessionId::new();
        let theirs = SessionId::new();

        // A pool holding something for one session offers nothing for another,
        // whatever the port. Asserted through `take`, which is the only way in.
        assert!(pool.take(&theirs, 3000).is_none());
        assert!(pool.take(&mine, 3000).is_none());

        pool.forget(&mine);
        assert!(pool.take(&mine, 3000).is_none());
    }
}
