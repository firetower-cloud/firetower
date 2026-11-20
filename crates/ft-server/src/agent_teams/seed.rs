//! Teams seeded from what profiles have **actually spawned**.
//!
//! A profile used to carry its own list of profiles it could hand work to, and
//! the default for that list was empty — which meant *anything the owner can
//! see*, including profiles created later. **That default cannot become a
//! tree.** It is not a set of rows; it is a standing subscription to a set,
//! and it changes without anybody touching it.
//!
//! So the old default is not copied across. Each team is built from session
//! lineage — `sessions.parent_id`, the edge `20261028120000_lineage.sql`
//! added. A session running profile P, a child session of it running profile
//! Q: that is one position, Q reporting to P. It is the only non-arbitrary
//! materialisation available, and it is the one with the property the
//! deprecation needs: **anybody whose patterns continue sees no change at
//! all**, because the team already holds what they have been doing. A
//! snapshot of everything visible would have handed somebody a fourteen-seat
//! team on day one for a profile that only ever used three, and every one of
//! those seats would be something nobody chose.
//!
//! Three shapes follow from the data rather than from a choice:
//!
//! * **Every seeded team is one level deep.** A delegated child cannot spawn
//!   today (`docs/delegation.md`, Limits), so there is no deeper lineage to
//!   read. Depth arrives when somebody authors it.
//! * **A profile that never spawned gets an empty team** — a name, a lead, and
//!   nothing under it. Not a missing one: the team is where reach is authored
//!   now, and making somebody create one before they can author anything is
//!   the break this exists to avoid.
//! * **A profile that cannot delegate gets no team.** `can_delegate` is the
//!   question "could this profile hand work off", and a profile demoted to an
//!   Operator before the cut had no reach to preserve, whatever its history.
//!
//! `roles.delegate_scope` is deliberately **not** read here, and it is the one
//! thing a reader will ask about. A narrowed scope is a finite list somebody
//! ticked, so copying it would be defensible — but #491 is explicit that a
//! profile which never spawned gets an *empty* team, and a scope that was
//! never exercised is a guess about intent the same way a visibility snapshot
//! is. The scope is not lost: it is exactly what the compatibility window
//! admits from, so a profile reaching one of those entries for the first time
//! gets the seat then, marked, out of real use. See [`super::window`].

use anyhow::{Context, Result};
use sqlx::Row;

use super::{check, slug_of, AgentTeams, MAX_POSITIONS};
use crate::AppState;

/// What one cut produced, for the log and for a test to assert on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Seeded {
    pub teams: usize,
    /// Positions written, the leads included.
    pub positions: usize,
    /// Leads whose spawn history did not fit in one team.
    pub truncated: Vec<Truncated>,
}

/// A profile that had spawned more distinct profiles than a team can hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Truncated {
    pub profile: String,
    pub name: String,
    /// How many distinct profiles it had spawned.
    pub spawned: usize,
    /// How many of them became positions: `MAX_POSITIONS - 1`.
    pub kept: usize,
}

/// Seed every organisation that has not been seeded, at start-up.
///
/// Spawned rather than awaited, like `seed_builtin_skills`, and safe to be:
/// **every session that exists has `position_id` null**, so nothing already
/// running is waiting on this. A team only reaches a session that is started
/// as one, which cannot happen before somebody has seen the team.
pub async fn run(state: AppState) {
    if !state.agent_teams.enabled() {
        tracing::info!("agent teams are off: no teams seeded from lineage");
        return;
    }
    let orgs: Vec<String> = match sqlx::query_scalar("SELECT id FROM organizations ORDER BY id")
        .fetch_all(state.db.pool())
        .await
    {
        Ok(orgs) => orgs,
        Err(e) => {
            tracing::error!("could not read the organisations to seed agent teams for: {e:#}");
            return;
        }
    };
    for org in orgs {
        match seed(&state.agent_teams, &org).await {
            Ok(None) => tracing::debug!(org = %org, "agent teams already seeded"),
            Ok(Some(done)) => {
                tracing::info!(
                    org = %org,
                    teams = done.teams,
                    positions = done.positions,
                    "seeded agent teams from session lineage"
                );
                for cut in &done.truncated {
                    tracing::warn!(
                        profile = %cut.profile,
                        "\"{}\" had spawned {} different profiles, which is more than the {} a \
                         team holds. Its team was seeded with the {} most recently spawned; the \
                         rest can be added on Configuration → Agent teams.",
                        cut.name,
                        cut.spawned,
                        MAX_POSITIONS,
                        cut.kept,
                    );
                }
            }
            Err(e) => tracing::error!(org = %org, "could not seed agent teams: {e:#}"),
        }
    }
}

/// One cut, for one organisation. `None` when it has already been seeded.
///
/// **One transaction.** Either the installation has its teams and the row that
/// says so, or it has neither and the next start-up tries again — a
/// half-materialised set of teams is the one outcome nobody could reason
/// about.
///
/// Public so the tests can run it against fixture lineage, which is the only
/// way to assert what it produces: it runs once per installation, and by the
/// time anything else in the suite exists it has already decided.
pub async fn seed(teams: &AgentTeams, org: &str) -> Result<Option<Seeded>> {
    if !teams.enabled() {
        return Ok(None);
    }
    let mut tx = teams.pool.begin().await?;

    /* **The claim, and the mutex.** Two control planes coming up together
    both reach this; the insert that conflicts returns no row and takes the
    other's lock on the way, so exactly one of them seeds and the other
    finds the work done. Claimed before anything is read, so the whole cut
    is inside the lock. */
    let claimed: Option<String> = sqlx::query_scalar(
        "INSERT INTO agent_team_seeding (org_id) VALUES ($1) \
         ON CONFLICT (org_id) DO NOTHING RETURNING org_id",
    )
    .bind(org)
    .fetch_optional(&mut *tx)
    .await
    .context("claiming the agent-team seeding for an organisation")?;
    if claimed.is_none() {
        return Ok(None);
    }

    /* Every profile that could delegate, and therefore every profile with a
    reach to preserve. `NOT EXISTS` skips one that already leads a team:
    there are none at the cut, and the guard is what keeps this from
    doubling a hand-made team if the two ever do overlap. */
    let leads = sqlx::query(
        "SELECT r.id, r.name, r.path::text AS path, r.created_by \
           FROM roles r \
          WHERE r.org_id = $1 AND r.can_delegate \
            AND NOT EXISTS (SELECT 1 FROM agent_team_positions p \
                             WHERE p.profile_id = r.id AND p.parent_id IS NULL) \
          ORDER BY r.id",
    )
    .bind(org)
    .fetch_all(&mut *tx)
    .await
    .context("reading the profiles that could delegate")?;

    let mut done = Seeded::default();
    for lead in &leads {
        let profile: String = lead.get("id");
        let name: String = lead.get("name");
        let path: String = lead.get("path");
        let created_by: Option<String> = lead.get("created_by");

        /* **What this profile actually spawned.** One row per distinct
        profile it has started a child as, newest first — which is both the
        order the seats are written in and the order the truncation below
        keeps, so there is one rule rather than two.

        `c.profile_id <> $1` is the one exclusion, and it is not
        housekeeping: a profile that spawned *itself* is a chain of agents
        of one kind handing the same work down, and `agent_teams::check`
        refuses a profile under itself on every write. Seeding one would
        make a team nobody could ever save. It is a narrow break in the old
        behaviour and the only one here. */
        let spawned = sqlx::query(
            "SELECT c.profile_id, max(c.created_at) AS last_spawn \
               FROM sessions l \
               JOIN sessions c ON c.parent_id = l.id \
               JOIN roles q ON q.id = c.profile_id \
              WHERE l.profile_id = $1 AND c.profile_id <> $1 AND q.org_id = $2 \
              GROUP BY c.profile_id \
              ORDER BY max(c.created_at) DESC, c.profile_id",
        )
        .bind(&profile)
        .bind(org)
        .fetch_all(&mut *tx)
        .await
        .context("reading what a profile has spawned")?;

        /* **Past the limit, the most recent survive, and it is said out
        loud.** A team holds `MAX_POSITIONS` seats with the lead among them,
        so a profile with a longer history than that cannot have all of it.
        The alternatives were to refuse the team — leaving the profile with
        no reach at all, which is the break this work exists to avoid — or
        to raise the limit for migrated teams, which would make the limit a
        suggestion. Keeping the most recently used is the choice that is
        most often right, and the rest are one add away on a screen that
        now exists. */
        let room = MAX_POSITIONS.saturating_sub(1);
        if spawned.len() > room {
            done.truncated.push(Truncated {
                profile: profile.clone(),
                name: name.clone(),
                spawned: spawned.len(),
                kept: room,
            });
        }
        let reports: Vec<String> = spawned
            .iter()
            .take(room)
            .map(|row| row.get::<String, _>("profile_id"))
            .collect();

        // Named after its lead profile, which is the name somebody already
        // knows it by. Trimmed to what `check` accepts rather than refused for
        // being long, because refusing would cost a profile its whole reach
        // over its name.
        let team_name = team_name(&name);

        /* The limits, asked of the same pure function every write asks.
        It cannot fail on a tree built here — one level, inside the count,
        no profile under itself — and that is the point of asking: if the
        limits ever move, this is where the two disagree, loudly, instead
        of writing a tree nobody can save. One profile skipped rather than
        the whole cut abandoned. */
        let shape = super::NewAgentTeam {
            name: team_name.clone(),
            lead: super::NewPosition {
                id: None,
                profile: profile.clone(),
                instructions: String::new(),
                children: reports
                    .iter()
                    .map(|p| super::NewPosition {
                        id: None,
                        profile: p.clone(),
                        instructions: String::new(),
                        children: Vec::new(),
                    })
                    .collect(),
            },
            directory: None,
        };
        if let Err(no) = check(&shape) {
            tracing::error!(
                profile = %profile,
                "not seeding a team for \"{name}\": {no}. Its profile keeps the reach it has."
            );
            continue;
        }

        let team = ft_core::AgentTeamId::new();
        let slug = slug_of(&team_name, team.as_str());
        /* **Filed where its lead profile is filed**, so exactly the people
        who can reach the profile can reach the team. A team dropped into
        the creator's own space when the profile lives in a directory would
        be invisible to the colleagues who have been using that profile,
        and their sessions would resolve to nothing — fail-closed, and
        silent. `ResourcePath` is the only thing that writes one, here as
        everywhere. */
        let path = ft_core::ResourcePath::from_stored(&path);
        let filed = match (path.directory_slug(), path.owner_slug()) {
            (Some(directory), _) => ft_core::ResourcePath::in_directory(directory, &slug),
            (None, Some(owner)) => ft_core::ResourcePath::personal(owner, &slug),
            // Neither root: a row somebody wrote by hand. Left alone rather
            // than guessed at, because a path is who can see a thing.
            (None, None) => {
                tracing::error!(
                    profile = %profile,
                    "not seeding a team for \"{name}\": its path is {path}, which is in neither \
                     a person's space nor a directory, so there is nowhere to file the team."
                );
                continue;
            }
        };

        sqlx::query(
            "INSERT INTO agent_teams (id, org_id, path, created_by, name, slug, seeded_at) \
             VALUES ($1, $2, $3::ltree, $4, $5, $6, now())",
        )
        .bind(team.as_str())
        .bind(org)
        .bind(filed.to_ltree())
        .bind(&created_by)
        .bind(&team_name)
        .bind(&slug)
        .execute(&mut *tx)
        .await
        .context("writing a seeded agent team")?;

        let lead_seat = ft_core::PositionId::new();
        sqlx::query(
            "INSERT INTO agent_team_positions (id, team_id, profile_id, parent_id, ord) \
             VALUES ($1, $2, $3, NULL, 0)",
        )
        .bind(lead_seat.as_str())
        .bind(team.as_str())
        .bind(&profile)
        .execute(&mut *tx)
        .await
        .context("writing a seeded team's lead")?;
        done.positions += 1;

        for (at, report) in reports.iter().enumerate() {
            /* `auto_added_at` is **null** on a seeded seat, deliberately.
            The mark means "the window added this while nobody was
            looking"; a seeded seat is accounted for by `seeded_at` on the
            team, which says the whole thing was materialised. Marking
            every seat as well would make the window's own additions
            invisible among them, which is the one thing the mark is for. */
            sqlx::query(
                "INSERT INTO agent_team_positions (id, team_id, profile_id, parent_id, ord) \
                 VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(ft_core::PositionId::new().as_str())
            .bind(team.as_str())
            .bind(report)
            .bind(lead_seat.as_str())
            .bind(at as i32)
            .execute(&mut *tx)
            .await
            .context("writing a seeded team's position")?;
            done.positions += 1;
        }
        done.teams += 1;
    }

    sqlx::query("UPDATE agent_team_seeding SET teams = $2, positions = $3 WHERE org_id = $1")
        .bind(org)
        .bind(done.teams as i32)
        .bind(done.positions as i32)
        .execute(&mut *tx)
        .await
        .context("recording what the agent-team seeding produced")?;
    tx.commit().await?;
    Ok(Some(done))
}

/// A team's name from its lead profile's.
///
/// `check` holds a name to 64 characters, so a longer profile name is cut
/// rather than allowed to cost its profile the whole team. Character-wise, not
/// byte-wise: a name is somebody's words and may be in any script.
fn team_name(profile: &str) -> String {
    let trimmed = profile.trim();
    let name: String = trimmed.chars().take(64).collect();
    if name.is_empty() {
        "Team".to_string()
    } else {
        name
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_team_is_named_after_its_lead_and_fits_what_a_name_may_be() {
        assert_eq!(team_name("  Orchestrator  "), "Orchestrator");
        assert_eq!(
            team_name("   "),
            "Team",
            "a nameless profile still gets one"
        );
        let long: String = "é".repeat(100);
        assert_eq!(
            team_name(&long).chars().count(),
            64,
            "cut by characters, not by bytes"
        );
    }
}
