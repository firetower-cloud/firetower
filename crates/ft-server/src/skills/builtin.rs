//! The skills Firetower itself provides.
//!
//! **Why these are rows rather than files the worker drops in.** A bundle
//! placed straight into a session's skills directory is less code and cannot
//! be seen: not in the library, not turn-off-able for a session that does not
//! want it, and not accountable for the context it costs. Invisible is not the
//! same as built-in.
//!
//! So a built-in is an ordinary Placed skill filed in a directory Firetower
//! owns — `d/firetower`, granted to the organisation's `everyone` team. Every
//! property wanted of it falls out of the path: visible in the library,
//! reachable by everybody, writable by nobody, groupable by prefix.
//!
//! The bytes ship inside this binary, so there is no fetch at start-up and no
//! missing-file failure mode.

use anyhow::{bail, Result};

/// Where built-ins live. Nobody holds writer on it, so nobody can delete,
/// rename or re-file what is in it.
pub const DIRECTORY_SLUG: &str = "firetower";

/// The `ltree` prefix a built-in's path begins with.
pub const PATH_PREFIX: &str = "d.firetower.";

/// One bundle, as it ships.
pub struct Builtin {
    /// The folder name on a worker, and the name the agent answers to.
    pub slug: &'static str,
    pub markdown: &'static str,
}

pub const ALL: &[Builtin] = &[Builtin {
    slug: "firetower-artifacts",
    markdown: include_str!("../../skills/firetower-artifacts/SKILL.md"),
}];

/// Name, description and body, out of the frontmatter.
///
/// Deliberately not a YAML parser. These files ship in this binary and are
/// written to suit this function: one `key: value` per line, no folded
/// scalars, no nesting. Taking on a YAML dependency to read two strings out of
/// a file we author ourselves would be a dependency for nothing — and the test
/// below is what stops the file drifting out of reach of the reader.
pub fn fields(markdown: &str) -> Result<(String, String, String)> {
    let rest = markdown
        .strip_prefix("---")
        .ok_or_else(|| anyhow::anyhow!("a skill starts with frontmatter"))?;
    let (head, body) = rest
        .split_once("\n---")
        .ok_or_else(|| anyhow::anyhow!("the frontmatter is not closed"))?;

    let mut name = None;
    let mut description = None;
    for line in head.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "name" => name = Some(value.trim().to_string()),
            "description" => description = Some(value.trim().to_string()),
            _ => {}
        }
    }

    match (name, description) {
        (Some(n), Some(d)) if !n.is_empty() && !d.is_empty() => {
            Ok((n, d, body.trim_start().to_string()))
        }
        _ => bail!("a built-in needs a name and a description on one line each"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What stops a shipped file drifting out of reach of the reader above.
    #[test]
    fn every_bundle_can_be_read() {
        for one in ALL {
            let (name, description, body) =
                fields(one.markdown).unwrap_or_else(|e| panic!("{}: {e}", one.slug));

            assert_eq!(name, one.slug, "the folder and the name must agree");
            assert!(
                description.len() > 40,
                "{}: the description is the whole triggering mechanism",
                one.slug
            );
            assert!(!body.is_empty(), "{}: a skill with no body", one.slug);
            // It is rendered into the system prompt, and the import path
            // refuses angle brackets in frontmatter for the same reason.
            assert!(
                !description.contains('<') && !description.contains('>'),
                "{}: no angle brackets in frontmatter",
                one.slug
            );
        }
    }

    /// The contract is the reason this one exists; losing the path would leave
    /// a skill that reads well and publishes nothing.
    #[test]
    fn the_artifact_skill_still_says_where_a_file_goes() {
        let (_, _, body) = fields(ALL[0].markdown).expect("it parses");
        assert!(body.contains(".firetower/artifacts/<name>/index.html"));
    }
}
