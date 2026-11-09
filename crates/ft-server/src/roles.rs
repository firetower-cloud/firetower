//! Roles: saved kinds of agent a lead can start by name.
//!
//! A role is **Placed** — see `docs/paths-and-ownership.md`. It has a path, it
//! can be filed into a directory and shared, and `access::filed_where` is the
//! only thing that decides who may see one. Nothing here invents a second way
//! to answer that; this module owns only what is specific to a role — the
//! fields a lead reads to choose it, and the ones the control plane applies
//! when a spawn names it.
//!
//! Smaller than a skill: no files, no versions, no bytes. A row and the text
//! on it.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use utoipa::ToSchema;

use crate::access::{filed_where, Level};

/// "May this person move this role" as a SQL predicate: it is in their own
/// space, or they administer the directory it is in, or they administer the
/// organisation. The same answer `skills.rs` computes for a skill; kept local
/// rather than shared because it is three lines and a shared one would be one
/// more thing to find.
fn shareable(alias: &str, person: usize) -> String {
    let admin = Level::Admin.rank();
    format!(
        "(EXISTS (SELECT 1 FROM principals me \
                   WHERE me.id = ${person} AND {alias}.path <@ ('u.' || me.slug)::ltree) \
          OR EXISTS (SELECT 1 FROM directories dd \
                       JOIN directory_access da ON da.directory_id = dd.id \
                      WHERE da.user_id = ${person} AND da.rank >= {admin} \
                        AND {alias}.path <@ ('d.' || dd.slug)::ltree) \
          OR (subpath({alias}.path, 0, 1) = 'd'::ltree \
              AND EXISTS (SELECT 1 FROM users uu WHERE uu.id = ${person} AND uu.role = 'admin')))"
    )
}

/// Where a role's child runs. A profile pins one of the two — there is no
/// "let the lead choose" in this version: a profile sets its own placement,
/// machine and agent, so the Manager never makes a resource call.
pub const PLACEMENT: [&str; 2] = ["here", "new"];

/// A role, as the interface and the spawn tool read it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub path: String,
    pub name: String,
    /// What it does and when to reach for it — the one line a lead reads to
    /// decide whether to hand it work, the way a skill's `description` is read.
    pub does: String,
    /// `lead` (let the lead choose) | `here` | `new`.
    pub placement: String,
    /// Which agent runs it, or absent to let the lead choose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The machine its own workspace runs on, by host id, or absent to let the
    /// lead choose. Meaningful only when `placement` is `new`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
    /// The subscription it runs its agent on, by account id. Absent means the
    /// owner's default for the engine resolves at launch — which is what an
    /// agent-authored profile gets, since it cannot see account ids.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// How it runs its agent — model, effort, mode, sandbox. Each unset falls
    /// back to the engine's default at launch, so a profile need not pin all.
    pub settings: ft_core::controls::Preferred,
    /// Composed into the child's instructions.
    pub instructions: String,
    /// A Manager (true) gets the spawn tool and may hand work to any profile it
    /// can see; an Operator (false) does the work and reports back.
    pub can_delegate: bool,
    /// The subagents a Manager may delegate to, by id. Empty means any the owner
    /// can see — scope is opt-in. Everything off the list is invisible to it.
    pub delegate_scope: Vec<String>,
    /// Include the owner's always-on skills — their `skill_defaults` rows with
    /// no repository against them. On unless somebody turns it off.
    pub include_always_on: bool,
    /// Include the owner's defaults for the repositories the child checks out.
    /// On unless somebody turns it off.
    pub include_repo_defaults: bool,
    /// Skills this profile loads whatever the two switches say, by id.
    ///
    /// **A tick grants.** It adds a skill on top of the two sources above
    /// rather than keeping one they already supplied, so an empty list narrows
    /// nothing and turning a switch off is the only way to load less. See
    /// [`skills_for`].
    pub skill_scope: Vec<String>,
    /// Whether the person asking may edit or delete it.
    pub may_write: bool,
    /// Whether they may move it into a directory, or out of one.
    pub may_share: bool,
    /// Whether this person starts a new workspace as this profile by default.
    /// At most one of theirs is, so setting another unsets this one.
    pub is_default: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// What the API accepts to create or change a role.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewRole {
    pub name: String,
    pub does: String,
    /// Required: "here" or "new". Empty when omitted, so `check` says so.
    #[serde(default)]
    pub placement: String,
    #[serde(default)]
    pub agent: Option<String>,
    /// The machine its own workspace runs on, by host id. Required when
    /// placement is `new`.
    #[serde(default)]
    pub machine: Option<String>,
    /// The subscription its agent runs on, by account id. Omit to run on the
    /// owner's default for the engine.
    #[serde(default)]
    pub account: Option<String>,
    /// How it runs its agent — model, effort, mode, sandbox. Each optional.
    #[serde(default)]
    pub settings: ft_core::controls::Preferred,
    #[serde(default)]
    pub instructions: String,
    /// Whether it is a Manager. Defaults to an Operator.
    #[serde(default)]
    pub can_delegate: bool,
    /// The subagents it may delegate to, by id. Empty = any the owner can see.
    #[serde(default)]
    pub delegate_scope: Vec<String>,
    /// Include the owner's always-on skills. **Absent means leave it as it
    /// is** — on an update, whatever is stored; on a create, on.
    ///
    /// `Option` rather than `bool` because the rest of this struct is a
    /// whole-object write and a client can leave a field out. A `bool` has to
    /// read that omission as something, and both readings edit a profile
    /// nobody asked to edit: `false` switches inheritance off on every profile
    /// an older client saves, and `true` — which this was — turns a switch
    /// somebody deliberately off back on. Keeping no opinion is the only
    /// answer that leaves a profile alone.
    #[serde(default)]
    pub include_always_on: Option<bool>,
    /// Include the owner's defaults for the repositories the child checks out.
    /// **Absent means leave it as it is** — see above.
    #[serde(default)]
    pub include_repo_defaults: Option<bool>,
    /// The skills it loads on top of those two, by id. Empty = just those two.
    #[serde(default)]
    pub skill_scope: Vec<String>,
    /// A directory to file it in, by id, so a teammate can reach it. Omit for
    /// your own space. Only honoured at creation; move it later with sharing.
    #[serde(default)]
    pub directory: Option<String>,
}

/// What an inheritance switch is when a *new* profile does not state one: on.
///
/// Named rather than written `true` at the bind, because it has to agree with
/// `include_always_on boolean not null default true` in the
/// `profile_skill_sources` migration — a new profile loading the owner's usual
/// set rather than nothing is the whole of that migration's compatibility
/// story, and this is the one place the server repeats it.
const INHERITS: bool = true;

/// Why a role was refused, in a sentence somebody can act on.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Everything a well-formed role must be.
///
/// Shape only — everything answerable without the database. The one field that
/// needs it is `skill_scope`, whose ids have to be skills the person saving can
/// actually see; that is `api::roles::check_skills`, called beside this on both
/// write paths. Said here because this is where somebody looks to find out what
/// is validated, and the answer "not here" is only useful with the "over there".
pub fn check(new: &NewRole) -> Result<(), Refused> {
    let name = new.name.trim();
    if name.is_empty() {
        return Err(Refused("a role needs a name".into()));
    }
    if name.chars().count() > 64 {
        return Err(Refused("a role's name is at most 64 characters".into()));
    }
    if new.does.trim().is_empty() {
        return Err(Refused("a role needs a line saying what it does".into()));
    }
    // A profile fully specifies where and what it runs. No "let the lead
    // choose": the safest first version is the one where the Manager inherits a
    // fixed shape rather than deciding the machine, the engine or the placement.
    if !PLACEMENT.contains(&new.placement.as_str()) {
        return Err(Refused(
            "placement is \"here\" (the lead's workspace) or \"new\" (its own)".into(),
        ));
    }
    match &new.agent {
        Some(agent) if ft_core::Agent::from_name(agent).is_some() => {}
        Some(agent) => return Err(Refused(format!("{agent} is not an agent Firetower runs"))),
        None => {
            return Err(Refused(
                "a profile sets the agent it runs on — pick one rather than leaving it open".into(),
            ))
        }
    }
    if new.placement == "new"
        && new
            .machine
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err(Refused(
            "a profile whose child gets its own workspace sets the machine it runs on".into(),
        ));
    }
    Ok(())
}

/// Which skills a profile loads: the union of its three additive sources.
///
/// **Pure, and deliberately apart from the queries that answer it.** Every
/// path that starts a child funnels through here — a person starting a
/// workspace as a profile, a lead delegating into its own workspace, a lead
/// delegating into a new one — so the three cases worth being sure about are
/// unit tests over a function rather than fixtures over a database: a source
/// switched off, a tick that duplicates one of them, and a tick naming a skill
/// this person cannot reach.
///
/// `always_on` and `repo_defaults` belong to **whoever is starting the run**,
/// not to whoever wrote the profile. `skill_defaults` is keyed on `user_id`, so
/// a profile shared through a directory resolves per viewer — which is what
/// "include the repository's defaults" means when the repository is not yours.
///
/// `reachable` is that same person's visible library, and **all three sources
/// are filtered through it**. Under the old semantics the list could only
/// subtract, so it needed no authorisation; a tick now introduces a skill, and
/// a skill is executable (`docs/skills.md` §8). Without this a Writer on a
/// shared profile could tick something only they can see and have a colleague
/// materialise and run it on their own worker under their own credentials.
/// `set_for_session` checks the same thing again at the moment it pins, which
/// is the chokepoint; this is the half that can say so in a test.
///
/// Order is stable — always-on, then the repository's, then the list — and a
/// skill in two sources is pinned once, so a tick for something a switch
/// already supplied costs nothing.
pub fn skills_for(
    role: &Role,
    always_on: &[String],
    repo_defaults: &[String],
    reachable: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (include, ids) in [
        (role.include_always_on, always_on),
        (role.include_repo_defaults, repo_defaults),
        // The list is not switchable: it is the profile's own decision, and
        // "always include these" is what it says on the screen.
        (true, role.skill_scope.as_slice()),
    ] {
        if !include {
            continue;
        }
        for id in ids {
            if reachable.contains(id) && !out.contains(id) {
                out.push(id.clone());
            }
        }
    }
    out
}

/// [`skills_for`], with its three lists read for one person and one set of
/// repositories.
///
/// The queries live here and the union lives there, which is the whole reason
/// the union is testable. Nothing is narrowed on the way: both switches are
/// honoured in exactly one place, so a skipped read can never disagree with the
/// field that decides. Two indexed reads per repository is not what this costs.
///
/// `person` is whoever is starting the run, never whoever wrote the profile —
/// see [`skills_for`].
///
/// **`repos` is `RepoId`, not a slug, and that is the whole reason it is typed.**
/// `skill_defaults.repo_id` is an id; a slug bound to it matches nothing, so
/// `include_repo_defaults` reads on, counts in the editor, and delivers
/// nothing. That is what the second-agent path did when this took
/// `&[String]` and was handed `WorkspacePlace::repo` — the first checkout's
/// *caption*. A `Vec<String>` will hold either happily; this will not.
pub async fn skills_at_spawn(
    skills: &crate::skills::Skills,
    role: &Role,
    person: &str,
    repos: &[ft_core::RepoId],
) -> Result<Vec<String>> {
    let always_on = skills
        .always_on(person)
        .await
        .context("reading somebody's always-on skills for a profile")?;
    let mut repo_defaults: Vec<String> = Vec::new();
    for repo in repos {
        repo_defaults.extend(
            skills
                .defaults_in(person, repo)
                .await
                .context("reading a repository's default skills for a profile")?,
        );
    }
    let reachable: std::collections::HashSet<String> = skills
        .visible(person, Level::Viewer)
        .await
        .context("reading the skills somebody can reach for a profile")?
        .into_iter()
        .map(|s| s.id.as_str().to_string())
        .collect();
    Ok(skills_for(role, &always_on, &repo_defaults, &reachable))
}

/// `<name>_<tail>`, so two people's `reviewer` roles do not collide on the
/// path's own uniqueness. The same shape a skill's slug has.
fn slug_of(name: &str, id: &str) -> String {
    let base: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "role".into() } else { base };
    format!("{base}_{}", &id[id.len().saturating_sub(8)..])
}

/// An optional string with the blank treated as nothing, for a nullable column.
fn nonblank(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|v| !v.trim().is_empty())
}

const FIELDS: &str = "r.id, r.path::text AS path, r.name, r.does, \
                      r.placement, r.agent, r.host_id, r.agent_account_id, \
                      r.pref_model, r.pref_effort, r.pref_mode, r.pref_sandbox, r.instructions, \
                      r.can_delegate, r.delegate_scope, r.skill_scope, \
                      r.include_always_on, r.include_repo_defaults, \
                      r.created_at, r.updated_at";

fn read(row: sqlx::postgres::PgRow) -> Result<Role> {
    Ok(Role {
        id: row.get("id"),
        // Slashes on the wire, dots in the database — the same conversion every
        // other Placed kind makes, so the sharing sheet reads a role's path the
        // way it reads a skill's rather than seeing `d.backend.x` and giving up.
        path: ft_core::ResourcePath::from_stored(row.get::<String, _>("path")).to_string(),
        name: row.get("name"),
        does: row.get("does"),
        placement: row.get("placement"),
        agent: row.get("agent"),
        machine: row.get("host_id"),
        account: row.get("agent_account_id"),
        settings: ft_core::controls::Preferred {
            model: row.get("pref_model"),
            effort: row.get("pref_effort"),
            mode: row.get("pref_mode"),
            sandbox: row.get("pref_sandbox"),
        },
        instructions: row.get("instructions"),
        can_delegate: row.get("can_delegate"),
        delegate_scope: row.get("delegate_scope"),
        include_always_on: row.get("include_always_on"),
        include_repo_defaults: row.get("include_repo_defaults"),
        skill_scope: row.get("skill_scope"),
        may_write: row.get("may_write"),
        may_share: row.get("may_share"),
        is_default: row.try_get("is_default").unwrap_or(false),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

#[derive(Clone)]
pub struct Roles {
    pool: PgPool,
}

impl Roles {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Every role this person may see, at the given level or better.
    pub async fn visible(&self, person: &str, at_least: Level) -> Result<Vec<Role>> {
        let sql = format!(
            "SELECT {FIELDS}, {writable} AS may_write, {shareable} AS may_share, \
                    EXISTS (SELECT 1 FROM role_defaults d \
                             WHERE d.role_id = r.id AND d.user_id = $1) AS is_default \
               FROM roles r WHERE {visible} ORDER BY r.name",
            visible = filed_where("r", 1, at_least),
            writable = filed_where("r", 1, Level::Writer),
            shareable = shareable("r", 1),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .fetch_all(&self.pool)
            .await
            .context("reading the roles somebody can see")?;
        rows.into_iter().map(read).collect()
    }

    /// One role, if this person may see it.
    pub async fn one(&self, person: &str, id: &str, at_least: Level) -> Result<Option<Role>> {
        let sql = format!(
            "SELECT {FIELDS}, {writable} AS may_write, {shareable} AS may_share, \
                    EXISTS (SELECT 1 FROM role_defaults d \
                             WHERE d.role_id = r.id AND d.user_id = $1) AS is_default \
               FROM roles r WHERE r.id = $2 AND {visible}",
            visible = filed_where("r", 1, at_least),
            writable = filed_where("r", 1, Level::Writer),
            shareable = shareable("r", 1),
        );
        let row = sqlx::query(&sql)
            .bind(person)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a role")?;
        row.map(read).transpose()
    }

    /// Make this the person's default profile for a new workspace, or clear it.
    ///
    /// One per person — `user_id` is the key, so setting another replaces it,
    /// which is how "only one" holds without a second write to unset the old.
    /// They must be able to see the role to default to it.
    pub async fn set_default(&self, person: &str, id: &str, on: bool) -> Result<bool> {
        if self.one(person, id, Level::Viewer).await?.is_none() {
            return Ok(false);
        }
        if on {
            sqlx::query(
                "INSERT INTO role_defaults (user_id, role_id) VALUES ($1, $2) \
                 ON CONFLICT (user_id) DO UPDATE SET role_id = EXCLUDED.role_id, at = now()",
            )
            .bind(person)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("setting a default profile")?;
        } else {
            sqlx::query("DELETE FROM role_defaults WHERE user_id = $1 AND role_id = $2")
                .bind(person)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("clearing a default profile")?;
        }
        Ok(true)
    }

    /// The role of this name this person may use, if there is one.
    ///
    /// By name because that is what a lead says — `role: "reviewer"` — and the
    /// name a person reads is the handle they expect to spawn with. Narrowed
    /// to what they may see, so a lead can never name a role filed somewhere
    /// its owner cannot reach.
    pub async fn by_name(&self, person: &str, name: &str) -> Result<Option<Role>> {
        let wanted = name.trim();
        Ok(self
            .visible(person, Level::Viewer)
            .await?
            .into_iter()
            .find(|r| r.name.eq_ignore_ascii_case(wanted)))
    }

    /// File a new role in this person's own space.
    pub async fn create(
        &self,
        org: &str,
        person: &str,
        person_slug: &str,
        new: &NewRole,
    ) -> Result<ft_core::RoleId> {
        let id = ft_core::RoleId::new();
        let slug = slug_of(&new.name, id.as_str());
        let path = format!("u.{person_slug}.{slug}");
        sqlx::query(
            "INSERT INTO roles \
               (id, org_id, path, created_by, name, slug, does, \
                placement, agent, host_id, agent_account_id, instructions, can_delegate, \
                delegate_scope, skill_scope, include_always_on, include_repo_defaults, \
                pref_model, pref_effort, pref_mode, pref_sandbox) \
             VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, \
                     $16, $17, $18, $19, $20, $21)",
        )
        .bind(id.as_str())
        .bind(org)
        .bind(&path)
        .bind(person)
        .bind(new.name.trim())
        .bind(&slug)
        .bind(new.does.trim())
        .bind(&new.placement)
        .bind(&new.agent)
        .bind(new.machine.as_deref().filter(|m| !m.is_empty()))
        .bind(new.account.as_deref().filter(|a| !a.is_empty()))
        .bind(&new.instructions)
        .bind(new.can_delegate)
        .bind(&new.delegate_scope)
        .bind(&new.skill_scope)
        // Nothing to leave alone on a row that does not exist yet, so an
        // absent switch resolves to the column's default.
        .bind(new.include_always_on.unwrap_or(INHERITS))
        .bind(new.include_repo_defaults.unwrap_or(INHERITS))
        .bind(nonblank(&new.settings.model))
        .bind(nonblank(&new.settings.effort))
        .bind(nonblank(&new.settings.mode))
        .bind(nonblank(&new.settings.sandbox))
        .execute(&self.pool)
        .await
        .context("writing a role")?;
        Ok(id)
    }

    /// Change a role's fields. The person must be able to work in where it is filed.
    ///
    /// Whole-object: every column here is replaced by what was sent, which is
    /// why `toDraft` on the desktop side carries all of them. The two
    /// exceptions are the inheritance switches, which are `COALESCE`d onto
    /// what is already stored — a caller that says nothing about them changes
    /// nothing about them. See [`NewRole::include_always_on`] for why those
    /// two cannot take the whole-object rule.
    pub async fn update(&self, person: &str, id: &str, new: &NewRole) -> Result<bool> {
        // Writer decides it, through the one predicate — the same gate the
        // interface drew `may_write` from.
        let may = self.one(person, id, Level::Writer).await?.is_some();
        if !may {
            return Ok(false);
        }
        sqlx::query(
            "UPDATE roles SET name=$2, does=$3, \
               placement=$4, agent=$5, host_id=$6, agent_account_id=$7, instructions=$8, \
               can_delegate=$9, delegate_scope=$10, skill_scope=$11, \
               include_always_on=COALESCE($12, include_always_on), \
               include_repo_defaults=COALESCE($13, include_repo_defaults), \
               pref_model=$14, pref_effort=$15, pref_mode=$16, pref_sandbox=$17, \
               updated_at=now() WHERE id=$1",
        )
        .bind(id)
        .bind(new.name.trim())
        .bind(new.does.trim())
        .bind(&new.placement)
        .bind(&new.agent)
        .bind(new.machine.as_deref().filter(|m| !m.is_empty()))
        .bind(new.account.as_deref().filter(|a| !a.is_empty()))
        .bind(&new.instructions)
        .bind(new.can_delegate)
        .bind(&new.delegate_scope)
        .bind(&new.skill_scope)
        .bind(new.include_always_on)
        .bind(new.include_repo_defaults)
        .bind(nonblank(&new.settings.model))
        .bind(nonblank(&new.settings.effort))
        .bind(nonblank(&new.settings.mode))
        .bind(nonblank(&new.settings.sandbox))
        .execute(&self.pool)
        .await
        .context("updating a role")?;
        Ok(true)
    }

    /// Delete a role. Writer on where it lives, like changing it.
    pub async fn delete(&self, person: &str, id: &str) -> Result<bool> {
        if self.one(person, id, Level::Writer).await?.is_none() {
            return Ok(false);
        }
        sqlx::query("DELETE FROM roles WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting a role")?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn new(name: &str) -> NewRole {
        NewRole {
            name: name.into(),
            does: "reads a branch and reports problems; reach for it after a developer hands back, not for a one-line fix".into(),
            placement: "here".into(),
            agent: None,
            machine: None,
            account: None,
            instructions: "Report findings as path:line.".into(),
            can_delegate: false,
            delegate_scope: vec![],
            include_always_on: Some(true),
            include_repo_defaults: Some(true),
            skill_scope: vec![],
            settings: Default::default(),
            directory: None,
        }
    }

    /// A profile with both sources on and nothing named — every row that
    /// exists today, and what `BLANK` and `create_profile` still mint.
    fn profile() -> Role {
        Role {
            id: "role_x".into(),
            path: "u/kevin/reviewer".into(),
            name: "reviewer".into(),
            does: "reviews a branch".into(),
            placement: "here".into(),
            agent: Some("ClaudeCode".into()),
            machine: None,
            account: None,
            settings: Default::default(),
            instructions: String::new(),
            can_delegate: false,
            delegate_scope: vec![],
            include_always_on: true,
            include_repo_defaults: true,
            skill_scope: vec![],
            may_write: true,
            may_share: true,
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    fn reachable(names: &[&str]) -> std::collections::HashSet<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    /// Criterion 11: an existing profile is unchanged by the migration.
    ///
    /// Both switches on and an empty list has to resolve to exactly what a
    /// profile is handed today — the owner's always-on set plus their defaults
    /// for the repositories the child checks out. This is the whole of why the
    /// columns default `true` and there is no backfill.
    #[test]
    fn both_sources_on_and_nothing_named_is_what_a_profile_already_loads() {
        let got = skills_for(
            &profile(),
            &ids(&["dataviz", "treg"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "treg", "rust-review", "unused"]),
        );
        assert_eq!(got, ids(&["dataviz", "treg", "rust-review"]));
    }

    /// Criteria 3 and 4: a switch removes exactly its own source, and nothing
    /// beside it.
    #[test]
    fn a_switch_removes_its_own_source_and_only_that() {
        let seen = reachable(&["dataviz", "treg", "rust-review"]);

        let mut no_always = profile();
        no_always.include_always_on = false;
        assert_eq!(
            skills_for(
                &no_always,
                &ids(&["dataviz", "treg"]),
                &ids(&["rust-review"]),
                &seen
            ),
            ids(&["rust-review"]),
        );

        let mut no_repo = profile();
        no_repo.include_repo_defaults = false;
        assert_eq!(
            skills_for(
                &no_repo,
                &ids(&["dataviz", "treg"]),
                &ids(&["rust-review"]),
                &seen
            ),
            ids(&["dataviz", "treg"]),
        );
    }

    /// Criterion 8: a tick is a grant. Under the intersection this replaces, a
    /// skill that was nobody's default could not be delivered at all — the
    /// filter dropped it — which is the defect the whole model exists to fix.
    #[test]
    fn a_tick_introduces_a_skill_no_source_supplies() {
        let mut role = profile();
        role.skill_scope = ids(&["make-ugc"]);
        let got = skills_for(
            &role,
            &ids(&["dataviz"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "rust-review", "make-ugc"]),
        );
        assert!(got.contains(&"make-ugc".to_string()));
        assert_eq!(got, ids(&["dataviz", "rust-review", "make-ugc"]));
    }

    /// Criterion 5: naming one a switch already supplies adds nothing. The
    /// screen promises its breakdown sums to the figure, so the set it is
    /// counting has to be de-duplicated here too.
    #[test]
    fn naming_a_skill_a_source_already_supplies_adds_nothing() {
        let plain = skills_for(
            &profile(),
            &ids(&["dataviz"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "rust-review"]),
        );

        let mut role = profile();
        role.skill_scope = ids(&["dataviz", "rust-review"]);
        let named = skills_for(
            &role,
            &ids(&["dataviz"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "rust-review"]),
        );

        assert_eq!(named.len(), plain.len());
        assert_eq!(named, ids(&["dataviz", "rust-review"]));
    }

    /// Criterion 10: both off and nothing named means none, and it has to come
    /// back as an empty set rather than as "no opinion" — `NewSession.skills`
    /// honours `Some(vec![])` as nothing, which is what carries the decision.
    #[test]
    fn both_switches_off_and_nothing_named_loads_nothing() {
        let mut role = profile();
        role.include_always_on = false;
        role.include_repo_defaults = false;
        let got = skills_for(
            &role,
            &ids(&["dataviz"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "rust-review"]),
        );
        assert!(got.is_empty());
    }

    /// Criterion 9: a skill the person starting the run cannot see is never in
    /// the set, however it got on to the profile.
    ///
    /// The case that makes it a security question and not a tidiness one: a
    /// profile is shareable, so a Writer on one filed in a directory can tick
    /// a skill filed in their own space. Without this the colleague who starts
    /// it materialises and runs somebody else's code on their own worker, under
    /// their own credentials.
    #[test]
    fn a_skill_the_person_cannot_reach_is_never_resolved() {
        let mut role = profile();
        role.skill_scope = ids(&["theirs-alone", "shared"]);
        let got = skills_for(
            &role,
            // A stale default — the skill was shared, defaulted, then unshared.
            &ids(&["was-shared"]),
            &[],
            &reachable(&["shared"]),
        );
        assert_eq!(got, ids(&["shared"]));
    }

    #[test]
    fn a_profile_pins_its_whole_shape() {
        // The agent is required: no "let the lead choose".
        let mut r = new("reviewer");
        r.agent = None;
        assert!(check(&r).unwrap_err().0.contains("sets the agent"));

        // Placement must be one of the two; "lead" is gone.
        let mut r = new("reviewer");
        r.agent = Some("ClaudeCode".into());
        r.placement = "lead".into();
        assert!(check(&r).unwrap_err().0.contains("placement"));

        // Its-own-workspace pins a machine.
        let mut r = new("reviewer");
        r.agent = Some("ClaudeCode".into());
        r.placement = "new".into();
        r.machine = None;
        assert!(check(&r).unwrap_err().0.contains("machine"));

        // Fully specified: accepted. A `here` profile needs no machine.
        let mut r = new("reviewer");
        r.agent = Some("ClaudeCode".into());
        r.placement = "here".into();
        assert!(check(&r).is_ok());

        let mut r = new("reviewer");
        r.agent = Some("ClaudeCode".into());
        r.placement = "new".into();
        r.machine = Some("host_abc".into());
        assert!(check(&r).is_ok());
    }

    async fn setup() -> (Roles, String, String, String) {
        let (db, person) = Db::open_for_test_owned().await.unwrap();
        let org = db.org().await.unwrap();
        let slug: String = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
            .bind(&person)
            .fetch_one(db.pool())
            .await
            .unwrap();
        (Roles::new(db.pool().clone()), person, org, slug)
    }

    /// The whole chain, against a real database: three sources resolve, and
    /// only what resolved is pinned.
    ///
    /// The unit tests above own the union's arithmetic. This one is here for
    /// the two things they cannot reach — that the switches survive a round
    /// trip through the columns, and that `set_for_session` refuses to pin a
    /// skill the person starting the run cannot see **even when it is handed
    /// to it directly**. That last assertion is the security one: the resolver
    /// is not the only caller, so the chokepoint has to hold on its own.
    ///
    /// Both placements share one call — `skills_at_spawn` — so what is asserted
    /// here is what a child gets at `here` and at `new` alike. What differs is
    /// only which repositories are handed in, which is the last argument.
    #[tokio::test]
    async fn a_profile_resolves_three_sources_and_pins_only_what_it_may() {
        use crate::accounts::Accounts;
        use crate::db::Db;
        use crate::skills::{IncomingFile, NewSkill};

        let (db, admin) = Db::open_for_test_owned().await.unwrap();
        let pool = db.pool().clone();
        let roles = Roles::new(pool.clone());
        let skills = crate::skills::Skills::new(pool.clone());
        let accounts = Accounts::new(pool.clone());
        let org = db.org().await.unwrap();
        let org_id = ft_core::OrgId::from_stored(org.clone());

        // Ana is who starts the run. The profile's three sources are read
        // against her, not against whoever wrote it.
        let ana = accounts
            .create_user(&org_id, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0
            .id
            .as_str()
            .to_string();

        let bundle = |name: &str| NewSkill {
            name: name.into(),
            description: format!("Does {name}."),
            frontmatter: serde_json::json!({"name": name}),
            body: "body".into(),
            files: vec![IncomingFile {
                path: "SKILL.md".into(),
                contents: ft_proto::encode(b"body"),
                executable: false,
            }],
            notes: None,
        };
        let hers = |name: &'static str| {
            let skills = skills.clone();
            let org = org.clone();
            let ana = ana.clone();
            async move {
                skills
                    .create(&org, &ana, "ana", &bundle(name), false)
                    .await
                    .unwrap()
                    .as_str()
                    .to_string()
            }
        };

        let everywhere = hers("treg").await;
        let in_repo = hers("rust-review").await;
        let named = hers("dataviz").await;
        // Filed in the admin's own space, so Ana can never reach it. This is
        // the skill a shared profile must not be able to hand her.
        let theirs = skills
            .create(&org, &admin, "admin", &bundle("make-ugc"), false)
            .await
            .unwrap()
            .as_str()
            .to_string();

        let repo = db
            .ensure_repo(
                "acme/backend",
                "git@example.test:acme/backend.git",
                Some("main"),
                None,
                &ana,
                None,
            )
            .await
            .unwrap();
        let repo_id = repo.id.clone();
        skills
            .set_default(&ana, &everywhere, None, true)
            .await
            .unwrap();
        skills
            .set_default(&ana, &in_repo, Some(repo_id.as_str()), true)
            .await
            .unwrap();

        // A profile naming two skills: one of Ana's, and one only the admin can
        // see. Written through the store, so the columns are what is read back.
        let slug: String = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
            .bind(&ana)
            .fetch_one(&pool)
            .await
            .unwrap();
        let mut wanted = new("reviewer");
        wanted.agent = Some("ClaudeCode".into());
        wanted.skill_scope = vec![named.clone(), theirs.clone()];
        let id = roles.create(&org, &ana, &slug, &wanted).await.unwrap();
        let profile = roles
            .one(&ana, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert!(
            profile.include_always_on && profile.include_repo_defaults,
            "a new profile inherits both sources"
        );

        // All three sources, counted once each — and the admin's skill absent,
        // though it is named, because Ana cannot reach it.
        let resolved = skills_at_spawn(&skills, &profile, &ana, std::slice::from_ref(&repo_id))
            .await
            .unwrap();
        assert_eq!(
            resolved,
            vec![everywhere.clone(), in_repo.clone(), named.clone()],
        );

        // Pinned, which is what puts a skill on a worker's disk.
        let host = db.ensure_test_host("fire-01", &ana).await.unwrap();
        let session = ft_core::SessionId::new();
        db.insert_session(
            &session,
            &host.id,
            &ana,
            None,
            "Reviewing",
            "",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
        skills
            .set_for_session(session.as_str(), &ana, &resolved)
            .await
            .unwrap();
        let mut pinned = skills.of_session(session.as_str()).await.unwrap();
        pinned.sort();
        let mut expected = resolved.clone();
        expected.sort();
        assert_eq!(pinned, expected, "a profile's whole resolved set is pinned");

        // The chokepoint, on its own. Handed the admin's skill directly — as a
        // caller that skipped the resolver would — it pins nothing.
        skills
            .set_for_session(session.as_str(), &ana, std::slice::from_ref(&theirs))
            .await
            .unwrap();
        assert!(
            skills
                .of_session(session.as_str())
                .await
                .unwrap()
                .is_empty(),
            "a skill the session's owner cannot see is never pinned",
        );
        // And the admin, who can see it, is not blocked by the same predicate.
        let theirs_session = ft_core::SessionId::new();
        db.insert_session(
            &theirs_session,
            &host.id,
            &admin,
            None,
            "Theirs",
            "",
            None,
            None,
            "ClaudeCode",
            ft_core::WorkspaceSize::Medium,
            ft_core::Share::Equal,
            &[],
            None,
        )
        .await
        .unwrap();
        skills
            .set_for_session(
                theirs_session.as_str(),
                &admin,
                std::slice::from_ref(&theirs),
            )
            .await
            .unwrap();
        assert_eq!(
            skills.of_session(theirs_session.as_str()).await.unwrap(),
            vec![theirs.clone()],
            "the check narrows to what each person may see, not to nothing",
        );

        // Both switches off: the named list is all that is left, and the
        // unreachable one is still gone.
        let mut bare = wanted.clone();
        bare.include_always_on = Some(false);
        bare.include_repo_defaults = Some(false);
        assert!(roles.update(&ana, id.as_str(), &bare).await.unwrap());
        let off = roles
            .one(&ana, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            skills_at_spawn(&skills, &off, &ana, &[repo_id])
                .await
                .unwrap(),
            vec![named],
            "turning both off leaves only what the profile names",
        );
    }

    #[tokio::test]
    async fn a_role_is_made_found_changed_and_removed() {
        let (roles, me, org, slug) = setup().await;

        // Made in my own space, visible to me, writable by me.
        let id = roles
            .create(&org, &me, &slug, &new("reviewer"))
            .await
            .unwrap();
        let mine = roles.visible(&me, Level::Viewer).await.unwrap();
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].name, "reviewer");
        assert!(mine[0].may_write);
        assert_eq!(mine[0].placement, "here");

        // Found by name, case-insensitively — what a lead says.
        assert_eq!(
            roles
                .by_name(&me, "Reviewer")
                .await
                .unwrap()
                .map(|r| r.id.clone()),
            Some(id.as_str().to_string())
        );
        assert!(roles.by_name(&me, "nope").await.unwrap().is_none());

        // Changed through the one predicate.
        let mut changed = new("reviewer");
        changed.placement = "new".into();
        changed.does = "implements and opens a PR".into();
        assert!(roles.update(&me, id.as_str(), &changed).await.unwrap());
        assert_eq!(
            roles
                .one(&me, id.as_str(), Level::Viewer)
                .await
                .unwrap()
                .unwrap()
                .placement,
            "new"
        );

        // Gone.
        assert!(roles.delete(&me, id.as_str()).await.unwrap());
        assert!(roles.visible(&me, Level::Viewer).await.unwrap().is_empty());
    }

    /// An omitted inheritance switch is not a decision, and the body of a
    /// write that never mentions one has to leave it alone.
    ///
    /// Shape only, no database: this is where the previous
    /// `#[serde(default = "inherits")]` lived, and the whole of what it got
    /// wrong is that it turned an absent field into `Some(true)` here — before
    /// anything downstream could tell the two apart.
    #[test]
    fn an_absent_switch_deserialises_to_no_opinion_rather_than_to_on() {
        let body = |extra: &str| {
            serde_json::from_str::<NewRole>(&format!(
                "{{\"name\":\"reviewer\",\"does\":\"reviews a branch\"{extra}}}"
            ))
            .unwrap()
        };

        let silent = body("");
        assert_eq!(silent.include_always_on, None);
        assert_eq!(silent.include_repo_defaults, None);

        // And a field that *is* sent still arrives as itself, in both
        // directions — `false` especially, which is the one that used to be
        // indistinguishable from silence.
        let off = body(",\"includeAlwaysOn\":false,\"includeRepoDefaults\":false");
        assert_eq!(off.include_always_on, Some(false));
        assert_eq!(off.include_repo_defaults, Some(false));
        let on = body(",\"includeAlwaysOn\":true");
        assert_eq!(on.include_always_on, Some(true));
        assert_eq!(on.include_repo_defaults, None);
    }

    /// Criterion 11, at the layer that decides it: what a write that omits the
    /// switches does to a profile somebody has narrowed.
    ///
    /// QA's repro, and the reason this is a `COALESCE` rather than a bind.
    /// `toDraft` on the desktop dropped both fields, so the editor's own save
    /// was the body in step three — and under the old default it read as "both
    /// on", which turned a switch somebody had deliberately switched off back
    /// on. The desktop is fixed, but the client that is already installed on
    /// somebody's machine is not, and this is what makes its save harmless.
    #[tokio::test]
    async fn a_write_that_never_mentions_a_switch_leaves_it_as_it_was() {
        let (roles, me, org, slug) = setup().await;

        // Said nothing either way, so a new profile gets the column default.
        let mut silent = new("reviewer");
        silent.include_always_on = None;
        silent.include_repo_defaults = None;
        let id = roles.create(&org, &me, &slug, &silent).await.unwrap();
        let read = || {
            let roles = &roles;
            let me = &me;
            let id = id.clone();
            async move {
                let r = roles
                    .one(me, id.as_str(), Level::Viewer)
                    .await
                    .unwrap()
                    .unwrap();
                (r.include_always_on, r.include_repo_defaults)
            }
        };
        assert_eq!(read().await, (true, true), "a new profile inherits both");

        // Narrowed on purpose.
        let mut narrowed = new("reviewer");
        narrowed.include_always_on = Some(false);
        assert!(roles.update(&me, id.as_str(), &narrowed).await.unwrap());
        assert_eq!(read().await, (false, true));

        // The save that says nothing about either. Everything else it carries
        // still lands, so this is a real write and not a no-op update.
        let mut unaware = new("reviewer");
        unaware.include_always_on = None;
        unaware.include_repo_defaults = None;
        unaware.does = "implements and opens a PR".into();
        assert!(roles.update(&me, id.as_str(), &unaware).await.unwrap());
        assert_eq!(
            read().await,
            (false, true),
            "a switch somebody turned off was turned back on by a save that never mentioned it",
        );
        assert_eq!(
            roles
                .one(&me, id.as_str(), Level::Viewer)
                .await
                .unwrap()
                .unwrap()
                .does,
            "implements and opens a PR",
            "the rest of the body is still whole-object",
        );

        // And it is still switchable: only silence is inert.
        let mut back = new("reviewer");
        back.include_always_on = Some(true);
        back.include_repo_defaults = Some(false);
        assert!(roles.update(&me, id.as_str(), &back).await.unwrap());
        assert_eq!(read().await, (true, false));
    }

    #[tokio::test]
    async fn another_person_cannot_see_or_change_my_role() {
        let (roles, me, org, slug) = setup().await;
        let id = roles
            .create(&org, &me, &slug, &new("reviewer"))
            .await
            .unwrap();

        // A second person in the same org, with a space of their own.
        let accounts = crate::accounts::Accounts::new(roles.pool.clone());
        let them = accounts
            .create_user(
                &ft_core::OrgId::from_stored(org),
                "them",
                "them@example.test",
                "member",
            )
            .await
            .unwrap()
            .0
            .id
            .as_str()
            .to_string();

        assert!(roles
            .visible(&them, Level::Viewer)
            .await
            .unwrap()
            .is_empty());
        assert!(roles
            .one(&them, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .is_none());
        // A role filed in my space is one they cannot name, so a lead of
        // theirs could never reach it.
        assert!(roles.by_name(&them, "reviewer").await.unwrap().is_none());
        assert!(!roles.update(&them, id.as_str(), &new("x")).await.unwrap());
        assert!(!roles.delete(&them, id.as_str()).await.unwrap());
    }

    #[tokio::test]
    async fn a_profile_is_an_operator_until_it_is_made_a_manager() {
        let (roles, me, org, slug) = setup().await;

        // A new profile is an Operator — it does the work, it does not delegate.
        let id = roles
            .create(&org, &me, &slug, &new("reviewer"))
            .await
            .unwrap();
        let made = roles
            .one(&me, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert!(!made.can_delegate);

        // Made a Manager, and it reads back as one.
        let mut manager = new("reviewer");
        manager.can_delegate = true;
        assert!(roles.update(&me, id.as_str(), &manager).await.unwrap());
        let now = roles
            .one(&me, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert!(now.can_delegate);
    }
}
