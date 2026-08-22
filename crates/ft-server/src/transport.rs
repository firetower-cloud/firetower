//! How the control plane reaches a worker.
//!
//! A transport hands back a reader and a writer. That's the whole contract —
//! the protocol doesn't care whether the bytes travel down a pipe to a child
//! process, through an SSH tunnel, or over a websocket the worker opened
//! outbound. Local today, SSH next, hosted later, one daemon throughout.

use anyhow::{Context, Result};
use async_trait::async_trait;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

/// How many lines of the far end's stderr to keep.
///
/// Enough for a stack of ssh warnings followed by the line that matters, and
/// bounded so a worker logging steadily can't grow it without limit.
const KEEP_LINES: usize = 20;

/// The far end's stderr. A ring: what explains a failure is the last thing said
/// before the stream closed.
type Tail = Arc<Mutex<VecDeque<String>>>;

/// A live bidirectional connection to a worker.
pub struct Connection {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    /// Held so the child isn't reaped while we're talking to it.
    child: Option<Child>,
    /// What it wrote to stderr. Empty for a transport with no child.
    tail: Option<Tail>,
}

impl Connection {
    /// The last thing the far end said, oldest first.
    ///
    /// When the frame stream closes without a frame, this is the only evidence
    /// of why.
    pub fn stderr_tail(&self) -> Vec<String> {
        self.tail
            .as_ref()
            .map(|t| t.lock().unwrap().iter().cloned().collect())
            .unwrap_or_default()
    }

    /// How the child ended, if it has.
    ///
    /// Waits briefly rather than only polling: stdout closing and the process
    /// being reaped are separate events, and polling in between reports "still
    /// running" for something already gone.
    pub async fn exit_status(&mut self) -> Option<std::process::ExitStatus> {
        let child = self.child.as_mut()?;
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        tokio::time::timeout(std::time::Duration::from_millis(500), child.wait())
            .await
            .ok()?
            .ok()
    }
}

#[cfg(test)]
impl Connection {
    /// A connection with no process behind it, for tests that need a worker
    /// that answers without one existing.
    pub(crate) fn piped(
        reader: Box<dyn AsyncRead + Send + Unpin>,
        writer: Box<dyn AsyncWrite + Send + Unpin>,
    ) -> Self {
        Self {
            reader,
            writer,
            child: None,
            tail: None,
        }
    }
}

/// Read a child's stderr into a ring, and into the log on the way past.
///
/// Both are needed: a worker's own tracing belongs in the log, and an error
/// returned to a caller can only carry what is held here.
fn watch(stderr: ChildStderr, who: String) -> Tail {
    let tail: Tail = Arc::new(Mutex::new(VecDeque::with_capacity(KEEP_LINES)));
    let sink = tail.clone();

    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::info!(target: "worker", transport = %who, "{line}");
            let mut held = sink.lock().unwrap();
            if held.len() == KEEP_LINES {
                held.pop_front();
            }
            held.push_back(line);
        }
    });

    tail
}

#[async_trait]
pub trait Transport: Send + Sync {
    /// Human-readable, for logs and the Compute view.
    fn describe(&self) -> String;
    async fn connect(&self) -> Result<Connection>;
}

/// The worker as a child process on this machine.
///
/// The command is `firetower worker --stdio`. Reaching a remote host adds
/// `ssh <target>` in front of exactly that — which is why the local milestone is
/// the real system rather than a stand-in for it.
pub struct LocalTransport {
    exe: std::path::PathBuf,
    root: std::path::PathBuf,
}

impl LocalTransport {
    pub fn new(root: impl Into<std::path::PathBuf>) -> Result<Self> {
        Ok(Self {
            exe: std::env::current_exe().context("locating the firetower binary")?,
            root: root.into(),
        })
    }
}

#[async_trait]
impl Transport for LocalTransport {
    fn describe(&self) -> String {
        "local child process".to_string()
    }

    async fn connect(&self) -> Result<Connection> {
        let mut child = Command::new(&self.exe)
            .arg("worker")
            .arg("--stdio")
            .arg("--root")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // The worker's logs belong in ours, not in the frame stream. Piped
            // rather than inherited so they can also be quoted in an error.
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("spawning the local worker")?;

        let stdout: ChildStdout = child.stdout.take().context("worker stdout was not piped")?;
        let stdin: ChildStdin = child.stdin.take().context("worker stdin was not piped")?;
        let tail = child.stderr.take().map(|e| watch(e, self.describe()));

        Ok(Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            child: Some(child),
            tail,
        })
    }
}

/// A worker on another machine, reached over SSH.
///
/// Not wired up yet — it exists here so the shape of the trait is settled by a
/// second implementation rather than by one.
/// A worker in a container on this machine.
///
/// `docker exec` gives the same bidirectional pipe an ssh session does, with no
/// sshd to run, no key to manage and no host key to verify. The worker cannot
/// tell the difference — which is the whole point of the transport being an
/// abstraction.
pub struct DockerTransport {
    pub container: String,
    pub root: std::path::PathBuf,
}

#[async_trait]
impl Transport for DockerTransport {
    fn describe(&self) -> String {
        format!("docker exec {}", self.container)
    }

    async fn connect(&self) -> Result<Connection> {
        let mut child = Command::new("docker")
            .arg("exec")
            // Interactive without a tty: frames are bytes, and a tty would
            // helpfully translate newlines and corrupt them.
            .arg("-i")
            .arg(&self.container)
            .arg("firetower")
            .arg("worker")
            .arg("--stdio")
            .arg("--root")
            .arg(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("connecting to container {}", self.container))?;

        let stdout = child.stdout.take().context("docker stdout was not piped")?;
        let stdin = child.stdin.take().context("docker stdin was not piped")?;
        let tail = child.stderr.take().map(|e| watch(e, self.describe()));

        Ok(Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            child: Some(child),
            tail,
        })
    }
}

pub struct SshTransport {
    /// `user@host`, or the host by itself. Assembled from the parts a host
    /// holds — see `Compute::ssh_destination`.
    pub destination: String,
    /// `None` takes ssh's own default, which may be set in its config.
    pub port: Option<u16>,
    /// Which key to offer.
    ///
    /// A path is expanded and checked on the way to the command line, so a key
    /// that moved is an error when it is needed rather than a stale value
    /// nobody rechecked. A key the vault holds is written where ssh can read it
    /// at that same moment — see [`crate::sshkey::materialise`].
    pub key: ft_core::SshKey,
    /// Where the control plane keeps its state, on this machine.
    ///
    /// Two things live under it: the file ssh records host keys in, and — when
    /// there is no `/dev/shm` — the key it authenticates with.
    pub home: std::path::PathBuf,
    /// Where a held key is read from, when the key is one.
    pub vault: Option<Arc<crate::vault::Vault>>,
    /// The container to run the worker in on that machine, if it runs in one.
    ///
    /// Reached by ssh-ing to the machine and running `docker exec` there,
    /// rather than by ssh-ing into the container: no sshd, no key inside the
    /// image, no published port, and no host key that changes on every
    /// recreate.
    pub container: Option<String>,
    /// Where that worker keeps its state.
    ///
    /// `Some` inside a container, where we are root and `/var/lib/firetower` is
    /// what the image creates. `None` on the machine itself, leaving the
    /// worker's own default of `~/.firetower/worker` — that account may have no
    /// way to write under `/var/lib`.
    pub root: Option<std::path::PathBuf>,
}

impl SshTransport {
    /// The file ssh records host keys in, created if it is not there.
    ///
    /// One file for every host rather than one each: that is what ssh expects,
    /// and it is what makes a machine answering on an address it did not answer
    /// on before something ssh can notice.
    fn known_hosts(&self) -> Result<std::path::PathBuf> {
        let dir = self.home.join("ssh");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("making {}", dir.display()))?;

        let path = dir.join("known_hosts");
        if !path.exists() {
            std::fs::write(&path, "")
                .with_context(|| format!("creating {}", path.display()))?;
        }

        Ok(path)
    }

    /// The file to hand `ssh -i`, if any.
    ///
    /// `None` means ssh decides for itself, which is what an unset key has
    /// always meant.
    async fn key_file(&self) -> Result<Option<std::path::PathBuf>> {
        match &self.key {
            ft_core::SshKey::Default => Ok(None),
            ft_core::SshKey::File { path } => Ok(Some(identity_path(path)?)),
            ft_core::SshKey::Managed | ft_core::SshKey::Held { .. } => {
                let vault = self.vault.as_ref().context(
                    "this host authenticates with a key Firetower holds, and there is no vault to read it from",
                )?;

                let path = crate::sshkey::materialise(
                    vault,
                    &self.home,
                    &format!("connecting to {}", self.destination),
                )
                .await?;

                Ok(Some(path))
            }
        }
    }
}

#[async_trait]
impl Transport for SshTransport {
    fn describe(&self) -> String {
        let mut described = String::from("ssh");
        if let Some(port) = self.port {
            described.push_str(&format!(" -p {port}"));
        }
        match &self.key {
            ft_core::SshKey::File { path } => described.push_str(&format!(" -i {path}")),
            ft_core::SshKey::Managed => described.push_str(" -i <firetower's key>"),
            ft_core::SshKey::Held { name } => described.push_str(&format!(" -i <{name}>")),
            ft_core::SshKey::Default => {}
        }
        described.push(' ');
        described.push_str(&self.destination);
        if let Some(container) = &self.container {
            described.push_str(&format!(" docker exec {container}"));
        }
        described
    }

    async fn connect(&self) -> Result<Connection> {
        let mut ssh = Command::new("ssh");

        // Without these, adding a host that isn't there hangs instead of
        // failing: ssh waits on a password prompt nobody can answer, or on
        // a TCP connection that will never be refused.
        ssh.arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=10")
            // A host that answers with a different key is not the one we
            // trusted. Accepting it silently is how credentials reach the
            // wrong machine.
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new");

        // Where ssh remembers what each machine answered with.
        //
        // Not its default. That is `$HOME/.ssh/known_hosts`, which in the image
        // is `/root/.ssh/known_hosts` — the container's writable layer, thrown
        // away every time the container is recreated. So every upgrade emptied
        // it, and `accept-new` above then re-trusted whatever answered next:
        // the exact substitution StrictHostKeyChecking exists to catch, made
        // invisible by the upgrade that caused it.
        //
        // Under the state directory it is on the volume, and outlives both.
        match self.known_hosts() {
            Ok(path) => {
                ssh.arg("-o")
                    .arg(format!("UserKnownHostsFile={}", path.display()));
            }
            // Not fatal. A connection with ssh's own default is worth more than
            // no connection, and the log says which we got.
            Err(e) => tracing::warn!(
                "could not prepare a known_hosts file, falling back to ssh's default: {e:#}"
            ),
        }

        if let Some(port) = self.port {
            ssh.arg("-p").arg(port.to_string());
        }

        if let Some(path) = self.key_file().await? {
            ssh.arg("-i").arg(path);
            // Naming a key does not stop ssh offering the others first: the
            // agent's keys and the usual names in `~/.ssh` are still tried, and
            // a server with a low `MaxAuthTries` can close the connection
            // before reaching the one that was asked for. That arrives as a
            // rejected key, which sends you looking at the wrong end.
            ssh.arg("-o").arg("IdentitiesOnly=yes");
        }

        ssh.arg(&self.destination);

        // `-i` and not `-t`: frames are bytes, and a tty would translate
        // newlines and corrupt them.
        if let Some(container) = &self.container {
            ssh.arg("docker").arg("exec").arg("-i").arg(container);
        }

        ssh.arg("firetower").arg("worker").arg("--stdio");

        if let Some(root) = &self.root {
            ssh.arg("--root").arg(root);
        }

        let mut child = ssh
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Where ssh reports a refused key, a changed host key, or the
            // remote shell's "command not found". Nothing reaches stdout.
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("connecting to {}", self.destination))?;

        let stdout = child.stdout.take().context("ssh stdout was not piped")?;
        let stdin = child.stdin.take().context("ssh stdin was not piped")?;
        let tail = child.stderr.take().map(|e| watch(e, self.describe()));

        Ok(Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            child: Some(child),
            tail,
        })
    }
}

/// Whether we are the image rather than a binary on somebody's machine.
///
/// Set in the Dockerfile, so this is a fact about how we were built rather than
/// a guess from `/.dockerenv` about where we are running.
pub fn in_a_container() -> bool {
    std::env::var_os("FIRETOWER_CONTAINER").is_some()
}

/// What to say when the key is not there.
///
/// In a container the plain answer is worse than unhelpful: the path names a
/// file that exists on the operator's machine, so "no such file" reads as a
/// mistake in what they typed and sends them to check the wrong filesystem.
/// Nothing they can type would work — the two filesystems are not the same one.
fn missing_key(path: &std::path::Path) -> String {
    if in_a_container() {
        format!(
            "no key at {}\n\nFiretower is running in a container, so that path is read inside \
             it rather than on your machine — which is why a key you can see is not one it can. \
             Use Firetower's own key instead: Compute → Add compute shows it.",
            path.display()
        )
    } else {
        format!("no key at {}", path.display())
    }
}

/// Make sense of a key path before anything depends on it.
///
/// Every failure here is one ssh would also refuse, but it refuses at
/// authentication time and in ssh's vocabulary — which reads as a server that
/// rejected you and sends you to look at the wrong machine. Said plainly, while
/// someone is still looking at the form, each of these is a ten-second fix.
pub fn identity_path(raw: &str) -> Result<std::path::PathBuf> {
    let raw = raw.trim();
    anyhow::ensure!(!raw.is_empty(), "no key was given");

    let path = match raw.strip_prefix("~/") {
        Some(rest) => match std::env::var_os("HOME") {
            Some(home) => std::path::PathBuf::from(home).join(rest),
            None => anyhow::bail!("{raw} starts at your home directory, and HOME isn't set"),
        },
        None => std::path::PathBuf::from(raw),
    };

    // A relative path resolves against whatever directory the control plane was
    // started in, which nobody can predict and which changes between running it
    // by hand and running it as a service.
    anyhow::ensure!(
        path.is_absolute(),
        "{raw} is a relative path. Give the whole path, or start it with ~/"
    );

    // The most common mistake by a distance, and worth catching before the
    // permission check below has something confusing to say about it: a public
    // key is meant to be readable by everyone.
    anyhow::ensure!(
        path.extension().is_none_or(|e| e != "pub"),
        "{} is the public half of the pair. Firetower needs the private key — \
         the same path without .pub",
        path.display()
    );

    let found = std::fs::metadata(&path).with_context(|| missing_key(&path))?;

    anyhow::ensure!(found.is_file(), "{} is not a file", path.display());

    // ssh refuses a private key other accounts can read, and it is right to:
    // on a shared machine that is the key already gone. Firetower says so
    // rather than tightening it, because this file is yours and it may be
    // deliberately shared with something else.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = found.permissions().mode() & 0o777;
        anyhow::ensure!(
            mode & 0o077 == 0,
            "{} can be read by other accounts on this machine (mode {mode:o}), \
             and ssh will refuse it. Run: chmod 600 {}",
            path.display(),
            path.display()
        );
    }

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(destination: &str) -> SshTransport {
        SshTransport {
            destination: destination.into(),
            port: None,
            key: ft_core::SshKey::Default,
            home: std::path::PathBuf::from("/var/lib/firetower"),
            // These describe themselves without connecting, and a key ssh
            // chooses for itself never reaches the vault.
            vault: None,
            container: None,
            root: None,
        }
    }

    #[test]
    fn a_transport_describes_itself_for_the_log() {
        assert_eq!(ssh("root@203.0.113.44").describe(), "ssh root@203.0.113.44");
    }

    /// "No worker on that machine" and "no worker in that container" are told
    /// apart from this line, so it has to name the container.
    #[test]
    fn a_containerised_server_says_so_in_its_description() {
        let described = SshTransport {
            container: Some("firetower-worker".into()),
            ..ssh("deploy@fire-01")
        }
        .describe();

        assert_eq!(described, "ssh deploy@fire-01 docker exec firetower-worker");
    }

    #[test]
    fn what_it_took_to_reach_a_host_is_in_the_description() {
        // A connection that failed is read about in a log rather than watched,
        // so the line has to say which key and which port were actually used.
        let described = SshTransport {
            port: Some(2222),
            key: ft_core::SshKey::File { path: "~/.ssh/fire".into() },
            ..ssh("deploy@fire-01")
        }
        .describe();

        assert_eq!(described, "ssh -p 2222 -i ~/.ssh/fire deploy@fire-01");
    }

    /// A remote command that writes one line to stderr and exits 127, leaving
    /// stdout empty. Without the tail, that failure reads only as a closed
    /// stream.
    #[tokio::test]
    async fn what_a_dying_child_said_survives_it() {
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("echo 'bash: firetower: command not found' >&2; exit 127")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("sh is on every machine this runs on");

        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let tail = child.stderr.take().map(|e| watch(e, "test".into()));

        let mut conn = Connection {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            child: Some(child),
            tail,
        };

        // The pipe outlives the process, so waiting first loses nothing and
        // gives the reader task time to drain.
        let status = conn.exit_status().await.expect("it exits immediately");
        assert_eq!(status.code(), Some(127));

        let said = conn.stderr_tail();
        assert!(
            said.iter().any(|l| l.contains("command not found")),
            "the reason should have survived: {said:?}"
        );

        let told = crate::diagnose::from_output(&said, Some(status), &ft_core::Compute::Local);
        assert_eq!(told.cause, ft_core::Cause::WorkerMissing);
    }

    /// Only the last lines are kept, so a healthy worker logging steadily
    /// can't grow this without bound.
    #[tokio::test]
    async fn the_tail_is_a_ring_and_not_a_log() {
        let child = Command::new("sh")
            .arg("-c")
            .arg("for i in $(seq 1 100); do echo line $i >&2; done")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("sh is on every machine this runs on");

        let mut child = child;
        let tail = watch(child.stderr.take().unwrap(), "test".into());
        let _ = child.wait().await;

        // The reader is a task of its own; give it a moment to finish draining.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let held = tail.lock().unwrap();
        assert_eq!(held.len(), KEEP_LINES);
        assert_eq!(
            held.back().map(String::as_str),
            Some("line 100"),
            "the end is what explains a failure"
        );
    }

    #[test]
    fn local_and_ssh_differ_only_in_how_the_command_is_reached() {
        // Both run `firetower worker --stdio`. That is the entire difference
        // between the local milestone and the remote one.
        let local = LocalTransport::new("/tmp/ft").unwrap();
        assert_eq!(local.describe(), "local child process");
    }

    /// Every one of these is a mistake someone makes once, and each has to
    /// arrive as its own sentence — "permission denied (publickey)" is the same
    /// message for all of them and points at the server.
    #[test]
    fn a_key_path_is_read_before_anything_depends_on_it() {
        let said = |raw: &str| identity_path(raw).unwrap_err().to_string();

        assert!(said("").contains("no key"));
        assert!(said(".ssh/id_ed25519").contains("relative path"));
        assert!(said("/no/such/directory/id_ed25519").contains("no key at"));
    }

    #[test]
    fn known_hosts_lives_under_the_state_directory_not_the_container() {
        // ssh's default is $HOME/.ssh/known_hosts, which in the image is the
        // container's writable layer — emptied by every upgrade, after which
        // `accept-new` re-trusts whatever answers. Under the state directory it
        // is on the volume and outlives the container.
        let dir = tempfile::tempdir().unwrap();

        let transport = SshTransport {
            home: dir.path().to_path_buf(),
            ..ssh("deploy@fire-01")
        };

        let path = transport.known_hosts().unwrap();
        assert_eq!(path, dir.path().join("ssh").join("known_hosts"));
        assert!(path.exists(), "ssh is given a file that is already there");

        // Asked for twice, because every connection asks.
        assert_eq!(transport.known_hosts().unwrap(), path);
    }

    #[test]
    fn a_missing_key_in_a_container_says_which_filesystem_was_read() {
        // The path exists on the operator's machine. Saying only "no such file"
        // reads as a typo and sends them to check the wrong one.
        let path = std::path::Path::new("/root/.ssh/id_ed25519");

        let plain = {
            std::env::remove_var("FIRETOWER_CONTAINER");
            missing_key(path)
        };
        assert_eq!(plain, "no key at /root/.ssh/id_ed25519");

        let contained = {
            std::env::set_var("FIRETOWER_CONTAINER", "1");
            let said = missing_key(path);
            std::env::remove_var("FIRETOWER_CONTAINER");
            said
        };
        assert!(contained.contains("running in a container"));
        assert!(contained.contains("Add compute"));
    }

    #[test]
    fn the_public_half_is_named_as_such() {
        // The pair sits in one directory and differs by three characters, so
        // this is the likeliest wrong answer of all.
        let dir = tempfile::tempdir().unwrap();
        let public = dir.path().join("id_ed25519.pub");
        std::fs::write(&public, "ssh-ed25519 AAAA…").unwrap();

        let said = identity_path(public.to_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(said.contains("public half"), "{said}");
    }

    #[test]
    fn a_tilde_is_expanded_rather_than_passed_along() {
        // Read-only: it is the message about a key that isn't there which shows
        // where the path was taken to mean.
        let home = std::env::var("HOME").expect("HOME");
        let said = identity_path("~/no-such-key-lives-here")
            .unwrap_err()
            .to_string();

        assert!(said.contains(&home), "~ should have been expanded: {said}");
    }

    #[cfg(unix)]
    #[test]
    fn a_key_others_can_read_is_refused_rather_than_tightened() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("id_ed25519");
        std::fs::write(&key, "-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();

        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        let said = identity_path(key.to_str().unwrap())
            .unwrap_err()
            .to_string();
        assert!(said.contains("chmod 600"), "{said}");

        // The file is left exactly as it was found: it belongs to whoever put
        // it there, and something else may be relying on how it is shared.
        let mode = std::fs::metadata(&key).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o644, "someone else's key is not ours to change");

        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(identity_path(key.to_str().unwrap()).unwrap(), key);
    }
}
