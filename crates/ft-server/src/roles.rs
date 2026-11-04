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
    /// The skills it may load, by id. Empty means any the owner can use; an
    /// off-list skill is never written to its workspace.
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
    /// The skills it may load, by id. Empty = any the owner can use.
    #[serde(default)]
    pub skill_scope: Vec<String>,
    /// A directory to file it in, by id, so a teammate can reach it. Omit for
    /// your own space. Only honoured at creation; move it later with sharing.
    #[serde(default)]
    pub directory: Option<String>,
}

/// Why a role was refused, in a sentence somebody can act on.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Everything a well-formed role must be.
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
                      r.can_delegate, r.delegate_scope, r.skill_scope, r.created_at, r.updated_at";

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
                delegate_scope, skill_scope, pref_model, pref_effort, pref_mode, pref_sandbox) \
             VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, \
                     $16, $17, $18, $19)",
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
               pref_model=$12, pref_effort=$13, pref_mode=$14, pref_sandbox=$15, \
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
            skill_scope: vec![],
            settings: Default::default(),
            directory: None,
        }
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
