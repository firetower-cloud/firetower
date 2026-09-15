//! Putting a worker on a machine that has none.
//!
//! One installer, in one place: the script in `install/worker.sh`. A person
//! runs it with `curl | sh`; this module runs the same script over the ssh
//! connection Firetower already has, so the two can never disagree about
//! where the worker goes or what the machine needs. It fetches the release
//! built for *that* machine, which is what lets a Linux control plane put a
//! worker on a Mac.
//!
//! What this never does: use sudo, write outside the account's home, or touch
//! a worker somebody else installed. The script writes one directory —
//! `~/.firetower/worker` — which the worker already owns, and which
//! [`crate::transport::worker_command`] puts last on PATH so an operator's own
//! copy still wins.
//!
//! ## Testing without a release
//!
//! A release is what the script downloads from. Between releases — a checkout
//! being worked on — there is none with this version in it, so the control
//! plane can be pointed at a directory of tarballs instead:
//! `FIRETOWER_WORKER_ARTIFACTS=target/artifacts`, holding
//! `firetower-worker-<os>-<arch>.tar.gz` as `just build-worker` makes them.
//! When the one for the machine's shape is there it is streamed down the
//! connection and the script installs it from stdin; when it is not, the
//! script downloads as it would for anybody.

use crate::transport::{SshTransport, INSTALLED_ROOT};
use anyhow::{Context, Result};
use std::path::PathBuf;

/// The installer, as shipped in this build.
pub const SCRIPT: &str = include_str!("../../../install/worker.sh");

/// Where the same script is published, for the line a person types.
pub const SCRIPT_URL: &str = "https://usefiretower.com/worker.sh";

/// The directory of tarballs to install from instead of a release.
pub const ARTIFACTS_ENV: &str = "FIRETOWER_WORKER_ARTIFACTS";

/// Where the script lands on the machine before it runs.
const REMOTE_SCRIPT: &str = "$HOME/.firetower/worker/install.sh";

/// The one line to run on a machine.
///
/// With the key, it also authorises Firetower on the account, so the machine
/// can be added the moment the script finishes. Without it — in a diagnosis,
/// where the key is a screen away — it installs and says so.
pub fn one_liner(public_key: Option<&str>) -> String {
    match public_key {
        Some(key) => format!(
            "curl -fsSL {SCRIPT_URL} | sh -s -- --authorize '{}'",
            key.trim().replace('\'', "'\\''")
        ),
        None => format!("curl -fsSL {SCRIPT_URL} | sh"),
    }
}

/// The release asset built for a machine, from what `uname -sm` said.
///
/// The names are the script's names, and the script's names are the release
/// job's: `darwin`/`linux`, `arm64`/`x86_64`. The alias list is short on
/// purpose — these are what the machines Firetower runs on answer with.
pub fn artifact_for(uname_sm: &str) -> Result<String> {
    let mut parts = uname_sm.split_whitespace();
    let (Some(os), Some(arch)) = (parts.next(), parts.next()) else {
        anyhow::bail!("that machine did not say what it is: `{}`", uname_sm.trim());
    };
    let os = match os.to_ascii_lowercase().as_str() {
        "darwin" => "darwin",
        "linux" => "linux",
        other => anyhow::bail!("no worker is published for {other}"),
    };
    let arch = match arch.to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => "x86_64",
        "aarch64" | "arm64" => "arm64",
        other => anyhow::bail!("no worker is published for {os} on {other}"),
    };
    Ok(format!("firetower-worker-{os}-{arch}.tar.gz"))
}

/// A tarball for this machine, in the directory the environment names.
///
/// `None` when nothing was named, or when what was named has no tarball of
/// that name — either way the script downloads, which is the ordinary path.
pub fn local_artifact(asset: &str) -> Option<PathBuf> {
    let dir = std::env::var_os(ARTIFACTS_ENV).map(PathBuf::from)?;
    let path = dir.join(asset);
    path.is_file().then_some(path)
}

/// Put this build's version of the worker there, and say what version
/// answered afterwards.
///
/// The version is `None` when the script ran and the probe did not answer.
/// Those are two outcomes, and treating the second as a failed install throws
/// away a worker that is sitting there working: the real verdict is the
/// supervisor's next connection.
pub async fn install(ssh: &SshTransport) -> Result<Option<String>> {
    install_version(ssh, env!("CARGO_PKG_VERSION")).await?;

    // Asked the way a connection will ask, so a probe and a session resolve to
    // the same binary. Not fatal: the install is what was requested, and the
    // real verdict is the supervisor's next connection.
    match ssh.ask(&crate::transport::worker_probe()).await {
        Ok(version) => Ok(Some(version)),
        Err(e) => {
            tracing::warn!("the worker was installed, but did not answer --version: {e:#}");
            Ok(None)
        }
    }
}

/// Run the installer on the machine for one version, and hand back what it
/// printed.
///
/// The script goes first, into the directory it will fill — sent rather than
/// fetched by the machine, so the version of the script that runs is this
/// build's. Then the tarball, if this build has one for that machine's shape;
/// otherwise the script downloads it from the release.
pub async fn install_version(ssh: &SshTransport, version: &str) -> Result<String> {
    let uname = ssh
        .ask("uname -sm")
        .await
        .context("asking the machine what it is")?;
    let asset = artifact_for(&uname)?;

    ssh.send_text(
        &format!("mkdir -p \"{INSTALLED_ROOT}\" && cat > \"{REMOTE_SCRIPT}\""),
        SCRIPT,
    )
    .await
    .context("sending the installer")?;

    let run = format!("sh \"{REMOTE_SCRIPT}\" --yes --version {version}");

    match local_artifact(&asset) {
        Some(tarball) => {
            tracing::info!(
                asset,
                from = %tarball.display(),
                "installing the worker from a local build"
            );
            ssh.send(&format!("{run} --from -"), &tarball)
                .await
                .context("installing the worker from the local build")
        }
        None => ssh.ask(&run).await.context("installing the worker"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_of_each_shape_gets_its_own_tarball() {
        assert_eq!(
            artifact_for("Darwin arm64").unwrap(),
            "firetower-worker-darwin-arm64.tar.gz"
        );
        assert_eq!(
            artifact_for("Linux x86_64\n").unwrap(),
            "firetower-worker-linux-x86_64.tar.gz"
        );
        assert_eq!(
            artifact_for("Linux aarch64").unwrap(),
            "firetower-worker-linux-arm64.tar.gz"
        );
        assert_eq!(
            artifact_for("Linux amd64").unwrap(),
            "firetower-worker-linux-x86_64.tar.gz"
        );
    }

    #[test]
    fn a_machine_of_another_shape_is_refused_with_its_name() {
        let said = artifact_for("FreeBSD amd64").unwrap_err().to_string();
        assert!(said.contains("freebsd"), "{said}");
        assert!(artifact_for("Linux").is_err(), "half an answer");
        assert!(artifact_for("").is_err());
    }

    /// The key goes into single quotes on the far end, so one inside it has
    /// to be escaped the way a shell wants.
    #[test]
    fn the_one_liner_carries_the_key_safely() {
        let line = one_liner(Some("ssh-ed25519 AAAA firetower"));
        assert!(line
            .starts_with("curl -fsSL https://usefiretower.com/worker.sh | sh -s -- --authorize '"));
        assert!(line.ends_with("'ssh-ed25519 AAAA firetower'"), "{line}");

        let odd = one_liner(Some("it's"));
        assert!(odd.contains(r"'it'\''s'"), "{odd}");

        assert_eq!(
            one_liner(None),
            "curl -fsSL https://usefiretower.com/worker.sh | sh"
        );
    }

    /// The script is what runs on every machine, so it has to be here.
    #[test]
    fn the_installer_ships_with_the_control_plane() {
        assert!(SCRIPT.starts_with("#!/bin/sh"), "a POSIX script, not bash");
        assert!(SCRIPT.contains("--authorize"));
        assert!(SCRIPT.contains("--from"));
        assert!(SCRIPT.contains("--version"));
        assert!(SCRIPT.contains("--yes"));
    }

    #[test]
    fn nothing_named_means_nothing_local() {
        std::env::remove_var(ARTIFACTS_ENV);
        assert!(local_artifact("firetower-worker-darwin-arm64.tar.gz").is_none());
    }
}
