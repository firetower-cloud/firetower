//! Release versions, compared rather than string-matched.
//!
//! Every crate carries one version, the release rewrites it, and the tag on a
//! release is `firetower-v<version>`. That prefix is release-please's, so it is
//! stripped here rather than everywhere a tag is read.

use semver::Version;

/// The tag release-please puts on a release of this repository.
pub const TAG_PREFIX: &str = "firetower-v";

/// What this control plane is.
pub fn current() -> Version {
    parse(env!("CARGO_PKG_VERSION")).expect("the crate's own version is a version")
}

/// Read a version from a tag, a `v`-prefixed string, or a bare one.
pub fn parse(raw: &str) -> Option<Version> {
    let raw = raw.trim();
    let bare = raw
        .strip_prefix(TAG_PREFIX)
        .or_else(|| raw.strip_prefix('v'))
        .unwrap_or(raw);
    Version::parse(&unpadded(bare)).ok()
}

/// A version with its zero-padding taken off, so semver will read it.
///
/// Semver forbids a leading zero in a numeric identifier, and Cursor dates its
/// builds — `2026.09.28-64d2043`. That is not a semver version, so it did not
/// parse, so every Cursor host compared as up to date against every newer
/// build: the Agents screen knew what was published and could not say anybody
/// was behind it.
///
/// Only the dotted numeric part is touched, and only where the whole component
/// is digits. `0` is left alone — it is a legal identifier, and Codex's
/// `0.164.0` goes through unchanged. Anything that is not a plain number,
/// including the build hash after the hyphen, is passed on as it came.
fn unpadded(bare: &str) -> String {
    let (numbers, rest) = match bare.find(['-', '+']) {
        Some(at) => bare.split_at(at),
        None => (bare, ""),
    };
    let numbers = numbers
        .split('.')
        .map(|part| match part.chars().all(|c| c.is_ascii_digit()) {
            true => part.trim_start_matches('0'),
            false => part,
        })
        .map(|part| if part.is_empty() { "0" } else { part })
        .collect::<Vec<_>>()
        .join(".");
    format!("{numbers}{rest}")
}

/// The tag a version was released under.
pub fn tag_for(version: &Version) -> String {
    format!("{TAG_PREFIX}{version}")
}

/// Whether `latest` is something this control plane should move to.
///
/// Strictly newer. A build ahead of the newest release — a checkout, an edge
/// image — is not told to downgrade.
pub fn is_newer(latest: &Version, current: &Version) -> bool {
    latest > current
}

#[cfg(test)]
mod tests {
    /// Cursor dates its builds and pads the month, which is not semver.
    #[test]
    fn a_zero_padded_build_is_read_and_ordered() {
        let old = super::parse("2026.09.28-64d2043").expect("a padded build parses");
        let new = super::parse("2026.10.22-27dcf5f").expect("a padded build parses");
        assert!(super::is_newer(&new, &old), "October is after September");
        // Everything else is untouched.
        assert_eq!(super::parse("0.164.0").unwrap().to_string(), "0.164.0");
        assert_eq!(super::parse("2.1.273").unwrap().to_string(), "2.1.273");
        assert_eq!(
            super::parse("firetower-v1.2.3").unwrap().to_string(),
            "1.2.3"
        );
    }

    use super::*;

    #[test]
    fn a_release_tag_reads_as_its_version() {
        assert_eq!(parse("firetower-v0.31.0").unwrap(), Version::new(0, 31, 0));
        assert_eq!(parse("v0.31.0").unwrap(), Version::new(0, 31, 0));
        assert_eq!(parse("0.31.0").unwrap(), Version::new(0, 31, 0));
        assert!(parse("edge").is_none());
        assert!(parse("").is_none());
    }

    #[test]
    fn only_a_newer_release_is_an_update() {
        let here = Version::new(0, 30, 1);
        assert!(is_newer(&Version::new(0, 31, 0), &here));
        assert!(is_newer(&Version::new(0, 30, 2), &here));
        assert!(!is_newer(&Version::new(0, 30, 1), &here));
        assert!(
            !is_newer(&Version::new(0, 29, 9), &here),
            "never a downgrade"
        );
    }

    #[test]
    fn the_tag_round_trips() {
        let v = Version::new(1, 2, 3);
        assert_eq!(parse(&tag_for(&v)).unwrap(), v);
    }
}
