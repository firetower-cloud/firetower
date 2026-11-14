//! Putting a session's skills where its agent will find them.
//!
//! **One shape for all three agents: a directory of bundles belonging to one
//! session.** A workspace holds several sessions — a second agent in one place
//! is a second session — each with its own agent and its own selection, so
//! anything shared by the workspace is the wrong home. Codex and Kimi already
//! get a directory per session; Claude Code is handed one on the command line
//! with `--add-dir`.
//!
//! **The whole selection, every time.** What arrives is the set the session
//! should be reading, not a change to it. A bundle already on disk under the
//! same name is left alone rather than rewritten, so a skill the agent is
//! part-way through reading does not move under it; one that is no longer in
//! the set is removed, which is what every agent watches for.
//!
//! Verified against the real CLIs, not their documentation — Claude Code
//! 2.1.273 lists a skill dropped into an added directory in its `init` frame,
//! and Codex 0.156.1 reports one under `$CODEX_HOME/skills` as
//! `scope: "user"` and fires `skills/changed` when the directory moves.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use ft_core::{Agent, SessionId, SkillsHome};
use ft_proto::SkillBundle;

use crate::agentd;

/// The directory Claude Code is pointed at — the parent of `.claude`.
///
/// Its own session's, so two agents in one workspace cannot see each other's.
pub fn added_dir(workspace: &Path, id: &SessionId) -> PathBuf {
    agentd::dir_for(workspace).join(format!("skills-{}", id.as_str()))
}

/// Where this session's bundles are written, for this agent.
///
/// `None` for an agent that has no way to read them, which is only the shell.
pub fn root(workspace: &Path, id: &SessionId, agent: Agent) -> Option<PathBuf> {
    match agent.skills_home()? {
        // Inside the home the agent is already given per session, at whatever
        // path that agent reads — `skills/` for Codex and Kimi,
        // `.cursor/skills/` for Cursor.
        SkillsHome::AgentHome(under) => Some(
            agentd::dir_for(workspace)
                .join(format!("agent-home-{}", id.as_str()))
                .join(under),
        ),
        // Claude Code reads `<added>/.claude/skills/<name>/`.
        SkillsHome::AddedDirectory => Some(added_dir(workspace, id).join(".claude").join("skills")),
    }
}

/// Make the set on disk be exactly `skills`.
///
/// The directory is created even when the set is empty. That is deliberate:
/// Claude Code watches a skills directory it already knows about, and needs
/// `/reload-skills` for one that appears later — so the first skill somebody
/// turns on mid-conversation has to land in a directory that was already
/// there.
pub async fn apply(
    workspace: &Path,
    id: &SessionId,
    agent: Agent,
    skills: &[SkillBundle],
    // **Whether every one of them has to land.** Off, the long-standing
    // answer: one bundle a filesystem refuses costs that bundle and is said
    // out loud, because the set a session asked for is worth more than the
    // one skill nobody can write. On — an approved workspace being created,
    // with nobody present — the first failure is the answer, and the caller
    // must not start the agent.
    //
    // Only `create_workspace` passes this on. `start_agent` passes `false`
    // whatever the session was approved with, so a relaunch is best effort;
    // that is a gap and is named where it is, not papered over here. See
    // `ft_proto::CreateWorkspace::skills_required`.
    required: bool,
) -> Result<()> {
    let Some(root) = root(workspace, id, agent) else {
        return Ok(());
    };
    tokio::fs::create_dir_all(&root)
        .await
        .with_context(|| format!("making {}", root.display()))?;

    // What is there now, so that what is gone can go.
    let mut present: Vec<String> = Vec::new();
    if let Ok(mut entries) = tokio::fs::read_dir(&root).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                present.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
    }

    for bundle in skills {
        // The name is a folder, so it has to be one label and nothing else. It
        // comes from the control plane rather than from a person, and is
        // checked anyway: a name with a separator in it would write outside the
        // directory this cleans up.
        if !usable(&bundle.name) {
            if required {
                anyhow::bail!(
                    "“{}” is not a name this machine can make a folder from, and this run was \
                     approved to read it",
                    bundle.name
                );
            }
            tracing::warn!(skill = %bundle.name, "not a usable skill folder name; skipped");
            continue;
        }
        let at = root.join(&bundle.name);
        // Already here under this name. Left alone rather than rewritten, so a
        // skill the agent is reading does not change under it — and so that
        // applying the same set twice costs nothing.
        if present.iter().any(|p| p == &bundle.name) {
            continue;
        }
        // One bundle, not the set. **This used to be a `?`**, and the whole
        // selection went with whichever bundle could not be written — so a
        // skill shaped in a way the filesystem refuses took a colleague's
        // *other* skills off their session, and the removal pass below never
        // ran either. The control plane refuses the shapes that are known to
        // do it, and that list is a list: it cannot be complete against every
        // filesystem a worker might run on. The set a session asked for is
        // worth more than the one bundle nobody can write, so the bundle is
        // skipped and said out loud, the same answer an unusable name gets
        // just above.
        if let Err(e) = write_bundle(&at, bundle).await {
            if required {
                return Err(e).with_context(|| {
                    format!(
                        "writing “{}”, which this run was approved to read",
                        bundle.name
                    )
                });
            }
            tracing::warn!(skill = %bundle.name, "could not write it; skipped: {e:#}");
        }
    }

    for gone in present
        .iter()
        .filter(|p| !skills.iter().any(|s| &&s.name == p))
    {
        let at = root.join(gone);
        if let Err(e) = tokio::fs::remove_dir_all(&at).await {
            tracing::warn!(skill = %gone, "could not take it back out: {e}");
        }
    }

    // **Checked, not assumed.** Everything above is a write that said it
    // worked; this is the directory saying so. It costs one `metadata` call
    // per approved skill and it is the only statement here that does not
    // depend on having thought of the way a write can half-happen.
    if required {
        for bundle in skills {
            let at = root.join(&bundle.name);
            if !tokio::fs::try_exists(&at).await.unwrap_or(false) {
                anyhow::bail!(
                    "“{}” is not in {} and this run was approved to read it",
                    bundle.name,
                    root.display()
                );
            }
            for file in &bundle.files {
                let path = at.join(&file.path);
                if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
                    anyhow::bail!(
                        "{} is missing from “{}”, which this run was approved to read",
                        file.path,
                        bundle.name
                    );
                }
            }
        }
    }

    tracing::info!(
        root = %root.display(),
        count = skills.len(),
        "this session's skills are in place"
    );
    Ok(())
}

/// One label: what a directory name may be, and nothing that climbs out of it.
fn usable(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Write one bundle into its own folder, atomically enough.
///
/// Into a staging name and then renamed, so an agent watching the directory
/// never sees a skill with half its files. Every agent here reacts to a
/// directory appearing, and a `SKILL.md` that arrives before its
/// `references/` is a skill that fails the first time it is used.
async fn write_bundle(at: &Path, bundle: &SkillBundle) -> Result<()> {
    let staging = at.with_file_name(format!(".{}.writing", bundle.name));
    let out = fill(&staging, at, bundle).await;
    if out.is_err() {
        // Half a bundle is not left lying beside the whole ones. It would be
        // swept up by the removal pass on the next `apply` anyway — nothing
        // is named after it — but a session reading this directory now should
        // not have to step over it.
        tokio::fs::remove_dir_all(&staging).await.ok();
    }
    out.with_context(|| format!("writing the {} skill", bundle.name))
}

/// Everything [`write_bundle`] does, so that it can clean up after a failure.
async fn fill(staging: &Path, at: &Path, bundle: &SkillBundle) -> Result<()> {
    tokio::fs::remove_dir_all(staging).await.ok();
    tokio::fs::create_dir_all(staging).await?;

    for file in &bundle.files {
        let relative = Path::new(&file.path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            anyhow::bail!("{} is not a name inside the skill's own folder", file.path);
        }
        let to = staging.join(relative);
        if let Some(parent) = to.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let bytes = ft_proto::decode(&file.contents)
            .with_context(|| format!("{} did not arrive intact", file.path))?;
        tokio::fs::write(&to, &bytes)
            .await
            .with_context(|| format!("writing {}", to.display()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Readable by whatever runs the agent, and executable only where
            // the bundle said so. Nothing here is a credential, so this is not
            // the 0600 that `write_agent_home` uses — a skill the agent cannot
            // read is a skill that does nothing.
            let mode = if file.executable { 0o755 } else { 0o644 };
            tokio::fs::set_permissions(&to, std::fs::Permissions::from_mode(mode))
                .await
                .ok();
        }
    }

    tokio::fs::remove_dir_all(at).await.ok();
    tokio::fs::rename(staging, at)
        .await
        .with_context(|| format!("moving into {}", at.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(name: &str, files: &[(&str, &str, bool)]) -> SkillBundle {
        SkillBundle {
            name: name.into(),
            files: files
                .iter()
                .map(|(p, body, x)| ft_proto::SkillFile {
                    path: (*p).into(),
                    contents: ft_proto::encode(body.as_bytes()),
                    executable: *x,
                })
                .collect(),
        }
    }

    /// **Blocker B: a required set is installed or the launch fails.**
    ///
    /// Writing these is best effort, which is right for somebody sitting in
    /// front of a session: one skill a filesystem refuses costs that skill
    /// rather than the session. A run *approved* against named skill versions
    /// is the other case — a safety skill among them as often as not, with
    /// nobody there to notice it is absent — and the server refusing to
    /// dispatch without it means nothing if this swallows the failure.
    #[tokio::test]
    async fn a_required_skill_that_cannot_be_written_fails_the_launch() {
        let dir = tempfile::tempdir().unwrap();
        let id = SessionId::from_stored("s_required");

        // A name that is not a folder. Best effort skips it and says so.
        let skipped = apply(
            dir.path(),
            &id,
            Agent::ClaudeCode,
            &[bundle("../escape", &[("SKILL.md", "x", false)])],
            false,
        )
        .await;
        assert!(
            skipped.is_ok(),
            "best effort keeps the session: {skipped:?}"
        );

        // Required, and the same set is a refusal rather than a warning.
        let refused = apply(
            dir.path(),
            &id,
            Agent::ClaudeCode,
            &[bundle("../escape", &[("SKILL.md", "x", false)])],
            true,
        )
        .await
        .expect_err("a run approved to read it cannot start without it");
        assert!(
            format!("{refused:#}").contains("approved to read"),
            "{refused:#}"
        );
    }

    /// **And "written" is checked rather than assumed.**
    ///
    /// Every write above reports its own success, and the reviewer reproduced
    /// `Ok(())` with an approved `SKILL.md` absent — so the last word is the
    /// directory's, not the writer's. Reproduced here by taking the file away
    /// behind the writer's back, which is what a half-failed write looks like
    /// from this side.
    #[tokio::test]
    async fn a_required_skill_missing_from_disk_fails_the_launch() {
        let dir = tempfile::tempdir().unwrap();
        let id = SessionId::from_stored("s_vanished");
        let root = root(dir.path(), &id, Agent::ClaudeCode).unwrap();
        let set = [bundle("house-prose", &[("SKILL.md", "x", false)])];

        apply(dir.path(), &id, Agent::ClaudeCode, &set, true)
            .await
            .expect("it lands");
        tokio::fs::remove_file(root.join("house-prose/SKILL.md"))
            .await
            .unwrap();

        // The folder is still there, so nothing above this notices: applying
        // the same set leaves a skill the agent cannot read.
        let refused = apply(dir.path(), &id, Agent::ClaudeCode, &set, true)
            .await
            .expect_err("the file it was approved to read is not there");
        assert!(
            format!("{refused:#}").contains("SKILL.md"),
            "and says which: {refused:#}"
        );
        // Best effort still comes up, with the skill empty.
        assert!(apply(dir.path(), &id, Agent::ClaudeCode, &set, false)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn the_set_on_disk_becomes_the_set_that_was_sent() {
        let dir = tempfile::tempdir().unwrap();
        let id = SessionId::from_stored("s_test");
        let root = root(dir.path(), &id, Agent::ClaudeCode).unwrap();

        apply(
            dir.path(),
            &id,
            Agent::ClaudeCode,
            &[
                bundle(
                    "rust-review",
                    &[("SKILL.md", "---\nname: rust-review\n---\n", false)],
                ),
                bundle("house-prose", &[("SKILL.md", "x", false)]),
            ],
            false,
        )
        .await
        .unwrap();
        assert!(root.join("rust-review/SKILL.md").exists());
        assert!(root.join("house-prose/SKILL.md").exists());

        // The whole selection, so dropping one takes it off disk.
        apply(
            dir.path(),
            &id,
            Agent::ClaudeCode,
            &[bundle("rust-review", &[("SKILL.md", "x", false)])],
            false,
        )
        .await
        .unwrap();
        assert!(root.join("rust-review").exists());
        assert!(!root.join("house-prose").exists());

        // And an empty set leaves the directory itself, because a watcher
        // already knows about it and would not notice a new one.
        apply(dir.path(), &id, Agent::ClaudeCode, &[], false)
            .await
            .unwrap();
        assert!(root.exists());
        assert!(!root.join("rust-review").exists());
    }

    #[tokio::test]
    async fn a_script_arrives_executable() {
        let dir = tempfile::tempdir().unwrap();
        let id = SessionId::from_stored("s_exec");
        apply(
            dir.path(),
            &id,
            Agent::Codex,
            &[bundle(
                "release",
                &[
                    ("SKILL.md", "x", false),
                    ("scripts/go.sh", "#!/bin/sh\n", true),
                ],
            )],
            false,
        )
        .await
        .unwrap();

        let root = root(dir.path(), &id, Agent::Codex).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| {
                std::fs::metadata(root.join(p))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777
            };
            assert_eq!(mode("release/scripts/go.sh"), 0o755);
            assert_eq!(mode("release/SKILL.md"), 0o644);
        }
    }

    #[tokio::test]
    async fn a_name_that_climbs_out_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let id = SessionId::from_stored("s_bad");
        apply(
            dir.path(),
            &id,
            Agent::Codex,
            &[bundle("../escape", &[("SKILL.md", "x", false)])],
            false,
        )
        .await
        .unwrap();
        assert!(!dir.path().join("escape").exists());
    }

    /// **One bundle nobody can write does not take the set with it.**
    ///
    /// Established rather than assumed, because the two answers are very
    /// different severities: this used to be a `?`, so `apply` returned the
    /// first write error and every bundle ordered after the bad one was never
    /// written — one malicious skill took a colleague's *other* skills off
    /// their session, and the removal pass below it never ran either.
    ///
    /// The bad bundle here is the confirmed shape: a path that has to be a
    /// file for one row and a folder for another, which fails with `Not a
    /// directory`. The control plane refuses that shape now, and this is the
    /// other half — the list of shapes a filesystem refuses cannot be
    /// complete, so the set is worth more than the one bundle.
    #[tokio::test]
    async fn one_bundle_that_cannot_be_written_does_not_take_the_set() {
        let dir = tempfile::tempdir().unwrap();
        let id = SessionId::from_stored("s_partial");
        let root = root(dir.path(), &id, Agent::ClaudeCode).unwrap();

        apply(
            dir.path(),
            &id,
            Agent::ClaudeCode,
            &[
                bundle("good-one", &[("SKILL.md", "x", false)]),
                bundle(
                    "ship-it",
                    &[
                        ("SKILL.md", "x", false),
                        ("scripts", "a file", false),
                        ("scripts/run.sh", "#!/bin/sh\n", false),
                    ],
                ),
                bundle("after-it", &[("SKILL.md", "x", false)]),
            ],
            false,
        )
        .await
        .expect("the set is applied, not abandoned");

        assert!(root.join("good-one/SKILL.md").exists(), "ordered before it");
        assert!(root.join("after-it/SKILL.md").exists(), "ordered after it");
        assert!(!root.join("ship-it").exists(), "and the bad one is absent");
        // Not left half-written beside the whole ones either.
        assert!(!root.join(".ship-it.writing").exists());
    }

    #[tokio::test]
    async fn two_sessions_in_one_workspace_do_not_share() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (SessionId::from_stored("s_a"), SessionId::from_stored("s_b"));
        apply(
            dir.path(),
            &a,
            Agent::ClaudeCode,
            &[bundle("mine", &[("SKILL.md", "x", false)])],
            false,
        )
        .await
        .unwrap();
        apply(dir.path(), &b, Agent::ClaudeCode, &[], false)
            .await
            .unwrap();

        assert!(root(dir.path(), &a, Agent::ClaudeCode)
            .unwrap()
            .join("mine")
            .exists());
        assert!(!root(dir.path(), &b, Agent::ClaudeCode)
            .unwrap()
            .join("mine")
            .exists());
    }
}
