//! What a release changed in the deployment's files, against what is there.
//!
//! Three copies of each file are compared: the one on the machine, the one the
//! release being left shipped, and the one the release being moved to ships.
//! The interesting case is the second and third differing *and* the first not
//! matching the second — the release changed a file the operator had edited.
//! Nothing here merges. It says what is different, in both directions, and the
//! person who made the edits decides.
//!
//! `.env` is never rewritten. What a new release needs added to it is reported
//! by name, from the difference between the two releases' `.env.example`.

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use utoipa::ToSchema;

/// The files an upgrade may rewrite. The same list the updater enforces.
pub const FILES: [&str; 3] = ["firetower.yml", "Caddyfile", "Caddyfile.dockerfile"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum FileVerdict {
    /// The release did not touch it. Nothing to do.
    Unchanged,
    /// The release changed it and the machine still has the previous release's
    /// copy: replaced during the run, previous kept as `.backup`.
    Update,
    /// The release changed it and so did somebody here. Both diffs are shown;
    /// replacing is a choice.
    Edited,
    /// The release ships a file the machine does not have. Written.
    New,
    /// The machine has a file the release no longer ships. Left alone.
    Unshipped,
}

/// One file, and what would happen to it.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilePlan {
    pub name: String,
    pub verdict: FileVerdict,
    /// Unified diff, previous release → this release.
    pub release_change: Option<String>,
    /// Unified diff, previous release → what is on the machine.
    pub your_edits: Option<String>,
}

/// A file's three copies. `None` is "not there".
pub struct Copies<'a> {
    pub name: &'a str,
    pub local: Option<&'a str>,
    pub old: Option<&'a str>,
    pub new: Option<&'a str>,
}

/// Decide what to do with one file.
pub fn plan(copies: Copies<'_>) -> FilePlan {
    let Copies {
        name,
        local,
        old,
        new,
    } = copies;
    let same = |a: Option<&str>, b: Option<&str>| a.map(normalise) == b.map(normalise);

    let verdict = match (local, old, new) {
        (_, _, None) if local.is_some() => FileVerdict::Unshipped,
        (_, _, None) => FileVerdict::Unchanged,
        (None, _, Some(_)) => FileVerdict::New,
        (Some(_), _, Some(_)) if same(old, new) => FileVerdict::Unchanged,
        (Some(_), _, Some(_)) if same(local, old) => FileVerdict::Update,
        (Some(_), _, Some(_)) if same(local, new) => FileVerdict::Unchanged,
        (Some(_), _, Some(_)) => FileVerdict::Edited,
    };

    let release_change = match verdict {
        FileVerdict::Update | FileVerdict::Edited | FileVerdict::New => {
            Some(unified(name, old.unwrap_or(""), new.unwrap_or("")))
        }
        _ => None,
    };
    let your_edits = match verdict {
        FileVerdict::Edited => Some(unified(name, old.unwrap_or(""), local.unwrap_or(""))),
        _ => None,
    };

    FilePlan {
        name: name.to_string(),
        verdict,
        release_change,
        your_edits,
    }
}

/// Whether a verdict means the run writes the file.
impl FileVerdict {
    pub fn writes(self) -> bool {
        matches!(self, FileVerdict::Update | FileVerdict::New)
    }
}

/// Line endings and a missing final newline are not edits.
fn normalise(text: &str) -> String {
    let mut s = text.replace("\r\n", "\n");
    while s.ends_with('\n') {
        s.pop();
    }
    s
}

fn unified(name: &str, from: &str, to: &str) -> String {
    let diff = TextDiff::from_lines(from, to);
    let mut out = String::new();
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        out.push_str(&format!("{}\n", hunk.header()));
        for change in hunk.iter_changes() {
            let sign = match change.tag() {
                ChangeTag::Delete => '-',
                ChangeTag::Insert => '+',
                ChangeTag::Equal => ' ',
            };
            out.push(sign);
            out.push_str(change.value());
            if !change.value().ends_with('\n') {
                out.push('\n');
            }
        }
    }
    if out.is_empty() {
        out
    } else {
        format!("--- {name}\n+++ {name}\n{out}")
    }
}

/// The variables a new release's `.env.example` sets that the previous one
/// did not, and that the machine's `.env` does not have.
///
/// Only uncommented lines count: a commented `# DOMAIN=` is documentation of
/// an optional value, and an uncommented `POSTGRES_PASSWORD=` is a demand.
pub fn env_missing(
    old_example: Option<&str>,
    new_example: &str,
    env_keys: &[String],
) -> Vec<String> {
    let before = old_example.map(required_keys).unwrap_or_default();
    required_keys(new_example)
        .into_iter()
        .filter(|k| !before.contains(k))
        .filter(|k| !env_keys.contains(k))
        .collect()
}

fn required_keys(example: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in example.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, _)) = line.split_once('=') {
            let key = key.trim();
            if !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !keys.contains(&key.to_string())
            {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned(local: Option<&str>, old: Option<&str>, new: Option<&str>) -> FilePlan {
        plan(Copies {
            name: "firetower.yml",
            local,
            old,
            new,
        })
    }

    #[test]
    fn a_file_the_release_did_not_touch_is_left_alone() {
        let p = planned(Some("a\n"), Some("a\n"), Some("a\n"));
        assert_eq!(p.verdict, FileVerdict::Unchanged);
        assert!(p.release_change.is_none());
        // Even if the operator edited it: not the release's business.
        assert_eq!(
            planned(Some("mine\n"), Some("a\n"), Some("a\n")).verdict,
            FileVerdict::Unchanged
        );
    }

    #[test]
    fn an_untouched_file_the_release_changed_is_updated_with_a_diff() {
        let p = planned(Some("a\nb\n"), Some("a\nb\n"), Some("a\nc\n"));
        assert_eq!(p.verdict, FileVerdict::Update);
        let diff = p.release_change.unwrap();
        assert!(diff.contains("-b\n"), "{diff}");
        assert!(diff.contains("+c\n"), "{diff}");
        assert!(p.your_edits.is_none());
        assert!(p.verdict.writes());
    }

    #[test]
    fn an_edited_file_the_release_changed_shows_both_diffs_and_writes_nothing_on_its_own() {
        let p = planned(Some("a\nmine\n"), Some("a\nb\n"), Some("a\nc\n"));
        assert_eq!(p.verdict, FileVerdict::Edited);
        assert!(p.release_change.unwrap().contains("+c\n"));
        assert!(p.your_edits.unwrap().contains("+mine\n"));
        assert!(!p.verdict.writes(), "a choice, not a default");
    }

    #[test]
    fn a_file_already_on_the_new_release_is_unchanged() {
        assert_eq!(
            planned(Some("a\nc\n"), Some("a\nb\n"), Some("a\nc\n")).verdict,
            FileVerdict::Unchanged
        );
    }

    #[test]
    fn line_endings_and_a_trailing_newline_are_not_edits() {
        assert_eq!(
            planned(Some("a\r\nb"), Some("a\nb\n"), Some("a\nc\n")).verdict,
            FileVerdict::Update
        );
    }

    #[test]
    fn a_new_file_is_written_and_a_dropped_one_is_kept() {
        assert_eq!(planned(None, None, Some("x\n")).verdict, FileVerdict::New);
        assert_eq!(
            planned(Some("x\n"), Some("x\n"), None).verdict,
            FileVerdict::Unshipped
        );
        assert_eq!(planned(None, None, None).verdict, FileVerdict::Unchanged);
    }

    #[test]
    fn new_required_variables_are_named_and_optional_ones_are_not() {
        let old = "POSTGRES_PASSWORD=\n# DOMAIN=\n";
        let new = "POSTGRES_PASSWORD=\nFIRETOWER_UPDATER_TOKEN=\n# DOMAIN=\n# NEW_OPTIONAL=\n";
        assert_eq!(
            env_missing(Some(old), new, &["POSTGRES_PASSWORD".into()]),
            vec!["FIRETOWER_UPDATER_TOKEN"]
        );
        // Already set on the machine: nothing to add.
        assert!(env_missing(
            Some(old),
            new,
            &["POSTGRES_PASSWORD".into(), "FIRETOWER_UPDATER_TOKEN".into()]
        )
        .is_empty());
    }
}
