//! Putting a worker on a machine that has none.
//!
//! The control plane and the worker are built from the same source at the same
//! version, and the connection that would run the worker is already open — so
//! the binary a bare host needs is one Firetower is holding, and it can go down
//! the wire it is already trusted on. What used to be here instead was a
//! `cargo build` in the interface, which asks somebody to install Rust on a
//! machine whose whole purpose is to not have things installed on it.
//!
//! What this never does: use sudo, write outside the account's home, or touch a
//! worker somebody else installed. It writes one directory —
//! `~/.firetower/worker/bin` — which the worker already owns, and which
//! [`crate::transport::worker_command`] puts last on PATH so an operator's own
//! copy still wins.

use crate::transport::{SshTransport, INSTALLED_BIN, WORKER_BINARY};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// What to send, and how the far end will have to run it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub path: PathBuf,
    /// Whether this is the control plane's own binary rather than a worker.
    ///
    /// They are two programs: a worker answers `--stdio`, and the control plane
    /// answers `worker --stdio`. Sending the wrong one under the right name
    /// produces `unknown option '--stdio'` on a machine nobody is looking at,
    /// so the difference is carried here and settled by a two-line wrapper.
    pub needs_wrapper: bool,
}

/// The worker to send: the one built beside us, or failing that, ourselves.
///
/// A release image carries both binaries, so the first branch is the usual one
/// and the far end gets exactly the program it is asked for. The second is what
/// makes this work for a control plane installed on its own — the binary
/// running this code can do the worker's job, it is just spelled differently.
pub fn source_from(exe: &Path) -> Result<Source> {
    let sibling = exe.with_file_name(WORKER_BINARY);
    if sibling.is_file() {
        return Ok(Source {
            path: sibling,
            needs_wrapper: false,
        });
    }
    anyhow::ensure!(
        exe.is_file(),
        "there is no worker binary to send: {} is not a file",
        exe.display()
    );
    Ok(Source {
        path: exe.to_path_buf(),
        needs_wrapper: true,
    })
}

pub fn source() -> Result<Source> {
    source_from(&std::env::current_exe().context("locating the Firetower binary")?)
}

/// Whether a binary built here will run there.
///
/// `uname -sm` rather than two round trips. The alias list is short on purpose:
/// these are the names the machines Firetower runs on actually answer with, and
/// guessing beyond them is how a binary that cannot run gets installed anyway.
pub fn runs_there(uname_sm: &str, os: &str, arch: &str) -> bool {
    let mut parts = uname_sm.split_whitespace();
    let (Some(their_os), Some(their_arch)) = (parts.next(), parts.next()) else {
        return false;
    };
    let same_os = match os {
        "linux" => their_os.eq_ignore_ascii_case("linux"),
        "macos" => their_os.eq_ignore_ascii_case("darwin"),
        _ => false,
    };
    let same_arch = match arch {
        "x86_64" => matches!(their_arch, "x86_64" | "amd64"),
        "aarch64" => matches!(their_arch, "aarch64" | "arm64"),
        other => their_arch == other,
    };
    same_os && same_arch
}

/// Said to whoever asked, when the machine is the wrong shape for our binary.
///
/// Names both sides. "Architecture mismatch" sends somebody to check the wrong
/// machine half the time.
pub fn mismatch(uname_sm: &str) -> String {
    format!(
        "that machine is {}, and this control plane is {} {} — its own binary will not run there. \
         Install a firetower-worker built for that machine into {INSTALLED_BIN}, or onto its PATH.",
        uname_sm.trim(),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
}

/// The script that catches the bytes on the other end.
///
/// Written to a dot-file and moved into place, so a connection that drops
/// halfway leaves nothing that looks like a worker. `chmod` before the move for
/// the same reason.
pub fn receive(needs_wrapper: bool) -> String {
    let landing = if needs_wrapper {
        "firetower"
    } else {
        WORKER_BINARY
    };
    let mut script = format!(
        "set -e
mkdir -p \"{INSTALLED_BIN}\"
cat > \"{INSTALLED_BIN}/.incoming\"
chmod 755 \"{INSTALLED_BIN}/.incoming\"
mv \"{INSTALLED_BIN}/.incoming\" \"{INSTALLED_BIN}/{landing}\"
"
    );
    if needs_wrapper {
        // `dirname $0` rather than the literal directory: a home that is not
        // where we think it is still resolves, and the wrapper keeps working if
        // the account moves.
        script.push_str(&format!(
            "printf '%s\\n' '#!/bin/sh' 'exec \"$(dirname \"$0\")/firetower\" worker \"$@\"' > \"{INSTALLED_BIN}/{WORKER_BINARY}\"
chmod 755 \"{INSTALLED_BIN}/{WORKER_BINARY}\"
"
        ));
    }
    script
}

/// Put the worker there, and say what version answered afterwards.
pub async fn install(ssh: &SshTransport) -> Result<String> {
    let uname = ssh
        .ask("uname -sm")
        .await
        .context("asking the machine what it is")?;
    anyhow::ensure!(
        runs_there(&uname, std::env::consts::OS, std::env::consts::ARCH),
        "{}",
        mismatch(&uname)
    );

    let source = source()?;
    ssh.send(&receive(source.needs_wrapper), &source.path)
        .await
        .context("sending the worker")?;

    // Asked the way a connection will ask, so this fails here rather than at
    // the next launch if the installed copy cannot answer.
    ssh.ask(&format!("{} --version", crate::transport::worker_command()))
        .await
        .context("the worker was copied, but did not answer --version")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_worker_built_beside_us() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("firetower");
        std::fs::write(&exe, "control plane").unwrap();
        std::fs::write(dir.path().join(WORKER_BINARY), "worker").unwrap();

        let source = source_from(&exe).unwrap();
        assert_eq!(source.path, dir.path().join(WORKER_BINARY));
        assert!(
            !source.needs_wrapper,
            "a real worker is run by the name it is asked for"
        );
    }

    #[test]
    fn falls_back_to_ourselves_and_says_it_needs_the_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("firetower");
        std::fs::write(&exe, "control plane").unwrap();

        let source = source_from(&exe).unwrap();
        assert_eq!(source.path, exe);
        assert!(source.needs_wrapper);
    }

    #[test]
    fn refuses_to_send_a_binary_that_is_not_there() {
        let dir = tempfile::tempdir().unwrap();
        assert!(source_from(&dir.path().join("gone")).is_err());
    }

    #[test]
    fn a_machine_of_the_same_shape_takes_our_binary() {
        assert!(runs_there("Linux x86_64", "linux", "x86_64"));
        assert!(runs_there("Linux amd64", "linux", "x86_64"));
        assert!(runs_there("Linux aarch64", "linux", "aarch64"));
        assert!(runs_there("Darwin arm64", "macos", "aarch64"));
    }

    #[test]
    fn a_machine_of_another_shape_does_not() {
        assert!(!runs_there("Linux aarch64", "linux", "x86_64"));
        assert!(!runs_there("Darwin arm64", "linux", "aarch64"));
        assert!(!runs_there("Linux", "linux", "x86_64"), "half an answer");
        assert!(!runs_there("", "linux", "x86_64"));
    }

    #[test]
    fn the_mismatch_names_both_machines() {
        let said = mismatch("Linux aarch64");
        assert!(said.contains("Linux aarch64"), "{said}");
        assert!(said.contains(std::env::consts::ARCH), "{said}");
    }

    /// Nothing lands under a name a connection would try until it is complete.
    #[test]
    fn a_dropped_connection_leaves_nothing_that_looks_like_a_worker() {
        for wrapper in [false, true] {
            let script = receive(wrapper);
            let landing = script
                .lines()
                .find(|l| l.starts_with("cat >"))
                .expect("it catches the bytes");
            assert!(landing.contains("/.incoming"), "{landing}");
            assert!(
                script.contains(&format!("chmod 755 \"{INSTALLED_BIN}/.incoming\"")),
                "executable before it is in place, and every path quoted: {script}"
            );
            assert!(script.starts_with("set -e"), "stops at the first failure");
        }
    }

    #[test]
    fn our_own_binary_is_installed_under_a_name_that_answers_stdio() {
        let script = receive(true);
        assert!(
            script.contains(&format!(
                "mv \"{INSTALLED_BIN}/.incoming\" \"{INSTALLED_BIN}/firetower\"\n"
            )),
            "{script}"
        );
        assert!(
            script.contains("exec \"$(dirname \"$0\")/firetower\" worker \"$@\""),
            "the wrapper turns `--stdio` into `worker --stdio`: {script}"
        );
        assert!(script.contains(&format!("chmod 755 \"{INSTALLED_BIN}/{WORKER_BINARY}\"")));
    }

    #[test]
    fn a_real_worker_needs_no_wrapper() {
        let script = receive(false);
        assert!(script.contains(&format!(
            "mv \"{INSTALLED_BIN}/.incoming\" \"{INSTALLED_BIN}/{WORKER_BINARY}\""
        )));
        assert!(!script.contains("dirname"), "nothing to wrap: {script}");
    }
}
