//! Agent teams: a name, the profile that leads it, and a tree of positions.
//!
//! **Reach is a property of a relationship, not of an agent.** A profile is
//! identity — its name, what it does, its instructions, its skills, how it
//! runs. Where it sits, and who it may hand work to, is a *position* in a team.
//! The same Designer can have three reports in one team and none in another,
//! and nothing about the profile changes between them.
//!
//! A team is **Placed** — see `docs/paths-and-ownership.md`. It has a path, it
//! can be filed into a directory and shared, it can name a few people as
//! exceptions, and [`crate::access::filed_where`] is the only thing that
//! decides who may see one. Nothing here invents a second way to answer that.
//!
//! The lead is the root position, not a column: one place says who leads a
//! team, and a lead is a position like any other — it can carry instructions
//! that apply only here, and its children are its reach.
//!
//! **Two things in this module are load-bearing security rather than tidiness**
//! and both are the same intersection: [`AgentTeams::reports`] and
//! [`AgentTeams::positions`] resolve a position's children through
//! `filed_where` against the *profile* as well as the team, so an agent can
//! never be handed a profile its owner cannot reach — exactly as the old
//! `delegate_scope` path intersects its list with what is visible.
//!
//! This is the expand half of an expand/contract. `roles.can_delegate` and
//! `roles.delegate_scope` are untouched and keep working for a session that
//! holds no position; #497 is what removes them.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use utoipa::ToSchema;

use crate::access::{filed_where, Level};
use crate::roles::Role;

pub mod seed;
pub mod window;

/// The flag the whole feature sits behind, for the compatibility window's
/// duration.
///
/// **On unless somebody says otherwise.** A deprecation that is meant to be
/// silent cannot be opt-in: the teams have to exist and have to resolve, or
/// nobody gets the reach the seeding just materialised for them. So the flag
/// is a way *out* rather than a way in — one variable to set on an
/// installation where something about teams has gone wrong, after which every
/// session is back on `can_delegate`/`delegate_scope` with nothing lost,
/// because this is the expand half and nothing has been dropped yet.
///
/// `off`, `0`, `no` and `false` turn it off; anything else, including unset,
/// leaves it on. It goes away with #497, which is what makes the old path
/// impossible to fall back to.
pub const ENABLED_ENV: &str = "FIRETOWER_AGENT_TEAMS";

fn reads_as_off(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "off" | "0" | "no" | "false"
    )
}

/// How deep a team's tree may go, counting the lead as level one.
///
/// **This and [`MAX_POSITIONS`] are the only structural guardrail delegation
/// has**, and they are deliberately the whole of it: there is no spend cap and
/// no wall-clock cap in this work (`docs/delegation.md` is candid about that),
/// so arbitrary-depth delegation with no bound at all was not acceptable. A
/// session's position is inherited one level per spawn, so a chain of agents
/// can never be longer than the tree is deep — the limit on the shape is the
/// limit on the recursion, and there is no second rule to keep in step.
///
/// Six, which is a lead and five levels of reports beneath it. Generous enough
/// that no hand-drawn org chart reaches it, and small enough that the worst
/// case is a chain of six agents rather than one nobody can see the bottom of.
pub const MAX_DEPTH: usize = 6;

/// How many positions one team may hold, the lead included.
///
/// Sixty-four. More than anybody authors on the map #492 draws — which has to
/// stay narrower than one window on a realistic library — and far short of the
/// number at which a single `spawn` resolution stops being one indexed read.
pub const MAX_POSITIONS: usize = 64;

/// "May this person move this team" as a SQL predicate: it is in their own
/// space, or they administer the directory it is in, or they administer the
/// organisation.
///
/// The same answer `roles.rs` and `skills.rs` compute for a profile and a
/// skill, and kept local for the reason the first of them gives: it is three
/// lines, and a shared one would be one more thing to find. The question it
/// answers is *may I move this*, which is not the question `filed_where`
/// answers — that one is reused rather than restated, here as everywhere.
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

/// Why a write was refused, in a sentence somebody can act on.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

/// A team, as a list row reads it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentTeam {
    pub id: String,
    pub path: String,
    pub name: String,
    /// The profile that leads it, by id.
    ///
    /// **Absent for a team whose lead profile was deleted**, which is a real
    /// state rather than an impossible one: deleting a profile cascades onto
    /// its positions, and when the position was the root that takes the whole
    /// tree with it. The team is then an empty team with a name, and a save
    /// that names a lead is what repairs it. #494's confirmation is what tells
    /// somebody that is about to happen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    /// What that profile is called, or absent when it is filed somewhere this
    /// person cannot reach. See [`Position::profile_name`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lead_name: Option<String>,
    /// How many positions it holds, the lead included.
    pub positions: i64,
    /// How many of those positions **nobody chose** — added by a spawn during
    /// the compatibility window.
    ///
    /// Here rather than only on the tree so a list row can say *2 added
    /// automatically* without reading it. Zero for every team somebody drew,
    /// and zero again for a seeded one the moment somebody saves it, because a
    /// save is what reviewing a team means. See `agent_teams/window.rs`.
    pub auto_added: i64,
    /// Whether this team was **materialised from what its lead profile had
    /// actually spawned**, rather than drawn by somebody.
    ///
    /// True for the teams #491's seeding produced at the cut, and the reason
    /// to say so on the wire is that a team nobody authored deserves a look
    /// before it is trusted — it is a reading of history, not a decision.
    pub seeded: bool,
    /// Whether the person asking may edit or delete it.
    pub may_write: bool,
    /// Whether they may move it into a directory, or out of one.
    pub may_share: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

/// One seat, as a client reads it.
///
/// Flat, with `parent` and `order`, rather than nested: the map draws a tree
/// and a list is what a tree is cheapest to rebuild from, and a flat list is
/// what a test can assert on a position of without walking.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub id: String,
    /// The profile it references.
    pub profile: String,
    /// What that profile is called — **absent when this person cannot see the
    /// profile.**
    ///
    /// The shape of the tree belongs to the team, which they may see; the
    /// profile's name belongs to the profile, which they may not. So the seat
    /// is shown and the name is withheld, rather than the whole read being
    /// refused the way an export is. Delegation never reads this: it reads
    /// [`AgentTeams::reports`], which drops the seat entirely.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_does: Option<String>,
    /// Who it reports to. Absent for the lead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Instructions that apply in this seat and nowhere else. **Added to the
    /// profile's, never in place of them.**
    pub instructions: String,
    /// Its place among its siblings, from zero.
    pub order: i32,
    /// When the compatibility window added this seat, if it did — **absent
    /// for a seat a person chose.**
    ///
    /// The mark the map draws, and the whole mitigation for a learning phase
    /// that grows a team without anybody deciding. Saving the team clears it:
    /// a save sends the whole tree with the whole tree on screen, so a marked
    /// seat kept through one is a seat somebody has now chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_added_at: Option<chrono::DateTime<chrono::Utc>>,
}

/// A team and its tree.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct TeamWithPositions {
    #[serde(flatten)]
    pub team: AgentTeam,
    /// Every position, the lead first and then depth-first in sibling order.
    pub positions: Vec<Position>,
}

/// What the limits are, so a client refuses before the server has to.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub max_depth: usize,
    pub max_positions: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_depth: MAX_DEPTH,
            max_positions: MAX_POSITIONS,
        }
    }
}

/// One seat as a write states it. Nested, so the parent is the nesting and the
/// sibling order is the array — neither needs a client-minted id.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewPosition {
    /// An existing position to keep, so that **a save that reshapes a team
    /// does not de-position the sessions running in it.**
    ///
    /// `sessions.position_id` points at a row. A whole-tree replace that
    /// deleted and re-inserted everything would set every one of those to
    /// null, and an agent mid-run would quietly lose its reach. An id given
    /// here is updated in place instead. Omit it for a new seat; an id that
    /// is not this team's is refused rather than ignored.
    #[serde(default)]
    pub id: Option<String>,
    /// The profile this seat references, by id.
    pub profile: String,
    /// Instructions for this seat only.
    #[serde(default)]
    pub instructions: String,
    /// Its reports, in the order they should sit.
    // **`no_recursion` is not cosmetic.** The type is recursive, and without
    // it `ToSchema` expands itself forever — the document is built in a test
    // (`api::tests::the_document_describes_every_route`), so the symptom is a
    // stack overflow rather than anything subtle. With it the field is a
    // `$ref` back to this schema, which is what a recursive shape means in
    // OpenAPI and what every client generates a recursive type from.
    //
    // Not a doc comment, because utoipa copies those into the contract and
    // the three clients, and a note about Rust's schema derive is not
    // something a TypeScript reader of this field needs.
    #[serde(default)]
    #[schema(no_recursion)]
    pub children: Vec<NewPosition>,
}

/// What the API accepts to create a team or to replace its tree.
///
/// One type for both, so the shape a client sends does not depend on which
/// verb it is sending. `directory` is honoured at creation only, exactly as a
/// profile's is: moving one afterwards is the sharing endpoints' job, and
/// there is one place a thing changes hands.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentTeam {
    pub name: String,
    /// The lead, and under it the whole tree.
    pub lead: NewPosition,
    #[serde(default)]
    pub directory: Option<String>,
}

/// A session's place in a team, as everything that decides reach reads it.
#[derive(Debug, Clone)]
pub struct Standing {
    pub position: String,
    pub team: String,
    pub team_name: String,
    /// The profile this seat references.
    pub profile: String,
    /// The seat's own instructions, added to the profile's.
    pub instructions: String,
    /// The position above it, which is its lead. None for a team's lead.
    pub parent: Option<String>,
    /// Whether the team was seeded from lineage rather than drawn.
    ///
    /// Read here because the compatibility window turns on it and on nothing
    /// else: a team somebody authored is exactly what they authored, from the
    /// first spawn onwards. See `agent_teams/window.rs`.
    pub team_seeded: bool,
}

/// A profile above a position, and how far above it sits.
///
/// `steps` is 1 for the position's own lead, 2 for its lead's lead, and so on.
/// It is what lets a refusal say *where* a named profile is rather than only
/// that it is not below.
#[derive(Debug, Clone)]
pub struct Above {
    pub name: String,
    pub steps: i32,
}

/// One report: a seat, and the profile in it.
#[derive(Debug, Clone)]
pub struct Report {
    pub position: String,
    /// The seat's own instructions, which travel into the child's brief.
    pub instructions: String,
    pub profile: Role,
}

/// Everything about a tree a write has to be right about before anything is
/// written: its size, its depth, and that nothing reports to itself.
///
/// **Pure, so the limits are testable without a database.** The three it
/// cannot answer — that each profile is one this person can see, that each id
/// belongs to this team, and that the name is free — need rows, and are asked
/// inside the transaction that writes.
pub fn check(new: &NewAgentTeam) -> Result<(), Refused> {
    let name = new.name.trim();
    if name.is_empty() {
        return Err(Refused("a team needs a name".into()));
    }
    if name.chars().count() > 64 {
        return Err(Refused("a team's name is at most 64 characters".into()));
    }

    let mut counted = 0usize;
    walk(&new.lead, 1, &mut Vec::new(), &mut counted)?;
    Ok(())
}

/// The recursion behind [`check`]: depth, count, and the ancestor rule.
fn walk(
    node: &NewPosition,
    depth: usize,
    ancestors: &mut Vec<String>,
    counted: &mut usize,
) -> Result<(), Refused> {
    if node.profile.trim().is_empty() {
        return Err(Refused("every position has to name a profile".into()));
    }
    if depth > MAX_DEPTH {
        return Err(Refused(format!(
            "a team is at most {MAX_DEPTH} levels deep, counting its lead, and this one goes \
             {depth}. Delegation follows the tree one level per hand-off, so the depth here is \
             the longest chain of agents this team can produce."
        )));
    }
    *counted += 1;
    if *counted > MAX_POSITIONS {
        return Err(Refused(format!(
            "a team holds at most {MAX_POSITIONS} positions, its lead included."
        )));
    }
    /* **A profile may not report to itself, however far up.** The tree
    itself cannot cycle — a position has one parent and the lead has none —
    but a *profile* appearing under itself is a chain of agents of one kind
    handing the same work down, which is the shape with no natural end. The
    depth limit would stop it eventually; this stops it where somebody can
    still see what they drew. Two positions of one profile in different
    branches stay legal, which is what tells them apart by their own
    instructions (#494). */
    if ancestors.iter().any(|a| a == &node.profile) {
        return Err(Refused(format!(
            "`{}` already sits above this position, so it would report to itself. A profile can \
             be in a team twice, but not under itself.",
            node.profile
        )));
    }
    /* **One profile at most once among one position's children.** A lead
    hands work off by *name* — `role: "Engineer"` — so two sibling seats of
    one profile would be a name that does not say which seat is meant, and
    picking either would be the guess `at_most_one` exists to refuse. This
    is the same rule #489 applies to profile names within a directory, one
    level down: make the reference unambiguous where somebody can still see
    what they drew, rather than at the spawn that cannot be answered.
    Across the team it stays legal, which is what per-position instructions
    are for — two seats of one profile in different branches are told
    different things and are never resolved against each other. */
    for (at, child) in node.children.iter().enumerate() {
        if node.children[..at]
            .iter()
            .any(|c| c.profile == child.profile)
        {
            return Err(Refused(format!(
                "`{}` is already a direct report of this position. A lead hands work off by \
                 name, so two of one profile reporting to one position would not say which is \
                 meant. The same profile can sit elsewhere in the team.",
                child.profile
            )));
        }
    }
    ancestors.push(node.profile.clone());
    for child in &node.children {
        walk(child, depth + 1, ancestors, counted)?;
    }
    ancestors.pop();
    Ok(())
}

/// Every profile a tree names, once each.
fn profiles_named(node: &NewPosition, out: &mut Vec<String>) {
    if !out.iter().any(|p| p == &node.profile) {
        out.push(node.profile.clone());
    }
    for child in &node.children {
        profiles_named(child, out);
    }
}

/// Every existing position a tree asks to keep.
fn ids_kept(node: &NewPosition, out: &mut Vec<String>) {
    if let Some(id) = &node.id {
        out.push(id.clone());
    }
    for child in &node.children {
        ids_kept(child, out);
    }
}

/// `<name>_<tail>`, so two people's `Platform` teams do not collide on the
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

const TEAM_FIELDS: &str = "t.id, t.path::text AS path, t.name, t.created_at, t.updated_at, \
     lead.profile_id AS lead_profile, lr.name AS lead_name, \
     t.seeded_at IS NOT NULL AS seeded, \
     (SELECT count(*) FROM agent_team_positions c WHERE c.team_id = t.id) AS positions, \
     (SELECT count(*) FROM agent_team_positions c \
       WHERE c.team_id = t.id AND c.auto_added_at IS NOT NULL) AS auto_added";

/// The joins `TEAM_FIELDS` reads from: the team's lead position, and the lead's
/// profile **only when this person can see it**.
fn team_joins(person: usize) -> String {
    format!(
        "LEFT JOIN agent_team_positions lead \
                ON lead.team_id = t.id AND lead.parent_id IS NULL \
         LEFT JOIN roles lr ON lr.id = lead.profile_id AND {visible}",
        visible = filed_where("lr", person, Level::Viewer),
    )
}

fn read_team(row: &sqlx::postgres::PgRow) -> AgentTeam {
    AgentTeam {
        id: row.get("id"),
        // Slashes on the wire, dots in the database — the same conversion
        // every other Placed kind makes.
        path: ft_core::ResourcePath::from_stored(row.get::<String, _>("path")).to_string(),
        name: row.get("name"),
        lead: row.get("lead_profile"),
        lead_name: row.get("lead_name"),
        positions: row.get("positions"),
        auto_added: row.get("auto_added"),
        seeded: row.get("seeded"),
        may_write: row.get("may_write"),
        may_share: row.get("may_share"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

#[derive(Clone)]
pub struct AgentTeams {
    pool: PgPool,
    /// Whether this installation runs agent teams at all — [`ENABLED_ENV`].
    ///
    /// Held here rather than read per call, and held *here* rather than on
    /// `AppState`, because this module is the only thing that has to know. Off
    /// makes every read answer as an installation with no teams: no team is
    /// visible, no session is standing anywhere, and so `delegate` and
    /// `persona_for` take the old path without either of them carrying a
    /// branch for it. One predicate, one place, and nothing to keep in step.
    enabled: bool,
}

impl AgentTeams {
    pub fn new(pool: PgPool) -> Self {
        let enabled = match std::env::var(ENABLED_ENV) {
            Ok(value) => !reads_as_off(&value),
            Err(_) => true,
        };
        if !enabled {
            tracing::warn!(
                "agent teams are turned off ({ENABLED_ENV}): every session delegates the old \
                 way, through its profile's own reach"
            );
        }
        Self { pool, enabled }
    }

    /// The same pool with the feature off, for a test that pins what an
    /// installation which has turned it off actually does.
    ///
    /// Not an environment variable in a test: these run in parallel threads in
    /// one process, and a test that set one would decide the answer for
    /// whichever other test read it at the same moment.
    pub fn turned_off(&self) -> Self {
        Self {
            pool: self.pool.clone(),
            enabled: false,
        }
    }

    /// Whether this installation runs agent teams.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Every team this person may see, at the given level or better.
    pub async fn visible(&self, person: &str, at_least: Level) -> Result<Vec<AgentTeam>> {
        if !self.enabled {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {TEAM_FIELDS}, {writable} AS may_write, {shareable} AS may_share \
               FROM agent_teams t {joins} WHERE {visible} ORDER BY t.name",
            joins = team_joins(1),
            visible = filed_where("t", 1, at_least),
            writable = filed_where("t", 1, Level::Writer),
            shareable = shareable("t", 1),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .fetch_all(&self.pool)
            .await
            .context("reading the agent teams somebody can see")?;
        Ok(rows.iter().map(read_team).collect())
    }

    /// One team, if this person may see it.
    pub async fn one(&self, person: &str, id: &str, at_least: Level) -> Result<Option<AgentTeam>> {
        if !self.enabled {
            return Ok(None);
        }
        let sql = format!(
            "SELECT {TEAM_FIELDS}, {writable} AS may_write, {shareable} AS may_share \
               FROM agent_teams t {joins} WHERE t.id = $2 AND {visible}",
            joins = team_joins(1),
            visible = filed_where("t", 1, at_least),
            writable = filed_where("t", 1, Level::Writer),
            shareable = shareable("t", 1),
        );
        let row = sqlx::query(&sql)
            .bind(person)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading an agent team")?;
        Ok(row.as_ref().map(read_team))
    }

    /// One team and its whole tree, if this person may see it.
    pub async fn detail(
        &self,
        person: &str,
        id: &str,
        at_least: Level,
    ) -> Result<Option<TeamWithPositions>> {
        let Some(team) = self.one(person, id, at_least).await? else {
            return Ok(None);
        };
        let positions = self.positions(person, id).await?;
        Ok(Some(TeamWithPositions { team, positions }))
    }

    /// Every position in a team, the lead first and then depth-first in
    /// sibling order.
    ///
    /// The profile's name and line are joined through `filed_where`, so a seat
    /// referencing a profile this person cannot reach comes back without them
    /// rather than not at all — see [`Position::profile_name`].
    pub async fn positions(&self, person: &str, team: &str) -> Result<Vec<Position>> {
        if !self.enabled {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT p.id, p.profile_id, p.parent_id, p.instructions, p.ord, p.auto_added_at, \
                    r.name AS profile_name, r.does AS profile_does \
               FROM agent_team_positions p \
               LEFT JOIN roles r ON r.id = p.profile_id AND {visible} \
              WHERE p.team_id = $2 ORDER BY p.ord, p.id",
            visible = filed_where("r", 1, Level::Viewer),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .bind(team)
            .fetch_all(&self.pool)
            .await
            .context("reading a team's positions")?;
        let flat: Vec<Position> = rows
            .iter()
            .map(|row| Position {
                id: row.get("id"),
                profile: row.get("profile_id"),
                profile_name: row.get("profile_name"),
                profile_does: row.get("profile_does"),
                parent: row.get("parent_id"),
                instructions: row.get("instructions"),
                order: row.get("ord"),
                auto_added_at: row.get("auto_added_at"),
            })
            .collect();
        Ok(in_reading_order(flat))
    }

    /// The position a session occupies, if its owner may still see the team.
    ///
    /// **Fails closed.** A team filed somewhere its owner can no longer reach
    /// resolves to nothing, and a session with nothing resolves to the old
    /// path — which for a profile that is not a Manager is a refusal that says
    /// why. The alternative is an agent keeping a reach into a team that has
    /// been taken away from it.
    pub async fn standing(&self, person: &str, position: &str) -> Result<Option<Standing>> {
        if !self.enabled {
            return Ok(None);
        }
        let sql = format!(
            "SELECT p.id, p.team_id, t.name AS team_name, p.profile_id, p.instructions, \
                    p.parent_id, t.seeded_at IS NOT NULL AS team_seeded \
               FROM agent_team_positions p JOIN agent_teams t ON t.id = p.team_id \
              WHERE p.id = $2 AND {visible}",
            visible = filed_where("t", 1, Level::Viewer),
        );
        let row = sqlx::query(&sql)
            .bind(person)
            .bind(position)
            .fetch_optional(&self.pool)
            .await
            .context("reading the position a session holds")?;
        Ok(row.map(|r| Standing {
            position: r.get("id"),
            team: r.get("team_id"),
            team_name: r.get("team_name"),
            profile: r.get("profile_id"),
            instructions: r.get("instructions"),
            parent: r.get("parent_id"),
            team_seeded: r.get("team_seeded"),
        }))
    }

    /// The lead position of a team, if this person may see the team.
    ///
    /// What places a session at the top of a tree: a person starting work as a
    /// team stands in its lead's seat, and everything below inherits from
    /// there.
    pub async fn lead_of(&self, person: &str, team: &str) -> Result<Option<Standing>> {
        if !self.enabled {
            return Ok(None);
        }
        let sql = format!(
            "SELECT p.id FROM agent_team_positions p JOIN agent_teams t ON t.id = p.team_id \
              WHERE p.team_id = $2 AND p.parent_id IS NULL AND {visible}",
            visible = filed_where("t", 1, Level::Viewer),
        );
        let id: Option<String> = sqlx::query_scalar(&sql)
            .bind(person)
            .bind(team)
            .fetch_optional(&self.pool)
            .await
            .context("reading a team's lead position")?;
        match id {
            Some(id) => self.standing(person, &id).await,
            None => Ok(None),
        }
    }

    /// **What an agent in this position may hand work to, and nothing else.**
    ///
    /// The position's children, in sibling order, each with the whole profile
    /// it references — intersected with what this person can see, through the
    /// same `filed_where` every other read uses, on the team *and* on the
    /// profile. That intersection is the security of the feature: a profile
    /// off the list is refused exactly as a name that was never defined, and a
    /// profile the owner cannot reach is not on the list at all.
    pub async fn reports(&self, person: &str, position: &str) -> Result<Vec<Report>> {
        if !self.enabled {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT p.id AS position_id, p.instructions AS position_instructions, p.ord, \
                    {fields}, {writable} AS may_write, {shareable} AS may_share \
               FROM agent_team_positions p \
               JOIN agent_teams t ON t.id = p.team_id \
               JOIN roles r ON r.id = p.profile_id \
              WHERE p.parent_id = $2 AND {team_visible} AND {role_visible} \
              ORDER BY p.ord, p.id",
            fields = crate::roles::FIELDS,
            writable = filed_where("r", 1, Level::Writer),
            shareable = shareable("r", 1),
            team_visible = filed_where("t", 1, Level::Viewer),
            role_visible = filed_where("r", 1, Level::Viewer),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .bind(position)
            .fetch_all(&self.pool)
            .await
            .context("reading the profiles a position may hand work to")?;
        rows.into_iter()
            .map(|row| {
                Ok(Report {
                    position: row.get("position_id"),
                    instructions: row.get("position_instructions"),
                    profile: crate::roles::read(row)?,
                })
            })
            .collect()
    }

    /// **Every profile above this position, nearest first** — the chain an
    /// agent reports up through.
    ///
    /// Read so that an agent naming one of them gets a refusal that says what
    /// it did rather than "no subagent called that", which would claim a
    /// profile does not exist when it plainly does and send the agent looking
    /// for a mistake that is not there.
    ///
    /// **The whole chain and not only the parent.** The immediate lead was the
    /// first case anybody hit, but a grandparent has exactly the same problem,
    /// and with [`MAX_DEPTH`] levels permitted a chain long enough to reach
    /// one is ordinary rather than exotic.
    ///
    /// An ancestor whose profile this person cannot see is left out: there is
    /// then no name to put in a sentence, and the generic refusal is the
    /// honest one. Same intersection as everywhere else.
    ///
    /// Bounded by `MAX_DEPTH`, which is not belt-and-braces: the recursion
    /// walks `parent_id`, and a cycle written by anything other than
    /// [`AgentTeams::write`] would otherwise spin in the database rather than
    /// fail.
    pub async fn above(&self, person: &str, position: &str) -> Result<Vec<Above>> {
        if !self.enabled {
            return Ok(Vec::new());
        }
        let sql = format!(
            "WITH RECURSIVE up AS ( \
                 SELECT p.parent_id AS id, 1 AS steps \
                   FROM agent_team_positions p WHERE p.id = $2 \
                 UNION ALL \
                 SELECT a.parent_id, up.steps + 1 \
                   FROM up JOIN agent_team_positions a ON a.id = up.id \
                  WHERE up.steps < {bound} \
             ) \
             SELECT r.name AS name, up.steps AS steps \
               FROM up \
               JOIN agent_team_positions a ON a.id = up.id \
               JOIN roles r ON r.id = a.profile_id \
              WHERE {visible} ORDER BY up.steps",
            bound = MAX_DEPTH,
            visible = filed_where("r", 1, Level::Viewer),
        );
        let rows = sqlx::query(&sql)
            .bind(person)
            .bind(position)
            .fetch_all(&self.pool)
            .await
            .context("reading the profiles a position reports up through")?;
        Ok(rows
            .iter()
            .map(|r| Above {
                name: r.get("name"),
                steps: r.get("steps"),
            })
            .collect())
    }

    /// The nearest of those: an agent's own lead.
    ///
    /// [`above`](Self::above) with the first answer taken, kept as its own
    /// question because "who do I report to" is asked on its own.
    pub async fn lead_above(&self, person: &str, position: &str) -> Result<Option<String>> {
        Ok(self
            .above(person, position)
            .await?
            .into_iter()
            .next()
            .filter(|a| a.steps == 1)
            .map(|a| a.name))
    }

    /// File a new team, with its tree, in one transaction.
    ///
    /// `directory` on the body is a slug and is applied here rather than by a
    /// move afterwards, so a team never exists for a moment in the wrong
    /// place.
    pub async fn create(
        &self,
        org: &str,
        person: &str,
        person_slug: &str,
        directory: Option<&str>,
        new: &NewAgentTeam,
    ) -> Result<ft_core::AgentTeamId> {
        if !self.enabled {
            return Err(Refused(format!(
                "agent teams are turned off on this installation ({ENABLED_ENV}), so there is \
                 nothing to put a profile in. A profile's own reach is what delegation reads \
                 while they are off."
            ))
            .into());
        }
        check(new)?;
        let id = ft_core::AgentTeamId::new();
        let slug = slug_of(&new.name, id.as_str());
        let path = match directory {
            Some(directory) => ft_core::ResourcePath::in_directory(directory, &slug),
            None => ft_core::ResourcePath::personal(person_slug, &slug),
        };

        let mut tx = self.pool.begin().await?;
        // Every profile named has to be one this person can actually see.
        // Asked inside the transaction so the answer cannot change between the
        // check and the write.
        self.must_see(&mut tx, person, new).await?;
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
        .context("writing an agent team")?;
        // Fresh ids throughout: nothing exists to keep.
        write_tree(&mut tx, id.as_str(), &new.lead, false, &mut Vec::new()).await?;
        tx.commit().await?;
        Ok(id)
    }

    /// Rename a team and replace its tree. Writer on where it is filed.
    ///
    /// `false` rather than an error when they may not, for the reason every
    /// other read gives: a team you cannot reach is one you are not told
    /// exists.
    ///
    /// **An existing position named by `id` is updated in place**, so a save
    /// that reshapes a team does not set `sessions.position_id` to null under
    /// a running agent. The exception is a change of lead: the root carrying a
    /// different id — or none — re-mints the whole tree, because a team with a
    /// different lead is not the same tree and pretending otherwise would be
    /// the one case where in-place updates lie.
    pub async fn write(&self, person: &str, id: &str, new: &NewAgentTeam) -> Result<bool> {
        if !self.enabled {
            return Ok(false);
        }
        check(new)?;
        let mut tx = self.pool.begin().await?;

        let sql = format!(
            "SELECT t.id FROM agent_teams t WHERE t.id = $2 AND {writable} FOR UPDATE",
            writable = filed_where("t", 1, Level::Writer),
        );
        let mine: Option<String> = sqlx::query_scalar(&sql)
            .bind(person)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .context("reading whether somebody may change an agent team")?;
        if mine.is_none() {
            return Ok(false);
        }

        self.must_see(&mut tx, person, new).await?;

        // Which positions exist now, and which the write asks to keep. An id
        // that is not this team's is refused rather than ignored: it is either
        // a mistake or an attempt to adopt somebody else's row, and neither
        // should be answered by silently minting a new seat.
        let existing: Vec<(String, Option<String>)> = sqlx::query(
            "SELECT id, parent_id FROM agent_team_positions WHERE team_id = $1 FOR UPDATE",
        )
        .bind(id)
        .fetch_all(&mut *tx)
        .await
        .context("reading a team's positions before replacing them")?
        .into_iter()
        .map(|r| (r.get("id"), r.get("parent_id")))
        .collect();
        let mut asked = Vec::new();
        ids_kept(&new.lead, &mut asked);
        if let Some(stray) = asked
            .iter()
            .find(|want| !existing.iter().any(|(have, _)| have == *want))
        {
            return Err(Refused(format!(
                "`{stray}` is not a position in this team, so there is nothing to keep under \
                 that id. Leave the id out for a new position."
            ))
            .into());
        }

        let lead_now = existing
            .iter()
            .find(|(_, parent)| parent.is_none())
            .map(|(id, _)| id.clone());
        let same_lead = matches!((&new.lead.id, &lead_now), (Some(a), Some(b)) if a == b);

        if same_lead {
            // Pre-order, so every node's parent is already written when it is
            // reached, and the deletes come last — by which time nothing kept
            // still hangs off a seat that is going, so the cascade takes only
            // the subtrees that were actually removed.
            let mut kept = Vec::new();
            /* **The one collision a legal tree can produce**, and the
            reason it is caught here rather than left to surface as a 500.

            `agent_team_one_profile_per_parent` is checked per statement,
            and the updates above go one at a time — so two seats under one
            position that **trade** profiles collide halfway through: the
            first takes the second's profile while the second is still
            holding it. The tree being saved is legal, `check` passes it,
            and the save still cannot be done in one pass.

            There is no ordering that fixes a two-cycle and no partial
            deferrable constraint in Postgres to defer it with, so the
            honest answer is a sentence that says what to do instead.
            Everything else that index refuses, `check` has already
            refused with a better message.

            **And the advice has to be advice that works.** "Change one and
            then the other" does not: with only the two profiles between
            the two seats, either half on its own is the same collision.
            Removing a seat and adding it back is two saves that each hold,
            because by the second one nothing is still holding the profile
            being taken. The test walks exactly that path. */
            if let Err(e) = write_tree(&mut tx, id, &new.lead, true, &mut kept).await {
                return Err(if traded_profiles(&e) {
                    Refused(
                        "two of these positions report to the same one and would trade \
                         profiles, which cannot be done in a single save — for a moment both \
                         seats would hold the same profile, and a lead hands work off by name. \
                         Remove one of the two and save, then add it back with the other's \
                         profile."
                            .into(),
                    )
                    .into()
                } else {
                    e
                });
            }
            sqlx::query(
                "DELETE FROM agent_team_positions WHERE team_id = $1 AND NOT (id = ANY($2))",
            )
            .bind(id)
            .bind(&kept)
            .execute(&mut *tx)
            .await
            .context("removing the positions a team no longer holds")?;
        } else {
            sqlx::query("DELETE FROM agent_team_positions WHERE team_id = $1")
                .bind(id)
                .execute(&mut *tx)
                .await
                .context("clearing a team before its lead changes")?;
            write_tree(&mut tx, id, &new.lead, false, &mut Vec::new()).await?;
        }

        sqlx::query("UPDATE agent_teams SET name = $2, updated_at = now() WHERE id = $1")
            .bind(id)
            .bind(new.name.trim())
            .execute(&mut *tx)
            .await
            .context("renaming an agent team")?;
        tx.commit().await?;
        Ok(true)
    }

    /// Delete a team. Writer on where it lives, like changing it.
    ///
    /// Its positions go with it, and the sessions standing in them keep
    /// running — `sessions.position_id` is `on delete set null`, so they lose
    /// their reach rather than their work.
    pub async fn delete(&self, person: &str, id: &str) -> Result<bool> {
        if self.one(person, id, Level::Writer).await?.is_none() {
            return Ok(false);
        }
        sqlx::query("DELETE FROM agent_teams WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting an agent team")?;
        Ok(true)
    }

    /// Every profile a tree names has to be one this person can see.
    ///
    /// Refused rather than quietly dropped, which is what `api::roles`'
    /// `check_skills` decided for the same question and for the same reason: a
    /// team is written down and read by everybody who can reach it, so a save
    /// that kept less than the screen showed would be a team that does not do
    /// what the person was told it does. The *reads* filter as well — that is
    /// what makes an id whose profile is later filed away harmless — and this
    /// is the half that can explain itself to somebody.
    async fn must_see(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        person: &str,
        new: &NewAgentTeam,
    ) -> Result<()> {
        let mut named = Vec::new();
        profiles_named(&new.lead, &mut named);
        let sql = format!(
            "SELECT r.id FROM roles r WHERE r.id = ANY($2) AND {visible}",
            visible = filed_where("r", 1, Level::Viewer),
        );
        let seen: Vec<String> = sqlx::query_scalar(&sql)
            .bind(person)
            .bind(&named)
            .fetch_all(&mut **tx)
            .await
            .context("reading which of a team's profiles somebody can see")?;
        let missing: Vec<&str> = named
            .iter()
            .filter(|id| !seen.iter().any(|ok| ok == *id))
            .map(String::as_str)
            .collect();
        if !missing.is_empty() {
            return Err(Refused(format!(
                "{} of the profiles named aren't ones you can use, so they can't hold a \
                 position: {}",
                missing.len(),
                missing.join(", ")
            ))
            .into());
        }
        Ok(())
    }
}

/// Whether a failed write is two sibling seats trading profiles mid-save.
///
/// Read off the constraint the database names rather than matched in the
/// message text, so it stays true if the wording of either moves. Every other
/// way to reach `agent_team_one_profile_per_parent` is one [`check`] has
/// already refused by the time anything is written.
fn traded_profiles(e: &anyhow::Error) -> bool {
    e.downcast_ref::<sqlx::Error>()
        .and_then(|e| e.as_database_error())
        .and_then(|e| e.constraint())
        == Some("agent_team_one_profile_per_parent")
}

/// Write a whole tree, parents before children.
///
/// **Iterative rather than recursive**, which is not a style choice: an
/// `async fn` that calls itself needs boxing, and a plain work stack says the
/// same thing without a `Pin<Box<dyn Future>>` in the middle of a transaction.
/// Pre-order is what the ordering guarantee rests on — a node is written
/// before any of its children name it as a parent.
///
/// `keep` is what tells the two write paths apart. With it on, a node carrying
/// an existing id is updated in place, so `sessions.position_id` survives the
/// save; with it off every seat is minted fresh. Either way `kept` comes back
/// holding every id that now exists, which is what the delete afterwards
/// spares.
async fn write_tree(
    tx: &mut Transaction<'_, Postgres>,
    team: &str,
    lead: &NewPosition,
    keep: bool,
    kept: &mut Vec<String>,
) -> Result<()> {
    let mut stack: Vec<(&NewPosition, Option<String>, i32)> = vec![(lead, None, 0)];
    while let Some((node, parent, order)) = stack.pop() {
        let (id, existing) = match (keep, &node.id) {
            (true, Some(id)) => (id.clone(), true),
            _ => (ft_core::PositionId::new().as_str().to_string(), false),
        };
        write_position(tx, &id, team, parent.as_deref(), node, order, existing).await?;
        kept.push(id.clone());
        for (i, child) in node.children.iter().enumerate().rev() {
            stack.push((child, Some(id.clone()), i as i32));
        }
    }
    Ok(())
}

/// One seat written, either way.
///
/// `ord` is normalised to the array index here and nowhere else, which is what
/// lets the column be plain rather than unique — see the migration.
///
/// **An in-place update clears `auto_added_at`**, which is how a seat the
/// compatibility window added stops being marked. A save carries the whole
/// tree, and the person sending it had the whole tree on screen with every
/// mark drawn on it — so a marked seat that survives a save is one they have
/// now chosen, and that is the whole of what reviewing a team means. There is
/// deliberately no accept-this-seat endpoint: a second way to clear the mark
/// would be a second answer to "who decided this".
async fn write_position(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    team: &str,
    parent: Option<&str>,
    node: &NewPosition,
    order: i32,
    existing: bool,
) -> Result<()> {
    if existing {
        sqlx::query(
            "UPDATE agent_team_positions \
                SET profile_id = $2, parent_id = $3, instructions = $4, ord = $5, \
                    auto_added_at = NULL \
              WHERE id = $1 AND team_id = $6",
        )
        .bind(id)
        .bind(node.profile.trim())
        .bind(parent)
        .bind(node.instructions.trim())
        .bind(order)
        .bind(team)
        .execute(&mut **tx)
        .await
        .context("moving a position")?;
    } else {
        sqlx::query(
            "INSERT INTO agent_team_positions \
               (id, team_id, profile_id, parent_id, instructions, ord) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(team)
        .bind(node.profile.trim())
        .bind(parent)
        .bind(node.instructions.trim())
        .bind(order)
        .execute(&mut **tx)
        .await
        .context("writing a position")?;
    }
    Ok(())
}

/// The lead first, then each subtree depth-first in sibling order.
///
/// The read comes back ordered by `ord` alone, which is right within one
/// parent and says nothing across parents. A list a person reads — or a test
/// asserts on — wants the shape, so it is rebuilt here rather than in three
/// clients.
fn in_reading_order(flat: Vec<Position>) -> Vec<Position> {
    let mut out: Vec<Position> = Vec::with_capacity(flat.len());
    let mut frontier: Vec<Option<String>> = vec![None];
    while let Some(parent) = frontier.pop() {
        let mut children: Vec<&Position> = flat.iter().filter(|p| p.parent == parent).collect();
        children.sort_by(|a, b| a.order.cmp(&b.order).then(a.id.cmp(&b.id)));
        // Pushed in reverse so the first sibling is taken next: depth-first,
        // left to right, which is how the map draws it.
        for child in children.into_iter().rev() {
            frontier.push(Some(child.id.clone()));
        }
        if let Some(id) = parent {
            if let Some(found) = flat.iter().find(|p| p.id == id) {
                out.push(found.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat(profile: &str, children: Vec<NewPosition>) -> NewPosition {
        NewPosition {
            id: None,
            profile: profile.into(),
            instructions: String::new(),
            children,
        }
    }

    fn team(lead: NewPosition) -> NewAgentTeam {
        NewAgentTeam {
            name: "Platform".into(),
            lead,
            directory: None,
        }
    }

    #[test]
    fn a_team_needs_a_name_and_a_lead_with_a_profile() {
        let mut no_name = team(seat("role_a", vec![]));
        no_name.name = "   ".into();
        assert!(check(&no_name).is_err());
        assert!(check(&team(seat("", vec![]))).is_err());
        assert!(check(&team(seat("role_a", vec![]))).is_ok());
    }

    /// The depth limit counts the lead, so `MAX_DEPTH` levels pass and one
    /// more does not. Built as a chain, which is the shape that reaches the
    /// limit first.
    #[test]
    fn the_depth_limit_counts_the_lead() {
        let chain = |levels: usize| {
            let mut node = seat("role_last", vec![]);
            for i in (0..levels.saturating_sub(1)).rev() {
                node = seat(&format!("role_{i}"), vec![node]);
            }
            team(node)
        };
        assert!(
            check(&chain(MAX_DEPTH)).is_ok(),
            "{MAX_DEPTH} levels is fine"
        );
        let too_deep = check(&chain(MAX_DEPTH + 1)).expect_err("one more is not");
        assert!(
            too_deep.0.contains(&MAX_DEPTH.to_string()),
            "the refusal says what the limit is: {}",
            too_deep.0
        );
    }

    /// The count limit, and the sentence that says what it is.
    #[test]
    fn a_team_holds_at_most_the_stated_number_of_positions() {
        let wide = |n: usize| {
            team(seat(
                "role_lead",
                (0..n).map(|i| seat(&format!("role_{i}"), vec![])).collect(),
            ))
        };
        assert!(
            check(&wide(MAX_POSITIONS - 1)).is_ok(),
            "the lead plus the rest"
        );
        let too_many = check(&wide(MAX_POSITIONS)).expect_err("one over");
        assert!(
            too_many.0.contains(&MAX_POSITIONS.to_string()),
            "the refusal says what the limit is: {}",
            too_many.0
        );
    }

    /// A profile may sit in a team twice — that is what per-position
    /// instructions are for — but never beneath itself, and never twice under
    /// one position.
    #[test]
    fn a_profile_may_be_in_a_team_twice_but_not_under_itself() {
        // Two seats of one profile, in different branches: legal, and told
        // apart by what each seat says.
        let twice = team(seat(
            "role_lead",
            vec![
                seat("role_a", vec![seat("role_eng", vec![])]),
                seat("role_b", vec![seat("role_eng", vec![])]),
            ],
        ));
        assert!(
            check(&twice).is_ok(),
            "two seats, one profile, two branches"
        );

        // Two of one profile reporting to the *same* position: a name that
        // does not say which is meant.
        let ambiguous = team(seat(
            "role_lead",
            vec![seat("role_eng", vec![]), seat("role_eng", vec![])],
        ));
        let refused = check(&ambiguous).expect_err("two siblings of one profile");
        assert!(
            refused.0.contains("already a direct report"),
            "the refusal says what the clash was: {}",
            refused.0
        );

        let under_itself = team(seat("role_lead", vec![seat("role_lead", vec![])]));
        let refused = check(&under_itself).expect_err("a profile under itself");
        assert!(
            refused.0.contains("report to itself"),
            "the refusal says what the shape was: {}",
            refused.0
        );
    }

    /// Reading order is the lead, then each subtree in full, left to right —
    /// not every sibling of one depth before the next.
    #[test]
    fn reading_order_is_depth_first_from_the_lead() {
        let p = |id: &str, parent: Option<&str>, order: i32| Position {
            id: id.into(),
            profile: "role_x".into(),
            profile_name: None,
            profile_does: None,
            parent: parent.map(str::to_string),
            instructions: String::new(),
            order,
            auto_added_at: None,
        };
        // lead → a (→ a1, a2), b
        let flat = vec![
            p("a1", Some("a"), 0),
            p("b", Some("lead"), 1),
            p("lead", None, 0),
            p("a2", Some("a"), 1),
            p("a", Some("lead"), 0),
        ];
        let order: Vec<String> = in_reading_order(flat).into_iter().map(|p| p.id).collect();
        assert_eq!(order, vec!["lead", "a", "a1", "a2", "b"]);
    }
    // ── against a real database ─────────────────────────────────────────
    //
    // The unit tests above own the arithmetic of the limits. Everything below
    // is what they cannot reach: that a team is filed and permissioned exactly
    // as a profile is, that one profile in two teams has two sets of children,
    // and that a save keeps the seats a running session is standing in.

    use crate::accounts::Accounts;
    use crate::db::Db;

    struct World {
        db: Db,
        teams: AgentTeams,
        roles: crate::roles::Roles,
        accounts: Accounts,
        org: String,
        me: String,
        my_slug: String,
    }

    async fn world() -> World {
        let (db, me) = Db::open_for_test_owned().await.unwrap();
        let pool = db.pool().clone();
        let org = db.org().await.unwrap();
        let my_slug: String = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
            .bind(&me)
            .fetch_one(&pool)
            .await
            .unwrap();
        World {
            teams: AgentTeams::new(pool.clone()),
            roles: crate::roles::Roles::new(pool.clone()),
            accounts: Accounts::new(pool.clone()),
            db,
            org,
            me,
            my_slug,
        }
    }

    impl World {
        /// A profile, through the same `check` the API applies.
        async fn profile(&self, name: &str) -> String {
            self.profile_of(&self.me, &self.my_slug, name).await
        }

        async fn profile_of(&self, person: &str, slug: &str, name: &str) -> String {
            let new: crate::roles::NewRole = serde_json::from_value(serde_json::json!({
                "name": name,
                "does": format!("{name}, and when to reach for it"),
                "placement": "here",
                "instructions": format!("How {name} works"),
            }))
            .unwrap();
            crate::roles::check(&new).unwrap();
            self.roles
                .create(&self.org, person, slug, &new)
                .await
                .unwrap()
                .as_str()
                .to_string()
        }

        /// A profile that could hand work off: what the old arrangement
        /// called a Manager, and the only kind the seeding builds a team
        /// for.
        async fn manager(&self, name: &str) -> String {
            let id = self.profile(name).await;
            sqlx::query("UPDATE roles SET can_delegate = true WHERE id = $1")
                .bind(&id)
                .execute(self.db.pool())
                .await
                .unwrap();
            id
        }

        /// One hand-off that actually happened: a session running `lead`, and
        /// a child of it running `child`.
        ///
        /// Written as rows rather than through a launch because that is
        /// exactly what the seeding reads — `sessions.parent_id` and the two
        /// `profile_id`s, and nothing else about either session.
        async fn spawned(&self, lead: &str, child: &str) {
            let parent = self.session(lead, None).await;
            self.session(child, Some(&parent)).await;
        }

        async fn session(&self, profile: &str, parent: Option<&str>) -> String {
            let workspace = self.workspace().await;
            let id = ft_core::SessionId::new().as_str().to_string();
            sqlx::query(
                "INSERT INTO sessions \
                   (id, user_id, workspace_id, title, prompt, agent, status, profile_id, \
                    parent_id) \
                 VALUES ($1, $2, $5, 'seeding', 'do it', 'claude', 'Finished', $3, $4)",
            )
            .bind(&id)
            .bind(&self.me)
            .bind(profile)
            .bind(parent)
            .bind(&workspace)
            .execute(self.db.pool())
            .await
            .unwrap();
            id
        }

        /// One workspace for all of this fixture's sessions, which is what
        /// `placement: "here"` produces anyway.
        async fn workspace(&self) -> String {
            let host = self.db.ensure_test_host("seeding", &self.me).await.unwrap();
            sqlx::query(
                "INSERT INTO workspaces (id, created_by, host_id, name, path) \
                 VALUES ('w_seeding', $1, $2, 'seeding', ('u.' || $3 || '.seeding')::ltree) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(&self.me)
            .bind(host.id.as_str())
            .bind(&self.my_slug)
            .execute(self.db.pool())
            .await
            .unwrap();
            "w_seeding".to_string()
        }

        /// What the one team this fixture produced holds, lead first.
        async fn team_named(&self, name: &str) -> (AgentTeam, Vec<String>) {
            let team = self
                .teams
                .visible(&self.me, Level::Viewer)
                .await
                .unwrap()
                .into_iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("a team called {name}"));
            let seats = self.teams.positions(&self.me, &team.id).await.unwrap();
            let profiles = seats.iter().map(|p| p.profile.clone()).collect();
            (team, profiles)
        }

        async fn colleague(&self, name: &str) -> (String, String) {
            let org = ft_core::OrgId::from_stored(self.org.clone());
            let who = self
                .accounts
                .create_user(&org, name, &format!("{name}@example.test"), "member")
                .await
                .unwrap()
                .0
                .id
                .as_str()
                .to_string();
            let slug: String = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
                .bind(&who)
                .fetch_one(self.db.pool())
                .await
                .unwrap();
            (who, slug)
        }
    }

    fn named(name: &str, lead: NewPosition) -> NewAgentTeam {
        NewAgentTeam {
            name: name.into(),
            lead,
            directory: None,
        }
    }

    /// Filed, shared and permissioned exactly as a profile is — which means
    /// through the one predicate and nothing else.
    ///
    /// A colleague with no grant is not told it exists; an exception named on
    /// the team is the fourth route in and reaches it; and `Viewer` is not
    /// `Writer`, so somebody given a look cannot rewrite the tree.
    #[tokio::test]
    async fn a_team_is_filed_and_permissioned_exactly_as_a_profile_is() {
        let w = world().await;
        let lead = w.profile("Orchestrator").await;
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Platform", seat(&lead, vec![])),
            )
            .await
            .unwrap();
        let (ana, _) = w.colleague("ana").await;

        assert_eq!(
            w.teams.visible(&w.me, Level::Viewer).await.unwrap().len(),
            1,
            "mine, in my own space"
        );
        assert!(
            w.teams
                .visible(&ana, Level::Viewer)
                .await
                .unwrap()
                .is_empty(),
            "a colleague with no grant is not told it exists"
        );

        let access = crate::access::Access::new(w.db.pool().clone());
        access
            .set_exception(
                crate::access::FiledKind::AgentTeam,
                id.as_str(),
                &ana,
                Level::Viewer,
            )
            .await
            .unwrap();
        let hers = w.teams.visible(&ana, Level::Viewer).await.unwrap();
        assert_eq!(hers.len(), 1, "named on the team, and reaching it");
        assert!(!hers[0].may_write, "a look is not a licence to rewrite it");
        assert!(
            w.teams
                .one(&ana, id.as_str(), Level::Writer)
                .await
                .unwrap()
                .is_none(),
            "and Writer is absent rather than refused"
        );
        assert!(
            !w.teams
                .write(&ana, id.as_str(), &named("Hers", seat(&lead, vec![])))
                .await
                .unwrap(),
            "so her save does nothing"
        );
    }

    /// **The sentence the whole ticket exists for.** The same profile in two
    /// teams has different children and different extra instructions, with
    /// identical name, description, instructions and skills.
    #[tokio::test]
    async fn one_profile_in_two_teams_has_two_sets_of_children() {
        let w = world().await;
        let designer = w.profile("Designer").await;
        let illustrator = w.profile("Illustrator").await;
        let writer = w.profile("Writer").await;

        // In Studio the Designer has two reports and a note about this team.
        let studio = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named(
                    "Studio",
                    NewPosition {
                        id: None,
                        profile: designer.clone(),
                        instructions: "In Studio, ship the brand system first.".into(),
                        children: vec![seat(&illustrator, vec![]), seat(&writer, vec![])],
                    },
                ),
            )
            .await
            .unwrap();
        // In Platform the same Designer leads nobody.
        let platform = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named(
                    "Platform",
                    NewPosition {
                        id: None,
                        profile: designer.clone(),
                        instructions: "In Platform, only the console.".into(),
                        children: vec![],
                    },
                ),
            )
            .await
            .unwrap();

        let in_studio = w
            .teams
            .lead_of(&w.me, studio.as_str())
            .await
            .unwrap()
            .unwrap();
        let in_platform = w
            .teams
            .lead_of(&w.me, platform.as_str())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(in_studio.profile, in_platform.profile, "one profile");
        assert_ne!(in_studio.position, in_platform.position, "two positions");
        assert_eq!(
            w.teams
                .reports(&w.me, &in_studio.position)
                .await
                .unwrap()
                .iter()
                .map(|r| r.profile.name.clone())
                .collect::<Vec<_>>(),
            vec!["Illustrator", "Writer"],
            "three reports in one team"
        );
        assert!(
            w.teams
                .reports(&w.me, &in_platform.position)
                .await
                .unwrap()
                .is_empty(),
            "and none in the other"
        );
        assert_ne!(
            in_studio.instructions, in_platform.instructions,
            "different extra instructions"
        );

        // And the profile itself is one row, unchanged by either.
        let row = w
            .roles
            .one(&w.me, &designer, Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.name, "Designer");
        assert_eq!(row.instructions, "How Designer works");
        assert!(
            row.delegate_scope.is_empty(),
            "nothing about reach is written onto the profile"
        );
    }

    /// Adding a profile that leads another team creates a position with no
    /// children, and the other team is unchanged. **Nothing travels.**
    #[tokio::test]
    async fn importing_a_lead_of_another_team_brings_nothing_with_it() {
        let w = world().await;
        let (qa, eng, ops) = (
            w.profile("QA").await,
            w.profile("Engineer").await,
            w.profile("Ops").await,
        );
        // QA leads its own team, with two reports.
        let theirs = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named(
                    "QA's own",
                    seat(&qa, vec![seat(&eng, vec![]), seat(&ops, vec![])]),
                ),
            )
            .await
            .unwrap();
        // And is given a seat in another team.
        let mine = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Mine", seat(&eng, vec![seat(&qa, vec![])])),
            )
            .await
            .unwrap();

        let here = w.teams.positions(&w.me, mine.as_str()).await.unwrap();
        let qa_here = here.iter().find(|p| p.profile == qa).unwrap();
        assert!(
            w.teams
                .reports(&w.me, &qa_here.id)
                .await
                .unwrap()
                .is_empty(),
            "the seat comes with nothing under it"
        );
        let there = w
            .teams
            .lead_of(&w.me, theirs.as_str())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            w.teams.reports(&w.me, &there.position).await.unwrap().len(),
            2,
            "and the other team is exactly as it was"
        );
    }

    /// A save keeps the seats it names, and **a session standing in one keeps
    /// its place**. Sibling order is explicit, so swapping two is a save.
    #[tokio::test]
    async fn a_save_keeps_the_seats_it_names_and_removes_the_rest() {
        let w = world().await;
        let (lead, a, b, c) = (
            w.profile("Lead").await,
            w.profile("A").await,
            w.profile("B").await,
            w.profile("C").await,
        );
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named(
                    "Platform",
                    seat(
                        &lead,
                        vec![seat(&a, vec![seat(&c, vec![])]), seat(&b, vec![])],
                    ),
                ),
            )
            .await
            .unwrap();
        let before = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        let find = |rows: &[Position], profile: &str| {
            rows.iter().find(|p| p.profile == profile).unwrap().clone()
        };
        let (was_lead, was_a, was_b, was_c) = (
            find(&before, &lead),
            find(&before, &a),
            find(&before, &b),
            find(&before, &c),
        );
        assert_eq!(
            before.iter().map(|p| p.profile.clone()).collect::<Vec<_>>(),
            vec![lead.clone(), a.clone(), c.clone(), b.clone()],
            "the lead, then each subtree in full"
        );

        // Swap A and B, keep A's subtree, drop C.
        w.teams
            .write(
                &w.me,
                id.as_str(),
                &named(
                    "Platform",
                    NewPosition {
                        id: Some(was_lead.id.clone()),
                        profile: lead.clone(),
                        instructions: String::new(),
                        children: vec![
                            NewPosition {
                                id: Some(was_b.id.clone()),
                                profile: b.clone(),
                                instructions: String::new(),
                                children: vec![],
                            },
                            NewPosition {
                                id: Some(was_a.id.clone()),
                                profile: a.clone(),
                                instructions: "Now with a note.".into(),
                                children: vec![],
                            },
                        ],
                    },
                ),
            )
            .await
            .unwrap();

        let after = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        assert_eq!(
            after.iter().map(|p| p.profile.clone()).collect::<Vec<_>>(),
            vec![lead.clone(), b.clone(), a.clone()],
            "B first now, and C gone"
        );
        assert_eq!(
            find(&after, &a).id,
            was_a.id,
            "A is the same row, so a session standing in it still is"
        );
        assert_eq!(find(&after, &a).instructions, "Now with a note.");
        assert!(
            w.teams.standing(&w.me, &was_c.id).await.unwrap().is_none(),
            "and the removed seat is gone rather than orphaned"
        );
    }

    /// An id from somewhere else is refused rather than quietly minted into a
    /// new seat.
    #[tokio::test]
    async fn an_id_that_is_not_this_teams_is_refused() {
        let w = world().await;
        let lead = w.profile("Lead").await;
        let other = w.profile("Other").await;
        let mine = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Mine", seat(&lead, vec![])),
            )
            .await
            .unwrap();
        let theirs = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Theirs", seat(&other, vec![])),
            )
            .await
            .unwrap();
        let elsewhere = w
            .teams
            .lead_of(&w.me, theirs.as_str())
            .await
            .unwrap()
            .unwrap();
        let mine_lead = w
            .teams
            .lead_of(&w.me, mine.as_str())
            .await
            .unwrap()
            .unwrap();

        let refused = w
            .teams
            .write(
                &w.me,
                mine.as_str(),
                &named(
                    "Mine",
                    NewPosition {
                        id: Some(mine_lead.position.clone()),
                        profile: lead.clone(),
                        instructions: String::new(),
                        children: vec![NewPosition {
                            id: Some(elsewhere.position.clone()),
                            profile: other.clone(),
                            instructions: String::new(),
                            children: vec![],
                        }],
                    },
                ),
            )
            .await
            .expect_err("an id from another team");
        assert!(
            format!("{refused}").contains("not a position in this team"),
            "{refused}"
        );
    }

    /// **The intersection, which is the security of the feature.** A seat
    /// whose profile this person cannot reach is not a report, and its name is
    /// withheld from the map rather than the seat being hidden.
    #[tokio::test]
    async fn a_seat_whose_profile_nobody_can_see_is_not_a_report() {
        let w = world().await;
        let (ana, ana_slug) = w.colleague("ana").await;
        let lead = w.profile_of(&ana, &ana_slug, "Hers").await;
        let secret = w.profile_of(&ana, &ana_slug, "Secret").await;
        // Ana's team, with both of her own profiles in it.
        let id = w
            .teams
            .create(
                &w.org,
                &ana,
                &ana_slug,
                None,
                &named("Hers", seat(&lead, vec![seat(&secret, vec![])])),
            )
            .await
            .unwrap();

        // She shares the team with me, and neither profile.
        let access = crate::access::Access::new(w.db.pool().clone());
        access
            .set_exception(
                crate::access::FiledKind::AgentTeam,
                id.as_str(),
                &w.me,
                Level::Viewer,
            )
            .await
            .unwrap();

        let standing = w.teams.lead_of(&w.me, id.as_str()).await.unwrap().unwrap();
        assert!(
            w.teams
                .reports(&w.me, &standing.position)
                .await
                .unwrap()
                .is_empty(),
            "a profile I cannot reach is not something I can be handed"
        );
        assert_eq!(
            w.teams
                .reports(&ana, &standing.position)
                .await
                .unwrap()
                .len(),
            1,
            "and is exactly one for her"
        );
        let seen = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        assert_eq!(seen.len(), 2, "the shape of the tree is the team's");
        assert!(
            seen.iter().all(|p| p.profile_name.is_none()),
            "and the names are the profiles', withheld"
        );
    }

    /// A team cannot be written naming a profile its author cannot see.
    #[tokio::test]
    async fn a_team_cannot_name_a_profile_its_author_cannot_see() {
        let w = world().await;
        let (ana, ana_slug) = w.colleague("ana").await;
        let mine = w.profile("Mine").await;
        let hers = w.profile_of(&ana, &ana_slug, "Hers").await;
        let refused = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Mine", seat(&mine, vec![seat(&hers, vec![])])),
            )
            .await
            .expect_err("naming somebody else's profile");
        assert!(
            format!("{refused}").contains("aren't ones you can use"),
            "{refused}"
        );
    }

    /// Deleting a profile takes its seats and everything under them, which is
    /// what makes #494's confirmation a true statement about what will happen.
    #[tokio::test]
    async fn deleting_a_profile_takes_its_seats_and_their_children() {
        let w = world().await;
        let (lead, mid, leaf) = (
            w.profile("Lead").await,
            w.profile("Mid").await,
            w.profile("Leaf").await,
        );
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named(
                    "Platform",
                    seat(&lead, vec![seat(&mid, vec![seat(&leaf, vec![])])]),
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            w.teams.positions(&w.me, id.as_str()).await.unwrap().len(),
            3
        );
        assert!(w.roles.delete(&w.me, &mid).await.unwrap());
        assert_eq!(
            w.teams
                .positions(&w.me, id.as_str())
                .await
                .unwrap()
                .iter()
                .map(|p| p.profile.clone())
                .collect::<Vec<_>>(),
            vec![lead],
            "the seat and the one under it went with it"
        );
    }
    /// Filed into a directory through the one operation that moves anything,
    /// and reachable there by whoever the directory is granted to.
    ///
    /// `access::transfer` takes a `FiledKind` and an id and nothing else, so
    /// this is the proof that a team joined that list rather than growing a
    /// move of its own — and that the sharing endpoints, which call exactly
    /// this, work on one without a line being written for them.
    #[tokio::test]
    async fn a_team_files_into_a_directory_through_the_one_transfer() {
        let w = world().await;
        let lead = w.profile("Orchestrator").await;
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Platform", seat(&lead, vec![])),
            )
            .await
            .unwrap();
        let (ana, _) = w.colleague("ana").await;

        sqlx::query(
            "INSERT INTO directories (id, org_id, name, slug) VALUES ('d_b', $1, 'Backend', 'backend')",
        )
        .bind(&w.org)
        .execute(w.db.pool())
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO grants (directory_id, subject_kind, subject_id, level) \
             VALUES ('d_b', 'person', $1, 'writer')",
        )
        .bind(&ana)
        .execute(w.db.pool())
        .await
        .unwrap();

        let access = crate::access::Access::new(w.db.pool().clone());
        let vault = crate::vault::Vault::new(
            w.db.pool().clone(),
            crate::vault::crypto::RootKey::generate(),
        );
        let from = access
            .path_of(crate::access::FiledKind::AgentTeam, id.as_str())
            .await
            .unwrap()
            .unwrap();
        access
            .transfer(
                &vault,
                crate::access::FiledKind::AgentTeam,
                id.as_str(),
                &from.moved_to(ft_core::path::DIRECTORY, "backend"),
                "admin",
            )
            .await
            .unwrap();

        let hers = w.teams.visible(&ana, Level::Writer).await.unwrap();
        assert_eq!(hers.len(), 1, "filing it handed it to the directory");
        assert_eq!(
            hers[0].path,
            "d/backend/platform_".to_string()
                + &hers[0].path[hers[0].path.rfind('_').unwrap() + 1..]
        );
        assert!(hers[0].may_write, "and a writer there may change it");
    }
    /// Deleting the profile that *leads* a team empties the team rather than
    /// deleting it, and a save with a new lead repairs it.
    ///
    /// The cascade runs from the root position, so it takes the whole tree.
    /// That is the approved behaviour — a profile's deletion is confirmed
    /// against the teams it is in — and what matters here is that nothing
    /// panics over a team with no lead and that it is not a dead row.
    #[tokio::test]
    async fn deleting_a_leads_profile_empties_the_team_and_a_save_repairs_it() {
        let w = world().await;
        let (lead, report, successor) = (
            w.profile("Lead").await,
            w.profile("Report").await,
            w.profile("Successor").await,
        );
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Platform", seat(&lead, vec![seat(&report, vec![])])),
            )
            .await
            .unwrap();
        assert!(w.roles.delete(&w.me, &lead).await.unwrap());

        let now = w
            .teams
            .one(&w.me, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .expect("the team is still there");
        assert_eq!(now.positions, 0, "the cascade ran from the root");
        assert!(now.lead.is_none(), "so it has nobody leading it");
        assert!(now.lead_name.is_none());
        assert!(
            w.teams.lead_of(&w.me, id.as_str()).await.unwrap().is_none(),
            "and nothing to stand in"
        );

        assert!(w
            .teams
            .write(
                &w.me,
                id.as_str(),
                &named("Platform", seat(&successor, vec![]))
            )
            .await
            .unwrap());
        let repaired = w
            .teams
            .one(&w.me, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(repaired.lead.as_deref(), Some(successor.as_str()));
        assert_eq!(repaired.positions, 1);
    }
    /// The chain above a position, nearest first — and **an ancestor whose
    /// profile this person cannot see is left out of it.**
    ///
    /// The ordering is what lets a refusal say *where* a named profile sits,
    /// and the omission is the same intersection every other read makes: a
    /// refusal that named a profile the asker cannot reach would disclose it
    /// in the course of being helpful.
    #[tokio::test]
    async fn the_chain_above_a_position_is_nearest_first_and_intersected() {
        let w = world().await;
        let (ana, ana_slug) = w.colleague("ana").await;
        // Ana's team, four deep, with the *middle* profile hers alone and the
        // other three shared with me.
        let top = w.profile_of(&ana, &ana_slug, "Top").await;
        let hidden = w.profile_of(&ana, &ana_slug, "Hidden").await;
        let mid = w.profile_of(&ana, &ana_slug, "Mid").await;
        let leaf = w.profile_of(&ana, &ana_slug, "Leaf").await;
        let id = w
            .teams
            .create(
                &w.org,
                &ana,
                &ana_slug,
                None,
                &named(
                    "Hers",
                    seat(
                        &top,
                        vec![seat(&hidden, vec![seat(&mid, vec![seat(&leaf, vec![])])])],
                    ),
                ),
            )
            .await
            .unwrap();

        let access = crate::access::Access::new(w.db.pool().clone());
        for on in [id.as_str()] {
            access
                .set_exception(
                    crate::access::FiledKind::AgentTeam,
                    on,
                    &w.me,
                    Level::Viewer,
                )
                .await
                .unwrap();
        }
        for profile in [&top, &mid, &leaf] {
            access
                .set_exception(
                    crate::access::FiledKind::Role,
                    profile,
                    &w.me,
                    Level::Viewer,
                )
                .await
                .unwrap();
        }

        let seats = w.teams.positions(&ana, id.as_str()).await.unwrap();
        let bottom = seats.iter().find(|p| p.profile == leaf).unwrap();

        // For Ana, the whole chain, nearest first.
        let hers = w.teams.above(&ana, &bottom.id).await.unwrap();
        assert_eq!(
            hers.iter()
                .map(|a| (a.name.as_str(), a.steps))
                .collect::<Vec<_>>(),
            vec![("Mid", 1), ("Hidden", 2), ("Top", 3)],
            "nearest first, with how far up each one is"
        );
        assert_eq!(
            w.teams
                .lead_above(&ana, &bottom.id)
                .await
                .unwrap()
                .as_deref(),
            Some("Mid"),
            "and the nearest on its own"
        );

        // For me, the one I cannot reach is simply not there — and the step
        // counts of the others do not shift to cover the gap, because they are
        // how far up the position actually is.
        let mine = w.teams.above(&w.me, &bottom.id).await.unwrap();
        assert_eq!(
            mine.iter()
                .map(|a| (a.name.as_str(), a.steps))
                .collect::<Vec<_>>(),
            vec![("Mid", 1), ("Top", 3)],
            "no Hidden, and Top is still three up"
        );
    }

    // ── seeding from session lineage (#491) ─────────────────────────────
    //
    // The old default meant *anything the owner can see*, which cannot become
    // a tree, so each team is materialised from what its lead profile
    // actually spawned. These are that, against fixture lineage: what a team
    // comes out holding, what the empty case produces, what happens past the
    // limits, and that the cut does not re-assert itself.

    /// **The ticket's own sentence.** A delegating profile gets a team named
    /// after it, holding the profiles it actually spawned — and nothing else
    /// it merely could have.
    #[tokio::test]
    async fn a_team_is_seeded_from_what_a_profile_actually_spawned() {
        let w = world().await;
        let orchestrator = w.manager("Orchestrator").await;
        let engineer = w.profile("Engineer").await;
        let reviewer = w.profile("Reviewer").await;
        // Visible to the same person, reachable under the old default, and
        // never once used. The whole reason a visibility snapshot was not the
        // answer.
        let unused = w.profile("Unused").await;

        w.spawned(&orchestrator, &engineer).await;
        w.spawned(&orchestrator, &reviewer).await;
        // Twice, which is one position and not two.
        w.spawned(&orchestrator, &engineer).await;

        let done = seed::seed(&w.teams, &w.org).await.unwrap().unwrap();
        assert_eq!(done.teams, 1, "one delegating profile, one team");
        assert_eq!(done.positions, 3, "its lead and the two it spawned");
        assert!(done.truncated.is_empty());

        let (team, seats) = w.team_named("Orchestrator").await;
        assert!(team.seeded, "a team nobody drew says so");
        assert_eq!(team.lead.as_deref(), Some(orchestrator.as_str()));
        assert_eq!(team.positions, 3);
        assert_eq!(
            team.auto_added, 0,
            "seeded is not the same as added behind somebody's back — the team says it was \
             materialised, and no seat claims the window put it there"
        );
        assert_eq!(seats[0], orchestrator, "the lead reads first");
        assert!(seats.contains(&engineer) && seats.contains(&reviewer));
        assert!(
            !seats.contains(&unused),
            "a profile it could have reached and never did is not a report"
        );
        assert_eq!(seats.len(), 3);

        // One level, because a child cannot spawn today, so there is no
        // deeper lineage to read.
        let under: Vec<Option<String>> = w
            .teams
            .positions(&w.me, &team.id)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.parent)
            .collect();
        let lead_seat = under[0].clone();
        assert!(lead_seat.is_none(), "the lead has nobody above it");
        assert!(
            under[1..].iter().all(|p| p.is_some()),
            "and everything else reports straight to it: {under:?}"
        );

        // And nothing was made for a profile that could not delegate, however
        // much of it there is in the lineage.
        assert!(
            w.teams
                .visible(&w.me, Level::Viewer)
                .await
                .unwrap()
                .iter()
                .all(|t| t.name == "Orchestrator"),
            "only the delegating profile gets one"
        );
    }

    /// **A profile that never spawned gets an empty team, not a missing one.**
    ///
    /// The team is where reach is authored now, so arriving with nowhere to
    /// author it would be the break the seeding exists to avoid.
    #[tokio::test]
    async fn a_profile_that_never_spawned_gets_an_empty_team() {
        let w = world().await;
        let quiet = w.manager("Quiet").await;
        let _never_used = w.profile("Engineer").await;

        let done = seed::seed(&w.teams, &w.org).await.unwrap().unwrap();
        assert_eq!(done.teams, 1);
        assert_eq!(done.positions, 1, "the lead, and nobody under it");

        let (team, seats) = w.team_named("Quiet").await;
        assert!(team.seeded);
        assert_eq!(team.lead.as_deref(), Some(quiet.as_str()));
        assert_eq!(seats, vec![quiet], "a name, a lead, and an empty tree");
        assert!(
            w.teams.lead_of(&w.me, &team.id).await.unwrap().is_some(),
            "and somewhere to stand, which is what makes it a team rather than a row"
        );
    }

    /// A profile that only ever spawned **itself** gets an empty team.
    ///
    /// `check` refuses a profile under itself on every write, so seeding one
    /// would make a team nobody could ever save. The narrowest break in the
    /// old behaviour, and the only one.
    #[tokio::test]
    async fn a_profile_that_only_spawned_itself_gets_an_empty_team() {
        let w = world().await;
        let recursive = w.manager("Recursive").await;
        w.spawned(&recursive, &recursive).await;

        let done = seed::seed(&w.teams, &w.org).await.unwrap().unwrap();
        assert_eq!(done.positions, 1, "itself is not a report");
        let (_, seats) = w.team_named("Recursive").await;
        assert_eq!(seats, vec![recursive]);
    }

    /// **Past the limit, the most recently spawned survive, and it is
    /// recorded.**
    ///
    /// A team holds `MAX_POSITIONS` seats with its lead among them, so a
    /// longer history than that cannot all come across. Refusing the team
    /// would leave the profile with no reach at all, and raising the limit for
    /// migrated teams would make the limit a suggestion.
    #[tokio::test]
    async fn a_spawn_history_longer_than_a_team_holds_keeps_the_most_recent() {
        let w = world().await;
        let busy = w.manager("Busy").await;
        let room = MAX_POSITIONS - 1;
        // One more than fits, spawned oldest first, so the one left out is
        // the one it has not reached for in longest.
        let mut spawned = Vec::new();
        for i in 0..room + 1 {
            let p = w.profile(&format!("Report{i}")).await;
            w.spawned(&busy, &p).await;
            spawned.push(p);
        }

        let done = seed::seed(&w.teams, &w.org).await.unwrap().unwrap();
        assert_eq!(done.positions, MAX_POSITIONS, "full, and no fuller");
        assert_eq!(
            done.truncated.len(),
            1,
            "and it is reported rather than silent"
        );
        let cut = &done.truncated[0];
        assert_eq!(cut.profile, busy);
        assert_eq!(cut.spawned, room + 1);
        assert_eq!(cut.kept, room);

        let (team, seats) = w.team_named("Busy").await;
        assert_eq!(team.positions as usize, MAX_POSITIONS);
        assert!(
            !seats.contains(&spawned[0]),
            "the oldest hand-off is the one left out"
        );
        assert!(
            seats.contains(spawned.last().unwrap()),
            "and the newest is in"
        );
    }

    /// **A team is filed where its lead profile is filed**, so exactly the
    /// people who can use the profile can see the team.
    ///
    /// Dropping it into the creator's own space would leave a directory's
    /// colleagues with a profile whose team they cannot reach — and a position
    /// that resolves to nothing, which fails closed and says nothing.
    #[tokio::test]
    async fn a_seeded_team_is_filed_where_its_lead_profile_is() {
        let w = world().await;
        let (ana, _) = w.colleague("ana").await;
        let access = crate::access::Access::new(w.db.pool().clone());
        let directory = access
            .create_directory(
                &ft_core::OrgId::from_stored(w.org.clone()),
                "Backend",
                &ft_core::UserId::from_stored(w.me.clone()),
                &[crate::access::NewGrant {
                    subject_kind: crate::access::SubjectKind::Person,
                    subject_id: ana.clone(),
                    level: Level::Writer,
                }],
            )
            .await
            .unwrap();

        let orchestrator = w.manager("Orchestrator").await;
        let engineer = w.profile("Engineer").await;
        for id in [&orchestrator, &engineer] {
            sqlx::query("UPDATE roles SET path = $2::ltree WHERE id = $1")
                .bind(id)
                .bind(format!("d.{}.{}", directory.slug, id))
                .execute(w.db.pool())
                .await
                .unwrap();
        }
        w.spawned(&orchestrator, &engineer).await;

        seed::seed(&w.teams, &w.org).await.unwrap().unwrap();
        let hers = w.teams.visible(&ana, Level::Viewer).await.unwrap();
        assert_eq!(hers.len(), 1, "it landed in the directory, not in my space");
        assert!(hers[0].path.starts_with(&format!("d/{}/", directory.slug)));
    }

    /// **The cut happens once.** A team somebody deleted afterwards stays
    /// deleted — a migration that keeps re-asserting itself is worse than one
    /// that was wrong once.
    #[tokio::test]
    async fn the_cut_is_recorded_and_never_runs_twice() {
        let w = world().await;
        let orchestrator = w.manager("Orchestrator").await;
        let engineer = w.profile("Engineer").await;
        w.spawned(&orchestrator, &engineer).await;

        assert!(seed::seed(&w.teams, &w.org).await.unwrap().is_some());
        assert!(
            seed::seed(&w.teams, &w.org).await.unwrap().is_none(),
            "the second run finds the work done"
        );

        let (team, _) = w.team_named("Orchestrator").await;
        assert!(w.teams.delete(&w.me, &team.id).await.unwrap());
        assert!(seed::seed(&w.teams, &w.org).await.unwrap().is_none());
        assert!(
            w.teams
                .visible(&w.me, Level::Viewer)
                .await
                .unwrap()
                .is_empty(),
            "and it stays deleted"
        );

        let (teams, positions): (i32, i32) =
            sqlx::query_as("SELECT teams, positions FROM agent_team_seeding WHERE org_id = $1")
                .bind(&w.org)
                .fetch_one(w.db.pool())
                .await
                .unwrap();
        assert_eq!(
            (teams, positions),
            (1, 2),
            "the record is what the cut produced, not a live count"
        );
    }

    /// With the feature turned off nothing is seeded and no team is visible,
    /// which is the whole of what the flag has to mean.
    #[tokio::test]
    async fn nothing_is_seeded_while_agent_teams_are_turned_off() {
        let w = world().await;
        let orchestrator = w.manager("Orchestrator").await;
        let engineer = w.profile("Engineer").await;
        w.spawned(&orchestrator, &engineer).await;

        let off = w.teams.turned_off();
        assert!(seed::seed(&off, &w.org).await.unwrap().is_none());
        assert!(
            w.teams
                .visible(&w.me, Level::Viewer)
                .await
                .unwrap()
                .is_empty(),
            "and the cut was not claimed either, so turning it back on still seeds"
        );
        assert!(seed::seed(&w.teams, &w.org).await.unwrap().is_some());
    }

    /// **A save is what reviewing a team means**, so it clears the marks the
    /// window left — and `auto_added` is what a list row counts to tell
    /// somebody there is something to review.
    #[tokio::test]
    async fn saving_a_team_clears_what_the_window_added() {
        let w = world().await;
        let lead = w.profile("Orchestrator").await;
        let report = w.profile("Engineer").await;
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named("Platform", seat(&lead, vec![])),
            )
            .await
            .unwrap();
        let lead_seat = w
            .teams
            .lead_of(&w.me, id.as_str())
            .await
            .unwrap()
            .unwrap()
            .position;
        sqlx::query(
            "INSERT INTO agent_team_positions \
               (id, team_id, profile_id, parent_id, ord, auto_added_at) \
             VALUES ($1, $2, $3, $4, 0, now())",
        )
        .bind(ft_core::PositionId::new().as_str())
        .bind(id.as_str())
        .bind(&report)
        .bind(&lead_seat)
        .execute(w.db.pool())
        .await
        .unwrap();

        let before = w
            .teams
            .one(&w.me, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(before.auto_added, 1, "one seat to review");
        let marked = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        assert!(
            marked[1].auto_added_at.is_some(),
            "and the seat says when it arrived"
        );
        assert!(
            marked[0].auto_added_at.is_none(),
            "while the one somebody chose says nothing"
        );

        // Saved with the seat kept, which is a person choosing it.
        assert!(w
            .teams
            .write(
                &w.me,
                id.as_str(),
                &NewAgentTeam {
                    name: "Platform".into(),
                    lead: NewPosition {
                        id: Some(lead_seat.clone()),
                        profile: lead.clone(),
                        instructions: String::new(),
                        children: vec![NewPosition {
                            id: Some(marked[1].id.clone()),
                            profile: report.clone(),
                            instructions: String::new(),
                            children: vec![],
                        }],
                    },
                    directory: None,
                }
            )
            .await
            .unwrap());

        let after = w
            .teams
            .one(&w.me, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.positions, 2, "the seat is still there");
        assert_eq!(after.auto_added, 0, "and nobody has to review it again");
    }

    /// **The one cost of `agent_team_one_profile_per_parent`**, pinned so it
    /// is a known sentence rather than a 500 somebody discovers.
    ///
    /// Two seats under one position cannot *trade* profiles in a single save:
    /// the updates go one statement at a time, so the first takes the second's
    /// profile while the second is still holding it. The tree asked for is
    /// legal — `check` passes it — and the save is still refused, because
    /// there is no ordering that fixes a two-cycle and no partial deferrable
    /// constraint to defer it with.
    #[tokio::test]
    async fn two_seats_under_one_position_cannot_trade_profiles_in_one_save() {
        let w = world().await;
        let lead = w.profile("Orchestrator").await;
        let (a, b) = (w.profile("Engineer").await, w.profile("Reviewer").await);
        let id = w
            .teams
            .create(
                &w.org,
                &w.me,
                &w.my_slug,
                None,
                &named(
                    "Platform",
                    seat(&lead, vec![seat(&a, vec![]), seat(&b, vec![])]),
                ),
            )
            .await
            .unwrap();
        let seats = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        let swapped = NewAgentTeam {
            name: "Platform".into(),
            lead: NewPosition {
                id: Some(seats[0].id.clone()),
                profile: lead.clone(),
                instructions: String::new(),
                children: vec![
                    NewPosition {
                        id: Some(seats[1].id.clone()),
                        profile: b.clone(),
                        instructions: String::new(),
                        children: vec![],
                    },
                    NewPosition {
                        id: Some(seats[2].id.clone()),
                        profile: a.clone(),
                        instructions: String::new(),
                        children: vec![],
                    },
                ],
            },
            directory: None,
        };
        assert!(check(&swapped).is_ok(), "the tree asked for is a legal one");

        let no = w
            .teams
            .write(&w.me, id.as_str(), &swapped)
            .await
            .expect_err("but not in one pass");
        let said = format!("{no:#}");
        assert!(
            no.downcast_ref::<Refused>().is_some(),
            "a sentence rather than a 500: {said}"
        );
        assert!(said.contains("trade"), "{said}");
        assert!(
            said.contains("Remove one of the two and save"),
            "and what to do instead — advice that works: {said}"
        );

        // Nothing moved — the transaction took the whole save with it.
        let after = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        assert_eq!(
            after.iter().map(|p| p.profile.clone()).collect::<Vec<_>>(),
            vec![lead.clone(), a.clone(), b.clone()],
            "and the team is exactly as it was"
        );

        /* **The path the refusal names, walked.** Remove one of the two and
        save; then add it back with the other's profile. Both saves hold,
        because by the second one nothing is still holding the profile being
        taken — which is the whole reason this is the advice and "change one
        and then the other" is not: either half of a straight swap is the
        same collision again. */
        let child = |seat: Option<&str>, profile: &str| NewPosition {
            id: seat.map(str::to_string),
            profile: profile.to_string(),
            instructions: String::new(),
            children: vec![],
        };
        let saved = |children: Vec<NewPosition>| NewAgentTeam {
            name: "Platform".into(),
            lead: NewPosition {
                id: Some(seats[0].id.clone()),
                profile: lead.clone(),
                instructions: String::new(),
                children,
            },
            directory: None,
        };
        assert!(w
            .teams
            .write(
                &w.me,
                id.as_str(),
                &saved(vec![child(Some(&seats[1].id), &a)])
            )
            .await
            .unwrap());
        assert!(w
            .teams
            .write(
                &w.me,
                id.as_str(),
                &saved(vec![child(Some(&seats[1].id), &b), child(None, &a)])
            )
            .await
            .unwrap());

        let now = w.teams.positions(&w.me, id.as_str()).await.unwrap();
        assert_eq!(
            now.iter().map(|p| p.profile.clone()).collect::<Vec<_>>(),
            vec![lead, b, a],
            "the two have traded"
        );
        assert_eq!(
            now[1].id, seats[1].id,
            "the seat that stayed kept its id, so a session standing in it still is"
        );
        assert_ne!(
            now[2].id, seats[2].id,
            "and the one removed and added back is a new seat, which is what it is"
        );
    }
}
