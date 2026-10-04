//! Skills: folders of instructions an agent loads when it needs them.
//!
//! A skill is **Placed** — see `docs/paths-and-ownership.md`. It has a path,
//! it can be filed into a directory, and every read of one pastes
//! [`filed_where`] into its `WHERE`. Nothing here invents a second way to
//! decide who can see something.
//!
//! What this module owns is the part that is specific to skills: validating a
//! bundle somebody dropped, counting what its listing entry will cost in the
//! model's context, and saying what the bundle will *do* to a session.
//!
//! **Bytes are content-addressed.** Re-dropping a folder is how a version is
//! made, so a file that has not changed is not stored again — and two people
//! who dropped the same folder share one copy. See `blobs`.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use ft_core::{SkillId, SkillVersionId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::BTreeSet;
use utoipa::ToSchema;

use crate::access::{filed_where, Level};

// ── limits ──────────────────────────────────────────────────────────────
//
// Taken from the published libraries rather than guessed. `canvas-design` is
// 5.55 MB over 83 files and `claude-api`'s own SKILL.md is 102 KB over 603
// lines, so a cap of 50 files or 64 KB — the first draft's — would have
// refused five of Anthropic's six largest skills on the day they were tried.

/// The most files one version may hold.
pub const MOST_FILES: usize = 100;
/// The most one file may be.
pub const BIGGEST_FILE: usize = 2 * 1024 * 1024;
/// The most one version may be, across every file in it.
pub const BIGGEST_VERSION: usize = 25 * 1024 * 1024;
/// The most the instructions may be. Guidance says 5,000 words; this is the
/// refusal, which is deliberately far above it.
pub const BIGGEST_BODY: usize = 256 * 1024;
/// What the standard allows a description to be, and what every agent reads.
pub const BIGGEST_DESCRIPTION: usize = 1024;

/// Names an agent ships itself, which a skill of the same name would shadow.
const RESERVED: &[&str] = &[
    "code-review",
    "review",
    "doctor",
    "debug",
    "batch",
    "run",
    "verify",
    "loop",
    "init",
    "security-review",
    "simplify",
    "compact",
    "clear",
    "config",
    "model",
    "help",
    "imagegen",
    "plan",
    "skill-creator",
    "skill-installer",
    "plugin-creator",
    "review-agent",
];

// ── what a skill is, on the wire ────────────────────────────────────────

/// One row of the library.
///
/// `name` and `description` are copied down from the current version rather
/// than joined per row: this list is three hundred long and those two fields
/// are what every one of them draws.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: SkillId,
    /// `u/kevin/rust_review` — slashes on the wire, dots in the database.
    pub path: String,
    pub name: String,
    pub slug: String,
    pub description: String,
    pub version: i32,
    pub version_id: SkillVersionId,
    /// What the listing entry costs in the model's context, every turn.
    pub tokens: i32,
    pub files: i32,
    pub bytes: i64,
    /// What this skill does to a session, read from the bundle rather than
    /// from what its author said about it. See [`risk_of`].
    pub risk: Vec<String>,
    /// Who wrote it. A fact that outlives them leaving.
    pub author: Option<String>,
    pub updated_at: DateTime<Utc>,
    /// Whether this person may make a version of it or rename it.
    pub may_write: bool,
    /// The repositories this person has it on by default. Empty for most.
    pub default_in: Vec<String>,
    /// On in every workspace this person starts.
    pub always_on: bool,
}

/// One version, which is a fact about the past and never updated.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersion {
    pub id: SkillVersionId,
    pub version: i32,
    pub notes: Option<String>,
    pub tokens: i32,
    pub files: i32,
    pub bytes: i64,
    pub author: Option<String>,
    pub created_at: DateTime<Utc>,
    /// How many sessions are still reading this one.
    pub pinned_by: i64,
}

/// One file of a bundle, without its bytes.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: String,
    pub size: i64,
    pub executable: bool,
    /// Whether these bytes were already here under the same hash.
    pub shared: bool,
}

/// What the instructions say, for the screen that shows them.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub body: String,
    pub frontmatter: serde_json::Value,
    pub files: Vec<SkillFile>,
}

/// A file arriving from a drop.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct IncomingFile {
    /// Relative, inside the bundle. Never absolute and never climbing out.
    pub path: String,
    /// base64, because a bundle may hold a font.
    pub contents: String,
    #[serde(default)]
    pub executable: bool,
}

/// A whole bundle somebody dropped.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewSkill {
    pub name: String,
    pub description: String,
    /// Parsed, for the library to read. The bytes are kept as they arrived in
    /// `files`, so nothing here is what gets written onto a worker.
    pub frontmatter: serde_json::Value,
    pub body: String,
    pub files: Vec<IncomingFile>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Why a bundle was refused, in a sentence somebody can act on.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

// ── counting what it costs ──────────────────────────────────────────────

/// What a skill's listing entry costs in the model's context, in tokens.
///
/// Tokens rather than characters because that is the unit the agents
/// themselves use — Codex's own knob is `skills.max_context_tokens`. Counted
/// once, when a version is made, and stored: a picker redrawing on every
/// keystroke must not be running a tokenizer.
///
/// `o200k_base` is a byte-pair encoder and not Claude's, so this is an
/// estimate — close enough for a budget meter, and wrong for billing. It is
/// local, deterministic and needs no network, which a count used this often
/// has to be.
pub fn tokens_for(name: &str, description: &str) -> i32 {
    // Name, description, and the path the agent is told to read it from, which
    // is what every agent renders into the system prompt per skill.
    let entry = format!("{name}: {description} (skills/{name}/SKILL.md)");
    match tiktoken_rs::o200k_base() {
        Ok(bpe) => bpe.encode_ordinary(&entry).len() as i32,
        // A tokenizer that will not load must not stop somebody importing a
        // skill. Four characters a token is the usual English ratio.
        Err(_) => (entry.len() / 4) as i32,
    }
}

/// What this bundle will do to a session, read from the bundle itself.
///
/// Never from what the author claims. Four things, and all four are ordinary
/// parts of the format rather than abuses of it — which is exactly why they
/// are worth saying out loud on the row. Firetower strips none of them: a
/// skill behaves here as it does in Claude Code, and a half-protection that
/// stopped `hooks` while leaving `scripts/` would read as safety without being
/// any.
pub fn risk_of(frontmatter: &serde_json::Value, body: &str, paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    // `` !`cmd` `` runs before the model ever sees the skill, and its output is
    // pasted into the context.
    if body.contains("!`") {
        out.push("shell".to_string());
    }
    if frontmatter.get("allowed-tools").is_some() {
        out.push("tools".to_string());
    }
    if frontmatter.get("hooks").is_some() {
        out.push("hooks".to_string());
    }
    if paths.iter().any(|p| p.starts_with("scripts/")) {
        out.push("scripts".to_string());
    }
    out
}

/// Whether a name is one the agents already answer to.
pub fn is_reserved(name: &str) -> bool {
    RESERVED.contains(&name)
}

/// Check a name against the standard's rules.
///
/// 1–64 characters, lowercase letters, digits and hyphens, no leading or
/// trailing hyphen. Anthropic additionally reserves anything containing
/// `claude` or `anthropic`, and forbids `<` and `>` anywhere in the
/// frontmatter — it is rendered into the system prompt, so an angle bracket is
/// an injection route rather than a style question.
pub fn check_name(name: &str) -> Result<(), Refused> {
    if name.is_empty() || name.len() > 64 {
        return Err(Refused("a name is 1 to 64 characters".into()));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(Refused(
            "a name holds lowercase letters, digits and hyphens".into(),
        ));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(Refused("a name does not start or end with a hyphen".into()));
    }
    if name.contains("claude") || name.contains("anthropic") {
        return Err(Refused(
            "`claude` and `anthropic` are reserved in a skill name".into(),
        ));
    }
    Ok(())
}

/// Check the whole bundle before any of it is written.
pub fn check(new: &NewSkill) -> Result<(), Refused> {
    check_name(&new.name)?;

    // The file has to *declare* a name. Claude Code falls back to the folder
    // when the key is missing, and that fallback is what lets a misspelled
    // `nae:` through — the skill lands in a shared library under a name
    // nothing in the file ever said, and the bundle written onto a worker
    // still says `nae`. The standard requires the field; so does this.
    //
    // Not required to *equal* `new.name`: the review step exists so that a
    // name colliding with one an agent already ships can be changed, and that
    // is a legitimate difference rather than a malformed file.
    match new.frontmatter.get("name").and_then(|v| v.as_str()) {
        Some(declared) if !declared.trim().is_empty() => {}
        _ => {
            let typo = new
                .frontmatter
                .as_object()
                .and_then(|m| m.keys().find(|k| one_edit_from(k, "name")).cloned());
            return Err(Refused(match typo {
                Some(k) => format!(
                    "its SKILL.md has no `name` field — there is a `{k}:`, which nothing reads"
                ),
                None => "its SKILL.md has no `name` field, and the standard requires one".into(),
            }));
        }
    }
    match new.frontmatter.get("description").and_then(|v| v.as_str()) {
        Some(d) if !d.trim().is_empty() => {}
        _ => {
            let typo = new
                .frontmatter
                .as_object()
                .and_then(|m| m.keys().find(|k| one_edit_from(k, "description")).cloned());
            return Err(Refused(match typo {
                Some(k) => format!("its SKILL.md has no `description` field — there is a `{k}:`, which nothing reads"),
                None => "its SKILL.md has no `description` field, and it is what the model decides on".into(),
            }));
        }
    }

    if new.description.trim().is_empty() {
        return Err(Refused(
            "a description is what the model decides on, so it cannot be empty".into(),
        ));
    }
    if new.description.chars().count() > BIGGEST_DESCRIPTION {
        return Err(Refused(format!(
            "a description is at most {BIGGEST_DESCRIPTION} characters"
        )));
    }
    if new.body.len() > BIGGEST_BODY {
        return Err(Refused(format!(
            "the instructions are at most {} KB",
            BIGGEST_BODY / 1024
        )));
    }
    // The frontmatter is rendered into the system prompt, so an angle bracket
    // in it is a way to inject a tag rather than a matter of taste.
    if serde_json::to_string(&new.frontmatter)
        .map(|t| t.contains('<') || t.contains('>'))
        .unwrap_or(false)
    {
        return Err(Refused(
            "`<` and `>` are not allowed in frontmatter — it is read as part of the system prompt"
                .into(),
        ));
    }
    if !new.files.iter().any(|f| f.path == "SKILL.md") {
        return Err(Refused(
            "a skill folder holds a SKILL.md, spelled exactly that way".into(),
        ));
    }
    if new.files.len() > MOST_FILES {
        return Err(Refused(format!("a skill holds at most {MOST_FILES} files")));
    }

    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    for f in &new.files {
        if !seen.insert(f.path.clone()) {
            return Err(Refused(format!("{} is in the bundle twice", f.path)));
        }
        check_path(&f.path)?;
        let bytes = ft_proto::decode(&f.contents)
            .ok_or_else(|| Refused(format!("{} did not arrive intact", f.path)))?;
        if bytes.len() > BIGGEST_FILE {
            return Err(Refused(format!(
                "{} is larger than the {} MB a file may be",
                f.path,
                BIGGEST_FILE / 1024 / 1024
            )));
        }
        total += bytes.len();
    }
    if total > BIGGEST_VERSION {
        return Err(Refused(format!(
            "a skill is at most {} MB",
            BIGGEST_VERSION / 1024 / 1024
        )));
    }
    Ok(())
}

/// Whether one word is a single edit away from another — a misspelled key.
///
/// Stopped at two, because the only question is "did they mean this one".
fn one_edit_from(a: &str, b: &str) -> bool {
    if a == b || a.len().abs_diff(b.len()) > 1 {
        return false;
    }
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut next = vec![i];
        for j in 1..=b.len() {
            next.push(
                (row[j] + 1)
                    .min(next[j - 1] + 1)
                    .min(row[j - 1] + usize::from(a[i - 1] != b[j - 1])),
            );
        }
        row = next;
    }
    row[b.len()] == 1
}

/// A path inside a bundle, and nothing else.
fn check_path(path: &str) -> Result<(), Refused> {
    if path.is_empty() {
        return Err(Refused("a file needs a name".into()));
    }
    if path.starts_with('/') || path.contains('\\') || path.contains("..") {
        return Err(Refused(format!(
            "{path} is not a name inside the skill's own folder"
        )));
    }
    if path.split('/').any(|seg| seg.is_empty() || seg == ".") {
        return Err(Refused(format!("{path} is not a usable path")));
    }
    Ok(())
}

/// `rust-review` → `rust_review`, which is what an `ltree` label may hold.
pub fn slug_of(name: &str) -> String {
    ft_core::slug(name)
}

// ── the store ───────────────────────────────────────────────────────────

/// Skills over the control plane's pool.
#[derive(Clone)]
pub struct Skills {
    pool: PgPool,
}

/// Columns every list of skills reads.
const COLUMNS: &str = "k.id, k.path::text AS path, k.name, k.slug, k.description, \
     k.current_version_id, k.updated_at, \
     v.version, v.tokens, v.files, v.bytes, v.frontmatter, v.body, \
     EXISTS (SELECT 1 FROM skill_files f \
              WHERE f.version_id = v.id AND f.path LIKE 'scripts/%') AS has_scripts, \
     u.name AS author";

const FROM: &str = "FROM skills k \
     LEFT JOIN skill_versions v ON v.id = k.current_version_id \
     LEFT JOIN principals u ON u.id = k.created_by";

impl Skills {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Every skill this person may see, with their own defaults folded in.
    ///
    /// `filed_where` is the only definition of "may see this" and this pastes
    /// it rather than writing a predicate of its own.
    pub async fn visible(&self, person: &str, at_least: Level) -> Result<Vec<Skill>> {
        let sql = format!(
            "SELECT {COLUMNS}, \
               (SELECT coalesce(array_agg(r.slug) FILTER (WHERE r.slug IS NOT NULL), '{{}}') \
                  FROM skill_defaults sd LEFT JOIN repos r ON r.id = sd.repo_id \
                 WHERE sd.skill_id = k.id AND sd.user_id = $1 AND sd.repo_id IS NOT NULL) AS default_in, \
               EXISTS (SELECT 1 FROM skill_defaults sd \
                        WHERE sd.skill_id = k.id AND sd.user_id = $1 AND sd.repo_id IS NULL) AS always_on, \
               {writable} AS may_write \
             {FROM} WHERE {visible} ORDER BY k.name",
            visible = filed_where("k", 1, at_least),
            writable = filed_where("k", 1, Level::Writer),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .fetch_all(&self.pool)
            .await
            .context("reading the skills somebody can see")?;
        rows.into_iter().map(read_skill).collect()
    }

    /// One skill, if this person may see it.
    pub async fn one(&self, person: &str, id: &str, at_least: Level) -> Result<Option<Skill>> {
        let sql = format!(
            "SELECT {COLUMNS}, '{{}}'::text[] AS default_in, false AS always_on, \
               {writable} AS may_write \
             {FROM} WHERE k.id = $2 AND {visible}",
            visible = filed_where("k", 1, at_least),
            writable = filed_where("k", 1, Level::Writer),
        );
        let row = sqlx::query(&sql)
            .bind(person)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a skill")?;
        row.map(read_skill).transpose()
    }

    /// The instructions and the file list of a skill's current version.
    pub async fn detail(&self, person: &str, id: &str) -> Result<Option<SkillDetail>> {
        let sql = format!(
            "SELECT v.id AS version_id, v.body, v.frontmatter \
             {FROM} WHERE k.id = $2 AND {visible}",
            visible = filed_where("k", 1, Level::Viewer),
        );
        let Some(row) = sqlx::query(&sql)
            .bind(person)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
        else {
            return Ok(None);
        };
        let version_id: Option<String> = row.try_get("version_id").ok().flatten();
        let Some(version_id) = version_id else {
            return Ok(None);
        };
        Ok(Some(SkillDetail {
            body: row.get("body"),
            frontmatter: row.get("frontmatter"),
            files: self.files_of(&version_id).await?,
        }))
    }

    /// What is in one version, without the bytes.
    pub async fn files_of(&self, version_id: &str) -> Result<Vec<SkillFile>> {
        Ok(sqlx::query(
            "SELECT f.path, f.size, f.executable, \
                    (SELECT count(*) FROM skill_files o WHERE o.hash = f.hash) > 1 AS shared \
               FROM skill_files f WHERE f.version_id = $1 ORDER BY f.path",
        )
        .bind(version_id)
        .fetch_all(&self.pool)
        .await
        .context("reading a bundle")?
        .into_iter()
        .map(|r| SkillFile {
            path: r.get("path"),
            size: r.get("size"),
            executable: r.get("executable"),
            shared: r.get("shared"),
        })
        .collect())
    }

    /// Every version of a skill, newest first.
    pub async fn versions(&self, person: &str, id: &str) -> Result<Vec<SkillVersion>> {
        let sql = format!(
            "SELECT v.id, v.version, v.notes, v.tokens, v.files, v.bytes, v.created_at, \
                    u.name AS author, \
                    (SELECT count(*) FROM skill_pins p WHERE p.version_id = v.id) AS pinned_by \
               FROM skill_versions v \
               JOIN skills k ON k.id = v.skill_id \
               LEFT JOIN principals u ON u.id = v.created_by \
              WHERE k.id = $2 AND {visible} ORDER BY v.version DESC",
            visible = filed_where("k", 1, Level::Viewer),
        );
        Ok(sqlx::query(&sql)
            .bind(person)
            .bind(id)
            .fetch_all(&self.pool)
            .await
            .context("reading a skill's versions")?
            .into_iter()
            .map(|r| SkillVersion {
                id: SkillVersionId::from_stored(r.get::<String, _>("id")),
                version: r.get("version"),
                notes: r.try_get("notes").ok().flatten(),
                tokens: r.get("tokens"),
                files: r.get("files"),
                bytes: r.get("bytes"),
                author: r.try_get("author").ok().flatten(),
                created_at: r.get("created_at"),
                pinned_by: r.get("pinned_by"),
            })
            .collect())
    }

    /// Write a bundle as a new skill in somebody's own space.
    pub async fn create(
        &self,
        org: &str,
        person: &str,
        person_slug: &str,
        new: &NewSkill,
    ) -> Result<SkillId> {
        let id = SkillId::new();
        // A discriminator, because two people may well both have a
        // `code-review` and the unique index on `path` would refuse the second.
        let slug = format!(
            "{}_{}",
            slug_of(&new.name),
            &id.as_str()[id.as_str().len().saturating_sub(8)..]
        );
        let path = format!("u.{person_slug}.{slug}");

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO skills (id, org_id, path, created_by, name, slug, description) \
             VALUES ($1, $2, $3::ltree, $4, $5, $6, $7)",
        )
        .bind(id.as_str())
        .bind(org)
        .bind(&path)
        .bind(person)
        .bind(&new.name)
        .bind(&slug)
        .bind(&new.description)
        .execute(&mut *tx)
        .await
        .context("writing a skill")?;

        write_version(&mut tx, id.as_str(), person, new, 1).await?;
        tx.commit().await?;
        Ok(id)
    }

    /// Add a version to a skill that already exists.
    pub async fn add_version(&self, id: &str, person: &str, new: &NewSkill) -> Result<i32> {
        let mut tx = self.pool.begin().await?;
        let last: Option<i32> =
            sqlx::query_scalar("SELECT max(version) FROM skill_versions WHERE skill_id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        let version = last.unwrap_or(0) + 1;
        write_version(&mut tx, id, person, new, version).await?;
        // The two editable fields follow the version that introduced them.
        sqlx::query(
            "UPDATE skills SET name = $2, description = $3, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(&new.name)
        .bind(&new.description)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(version)
    }

    /// Rename a skill, or rewrite what it says it is for.
    ///
    /// The only two fields that change without a new version. Everything else
    /// about a skill is its bundle, and a bundle changes by being dropped
    /// again.
    pub async fn rename(&self, id: &str, name: &str, description: &str) -> Result<()> {
        sqlx::query(
            "UPDATE skills SET name = $2, description = $3, updated_at = now() WHERE id = $1",
        )
        .bind(id)
        .bind(name)
        .bind(description)
        .execute(&self.pool)
        .await
        .context("renaming a skill")?;
        // The listing entry just changed size, so what it costs did too.
        sqlx::query(
            "UPDATE skill_versions SET tokens = $2 \
              WHERE id = (SELECT current_version_id FROM skills WHERE id = $1)",
        )
        .bind(id)
        .bind(tokens_for(name, description))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM skills WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting a skill")?;
        // Bytes nothing points at any more. Cheap, and it runs where the
        // deletion happened rather than on a timer nobody remembers exists.
        sqlx::query(
            "DELETE FROM blobs b WHERE NOT EXISTS \
               (SELECT 1 FROM skill_files f WHERE f.hash = b.hash)",
        )
        .execute(&self.pool)
        .await
        .ok();
        Ok(())
    }

    // ── defaults ────────────────────────────────────────────────────────

    /// Turn a default on or off. A null repository means every workspace.
    pub async fn set_default(
        &self,
        person: &str,
        skill: &str,
        repo: Option<&str>,
        on: bool,
    ) -> Result<()> {
        if on {
            sqlx::query(
                "INSERT INTO skill_defaults (user_id, repo_id, skill_id) VALUES ($1, $2, $3) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(person)
            .bind(repo)
            .bind(skill)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query(
                "DELETE FROM skill_defaults \
                  WHERE user_id = $1 AND skill_id = $3 \
                    AND coalesce(repo_id, '') = coalesce($2, '')",
            )
            .bind(person)
            .bind(repo)
            .bind(skill)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    /// Which skills would be ticked for somebody starting work on these
    /// repositories: the union of their defaults, plus their always-on set.
    pub async fn defaults_for(&self, person: &str, repos: &[String]) -> Result<Vec<String>> {
        Ok(sqlx::query_scalar(
            "SELECT DISTINCT sd.skill_id FROM skill_defaults sd \
              WHERE sd.user_id = $1 AND (sd.repo_id IS NULL OR sd.repo_id = ANY($2))",
        )
        .bind(person)
        .bind(repos)
        .fetch_all(&self.pool)
        .await
        .context("reading somebody's default skills")?)
    }

    // ── what a session is running ───────────────────────────────────────

    /// The skills a session is reading, in the version it pinned.
    pub async fn of_session(&self, session: &str) -> Result<Vec<String>> {
        Ok(
            sqlx::query_scalar("SELECT skill_id FROM skill_pins WHERE session_id = $1")
                .bind(session)
                .fetch_all(&self.pool)
                .await
                .context("reading a session's skills")?,
        )
    }

    /// The bundles a session is reading, as the worker will write them.
    ///
    /// Read from the version each one *pinned*, not from whatever is current:
    /// a version made after this conversation started must not change what it
    /// is reading. That is the whole point of `skill_pins`.
    ///
    /// The folder on disk is the skill's `name`, because that is what the
    /// agent answers to and what the standard says a folder is called — not
    /// the slug, which exists so two skills of one name can be told apart in
    /// a database.
    pub async fn bundles_for_session(&self, session: &str) -> Result<Vec<ft_proto::SkillBundle>> {
        let rows = sqlx::query(
            "SELECT k.name, f.path, f.executable, b.bytes \
               FROM skill_pins p \
               JOIN skills k ON k.id = p.skill_id \
               JOIN skill_files f ON f.version_id = p.version_id \
               JOIN blobs b ON b.hash = f.hash \
              WHERE p.session_id = $1 \
              ORDER BY k.name, f.path",
        )
        .bind(session)
        .fetch_all(&self.pool)
        .await
        .context("reading a session's skill bundles")?;

        let mut out: Vec<ft_proto::SkillBundle> = Vec::new();
        for row in rows {
            let name: String = row.get("name");
            let file = ft_proto::SkillFile {
                path: row.get("path"),
                contents: ft_proto::encode(&row.get::<Vec<u8>, _>("bytes")),
                executable: row.get("executable"),
            };
            match out.last_mut() {
                Some(bundle) if bundle.name == name => bundle.files.push(file),
                _ => out.push(ft_proto::SkillBundle {
                    name,
                    files: vec![file],
                }),
            }
        }
        Ok(out)
    }

    /// Replace what a session is reading with exactly this set.
    ///
    /// The whole selection rather than a delta: a delta that arrives out of
    /// order leaves a session holding a set nobody chose. Each one pins the
    /// version that is current *now*, so a version made later does not change
    /// what this conversation reads.
    pub async fn set_for_session(
        &self,
        session: &str,
        person: &str,
        skills: &[String],
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM skill_pins WHERE session_id = $1 AND NOT (skill_id = ANY($2))")
            .bind(session)
            .bind(skills)
            .execute(&mut *tx)
            .await?;
        for skill in skills {
            sqlx::query(
                "INSERT INTO skill_pins (session_id, skill_id, version_id, added_by) \
                 SELECT $1, k.id, k.current_version_id, $3 FROM skills k \
                  WHERE k.id = $2 AND k.current_version_id IS NOT NULL \
                 ON CONFLICT (session_id, skill_id) DO NOTHING",
            )
            .bind(session)
            .bind(skill)
            .bind(person)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}

/// Write one version and its files, and point the skill at it.
async fn write_version(
    tx: &mut Transaction<'_, Postgres>,
    skill: &str,
    person: &str,
    new: &NewSkill,
    version: i32,
) -> Result<()> {
    let vid = SkillVersionId::new();
    let paths: Vec<String> = new.files.iter().map(|f| f.path.clone()).collect();
    let mut total: i64 = 0;

    sqlx::query(
        "INSERT INTO skill_versions \
           (id, skill_id, version, frontmatter, body, notes, tokens, files, bytes, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)",
    )
    .bind(vid.as_str())
    .bind(skill)
    .bind(version)
    .bind(&new.frontmatter)
    .bind(&new.body)
    .bind(&new.notes)
    .bind(tokens_for(&new.name, &new.description))
    .bind(paths.len() as i32)
    .bind(person)
    .execute(&mut **tx)
    .await
    .context("writing a skill version")?;

    for f in &new.files {
        let bytes = ft_proto::decode(&f.contents)
            .with_context(|| format!("{} did not arrive intact", f.path))?;
        let hash = format!("{:x}", Sha256::digest(&bytes));
        total += bytes.len() as i64;

        // The bytes once, under a hash of themselves. A file that has not
        // changed between two versions is one row here, not two.
        sqlx::query(
            "INSERT INTO blobs (hash, bytes, size) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(&hash)
        .bind(&bytes)
        .bind(bytes.len() as i64)
        .execute(&mut **tx)
        .await
        .context("storing a file")?;

        sqlx::query(
            "INSERT INTO skill_files (version_id, path, hash, executable, size) \
             VALUES ($1, $2, $3, $4, $5)",
        )
        .bind(vid.as_str())
        .bind(&f.path)
        .bind(&hash)
        .bind(f.executable)
        .bind(bytes.len() as i64)
        .execute(&mut **tx)
        .await
        .context("recording a file")?;
    }

    sqlx::query("UPDATE skill_versions SET bytes = $2 WHERE id = $1")
        .bind(vid.as_str())
        .bind(total)
        .execute(&mut **tx)
        .await?;

    sqlx::query("UPDATE skills SET current_version_id = $2, updated_at = now() WHERE id = $1")
        .bind(skill)
        .bind(vid.as_str())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Stands in for "there is something under `scripts/`", which the query
/// answered so that a list of three hundred does not read three hundred
/// bundles to find out.
static SCRIPTS: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| "scripts/".to_string());

/// One row of a skills query.
///
/// Columns the query may not have selected are read with `try_get`. A reader
/// that panicked over a missing column once took down every request that
/// reached it.
fn read_skill(r: sqlx::postgres::PgRow) -> Result<Skill> {
    let frontmatter: serde_json::Value =
        r.try_get("frontmatter").unwrap_or(serde_json::Value::Null);
    let body: String = r.try_get("body").unwrap_or_default();
    // Whether the bundle ships anything under `scripts/`, answered by the
    // query rather than by loading every path of every skill in the list.
    let scripts: bool = r.try_get("has_scripts").unwrap_or(false);
    let name: String = r.get("name");
    let description: String = r.get("description");
    let version_id: Option<String> = r.try_get("current_version_id").ok().flatten();

    Ok(Skill {
        id: SkillId::from_stored(r.get::<String, _>("id")),
        path: ft_core::ResourcePath::from_stored(r.get::<String, _>("path")).to_string(),
        slug: r.get("slug"),
        version: r.try_get("version").unwrap_or(0),
        version_id: SkillVersionId::from_stored(version_id.unwrap_or_default()),
        tokens: r
            .try_get("tokens")
            .unwrap_or_else(|_| tokens_for(&name, &description)),
        files: r.try_get("files").unwrap_or(0),
        bytes: r.try_get("bytes").unwrap_or(0),
        risk: risk_of(
            &frontmatter,
            &body,
            if scripts {
                std::slice::from_ref(&SCRIPTS)
            } else {
                &[]
            },
        ),
        author: r.try_get("author").ok().flatten(),
        updated_at: r.get("updated_at"),
        may_write: r.try_get("may_write").unwrap_or(false),
        default_in: r.try_get("default_in").unwrap_or_default(),
        always_on: r.try_get("always_on").unwrap_or(false),
        name,
        description,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_follows_the_standard() {
        assert!(check_name("rust-review").is_ok());
        assert!(check_name("").is_err());
        assert!(check_name("Rust-Review").is_err());
        assert!(check_name("rust_review").is_err());
        assert!(check_name("-review").is_err());
        assert!(check_name("review-").is_err());
        // Reserved by the people who wrote the standard.
        assert!(check_name("claude-helper").is_err());
        assert!(check_name("anthropic-docs").is_err());
    }

    /// The bug this caught: `nae: webapp-testing` left no `name` at all, the
    /// client filled one in from the folder, and a malformed bundle was
    /// accepted under a name its own file never used.
    #[test]
    fn a_misspelled_key_is_not_a_name() {
        let bundle = |fm: serde_json::Value| NewSkill {
            name: "webapp-testing".into(),
            description: "Toolkit for testing local web applications.".into(),
            frontmatter: fm,
            body: "do the thing".into(),
            files: vec![IncomingFile {
                path: "SKILL.md".into(),
                contents: ft_proto::encode(b"---\n---\n"),
                executable: false,
            }],
            notes: None,
        };

        let refused = check(&bundle(serde_json::json!({
            "nae": "webapp-testing",
            "description": "Toolkit for testing local web applications.",
        })))
        .unwrap_err();
        assert!(refused.0.contains("`nae:`"), "{}", refused.0);

        // Renaming in the review is legitimate: the file declares a name, and
        // the one being saved differs on purpose.
        assert!(check(&bundle(serde_json::json!({
            "name": "code-review",
            "description": "Toolkit for testing local web applications.",
        })))
        .is_ok());
    }

    #[test]
    fn a_path_cannot_climb_out_of_the_bundle() {
        assert!(check_path("scripts/run.sh").is_ok());
        assert!(check_path("/etc/passwd").is_err());
        assert!(check_path("../outside").is_err());
        assert!(check_path("scripts/../../x").is_err());
        assert!(check_path("").is_err());
    }

    #[test]
    fn risk_is_read_from_the_bundle() {
        let fm = serde_json::json!({"allowed-tools": "Bash(git *)", "hooks": {}});
        let got = risk_of(&fm, "run !`whoami` first", &["scripts/x.sh".into()]);
        assert_eq!(got, vec!["shell", "tools", "hooks", "scripts"]);
        assert!(risk_of(&serde_json::json!({}), "just prose", &[]).is_empty());
    }

    #[test]
    fn a_listing_entry_is_counted_in_tokens() {
        let n = tokens_for(
            "rust-review",
            "Review Rust for the conventions this codebase uses.",
        );
        // Tokens, not characters: the entry is ~75 characters.
        assert!(n > 5 && n < 40, "{n} tokens is not a plausible count");
    }
}
