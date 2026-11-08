//! The agents this machine can run, and where they came from.
//!
//! Each agent is fetched as the standalone binary its publisher ships — Claude
//! Code and Kimi Code from their own download services, Codex and Mistral Vibe
//! from their GitHub releases — and kept under the worker's state directory,
//! one per version:
//!
//! ```text
//! <state>/agents/claude-code/2.1.0/bin/claude
//! <state>/agents/codex/0.154.0/bin/codex
//! <state>/agents/codex/0.154.0/bin/codex-code-mode-host
//! <state>/agents/kimi/2.1.1/bin/kimi
//! <state>/agents/mistral-vibe/3.1.0/bin/vibe-acp
//! ```
//!
//! Codex is two binaries, and both of them are Codex — see `CODE_MODE_HOST`.
//!
//! Not through npm. All three publish an npm package and all three were
//! installed from it once, which made Node a requirement of every machine a
//! worker ran on — and Node is exactly the thing people install through a
//! version manager, into a directory only their interactive shell knows
//! about. A worker started by sshd or launchd never saw it. A binary in a
//! directory this module chose needs nothing on the machine but `curl` and
//! `tar`, and is found by the `PATH` the worker builds itself.
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

    // Each request gets its own scratch directory. Removing one shared
    // `.installing` directory here lets a second UI request delete the first
    // request's live download.
    let staging = staging_dir(&dir);
    let bin = staging.join("bin");
    tokio::fs::create_dir(&staging)
        .await
        .with_context(|| format!("making {}", staging.display()))?;
    tokio::fs::create_dir(&bin)
        .await
        .with_context(|| format!("making {}", bin.display()))?;

    let fetched = match kind {
        Agent::ClaudeCode => fetch_claude(&bin, &platform, version).await,
        Agent::Codex => fetch_codex(&bin, &platform, version).await,
        Agent::KimiCode => fetch_kimi(&bin, &platform, version).await,
        Agent::MistralVibe => fetch_mistral_vibe(&bin, &platform, version).await,
        Agent::CursorAgent => fetch_cursor(&bin, &platform, version).await,
        Agent::Shell => unreachable!("refused above"),
    };
    if let Err(e) = fetched {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(e).with_context(|| format!("installing {}", kind.label()));
    }

    // What it says it is, from the binary itself, rather than what was asked
    // for: `latest` does not say what it resolved to, and a directory called
    // `latest` would be a lie the day after.
    let version = version_of(&bin.join(kind.command()), kind.env())
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

/// A fresh hidden directory for one in-flight installer request.
fn staging_dir(agent_root: &Path) -> PathBuf {
    agent_root.join(format!(".installing-{}", ft_core::SessionId::new()))
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
        Agent::KimiCode => "kimi",
        Agent::MistralVibe => "mistral-vibe",
        Agent::CursorAgent => "cursor-agent",
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

    /// How Kimi Code's download service names this machine.
    ///
    /// A `Result` where the others are infallible, because Kimi ships glibc
    /// only. Its own installer stops on musl rather than handing over a binary
    /// that cannot start, and saying so here is better than an install that
    /// succeeds and an agent that dies on first launch.
    fn kimi(&self) -> Result<String> {
        let arch = match self.arch {
            Arch::X86_64 => "x64",
            Arch::Aarch64 => "arm64",
        };
        match (self.os, self.musl) {
            (Os::Darwin, _) => Ok(format!("darwin-{arch}")),
            (Os::Linux, false) => Ok(format!("linux-{arch}")),
            (Os::Linux, true) => {
                bail!("Kimi Code publishes no musl build, so it cannot run on this machine")
            }
        }
    }

    /// The tar.gz asset suffix Mistral Vibe uses for its native ACP builds.
    ///
    /// Its Linux build is glibc based. The publisher has no musl archive, so
    /// refuse Alpine rather than install a binary that cannot start there.
    fn mistral_vibe(&self) -> Result<&'static str> {
        match (self.os, self.arch, self.musl) {
            (Os::Darwin, Arch::Aarch64, _) => Ok("darwin-aarch64"),
            (Os::Darwin, Arch::X86_64, _) => Ok("darwin-x86_64"),
            (Os::Linux, Arch::Aarch64, false) => Ok("linux-aarch64"),
            (Os::Linux, Arch::X86_64, false) => Ok("linux-x86_64"),
            (Os::Linux, _, true) => {
                bail!("Mistral Vibe publishes no musl build, so it cannot run on this machine")
            }
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

/// Where each of them publishes itself.
///
/// In `ft-core` rather than here because the control plane asks the same
/// services what the newest version is, so it can say when a host is behind
/// one — and two copies of an address is how the two come to disagree about
/// where an agent comes from. The layout each one serves is documented there.
use ft_core::releases::{looks_like_a_version, version_in, CLAUDE_RELEASES, KIMI_RELEASES};

/// The build shipped with, and the digests checked by hand for it.
///
/// Cursor publishes no checksum manifest — Claude and Kimi both serve one and
/// are verified against it, and this is the reason Cursor cannot be. So these
/// four were computed from the archives this version of Firetower was tested
/// against, and a fetch of *this* build still has to match them.
///
/// **A floor, not a lock.** It used to be a lock: anything but this build was
/// refused outright, which made the one-click update refuse every update and
/// left the fleet on whatever was current the day the branch was written. A
/// newer build that Cursor's own installer names is fetched over TLS and taken
/// on that alone — which is already how Codex arrives, for the same reason and
/// with the same publisher to trust.
const CURSOR_BUILD: &str = "2026.09.28-64d2043";
const CURSOR_DOWNLOADS: &str = "https://downloads.cursor.com/lab";

async fn fetch_cursor(bin: &Path, platform: &Platform, version: Option<&str>) -> Result<()> {
    // Newest when nobody says, which is what every other agent here does. The
    // pin is the fallback rather than the default: installing the build this
    // was written against would make a fresh host behind on the day it was
    // added, and the Agents screen would be right to say so.
    let newest = match version {
        Some(_) => None,
        None => text(ft_core::releases::CURSOR_INSTALLER)
            .await
            .ok()
            .as_deref()
            .and_then(ft_core::releases::cursor_build_in),
    };
    let build = version.or(newest.as_deref()).unwrap_or(CURSOR_BUILD);
    let pinned = build == CURSOR_BUILD;
    let (os, arch, expected) = match (platform.os, platform.arch, platform.musl) {
        (Os::Darwin, Arch::Aarch64, _) => (
            "darwin",
            "arm64",
            "c0d7e9cd2e62438610b886d3439907dc1f98c2923b07b3a41416cc919aaf53c7",
        ),
        (Os::Darwin, Arch::X86_64, _) => (
            "darwin",
            "x64",
            "3efe0dff2f3d92a1e8139e33fef182801556b57ed50a6afd7bac19c4fad09549",
        ),
        (Os::Linux, Arch::X86_64, false) => (
            "linux",
            "x64",
            "6e4cd936a4866b8a77c50ff51a564460d715772fabc477a01aa0f0455d9559f0",
        ),
        (Os::Linux, Arch::Aarch64, false) => (
            "linux",
            "arm64",
            "c737599b27d3d8d6743c72b487204e335f3a8ea2fdbaf18302ee207a646ffd8d",
        ),
        _ => bail!("Cursor Agent has no verified archive for this platform"),
    };
    let archive = bin.join(".cursor-agent-package.tar.gz");
    let url = format!("{CURSOR_DOWNLOADS}/{build}/{os}/{arch}/agent-cli-package.tar.gz");
    download(&url, &archive).await?;
    // Only the shipped build has a digest to be checked against; see
    // `CURSOR_BUILD`. A newer one is as verified as the connection that
    // carried it, and saying so here is better than a constant that implies
    // more than it does.
    if pinned {
        anyhow::ensure!(
            sha256_of(&archive).await? == expected,
            "Cursor Agent archive checksum mismatch"
        );
    }
    let output = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(bin)
        .args(["--strip-components=1"])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .context("unpacking Cursor Agent")?;
    anyhow::ensure!(
        output.status.success(),
        "Cursor Agent archive could not be unpacked: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    tokio::fs::remove_file(&archive).await?;
    let agent = bin.join("cursor-agent");
    anyhow::ensure!(
        tokio::fs::metadata(&agent).await?.is_file(),
        "Cursor Agent archive has no launcher"
    );
    executable(&agent).await
}

/// Kimi Code, from its download service.
///
/// Kimi also publishes an npm package, and this used to install that. It
/// should not have: Node is the requirement this module exists to avoid, and
/// a worker started by launchd or sshd sees none of the version manager a
/// person installed Node into — so the install failed on exactly the machines
/// that most needed it to work. Kimi ships a single-file binary per platform,
/// which is what its own installer fetches and what this fetches now.
///
/// The published checksum is of the *bare* binary rather than the tarball, so
/// the order here is unpack first and verify second. The tarball is worth the
/// extra step: 62MB compressed against 188MB unpacked.
async fn fetch_kimi(bin: &Path, platform: &Platform, version: Option<&str>) -> Result<()> {
    let target = platform.kimi()?;

    let version = match version {
        Some(v) => v.to_string(),
        None => {
            let said = text(&format!("{KIMI_RELEASES}/latest"))
                .await
                .context("asking which Kimi Code is newest")?;
            let said = said.trim().to_string();
            if !looks_like_a_version(&said) {
                bail!("the download service did not answer with a version: {said:.60}");
            }
            said
        }
    };
    let base = format!("{KIMI_RELEASES}/binaries/{version}");

    let manifest = text(&format!("{base}/manifest.json"))
        .await
        .with_context(|| format!("reading the manifest for Kimi Code {version}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest).context("the manifest is not JSON")?;
    let expected = manifest
        .get("platforms")
        .and_then(|p| p.get(&target))
        .and_then(|p| p.get("checksum"))
        .and_then(|c| c.as_str())
        .with_context(|| format!("Kimi Code {version} is not published for {target}"))?
        .to_string();

    let scratch = bin.join(".unpack");
    tokio::fs::create_dir_all(&scratch).await?;
    let asset = format!("kimi-code-{target}.tar.gz");
    let archive = scratch.join(&asset);
    let unpacked = async {
        download(&format!("{base}/{asset}"), &archive).await?;
        untar(&archive, &scratch).await?;
        let _ = tokio::fs::remove_file(&archive).await;
        find_binary(&scratch, "kimi", &target)
            .await
            .context("the tarball had no binary in it")
    }
    .await
    .with_context(|| format!("downloading Kimi Code {version}"));

    let unpacked = match unpacked {
        Ok(found) => found,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&scratch).await;
            return Err(e);
        }
    };

    let actual = sha256_of(&unpacked).await?;
    if actual != expected {
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        bail!("Kimi Code {version} did not match its published checksum");
    }

    let installed = bin.join(ft_core::Agent::KimiCode.command());
    tokio::fs::rename(&unpacked, &installed)
        .await
        .with_context(|| format!("moving {} into place", unpacked.display()))?;
    let _ = tokio::fs::remove_dir_all(&scratch).await;

    executable(&installed).await
}

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

use ft_core::releases::CODEX_RELEASES;

/// The sidecar Codex runs its tools through, and the second half of Codex.
///
/// What Codex calls Code Mode: every file it reads, every edit it makes and
/// every command it runs goes through this process, which `codex` spawns from
/// beside its own executable. Where it is missing Code Mode **fails closed** —
/// the session starts, signs in and answers, and cannot touch the repository —
/// which is harder to recognise than an agent that refuses to start, because
/// everything about it looks like it is working.
///
/// The release publishes it as its own asset rather than inside the CLI's, so
/// installing `codex` alone installs a Codex that can talk and not work.
pub const CODE_MODE_HOST: &str = "codex-code-mode-host";

async fn fetch_codex(bin: &Path, platform: &Platform, version: Option<&str>) -> Result<()> {
    let target = platform.codex();
    fetch_codex_binary(bin, target, version, "codex").await?;

    // The host pinned to the CLI that will spawn it rather than asked for by
    // `latest` a second time: the two speak a handshake to each other, and two
    // `latest` requests either side of a release would fetch halves of
    // different ones. Only where the CLI would not say its version does this
    // fall back to asking for the newest.
    let installed = version_of(&bin.join("codex"), Agent::Codex.env()).await;
    fetch_codex_binary(
        bin,
        target,
        version.or(installed.as_deref()),
        CODE_MODE_HOST,
    )
    .await
}

/// One binary out of a Codex release, installed under its plain name.
async fn fetch_codex_binary(
    bin: &Path,
    target: &str,
    version: Option<&str>,
    name: &str,
) -> Result<()> {
    let asset = format!("{name}-{target}.tar.gz");
    let url = match version {
        // Codex tags its releases `rust-v<version>`.
        Some(v) => format!("{CODEX_RELEASES}/download/rust-v{v}/{asset}"),
        None => format!("{CODEX_RELEASES}/latest/download/{asset}"),
    };

    // One scratch directory per asset, so the only thing the search below can
    // find is the thing this download unpacked. Shared, `codex` and
    // `codex-code-mode-host` are each other's near misses.
    let scratch = bin.join(format!(".unpack-{name}"));
    let _ = tokio::fs::remove_dir_all(&scratch).await;
    tokio::fs::create_dir_all(&scratch).await?;
    let archive = scratch.join(&asset);
    download(&url, &archive)
        .await
        .with_context(|| format!("downloading {name}"))?;
    untar(&archive, &scratch)
        .await
        .with_context(|| format!("unpacking {name}"))?;
    let _ = tokio::fs::remove_file(&archive).await;

    let found = find_binary(&scratch, name, target).await;
    let Some(found) = found else {
        let _ = tokio::fs::remove_dir_all(&scratch).await;
        bail!("the Codex release for {target} had no {name} in it");
    };

    let installed = bin.join(name);
    tokio::fs::rename(&found, &installed)
        .await
        .with_context(|| format!("moving {} into place", found.display()))?;
    let _ = tokio::fs::remove_dir_all(&scratch).await;

    executable(&installed).await
}

// ── Mistral Vibe ────────────────────────────────────────────────────

use ft_core::releases::{MISTRAL_VIBE_RELEASES, MISTRAL_VIBE_RELEASE_LATEST};

#[derive(Debug, Clone, PartialEq, Eq)]
struct MistralVibeReleaseAsset {
    version: String,
    api_url: String,
    sha256: String,
}

/// Resolve the GitHub release and its platform archive from the release API.
///
/// Asset digests are part of GitHub's release API response. Missing or
/// malformed digest metadata is a hard failure; a successful HTTPS download
/// alone is not enough to install the archive.
fn mistral_vibe_release_asset(
    body: &serde_json::Value,
    requested_version: Option<&str>,
    target: &str,
) -> Result<MistralVibeReleaseAsset> {
    anyhow::ensure!(
        !body.get("draft").and_then(|v| v.as_bool()).unwrap_or(false),
        "the Mistral Vibe release is a draft"
    );
    anyhow::ensure!(
        !body
            .get("prerelease")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "the Mistral Vibe release is a pre-release"
    );

    let tag = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .context("the Mistral Vibe release has no tag")?;
    let version = ft_core::releases::mistral_vibe_version_in_tag(tag)
        .with_context(|| format!("unrecognized Mistral Vibe release tag: {tag}"))?;
    if let Some(requested) = requested_version {
        anyhow::ensure!(
            version == requested,
            "GitHub returned Mistral Vibe {version} for requested version {requested}"
        );
    }

    let name = format!("vibe-acp-{target}-{version}.tar.gz");
    let expected_url =
        format!("https://github.com/mistralai/mistral-vibe/releases/download/v{version}/{name}");
    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .context("the Mistral Vibe release has no assets")?;
    let asset = assets
        .iter()
        .find(|a| a.get("name").and_then(|v| v.as_str()) == Some(name.as_str()))
        .with_context(|| format!("Mistral Vibe {version} has no {target} archive"))?;
    let digest = asset
        .get("digest")
        .and_then(|v| v.as_str())
        .context("the GitHub release asset has no SHA-256 digest")?;
    let sha256 = digest
        .strip_prefix("sha256:")
        .with_context(|| format!("unrecognized GitHub asset digest: {digest}"))?;
    anyhow::ensure!(
        sha256.len() == 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit()),
        "the GitHub asset SHA-256 digest is malformed"
    );
    let url = asset
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .context("the GitHub release asset has no download URL")?;
    anyhow::ensure!(
        url == expected_url,
        "the GitHub release asset URL does not match the official release path"
    );
    let api_url = asset
        .get("url")
        .and_then(|v| v.as_str())
        .context("the GitHub release asset has no API URL")?;
    const ASSET_API_PREFIX: &str =
        "https://api.github.com/repos/mistralai/mistral-vibe/releases/assets/";
    let asset_id = api_url
        .strip_prefix(ASSET_API_PREFIX)
        .context("the GitHub release asset API URL is not official")?;
    anyhow::ensure!(
        !asset_id.is_empty() && asset_id.bytes().all(|b| b.is_ascii_digit()),
        "the GitHub release asset API URL has an invalid asset id"
    );

    Ok(MistralVibeReleaseAsset {
        version,
        api_url: api_url.to_string(),
        sha256: sha256.to_ascii_lowercase(),
    })
}

fn normalise_mistral_vibe_version(version: &str) -> Result<String> {
    let version = version.strip_prefix('v').unwrap_or(version);
    anyhow::ensure!(
        ft_core::releases::mistral_vibe_version_in_tag(&format!("v{version}")).is_some(),
        "Mistral Vibe version must be a stable X.Y.Z version"
    );
    Ok(version.to_string())
}

async fn fetch_mistral_vibe(
    bin: &Path,
    platform: &Platform,
    requested: Option<&str>,
) -> Result<()> {
    let target = platform.mistral_vibe()?;
    let requested = requested.map(normalise_mistral_vibe_version).transpose()?;
    let release_url = match requested.as_deref() {
        Some(version) => format!("{MISTRAL_VIBE_RELEASES}/tags/v{version}"),
        None => MISTRAL_VIBE_RELEASE_LATEST.to_string(),
    };
    let body = text(&release_url)
        .await
        .with_context(|| format!("asking GitHub about Mistral Vibe at {release_url}"))?;
    let body: serde_json::Value =
        serde_json::from_str(&body).context("the GitHub release response is not JSON")?;
    let asset = mistral_vibe_release_asset(&body, requested.as_deref(), target)?;

    // Extract the onedir archive in place. Its executable depends on the
    // adjacent `_internal` tree, which includes relative symlinks into the
    // bundled Python framework. Keeping the tree intact and renaming the
    // complete staging directory preserves those links.
    let archive = bin.join(".vibe-acp.tar.gz");
    download_github_release_asset(&asset.api_url, &archive)
        .await
        .with_context(|| format!("downloading Mistral Vibe {}", asset.version))?;
    let actual = sha256_of(&archive).await?;
    anyhow::ensure!(
        actual == asset.sha256,
        "Mistral Vibe {} archive did not match GitHub's SHA-256 digest",
        asset.version
    );
    untar(&archive, bin)
        .await
        .with_context(|| format!("unpacking Mistral Vibe {}", asset.version))?;
    tokio::fs::remove_file(&archive).await?;

    let launcher = bin.join("vibe-acp");
    anyhow::ensure!(
        tokio::fs::metadata(&launcher).await?.is_file(),
        "the Mistral Vibe archive has no vibe-acp launcher"
    );
    anyhow::ensure!(
        tokio::fs::metadata(bin.join("_internal")).await?.is_dir(),
        "the Mistral Vibe archive has no _internal runtime directory"
    );
    executable(&launcher).await?;

    // This release supports `--version`; require it to match the API response
    // so a broken or incomplete onedir extraction cannot be installed under a
    // version it did not answer for.
    let reported = version_of_with_timeout(
        &launcher,
        Agent::MistralVibe.env(),
        Agent::MistralVibe.probe_timeout(),
    )
    .await
    .context("Mistral Vibe --version did not return a version")?;
    anyhow::ensure!(
        reported == asset.version,
        "Mistral Vibe reported version {reported}, expected {}",
        asset.version
    );
    Ok(())
}

/// The executable in an unpacked release.
///
/// Each Codex asset holds one file, named for its target. Looked for by name
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
        .kill_on_drop(true)
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

/// Fetch a public GitHub release asset through its API endpoint.
///
/// `Accept: application/octet-stream` asks GitHub for the asset bytes instead
/// of its JSON metadata. This also keeps the downloaded object paired with the
/// API response whose `digest` is checked before extraction.
async fn download_github_release_asset(api_url: &str, to: &Path) -> Result<()> {
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--retry",
            "3",
            "-H",
            "Accept: application/octet-stream",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            "-o",
        ])
        .arg(to)
        .arg(api_url)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .context("running curl to fetch a GitHub release asset")?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        bail!(
            "{api_url}: {}",
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
        .kill_on_drop(true)
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
        .kill_on_drop(true)
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
async fn version_of(binary: &Path, env: &[(&str, &str)]) -> Option<String> {
    version_of_with_timeout(binary, env, std::time::Duration::from_secs(10)).await
}

async fn version_of_with_timeout(
    binary: &Path,
    env: &[(&str, &str)],
    timeout: std::time::Duration,
) -> Option<String> {
    let output = tokio::time::timeout(
        timeout,
        Command::new(binary)
            .arg("--version")
            .env(NO_SELF_UPDATE.0, NO_SELF_UPDATE.1)
            // What the agent needs to answer at all — see `Agent::env`. Asked
            // here as well as in `agents::probe`, because this answer names
            // the directory the install lands in: without it Cursor went into
            // one called `unknown` and then read as not installed.
            .envs(env.iter().copied())
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
    fn every_in_flight_install_gets_its_own_hidden_staging_directory() {
        let agent_root = Path::new("/state/agents/mistral-vibe");
        let first = staging_dir(agent_root);
        let second = staging_dir(agent_root);
        assert_ne!(first, second);
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with('.'));
        assert!(first
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".installing-"));
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
        assert_eq!(mac.kimi().unwrap(), "darwin-arm64");

        let debian = Platform {
            os: Os::Linux,
            arch: Arch::X86_64,
            musl: false,
        };
        assert_eq!(debian.claude(), "linux-x64");
        assert_eq!(debian.codex(), "x86_64-unknown-linux-musl");
        assert_eq!(debian.kimi().unwrap(), "linux-x64");

        let alpine = Platform {
            os: Os::Linux,
            arch: Arch::Aarch64,
            musl: true,
        };
        assert_eq!(alpine.claude(), "linux-arm64-musl");
        // Kimi ships glibc only, and an install that succeeded here would be
        // a binary that cannot start.
        assert!(alpine.kimi().is_err());
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

    #[test]
    fn mistral_vibe_release_asset_requires_exact_platform_archive_and_sha256() {
        let body = serde_json::json!({
            "tag_name": "v3.1.0",
            "draft": false,
            "prerelease": false,
            "assets": [{
                "name": "vibe-acp-darwin-aarch64-3.1.0.tar.gz",
                "digest": "sha256:c56ec63bd6bcd60591bee441cf31f3fe555da493275a1756b2f5152039f65ec4",
                "url": "https://api.github.com/repos/mistralai/mistral-vibe/releases/assets/42",
                "browser_download_url": "https://github.com/mistralai/mistral-vibe/releases/download/v3.1.0/vibe-acp-darwin-aarch64-3.1.0.tar.gz"
            }]
        });
        let asset = mistral_vibe_release_asset(&body, Some("3.1.0"), "darwin-aarch64").unwrap();
        assert_eq!(asset.version, "3.1.0");
        assert_eq!(asset.sha256.len(), 64);
        assert!(asset.api_url.ends_with("/assets/42"));

        assert!(mistral_vibe_release_asset(&body, Some("3.0.0"), "darwin-aarch64").is_err());
        assert!(mistral_vibe_release_asset(&body, None, "linux-x86_64").is_err());

        let mut malformed_digest = body.clone();
        malformed_digest["assets"][0]["digest"] = serde_json::json!("sha256:1234");
        assert!(mistral_vibe_release_asset(&malformed_digest, None, "darwin-aarch64").is_err());

        let mut untrusted_api_url = body.clone();
        untrusted_api_url["assets"][0]["url"] =
            serde_json::json!("https://example.invalid/releases/assets/42");
        assert!(mistral_vibe_release_asset(&untrusted_api_url, None, "darwin-aarch64").is_err());

        let missing_digest = serde_json::json!({
            "tag_name": "v3.1.0",
            "draft": false,
            "prerelease": false,
            "assets": [{
                "name": "vibe-acp-darwin-aarch64-3.1.0.tar.gz",
                "url": "https://api.github.com/repos/mistralai/mistral-vibe/releases/assets/42",
                "browser_download_url": "https://github.com/mistralai/mistral-vibe/releases/download/v3.1.0/vibe-acp-darwin-aarch64-3.1.0.tar.gz"
            }]
        });
        assert!(mistral_vibe_release_asset(&missing_digest, None, "darwin-aarch64").is_err());
    }

    #[test]
    fn mistral_vibe_assets_cover_native_platforms_and_reject_musl() {
        let cases = [
            (Os::Darwin, Arch::Aarch64, false, Ok("darwin-aarch64")),
            (Os::Darwin, Arch::X86_64, false, Ok("darwin-x86_64")),
            (Os::Linux, Arch::Aarch64, false, Ok("linux-aarch64")),
            (Os::Linux, Arch::X86_64, false, Ok("linux-x86_64")),
            (Os::Linux, Arch::Aarch64, true, Err(())),
            (Os::Linux, Arch::X86_64, true, Err(())),
        ];
        for (os, arch, musl, expected) in cases {
            let platform = Platform { os, arch, musl };
            match expected {
                Ok(target) => assert_eq!(platform.mistral_vibe().unwrap(), target),
                Err(()) => assert!(platform.mistral_vibe().is_err()),
            }
        }
        assert_eq!(normalise_mistral_vibe_version("v3.1.0").unwrap(), "3.1.0");
        assert!(normalise_mistral_vibe_version("3.1.0/../../other").is_err());
        assert!(normalise_mistral_vibe_version("v3.1.0-rc1").is_err());
    }
}
