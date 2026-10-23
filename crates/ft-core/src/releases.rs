//! Where each agent publishes itself, and how to read a version out of one.
//!
//! Two places need this and for opposite reasons. The worker fetches a binary
//! from these services, and has since agents stopped coming from npm — see
//! `ft_worker::runtime`. The control plane only asks them what the newest
//! version is, so it can say when a host is behind one.
//!
//! Held here so the two cannot disagree about where an agent comes from. No
//! HTTP: this crate has no client and should not gain one. Each side does its
//! own fetching and shares only the addresses and the parsing.

use crate::Agent;

/// Where Claude Code publishes its native binaries.
///
/// The same service and the same layout its own installer reads: `latest` is
/// a version, `<version>/manifest.json` carries a checksum per platform, and
/// the binary is at `<version>/<platform>/claude`.
pub const CLAUDE_RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";

/// Where Kimi Code publishes its native binaries.
///
/// The same service and the same layout its own `install.sh` reads: `latest`
/// is a version, `binaries/<version>/manifest.json` carries a checksum per
/// platform, and the binary is in `binaries/<version>/kimi-code-<platform>.tar.gz`.
///
/// `code.kimi.ai` is the global mirror of `code.kimi.com`; the two serve the
/// same builds, and the checksum the worker compares is what decides whether to
/// believe either of them. Which Kimi an *account* lives on is a separate
/// question, settled per sign-in by the worker's `--region`.
pub const KIMI_RELEASES: &str = "https://code.kimi.ai/kimi-code";

/// Where Codex publishes its binaries: one tarball per target on each release.
pub const CODEX_RELEASES: &str = "https://github.com/openai/codex/releases";

/// Codex's releases, as a list rather than as one answer.
///
/// `releases/latest` is whichever package released most recently, and
/// `openai/codex` publishes more than the CLI — so the newest `rust-v*` in the
/// list is the answer and `latest` is not. The same reasoning, and the same
/// anonymous sixty-an-hour budget, as the control plane's own feed.
pub const CODEX_RELEASE_LIST: &str =
    "https://api.github.com/repos/openai/codex/releases?per_page=30";

/// The prefix Codex tags its CLI releases with.
pub const CODEX_TAG_PREFIX: &str = "rust-v";

/// Cursor's own installer, which is where its current build is written down.
///
/// There is no feed to ask. `downloads.cursor.com/lab/latest` is a 403, and
/// nothing else answers with a version — Cursor pins a build inside the script
/// at this address and republishes the script. So the thing every one of their
/// users already runs is also the only statement of what is current, and
/// reading it is reading what they publish.
pub const CURSOR_INSTALLER: &str = "https://cursor.com/install";

/// Where to ask what the newest published version of one agent is.
///
/// `None` only for the shell, which has no publisher to ask.
pub fn newest_url(kind: Agent) -> Option<String> {
    match kind {
        Agent::ClaudeCode => Some(format!("{CLAUDE_RELEASES}/latest")),
        Agent::KimiCode => Some(format!("{KIMI_RELEASES}/latest")),
        Agent::Codex => Some(CODEX_RELEASE_LIST.to_string()),
        Agent::CursorAgent => Some(CURSOR_INSTALLER.to_string()),
        Agent::Shell => None,
    }
}

/// The build Cursor's installer fetches, out of the script itself.
///
/// The script contains exactly one versioned URL, of the shape
/// `downloads.cursor.com/lab/<build>/${OS}/${ARCH}/agent-cli-package.tar.gz`,
/// and `<build>` is the answer. Read rather than guessed: the placeholders are
/// the script's own shell variables, so the segment after the build is skipped
/// and only the build is taken.
///
/// Strict about the shape for the reason `read_version` is: this address
/// answering with an HTML error page must not become a version every host is
/// then told it is behind.
pub fn cursor_build_in(script: &str) -> Option<String> {
    const AT: &str = "downloads.cursor.com/lab/";
    let at = script.find(AT)? + AT.len();
    let build = script[at..].split('/').next()?;
    (looks_like_a_version(build) && !build.contains('$')).then(|| build.to_string())
}

/// The version inside whatever a binary printed.
///
/// `claude --version` says `2.1.273 (Claude Code)` and `codex --version` says
/// `codex-cli 0.156.1`, so neither answer is a version on its own. This finds
/// the word that is one.
pub fn version_in(said: &str) -> Option<String> {
    said.split_whitespace()
        .map(|word| word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.'))
        .map(|word| word.strip_prefix('v').unwrap_or(word))
        .find(|word| looks_like_a_version(word))
        .map(str::to_string)
}

/// Whether a word is a version: two or more dot-separated parts that start
/// with digits.
pub fn looks_like_a_version(word: &str) -> bool {
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

    /// What each of them actually prints, which is not a bare version for any.
    #[test]
    fn a_version_is_found_in_what_a_binary_printed() {
        assert_eq!(
            version_in("2.1.273 (Claude Code)").as_deref(),
            Some("2.1.273")
        );
        assert_eq!(version_in("codex-cli 0.156.1").as_deref(), Some("0.156.1"));
        assert_eq!(version_in("v2.1.1").as_deref(), Some("2.1.1"));
        assert_eq!(version_in("kimi-code 2.1.1\n").as_deref(), Some("2.1.1"));
    }

    /// Nothing is not a version, and neither is a word that merely has digits
    /// in it — a probe that read one would report a host as behind on a guess.
    #[test]
    fn a_line_with_no_version_in_it_answers_nothing() {
        assert_eq!(version_in(""), None);
        assert_eq!(version_in("command not found"), None);
        assert_eq!(version_in("claude"), None);
        assert!(!looks_like_a_version("2"));
        assert!(!looks_like_a_version("latest"));
        assert!(looks_like_a_version("0.1"));
    }

    /// Only the agents Firetower fetches have somewhere to ask.
    #[test]
    fn only_agents_with_supported_latest_feeds_are_polled() {
        assert!(newest_url(Agent::Shell).is_none());
        for kind in Agent::all() {
            assert!(newest_url(kind).is_some(), "{kind:?}");
        }
    }

    /// Cursor's installer names its build, and nothing else is read as one.
    #[test]
    fn the_cursor_build_is_read_out_of_the_installer_and_not_invented() {
        let script = "#!/usr/bin/env bash\nURL=\"https://downloads.cursor.com/lab/2026.10.22-27dcf5f/${OS}/${ARCH}/agent-cli-package.tar.gz\"\n";
        assert_eq!(
            cursor_build_in(script).as_deref(),
            Some("2026.10.22-27dcf5f")
        );
        // An error page is not a version, however much of it there is.
        assert!(cursor_build_in("<!DOCTYPE html><html>not a script</html>").is_none());
        // Nor is the script's own placeholder, if the shape ever moves.
        assert!(cursor_build_in("downloads.cursor.com/lab/${VERSION}/x").is_none());
    }
}
