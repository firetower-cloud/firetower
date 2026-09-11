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
    Version::parse(bare).ok()
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
