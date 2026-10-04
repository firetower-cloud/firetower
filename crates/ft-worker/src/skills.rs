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
        // `skills/` inside the home the agent is already given per session.
        SkillsHome::AgentHome => Some(
            agentd::dir_for(workspace)
                .join(format!("agent-home-{}", id.as_str()))
                .join("skills"),
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
        write_bundle(&at, bundle)
            .await
            .with_context(|| format!("writing the {} skill", bundle.name))?;
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
    tokio::fs::remove_dir_all(&staging).await.ok();
    tokio::fs::create_dir_all(&staging).await?;

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
    tokio::fs::rename(&staging, at)
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
                bundle("rust-review", &[("SKILL.md", "---\nname: rust-review\n---\n", false)]),
                bundle("house-prose", &[("SKILL.md", "x", false)]),
            ],
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
        )
        .await
        .unwrap();
        assert!(root.join("rust-review").exists());
        assert!(!root.join("house-prose").exists());

        // And an empty set leaves the directory itself, because a watcher
        // already knows about it and would not notice a new one.
        apply(dir.path(), &id, Agent::ClaudeCode, &[]).await.unwrap();
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
                &[("SKILL.md", "x", false), ("scripts/go.sh", "#!/bin/sh\n", true)],
            )],
        )
        .await
        .unwrap();

        let root = root(dir.path(), &id, Agent::Codex).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| {
                std::fs::metadata(root.join(p)).unwrap().permissions().mode() & 0o777
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
        )
        .await
        .unwrap();
        assert!(!dir.path().join("escape").exists());
    }

    #[tokio::test]
    async fn two_sessions_in_one_workspace_do_not_share() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (SessionId::from_stored("s_a"), SessionId::from_stored("s_b"));
        apply(dir.path(), &a, Agent::ClaudeCode, &[bundle("mine", &[("SKILL.md", "x", false)])])
            .await
            .unwrap();
        apply(dir.path(), &b, Agent::ClaudeCode, &[]).await.unwrap();

        assert!(root(dir.path(), &a, Agent::ClaudeCode).unwrap().join("mine").exists());
        assert!(!root(dir.path(), &b, Agent::ClaudeCode).unwrap().join("mine").exists());
    }
}
