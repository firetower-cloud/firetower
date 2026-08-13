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
    line: String,
}

impl<R: tokio::io::AsyncRead + Unpin> FrameReader<R> {
    /// Next frame, or `Closed` when the other end goes away.
    ///
    /// Blank lines are skipped rather than treated as errors — a stream that
    /// picked up a stray newline shouldn't take the connection down.
    pub async fn read<T: DeserializeOwned>(&mut self) -> Result<T, CodecError> {
        loop {
            self.line.clear();
            let n = self.reader.read_line(&mut self.line).await?;
            if n == 0 {
                return Err(CodecError::Closed);
            }
            let trimmed = self.line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Ok(serde_json::from_str(trimmed)?);
        }
    }
}

/// The writing half.
pub struct FrameWriter<W> {
    writer: W,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
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
            reader: FrameReader {
                reader: BufReader::new(reader),
                line: String::new(),
            },
            writer: FrameWriter { writer },
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
}
