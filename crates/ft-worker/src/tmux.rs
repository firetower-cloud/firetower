//! The agent's home on a host.
//!
//! Every session gets a tmux session of its own. That's what lets you close the
//! laptop: the agent's parent is the tmux server, not the worker, so restarting
//! the worker — or losing the network — doesn't touch anything that's running.
//!
//! It also means a worker that comes back can find what's still alive by asking
//! tmux, rather than having to have remembered.

use anyhow::{bail, Context, Result};
use std::path::Path;
use tokio::process::Command;

/// How long `has-session` is given before the answer is called unknown.
///
/// Generous, because a slow answer is still an answer and a machine under
/// load is the ordinary condition of a worker. Finite, because the only thing
/// worse than a slow probe is one that never returns: it is awaited on the
/// path that decides whether an agent is gone.
const PROBE_LIMIT: std::time::Duration = std::time::Duration::from_secs(10);

/// One agent, running or not.
#[derive(Debug, Clone)]
pub struct Tmux {
    name: String,
}

impl Tmux {
    /// Named after the session, so `tmux ls` on a host is readable by a human
    /// wondering what Firetower has running.
    ///
    /// What runs in here is the supervisor holding an agent's pipes, not a
    /// terminal anybody attaches to. tmux is here for what it was always here
    /// for — being the parent that outlives a worker — and no longer for being
    /// a screen.
    ///
    /// **This name is a strict prefix of [`Pty::tmux_name`]'s**, which is
    /// `firetower-<id>-shell` for the same session, and tmux matches a `-t`
    /// target loosely: exact, then fnmatch, then prefix. So every question
    /// asked about an agent by name was answered by the shell beside it the
    /// moment somebody opened one. See `Tmux::target` for what that cost and
    /// for the one character that turns it off.
    ///
    /// [`Pty::tmux_name`]: ft_proto::Pty::tmux_name
    pub fn for_session(session_id: &str) -> Self {
        Self::named(format!("firetower-{session_id}"))
    }

    /// A tmux session by name — the shell a session opens alongside its agent.
    pub fn named(name: String) -> Self {
        Self { name }
    }

    /// This session and no other, as tmux takes a target.
    ///
    /// `-t NAME` does not mean the session called `NAME`. tmux tries an exact
    /// match, then fnmatch, then a **prefix**, and takes the first thing that
    /// answers — so with `firetower-<id>-shell` alive, every one of these
    /// commands aimed at `firetower-<id>` hit the shell instead:
    ///
    /// - `has-session` answered true for an agent that had exited, so a
    ///   watcher's EOF was read as "only the watching stopped" and the control
    ///   plane was never told the agent had gone. The session sat in the inbox
    ///   looking alive until somebody typed at it.
    /// - `kill-session` on a session's agent killed that session's shell.
    /// - `show-environment` read the shell back to a shell that was being
    ///   opened to copy the *agent's* environment.
    ///
    /// A leading `=` asks for the name itself and nothing else. Verified on
    /// tmux 3.7c, where `-t =firetower-x` refuses while `-t firetower-x`
    /// cheerfully finds `firetower-x-shell`.
    fn target(&self) -> String {
        format!("={}", self.name)
    }

    /// The same session, where tmux wants a pane rather than a session.
    ///
    /// `capture-pane` and `set-option` take `session:window.pane`, and `=NAME`
    /// read as a pane target is not a session at all — tmux answers `can't
    /// find pane: =NAME` and the call fails against a session that is right
    /// there. The trailing colon is what makes it the session's current pane,
    /// and the `=` then applies to the session half, where it belongs.
    fn pane_target(&self) -> String {
        format!("={}:", self.name)
    }

    /// The environment the session was started with.
    ///
    /// Asked of tmux rather than remembered, because it is the one place these
    /// values already are: they were handed over with `-e` when the agent
    /// started, and a worker deliberately writes them nowhere. Lines that are
    /// not `KEY=value` — tmux prints `-KEY` for one it was told to unset — are
    /// skipped.
    pub async fn environment(&self) -> Result<Vec<(String, String)>> {
        let output = Command::new("tmux")
            .args(["show-environment", "-t", &self.target()])
            .output()
            .await
            .context("reading the session environment")?;

        if !output.status.success() {
            bail!(
                "reading the environment of {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(name, _)| !name.starts_with('-'))
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect())
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Start the agent, detached, in the worktree.
    ///
    /// Environment goes through `-e`, which sets it per session. Setting it on
    /// our own process instead does not work: tmux takes a new session's
    /// environment from the *server*, so whatever the first client happened to
    /// export would be frozen in and a rotated token would never reach a new
    /// session.
    ///
    /// The cost is that values pass through the tmux client's arguments, which
    /// on Linux are world-readable for as long as that call takes. On a host
    /// with untrusted users that is a real window, and closing it means putting
    /// a small wrapper between tmux and the agent to hand the environment over
    /// a socket — the same trick used for git credentials. Worth doing when
    /// shared hosts matter; not yet.
    pub async fn start(&self, cwd: &Path, command: &str, env: &[(String, String)]) -> Result<()> {
        if self.exists().await {
            bail!("{} is already running", self.name);
        }

        let mut args: Vec<String> = ["new-session", "-d", "-s"]
            .iter()
            .map(|a| a.to_string())
            .collect();
        args.push(self.name.clone());
        args.push("-c".into());
        args.push(cwd.to_str().unwrap_or(".").to_string());

        for (key, value) in env {
            args.push("-e".into());
            args.push(format!("{key}={value}"));
        }

        // And again, in front of the command itself.
        //
        // `-e` is not enough on its own: **tmux does not give the first pane
        // the `PATH` it was handed here.** Every other variable arrives — this
        // was found with one that did and one that didn't, on tmux 3.3a — but
        // `PATH` is taken from the server's own environment instead, so the
        // pane gets whatever started the tmux server and never ours.
        //
        // That matters because the agents are on the volume now rather than in
        // the image, and the only thing that says where they are *is* `PATH`.
        // Without this the agent is not on it, and the session fails at
        // `starting codex: No such file or directory` — which reads as a
        // missing install rather than a dropped variable.
        //
        // `-e` stays as well: it is what a window opened later inherits, and
        // somebody attaching to poke around should find the same agent the
        // session ran.
        //
        // The cgroup join goes first of all, ahead of the environment and the
        // command, because it has to happen while this pane is still a shell
        // and before it becomes the agent. Every call into here starts a pane
        // in a workspace's directory, which is the one thing that says which
        // workspace it belongs to — see `cgroup::join_command` for why the
        // pane has to move itself rather than be moved.
        args.push(format!(
            "{} {} {}",
            crate::cgroup::join_command(cwd),
            env_prefix(env),
            command
        ));

        // Before tmux is asked, because what tmux says when this is too big is
        // `command too long` — four words that name neither the session, nor
        // the environment, nor the variable that did it. This says all three.
        if let Some(why) = too_long(&args, env) {
            bail!("{} cannot be started: {why}", self.name);
        }

        let output = Command::new("tmux")
            .args(&args)
            .output()
            .await
            .context("starting tmux")?;
        if !output.status.success() {
            bail!(
                "tmux couldn't start {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }

        // No status bar. It's tmux telling you about tmux, and here the frame
        // around the terminal already says which session you're looking at.
        let _ = Command::new("tmux")
            .args(["set-option", "-t", &self.pane_target(), "status", "off"])
            .output()
            .await;

        Ok(())
    }

    pub async fn exists(&self) -> bool {
        Command::new("tmux")
            .args(["has-session", "-t", &self.target()])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Check existence without treating a failed tmux probe as proof of
    /// absence. Watcher EOF may indicate an agent exit, but only a known
    /// `has-session` miss is enough evidence to close its conversation.
    ///
    /// Bounded, because the question is asked on the path that decides whether
    /// a session is reported gone and `has-session` talks to a server that can
    /// stop answering: a tmux under heavy load, a filesystem that has wedged,
    /// a socket a process is holding without reading. An unbounded probe there
    /// is not a slow answer, it is a watcher task parked for the life of the
    /// worker and a session whose liveness is never resolved either way. A
    /// probe that runs out of time is an *unknown* — the same as any other
    /// unreadable answer — so the conservative path is the one it takes.
    pub(crate) async fn checked_exists(&self) -> Result<bool> {
        let output = tokio::time::timeout(
            PROBE_LIMIT,
            Command::new("tmux")
                .args(["has-session", "-t", &self.target()])
                .output(),
        )
        .await
        .with_context(|| {
            format!(
                "tmux did not answer about {} within {}s",
                self.name,
                PROBE_LIMIT.as_secs()
            )
        })?
        .context("checking the tmux session")?;

        checked_exists_output(
            &self.name,
            output.status.success(),
            output.status.code(),
            &String::from_utf8_lossy(&output.stderr),
        )
    }

    /// Everything on screen and above it.
    ///
    /// Sent when you open a session, so a long-running agent shows its history
    /// rather than whatever it happens to print next.
    pub async fn scrollback(&self) -> Result<String> {
        let output = Command::new("tmux")
            .args([
                "capture-pane",
                "-p",
                "-e",
                "-S",
                "-",
                "-t",
                &self.pane_target(),
            ])
            .output()
            .await
            .context("capturing the pane")?;

        if !output.status.success() {
            bail!(
                "capturing {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Tear it down. Absent is success — the desired state is "not running".
    pub async fn kill(&self) -> Result<()> {
        if !self.exists().await {
            return Ok(());
        }
        let output = Command::new("tmux")
            .args(["kill-session", "-t", &self.target()])
            .output()
            .await
            .context("killing the tmux session")?;

        if !output.status.success() {
            bail!(
                "killing {}: {}",
                self.name,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    /// Which sessions are ours, for a worker picking up where it left off.
    pub async fn ours() -> Result<Vec<String>> {
        let output = Command::new("tmux")
            .args(["list-sessions", "-F", "#{session_name}"])
            .output()
            .await
            .context("listing tmux sessions")?;

        // No server running means no sessions, which is not a failure.
        if !output.status.success() {
            return Ok(Vec::new());
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix("firetower-"))
            .map(str::to_string)
            .collect())
    }
}

/// What one tmux command line holds, in bytes.
///
/// A tmux client packs the whole of `argv` into a single message to its
/// server, and that message is capped: `MAX_IMSGSIZE` (16384) less the header
/// (16) less the argument count (4). Measured against tmux 3.3a, which takes
/// 16364 bytes of packed arguments and refuses 16365 with `command too long`.
///
/// Nothing here can raise it. What a session can do is stay under it, which is
/// why the one value with no ceiling — a profile's system prompt — travels as
/// a file now rather than as a variable. See `agentd::persona_path`.
const COMMAND_LIMIT: usize = 16_364;

/// Why this launch will not fit, if it will not.
///
/// The environment is counted twice on purpose: it is in `argv` twice, once
/// as `-e` arguments and once inlined in front of the command, and somebody
/// reading "9 kB of environment, 16 kB of room" would otherwise be right to
/// think there was space. Naming the largest variable is the whole point —
/// it is almost always one value rather than a hundred small ones.
fn too_long(args: &[String], env: &[(String, String)]) -> Option<String> {
    // A packed argument is its bytes and a terminator, which is what tmux
    // measures.
    let packed: usize = args.iter().map(|arg| arg.len() + 1).sum();
    if packed <= COMMAND_LIMIT {
        return None;
    }

    let biggest = env
        .iter()
        .max_by_key(|(key, value)| key.len() + value.len())
        .map(|(key, value)| {
            format!(
                ", the largest being {key} at {}",
                size(key.len() + value.len() + 1)
            )
        });

    Some(format!(
        "its environment does not fit in a tmux command line. tmux takes {} and this launch is \
         {}, because a session's environment travels in it twice — {} of variables{}. Shorten \
         what this session carries: a profile's instructions, or a repository variable holding a \
         key or a file.",
        size(COMMAND_LIMIT),
        size(packed),
        size(env.iter().map(|(k, v)| k.len() + v.len() + 1).sum()),
        biggest.unwrap_or_default(),
    ))
}

/// Bytes, as somebody reading an error wants them.
fn size(bytes: usize) -> String {
    match bytes < 1024 {
        true => format!("{bytes} B"),
        false => format!("{:.1} kB", bytes as f64 / 1024.0),
    }
}

/// `env 'K=V' 'K=V'` — the environment, set by the shell tmux runs the command
/// with rather than by tmux itself.
///
/// Quoted the same way `structured::tmux_command` quotes its arguments, because
/// this is prepended to exactly that string and goes to the same shell. A value
/// holding a quote is a token, not an attack, but it would break the command
/// just as effectively.
fn env_prefix(env: &[(String, String)]) -> String {
    let mut out = String::from("env");
    for (key, value) in env {
        out.push(' ');
        out.push_str(&quote(&format!("{key}={value}")));
    }
    out
}

fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

fn checked_exists_output(
    name: &str,
    success: bool,
    exit_code: Option<i32>,
    stderr: &str,
) -> Result<bool> {
    if success {
        return Ok(true);
    }

    let stderr = stderr.trim();
    if exit_code == Some(1) && (said_absent(name, stderr) || said_no_server(stderr)) {
        return Ok(false);
    }

    anyhow::bail!(
        "checking {}: {}",
        name,
        if stderr.is_empty() {
            "tmux has-session failed without a diagnostic"
        } else {
            stderr
        }
    )
}

/// Whether tmux said there is no server at all, rather than refusing to say.
///
/// Which is the same fact about a session as `said_absent`, reached from the
/// other end: nothing is listening on that socket, so nothing is running under
/// it. And it is the answer the case this whole path exists for actually
/// produces — a machine that has just rebooted has no tmux server, because
/// tmux had not been started again yet.
///
/// Two wordings, because `no server running on …` is not the only one:
/// tmux 3.3a — Debian bookworm's, and so most Linux hosts — answers
/// `error connecting to /tmp/tmux-1000/default (No such file or directory)`.
/// Only the first was read, and the consequence was the whole feature: on a
/// rebooted machine the probe came back *unreadable*, an unreadable probe is
/// an unknown, and an unknown leaves a dead agent reported alive. Found by
/// running it in a container; it cannot be found on a developer's Mac, where a
/// tmux server is almost always already up and the answer is `NAME not found`
/// instead.
///
/// `(Connection refused)` is the same fact with the socket file still there —
/// a server that died without cleaning up after itself, which is what a crash
/// leaves behind on a machine that does not clear its temporary directory at
/// boot. macOS is that machine.
///
/// Nothing else. `(Permission denied)` is a server somebody else is running
/// and is not an answer about ours, and anything unrecognised stays an
/// unknown — the whole value of this function is that it is the one place that
/// decides, and it decides by recognising rather than by assuming.
///
/// **A socket can go while the server it belongs to lives**, which on its own
/// would make this a guess: something sweeping `/tmp` could take it with the
/// agents still running. What makes it an answer is *where it is asked from*.
/// Both callers have already failed to reach the agent through its own socket
/// — the watcher's, which is a different file in the same directory — so by
/// the time this is read, two sockets are unreachable at once. That is the
/// signature of a temporary directory that was emptied, which is a reboot;
/// and in the case it is not, the agent is already unreachable for turns,
/// permissions and everything else the product does with it. A session nobody
/// can send a word to is one to offer a restart for, whichever way it got
/// there.
fn said_no_server(stderr: &str) -> bool {
    stderr.starts_with("no server running on ")
        || (stderr.starts_with("error connecting to ")
            && (stderr.ends_with("(No such file or directory)")
                || stderr.ends_with("(Connection refused)")))
}

/// Whether tmux said this session is not there, rather than refusing to say.
///
/// The distinction is the whole reason [`Tmux::checked_exists`] exists: a
/// known miss closes a conversation, and anything else must not. So the
/// wording matters, and there is more than one of it. Asking loosely —
/// `-t NAME` — gets `can't find session: NAME`; asking exactly, which is the
/// only way to ask about a session whose name is a prefix of another's, gets
/// that same sentence on tmux 3.7c with the `=` trimmed back off, and
/// `NAME not found` on builds that word it the other way.
///
/// All four are read, because a worker is not upgraded in step with the tmux
/// on its host. One unrecognised wording turns "the agent is gone" into "the
/// probe could not be read", and an unreadable probe is exactly what stops a
/// dead agent from ever being reported dead.
fn said_absent(name: &str, stderr: &str) -> bool {
    [
        format!("can't find session: {name}"),
        format!("can't find session: ={name}"),
        format!("{name} not found"),
        format!("={name} not found"),
    ]
    .iter()
    .any(|wording| stderr == wording)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Unique per test, so a failure never leaves a name that breaks the next run.
    fn unique(tag: &str) -> Tmux {
        Tmux::for_session(&unique_id(tag))
    }

    /// The session id behind it, for a test that needs both an agent's name
    /// and the name of the shell that sits beside it.
    fn unique_id(tag: &str) -> String {
        format!("test-{tag}-{}", std::process::id())
    }

    /// An ordinary session is nowhere near the ceiling, and must not be told
    /// it is.
    #[test]
    fn an_ordinary_launch_fits() {
        let env = vec![
            ("PATH".to_string(), "/usr/bin:/bin".repeat(10)),
            (
                "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                "sk-ant-oat".repeat(8),
            ),
            (
                "FIRETOWER_SESSION".to_string(),
                "s_01m6pbz9p4bn16xpj8".into(),
            ),
        ];
        let args = vec![
            "new-session".to_string(),
            "-d".into(),
            "-s".into(),
            "firetower-s_01m6pbz9p4bn16xpj8".into(),
        ];
        assert!(too_long(&args, &env).is_none());
    }

    /// And when it does not fit, the sentence has to be the one that saves the
    /// next hour: which variable, and how big.
    #[test]
    fn an_oversized_environment_names_what_filled_it() {
        let persona = "You are the Orchestrator. ".repeat(400);
        let env = vec![
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("FIRETOWER_PERSONA".to_string(), persona),
        ];
        // What `start` builds: the variables as `-e` arguments, then the same
        // variables again inlined in front of the command.
        let mut args = vec!["new-session".to_string()];
        for (key, value) in &env {
            args.push("-e".into());
            args.push(format!("{key}={value}"));
        }
        args.push(env_prefix(&env));

        let why = too_long(&args, &env).expect("this does not fit");
        assert!(why.contains("FIRETOWER_PERSONA"), "{why}");
        assert!(why.contains("twice"), "{why}");
    }

    /// Exactly at the ceiling still goes — the limit tmux enforces is the one
    /// measured against it, not one rounded down for comfort.
    #[test]
    fn the_last_byte_that_fits_is_allowed() {
        let args = vec!["x".repeat(COMMAND_LIMIT - 1)];
        assert!(too_long(&args, &[]).is_none());
        let args = vec!["x".repeat(COMMAND_LIMIT)];
        assert!(too_long(&args, &[]).is_some());
    }

    #[test]
    fn checked_presence_only_treats_known_tmux_misses_as_absent() {
        assert!(checked_exists_output("firetower-s_test", true, Some(0), "").unwrap());
        assert!(!checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "can't find session: firetower-s_test\n"
        )
        .unwrap());
        assert!(!checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "no server running on /tmp/tmux-501/default\n"
        )
        .unwrap());
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "failed to connect to server: resource temporarily unavailable\n"
        )
        .is_err());
        assert!(checked_exists_output("firetower-s_test", false, Some(1), "").is_err());
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            Some(2),
            "can't find session: firetower-s_test"
        )
        .is_err());
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            None,
            "can't find session: firetower-s_test"
        )
        .is_err());
    }

    /// The wording a rebooted machine actually produces.
    ///
    /// This is the one that was missing, and it was the whole feature: with no
    /// tmux server at all, tmux 3.3a says `error connecting to … (No such file
    /// or directory)` rather than `no server running on …`, so a machine that
    /// had just restarted answered the probe unreadably and every agent on it
    /// went on being reported alive. Verified against tmux 3.3a in the
    /// container harness, where `has-session` exits 1 with exactly this.
    #[test]
    fn no_tmux_server_at_all_is_an_answer_whichever_way_it_is_worded() {
        for wording in [
            // tmux 3.4 and later.
            "no server running on /tmp/tmux-1000/default",
            // Debian bookworm's 3.3a, and so most Linux hosts.
            "error connecting to /tmp/tmux-1000/default (No such file or directory)",
            // A socket left behind by a server that died: macOS, which does
            // not clear its temporary directory at every boot.
            "error connecting to /var/folders/x/y/T/tmux-501/default (Connection refused)",
        ] {
            assert!(
                !checked_exists_output("firetower-s_test", false, Some(1), wording).unwrap(),
                "{wording:?} means there is no session"
            );
        }

        // And a server that is there and will not talk to us is not an answer
        // about anything. A probe that cannot be read has to stay an unknown,
        // because an unknown leaves a live agent alone.
        for unknown in [
            "error connecting to /tmp/tmux-0/default (Permission denied)",
            "error connecting to /tmp/tmux-1000/default (Connection timed out)",
            "failed to connect to server: resource temporarily unavailable",
        ] {
            assert!(
                checked_exists_output("firetower-s_test", false, Some(1), unknown).is_err(),
                "{unknown:?} is not an answer"
            );
        }
    }

    /// Asking exactly changes the sentence, and the sentence is parsed.
    ///
    /// `has-session` is asked with `-t =NAME` now, because that is the only
    /// form that will not answer about the shell beside the agent. tmux 3.7c
    /// replies to a miss with the familiar `can't find session:` and trims the
    /// `=` back off; other builds keep the `=` or word it `NAME not found`.
    /// Every one of those means absent, and reading one of them as "the probe
    /// failed" is what would stop a dead agent from ever being reported dead —
    /// the fault this whole path exists to report.
    #[test]
    fn an_exact_probe_is_still_read_as_absent_whichever_way_tmux_words_it() {
        for wording in [
            "can't find session: firetower-s_test",
            "can't find session: =firetower-s_test",
            "firetower-s_test not found",
            "=firetower-s_test not found",
        ] {
            assert!(
                !checked_exists_output("firetower-s_test", false, Some(1), wording).unwrap(),
                "{wording:?} says the session is not there"
            );
        }

        // And a sentence about another session is still not an answer about
        // this one.
        assert!(checked_exists_output(
            "firetower-s_test",
            false,
            Some(1),
            "can't find session: firetower-s_other"
        )
        .is_err());
    }

    /// The shell beside an agent must not answer for the agent.
    ///
    /// `Tmux::for_session` is `firetower-<id>` and `Pty::tmux_name` is
    /// `firetower-<id>-shell`, so an agent's name is a strict prefix of its
    /// own shell's, and tmux will take a prefix match when nothing matches
    /// exactly. With a shell open, `has-session` therefore said yes about an
    /// agent that had exited — which is how the control plane was told the
    /// watching had stopped rather than that the agent had gone, and how a
    /// session sat in the inbox looking alive until somebody typed at it. The
    /// same slip pointed `kill-session` at the person's shell.
    #[tokio::test]
    async fn a_sessions_shell_is_not_its_agent() {
        let dir = TempDir::new().unwrap();
        let id = unique_id("prefix");
        let agent = Tmux::for_session(&id);
        let shell = Tmux::named(ft_proto::Pty::Shell.tmux_name(&id));
        assert!(
            shell.name().starts_with(agent.name()),
            "the trap this is about is that one name is a prefix of the other"
        );

        // Only the shell, which is the state a session is in whenever somebody
        // has opened a terminal and the agent has since gone.
        shell.start(dir.path(), "sleep 30", &[]).await.unwrap();

        let loosely_there = agent.exists().await;
        let checked = agent.checked_exists().await;
        // Tearing down an agent that is not there has to be a no-op, not a
        // kill of the shell standing next to it.
        let killing = agent.kill().await;
        let shell_survived = shell.exists().await;
        let _ = shell.kill().await;

        assert!(!loosely_there, "the shell is not the agent");
        assert!(
            !checked.expect("tmux answered, so this is not an unreadable probe"),
            "the shell is not the agent"
        );
        assert!(killing.is_ok(), "{killing:?}");
        assert!(
            shell_survived,
            "killing a session's agent must not take that session's shell with it"
        );
    }

    /// The one tmux drops.
    ///
    /// `-e PATH=…` sets the session environment and the first pane never sees
    /// it — tmux uses the server's own `PATH` instead. Everything else passes,
    /// which is what made this hard to see: the agent's `CODEX_HOME` arrived
    /// and the agent itself could not be found.
    #[tokio::test]
    async fn the_first_pane_gets_the_path_it_was_given() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("path");
        let marker = dir.path().join("seen");

        // A directory holding one program, which is only findable through the
        // PATH we pass — exactly the shape of an agent on the volume.
        let bin = dir.path().join("bin");
        tokio::fs::create_dir_all(&bin).await.unwrap();
        let program = bin.join("firetower-test-agent");
        tokio::fs::write(
            &program,
            format!("#!/bin/sh\necho found > {}\n", marker.display()),
        )
        .await
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755))
                .await
                .unwrap();
        }

        let path = format!(
            "{}:{}",
            std::env::var("PATH").unwrap_or_default(),
            bin.display()
        );
        tmux.start(
            dir.path(),
            "firetower-test-agent",
            &[("PATH".to_string(), path)],
        )
        .await
        .unwrap();

        for _ in 0..50 {
            if marker.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = tmux.kill().await;

        assert!(
            marker.exists(),
            "the pane could not run a program that was on the PATH it was given"
        );
    }

    #[tokio::test]
    async fn an_agent_outlives_the_command_that_started_it() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("detach");

        tmux.start(dir.path(), "sleep 30", &[]).await.unwrap();
        assert!(
            tmux.exists().await,
            "the session should be running detached"
        );

        tmux.kill().await.unwrap();
        assert!(!tmux.exists().await);
    }

    #[tokio::test]
    async fn killing_something_already_gone_is_fine() {
        // Tearing down twice happens whenever a retry meets a success.
        unique("absent").kill().await.unwrap();
    }

    #[tokio::test]
    async fn the_environment_reaches_the_agent() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("env");

        // The command writes the variable out, proving it arrived.
        tmux.start(
            dir.path(),
            "printenv FIRETOWER_TEST_SECRET > seen.txt; sleep 5",
            &[("FIRETOWER_TEST_SECRET".into(), "s3cret-value".into())],
        )
        .await
        .unwrap();

        // Wait for content, not for the file: the redirect creates it before
        // the command writes, so existence alone is a race the test loses.
        let mut seen = String::new();
        for _ in 0..40 {
            seen = tokio::fs::read_to_string(dir.path().join("seen.txt"))
                .await
                .unwrap_or_default();
            if !seen.trim().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tmux.kill().await.unwrap();

        assert_eq!(
            seen.trim(),
            "s3cret-value",
            "the agent should see the value"
        );
    }

    #[tokio::test]
    async fn scrollback_returns_what_the_agent_printed() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("scroll");

        tmux.start(dir.path(), "echo hello-from-the-agent; sleep 10", &[])
            .await
            .unwrap();

        let mut seen = String::new();
        for _ in 0..40 {
            seen = tmux.scrollback().await.unwrap_or_default();
            if seen.contains("hello-from-the-agent") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        tmux.kill().await.unwrap();

        assert!(seen.contains("hello-from-the-agent"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_worker_can_find_what_it_left_running() {
        let dir = TempDir::new().unwrap();
        let tmux = unique("adopt");
        let id = tmux.name().strip_prefix("firetower-").unwrap().to_string();

        tmux.start(dir.path(), "sleep 30", &[]).await.unwrap();
        let found = Tmux::ours().await.unwrap();
        tmux.kill().await.unwrap();

        assert!(found.contains(&id), "{found:?}");
    }
}
