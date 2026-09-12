//! The Docker Engine API, over its socket, by hand.
//!
//! Everything the updater does to a machine goes through here: pull an image,
//! tag one, inspect a container, run the helper that runs Compose, exec
//! `pg_dump`. Each is one request and one document, so this is a thin client
//! rather than a dependency — and the whole surface the updater has on the
//! socket can be read in one file.
//!
//! **The socket is root on the machine.** Nothing here takes a value from
//! outside the updater and puts it into a container's command line; the
//! control plane asks for a version and a set of files, and this module
//! decides what is run.

use anyhow::{anyhow, Context, Result};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::time::Duration;

/// Where the daemon listens. The compose file mounts the machine's socket here.
pub const SOCKET: &str = "/var/run/docker.sock";

/// How long any one response may take to start.
///
/// Generous: creating or removing a container on a daemon that is busy, or
/// on a full disk, has been seen to take a minute, and a request given up on
/// is one the daemon still carries out — which is how a retry meets a name
/// that is already taken.
const HEADERS_TIMEOUT: Duration = Duration::from_secs(120);

/// How long a streaming response may go quiet before it is given up on — a
/// pull that has stalled, an exec that hung.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

/// The most of a command's stderr worth keeping. Enough for any real error and
/// its context; far less than one statement naming every table in a database.
pub const STDERR_KEPT: usize = 64 * 1024;

#[derive(Clone)]
pub struct Docker {
    socket: std::path::PathBuf,
}

/// What a container is, as much of `docker inspect` as the updater reads.
#[derive(Debug, Clone)]
pub struct Container {
    pub id: String,
    pub name: String,
    /// The image reference it was created from, `ghcr.io/…/firetower:latest`.
    pub image_ref: String,
    /// The image by id, `sha256:…`. What a rollback re-tags.
    pub image_id: String,
    pub labels: std::collections::BTreeMap<String, String>,
    pub running: bool,
}

impl Container {
    pub fn label(&self, key: &str) -> Option<&str> {
        self.labels.get(key).map(String::as_str)
    }
}

/// What an image is.
#[derive(Debug, Clone)]
pub struct Image {
    pub id: String,
    pub labels: std::collections::BTreeMap<String, String>,
    pub repo_digests: Vec<String>,
}

impl Image {
    /// The version the build stamped on it, if any.
    pub fn version(&self) -> Option<&str> {
        self.labels
            .get("org.opencontainers.image.version")
            .map(String::as_str)
    }
}

/// What a container that was run to completion said.
#[derive(Debug, Clone)]
pub struct Finished {
    pub exit_code: i64,
    pub output: String,
}

impl Docker {
    pub fn new() -> Self {
        Self {
            socket: std::path::PathBuf::from(SOCKET),
        }
    }

    /// A client for a socket that is not the machine's — tests, only.
    #[cfg(test)]
    pub fn at(socket: impl Into<std::path::PathBuf>) -> Self {
        Self {
            socket: socket.into(),
        }
    }

    /// The daemon's version string. Also the one check that the socket works.
    pub async fn version(&self) -> Result<String> {
        let v: Value = self.json(Method::GET, "/version", None).await?;
        v.get("Version")
            .and_then(Value::as_str)
            .map(str::to_string)
            .context("the daemon answered /version without a Version")
    }

    pub async fn inspect_container(&self, name_or_id: &str) -> Result<Container> {
        let v: Value = self
            .json(
                Method::GET,
                &format!("/containers/{}/json", encode(name_or_id)),
                None,
            )
            .await
            .with_context(|| format!("inspecting container {name_or_id}"))?;
        container_from(&v)
    }

    /// Containers carrying every one of these labels.
    pub async fn containers_labelled(&self, labels: &[(&str, &str)]) -> Result<Vec<Container>> {
        let filter = serde_json::json!({
            "label": labels.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>()
        });
        let path = format!(
            "/containers/json?all=true&filters={}",
            encode(&filter.to_string())
        );
        let listed: Vec<Value> = self.json(Method::GET, &path, None).await?;
        let mut found = Vec::new();
        for entry in listed {
            if let Some(id) = entry.get("Id").and_then(Value::as_str) {
                found.push(self.inspect_container(id).await?);
            }
        }
        Ok(found)
    }

    pub async fn inspect_image(&self, reference: &str) -> Result<Image> {
        let v: Value = self
            .json(
                Method::GET,
                &format!("/images/{}/json", encode(reference)),
                None,
            )
            .await
            .with_context(|| format!("inspecting image {reference}"))?;
        Ok(Image {
            id: v
                .get("Id")
                .and_then(Value::as_str)
                .context("image without an Id")?
                .to_string(),
            labels: labels_of(v.pointer("/Config/Labels")),
            repo_digests: v
                .get("RepoDigests")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    /// Pull `repo:tag`, reporting progress lines to `say`.
    ///
    /// Anonymous. The images this updater pulls are public, and a registry
    /// credential is exactly the kind of thing this container should not hold.
    pub async fn pull(&self, repo: &str, tag: &str, mut say: impl FnMut(String)) -> Result<()> {
        let path = format!(
            "/images/create?fromImage={}&tag={}",
            encode(repo),
            encode(tag)
        );
        let response = self.send(Method::POST, &path, None, None).await?;
        let status = response.status();
        let body = read_all(response.into_body()).await?;

        if !status.is_success() {
            return Err(anyhow!(
                "pulling {repo}:{tag}: {}",
                error_message(&body).unwrap_or_else(|| status.to_string())
            ));
        }

        // The body is JSON lines; the last one says whether it worked. Only
        // the status lines are worth repeating, not the per-layer progress
        // bars — those are hundreds of lines that say "Downloading".
        let mut last_status = String::new();
        let mut errored = None;
        for line in body.split(|b| *b == b'\n') {
            let Ok(v) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if let Some(e) = v.get("error").and_then(Value::as_str) {
                errored = Some(e.to_string());
            }
            if let Some(s) = v.get("status").and_then(Value::as_str) {
                if v.get("id").is_none() && s != last_status {
                    last_status = s.to_string();
                    say(s.to_string());
                }
            }
        }
        match errored {
            Some(e) => Err(anyhow!("pulling {repo}:{tag}: {e}")),
            None => Ok(()),
        }
    }

    /// Give an image another name. `source` may be an id or a reference.
    pub async fn tag(&self, source: &str, repo: &str, tag: &str) -> Result<()> {
        let path = format!(
            "/images/{}/tag?repo={}&tag={}",
            encode(source),
            encode(repo),
            encode(tag)
        );
        let response = self.send(Method::POST, &path, None, None).await?;
        let status = response.status();
        let body = read_all(response.into_body()).await?;
        if !status.is_success() {
            return Err(anyhow!(
                "tagging {source} as {repo}:{tag}: {}",
                error_message(&body).unwrap_or_else(|| status.to_string())
            ));
        }
        Ok(())
    }

    /// Run a container to completion and return what it printed.
    ///
    /// Created, started, waited for, read, removed — in that order, so the
    /// output is read before the container is gone. `AutoRemove` would race
    /// the read.
    pub async fn run_to_completion(&self, spec: Value, name: &str) -> Result<Finished> {
        let created: Value = self
            .json(
                Method::POST,
                &format!("/containers/create?name={}", encode(name)),
                Some(spec),
            )
            .await
            .context("creating the helper container")?;
        let id = created
            .get("Id")
            .and_then(Value::as_str)
            .context("created a container without an Id")?
            .to_string();

        let outcome = self.drive(&id).await;

        // Whatever happened, the helper does not stay around.
        let _ = self.remove(&id).await;

        outcome
    }

    /// Remove a container, running or not.
    pub async fn remove(&self, id: &str) -> Result<()> {
        let response = self
            .send(
                Method::DELETE,
                &format!("/containers/{}?force=true", encode(id)),
                None,
                None,
            )
            .await?;
        let status = response.status();
        if !status.is_success() && status != StatusCode::NOT_FOUND {
            let body = read_all(response.into_body()).await?;
            return Err(anyhow!(
                "removing container {id}: {}",
                error_message(&body).unwrap_or_else(|| status.to_string())
            ));
        }
        Ok(())
    }

    async fn drive(&self, id: &str) -> Result<Finished> {
        let started = self
            .send(Method::POST, &format!("/containers/{id}/start"), None, None)
            .await?;
        if !started.status().is_success() && started.status() != StatusCode::NOT_MODIFIED {
            let body = read_all(started.into_body()).await?;
            return Err(anyhow!(
                "starting the helper container: {}",
                error_message(&body).unwrap_or_default()
            ));
        }

        let waited: Value = self
            .json_with(
                Method::POST,
                &format!("/containers/{id}/wait"),
                None,
                Duration::from_secs(20 * 60),
            )
            .await
            .context("waiting for the helper container")?;
        let exit_code = waited
            .get("StatusCode")
            .and_then(Value::as_i64)
            .unwrap_or(-1);

        let logs = self
            .send(
                Method::GET,
                &format!("/containers/{id}/logs?stdout=true&stderr=true"),
                None,
                None,
            )
            .await?;
        let raw = read_all(logs.into_body()).await?;

        Ok(Finished {
            exit_code,
            output: String::from_utf8_lossy(&demux(&raw)).into_owned(),
        })
    }

    /// Run a command inside a running container and stream its stdout to
    /// `sink`. Returns the exit code and what it wrote to stderr.
    pub async fn exec(
        &self,
        container: &str,
        cmd: &[&str],
        sink: &mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> Result<(i64, String)> {
        use tokio::io::AsyncWriteExt;

        let created: Value = self
            .json(
                Method::POST,
                &format!("/containers/{}/exec", encode(container)),
                Some(serde_json::json!({
                    "AttachStdout": true,
                    "AttachStderr": true,
                    "Tty": false,
                    "Cmd": cmd,
                })),
            )
            .await
            .context("creating an exec")?;
        let id = created
            .get("Id")
            .and_then(Value::as_str)
            .context("exec without an Id")?
            .to_string();

        let response = self
            .send(
                Method::POST,
                &format!("/exec/{id}/start"),
                Some(serde_json::json!({"Detach": false, "Tty": false})),
                None,
            )
            .await
            .context("starting the exec")?;
        if !response.status().is_success() {
            let body = read_all(response.into_body()).await?;
            return Err(anyhow!(
                "exec refused: {}",
                error_message(&body).unwrap_or_default()
            ));
        }

        // Demultiplex as it arrives: stdout to the sink, stderr kept.
        let mut body = response.into_body();
        let mut pending: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut dropped: usize = 0;
        loop {
            let next = tokio::time::timeout(IDLE_TIMEOUT, body.frame())
                .await
                .context("the exec went quiet")?;
            let Some(frame) = next else { break };
            let frame = frame.context("reading the exec's output")?;
            let Ok(data) = frame.into_data() else {
                continue;
            };
            pending.extend_from_slice(&data);

            while pending.len() >= 8 {
                let kind = pending[0];
                let size =
                    u32::from_be_bytes([pending[4], pending[5], pending[6], pending[7]]) as usize;
                if pending.len() < 8 + size {
                    break;
                }
                let payload = pending[8..8 + size].to_vec();
                pending.drain(..8 + size);
                match kind {
                    1 => sink.write_all(&payload).await?,
                    // Bounded. `pg_dump` failing on a database full of
                    // schemas writes one line naming every table in it, and
                    // this used to be kept whole — through the job's error,
                    // the run log, the database and onto the screen. The tail
                    // is the half worth keeping: that is where `ERROR:` and
                    // `HINT:` end up.
                    _ => {
                        stderr.extend_from_slice(&payload);
                        if stderr.len() > STDERR_KEPT {
                            let cut = stderr.len() - STDERR_KEPT;
                            stderr.drain(..cut);
                            dropped += cut;
                        }
                    }
                }
            }
        }
        sink.flush().await?;

        let inspected: Value = self
            .json(Method::GET, &format!("/exec/{id}/json"), None)
            .await
            .context("reading the exec's exit code")?;
        let code = inspected
            .get("ExitCode")
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        let said = String::from_utf8_lossy(&stderr).into_owned();
        Ok((
            code,
            if dropped > 0 {
                format!("… {dropped} earlier bytes not shown …\n{said}")
            } else {
                said
            },
        ))
    }

    // ── plumbing ───────────────────────────────────────────────────────

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        self.json_with(method, path, body, HEADERS_TIMEOUT).await
    }

    async fn json_with<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        wait: Duration,
    ) -> Result<T> {
        let response = self.send(method, path, body, Some(wait)).await?;
        let status = response.status();
        let bytes = read_all(response.into_body()).await?;
        if !status.is_success() {
            return Err(anyhow!(
                "docker said {}: {}",
                status,
                error_message(&bytes).unwrap_or_else(|| String::from_utf8_lossy(&bytes).into())
            ));
        }
        serde_json::from_slice(&bytes).with_context(|| format!("reading the answer to {path}"))
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        wait: Option<Duration>,
    ) -> Result<Response<Incoming>> {
        let stream = tokio::net::UnixStream::connect(&self.socket)
            .await
            .with_context(|| {
                format!(
                    "connecting to Docker at {} — is the socket mounted into this container?",
                    self.socket.display()
                )
            })?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .context("speaking HTTP to Docker")?;
        tokio::spawn(async move {
            let _ = connection.await;
        });

        let payload = body.map(|v| v.to_string()).unwrap_or_default();
        let request = Request::builder()
            .method(method)
            .uri(format!("http://docker{path}"))
            .header("host", "docker")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(payload)))
            .context("building a request")?;

        tokio::time::timeout(
            wait.unwrap_or(HEADERS_TIMEOUT),
            sender.send_request(request),
        )
        .await
        .with_context(|| format!("Docker did not answer {path} in time"))?
        .with_context(|| format!("asking Docker for {path}"))
    }
}

impl Default for Docker {
    fn default() -> Self {
        Self::new()
    }
}

async fn read_all(body: Incoming) -> Result<Vec<u8>> {
    let mut body = body;
    let mut out = Vec::new();
    loop {
        let next = tokio::time::timeout(IDLE_TIMEOUT, body.frame())
            .await
            .context("Docker went quiet mid-response")?;
        let Some(frame) = next else { break };
        let frame = frame.context("reading Docker's response")?;
        if let Ok(data) = frame.into_data() {
            out.extend_from_slice(&data);
        }
    }
    Ok(out)
}

/// Docker's error bodies are `{"message": "…"}`.
fn error_message(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()?
        .get("message")?
        .as_str()
        .map(str::to_string)
}

/// Undo the 8-byte-header framing a non-tty stream comes in. stdout and stderr
/// interleaved in the order they were written, which is what a log should be.
pub fn demux(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut at = 0;
    while at + 8 <= raw.len() {
        let size =
            u32::from_be_bytes([raw[at + 4], raw[at + 5], raw[at + 6], raw[at + 7]]) as usize;
        let end = (at + 8 + size).min(raw.len());
        out.extend_from_slice(&raw[at + 8..end]);
        at = end;
    }
    if at == 0 && !raw.is_empty() {
        // Not framed at all — a tty stream. Take it as it is.
        return raw.to_vec();
    }
    out
}

fn container_from(v: &Value) -> Result<Container> {
    let name = v
        .get("Name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_string();
    Ok(Container {
        id: v
            .get("Id")
            .and_then(Value::as_str)
            .context("container without an Id")?
            .to_string(),
        name,
        image_ref: v
            .pointer("/Config/Image")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        image_id: v
            .get("Image")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        labels: labels_of(v.pointer("/Config/Labels")),
        running: v
            .pointer("/State/Running")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn labels_of(v: Option<&Value>) -> std::collections::BTreeMap<String, String> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Percent-encode a query value or path segment.
fn encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Split `repo:tag` — or `repo` alone, which Docker reads as `:latest`.
///
/// The colon that separates a tag is the last one after the last slash, so a
/// registry with a port (`localhost:5000/firetower:latest`) comes apart right.
pub fn split_reference(reference: &str) -> (String, String) {
    let after_slash = reference.rfind('/').map(|i| i + 1).unwrap_or(0);
    match reference[after_slash..].rfind(':') {
        Some(i) => (
            reference[..after_slash + i].to_string(),
            reference[after_slash + i + 1..].to_string(),
        ),
        None => (reference.to_string(), "latest".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reference_comes_apart_at_the_right_colon() {
        assert_eq!(
            split_reference("ghcr.io/firetower-cloud/firetower:latest"),
            ("ghcr.io/firetower-cloud/firetower".into(), "latest".into())
        );
        assert_eq!(
            split_reference("localhost:5000/firetower"),
            ("localhost:5000/firetower".into(), "latest".into())
        );
        assert_eq!(
            split_reference("localhost:5000/firetower:0.31.0"),
            ("localhost:5000/firetower".into(), "0.31.0".into())
        );
    }

    #[test]
    fn a_multiplexed_stream_is_read_in_order() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&[1, 0, 0, 0, 0, 0, 0, 3]);
        raw.extend_from_slice(b"out");
        raw.extend_from_slice(&[2, 0, 0, 0, 0, 0, 0, 3]);
        raw.extend_from_slice(b"err");
        assert_eq!(demux(&raw), b"outerr");

        // A tty stream has no frames and is passed through.
        assert_eq!(demux(b"plain"), b"plain");
    }

    #[test]
    fn a_container_is_read_from_what_inspect_says() {
        let v = serde_json::json!({
            "Id": "abc",
            "Name": "/firetower-firetower-1",
            "Image": "sha256:111",
            "Config": {
                "Image": "ghcr.io/firetower-cloud/firetower:latest",
                "Labels": {"com.docker.compose.project": "firetower"}
            },
            "State": {"Running": true}
        });
        let c = container_from(&v).unwrap();
        assert_eq!(c.name, "firetower-firetower-1");
        assert_eq!(c.image_id, "sha256:111");
        assert_eq!(c.label("com.docker.compose.project"), Some("firetower"));
        assert!(c.running);
    }

    #[test]
    fn a_query_value_is_encoded() {
        assert_eq!(encode("a b/c:d"), "a%20b%2Fc%3Ad");
    }
}
