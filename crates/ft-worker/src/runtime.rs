//! The agents this machine can run, and where they came from.
//!
//! Each agent is fetched as the standalone binary its publisher ships — Claude
//! Code from its own download service, Codex from its GitHub releases — and
//! kept under the worker's state directory, one directory per version:
//!
//! ```text
//! <state>/agents/claude-code/2.1.0/bin/claude
//! <state>/agents/codex/0.154.0/bin/codex
//! ```
//!
//! Not through npm. Both agents used to be installed that way, which made Node
//! a requirement of every machine a worker ran on — and Node is exactly the
//! thing people install through a version manager, into a directory only their
//! interactive shell knows about. A worker started by sshd never saw it. A
//! binary in a directory this module chose needs nothing on the machine but
//! `curl` and `tar`, and is found by the `PATH` the worker builds itself.
//!
//! **Nothing here touches a credential.** Installing a binary and signing it
//! in are separate acts, and only the first happens on this machine: what an
//! agent authenticates with is held by the control plane and handed over per
//! session.

use anyhow::{bail, Context, Result};
use ft_core::Agent;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tokio::process::Command;

/// The variable, and the value, that stops an agent replacing itself.
///
/// Claude Code's binary checks for a newer one and swaps itself out unless told
/// not to. The version a session runs is the one this worker installed and the
/// one the Agents screen shows, so it is told not to. Codex has no such switch
/// and ignores the variable, which is the right thing for it to do.
pub const NO_SELF_UPDATE: (&str, &str) = ("DISABLE_AUTOUPDATER", "1");

/// Where installed agents live, under the worker's own state directory.
pub fn root(state: &Path) -> PathBuf {
    state.join("agents")
}

/// One agent this machine has, and which copy answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub kind: Agent,
    pub version: String,
    /// The directory holding its executable.
    pub bin: PathBuf,
}

/// Everything Firetower has installed here.
///
/// Reads the directory rather than remembering: an operator who deleted one by
/// hand is telling us something, and a record that disagreed with the disk
/// would be worse than no record.
pub async fn installed(state: &Path) -> Vec<Installed> {
    let mut out = Vec::new();
    for kind in Agent::all() {
        if let Some(one) = newest(state, kind).await {
            out.push(one);
        }
    }
    out
}

/// The newest version of one agent, if any is here.
pub async fn newest(state: &Path, kind: Agent) -> Option<Installed> {
    let dir = root(state).join(directory(kind));
    let mut entries = tokio::fs::read_dir(&dir).await.ok()?;

    let mut versions: Vec<String> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        // A fetch that was interrupted leaves its scratch directory behind,
        // and that is not a version.
        if name.starts_with('.') {
            continue;
        }
        if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            versions.push(name);
        }
    }

    versions.sort_by_key(|v| version_order(v));
    let version = versions.pop()?;
    let bin = dir.join(&version).join("bin");
    tokio::fs::metadata(&bin).await.ok()?;

    Some(Installed { kind, version, bin })
}

/// Numeric where it can be, so `0.10.0` sorts after `0.9.0`.
fn version_order(version: &str) -> Vec<u64> {
    version
        .split(['.', '-'])
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

/// The `PATH` a process should have to find these.
///
/// **Appended, never prepended.** A machine that has its own `claude` — a
/// version manager, a build somebody pinned, a package the operator installed
/// — keeps using it, and ours answers only when nothing else does. Prepending
/// would silently override a choice somebody made deliberately.
pub async fn path_with_agents(state: &Path) -> std::ffi::OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&existing).collect();

    for one in installed(state).await {
        dirs.push(one.bin);
    }

    std::env::join_paths(dirs).unwrap_or(existing)
}

/// Give a command the agents this machine has.
pub async fn with_agents(command: &mut Command, state: &Path) {
    command.env("PATH", path_with_agents(state).await);
}

/// Fetch one, into a directory named for the version it turned out to be.
///
/// Installed beside whatever is already there rather than over it: a fetch
/// that fails half way leaves the working copy alone, and going back to the
/// previous version is a directory that is still sitting there.
pub async fn install(state: &Path, kind: Agent, version: Option<&str>) -> Result<Installed> {
    if !kind.installable() {
        bail!("{} is not something Firetower installs", kind.label());
    }

    let platform = Platform::here()?;

    let dir = root(state).join(directory(kind));
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("making {}", dir.display()))?;

    // Into a scratch directory first, then renamed once it is whole.
    let staging = dir.join(".installing");
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let bin = staging.join("bin");
    tokio::fs::create_dir_all(&bin)
        .await
        .with_context(|| format!("making {}", bin.display()))?;

    let fetched = match kind {
        Agent::ClaudeCode => fetch_claude(&bin, &platform, version).await,
        Agent::Codex => fetch_codex(&bin, &platform, version).await,
        Agent::Shell => unreachable!("refused above"),
    };
    if let Err(e) = fetched {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(e).with_context(|| format!("installing {}", kind.label()));
    }

    // What it says it is, from the binary itself, rather than what was asked
    // for: `latest` does not say what it resolved to, and a directory called
    // `latest` would be a lie the day after.
    let version = version_of(&bin.join(kind.command()))
        .await
        .or_else(|| version.map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());

    let home = dir.join(&version);
    let _ = tokio::fs::remove_dir_all(&home).await;
    tokio::fs::rename(&staging, &home)
        .await
        .with_context(|| format!("moving {} into place", kind.label()))?;

    Ok(Installed {
        kind,
        version,
        bin: home.join("bin"),
    })
}

/// Remove every copy of one.
pub async fn remove(state: &Path, kind: Agent) -> Result<()> {
    let dir = root(state).join(directory(kind));
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        // Already gone is the wanted state.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("removing {}", dir.display())),
    }
}

/// The directory name for an agent. Stable, and never the label.
fn directory(kind: Agent) -> &'static str {
    match kind {
        Agent::ClaudeCode => "claude-code",
        Agent::Codex => "codex",
        Agent::Shell => "shell",
    }
}

// ── the machine ──────────────────────────────────────────────────────

/// What this machine is, in the two words a publisher's download URL wants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Platform {
    os: Os,
    arch: Arch,
    /// Linux with musl rather than glibc. Claude Code ships a separate build
    /// for it; Codex ships musl for every Linux and does not care.
    musl: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Os {
    Darwin,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arch {
    X86_64,
    Aarch64,
}

impl Platform {
    fn here() -> Result<Self> {
        let os = match std::env::consts::OS {
            "macos" => Os::Darwin,
            "linux" => Os::Linux,
            other => bail!("no agent build is published for {other}"),
        };
        let arch = match std::env::consts::ARCH {
            "x86_64" => Arch::X86_64,
            "aarch64" => Arch::Aarch64,
            other => bail!("no agent build is published for {other}"),
        };
        let musl = os == Os::Linux
            && (cfg!(target_env = "musl")
                && !Path::new("/lib/x86_64-linux-gnu").exists()
                && !Path::new("/lib/aarch64-linux-gnu").exists()
                && !Path::new("/lib64/ld-linux-x86-64.so.2").exists()
                || Path::new("/lib/libc.musl-x86_64.so.1").exists()
                || Path::new("/lib/libc.musl-aarch64.so.1").exists());
        Ok(Self { os, arch, musl })
    }

    /// How Claude Code's download service names this machine.
    fn claude(&self) -> String {
        let arch = match self.arch {
            Arch::X86_64 => "x64",
            Arch::Aarch64 => "arm64",
        };
        match (self.os, self.musl) {
            (Os::Darwin, _) => format!("darwin-{arch}"),
            (Os::Linux, false) => format!("linux-{arch}"),
            (Os::Linux, true) => format!("linux-{arch}-musl"),
        }
    }

    /// How Codex's release names this machine: a Rust target triple.
    fn codex(&self) -> &'static str {
        match (self.os, self.arch) {
            (Os::Darwin, Arch::Aarch64) => "aarch64-apple-darwin",
            (Os::Darwin, Arch::X86_64) => "x86_64-apple-darwin",
            (Os::Linux, Arch::Aarch64) => "aarch64-unknown-linux-musl",
            (Os::Linux, Arch::X86_64) => "x86_64-unknown-linux-musl",
        }
    }
}

// ── Claude Code ──────────────────────────────────────────────────────

/// Where Claude Code publishes its native binaries.
///
/// The same service and the same layout its own installer reads: `latest` is
/// a version, `<version>/manifest.json` carries a checksum per platform, and
/// the binary is at `<version>/<platform>/claude`.
const CLAUDE_RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";

async fn fetch_claude(bin: &Path, platform: &Platform, version: Option<&str>) -> Result<()> {
    let version = match version {
        Some(v) => v.to_string(),
        None => {
            let said = text(&format!("{CLAUDE_RELEASES}/latest"))
                .await
                .context("asking which Claude Code is newest")?;
            let said = said.trim().to_string();
            if !looks_like_a_version(&said) {
                bail!("the download service did not answer with a version: {said:.60}");
            }
            said
        }
    };

    let manifest = text(&format!("{CLAUDE_RELEASES}/{version}/manifest.json"))
        .await
        .with_context(|| format!("reading the manifest for Claude Code {version}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest).context("the manifest is not JSON")?;
    let name = platform.claude();
    let expected = manifest
        .get("platforms")
        .and_then(|p| p.get(&name))
        .and_then(|p| p.get("checksum"))
        .and_then(|c| c.as_str())
        .with_context(|| format!("Claude Code {version} is not published for {name}"))?
        .to_string();

    let target = bin.join("claude");
    download(
        &format!("{CLAUDE_RELEASES}/{version}/{name}/claude"),
        &target,
    )
    .await
    .with_context(|| format!("downloading Claude Code {version}"))?;

    let actual = sha256_of(&target).await?;
    if actual != expected {
        bail!("Claude Code {version} did not match its published checksum");
    }

    executable(&target).await
}

// ── Codex ────────────────────────────────────────────────────────────

/// Where Codex publishes its binaries: one tarball per target on each release.
const CODEX_RELEASES: &str = "https://github.com/openai/codex/releases";

async fn fetch_codex(bin: &Path, platform: &Platform, version: Option<&str>) -> Result<()> {
    let target = platform.codex();
    let asset = format!("codex-{target}.tar.gz");
    let url = match version {
        // Codex tags its releases `rust-v<version>`.
        Some(v) => format!("{CODEX_RELEASES}/download/rust-v{v}/{asset}"),
        None => format!("{CODEX_RELEASES}/latest/download/{asset}"),
    };

    let scratch = bin.join(".unpack");
    tokio::fs::create_dir_all(&scratch).await?;
    let archive = scratch.join(&asset);
    download(&url, &archive)
        .await
        .context("downloading Codex")?;
    untar(&archive, &scratch).await.context("unpacking Codex")?;
    let _ = tokio::fs::remove_file(&archive).await;

    let found = find_binary(&scratch, "codex", target).await;
    let Some(found) = found else {
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        bail!("the Codex release for {target} had no binary in it");
    };

    let installed = bin.join("codex");
    tokio::fs::rename(&found, &installed)
        .await
        .with_context(|| format!("moving {} into place", found.display()))?;
    let _ = tokio::fs::remove_dir_all(&scratch).await;

    executable(&installed).await
}

/// The executable in an unpacked release.
///
/// Codex's tarball holds one file, named for its target. Looked for by name
/// first and by being the only file second, so a release that renames it
/// still installs.
async fn find_binary(dir: &Path, name: &str, target: &str) -> Option<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(here) = pending.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&here).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            match entry.file_type().await {
                Ok(t) if t.is_dir() => pending.push(path),
                Ok(t) if t.is_file() => files.push(path),
                _ => {}
            }
        }
    }
    pick_binary(&files, name, target)
}

fn pick_binary(files: &[PathBuf], name: &str, target: &str) -> Option<PathBuf> {
    let named = |wanted: &str| {
        files
            .iter()
            .find(|f| f.file_name().is_some_and(|n| n == wanted))
            .cloned()
    };
    named(&format!("{name}-{target}"))
        .or_else(|| named(name))
        .or_else(|| {
            files
                .iter()
                .find(|f| {
                    f.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(name) && !n.ends_with(".sigstore"))
                })
                .cloned()
        })
        .or_else(|| (files.len() == 1).then(|| files[0].clone()))
}

// ── the tools this uses ──────────────────────────────────────────────

/// Fetch a URL to a file.
///
/// `curl` rather than an HTTP client compiled in: it is on the list of things
/// a machine needs anyway, it knows the machine's proxies and certificates
/// without being told, and it keeps a TLS stack out of a binary whose job is
/// tmux and git.
///
/// **`stdin` is nulled deliberately.** `tokio`'s `output()` leaves stdin
/// inherited, and when the caller is the worker daemon that is the frame pipe
/// from the control plane. Nothing here has a use for it.
async fn download(url: &str, to: &Path) -> Result<()> {
    let output = Command::new("curl")
        .args(["-fsSL", "--retry", "3", "-o"])
        .arg(to)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .context("running curl — is it installed on this machine?")?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{url}: {}",
            said.lines().last().unwrap_or("curl said nothing").trim()
        );
    }
    Ok(())
}

/// Fetch a URL as text.
async fn text(url: &str) -> Result<String> {
    let output = Command::new("curl")
        .args(["-fsSL", "--retry", "3", url])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .context("running curl — is it installed on this machine?")?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{url}: {}",
            said.lines().last().unwrap_or("curl said nothing").trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn untar(archive: &Path, into: &Path) -> Result<()> {
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(into)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .context("running tar — is it installed on this machine?")?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{}",
            said.lines().last().unwrap_or("tar said nothing").trim()
        );
    }
    Ok(())
}

async fn sha256_of(path: &Path) -> Result<String> {
    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("reading {}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

async fn executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .await
            .with_context(|| format!("marking {} executable", path.display()))?;
    }
    Ok(())
}

/// What a binary says its version is, from `--version`.
///
/// Claude Code says `2.1.0 (Claude Code)`; Codex says `codex-cli 0.154.0`. The
/// first word that looks like a version is the answer for both, and for
/// whatever either prints next year.
async fn version_of(binary: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        Command::new(binary)
            .arg("--version")
            .env(NO_SELF_UPDATE.0, NO_SELF_UPDATE.1)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    version_in(&String::from_utf8_lossy(&output.stdout))
}

fn version_in(said: &str) -> Option<String> {
    said.split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.'))
        .map(|word| word.strip_prefix('v').unwrap_or(word))
        .find(|word| looks_like_a_version(word))
        .map(str::to_string)
}

fn looks_like_a_version(word: &str) -> bool {
    let mut parts = word.split('.');
    let mut count = 0;
    for part in parts.by_ref() {
        let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return false;
        }
        count += 1;
    }
    count >= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn nothing_installed_is_an_empty_answer_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(installed(dir.path()).await.is_empty());
        assert!(newest(dir.path(), Agent::ClaudeCode).await.is_none());
    }

    /// A machine's own copy wins. Ours is the fallback, which is why it goes on
    /// the end.
    #[tokio::test]
    async fn our_copies_are_appended_so_the_machines_own_still_wins() {
        let dir = tempfile::tempdir().unwrap();
        let bin = root(dir.path())
            .join("claude-code")
            .join("2.1.0")
            .join("bin");
        tokio::fs::create_dir_all(&bin).await.unwrap();

        let path = path_with_agents(dir.path()).await;
        let dirs: Vec<_> = std::env::split_paths(&path).collect();

        assert_eq!(
            dirs.last().map(|p| p.as_path()),
            Some(bin.as_path()),
            "ours must be last, or it overrides a binary somebody chose"
        );
        assert!(dirs.len() > 1, "the existing PATH has to survive");
    }

    /// `0.10.0` is newer than `0.9.0`, whatever the alphabet says.
    #[tokio::test]
    async fn the_newest_version_is_the_numerically_largest() {
        let dir = tempfile::tempdir().unwrap();
        for v in ["0.9.0", "0.10.0", "0.2.0"] {
            tokio::fs::create_dir_all(root(dir.path()).join("codex").join(v).join("bin"))
                .await
                .unwrap();
        }
        // And a fetch that never finished is not a version.
        tokio::fs::create_dir_all(root(dir.path()).join("codex").join(".installing"))
            .await
            .unwrap();

        let newest = newest(dir.path(), Agent::Codex).await.unwrap();
        assert_eq!(newest.version, "0.10.0");
    }

    /// Removing what is not there is success: the wanted state is "absent".
    #[tokio::test]
    async fn removing_something_absent_is_fine() {
        let dir = tempfile::tempdir().unwrap();
        remove(dir.path(), Agent::Codex).await.unwrap();
    }

    #[tokio::test]
    async fn a_shell_is_not_something_we_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let refused = install(dir.path(), Agent::Shell, None).await;
        assert!(refused.is_err(), "there is nothing to fetch for a shell");
    }

    #[test]
    fn the_version_is_read_out_of_whatever_the_binary_prints() {
        assert_eq!(version_in("2.1.0 (Claude Code)").as_deref(), Some("2.1.0"));
        assert_eq!(version_in("codex-cli 0.154.0").as_deref(), Some("0.154.0"));
        assert_eq!(
            version_in("v1.2.3-beta.1\n").as_deref(),
            Some("1.2.3-beta.1")
        );
        assert_eq!(version_in("no version here"), None);
    }

    #[test]
    fn each_publisher_is_asked_in_its_own_words() {
        let mac = Platform {
            os: Os::Darwin,
            arch: Arch::Aarch64,
            musl: false,
        };
        assert_eq!(mac.claude(), "darwin-arm64");
        assert_eq!(mac.codex(), "aarch64-apple-darwin");

        let debian = Platform {
            os: Os::Linux,
            arch: Arch::X86_64,
            musl: false,
        };
        assert_eq!(debian.claude(), "linux-x64");
        assert_eq!(debian.codex(), "x86_64-unknown-linux-musl");

        let alpine = Platform {
            os: Os::Linux,
            arch: Arch::Aarch64,
            musl: true,
        };
        assert_eq!(alpine.claude(), "linux-arm64-musl");
    }

    #[test]
    fn the_binary_in_a_release_is_found_by_name_then_by_being_alone() {
        let named = vec![
            PathBuf::from("/x/README"),
            PathBuf::from("/x/codex-aarch64-apple-darwin"),
        ];
        assert_eq!(
            pick_binary(&named, "codex", "aarch64-apple-darwin"),
            Some(PathBuf::from("/x/codex-aarch64-apple-darwin"))
        );

        let alone = vec![PathBuf::from("/x/whatever")];
        assert_eq!(
            pick_binary(&alone, "codex", "aarch64-apple-darwin"),
            Some(PathBuf::from("/x/whatever"))
        );

        let nothing: Vec<PathBuf> = vec![];
        assert_eq!(pick_binary(&nothing, "codex", "aarch64-apple-darwin"), None);
    }
}
