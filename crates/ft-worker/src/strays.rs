//! The processes a workspace leaves behind.
//!
//! Killing the tmux session reaches the pane and its foreground process group,
//! and nothing else. What the agent started and detached — a `pnpm dev`, the
//! `workerd` under a `wrangler dev`, a watcher — outlives the pane, reparents
//! to init, and goes on holding its memory with the workspace it was started
//! in already deleted. Teardown therefore needs something that can say which
//! processes belong to a workspace *after the fact*, with no parent left to
//! ask. Each platform has exactly one such thing, and this is where the two
//! meet.
//!
//! ## Linux says it with the cgroup
//!
//! A pane puts itself in `ft-w_<workspace>/agents` before it becomes the
//! agent, and cgroup membership is inherited by everything it forks and
//! survives reparenting. The tree under the workspace's cgroup *is* the
//! workspace's processes. See [`crate::cgroup::kill`].
//!
//! ## macOS says it with the environment
//!
//! There are no cgroups, and the obvious substitutes are all worse than
//! useless. The parent chain is gone: an orphan reparents to launchd the
//! moment the shell that started it exits, which is long before teardown runs,
//! so a walk down from the pane finds nothing at all. Process groups and
//! sessions are no better — `setsid` is precisely what a daemonising dev
//! server calls, and it leaves both.
//!
//! What does survive is the environment. Every pane is started with
//! `FIRETOWER_SESSION` in it, the kernel copies the environment through every
//! fork and every exec, and reparenting does not touch it. On the machine this
//! was written on there were 23 orphans holding 159 MB between them, the
//! oldest six days past the deletion of the workspace it belonged to, and
//! every one of them still correctly tagged. It is the same inheritance the
//! cgroup gives us, written somewhere the kernel will not take away.
//!
//! The tag names a *session* and the thing being torn down is a *workspace*,
//! so the caller passes every session that ever worked there rather than only
//! the one it was asked to destroy — otherwise a dev server left by a sibling
//! that ended last week would be missed, and the Linux side, which empties the
//! whole cgroup, would be doing a different job from this one.
//!
//! ## The tmux server carries a tag too, and must never be killed
//!
//! The server is forked from the first `new-session` the worker ever ran, so
//! it inherits that session's environment and keeps it for as long as it
//! lives. On the machine this was written on that was a server eleven days
//! old, tagged with a session whose workspace had been deleted a week before —
//! and the parent of every pane of every other session on the box. A selector
//! that trusted the tag alone would have killed it and taken down every
//! workspace on the worker at once.
//!
//! So it is excluded twice over, deliberately: by the pid tmux itself reports,
//! which is exact, and by refusing to kill anything whose executable is tmux,
//! which still holds if the first answer could not be had. Neither is a
//! heuristic worth softening.
//!
//! ## Nothing here is fatal
//!
//! Teardown must finish. A process whose environment cannot be read is skipped
//! rather than guessed at, a tmux that will not answer costs the exact
//! exclusion and not the careful one, and a platform with neither handle does
//! nothing quietly.

use std::path::Path;

use ft_core::SessionId;

/// Kill everything the workspace still has running.
///
/// `sessions` is every session that has ever worked in this workspace, which
/// is what its processes are tagged with; `session` is the one being
/// destroyed, for the log.
///
/// **Only for the last agent out.** Both handles here belong to the workspace
/// rather than to the session that happens to be ending, so a sibling agent
/// still working would be killed by this. The `alone` check in teardown is
/// what establishes that it is safe, and it stays at the call site — see
/// [`crate::cgroup::remove`] for why nothing down here decides it for itself.
pub async fn kill(workspace: &Path, sessions: &[SessionId], session: &SessionId) {
    crate::cgroup::kill(workspace, session).await;

    #[cfg(target_os = "macos")]
    by_tag(sessions, session).await;

    // The tag is read through `sysctl`, which is a macOS interface; everywhere
    // else the cgroup above is the whole of what we have.
    #[cfg(not(target_os = "macos"))]
    let _ = sessions;
}

/// How many times to ask, and how long to wait between asking.
///
/// A second pass rather than one, for the same reason the Linux side has
/// rounds: a supervisor restarting the dev server it has just lost puts a new
/// process where the one we killed was, and a snapshot taken before the signal
/// cannot know about it. Fewer rounds than the cgroup needs, because there is
/// no `rmdir` waiting on this to be finished — nothing here is waiting for the
/// processes to be *reaped*, only for them to stop running.
#[cfg(target_os = "macos")]
const ROUNDS: u32 = 5;
#[cfg(target_os = "macos")]
const PAUSE: std::time::Duration = std::time::Duration::from_millis(50);

/// Kill every process carrying one of these sessions' tags.
#[cfg(target_os = "macos")]
async fn by_tag(sessions: &[SessionId], session: &SessionId) {
    let tags: Vec<&str> = sessions.iter().map(SessionId::as_str).collect();
    let spare = tmux_server().await;

    // Asked before anything is killed so that the log can say what teardown
    // found, which is the number somebody wants when their memory came back.
    let found = strays(&tags, spare);
    if found.is_empty() {
        return;
    }

    for stray in &found {
        tracing::info!(
            session = %session,
            pid = stray.pid,
            "killing a process the workspace left running: {}",
            stray.command
        );
    }

    let mut left = found;
    for _ in 0..ROUNDS {
        if left.is_empty() {
            break;
        }
        for stray in &left {
            // SAFETY: kill takes a pid and a signal and touches no memory of
            // ours. `ESRCH` on one that has already gone is the ordinary
            // answer and there is nothing to do with it.
            unsafe { libc::kill(stray.pid, libc::SIGKILL) };
        }
        tokio::time::sleep(PAUSE).await;
        left = strays(&tags, spare);
    }

    if !left.is_empty() {
        // A warning because this is the leak, still leaking: memory that will
        // not come back until somebody finds these by hand.
        tracing::warn!(
            session = %session,
            pids = ?left.iter().map(|s| s.pid).collect::<Vec<_>>(),
            "{} processes in the workspace would not die",
            left.len()
        );
    }
}

/// One process that belongs to a workspace being torn down.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct Stray {
    pid: i32,
    /// What it is, for the log. A pid alone tells nobody whether teardown
    /// killed their dev server or something they will miss.
    command: String,
}

/// Every process tagged with one of these sessions, less the ones that are
/// never ours to kill.
///
/// `spare` is the tmux server, which carries a tag of its own and is the
/// parent of every pane on the machine. See this module's header.
#[cfg(target_os = "macos")]
fn strays(tags: &[&str], spare: Option<i32>) -> Vec<Stray> {
    // The worker is not necessarily untagged: it can be started from inside a
    // session by somebody working on Firetower with Firetower, and a teardown
    // that kills the process running it finishes nothing.
    let own = std::process::id() as i32;
    let mut buffer = vec![0u8; argmax()];

    pids()
        .into_iter()
        .filter(|pid| *pid != own && Some(*pid) != spare && *pid > 1)
        .filter_map(|pid| {
            let described = describe(pid, &mut buffer)?;
            if !described
                .session
                .is_some_and(|tag| tags.contains(&tag.as_str()))
            {
                return None;
            }
            // The second guard on the tmux server, and the one that holds when
            // tmux could not be asked which pid it is. A server started from a
            // session carries that session's tag for life.
            if described
                .exec
                .file_name()
                .is_some_and(|name| name == "tmux")
            {
                tracing::warn!(
                    pid,
                    "not killing the tmux server, which carries a tag of its own"
                );
                return None;
            }
            Some(Stray {
                pid,
                command: described.command,
            })
        })
        .collect()
}

/// The pid of the tmux server, which tmux is the only thing that knows.
///
/// `None` when there is no server to ask or it would not answer, which is not
/// a reason to stop: the executable test in [`strays`] excludes it either way.
#[cfg(target_os = "macos")]
async fn tmux_server() -> Option<i32> {
    let output = tokio::process::Command::new("tmux")
        .args(["display-message", "-p", "#{pid}"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

/// What one process says about itself.
#[cfg(target_os = "macos")]
struct Described {
    exec: std::path::PathBuf,
    command: String,
    session: Option<String>,
}

/// Every process on the machine.
///
/// All of them rather than a subtree, because a subtree is exactly what an
/// orphan has left: the list is the only place it still appears.
#[cfg(target_os = "macos")]
fn pids() -> Vec<i32> {
    // SAFETY: a null buffer asks for the size rather than the contents, which
    // is what this call is documented to answer.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }

    // Generous room: processes start while we are asking, and a buffer the
    // kernel fills to the brim is one that may have had more to say.
    let mut pids = vec![0i32; count as usize + 256];
    let bytes = (std::mem::size_of::<i32>() * pids.len()) as i32;
    // SAFETY: the buffer is pids.len() * 4 bytes of initialised memory and
    // `bytes` says so; the call writes whole pids into it.
    let written = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    if written <= 0 {
        return Vec::new();
    }

    // What came back is read from the buffer rather than from the return
    // value, which is a count here and documented as a length in bytes — the
    // two differ by four, and believing the wrong one silently drops three
    // quarters of the machine. Every entry the kernel did not write is still
    // the zero it was initialised to, so taking what is nonzero is true under
    // either reading.
    pids.retain(|pid| *pid > 0);
    pids
}

/// How much room the kernel may want for one process's arguments.
///
/// Asked rather than assumed, and asked once per scan: the answer is a
/// megabyte on every machine seen so far, which is worth allocating a single
/// time and not once per process.
#[cfg(target_os = "macos")]
fn argmax() -> usize {
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let mut value: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: two name elements are described by the 2 that follows them, and
    // the result is one int written into an int-sized initialised buffer.
    let result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut value as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };

    // A megabyte, which is what every macOS has answered since the question
    // was first asked, and enough for an environment nobody would recognise.
    if result != 0 || value <= 0 {
        return 1 << 20;
    }
    value as usize
}

/// A process's executable, its command line and its session tag.
///
/// `KERN_PROCARGS2` is the only interface that gives the environment of
/// another process, and it gives it to the same user only — which is the right
/// answer anyway: a worker has no business killing somebody else's processes.
/// A process that has gone between the listing and this call, or that belongs
/// to another user, is skipped rather than guessed at.
///
/// The buffer it fills is `argc`, then the executable path, then padding, then
/// `argc` arguments, then the environment, all NUL-terminated and run
/// together. Walking it is the whole of the parsing, and reading the
/// environment honestly — rather than looking for the tag anywhere in the
/// block — is what keeps a `tmux new-session -e FIRETOWER_SESSION=…` on
/// somebody's command line from being mistaken for a process that carries it.
#[cfg(target_os = "macos")]
fn describe(pid: i32, buffer: &mut [u8]) -> Option<Described> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = buffer.len();
    // SAFETY: three name elements described by the 3 that follows them, and a
    // buffer of `size` initialised bytes for the kernel to fill; `size` comes
    // back as how much it wrote.
    let result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return None;
    }

    parse(&buffer[..size])
}

/// Walk one `KERN_PROCARGS2` block. Separated from the call that fills it so
/// that it can be read against bytes a test wrote by hand.
#[cfg(target_os = "macos")]
fn parse(block: &[u8]) -> Option<Described> {
    let (count, mut rest) = block.split_at_checked(4)?;
    let argc = i32::from_ne_bytes(count.try_into().ok()?);

    // The executable comes first and is not one of the arguments.
    let exec = next(&mut rest)?;

    // Then padding: the kernel aligns what follows, and the gap is NULs.
    while rest.first() == Some(&0) {
        rest = &rest[1..];
    }

    let mut command = Vec::new();
    for _ in 0..argc.max(0) {
        let Some(argument) = next(&mut rest) else {
            break;
        };
        command.push(String::from_utf8_lossy(argument).into_owned());
    }

    // And the rest is the environment, which is the point of all of this.
    let mut session = None;
    while let Some(entry) = next(&mut rest) {
        if let Some(value) = entry.strip_prefix(ft_core::SESSION_ENV.as_bytes()) {
            if let Some(value) = value.strip_prefix(b"=") {
                session = Some(String::from_utf8_lossy(value).into_owned());
            }
        }
    }

    Some(Described {
        exec: std::path::PathBuf::from(String::from_utf8_lossy(exec).into_owned()),
        command: match command.is_empty() {
            true => String::from_utf8_lossy(exec).into_owned(),
            false => command.join(" "),
        },
        session,
    })
}

/// Whether a process has reached the state [`kill`] could find it in.
///
/// Test-only, and shared with the teardown test over in `lib.rs`, which starts
/// the same kind of decoy and has to wait for the same moment. Both halves
/// matter and neither implies the other: a pid the process list has not
/// published yet is not scanned, and a process that has not finished `exec`ing
/// has no environment to read the tag out of. See `tests::detached` for what
/// waiting on anything earlier costs.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn visible(pid: i32, tag: &str) -> bool {
    pids().contains(&pid)
        && describe(pid, &mut vec![0u8; argmax()])
            .and_then(|it| it.session)
            .is_some_and(|it| it == tag)
}

/// The next NUL-terminated string, leaving the cursor after it.
#[cfg(target_os = "macos")]
fn next<'a>(rest: &mut &'a [u8]) -> Option<&'a [u8]> {
    let end = rest.iter().position(|byte| *byte == 0)?;
    let (string, after) = rest.split_at(end);
    *rest = &after[1..];
    Some(string)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// A tag no process on this machine can be carrying.
    ///
    /// These tests kill what they find, and they run on a developer's laptop
    /// beside their real sessions. Nothing but a tag invented here is ever
    /// hunted for.
    fn invented() -> String {
        format!(
            "s_test_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    /// A process in the shape of the leak: detached from the shell that
    /// started it, orphaned onto launchd, and carrying the tag it inherited —
    /// which by then is the only thing that says where it came from.
    ///
    /// This binary, told to sit still, rather than the `sleep` a test would
    /// reach for first. macOS shows nobody but root the environment of an
    /// Apple *platform* binary, and everything in `/bin` is one: a `/bin/sleep`
    /// is invisible to the very handle under test here, while anything built
    /// by Homebrew or cargo — node, pnpm, esbuild, workerd, this test — is
    /// read without trouble. See [`describe`], which says the same thing where
    /// somebody reading the module will meet it.
    fn detached(tag: &str) -> i32 {
        let own = std::env::current_exe().expect("a test has a binary");
        let started = std::process::Command::new("sh")
            .env(ft_core::SESSION_ENV, tag)
            .env("FT_STRAY_SLEEPER", "1")
            .args([
                "-c",
                &format!(
                    "'{}' --exact strays::tests::the_sleeper --ignored \
                        >/dev/null 2>&1 </dev/null & echo $!",
                    own.display()
                ),
            ])
            .output()
            .expect("the shell should run");

        let pid: i32 = String::from_utf8_lossy(&started.stdout)
            .trim()
            .parse()
            .expect("the shell should have said the pid");

        // Started is not the same as findable, and the gap is where a test
        // asks its question a moment too early and calls the answer a bug.
        //
        // A process reaches the state [`strays`] needs only once it has
        // `exec`ed. Before that the kernel has no saved environment for it at
        // all — a fork of the shell reads back with the shell's arguments and
        // no environment, tag included — and during the `exec` itself there is
        // a window where it cannot be read at all. Both were watched happening
        // on a laptop, in microseconds; a loaded CI runner starting a debug
        // binary stays in them for long enough to be scanned in the middle,
        // which is what made this fail there and nowhere else.
        //
        // So the wait is for exactly what the scan reads — the process list
        // and the environment on it — and not for some earlier state that
        // merely implies them.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if visible(pid, tag) {
                return pid;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Loudly, and here rather than in whichever assertion came next. A
        // decoy that cannot be seen is how every test that uses one passes for
        // the wrong reason — the selector could be returning nothing at all
        // and they would still be green.
        panic!("the decoy never became visible to a scan: {}", why(pid));
    }

    /// What the scan can see about one pid, for an assertion that failed to
    /// explain itself. A pid and "not found" is the start of the question
    /// rather than the answer to it, and on a machine somebody cannot log in
    /// to it is the whole of what they get.
    fn why(pid: i32) -> String {
        format!(
            "pid {pid}: listed={}, described={:?}",
            pids().contains(&pid),
            describe(pid, &mut vec![0u8; argmax()]).map(|it| format!(
                "tag={:?} exec={:?}",
                it.session,
                it.exec.file_name()
            ))
        )
    }

    /// Not a test: the process the tests above go looking for, which has to be
    /// this binary and therefore has to be a test. Harmless when run by
    /// anything else — a `cargo test -- --ignored` sweep finds no instruction
    /// to wait and returns.
    #[test]
    #[ignore = "the process other tests go looking for, not a test itself"]
    fn the_sleeper() {
        if std::env::var_os("FT_STRAY_SLEEPER").is_none() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
    }

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 asks whether a pid exists and sends nothing.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    fn stop(pid: i32) {
        // SAFETY: as above, with a signal this time.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }

    /// The handle itself: a detached process is found by the tag it inherited,
    /// and one that never had it is not touched.
    #[test]
    fn a_process_is_found_by_the_tag_it_inherited() {
        let tag = invented();
        let ours = detached(&tag);
        let theirs = detached(&invented());
        assert!(alive(ours) && alive(theirs), "both are there to be found");

        let found = strays(&[&tag], None);
        stop(ours);
        stop(theirs);

        let pids: Vec<i32> = found.iter().map(|stray| stray.pid).collect();
        assert!(pids.contains(&ours), "{pids:?} should hold {}", why(ours));
        assert!(
            !pids.contains(&theirs),
            "another session's process is not ours to kill: {pids:?}"
        );
        assert!(
            found
                .iter()
                .any(|stray| stray.command.contains("the_sleeper")),
            "the log needs to say what was killed, not only which pid: {found:?}"
        );
    }

    /// **The one that matters.** A tmux server is forked from the first
    /// `new-session` a client ever ran and keeps that client's environment for
    /// life, while being the parent of every pane of every other session on
    /// the machine. Killing it takes the whole worker down with it.
    ///
    /// On a server of this test's own, on a socket of its own, because the
    /// alternative is a test that asks whatever server the machine happens to
    /// be running — which on a laptop is one started long ago from an
    /// untagged shell, so there is nothing to spare and the test quietly
    /// proves nothing. A private socket makes the dangerous case on purpose,
    /// the same way the real one came about, and the premise is asserted
    /// rather than assumed: a server forked from a tagged client really does
    /// carry the tag.
    ///
    /// Asked with no server pid passed in, so what spares it is the second
    /// guard — the executable — on its own. And the decoy is what keeps the
    /// whole thing honest: it carries the same tag and must be found, so an
    /// empty answer cannot pass for a careful one.
    #[tokio::test]
    async fn the_tmux_server_is_spared_though_it_carries_a_tag() {
        let tag = invented();
        let socket = format!("ft-{tag}");

        let started = tokio::process::Command::new("tmux")
            .env(ft_core::SESSION_ENV, &tag)
            .args([
                "-L",
                &socket,
                "new-session",
                "-d",
                "-s",
                "probe",
                "sleep",
                "30",
            ])
            .output()
            .await
            .expect("tmux should run");
        assert!(
            started.status.success(),
            "tmux: {}",
            String::from_utf8_lossy(&started.stderr)
        );

        let asked = tokio::process::Command::new("tmux")
            .args(["-L", &socket, "display-message", "-p", "#{pid}"])
            .output()
            .await
            .expect("tmux should run");
        let server: i32 = String::from_utf8_lossy(&asked.stdout)
            .trim()
            .parse()
            .expect("tmux should name its own server");

        let carried = describe(server, &mut vec![0u8; argmax()]).and_then(|it| it.session);
        assert_eq!(
            carried.as_deref(),
            Some(tag.as_str()),
            "the premise: a server forked from a tagged client carries the tag"
        );

        let decoy = detached(&tag);
        let before = visible(decoy, &tag);
        let found = strays(&[&tag], None);
        // Before the cleanup below, or it describes what the cleanup did
        // rather than what the scan saw.
        let report = format!(
            "visible before={before} after={}, {}",
            visible(decoy, &tag),
            why(decoy)
        );
        stop(decoy);
        let _ = tokio::process::Command::new("tmux")
            .args(["-L", &socket, "kill-server"])
            .output()
            .await;

        let pids: Vec<i32> = found.iter().map(|stray| stray.pid).collect();
        assert!(
            !pids.contains(&server),
            "the tmux server must never be killed: {pids:?} holds {server}"
        );
        assert!(
            pids.contains(&decoy),
            "and the tag must still select, or this proves nothing: {pids:?}, {report}"
        );
    }

    /// The first guard, on its own: a pid tmux named as its server is spared
    /// whatever it is running. Asserted against a process that is not tmux, so
    /// that the executable test cannot be the thing doing the work.
    #[test]
    fn the_pid_tmux_names_is_spared_whatever_it_is() {
        let tag = invented();
        let pretender = detached(&tag);

        let before = visible(pretender, &tag);
        let without = strays(&[&tag], None);
        let after = visible(pretender, &tag);
        let with = strays(&[&tag], Some(pretender));
        let report = format!("visible before={before} after={after}, {}", why(pretender));
        stop(pretender);

        assert!(
            without.iter().any(|stray| stray.pid == pretender),
            "the process is there to be found: {report}"
        );
        assert!(
            !with.iter().any(|stray| stray.pid == pretender),
            "and named as the server, it is left alone"
        );
    }

    /// The tag is read from the environment and from nowhere else.
    ///
    /// `ps` prints a process's arguments and its environment run together, and
    /// a worker's own `tmux new-session -e FIRETOWER_SESSION=…` puts that text
    /// on a command line. Anything matching the block as a whole would take
    /// the client for the session and kill the server. Walked properly, the
    /// argument is an argument.
    #[test]
    fn the_tag_is_read_from_the_environment_and_not_the_command_line() {
        let mut block = Vec::new();
        block.extend_from_slice(&2i32.to_ne_bytes());
        block.extend_from_slice(b"/opt/homebrew/bin/tmux\0");
        block.extend_from_slice(b"\0\0\0");
        block.extend_from_slice(b"tmux\0");
        block.extend_from_slice(b"-e FIRETOWER_SESSION=s_on_the_command_line\0");
        block.extend_from_slice(b"PATH=/usr/bin\0");
        block.extend_from_slice(b"FIRETOWER_SESSION=s_in_the_environment\0");

        let described = parse(&block).expect("a well-formed block parses");
        assert_eq!(described.session.as_deref(), Some("s_in_the_environment"));
        assert_eq!(described.exec.file_name().unwrap(), "tmux");
        assert!(
            described.command.contains("s_on_the_command_line"),
            "the arguments are still the arguments: {}",
            described.command
        );
    }

    /// Nothing that is not a process is a process. A truncated block is what a
    /// read that raced a process's exit looks like.
    #[test]
    fn a_block_that_says_nothing_is_not_guessed_at() {
        assert!(parse(&[]).is_none());
        assert!(parse(&[1, 2, 3]).is_none());
        assert!(parse(&2i32.to_ne_bytes()).is_none());
    }

    /// What this machine is carrying, by session, and what would be spared.
    ///
    /// Not an assertion — a survey, for looking at a worker that is leaking.
    /// `FT_STRAY_SESSIONS=s_one,s_two cargo test -p ft-worker what_this
    /// -- --ignored --nocapture` lists exactly what teardown would kill for
    /// those sessions; with nothing named it lists everything tagged, which is
    /// how the 23 orphans in this module's header were found.
    #[tokio::test]
    #[ignore = "a survey of the machine it runs on, not an assertion"]
    async fn what_this_machine_is_carrying() {
        let spare = tmux_server().await;
        println!("tmux server: {spare:?}");

        match std::env::var("FT_STRAY_SESSIONS") {
            Ok(named) => {
                let tags: Vec<&str> = named.split(',').map(str::trim).collect();
                let found = strays(&tags, spare);
                for stray in &found {
                    println!("would kill {:>7}  {}", stray.pid, stray.command);
                }
                println!("{} processes, for {} sessions", found.len(), tags.len());
            }
            Err(_) => {
                let mut buffer = vec![0u8; argmax()];
                let mut carried = 0;
                for pid in pids() {
                    let Some(described) = describe(pid, &mut buffer) else {
                        continue;
                    };
                    let Some(session) = described.session else {
                        continue;
                    };
                    carried += 1;
                    let spared = match () {
                        _ if Some(pid) == spare => " (spared: the tmux server)",
                        _ if described.exec.file_name().is_some_and(|n| n == "tmux") => {
                            " (spared: tmux)"
                        }
                        _ => "",
                    };
                    println!("{pid:>7}  {session}  {}{spared}", described.command);
                }
                println!("{carried} processes carry a tag");
            }
        }
    }
}
