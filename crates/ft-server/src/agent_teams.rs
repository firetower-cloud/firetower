//! Agent teams: a lead profile, and the tree of positions under it.
//!
//! A profile is **identity** — its name, what it does, its instructions, its
//! skills, how it runs. A team is **structure**. Delegation is not a property
//! of a profile any more; it is what a team says, and the only thing that
//! decides whether a `spawn` is refused is the children of the position a
//! session occupies.
//!
//! A team is **Placed** — see `docs/paths-and-ownership.md`. It has a path, it
//! can be filed into a directory and shared, and `access::filed_where` is the
//! only thing that decides who may see one. Nothing here invents a second way
//! to answer that.
//!
//! ## The tree is flat on the wire
//!
//! A position carries its parent rather than its children, in both directions.
//! A nested shape would be the honest one for a tree, and it is the shape the
//! YAML file takes — but it generates a recursive schema, and the three clients
//! are generated. Flat with a parent is the same tree, and the client builds it
//! in four lines.
//!
//! ## The lead is a position, and it is the same row for the life of the team
//!
//! Changing the lead changes which profile the root position references; it
//! never moves the root. That is what makes a whole-tree save an ordinary
//! update rather than a dance around `agent_teams_one_lead` — see [`replace`].

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use utoipa::ToSchema;

use crate::access::{filed_where, Level};

/// How deep a team may go, and how many positions it may hold.
///
/// Generous enough never to bite ordinary use, and stated rather than left to
/// whoever reads the recursion first — with no spend cap in this scope these
/// are the only guardrail there is, and an engineer inventing a different
/// limit somewhere else is how two limits come to disagree.
///
/// Six levels is an organisation chart nobody has drawn yet; the hardest lane
/// in the prototype is three. Fifty positions is four times the largest team
/// anybody has built.
pub const MAX_DEPTH: usize = 6;
pub const MAX_POSITIONS: usize = 50;

/// A team, as the map and the picker read it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentTeam {
    pub id: String,
    pub path: String,
    pub name: String,
    /// The whole tree, flat and in sibling order. The lead is the one entry
    /// with no `parent`, and it is always first.
    pub positions: Vec<Position>,
    /// Whether the person asking may edit or delete it.
    pub may_write: bool,
    /// Whether they may move it into a directory, or out of one.
    pub may_share: bool,
    /// How many schedules pin this team. The team editor states this before
    /// Save, because saving pauses every one of them.
    pub schedules: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl AgentTeam {
    /// The root. Every team has exactly one — `agent_teams_one_lead`.
    pub fn lead(&self) -> Option<&Position> {
        self.positions.iter().find(|p| p.parent.is_none())
    }

    /// How many agents picking this team can run: every position, the lead
    /// included. The composer says this on the row, because picking something
    /// that quietly starts eight agents is the misleading case.
    pub fn size(&self) -> usize {
        self.positions.len()
    }

    /// How many levels it has, the lead's being the first.
    pub fn depth(&self) -> usize {
        let mut deepest = 0;
        for p in &self.positions {
            let mut n = 1;
            let mut at = p.parent.as_deref();
            while let Some(id) = at {
                n += 1;
                at = self
                    .positions
                    .iter()
                    .find(|q| q.id == id)
                    .and_then(|q| q.parent.as_deref());
                if n > MAX_DEPTH + 1 {
                    break;
                }
            }
            deepest = deepest.max(n);
        }
        deepest
    }

    /// The positions directly under this one: exactly what a session standing
    /// here may hand work to.
    pub fn children_of(&self, position: &str) -> Vec<&Position> {
        self.positions
            .iter()
            .filter(|p| p.parent.as_deref() == Some(position))
            .collect()
    }
}

/// One profile, where it sits in one team, and what is said to it only there.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    /// Null for the lead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// The profile it references, by id.
    pub profile: String,
    /// The profile's name, so the map draws a card without a request per card.
    /// Empty when `redacted`.
    pub name: String,
    /// The profile's one-liner, for the card's tooltip. Empty when `redacted`.
    pub does: String,
    /// The engine the profile pins, for the mark on the card. Absent when the
    /// profile leaves it open, and when `redacted`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// The profile is real and in this team, and this person cannot see it.
    ///
    /// Drawn as a redacted card rather than left out. A gap would misrepresent
    /// the team's shape, which is the thing the map exists to convey — and
    /// the count under a parent would be wrong, which is worse than a card
    /// that says it is not for you.
    pub redacted: bool,
    /// Markdown that applies here and nowhere else. It never replaces a
    /// profile field; it is composed after the profile's own instructions.
    pub extra_instructions: String,
    /// Authoritative sibling order. The map draws in it and export writes it.
    pub ordinal: i32,
}

/// What the API accepts to create or replace a team.
///
/// **Declarative.** What is sent is the team: a position that is not in
/// `positions` is removed, with its subtree. That is the same contract the
/// YAML file has, which is what lets one round-trip into the other.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentTeam {
    pub name: String,
    /// The whole tree, flat. Exactly one entry has no `parent`: the lead.
    /// Array order is sibling order.
    #[serde(default)]
    pub positions: Vec<DraftPosition>,
    /// A directory to file it in, by id, so a teammate can reach it. Omit for
    /// your own space. Only honoured at creation; move it later with sharing.
    #[serde(default)]
    pub directory: Option<String>,
}

/// One position as the caller draws it, before it has an id of its own.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DraftPosition {
    /// The caller's own key for this position, which its children name as
    /// their `parent`. An existing position's id keeps that row — and keeps
    /// the sessions standing on it; anything else mints a new one.
    pub key: String,
    /// The key of the position above it. Null for the lead, and exactly one
    /// entry may say so.
    #[serde(default)]
    pub parent: Option<String>,
    /// The profile it references, by id.
    pub profile: String,
    #[serde(default)]
    pub extra_instructions: String,
}

/// Why a write was refused, in a sentence somebody can act on.
///
/// The same shape `roles::Refused` has, and for the same reason: these come
/// back through the API as a 400 with the sentence, and through the MCP server
/// as the text of a tool result an agent reads and acts on.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

fn no(what: impl Into<String>) -> anyhow::Error {
    anyhow::Error::new(Refused(what.into()))
}

/// `<name>_<tail>`, so two people's `product` teams do not collide on the
/// path's own uniqueness. The same shape a profile's slug has.
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
    let base = if base.is_empty() { "team".into() } else { base };
    format!("{base}_{}", &id[id.len().saturating_sub(8)..])
}

/// "May this person move this team": it is in their own space, or they
/// administer the directory it is in, or they administer the organisation.
///
/// Character for character what `roles::shareable` computes for a profile.
/// Kept local for the reason that one is: it is three lines, and a shared one
/// would be one more thing to find.
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

const FIELDS: &str = "t.id, t.path::text AS path, t.name, t.created_at, t.updated_at";

#[derive(Clone)]
pub struct AgentTeams {
    pool: PgPool,
}

impl AgentTeams {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// Every team this person may see, at the given level or better, with its
    /// whole tree.
    ///
    /// The tree comes back in one statement rather than one per team: the
    /// teams list draws lead, size and depth for every team without opening
    /// anything, so the positions are what the list is made of rather than
    /// detail behind a click.
    pub async fn visible(&self, person: &str, at_least: Level) -> Result<Vec<AgentTeam>> {
        let sql = format!(
            "SELECT {FIELDS}, {writable} AS may_write, {shareable} AS may_share, \
                    (SELECT count(*) FROM schedules s \
                      WHERE s.pins -> 'team' ->> 'id' = t.id) AS schedules \
               FROM agent_teams t WHERE {visible} ORDER BY t.name",
            visible = filed_where("t", 1, at_least),
            writable = filed_where("t", 1, Level::Writer),
            shareable = shareable("t", 1),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .fetch_all(&self.pool)
            .await
            .context("reading the agent teams somebody can see")?;
        let ids: Vec<String> = rows.iter().map(|r| r.get::<String, _>("id")).collect();
        let mut positions = self.positions_in(person, &ids).await?;
        rows.into_iter()
            .map(|r| {
                let id: String = r.get("id");
                let mine = positions.remove(&id).unwrap_or_default();
                Ok(AgentTeam {
                    positions: mine,
                    // Slashes on the wire, dots in the database — the same
                    // conversion every other Placed kind makes.
                    path: ft_core::ResourcePath::from_stored(r.get::<String, _>("path"))
                        .to_string(),
                    id,
                    name: r.get("name"),
                    may_write: r.get("may_write"),
                    may_share: r.get("may_share"),
                    schedules: r.get("schedules"),
                    created_at: r.get("created_at"),
                    updated_at: r.get("updated_at"),
                })
            })
            .collect()
    }

    /// One team, if this person may see it at that level.
    pub async fn one(&self, person: &str, id: &str, at_least: Level) -> Result<Option<AgentTeam>> {
        Ok(self
            .visible(person, at_least)
            .await?
            .into_iter()
            .find(|t| t.id == id))
    }

    /// The positions of these teams, by team, in sibling order.
    ///
    /// **The join to `roles` is a left join through `filed_where`.** A team may
    /// hold a position on a profile this person cannot see — the team is
    /// shared and the profile is not, which is an ordinary state rather than a
    /// broken one. The row comes back either way and is marked `redacted`, so
    /// the shape of the team is true even where its contents are not readable.
    async fn positions_in(
        &self,
        person: &str,
        teams: &[String],
    ) -> Result<std::collections::HashMap<String, Vec<Position>>> {
        let mut out: std::collections::HashMap<String, Vec<Position>> = Default::default();
        if teams.is_empty() {
            return Ok(out);
        }
        let sql = format!(
            "SELECT p.id, p.team_id, p.parent_id, p.role_id, p.extra_instructions, p.ordinal, \
                    r.name, r.does, r.agent, ({visible}) AS readable \
               FROM team_positions p JOIN roles r ON r.id = p.role_id \
              WHERE p.team_id = ANY($2) \
              ORDER BY p.team_id, p.parent_id NULLS FIRST, p.ordinal, p.id",
            visible = filed_where("r", 1, Level::Viewer),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .bind(teams)
            .fetch_all(&self.pool)
            .await
            .context("reading the positions in an agent team")?;
        for r in rows {
            let readable: bool = r.get("readable");
            let position = Position {
                id: r.get("id"),
                parent: r.get("parent_id"),
                profile: r.get("role_id"),
                name: if readable {
                    r.get("name")
                } else {
                    String::new()
                },
                does: if readable {
                    r.get("does")
                } else {
                    String::new()
                },
                agent: if readable { r.get("agent") } else { None },
                redacted: !readable,
                extra_instructions: r.get("extra_instructions"),
                ordinal: r.get("ordinal"),
            };
            out.entry(r.get::<String, _>("team_id"))
                .or_default()
                .push(position);
        }
        Ok(out)
    }

    /// Which teams hold a position on this profile, and how many each holds.
    ///
    /// Read in two places that must agree: the drawer's band, which states the
    /// consequence of an edit before it is made, and the refusal when somebody
    /// deletes a profile a team is standing on.
    pub async fn holding(&self, person: &str, role: &str) -> Result<Vec<(String, i64)>> {
        let sql = format!(
            "SELECT t.name, count(*) AS held \
               FROM team_positions p JOIN agent_teams t ON t.id = p.team_id \
              WHERE p.role_id = $2 AND {visible} \
              GROUP BY t.id, t.name ORDER BY t.name",
            visible = filed_where("t", 1, Level::Viewer),
        );
        Ok(sqlx::query(&sql)
            .bind(person)
            .bind(role)
            .fetch_all(&self.pool)
            .await
            .context("reading which teams hold a profile")?
            .into_iter()
            .map(|r| (r.get("name"), r.get("held")))
            .collect())
    }

    /// Every team holding a position on this profile, whoever can see it.
    ///
    /// The refusal when a profile is deleted. Unscoped on purpose and it
    /// discloses nothing new: the asker is holding a profile they may write,
    /// and a count of teams they cannot see is the only honest way to say why
    /// the delete will not happen. The names are only those they may read.
    pub async fn standing_on(&self, person: &str, role: &str) -> Result<(i64, Vec<String>)> {
        let sql = format!(
            "SELECT count(*) AS held, \
                    coalesce(array_agg(t.name) FILTER (WHERE {visible}), '{{}}') AS names \
               FROM team_positions p JOIN agent_teams t ON t.id = p.team_id \
              WHERE p.role_id = $2",
            visible = filed_where("t", 1, Level::Viewer),
        );
        let row = sqlx::query(&sql)
            .bind(person)
            .bind(role)
            .fetch_one(&self.pool)
            .await
            .context("reading which teams stand on a profile")?;
        Ok((row.get("held"), row.get("names")))
    }

    /// The team and position a session occupies, with the whole team.
    ///
    /// This is what replaces `delegate_scope` at run time. A session that
    /// answers `None` here has no position, and a session with no position
    /// cannot delegate — which is the refusal `spawn` gives.
    ///
    /// **Unscoped by the asker, because the asker is a session.** What a
    /// running agent may hand work to was decided when somebody who could see
    /// both the team and the profiles put them in it; asking again as the
    /// session's owner would mean a team shared with somebody stopped working
    /// the moment they started it.
    pub async fn at_position(&self, position: &str) -> Result<Option<(AgentTeam, Position)>> {
        let team_id: Option<String> =
            sqlx::query_scalar("SELECT team_id FROM team_positions WHERE id = $1")
                .bind(position)
                .fetch_optional(&self.pool)
                .await
                .context("reading which team a position is in")?;
        let Some(team_id) = team_id else {
            return Ok(None);
        };
        let Some(team) = self.unscoped(&team_id).await? else {
            return Ok(None);
        };
        let Some(here) = team.positions.iter().find(|p| p.id == position).cloned() else {
            return Ok(None);
        };
        Ok(Some((team, here)))
    }

    /// One team with every position readable, for the run-time path.
    ///
    /// See [`Self::at_position`] for why this does not take a person.
    pub async fn unscoped(&self, id: &str) -> Result<Option<AgentTeam>> {
        let row = sqlx::query(&format!(
            "SELECT {FIELDS} FROM agent_teams t WHERE t.id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("reading an agent team")?;
        let Some(row) = row else { return Ok(None) };
        let rows = sqlx::query(
            "SELECT p.id, p.parent_id, p.role_id, p.extra_instructions, p.ordinal, \
                    r.name, r.does, r.agent \
               FROM team_positions p JOIN roles r ON r.id = p.role_id \
              WHERE p.team_id = $1 ORDER BY p.parent_id NULLS FIRST, p.ordinal, p.id",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .context("reading the positions in an agent team")?;
        Ok(Some(AgentTeam {
            id: row.get("id"),
            path: ft_core::ResourcePath::from_stored(row.get::<String, _>("path")).to_string(),
            name: row.get("name"),
            positions: rows
                .into_iter()
                .map(|r| Position {
                    id: r.get("id"),
                    parent: r.get("parent_id"),
                    profile: r.get("role_id"),
                    name: r.get("name"),
                    does: r.get("does"),
                    agent: r.get("agent"),
                    redacted: false,
                    extra_instructions: r.get("extra_instructions"),
                    ordinal: r.get("ordinal"),
                })
                .collect(),
            may_write: false,
            may_share: false,
            schedules: 0,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
        }))
    }

    /// Create a team. Its tree is written in the same transaction, so a team
    /// is never briefly leadless and never briefly half a tree.
    pub async fn create(
        &self,
        org: &str,
        person: &str,
        person_slug: &str,
        directory_slug: Option<&str>,
        new: &NewAgentTeam,
    ) -> Result<ft_core::AgentTeamId> {
        let tree = Tree::read(new)?;
        let id = ft_core::AgentTeamId::new();
        let slug = slug_of(&new.name, id.as_str());
        let path = match directory_slug {
            Some(directory) => ft_core::ResourcePath::in_directory(directory, &slug),
            None => ft_core::ResourcePath::personal(person_slug, &slug),
        };
        let mut tx = self.pool.begin().await.context("starting an agent team")?;
        sqlx::query(
            "INSERT INTO agent_teams (id, org_id, path, created_by, name, slug) \
             VALUES ($1, $2, $3::ltree, $4, $5, $6)",
        )
        .bind(id.as_str())
        .bind(org)
        .bind(path.to_ltree())
        .bind(person)
        .bind(new.name.trim())
        .bind(&slug)
        .execute(&mut *tx)
        .await
        .map_err(|e| named(e, new))?;
        // Parents before children, which `Tree::order` already guarantees, so
        // every `parent_id` names a row that is already in.
        let mut minted: std::collections::HashMap<&str, String> = Default::default();
        for key in &tree.order {
            let draft = &tree.by_key[key];
            let pid = ft_core::PositionId::new().as_str().to_string();
            let parent = draft.parent.as_deref().map(|k| minted[k].clone());
            sqlx::query(
                "INSERT INTO team_positions \
                   (id, team_id, parent_id, role_id, extra_instructions, ordinal) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
            )
            .bind(&pid)
            .bind(id.as_str())
            .bind(&parent)
            .bind(&draft.profile)
            .bind(draft.extra_instructions.trim())
            .bind(ordinal_of(&tree, key))
            .execute(&mut *tx)
            .await
            .map_err(|e| named(e, new))?;
            minted.insert(key.as_str(), pid);
        }
        tx.commit().await.context("starting an agent team")?;
        Ok(id)
    }

    /// Replace a team's name and its whole tree with what was sent.
    ///
    /// **Declarative, and one write.** The map drafts and Save commits every
    /// pending change together, so this takes the team as it should be rather
    /// than a list of what changed — which is also what makes a YAML file and
    /// a map two ways of saying the same thing.
    ///
    /// A key that is already a position id of this team **keeps that row**, so
    /// the sessions standing on it keep standing on it. Everything else is
    /// minted, and what is no longer named is deleted.
    ///
    /// The four passes exist to keep `agent_teams_one_lead` true at every
    /// instant: the root row never moves, everything is briefly parented to
    /// it, what is going is deleted while it has no children to cascade into,
    /// and the real parents are set last.
    pub async fn replace(&self, person: &str, id: &str, new: &NewAgentTeam) -> Result<bool> {
        if !may_write_in(&self.pool, person, id).await? {
            return Ok(false);
        }
        let tree = Tree::read(new)?;
        let mut tx = self.pool.begin().await.context("saving an agent team")?;
        let root: String = sqlx::query_scalar(
            "SELECT id FROM team_positions WHERE team_id = $1 AND parent_id IS NULL",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .context("reading an agent team's lead")?;
        let here: Vec<String> =
            sqlx::query_scalar("SELECT id FROM team_positions WHERE team_id = $1")
                .bind(id)
                .fetch_all(&mut *tx)
                .await
                .context("reading an agent team's positions")?;

        // Which row each key is going to be. The root key always lands on the
        // root row, whatever the caller called it: the lead is the team's one
        // fixed point, and a caller changing the lead is changing which
        // profile that row references.
        let mut rows: std::collections::HashMap<&str, String> = Default::default();
        for key in &tree.order {
            let row = if *key == tree.root {
                root.clone()
            } else if here.iter().any(|h| h == key) {
                key.clone()
            } else {
                ft_core::PositionId::new().as_str().to_string()
            };
            rows.insert(key.as_str(), row);
        }
        let keeping: Vec<String> = rows.values().cloned().collect();

        // 1. Everything hangs off the root, so nothing about to be deleted has
        //    a child to take with it.
        sqlx::query("UPDATE team_positions SET parent_id = $2 WHERE team_id = $1 AND id <> $2")
            .bind(id)
            .bind(&root)
            .execute(&mut *tx)
            .await
            .context("saving an agent team")?;
        // 2. What is no longer named, gone.
        sqlx::query("DELETE FROM team_positions WHERE team_id = $1 AND id <> ALL($2)")
            .bind(id)
            .bind(&keeping)
            .execute(&mut *tx)
            .await
            .context("saving an agent team")?;
        // 3. Every row as it should be, still parented to the root.
        for key in &tree.order {
            let draft = &tree.by_key[key];
            let row = &rows[key.as_str()];
            let ordinal = ordinal_of(&tree, key);
            if here.iter().any(|h| h == row) {
                sqlx::query(
                    "UPDATE team_positions SET role_id = $2, extra_instructions = $3, \
                            ordinal = $4 WHERE id = $1",
                )
                .bind(row)
                .bind(&draft.profile)
                .bind(draft.extra_instructions.trim())
                .bind(ordinal)
                .execute(&mut *tx)
                .await
                .map_err(|e| named(e, new))?;
            } else {
                sqlx::query(
                    "INSERT INTO team_positions \
                       (id, team_id, parent_id, role_id, extra_instructions, ordinal) \
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(row)
                .bind(id)
                .bind(&root)
                .bind(&draft.profile)
                .bind(draft.extra_instructions.trim())
                .bind(ordinal)
                .execute(&mut *tx)
                .await
                .map_err(|e| named(e, new))?;
            }
        }
        // 4. The real parents. The root is skipped and keeps its null, so
        //    there is never a second row without one.
        for key in &tree.order {
            let Some(parent) = tree.by_key[key].parent.as_deref() else {
                continue;
            };
            sqlx::query("UPDATE team_positions SET parent_id = $2 WHERE id = $1")
                .bind(&rows[key.as_str()])
                .bind(&rows[parent])
                .execute(&mut *tx)
                .await
                .context("saving an agent team")?;
        }
        sqlx::query("UPDATE agent_teams SET name = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(new.name.trim())
            .execute(&mut *tx)
            .await
            .map_err(|e| named(e, new))?;
        tx.commit().await.context("saving an agent team")?;
        Ok(true)
    }

    /// Delete a team. Writer on where it lives, like changing it.
    ///
    /// The positions go with it and the profiles do not: a position is the
    /// team's, and a profile was only ever referenced.
    pub async fn delete(&self, person: &str, id: &str) -> Result<bool> {
        if !may_write_in(&self.pool, person, id).await? {
            return Ok(false);
        }
        let done = sqlx::query("DELETE FROM agent_teams WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting an agent team")?;
        Ok(done.rows_affected() == 1)
    }
}

/// Where a position sits among its siblings, as the caller sent them. The lead
/// is alone on its level and is always zero.
fn ordinal_of(tree: &Tree, key: &str) -> i32 {
    let Some(parent) = tree.by_key[key].parent.as_deref() else {
        return 0;
    };
    tree.siblings
        .get(parent)
        .and_then(|s| s.iter().position(|k| k == key))
        .unwrap_or(0) as i32
}

/// Whether this person may change this team: Writer where it is filed, through
/// the one predicate the interface's `may_write` is drawn from.
pub async fn may_write_in<'e, E>(x: E, person: &str, id: &str) -> Result<bool>
where
    E: sqlx::PgExecutor<'e>,
{
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM agent_teams t WHERE t.id = $2 AND {visible})",
        visible = filed_where("t", 1, Level::Writer),
    );
    sqlx::query_scalar::<_, bool>(&sql)
        .bind(person)
        .bind(id)
        .fetch_one(x)
        .await
        .context("reading whether somebody may change an agent team")
}

/// A draft read as a tree, once: one root, no orphans, no cycles, within the
/// limits, and in sibling order.
///
/// Its own type because three callers need the same answer — create, replace,
/// and the plan an import shows before it writes — and because the validation
/// is the whole of what makes a flat list a tree.
pub struct Tree {
    /// Keys in an order where a parent always precedes its children.
    pub order: Vec<String>,
    pub by_key: std::collections::HashMap<String, DraftPosition>,
    pub root: String,
    /// Sibling order, by parent key, as the caller sent it.
    pub siblings: std::collections::HashMap<String, Vec<String>>,
}

impl Tree {
    pub fn read(new: &NewAgentTeam) -> Result<Self> {
        let mut by_key: std::collections::HashMap<String, DraftPosition> = Default::default();
        for p in &new.positions {
            if p.key.trim().is_empty() {
                return Err(no("every position needs a key of its own"));
            }
            if by_key.insert(p.key.clone(), p.clone()).is_some() {
                return Err(no(format!(
                    "two positions share the key \"{}\" — a key names one position",
                    p.key
                )));
            }
        }
        let roots: Vec<&DraftPosition> = new
            .positions
            .iter()
            .filter(|p| p.parent.is_none())
            .collect();
        let root =
            match roots.len() {
                1 => roots[0].key.clone(),
                0 => return Err(no(
                    "a team is a lead and the positions under it, and this one has no lead. One \
                     position has no parent, and that is the lead.",
                )),
                n => {
                    return Err(no(format!(
                    "a team has one lead and this one has {n}. Everything but the lead names the \
                     position above it."
                )))
                }
            };
        if new.positions.len() > MAX_POSITIONS {
            return Err(no(format!(
                "a team holds at most {MAX_POSITIONS} positions, and this one has {}",
                new.positions.len()
            )));
        }
        // Every parent has to be somebody. Named rather than counted: a typo
        // in one key is the likely cause and the key is what to look for.
        for p in &new.positions {
            if let Some(parent) = &p.parent {
                if !by_key.contains_key(parent) {
                    return Err(no(format!(
                        "\"{}\" sits under \"{parent}\", and there is no position with that key",
                        p.key
                    )));
                }
            }
        }
        // Sibling order is the order it arrived in.
        let mut siblings: std::collections::HashMap<String, Vec<String>> = Default::default();
        for p in &new.positions {
            if let Some(parent) = &p.parent {
                siblings
                    .entry(parent.clone())
                    .or_default()
                    .push(p.key.clone());
            }
        }
        // Parents before children, which is also the order the writes go in.
        // Anything left over when the walk stops is in a cycle — and a cycle
        // is the one shape a tree cannot hold, so it is named rather than
        // silently flattened.
        let mut order = vec![root.clone()];
        let mut at = 0;
        while at < order.len() {
            let here = order[at].clone();
            at += 1;
            for key in siblings.get(&here).into_iter().flatten() {
                order.push(key.clone());
            }
        }
        if order.len() != new.positions.len() {
            let loose: Vec<&str> = new
                .positions
                .iter()
                .map(|p| p.key.as_str())
                .filter(|k| !order.iter().any(|o| o == k))
                .collect();
            return Err(no(format!(
                "{} of these positions are under each other in a circle, so none of them is in \
                 the team: {}. A team is a tree — follow any position upwards and you reach the \
                 lead.",
                loose.len(),
                loose.join(", "),
            )));
        }
        // Depth, measured on the walk rather than recursed.
        let mut depth: std::collections::HashMap<&str, usize> = Default::default();
        depth.insert(root.as_str(), 1);
        for key in &order {
            let Some(parent) = by_key[key].parent.as_deref() else {
                continue;
            };
            let here = depth.get(parent).copied().unwrap_or(1) + 1;
            depth.insert(key.as_str(), here);
            if here > MAX_DEPTH {
                let name = &by_key[key].profile;
                return Err(no(format!(
                    "a team goes {MAX_DEPTH} levels deep at most, and this puts {name} on level \
                     {here}. Put it under something nearer the lead."
                )));
            }
        }
        Ok(Self {
            order,
            by_key,
            root,
            siblings,
        })
    }

    /// Every profile the tree names, each once.
    pub fn profiles(&self) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for key in &self.order {
            let id = &self.by_key[key].profile;
            if !seen.iter().any(|s| s == id) {
                seen.push(id.clone());
            }
        }
        seen
    }
}

/// What a database refusal means, said as a sentence rather than dumped.
fn named(e: sqlx::Error, new: &NewAgentTeam) -> anyhow::Error {
    if let Some(db) = e.as_database_error() {
        if db.is_unique_violation() {
            return no(format!(
                "there is already a team called \"{}\" where this one would go",
                new.name.trim()
            ));
        }
        if db.is_foreign_key_violation() {
            return no("one of the profiles named is not one you can use");
        }
    }
    anyhow::Error::new(e).context("writing an agent team")
}
