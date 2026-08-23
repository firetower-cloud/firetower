//! Files somebody handed to a session.
//!
//! A picture goes inside the message, because the model looks at it. Everything
//! else is better as a file: the agent can read it, grep it, unzip it or edit it
//! with the tools it already has, it costs no context until it does, and a
//! twenty-megabyte archive never has to fit in a prompt.
//!
//! That also means one mechanism covers every type. There is nothing here that
//! knows what a `.zip` or a `.csv` is, because nothing needs to.
//!
//! They live under the session's own directory, which is excluded from git.
//! An attachment is an input to the work rather than part of it, and a
//! spreadsheet somebody dropped in to ask a question about should not turn up
//! in the pull request.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

/// Where they go, under the session's directory.
pub const DIR: &str = "attachments";

/// The most one file may be.
///
/// It travels as base64 in a single JSON frame, and every hop between the
/// browser and the workspace holds that line whole. Larger than an image is
/// allowed because this never enters the model's context — but not unbounded,
/// because five processes have to carry it at once.
pub const BIGGEST: usize = 10 * 1024 * 1024;

/// Write a file into the workspace and say where it landed.
///
/// The returned path is relative to the workspace, because that is what gets
/// said to the agent and a relative path is what it can act on.
pub async fn keep(workspace: &Path, name: &str, bytes: &[u8]) -> Result<String> {
    anyhow::ensure!(
        bytes.len() <= BIGGEST,
        "that file is {:.1} MB, and the limit is {} MB",
        bytes.len() as f64 / 1_048_576.0,
        BIGGEST / 1_048_576
    );

    let name = safe(name);
    let dir = workspace.join(crate::agentd::DIR).join(DIR);
    tokio::fs::create_dir_all(&dir)
        .await
        .with_context(|| format!("making {}", dir.display()))?;

    let at = free_name(&dir, &name).await;
    tokio::fs::write(dir.join(&at), bytes)
        .await
        .with_context(|| format!("writing {at}"))?;

    Ok(format!("{}/{}/{}", crate::agentd::DIR, DIR, at))
}

/// A filename that cannot be anything else.
///
/// Somebody else chose this string — it arrived from a browser — so it is
/// treated as text rather than as a path. Directory separators, parent
/// references and leading dots all go, because a name is a name and this is the
/// one place a bad one could write outside the directory it was meant for.
fn safe(name: &str) -> String {
    let leaf = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .trim()
        .trim_matches('.');

    let cleaned: String = leaf
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') {
                c
            } else {
                '-'
            }
        })
        .collect();

    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "attachment".to_string()
    } else {
        // Long enough for anything real, short enough for every filesystem.
        cleaned.chars().take(120).collect()
    }
}

/// The same name twice means the second one is a new file, not a replacement.
///
/// Somebody attaching `report.csv` twice in one session almost certainly means
/// two different reports, and silently overwriting the first would change what
/// an earlier message in the transcript refers to.
async fn free_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }

    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem, format!(".{ext}")),
        None => (name, String::new()),
    };

    for n in 2..1000 {
        let candidate = format!("{stem}-{n}{ext}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem}-{}{ext}", std::process::id())
}

/// Where a session's attachments live, for anything that needs the directory
/// itself.
pub fn dir_for(workspace: &Path) -> PathBuf {
    workspace.join(crate::agentd::DIR).join(DIR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_only_ever_a_name() {
        // It came from a browser. Every one of these is somebody's attempt to
        // write somewhere they were not offered.
        // The last segment, so a path becomes the name at the end of it.
        assert_eq!(safe("../../etc/passwd"), "passwd");
        assert_eq!(safe("/etc/shadow"), "shadow");
        assert_eq!(safe("..\\\\..\\\\windows\\\\system32"), "system32");
        assert_eq!(safe("....//....//x"), "x");
    }

    #[test]
    fn an_ordinary_name_survives_intact() {
        assert_eq!(safe("quarterly report.csv"), "quarterly report.csv");
        assert_eq!(safe("archive-2026_final.zip"), "archive-2026_final.zip");
    }

    #[test]
    fn a_name_that_is_nothing_still_gets_one() {
        assert_eq!(safe(""), "attachment");
        assert_eq!(safe("..."), "attachment");
        assert_eq!(safe("///"), "attachment");
    }

    #[tokio::test]
    async fn the_same_name_twice_is_two_files() {
        // Two reports called `report.csv` are two reports. Overwriting the
        // first would change what an earlier message in the transcript refers
        // to.
        let workspace = tempfile::tempdir().unwrap();
        let first = keep(workspace.path(), "report.csv", b"one").await.unwrap();
        let second = keep(workspace.path(), "report.csv", b"two").await.unwrap();

        assert_ne!(first, second);
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join(&first))
                .await
                .unwrap(),
            "one"
        );
        assert_eq!(
            tokio::fs::read_to_string(workspace.path().join(&second))
                .await
                .unwrap(),
            "two"
        );
    }

    #[tokio::test]
    async fn what_comes_back_is_where_the_agent_can_find_it() {
        let workspace = tempfile::tempdir().unwrap();
        let at = keep(workspace.path(), "notes.txt", b"hello").await.unwrap();

        assert!(at.starts_with(".firetower/attachments/"), "{at}");
        assert!(
            workspace.path().join(&at).exists(),
            "the path is relative to the workspace, which is where the agent stands"
        );
    }

    #[tokio::test]
    async fn something_too_large_is_refused_with_its_size() {
        let workspace = tempfile::tempdir().unwrap();
        let huge = vec![0u8; BIGGEST + 1];
        let refused = keep(workspace.path(), "big.zip", &huge).await.unwrap_err();
        let said = format!("{refused}");
        assert!(said.contains("MB"), "it should say how big: {said}");
    }
}
