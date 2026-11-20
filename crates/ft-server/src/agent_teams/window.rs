//! The compatibility window: a seeded team that still learns, briefly.
//!
//! Seeding reads what a profile has done, which is the best available guess
//! and is still a guess. Somebody whose Manager handed work to a Reviewer once
//! a quarter has a team with no Reviewer in it, and the first time that
//! quarter comes round their long-working setup would refuse — a break, caused
//! by a migration they did not ask for, in a release that was meant to change
//! nothing for them.
//!
//! So for a bounded period after the cut, **a spawn of a profile that is not
//! yet in a seeded team succeeds and adds it.** Teams converge on real use
//! rather than on a reading of history.
//!
//! ## The risk, and why this is not the old behaviour with extra steps
//!
//! A learning phase grows a team without anybody choosing, which *is* the
//! unbounded reach this whole effort removes — only slower. That is not a
//! thing to accept and move on from. Four properties are what make it a
//! migration aid rather than a reprieve:
//!
//! 1. **It never grants reach the old path did not already grant.** What the
//!    window admits from is exactly what `spawn` would have resolved against
//!    before any of this existed: the profile's own `delegate_scope`,
//!    intersected with what its owner can see, for a root session whose
//!    profile is a Manager. Not "any profile" — *that* session's old reach,
//!    and not one profile more.
//! 2. **Every seat it adds is marked**, with the time it happened, and the
//!    team carries a count of them so a list row can say *2 added
//!    automatically*. Saving the team clears the marks, which is what
//!    reviewing one means. An auto-added seat indistinguishable from a chosen
//!    one is the failure mode this is designed against.
//! 3. **Only a team nobody drew learns.** `agent_teams.seeded_at` is the
//!    condition. A team somebody authored after the cut has no gap left by a
//!    migration, so growing it behind their back would have no justification
//!    at all.
//! 4. **It closes**, [`WINDOW_DAYS`] days after that installation's own cut,
//!    and the same spawn is then refused with the sentence it will be refused
//!    with forever.
//!
//! ## What it does not reach
//!
//! The window is open at the **lead** seat of a seeded team, for a session a
//! person started, whose profile could delegate. Nowhere else, and each of
//! those is the old path's own boundary rather than a new rule:
//!
//! * A delegated child could never spawn at all before this (`docs/
//!   delegation.md`, Limits), so a child standing in a seeded team's leaf has
//!   nothing to preserve. It reaches what its seat's children say and no more.
//! * A profile that was not a Manager could not delegate either, so a seeded
//!   team's leaf profile does not acquire a reach by being in one.
//! * A team somebody authored is exactly what they authored, from its first
//!   spawn onwards.

use anyhow::{bail, Result};
use chrono::{DateTime, Duration, Utc};
use sqlx::Row;

use super::{Report, Standing, MAX_POSITIONS};
use crate::roles::Role;
use crate::AppState;
use ft_core::Session;

/// How long a seeded team keeps learning: **30 days from that installation's
/// own cut.**
///
/// Measured from `agent_team_seeding.seeded_at` rather than from a date in the
/// binary, so an installation that upgrades six months after this ships gets a
/// whole window instead of one that expired before it arrived.
///
/// Thirty days, and the reasoning is a trade rather than a round number. Long
/// enough that anything on a daily or weekly rhythm fires inside it several
/// times over, and that one monthly cycle lands; short enough that two paths
/// to the same answer, and the flag that turns them both off, do not become
/// permanent. #497 drops `can_delegate` and `delegate_scope` after this
/// closes, and the longer this is, the longer that waits. A quarterly habit is
/// the case it does not cover: that one gets the refusal, which names the
/// screen and the profiles that do report there.
pub const WINDOW_DAYS: i64 = 30;

/// The window, open for one session, with what it admits from already
/// resolved.
#[derive(Debug, Clone)]
pub struct Window {
    /// When it closes, so a log line or a test can say which side of it we
    /// are on.
    pub closes_at: DateTime<Utc>,
    /// **The old path's answer for this session**, and the whole of what the
    /// window will admit: the profile's `delegate_scope` intersected with what
    /// its owner can see, minus the profile itself.
    pub reach: Vec<Role>,
}

/// Whether the window is open for this session, and what it admits from.
///
/// `None` is the ordinary case the moment the window closes, and the ordinary
/// case for every session that is not a person-started Manager standing at the
/// lead of a seeded team. The caller then behaves exactly as #490 left it.
pub async fn open_for(
    state: &AppState,
    lead: &Session,
    profile: Option<&Role>,
    standing: Option<&Standing>,
) -> Result<Option<Window>> {
    // A session a person started. The old path refused a child outright — "this
    // session is itself a child, and children cannot spawn" — so a child has no
    // old behaviour to keep.
    if lead.parent_id.is_some() {
        return Ok(None);
    }
    open_at(state, lead.owner.as_str(), profile, standing).await
}

/// The same question where there is no session row to ask it of.
///
/// Composing a persona happens *before* the session exists, and only ever for
/// one a person is starting — a delegated child is told what it is for in its
/// brief, not in a composed persona, which is the same reason
/// [`open_for`]'s check on `parent_id` is not repeated here.
pub async fn open_at(
    state: &AppState,
    owner: &str,
    profile: Option<&Role>,
    standing: Option<&Standing>,
) -> Result<Option<Window>> {
    if !state.agent_teams.enabled() {
        return Ok(None);
    }
    // At the lead seat of a team nobody drew. A seat further down is bounded
    // by its own children, as it will be forever.
    let Some(standing) = standing.filter(|s| s.parent.is_none() && s.team_seeded) else {
        return Ok(None);
    };
    // And a profile that could delegate, which is the old path's other gate.
    let Some(profile) = profile.filter(|p| p.can_delegate) else {
        return Ok(None);
    };

    let Some(closes_at) = closes_at(state, &standing.team).await? else {
        return Ok(None);
    };
    if Utc::now() >= closes_at {
        return Ok(None);
    }

    /* **Exactly the old path's reach, computed the way the old path computes
    it.** `roles::visible` is the intersection with what the owner can see,
    and an empty `delegate_scope` means "any of those", which was the
    default this whole effort is replacing. The profile itself is dropped
    because a profile may not report to itself — `agent_teams::check`
    refuses it on every write, so a seat the window added would be one
    nobody could ever save. */
    let scoped = !profile.delegate_scope.is_empty();
    let reach: Vec<Role> = state
        .roles
        .visible(owner, crate::access::Level::Viewer)
        .await?
        .into_iter()
        .filter(|r| r.id != profile.id)
        .filter(|r| !scoped || profile.delegate_scope.contains(&r.id))
        .collect();

    Ok(Some(Window { closes_at, reach }))
}

/// When a team's window closes: that organisation's cut plus [`WINDOW_DAYS`].
///
/// `None` when the organisation has never been seeded, which is a fresh
/// installation. Nothing on one needs a window — there is no old behaviour
/// behind it — and the `seeded_at` condition means nothing on one would be
/// eligible anyway.
async fn closes_at(state: &AppState, team: &str) -> Result<Option<DateTime<Utc>>> {
    let row = sqlx::query(
        "SELECT s.seeded_at FROM agent_team_seeding s \
           JOIN agent_teams t ON t.org_id = s.org_id \
          WHERE t.id = $1",
    )
    .bind(team)
    .fetch_optional(state.db.pool())
    .await?;
    Ok(row.map(|r| r.get::<DateTime<Utc>, _>("seeded_at") + Duration::days(WINDOW_DAYS)))
}

/// Put a profile the window admits into the team, under this session's own
/// position, and hand back the seat it now holds.
///
/// `Ok(None)` is "the window does not know this name either", and the caller
/// falls through to the refusal it would have given anyway — the ordinary
/// not-found, because out of reach reads as *does not exist* rather than as
/// *not allowed*, here as everywhere.
///
/// An `Err` is a refusal with a sentence in it, for the two cases where the
/// name resolves and the seat still cannot exist.
pub async fn admit(
    state: &AppState,
    standing: &Standing,
    window: &Window,
    wanted: &str,
) -> Result<Option<Report>> {
    let wanted = wanted.trim();
    /* The same `at_most_one` the resolution itself uses, so a name that
    matches two profiles is refused here too rather than resolved to
    whichever the query returned first — and refused before anything is
    written, so a team does not gain a seat somebody has to work out the
    provenance of. */
    let Some(found) =
        crate::delegate::at_most_one("subagent", wanted, &window.reach, |r| r.name.as_str())?
    else {
        return Ok(None);
    };

    /* **A profile may not report to itself**, which `open_for` already
    excluded from the reach — so this is the belt to that braces, and it is
    worth keeping: a seat the window added that no save could ever
    reproduce would be a team somebody is locked out of editing. */
    if found.id == standing.profile {
        bail!(
            "\"{}\" is the profile this session is running, so it cannot also report to it. A \
             profile can sit in a team twice, but not under itself.",
            found.name
        );
    }

    /* The position limit, which a seeded team can reach: 63 reports came
    across at the cut and this would be the 65th seat. Refused with the
    number and the fix, rather than a limit enforced on the write screen
    and quietly ignored here. */
    let held: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_team_positions WHERE team_id=$1")
            .bind(&standing.team)
            .fetch_one(state.db.pool())
            .await?;
    if held as usize >= MAX_POSITIONS {
        bail!(
            "the \"{}\" team already holds {MAX_POSITIONS} positions, which is as many as a team \
             may have, so \"{}\" cannot be added to it. Remove a position it no longer needs on \
             Configuration → Agent teams, or put this work in a team of its own.",
            standing.team_name,
            found.name
        );
    }

    /* **One profile at most once among one position's children.** The
    insert is conditional rather than checked-then-written, so two spawns
    naming the same profile at the same moment cannot both add a seat. No
    row inserted means a seat already exists — which happens when the seat
    references a profile the *owner* cannot see, so `reports` dropped it and
    the name never resolved. Falling through to the ordinary not-found is
    right: the fix is the profile's filing, not the team's shape. */
    let seat = ft_core::PositionId::new();
    let written = sqlx::query(
        "INSERT INTO agent_team_positions \
           (id, team_id, profile_id, parent_id, ord, auto_added_at) \
         SELECT $1, $2, $3, $4, \
                coalesce((SELECT max(ord) + 1 FROM agent_team_positions \
                           WHERE parent_id = $4), 0), \
                now() \
          WHERE NOT EXISTS (SELECT 1 FROM agent_team_positions \
                             WHERE parent_id = $4 AND profile_id = $3)",
    )
    .bind(seat.as_str())
    .bind(&standing.team)
    .bind(&found.id)
    .bind(&standing.position)
    .execute(state.db.pool())
    .await?;
    if written.rows_affected() == 0 {
        return Ok(None);
    }

    tracing::info!(
        team = %standing.team,
        position = %seat,
        profile = %found.id,
        "the compatibility window added \"{}\" to the \"{}\" team, which was seeded from \
         lineage. Marked for review; it closes {}",
        found.name,
        standing.team_name,
        window.closes_at.format("%Y-%m-%d"),
    );

    Ok(Some(Report {
        position: seat.as_str().to_string(),
        // A seat nobody authored carries no instructions. The profile's own
        // are what the child is told, which is what it was told before.
        instructions: String::new(),
        profile: found.clone(),
    }))
}
