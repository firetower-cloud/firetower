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

use anyhow::{bail, Context, Result};

/// Where built-ins live. Nobody holds writer on it, so nobody can delete,
/// rename or re-file what is in it.
pub const DIRECTORY_SLUG: &str = "firetower";

/// The built-ins that are not a choice, and what breaks without each.
///
/// **A capability can be turned off; a contract cannot.** The test is one
/// question: *does a Firetower feature stop working, without saying so, if
/// this is off?* Not "is it useful" and not "is it ours" — most of what ships
/// here is both and is still a capability.
///
/// Two pass it, and they fail the same way. Each is the only thing that tells
/// an agent how to reach a mechanism the product is built on, so with it off
/// the agent does the obvious wrong thing — writes a file somewhere and says
/// "here you go" — and nothing appears. That reads as an agent being bad at
/// its job rather than as a setting somebody changed, which is what makes it
/// worse than an error.
///
/// Both were cheaper to ship as skills than as system prompt: roughly 250
/// tokens every turn against 30 at rest. The move was about cost. It was
/// never about making them optional.
pub const REQUIRED: &[(&str, &str)] = &[
    (
        "firetower-artifacts",
        "Publishing an artifact means writing to a path Firetower watches. \
         Without this, an agent asked to show you something writes an HTML file \
         somewhere else and nothing appears in the conversation.",
    ),
    (
        "skill-creator",
        "Saving a skill means calling the tool that puts it in your library. \
         Without this, an agent asked to write you one leaves a SKILL.md in a \
         checkout and it never reaches the Skills screen.",
    ),
];

/// Whether this slug is one of those.
pub fn required(slug: &str) -> bool {
    REQUIRED.iter().any(|(s, _)| *s == slug)
}

/// Why it cannot be turned off, in words for the person looking at the row.
pub fn why_required(slug: &str) -> Option<&'static str> {
    REQUIRED.iter().find(|(s, _)| *s == slug).map(|(_, w)| *w)
}

/// Every required slug, for a query that needs the names.
pub fn required_slugs() -> Vec<String> {
    REQUIRED.iter().map(|(s, _)| s.to_string()).collect()
}

/// The `ltree` prefix a built-in's path begins with.
pub const PATH_PREFIX: &str = "d.firetower.";

/// What a built-in is, which decides where on a worker it lands.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// A lone skill: one `SKILL.md`, written where that agent reads skills.
    Skill,
    /// A folder carrying several components, with a manifest at
    /// `.claude-plugin/plugin.json`. Written where that agent reads *plugins*
    /// from, or taken apart for one that has no such place.
    Plugin,
}

/// An MCP server a plugin declares.
///
/// **Not the credential.** The `.mcp.json` a worker writes is synthesised when
/// a session starts, from this plus that person's own token, so nothing stored
/// here or in `blobs` ever holds a secret.
pub struct Connector {
    /// The key this server has in `.mcp.json`, which is what the agent calls it.
    pub server: &'static str,
    pub url: &'static str,
    /// `borrow-git` reuses a token Firetower already holds. Measured: GitHub's
    /// MCP server names `github.com/login/oauth` as its authorization server,
    /// which is the application Firetower already registered for git — so the
    /// token at `git/<host>/<owner>` is the bearer it is asking for, and there
    /// is no new authorization flow to write.
    pub auth: &'static str,
    /// Which *kind* of git host's token, when `auth` is `borrow-git`. Matched
    /// against the host's kind rather than an id, because an id is per
    /// installation and this ships compiled in.
    pub borrow: Option<&'static str>,
    pub scopes: Option<&'static str>,
}

/// One bundle, as it ships.
pub struct Builtin {
    /// The folder name on a worker, and the name the agent answers to.
    pub slug: &'static str,
    pub kind: Kind,
    /// Every file in the bundle: path, then contents. For a skill that is one
    /// `SKILL.md`; for a plugin it is the manifest and everything under it.
    pub files: &'static [(&'static str, &'static str)],
    pub connector: Option<Connector>,
}

/// A lone skill, which is one file and needs no manifest.
const fn skill(slug: &'static str, files: &'static [(&'static str, &'static str)]) -> Builtin {
    Builtin {
        slug,
        kind: Kind::Skill,
        files,
        connector: None,
    }
}

pub const ALL: &[Builtin] = &[
    skill(
        "firetower-artifacts",
        &[(
            "SKILL.md",
            include_str!("../../skills/firetower-artifacts/SKILL.md"),
        )],
    ),
    skill(
        "skill-creator",
        &[(
            "SKILL.md",
            include_str!("../../skills/skill-creator/SKILL.md"),
        )],
    ),
    // **Two skills, no plugins, no connectors.** What ships inside the
    // binary is what Firetower itself knows how to do — publishing an
    // artifact, and writing a skill — and nothing else.
    //
    // `security-review`, `release-notes`, `linear` and `github` were all here
    // and all came out. A plugin that arrives pre-installed is one nobody
    // chose, and the one holding a credential granted for git made the
    // argument for the rest. They live in `firetower-cloud/firetower-plugins`
    // now, reached the way anybody else's are.
];

impl Builtin {
    /// What the library row says, and what goes into the system prompt.
    ///
    /// A skill declares both in its frontmatter; a plugin declares them in its
    /// manifest. Two readers because they are two formats, and guessing one
    /// from the other is how a plugin ends up named after its first skill.
    pub fn describe(&self) -> Result<(String, String, String)> {
        match self.kind {
            Kind::Skill => {
                let markdown = self.file("SKILL.md").context("a skill needs a SKILL.md")?;
                fields(markdown)
            }
            Kind::Plugin => {
                let manifest = self
                    .file(".claude-plugin/plugin.json")
                    .context("a plugin needs .claude-plugin/plugin.json")?;
                let value: serde_json::Value =
                    serde_json::from_str(manifest).context("that manifest is not JSON")?;
                let name = value["name"].as_str().unwrap_or_default().to_string();
                let description = value["description"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                if name.is_empty() || description.is_empty() {
                    bail!("a plugin needs a name and a description in its manifest");
                }
                // No body. A plugin's own text is not loaded by anything — its
                // components carry theirs — so inventing one would put bytes
                // in a system prompt that nothing reads.
                Ok((name, description, String::new()))
            }
        }
    }

    pub fn file(&self, path: &str) -> Option<&'static str> {
        self.files.iter().find(|(p, _)| *p == path).map(|(_, c)| *c)
    }
}

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

    /// What stops a shipped file drifting out of reach of the readers above.
    #[test]
    fn every_bundle_can_be_read() {
        for one in ALL {
            let (name, description, _body) = one
                .describe()
                .unwrap_or_else(|e| panic!("{}: {e}", one.slug));

            assert_eq!(name, one.slug, "the folder and the name must agree");
            assert!(
                description.len() > 40,
                "{}: the description is the whole triggering mechanism",
                one.slug
            );
            // It is rendered into the system prompt, and the import path
            // refuses angle brackets in frontmatter for the same reason.
            assert!(
                !description.contains('<') && !description.contains('>'),
                "{}: no angle brackets in a description",
                one.slug
            );
            assert!(
                !one.files.is_empty(),
                "{}: a bundle with no files",
                one.slug
            );
        }
    }

    /// A plugin that loads nothing is the failure this catches. Measured:
    /// Claude Code reads every child of a `--plugin-dir` folder, and a child
    /// **without** `.claude-plugin/plugin.json` is not loaded at all — the
    /// `init` frame comes back with `plugins: []` and no error anywhere.
    #[test]
    fn every_plugin_carries_the_manifest_that_makes_it_one() {
        for one in ALL.iter().filter(|b| b.kind == Kind::Plugin) {
            assert!(
                one.file(".claude-plugin/plugin.json").is_some(),
                "{}: a plugin without its manifest silently loads nothing",
                one.slug
            );
            assert!(
                one.files
                    .iter()
                    .any(|(p, _)| p.starts_with("skills/") || p.starts_with("commands/"))
                    || one.connector.is_some(),
                "{}: a plugin with no components in it",
                one.slug
            );
        }
    }

    /// A skill's bundle is its `SKILL.md` and the standard says so. One that
    /// shipped a manifest instead would be written to the skills directory
    /// and read by nothing.
    #[test]
    fn every_skill_is_one_file_called_skill_md() {
        for one in ALL.iter().filter(|b| b.kind == Kind::Skill) {
            assert_eq!(one.files.len(), 1, "{}: a skill is one file", one.slug);
            assert_eq!(one.files[0].0, "SKILL.md", "{}: spelt exactly", one.slug);
            let (_, _, body) = one.describe().expect("it parses");
            assert!(!body.is_empty(), "{}: a skill with no body", one.slug);
        }
    }

    /// The contract is the reason this one exists; losing the path would leave
    /// a skill that reads well and publishes nothing.
    #[test]
    fn the_artifact_skill_still_says_where_a_file_goes() {
        let (_, _, body) = ALL[0].describe().expect("it parses");
        assert!(body.contains(".firetower/artifacts/<name>/index.html"));
    }
}
