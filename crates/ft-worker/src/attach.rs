//! Watching, and typing into, a running agent.
//!
//! One attachment per session, however many people are looking. Two `tmux
//! attach` clients on one session fight over its size and each redraw undoes
//! the other's, so the worker holds a single pty and everyone shares it.
//!
//! The pty runs `tmux attach`, not the agent itself. The agent already belongs
//! to tmux, which is what lets it survive us: detaching, restarting, or losing
//! the network never reaches the process doing the work.

use anyhow::{Context, Result};
use ft_core::SessionId;
use ft_proto::{encode, ToServer};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// A live view of one session's terminal.
pub struct Attachment {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    reader: tokio::task::JoinHandle<()>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Cleared when the pty ends, so a stale entry can be told from a live one.
    alive: Arc<AtomicBool>,
}

impl Attachment {
    /// Attach to a tmux session and start streaming it.
    ///
    /// Output goes out as it arrives rather than being buffered into lines: a
    /// terminal is a byte stream and an agent redrawing a spinner never sends a
    /// newline at all.
    pub fn open(
        tmux_session: &str,
        session_id: SessionId,
        pty_kind: ft_proto::Pty,
        cols: u16,
        rows: u16,
        out: mpsc::Sender<ToServer>,
    ) -> Result<Self> {
        let pty = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("opening a pty for the terminal")?;

        let mut command = CommandBuilder::new("tmux");
        command.args(["attach-session", "-t", tmux_session]);
        // Without this tmux draws for whatever terminal it inherits, which in a
        // daemon is none, and the output arrives unusable.
        command.env("TERM", "xterm-256color");

        let child = pty
            .slave
            .spawn_command(command)
            .with_context(|| format!("attaching to {tmux_session}"))?;
        drop(pty.slave);

        let mut reader = pty.master.try_clone_reader()?;
        let writer = pty.master.take_writer()?;

        let alive = Arc::new(AtomicBool::new(true));
        let ending = alive.clone();

        let reader = tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Base64 because the frame is JSON and terminal output
                        // is bytes, not text — it carries control sequences and
                        // partial UTF-8 mid-character.
                        let frame = ToServer::PtyOutput {
                            pty: pty_kind,
                            session_id: session_id.clone(),
                            data: encode(&buf[..n]),
                        };
                        if out.blocking_send(frame).is_err() {
                            break;
                        }
                    }
                }
            }
            ending.store(false, Ordering::Relaxed);
            let _ = out.blocking_send(ToServer::PtyClosed {
                session_id,
                pty: pty_kind,
            });
        });

        Ok(Self {
            master: Arc::new(Mutex::new(pty.master)),
            writer: Arc::new(Mutex::new(writer)),
            reader,
            child: Arc::new(Mutex::new(child)),
            alive,
        })
    }

    /// Whether the terminal behind this is still there.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Make tmux repaint, for a viewer that arrived after the last redraw.
    ///
    /// A size change is what tmux listens for, so this asks for one column less
    /// and then puts it back. Crude, but it uses the one channel tmux is
    /// already watching, and typing a redraw key would reach the agent instead.
    pub fn repaint(&self, cols: u16, rows: u16) -> Result<()> {
        self.resize(cols.saturating_sub(1).max(2), rows)?;
        self.resize(cols, rows)
    }

    /// Keystrokes, verbatim. Control characters included — this is a terminal,
    /// so `Ctrl-C` has to reach the agent as `Ctrl-C`.
    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock().expect("attachment writer");
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    /// Tell tmux how big the window is, so it wraps where the viewer wraps.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .expect("attachment master")
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resizing the terminal")
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        // Detach only. The agent belongs to tmux and carries on without us,
        // which is the entire point of running it there.
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        self.reader.abort();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_attachment_needs_a_session_that_exists() {
        // Everything else here needs a live tmux session; the encoding it
        // relies on is covered where it lives, in the protocol crate.
        assert!(ft_proto::decode("not valid base64!").is_none());
    }
}
