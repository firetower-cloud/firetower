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

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use utoipa::ToSchema;

use crate::access::{filed_where, Level};

/// The most teammates one profile may lead. A number, not a philosophy: a team
/// a person cannot read at a glance is one they have stopped designing.
const TEAM_MAX: usize = 24;

/// One profile as it appears on another's team — the little a row needs to show
/// a teammate or a manager without reading the whole profile.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Mate {
    pub id: String,
    pub name: String,
    /// Which agent it pins, if any — for the mark the row draws.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub does: String,
}

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

/// Where a role's child runs. `lead` lets the lead choose; the other two pin it.
pub const PLACEMENT: [&str; 3] = ["lead", "here", "new"];

/// A role, as the interface and the spawn tool read it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub path: String,
    pub name: String,
    /// One line: what this kind of agent does.
    pub does: String,
    /// When a lead should reach for it.
    pub use_when: String,
    /// When it should not — the line that says "you can do this yourself".
    pub not_when: String,
    /// `lead` (let the lead choose) | `here` | `new`.
    pub placement: String,
    /// Which agent runs it, or absent to let the lead choose.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Composed into the child's instructions.
    pub instructions: String,
    /// Its team — the profiles it may hand work to. Empty for a worker.
    pub members: Vec<Mate>,
    /// The inverse edge: the profiles that have this one on their team. What
    /// the "reports to" line reads, and why the field is not editable here —
    /// it is a view of someone else's team.
    pub managed_by: Vec<Mate>,
    /// Whether it leads a team at all. `!members.is_empty()`, named so the
    /// interface and the control plane agree on what "can delegate" means.
    pub can_delegate: bool,
    /// Whether the person asking may edit or delete it.
    pub may_write: bool,
    /// Whether they may move it into a directory, or out of one.
    pub may_share: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// What the API accepts to create or change a role.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewRole {
    pub name: String,
    pub does: String,
    #[serde(default)]
    pub use_when: String,
    #[serde(default)]
    pub not_when: String,
    #[serde(default = "lead")]
    pub placement: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub instructions: String,
    /// The team, as a list of profile ids. Replaces the whole set on save —
    /// the editor sends what the team should now be, not a diff.
    #[serde(default)]
    pub members: Vec<String>,
}

fn lead() -> String {
    "lead".into()
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
    if !PLACEMENT.contains(&new.placement.as_str()) {
        return Err(Refused("placement must be lead, here or new".into()));
    }
    if let Some(agent) = &new.agent {
        if ft_core::Agent::from_name(agent).is_none() {
            return Err(Refused(format!("{agent} is not an agent Firetower runs")));
        }
    }
    if new.members.len() > TEAM_MAX {
        return Err(Refused(format!("a team is at most {TEAM_MAX} profiles")));
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

const FIELDS: &str = "r.id, r.path::text AS path, r.name, r.does, r.use_when, r.not_when, \
                      r.placement, r.agent, r.instructions, r.created_at, r.updated_at";

/// A teammate or manager row, read from a join with the member's own profile.
fn mate(row: &sqlx::postgres::PgRow) -> Mate {
    Mate {
        id: row.get("id"),
        name: row.get("name"),
        agent: row.get("agent"),
        does: row.get("does"),
    }
}

fn read(row: sqlx::postgres::PgRow) -> Result<Role> {
    Ok(Role {
        id: row.get("id"),
        path: row.get("path"),
        name: row.get("name"),
        does: row.get("does"),
        use_when: row.get("use_when"),
        not_when: row.get("not_when"),
        placement: row.get("placement"),
        agent: row.get("agent"),
        instructions: row.get("instructions"),
        // Filled by `attach_teams` once the whole set is read, in one query
        // rather than one per row.
        members: Vec::new(),
        managed_by: Vec::new(),
        can_delegate: false,
        may_write: row.get("may_write"),
        may_share: row.get("may_share"),
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
            "SELECT {FIELDS}, {writable} AS may_write, {shareable} AS may_share \
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
        let mut roles = rows.into_iter().map(read).collect::<Result<Vec<_>>>()?;
        self.attach_teams(&mut roles).await?;
        Ok(roles)
    }

    /// One role, if this person may see it.
    pub async fn one(&self, person: &str, id: &str, at_least: Level) -> Result<Option<Role>> {
        let sql = format!(
            "SELECT {FIELDS}, {writable} AS may_write, {shareable} AS may_share \
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
        let Some(mut role) = row.map(read).transpose()? else {
            return Ok(None);
        };
        self.attach_teams(std::slice::from_mut(&mut role)).await?;
        Ok(Some(role))
    }

    /// Fill in each role's team and the inverse "managed by", in two queries
    /// for the whole set rather than per row. Members carry a teammate's name,
    /// mark and one-liner — enough for a row — joined from the member's own
    /// profile so the two never drift.
    async fn attach_teams(&self, roles: &mut [Role]) -> Result<()> {
        if roles.is_empty() {
            return Ok(());
        }
        let ids: Vec<String> = roles.iter().map(|r| r.id.clone()).collect();

        let team_rows = sqlx::query(
            "SELECT rm.manager_id AS owner, m.id, m.name, m.agent, m.does \
               FROM role_members rm JOIN roles m ON m.id = rm.member_id \
              WHERE rm.manager_id = ANY($1) ORDER BY m.name",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await
        .context("reading teams")?;
        let mut members: HashMap<String, Vec<Mate>> = HashMap::new();
        for row in team_rows {
            members.entry(row.get("owner")).or_default().push(mate(&row));
        }

        let mgr_rows = sqlx::query(
            "SELECT rm.member_id AS owner, g.id, g.name, g.agent, g.does \
               FROM role_members rm JOIN roles g ON g.id = rm.manager_id \
              WHERE rm.member_id = ANY($1) ORDER BY g.name",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await
        .context("reading who manages these")?;
        let mut managers: HashMap<String, Vec<Mate>> = HashMap::new();
        for row in mgr_rows {
            managers.entry(row.get("owner")).or_default().push(mate(&row));
        }

        for role in roles.iter_mut() {
            role.members = members.remove(&role.id).unwrap_or_default();
            role.managed_by = managers.remove(&role.id).unwrap_or_default();
            role.can_delegate = !role.members.is_empty();
        }
        Ok(())
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
               (id, org_id, path, created_by, name, slug, does, use_when, not_when, \
                placement, agent, instructions) \
             VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        )
        .bind(id.as_str())
        .bind(org)
        .bind(&path)
        .bind(person)
        .bind(new.name.trim())
        .bind(&slug)
        .bind(new.does.trim())
        .bind(new.use_when.trim())
        .bind(new.not_when.trim())
        .bind(&new.placement)
        .bind(&new.agent)
        .bind(&new.instructions)
        .execute(&self.pool)
        .await
        .context("writing a role")?;
        self.set_members(id.as_str(), &new.members).await?;
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
            "UPDATE roles SET name=$2, does=$3, use_when=$4, not_when=$5, \
               placement=$6, agent=$7, instructions=$8, updated_at=now() WHERE id=$1",
        )
        .bind(id)
        .bind(new.name.trim())
        .bind(new.does.trim())
        .bind(new.use_when.trim())
        .bind(new.not_when.trim())
        .bind(&new.placement)
        .bind(&new.agent)
        .bind(&new.instructions)
        .execute(&self.pool)
        .await
        .context("updating a role")?;
        self.set_members(id, &new.members).await?;
        Ok(true)
    }

    /// Replace a profile's team with exactly this set of ids.
    ///
    /// The whole set every time, so the editor sends what the team should be
    /// and never a diff. Deduped; the schema refuses a self-edge and a missing
    /// member, so a bad id is a refusal rather than a silent drop. `vet` has
    /// already decided the person may name these and that none of them loops
    /// back — this only writes.
    async fn set_members(&self, manager: &str, members: &[String]) -> Result<()> {
        let mut seen = HashSet::new();
        let wanted: Vec<&String> = members.iter().filter(|m| seen.insert(*m)).collect();

        let mut tx = self.pool.begin().await.context("opening a team write")?;
        sqlx::query("DELETE FROM role_members WHERE manager_id = $1")
            .bind(manager)
            .execute(&mut *tx)
            .await
            .context("clearing a team")?;
        for member in wanted {
            sqlx::query("INSERT INTO role_members (manager_id, member_id) VALUES ($1, $2)")
                .bind(manager)
                .bind(member)
                .execute(&mut *tx)
                .await
                .context("adding a teammate")?;
        }
        tx.commit().await.context("committing a team")?;
        Ok(())
    }

    /// Everything a well-formed team must be, for this person on this profile.
    ///
    /// Separate from [`check`] because it needs the database and the person:
    /// each teammate must be a profile they can see, none may be the profile
    /// itself, and — when editing an existing one — none may already lead back
    /// to it, which would be a loop. Pure field checks stay in `check`.
    pub async fn vet(&self, person: &str, id: Option<&str>, new: &NewRole) -> Result<(), Refused> {
        let mut seen = HashSet::new();
        for member in &new.members {
            if !seen.insert(member) {
                continue;
            }
            if Some(member.as_str()) == id {
                return Err(Refused("a profile can't be on its own team".into()));
            }
            let visible = self
                .one(person, member, Level::Viewer)
                .await
                .map_err(|_| Refused("couldn't read the team".into()))?
                .is_some();
            if !visible {
                return Err(Refused("a teammate has to be a profile you can see".into()));
            }
        }
        // A loop is only reachable when editing a profile that already exists:
        // a new one has nothing pointing at it yet.
        if let Some(manager) = id {
            for member in &new.members {
                let loops = self
                    .reaches(member, manager)
                    .await
                    .map_err(|_| Refused("couldn't check the team for loops".into()))?;
                if loops {
                    return Err(Refused(
                        "that would loop — one of those profiles already leads back to this one"
                            .into(),
                    ));
                }
            }
        }
        Ok(())
    }

    /// Whether `start` can reach `target` by following `manages` edges — so
    /// adding `target → start` would close a cycle.
    async fn reaches(&self, start: &str, target: &str) -> Result<bool> {
        let hit: bool = sqlx::query_scalar(
            "WITH RECURSIVE reach(id) AS ( \
                 SELECT member_id FROM role_members WHERE manager_id = $1 \
                 UNION \
                 SELECT rm.member_id FROM role_members rm JOIN reach ON rm.manager_id = reach.id \
             ) SELECT EXISTS (SELECT 1 FROM reach WHERE id = $2)",
        )
        .bind(start)
        .bind(target)
        .fetch_one(&self.pool)
        .await
        .context("walking the team graph")?;
        Ok(hit)
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
            does: "reads a branch and reports problems".into(),
            use_when: "after a developer hands back".into(),
            not_when: "a one-line fix".into(),
            placement: "here".into(),
            agent: None,
            instructions: "Report findings as path:line.".into(),
            members: Vec::new(),
        }
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
    async fn a_team_is_built_read_from_both_ends_and_kept_acyclic() {
        let (roles, me, org, slug) = setup().await;
        let lead = roles.create(&org, &me, &slug, &new("lead")).await.unwrap();
        let qa = roles.create(&org, &me, &slug, &new("qa")).await.unwrap();

        // The lead manages QA.
        let mut team = new("lead");
        team.members = vec![qa.as_str().to_string()];
        roles.vet(&me, Some(lead.as_str()), &team).await.unwrap();
        assert!(roles.update(&me, lead.as_str(), &team).await.unwrap());

        // Read from the top it is a teammate and the lead can delegate.
        let led = roles.one(&me, lead.as_str(), Level::Viewer).await.unwrap().unwrap();
        assert_eq!(led.members.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["qa"]);
        assert!(led.can_delegate);
        // Read from the bottom it is a manager, and QA leads nobody.
        let worker = roles.one(&me, qa.as_str(), Level::Viewer).await.unwrap().unwrap();
        assert_eq!(worker.managed_by.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["lead"]);
        assert!(!worker.can_delegate);

        // A profile cannot be on its own team.
        let mut selfish = new("qa");
        selfish.members = vec![qa.as_str().to_string()];
        assert!(roles.vet(&me, Some(qa.as_str()), &selfish).await.is_err());

        // And QA managing the lead back would loop, so it is refused.
        let mut loopy = new("qa");
        loopy.members = vec![lead.as_str().to_string()];
        assert!(roles.vet(&me, Some(qa.as_str()), &loopy).await.is_err());
    }
}
