//! What actually lands on a worker's disk, per engine.
//!
//! The claim slice one makes is that **one row, one switch, every engine** —
//! so these assert the four layouts rather than the one that was easiest to
//! build. Each is asserted against the engine's own discovery path, which is
//! what `docs/skills.md` says to do and what stops a test agreeing with our
//! intent instead of with the agent.
//!
//! The facts under them were measured against the installed CLIs, not read:
//!
//! - Claude Code 2.1.273 loads **each child** of a `--plugin-dir` folder, and
//!   a child without `.claude-plugin/plugin.json` is not loaded at all.
//! - Codex 0.156.1 reports a skill under `$CODEX_HOME/skills` as
//!   `scope: "user"`, and takes MCP servers from `config.toml`.
//! - Kimi Code 2.1.1 has no `plugin` and no `mcp` subcommand; `--skills-dir`
//!   is the whole of its extension surface, and `session/new` is the only way
//!   a server reaches it.

use std::path::Path;

use ft_core::{Agent, SessionId};
use ft_proto::{encode, BundleKind, SkillBundle, SkillFile};

fn file(path: &str, body: &str) -> SkillFile {
    SkillFile {
        path: path.into(),
        contents: encode(body.as_bytes()),
        executable: false,
    }
}

/// A plugin holding two skills, a command and a connector — one of each thing
/// the delivery has to decide about.
fn a_plugin() -> SkillBundle {
    SkillBundle {
        name: "security-review".into(),
        kind: BundleKind::Plugin,
        files: vec![
            file(
                ".claude-plugin/plugin.json",
                r#"{"name":"security-review","description":"d","version":"1.0.0"}"#,
            ),
            file(
                "skills/review-the-diff/SKILL.md",
                "---\nname: review-the-diff\n---\nbody",
            ),
            file("skills/review-the-diff/references/rust.md", "more"),
            file(
                "skills/patch-verifier/SKILL.md",
                "---\nname: patch-verifier\n---\nbody",
            ),
            file("commands/review.md", "a command"),
            file(
                ".mcp.json",
                r#"{"mcpServers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer secret-token"}}}}"#,
            ),
        ],
    }
}

/// A lone skill, which must keep going exactly where it goes today.
fn a_skill() -> SkillBundle {
    SkillBundle {
        name: "code-review".into(),
        kind: BundleKind::Skill,
        files: vec![file("SKILL.md", "---\nname: code-review\n---\nbody")],
    }
}

async fn apply(dir: &Path, agent: Agent) -> SessionId {
    let id = SessionId::from_stored("s_test");
    ft_worker::skills::apply(dir, &id, agent, &[a_plugin(), a_skill()], false)
        .await
        .expect("the set is written");
    id
}

/// Claude Code is handed a folder and reads every child of it as a plugin.
#[tokio::test]
async fn claude_code_gets_a_folder_of_plugins_and_its_skills_stay_where_they_were() {
    let dir = tempfile::tempdir().unwrap();
    let id = apply(dir.path(), Agent::ClaudeCode).await;

    let plugins = ft_worker::plugins::root(dir.path(), &id);
    assert!(
        plugins
            .join("security-review/.claude-plugin/plugin.json")
            .is_file(),
        "a plugin without its manifest is a folder Claude Code silently ignores"
    );
    assert!(plugins
        .join("security-review/skills/review-the-diff/SKILL.md")
        .is_file());
    assert!(
        plugins
            .join("security-review/skills/review-the-diff/references/rust.md")
            .is_file(),
        "a skill's references travel with it"
    );
    assert!(plugins.join("security-review/commands/review.md").is_file());
    assert!(plugins.join("security-review/.mcp.json").is_file());

    // And the lone skill is untouched by any of it: still a folder in the
    // skills root, which is the whole reason the library is not migrated.
    let skills = ft_worker::skills::root(dir.path(), &id, Agent::ClaudeCode).unwrap();
    assert!(skills.join("code-review/SKILL.md").is_file());
    assert!(
        !skills.join("security-review").exists(),
        "a plugin in the skills directory loads as nothing"
    );
}

/// Codex has no plugin directory this worker drives yet, so the bundle is
/// taken apart: its skills to the skills root it already reads, its connector
/// into the `config.toml` it already reads.
#[tokio::test]
async fn codex_gets_the_skills_out_of_the_plugin_and_the_connector_in_its_config() {
    let dir = tempfile::tempdir().unwrap();
    let id = apply(dir.path(), Agent::Codex).await;

    let skills = ft_worker::skills::root(dir.path(), &id, Agent::Codex).unwrap();
    assert!(
        skills.join("review-the-diff/SKILL.md").is_file(),
        "a plugin's skill is a skill, under its own name"
    );
    assert!(
        skills.join("review-the-diff/references/rust.md").is_file(),
        "paths are rewritten relative to the skill, not left under skills/"
    );
    assert!(skills.join("patch-verifier/SKILL.md").is_file());
    assert!(
        skills.join("code-review/SKILL.md").is_file(),
        "the lone skill too"
    );

    let config = std::fs::read_to_string(
        ft_worker::agentd::dir_for(dir.path())
            .join(format!("agent-home-{}", id.as_str()))
            .join("config.toml"),
    )
    .expect("codex gets a config.toml");
    assert!(config.contains("[mcp_servers.github]"), "{config}");
    assert!(
        config.contains("https://api.githubcopilot.com/mcp/"),
        "{config}"
    );
    assert!(
        config.contains("Bearer secret-token"),
        "the credential reaches the engine, or the connector is decoration"
    );
}

/// Written twice, the block is replaced rather than repeated — and anything
/// that was already in the file survives. One bad line makes Codex fail to
/// load its configuration at all and answer with no skills, so this is the
/// test that stops a duplicate table from being how somebody finds out.
#[tokio::test]
async fn codex_config_is_rewritten_in_place_and_keeps_what_was_already_there() {
    let dir = tempfile::tempdir().unwrap();
    let id = SessionId::from_stored("s_test");
    let home = ft_worker::agentd::dir_for(dir.path()).join(format!("agent-home-{}", id.as_str()));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("config.toml"), "model = \"gpt-5\"\n").unwrap();

    for _ in 0..2 {
        ft_worker::skills::apply(dir.path(), &id, Agent::Codex, &[a_plugin()], false)
            .await
            .unwrap();
    }
    let config = std::fs::read_to_string(home.join("config.toml")).unwrap();
    assert!(config.contains("model = \"gpt-5\""), "{config}");
    assert_eq!(
        config.matches("[mcp_servers.github]").count(),
        1,
        "a second apply must replace the block, not append another: {config}"
    );
}

/// Kimi reads a skills directory and nothing else, so everything the plugin
/// can give it arrives that way — and its connector travels in `session/new`,
/// which is what `acp_mcp_servers` builds.
#[tokio::test]
async fn kimi_gets_the_skills_and_the_connector_in_the_shape_acp_takes() {
    let dir = tempfile::tempdir().unwrap();
    let id = apply(dir.path(), Agent::KimiCode).await;

    let skills = ft_worker::skills::root(dir.path(), &id, Agent::KimiCode).unwrap();
    assert!(skills.join("review-the-diff/SKILL.md").is_file());
    assert!(skills.join("patch-verifier/SKILL.md").is_file());
    assert!(skills.join("code-review/SKILL.md").is_file());

    let servers = ft_worker::plugins::acp_mcp_servers(dir.path(), &id).await;
    assert_eq!(servers.len(), 1, "one connector, one server");
    assert_eq!(servers[0]["name"], "github");
    assert_eq!(servers[0]["type"], "http");
    assert_eq!(servers[0]["url"], "https://api.githubcopilot.com/mcp/");
    // ACP takes headers as a list of pairs rather than as an object, so this
    // is a translation and a pass-through would have been silently wrong.
    assert_eq!(servers[0]["headers"][0]["name"], "Authorization");
    assert_eq!(servers[0]["headers"][0]["value"], "Bearer secret-token");
}

/// A plugin that stops being in the set stops being on the disk. The whole
/// selection arrives every time, so what is gone is what is not in it.
#[tokio::test]
async fn a_plugin_taken_out_of_the_set_leaves_the_disk() {
    let dir = tempfile::tempdir().unwrap();
    let id = apply(dir.path(), Agent::ClaudeCode).await;
    let at = ft_worker::plugins::root(dir.path(), &id).join("security-review");
    assert!(at.exists());

    ft_worker::skills::apply(dir.path(), &id, Agent::ClaudeCode, &[a_skill()], false)
        .await
        .unwrap();
    assert!(!at.exists(), "it is still being handed to the agent");
}

/// **The token is rewritten on every launch.** A bundle already on disk under
/// the same name is carrying an access token from the last session, and those
/// have an hour on them — leaving it would hand this session a credential that
/// has very likely expired, and the failure would read as the connector being
/// broken rather than as it being stale.
#[tokio::test]
async fn a_second_launch_replaces_the_token_rather_than_keeping_it() {
    let dir = tempfile::tempdir().unwrap();
    let id = apply(dir.path(), Agent::ClaudeCode).await;

    let mut fresher = a_plugin();
    fresher.files.retain(|f| f.path != ".mcp.json");
    fresher.files.push(file(
        ".mcp.json",
        r#"{"mcpServers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer minted-just-now"}}}}"#,
    ));
    ft_worker::skills::apply(dir.path(), &id, Agent::ClaudeCode, &[fresher], false)
        .await
        .unwrap();

    let at = ft_worker::plugins::root(dir.path(), &id).join("security-review/.mcp.json");
    let text = std::fs::read_to_string(at).unwrap();
    assert!(text.contains("minted-just-now"), "{text}");
    assert!(
        !text.contains("secret-token"),
        "the stale one is still there: {text}"
    );
}

/// Every engine that runs an agent has somewhere for a plugin to go. The shell
/// is the one that reads nothing, and it answers `None` rather than being
/// handed a directory it would ignore.
#[test]
fn every_engine_has_an_answer_for_where_a_plugin_goes() {
    for agent in Agent::every() {
        let home = agent.plugins_home();
        assert_eq!(
            home.is_none(),
            agent == Agent::Shell,
            "{:?} has no plugin home and is not the shell",
            agent
        );
    }
}

/// A plugin that carries a skill somebody already has.
///
/// **It used to replace it, silently, on three engines out of four.** Claude
/// Code is unaffected because a plugin folder and the skills directory are
/// different roots; everything that decomposes writes into one directory
/// keyed on the folder name, so `code-review` from a plugin landed on
/// `code-review` from the person's own library and nothing said so.
#[tokio::test]
async fn a_plugin_does_not_quietly_replace_a_skill_of_the_same_name() {
    let dir = tempfile::tempdir().unwrap();
    let id = SessionId::new();

    let mine = SkillBundle {
        name: "code-review".into(),
        kind: ft_proto::BundleKind::Skill,
        files: vec![file("SKILL.md", "---\nname: code-review\n---\nMINE\n")],
    };
    let theirs = SkillBundle {
        name: "security-review".into(),
        kind: ft_proto::BundleKind::Plugin,
        files: vec![
            file(".claude-plugin/plugin.json", r#"{"name":"security-review"}"#),
            file(
                "skills/code-review/SKILL.md",
                "---\nname: code-review\n---\nTHEIRS\n",
            ),
        ],
    };

    ft_worker::skills::apply(dir.path(), &id, Agent::Codex, &[mine, theirs], false)
        .await
        .unwrap();

    let root = ft_worker::skills::root(dir.path(), &id, Agent::Codex).unwrap();
    let ours = tokio::fs::read_to_string(root.join("code-review/SKILL.md"))
        .await
        .expect("the skill somebody wrote is still there");
    assert!(ours.contains("MINE"), "the plugin overwrote it: {ours}");

    // And the plugin's own copy still arrives, under a name that says where
    // it came from rather than not arriving at all.
    let prefixed = tokio::fs::read_to_string(root.join("security-review-code-review/SKILL.md"))
        .await
        .expect("the plugin's copy is written beside it");
    assert!(prefixed.contains("THEIRS"));
}
