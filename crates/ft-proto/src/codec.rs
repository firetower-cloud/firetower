//! Newline-delimited JSON over any stream.
//!
//! The codec is deliberately the only thing that knows the encoding, so swapping
//! to a compact binary format later touches this file and nothing else.

use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};

#[derive(Debug, thiserror::Error)]
pub enum CodecError {
    #[error("stream closed")]
    Closed,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed frame: {0}")]
    Malformed(#[from] serde_json::Error),
}

/// The reading half. Separable from the writing half so a peer can send while
/// it is waiting to receive — a terminal streaming output is exactly that.
pub struct FrameReader<R> {
    reader: BufReader<R>,
    /// Bytes taken off the stream that aren't yet a whole frame.
    ///
    /// A field rather than a local because a read may be abandoned partway —
    /// see [`FrameReader::read`].
    held: Vec<u8>,
}

impl<R: tokio::io::AsyncRead + Unpin> FrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader: BufReader::new(reader),
            held: Vec::new(),
        }
    }

    /// Next frame, or `Closed` when the other end goes away.
    ///
    /// Blank lines are skipped rather than treated as errors — a stream that
    /// picked up a stray newline shouldn't take the connection down.
    ///
    /// **Cancellation safe**, and it has to be. The obvious implementation is
    /// `read_line`, which is not: abandon it partway and the bytes it has taken
    /// off the stream are gone for good. Put that in a `select!` alongside
    /// anything else — as the control plane does, so it can send while it waits
    /// — and the first time the other branch wins, half a frame disappears and
    /// every frame after it is misaligned. Only the reading half breaks, so the
    /// connection goes on looking healthy while nothing the peer says is ever
    /// heard again. That is not hypothetical; it is where this was found.
    ///
    /// So the only await here is `fill_buf`, which is cancellation safe and
    /// consumes nothing. Bytes move into `held` and are consumed in the same
    /// breath, with no await in between, so there is no moment at which being
    /// dropped could lose them.
    pub async fn read<T: DeserializeOwned>(&mut self) -> Result<T, CodecError> {
        loop {
            // Anything already whole is answered without touching the stream.
            if let Some(at) = self.held.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.held.drain(..=at).collect();
                match parse(&line)? {
                    Some(frame) => return Ok(frame),
                    None => continue,
                }
            }

            let taken = {
                let Self { reader, held } = self;
                let available = reader.fill_buf().await?;

                if available.is_empty() {
                    // End of stream. A last frame with no trailing newline
                    // still counts; an empty buffer means there is nothing left.
                    let rest = std::mem::take(held);
                    return match parse(&rest)? {
                        Some(frame) => Ok(frame),
                        None => Err(CodecError::Closed),
                    };
                }

                held.extend_from_slice(available);
                available.len()
            };
            self.reader.consume(taken);
        }
    }
}

/// One line to a frame. `None` for a blank line, which is not an error.
fn parse<T: DeserializeOwned>(line: &[u8]) -> Result<Option<T>, CodecError> {
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(trimmed)?))
}

/// The writing half.
pub struct FrameWriter<W> {
    writer: W,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub async fn write<T: Serialize>(&mut self, frame: &T) -> Result<(), CodecError> {
        let mut buf = serde_json::to_vec(frame)?;
        buf.push(b'\n');
        self.writer.write_all(&buf).await?;
        self.writer.flush().await?;
        Ok(())
    }
}

/// Reads and writes frames over a split stream.
pub struct Codec<R, W> {
    reader: FrameReader<R>,
    writer: FrameWriter<W>,
}

impl<R, W> Codec<R, W>
where
    R: tokio::io::AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            reader: FrameReader::new(reader),
            writer: FrameWriter::new(writer),
        }
    }

    /// Take the halves apart, for a loop that reads and writes independently.
    pub fn split(self) -> (FrameReader<R>, FrameWriter<W>) {
        (self.reader, self.writer)
    }

    pub async fn read<T: DeserializeOwned>(&mut self) -> Result<T, CodecError> {
        self.reader.read().await
    }

    pub async fn write<T: Serialize>(&mut self, frame: &T) -> Result<(), CodecError> {
        self.writer.write(frame).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ToServer, ToWorker};

    #[tokio::test]
    async fn frames_survive_a_round_trip_through_bytes() {
        let mut out: Vec<u8> = Vec::new();
        {
            let mut codec = Codec::new(&[][..], &mut out);
            codec.write(&ToWorker::Ping).await.unwrap();
            codec
                .write(&ToWorker::Hello {
                    protocol: 1,
                    client_version: "0.1.0".into(),
                })
                .await
                .unwrap();
        }

        let mut codec = Codec::new(&out[..], Vec::new());
        assert!(matches!(
            codec.read::<ToWorker>().await.unwrap(),
            ToWorker::Ping
        ));
        assert!(matches!(
            codec.read::<ToWorker>().await.unwrap(),
            ToWorker::Hello { protocol: 1, .. }
        ));
    }

    #[tokio::test]
    async fn a_closed_stream_reports_closed_not_an_io_error() {
        let mut codec = Codec::new(&[][..], Vec::new());
        assert!(matches!(
            codec.read::<ToServer>().await,
            Err(CodecError::Closed)
        ));
    }

    #[tokio::test]
    async fn blank_lines_are_skipped() {
        let input = b"\n\n{\"frame\":\"Pong\"}\n";
        let mut codec = Codec::new(&input[..], Vec::new());
        assert!(matches!(
            codec.read::<ToServer>().await.unwrap(),
            ToServer::Pong
        ));
    }

    #[tokio::test]
    async fn a_bad_frame_is_reported_without_killing_the_stream() {
        let input = b"{not json}\n{\"frame\":\"Pong\"}\n";
        let mut codec = Codec::new(&input[..], Vec::new());
        assert!(matches!(
            codec.read::<ToServer>().await,
            Err(CodecError::Malformed(_))
        ));
        // the next frame still reads
        assert!(matches!(
            codec.read::<ToServer>().await.unwrap(),
            ToServer::Pong
        ));
    }

    /// The bug that broke live worker connections: a read abandoned partway
    /// must not eat the frame it had started on.
    ///
    /// A `select!` that also waits on something else does exactly this — the
    /// other branch wins, the read future is dropped, and whatever it had taken
    /// off the stream is gone. Only the reading half breaks, so the connection
    /// keeps looking healthy while every frame after it is lost.
    #[tokio::test]
    async fn a_read_abandoned_partway_loses_nothing() {
        use tokio::io::AsyncWriteExt;

        let (client, mut server) = tokio::io::duplex(64);
        let mut frames = FrameReader::new(client);

        // Half a frame, then nothing — so a read has to wait.
        let whole = serde_json::to_string(&ToServer::Pong).unwrap() + "\n";
        let (head, tail) = whole.split_at(whole.len() / 2);
        server.write_all(head.as_bytes()).await.unwrap();

        // Abandon the read, the way `select!` does when its other branch wins.
        tokio::select! {
            _ = frames.read::<ToServer>() => panic!("nothing complete to read yet"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }

        // The rest arrives, and the frame must still be readable in full.
        server.write_all(tail.as_bytes()).await.unwrap();
        assert!(matches!(
            frames.read::<ToServer>().await.unwrap(),
            ToServer::Pong
        ));
    }

    #[tokio::test]
    async fn many_reads_abandoned_in_a_row_still_deliver_every_frame() {
        use tokio::io::AsyncWriteExt;

        let (client, mut server) = tokio::io::duplex(4096);
        let mut frames = FrameReader::new(client);

        let frame = serde_json::to_string(&ToServer::Pong).unwrap() + "\n";
        let stream: String = frame.repeat(5);

        // Dribble it in a byte at a time, abandoning a read between each.
        let mut seen = 0;
        for byte in stream.as_bytes() {
            server.write_all(&[*byte]).await.unwrap();
            tokio::select! {
                frame = frames.read::<ToServer>() => {
                    frame.expect("a frame that arrived must parse");
                    seen += 1;
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(1)) => {}
            }
        }
        drop(server);

        while frames.read::<ToServer>().await.is_ok() {
            seen += 1;
        }
        assert_eq!(
            seen, 5,
            "every frame written must be delivered exactly once"
        );
    }
}
