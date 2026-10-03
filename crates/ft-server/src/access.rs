//! Who may see what, and how much of it.
//!
//! One column used to answer this. Everything a person made carried their id,
//! and every read said `WHERE user_id = $me` — a complete answer to "is this
//! mine" and no answer to "may I see yours".
//!
//! Three nouns now, and they are the smallest set that says what a team says:
//!
//! * a **team** is a named group of people, so a grant given to five of them
//!   does not become five rows that drift apart when somebody joins;
//! * a **directory** is a named bag of things to hold a grant over, because
//!   nobody maintains a grant per workspace;
//! * a **grant** is: a person or a team, may look or work or administer, in a
//!   directory.
//!
//! **Everything has a path, and the path says who can reach it.** Two roots:
//! `u.<person>` is somebody's own space, needs no grant and has no row;
//! `d.<directory>` is a directory, and a grant on it reaches everything filed
//! under it. So "I administer what I just created" is not a rule in the code —
//! what somebody makes is born in their own root, where nobody else is.
//!
//! **Filing something into a directory hands it over.** The path is the only
//! statement of where a thing lives, so moving it is moving it; the person who
//! put it there keeps access as somebody the directory grants, and no more.
//! `created_by` is what survives the change of hands.
//!
//! **[`filed_where`] is the only place "may see this" is written down.** Every
//! read that enforces access builds its predicate from it. That is the whole
//! defence against the failure this module exists to prevent: not a wrong
//! design, but a query added next spring that forgets the predicate and quietly
//! returns everybody's rows. One function, and `grep` finds every caller.
//!
//! **An administrator of the organisation is not automatically a reader of it.**
//! They can create teams, make directories and hand out grants — somebody has
//! to be able to unstick a directory nobody can administer — but seeing
//! somebody's work means granting themselves, which leaves a row in the grant
//! list with their name on it. The alternative is an administrator who can read
//! every conversation on the installation and leaves no trace of having done
//! it.

use anyhow::{bail, Context, Result};
use ft_core::{DirectoryId, OrgId, ResourcePath, TeamId, UserId};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use utoipa::ToSchema;

/// Said here as well as in `ft_core`, because a caller reaching for a level is
/// already reaching for this module.
pub use ft_core::{Level, SubjectKind};

/// What "this is filed where they may look" means, as SQL.
///
/// **The one definition.** A read that enforces access calls this and pastes
/// the result into its `WHERE`; nothing else spells the condition out. The
/// reason is not tidiness — the dangerous mistake here is a query written next
/// spring that leaves the condition off altogether, and one function with one
/// set of callers is something a reviewer can check by grepping.
///
/// Four ways in, `OR`ed — which is the same as taking the most generous, and is
/// why two of them can never contradict each other:
///
/// * it is in **their own space**, `u.<their slug>.…`, which needs no grant and
///   no row — a personal root is implicit, and that is the whole of why there
///   is no per-person directory to create, own and clean up;
/// * it is in a **directory** they hold a grant on at `at_least`;
/// * the row **names them** in `extra_perms`;
/// * the row **names a team they are in**.
///
/// `<@` is "is a descendant of", against a GiST index. Only the first two
/// labels decide anything, so a path nested five deep costs the same as one
/// nested none — and there is no recursion, because depth grants nothing.
///
/// **Both exception clauses lead with a key test, and that is deliberate.**
/// `extra_perms ? key` and `?| keys` are what the GIN index can answer;
/// `level_rank(extra_perms ->> key) >= n` is an opaque expression over a dynamic
/// key and would be a sequential scan on every list query in the product. So the
/// index narrows to the few rows that name this person at all, and the level is
/// rechecked on those.
///
/// The team clause is **uncorrelated** — its subquery never mentions `{alias}` —
/// so Postgres builds the array of their team keys once and hits the index with
/// it, rather than walking `team_members` per candidate row.
///
/// It takes no kind. Every table a person can file has `path` and
/// `extra_perms`, and the question is the same for all of them, which is the
/// point.
pub fn filed_where(alias: &str, person: usize, at_least: Level) -> String {
    let rank = at_least.rank();
    format!(
        "(EXISTS (SELECT 1 FROM principals me \
                   WHERE me.id = ${person} AND {alias}.path <@ ('u.' || me.slug)::ltree) \
          OR EXISTS (SELECT 1 FROM directories dd \
                       JOIN directory_access da ON da.directory_id = dd.id \
                      WHERE da.user_id = ${person} AND da.rank >= {rank} \
                        AND {alias}.path <@ ('d.' || dd.slug)::ltree) \
          OR ({alias}.extra_perms ? (SELECT 'u/' || me.slug FROM principals me \
                                      WHERE me.id = ${person} AND me.retired_at IS NULL) \
              AND level_rank({alias}.extra_perms ->> \
                    (SELECT 'u/' || me.slug FROM principals me WHERE me.id = ${person})) \
                  >= {rank}) \
          OR ({alias}.extra_perms ?| (SELECT array_agg('t/' || p.slug) \
                                        FROM team_members m \
                                        JOIN principals p ON p.id = m.team_id \
                                       WHERE m.user_id = ${person}) \
              AND EXISTS (SELECT 1 FROM jsonb_each_text({alias}.extra_perms) e \
                           WHERE level_rank(e.value) >= {rank} \
                             AND e.key = ANY (SELECT 't/' || p.slug \
                                                FROM team_members m \
                                                JOIN principals p ON p.id = m.team_id \
                                               WHERE m.user_id = ${person}))))"
    )
}

/// A level as the database spells it.
///
/// Its own function so the error becomes this crate's, with the column named:
/// a row that will not decode is a schema disagreement, and "viewer, writer or
/// admin" alone does not say where to look.
fn parse_level(stored: &str) -> Result<Level> {
    Level::parse(stored).map_err(|e| anyhow::anyhow!("reading a grant: {e}"))
}

fn parse_subject(stored: &str) -> Result<SubjectKind> {
    SubjectKind::parse(stored).map_err(|e| anyhow::anyhow!("reading a grant: {e}"))
}

/// What every read of a directory selects.
///
/// The counts are `<@` against each kind's path index — "everything filed under
/// this root" — which is the same question the access check asks and the reason
/// a directory needs no join to know what it holds.
const DIRECTORY_COLUMNS: &str = "d.id, d.name, d.slug, \
     (SELECT count(*) FROM workspaces     x WHERE x.path <@ ('d.' || d.slug)::ltree) AS workspaces, \
     (SELECT count(*) FROM hosts          x WHERE x.path <@ ('d.' || d.slug)::ltree) AS hosts, \
     (SELECT count(*) FROM agent_accounts x WHERE x.path <@ ('d.' || d.slug)::ltree) AS agent_accounts, \
     (SELECT count(*) FROM secrets        x WHERE x.path <@ ('d.' || d.slug)::ltree) AS secrets";

/// A named group of people.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: TeamId,
    pub name: String,
    /// True for the one team that is everybody in the organisation. It has no
    /// membership rows: whoever exists now is who it means.
    pub everyone: bool,
    /// How many people are in it. The whole organisation, for `everyone`.
    pub members: i64,
}

/// A bag of things a grant is held over.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub id: DirectoryId,
    pub name: String,
    /// What appears in a path. Derived from the name once, and stable after —
    /// renaming a directory must not rewrite every path underneath it.
    pub slug: String,

    /// What the person asking may do here. Absent when nothing was asked for.
    pub level: Option<Level>,
    /// What is filed here, so a list can say so and a deletion can refuse.
    pub workspaces: i64,
    pub hosts: i64,
    pub agent_accounts: i64,
    pub secrets: i64,
}

impl Directory {
    /// Whether anything at all is filed here.
    pub fn holds_anything(&self) -> bool {
        self.workspaces + self.hosts + self.agent_accounts + self.secrets > 0
    }
}

/// How somebody came by the access they have to a directory.
///
/// Not `Route`, which is taken: the sharing sheet already has one, meaning
/// *owner, directory or exception*. Two schemas of the same name do not
/// collide loudly — one silently replaces the other in every generated client,
/// and the first sign is a field typed as something unrelated.
///
/// Flattened, `directory_access` answers *what* they may do and loses *why* —
/// which is the only thing that matters when the question is how to take it
/// away. Revoking a grant that was never theirs to begin with changes nothing;
/// the team is what has to be left.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", tag = "how")]
pub enum HowReached {
    /// A grant naming them.
    Direct,
    /// A grant naming a team they are in.
    Team { name: String },
    /// A grant naming the team that is everybody. Leaving is not possible;
    /// only the grant can go.
    Everyone,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReachedDirectory {
    pub directory_id: String,
    pub name: String,
    pub slug: String,
    /// The most generous of the routes below.
    pub level: Level,
    pub through: Vec<HowReached>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Named {
    pub kind: FiledKind,
    pub id: String,
    pub name: String,
    pub level: Level,
    /// Named personally, or through a team they are in.
    pub through: HowReached,
}

/// Everything one person can reach, and everything that is theirs.
///
/// **Answered for a person, which is the opposite of how access is stored.**
/// Every other read asks "may this person see this thing" and lets
/// [`filed_where`] answer it per row. This asks the reverse, and nothing else
/// needs it — only offboarding, where deciding about somebody means seeing what
/// goes with them before it goes.
///
/// Each field is a list so the shape can grow a kind without breaking a client:
/// a reader that does not know about a new one ignores it rather than failing.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Administered {
    pub directory_id: String,
    pub name: String,
    pub slug: String,
    /// Nobody else administers it. Not a blocker — an organisation
    /// administrator can administer any directory, which is the fallback that
    /// makes a directory whose last administrator left fixable. It is said
    /// because the people who *work* there would lose the ability to file
    /// anything out of it.
    pub alone: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reach {
    pub teams: Vec<Team>,
    /// Directories they can work in, and how they came by each.
    pub directories: Vec<ReachedDirectory>,
    /// Resources naming them personally, or naming a team they are in.
    pub exceptions: Vec<Named>,
    /// Filed in their own root. This is what a deletion takes with it.
    pub owns: Vec<Filed>,
    /// Directories they administer, and whether anybody else does.
    pub administers: Vec<Administered>,
    /// They made these and then filed them somewhere else, so the directory
    /// owns them now and they do not go with them. Nothing to decide — shown
    /// because somebody deciding about a person wants the whole picture, and
    /// the absence of an action is the answer to "what happens to the thing
    /// ana built for the backend team".
    pub created: Vec<Filed>,
}

/// One of the things a directory holds.
///
/// Four kinds in one list, because "what is in here" is one question and
/// answering it four times is how a screen ends up with four tables nobody
/// reads. What differs between them is only what the second line says.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Filed {
    pub kind: FiledKind,
    /// Where it is filed — and so who can reach it.
    pub path: ResourcePath,
    /// What identifies it. A secret has no id of its own — it is keyed by
    /// scope, name and owner — so for one of those this is `scope/name/owner`,
    /// and
    /// the owner is whoever is asking. See `Access::place`.
    pub id: String,
    pub name: String,
    /// The second line: the repository, the agent, the scope.
    pub detail: Option<String>,
    /// Whose it is. Absent for a machine, which is the organisation's.
    pub owner_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum FiledKind {
    Workspace,
    Machine,
    AgentAccount,
    Secret,
    /// The one kind that is never in a directory.
    ///
    /// It is in this enum because the screens that list what somebody owns,
    /// and what removing them destroys, read exactly one list. Leaving
    /// repositories out of it is how they stayed invisible to offboarding
    /// while being perfectly visible to everybody else.
    Repository,
}

impl FiledKind {
    pub fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "workspace" => FiledKind::Workspace,
            "machine" => FiledKind::Machine,
            "agentAccount" => FiledKind::AgentAccount,
            "secret" => FiledKind::Secret,
            "repository" => FiledKind::Repository,
            other => bail!("{other} is not something a directory holds"),
        })
    }

    /// In words, for a refusal somebody reads.
    pub fn singular(self) -> &'static str {
        match self {
            FiledKind::Workspace => "workspace",
            FiledKind::Machine => "machine",
            FiledKind::AgentAccount => "agent account",
            FiledKind::Secret => "secret",
            FiledKind::Repository => "repository",
        }
    }

    /// Whether a directory can hold one of these at all.
    ///
    /// Only repositories cannot. They are personal in the strong sense — what
    /// opens one is the token of whoever connected it — so there is no filing
    /// one anywhere, by anybody. `may_share` would refuse it too, because the
    /// path is personal and personal paths are excluded from the administrator
    /// bypass, but a sentence that names the rule beats a sentence about roots.
    pub fn is_filable(self) -> bool {
        !matches!(self, FiledKind::Repository)
    }
}

/// Somebody named on one resource, over and above where it is filed.
///
/// Deliberately the same shape as [`Grant`] minus the directory: a screen shows
/// the two in one list, because "who can access this" does not care which route
/// somebody arrived by.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Exception {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub level: Level,
}

/// Somebody to put in a directory, and how much they may do there.
///
/// Lives here rather than in `api::access` because the access layer is what
/// consumes it — `create_directory` takes a list of these — and a type that
/// crosses the boundary should belong to the side that acts on it.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct NewGrant {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    pub level: Level,
}

/// One line of who may do what in a directory.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub subject_kind: SubjectKind,
    pub subject_id: String,
    /// The person's username or the team's name, so a list needs one read.
    pub subject_name: String,
    pub level: Level,
}

/// Teams, directories and grants, over the control plane's pool.
#[derive(Clone)]
pub struct Access {
    pool: PgPool,
}

impl Access {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    // ── asking ─────────────────────────────────────────────────────────

    /// How much this person may do in this directory, if anything.
    pub async fn level_on(&self, person: &str, directory: &str) -> Result<Option<Level>> {
        let row = sqlx::query(
            "SELECT level FROM directory_access WHERE user_id = $1 AND directory_id = $2",
        )
        .bind(person)
        .bind(directory)
        .fetch_optional(&self.pool)
        .await
        .context("reading a grant")?;

        row.map(|r| parse_level(&r.get::<String, _>("level")))
            .transpose()
    }

    /// The same question, refusing rather than answering `None`.
    ///
    /// Absent and not-enough are one sentence on purpose. Telling somebody that
    /// a directory exists but is not theirs is telling them something they were
    /// not meant to learn, and the two cases are indistinguishable to a caller
    /// that only wants to know whether to go on.
    pub async fn require(&self, person: &str, directory: &str, at_least: Level) -> Result<Level> {
        match self.level_on(person, directory).await? {
            Some(level) if level >= at_least => Ok(level),
            _ => bail!("no directory here you can do that in"),
        }
    }

    /// The directory the whole organisation works in.
    ///
    /// Made on first boot and found by its slug, because that slug is what
    /// appears in `d.shared.…` and the migration wrote it into every path it
    /// backfilled. Renaming it changes what people read, never where things
    /// are.
    pub async fn shared(&self, org: &str) -> Result<DirectoryId> {
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM directories WHERE org_id = $1 AND slug = 'shared'")
                .bind(org)
                .fetch_optional(&self.pool)
                .await
                .context("looking for the shared directory")?;

        id.map(DirectoryId::from_stored)
            .ok_or_else(|| anyhow::anyhow!("this organisation has no shared directory"))
    }

    /// The team that is everybody.
    pub async fn everyone_team(&self, org: &str) -> Result<TeamId> {
        let id: Option<String> =
            sqlx::query_scalar("SELECT id FROM teams WHERE org_id = $1 AND everyone")
                .bind(org)
                .fetch_optional(&self.pool)
                .await
                .context("looking for the everyone team")?;

        id.map(TeamId::from_stored)
            .ok_or_else(|| anyhow::anyhow!("this organisation has no everyone team"))
    }

    // ── teams ──────────────────────────────────────────────────────────

    /// Every team in the organisation, `Everyone` first, then by name.
    pub async fn teams(&self, org: &str) -> Result<Vec<Team>> {
        let rows = sqlx::query(
            "SELECT t.id, t.name, t.everyone,
                    CASE WHEN t.everyone
                         THEN (SELECT count(*) FROM users u WHERE u.org_id = t.org_id)
                         ELSE (SELECT count(*) FROM team_members m WHERE m.team_id = t.id)
                    END AS members
               FROM teams t
              WHERE t.org_id = $1
              ORDER BY t.everyone DESC, lower(t.name)",
        )
        .bind(org)
        .fetch_all(&self.pool)
        .await
        .context("reading the teams")?;

        Ok(rows
            .into_iter()
            .map(|r| Team {
                id: TeamId::from_stored(r.get::<String, _>("id")),
                name: r.get("name"),
                everyone: r.get("everyone"),
                members: r.get("members"),
            })
            .collect())
    }

    /// Who is in one. Empty for `everyone`, which has no rows by design —
    /// callers show the organisation instead.
    pub async fn members(&self, team: &str) -> Result<Vec<UserId>> {
        let rows = sqlx::query(
            "SELECT m.user_id FROM team_members m
               JOIN users u ON u.id = m.user_id
              WHERE m.team_id = $1
              ORDER BY lower(u.username)",
        )
        .bind(team)
        .fetch_all(&self.pool)
        .await
        .context("reading a team's members")?;

        Ok(rows
            .into_iter()
            .map(|r| UserId::from_stored(r.get::<String, _>("user_id")))
            .collect())
    }

    pub async fn create_team(&self, org: &OrgId, name: &str) -> Result<Team> {
        let name = check_name(name, "a team")?;
        let id = TeamId::new();
        let mut tx = self.pool.begin().await?;

        // The identity first: `teams.id` references it, and a team is a
        // principal like a person — it can be granted, it can be named in an
        // exception, and its name must never be reissued to a second team.
        Self::provision_principal(&mut tx, org, id.as_str(), SubjectKind::Team, &name).await?;

        let done = sqlx::query(
            "INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING",
        )
        .bind(id.as_str())
        .bind(org.as_str())
        .bind(&name)
        .execute(&mut *tx)
        .await
        .context("creating a team")?;

        if done.rows_affected() == 0 {
            bail!("there is already a team called {name}");
        }
        tx.commit().await?;

        Ok(Team {
            id,
            name,
            everyone: false,
            members: 0,
        })
    }

    pub async fn rename_team(&self, team: &str, name: &str) -> Result<()> {
        let name = check_name(name, "a team")?;
        let done = sqlx::query("UPDATE teams SET name = $1 WHERE id = $2 AND NOT everyone")
            .bind(&name)
            .bind(team)
            .execute(&self.pool)
            .await
            // The only way this fails is the unique index, and the sentence for
            // it is about the name rather than about SQL.
            .map_err(|_| anyhow::anyhow!("there is already a team called {name}"))?;

        if done.rows_affected() == 0 {
            bail!("no team here to rename — the team that is everybody cannot be renamed");
        }
        Ok(())
    }

    /// Remove a team, and with it every grant it held.
    ///
    /// The grants go by cascade, which is the whole reason a team is worth
    /// having: taking a group's access away is one delete rather than a hunt
    /// through every directory somebody thought to share.
    pub async fn delete_team(&self, team: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let slug: Option<String> = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
            .bind(team)
            .fetch_optional(&mut *tx)
            .await?;

        sqlx::query("DELETE FROM grants WHERE subject_kind = 'team' AND subject_id = $1")
            .bind(team)
            .execute(&mut *tx)
            .await
            .context("revoking a team's grants")?;

        let done = sqlx::query("DELETE FROM teams WHERE id = $1 AND NOT everyone")
            .bind(team)
            .execute(&mut *tx)
            .await
            .context("removing a team")?;

        if done.rows_affected() == 0 {
            bail!("no team here to remove — the team that is everybody cannot be removed");
        }

        // The identity stays, retired. A second team called `Backend` gets
        // `backend_2`, so an exception naming `t/backend` cannot be inherited by
        // it — the same rule as a person.
        if let Some(slug) = slug {
            Self::forget_exceptions(&mut tx, &format!("t/{slug}")).await?;
        }
        Self::retire_principal(&mut tx, team).await?;

        tx.commit().await?;
        Ok(())
    }

    /// Put somebody in a team. Already in it is not an error.
    pub async fn add_member(&self, team: &str, person: &str) -> Result<()> {
        let everyone: Option<bool> = sqlx::query_scalar("SELECT everyone FROM teams WHERE id = $1")
            .bind(team)
            .fetch_optional(&self.pool)
            .await?;

        match everyone {
            None => bail!("no team here"),
            // Refused rather than ignored: a row here would be a second,
            // disagreeing account of who is in it, and the person adding it
            // believes something about this team that is not true.
            Some(true) => bail!("everybody is already in that team"),
            Some(false) => {}
        }

        sqlx::query(
            "INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING",
        )
        .bind(team)
        .bind(person)
        .execute(&self.pool)
        .await
        .context("adding somebody to a team")?;
        Ok(())
    }

    pub async fn remove_member(&self, team: &str, person: &str) -> Result<()> {
        sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(team)
            .bind(person)
            .execute(&self.pool)
            .await
            .context("removing somebody from a team")?;
        Ok(())
    }

    // ── directories ────────────────────────────────────────────────────

    /// Every directory this person may at least look in, with what they may do
    /// and what is filed there.
    pub async fn directories_for(&self, person: &str) -> Result<Vec<Directory>> {
        let rows = sqlx::query(&format!(
            "SELECT {DIRECTORY_COLUMNS}, a.level
                   FROM directories d
                   JOIN directory_access a ON a.directory_id = d.id AND a.user_id = $1
                  ORDER BY lower(d.name)"
        ))
        .bind(person)
        .fetch_all(&self.pool)
        .await
        .context("reading the directories")?;

        rows.into_iter().map(directory_from_row).collect()
    }

    /// Every directory in the organisation, whoever may see it.
    ///
    /// For an administrator's screen, which has to be able to show a directory
    /// nobody has granted them anything in — otherwise a directory whose last
    /// administrator left is invisible to the one person who could fix it.
    /// `level` is still their own, and still absent when they have none.
    pub async fn directories_in(&self, org: &str, asker: &str) -> Result<Vec<Directory>> {
        let rows = sqlx::query(&format!(
            "SELECT {DIRECTORY_COLUMNS}, a.level
                   FROM directories d
                   LEFT JOIN directory_access a ON a.directory_id = d.id AND a.user_id = $2
                  WHERE d.org_id = $1
                  ORDER BY lower(d.name)"
        ))
        .bind(org)
        .bind(asker)
        .fetch_all(&self.pool)
        .await
        .context("reading every directory")?;

        rows.into_iter().map(directory_from_row).collect()
    }

    pub async fn directory(&self, id: &str) -> Result<Option<Directory>> {
        let row = sqlx::query(&format!(
            "SELECT {DIRECTORY_COLUMNS}, NULL::text AS level FROM directories d WHERE d.id = $1"
        ))
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("reading a directory")?;

        row.map(directory_from_row).transpose()
    }

    /// A new directory, administered by whoever made it.
    ///
    /// Anybody may make one. Sharing your own work is the reason the feature
    /// exists, and making that an administrator's errand means it does not
    /// happen.
    pub async fn create_directory(
        &self,
        org: &OrgId,
        name: &str,
        by: &UserId,
        with: &[NewGrant],
    ) -> Result<Directory> {
        let name = check_name(name, "a directory")?;
        // The slug is derived once and never again. Renaming a directory must
        // not rewrite the path of everything filed under it — the display name
        // is free to change, the label in the path is not.
        let slug = ft_core::slug(&name);
        let id = DirectoryId::new();
        let mut tx = self.pool.begin().await?;

        let done = sqlx::query(
            "INSERT INTO directories (id, org_id, name, slug, created_by)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
        )
        .bind(id.as_str())
        .bind(org.as_str())
        .bind(&name)
        .bind(&slug)
        .bind(by.as_str())
        .execute(&mut *tx)
        .await
        .context("creating a directory")?;

        if done.rows_affected() == 0 {
            // Two indexes can refuse this, and they are different mistakes. A
            // name clash is obvious to whoever typed it; a *slug* clash is not —
            // `Ledger work` and `Ledger  Work!` are different names and the same
            // `d/ledger_work`, and saying "there is already a directory called
            // Ledger  Work!" would name a directory that does not exist.
            let taken: Option<String> =
                sqlx::query_scalar("SELECT name FROM directories WHERE org_id = $1 AND slug = $2")
                    .bind(org.as_str())
                    .bind(&slug)
                    .fetch_optional(&mut *tx)
                    .await?;
            match taken {
                Some(other) if other.to_lowercase() != name.to_lowercase() => bail!(
                    "{other} already uses d/{slug}. Pick a name that differs by more than \
                     spacing or punctuation — or put this in {other} instead."
                ),
                _ => bail!("there is already a directory called {name}"),
            }
        }

        sqlx::query(
            "INSERT INTO grants (directory_id, subject_kind, subject_id, level, granted_by)
             VALUES ($1, 'person', $2, 'admin', $2)",
        )
        .bind(id.as_str())
        .bind(by.as_str())
        .execute(&mut *tx)
        .await
        .context("granting a directory to whoever made it")?;

        // The rest of the people, in the same transaction. `set_grant` is not
        // reused here on purpose: it locks the directory and checks that an
        // administrator survives, and neither can be in question for a directory
        // that is being created with its author as admin two statements up.
        for g in with {
            if g.subject_id == by.as_str() {
                continue;
            }
            Self::exists(&mut tx, g.subject_kind, &g.subject_id).await?;
            sqlx::query(
                "INSERT INTO grants (directory_id, subject_kind, subject_id, level, granted_by)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (directory_id, subject_kind, subject_id) DO UPDATE SET level = $4",
            )
            .bind(id.as_str())
            .bind(g.subject_kind.as_str())
            .bind(&g.subject_id)
            .bind(g.level.as_str())
            .bind(by.as_str())
            .execute(&mut *tx)
            .await
            .context("putting somebody in a new directory")?;
        }

        tx.commit().await?;

        Ok(Directory {
            id,
            name,
            slug,
            level: Some(Level::Admin),
            workspaces: 0,
            hosts: 0,
            agent_accounts: 0,
            secrets: 0,
        })
    }

    pub async fn rename_directory(&self, id: &str, name: &str) -> Result<()> {
        let name = check_name(name, "a directory")?;
        let done = sqlx::query("UPDATE directories SET name = $1 WHERE id = $2")
            .bind(&name)
            .bind(id)
            .execute(&self.pool)
            .await
            .map_err(|_| anyhow::anyhow!("there is already a directory called {name}"))?;

        if done.rows_affected() == 0 {
            bail!("no directory here to rename");
        }
        Ok(())
    }

    /// Remove an empty directory.
    ///
    /// Empty is required rather than helpful. The foreign keys cascade, so a
    /// delete that did not check would take the workspaces filed here with it —
    /// and where those things should go instead is a question for a person, not
    /// a default. The cascade exists for removing a *person*, where those rows
    /// are being destroyed anyway.
    ///
    /// There is no personal directory to protect: `u/<somebody>` is implicit and
    /// has no row, which is one of the things paths simplified away — nothing to
    /// create on the way in, and nothing anybody can delete by mistake.
    pub async fn delete_directory(&self, id: &str) -> Result<()> {
        let Some(directory) = self.directory(id).await? else {
            bail!("no directory here to remove");
        };

        if directory.holds_anything() {
            bail!(
                "{} still holds {}. Move them somewhere else first.",
                directory.name,
                what_it_holds(&directory)
            );
        }

        sqlx::query("DELETE FROM directories WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("removing a directory")?;
        Ok(())
    }

    // ── what a directory holds ─────────────────────────────────────────

    /// Which table holds each kind, and what its rows are called.
    ///
    /// The one place a kind becomes a table name. Nothing else in this module
    /// formats one into a statement.
    fn table(kind: FiledKind) -> &'static str {
        match kind {
            FiledKind::Workspace => "workspaces",
            FiledKind::Machine => "hosts",
            FiledKind::AgentAccount => "agent_accounts",
            FiledKind::Secret => "secrets",
            // Never reached by a move: `is_filable` refuses before this, and
            // `may_share` would refuse again on the personal path. Named
            // anyway, because the one place a kind becomes a table name should
            // be able to name them all.
            FiledKind::Repository => "repos",
        }
    }

    /// Everything filed here, whatever kind it is.
    ///
    /// One statement rather than four round trips: this is drawn as a single
    /// list, and four queries would arrive in four orders and need sorting
    /// again anyway.
    ///
    /// Attached things are absent, and that is the rule rather than an
    /// exception — a secret in the `agent` or `env:` scope belongs to an agent
    /// account or a repository, moves when that moves, and has no path of its
    /// own. So does the install's own. `path IS NULL` is what "attached" looks
    /// like in the schema, and this filters on it by asking for descendants of
    /// the root, which a null path can never be.
    pub async fn filed_in(&self, directory_slug: &str) -> Result<Vec<Filed>> {
        self.filed_under(&format!("d.{directory_slug}")).await
    }

    /// The same question asked of any root, including somebody's own.
    ///
    /// `u.<slug>` is what "theirs" means, and asking it is how offboarding
    /// finds out what would go with them. The only difference from a directory
    /// is the first label.
    pub async fn filed_under(&self, under: &str) -> Result<Vec<Filed>> {
        let rows = sqlx::query(
            "SELECT 'workspace' AS kind, w.id, w.path::text, w.name, w.repo AS detail,
                    u.name AS owner_name
               FROM workspaces w LEFT JOIN principals u ON u.id = w.created_by
              WHERE w.path <@ $1::ltree
             UNION ALL
             SELECT 'machine', h.id, h.path::text, h.name, NULL, u.name
               FROM hosts h LEFT JOIN principals u ON u.id = h.created_by
              WHERE h.path <@ $1::ltree
             UNION ALL
             SELECT 'agentAccount', a.id, a.path::text, a.name, a.kind, u.name
               FROM agent_accounts a LEFT JOIN principals u ON u.id = a.user_id
              WHERE a.path <@ $1::ltree
             UNION ALL
             SELECT 'secret', s.scope || '/' || s.name || '/' || s.owner,
                    s.path::text, s.name, s.scope,
                    u.name
               FROM secrets s LEFT JOIN principals u ON u.id = s.created_by
              WHERE s.path <@ $1::ltree
             UNION ALL
             SELECT 'repository', r.id, r.path::text, r.slug, r.remote, u.name
               FROM repos r LEFT JOIN principals u ON u.id = r.added_by
              WHERE r.path <@ $1::ltree
             ORDER BY kind, name",
        )
        .bind(under)
        .fetch_all(&self.pool)
        .await
        .context("reading what is filed there")?;

        rows.into_iter()
            .map(|r| {
                Ok(Filed {
                    kind: FiledKind::parse(&r.get::<String, _>("kind"))?,
                    id: r.get("id"),
                    path: ResourcePath::from_stored(r.get::<String, _>("path")),
                    name: r.get("name"),
                    detail: r.get("detail"),
                    owner_name: r.get("owner_name"),
                })
            })
            .collect()
    }

    /// The directory a path's root names.
    ///
    /// `level` is absent: this answers "which directory is `d/<slug>`", and what
    /// the person asking may do there is a second question their caller asks
    /// with their own id. Selected explicitly so the shape of the row says so.
    pub async fn directory_by_slug(&self, org: &str, slug: &str) -> Result<Option<Directory>> {
        let row = sqlx::query(&format!(
            "SELECT {DIRECTORY_COLUMNS}, NULL::text AS level FROM directories d
              WHERE d.org_id = $1 AND d.slug = $2"
        ))
        .bind(org)
        .bind(slug)
        .fetch_optional(&self.pool)
        .await
        .context("looking up a directory by its slug")?;
        row.map(directory_from_row).transpose()
    }

    /// Where something is filed now.
    pub async fn path_of(&self, kind: FiledKind, id: &str) -> Result<Option<ResourcePath>> {
        let table = Self::table(kind);
        // `Option<Option<_>>`: no row, and a row whose `path` is null, are two
        // different things that flatten to the same answer. Decoding it as a
        // `String` treated the second as a decoding failure, so asking about an
        // *attached* thing — the install's own secrets, an agent account's
        // credential — answered 500 rather than "it has no path".
        let found: Option<Option<String>> = match kind {
            FiledKind::Secret => {
                let (scope, name, owner) = split_secret(id)?;
                sqlx::query_scalar(
                    "SELECT path::text FROM secrets
                      WHERE scope = $1 AND name = $2 AND owner = $3",
                )
                .bind(scope)
                .bind(name)
                .bind(owner)
                .fetch_optional(&self.pool)
                .await?
            }
            _ => {
                sqlx::query_scalar(&format!("SELECT path::text FROM {table} WHERE id = $1"))
                    .bind(id)
                    .fetch_optional(&self.pool)
                    .await?
            }
        };
        Ok(found.flatten().map(ResourcePath::from_stored))
    }

    /// Everything one person reaches, and everything that is theirs.
    ///
    /// Four reads rather than one union, because they answer four different
    /// shapes and a single query would have to flatten them back apart in Rust
    /// anyway. None of them is on a hot path: this is asked once, by one
    /// administrator, while deciding about one person.
    pub async fn reach(&self, person: &str) -> Result<Reach> {
        let slug: Option<String> =
            sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1 AND kind = 'user'")
                .bind(person)
                .fetch_optional(&self.pool)
                .await?;
        let Some(slug) = slug else {
            anyhow::bail!("there is nobody here with that id");
        };

        // The slug comes back beside the team because the exception key is
        // `t/<slug>` and a name cannot be turned back into one: two teams whose
        // names differ can slug the same, and the stored slug is the only
        // answer that is not a guess.
        let rows = sqlx::query(
            "SELECT p.id, p.name, p.slug, t.everyone,
                    (SELECT count(*) FROM team_members m2 WHERE m2.team_id = t.id)::int AS members
               FROM team_members m
               JOIN teams t ON t.id = m.team_id
               JOIN principals p ON p.id = t.id
              WHERE m.user_id = $1
              ORDER BY lower(p.name)",
        )
        .bind(person)
        .fetch_all(&self.pool)
        .await
        .context("reading the teams somebody is in")?;

        let mut teams = Vec::new();
        let mut team_slugs = Vec::new();
        for r in rows {
            team_slugs.push((r.get::<String, _>("slug"), r.get::<String, _>("name")));
            teams.push(Team {
                id: TeamId::from_stored(r.get::<String, _>("id")),
                name: r.get("name"),
                everyone: r.get("everyone"),
                members: r.get::<i32, _>("members") as i64,
            });
        }

        // Every route separately, then folded — `directory_access` takes the
        // max and throws away which grant produced it, and which grant produced
        // it is the whole question here.
        let rows = sqlx::query(
            "SELECT d.id, d.name, d.slug, g.level, 'direct' AS how, NULL::text AS team
               FROM grants g JOIN directories d ON d.id = g.directory_id
              WHERE g.subject_kind = 'person' AND g.subject_id = $1
             UNION ALL
             SELECT d.id, d.name, d.slug, g.level, 'team', p.name
               FROM grants g
               JOIN directories d ON d.id = g.directory_id
               JOIN team_members m ON m.team_id = g.subject_id AND m.user_id = $1
               JOIN principals p ON p.id = g.subject_id
              WHERE g.subject_kind = 'team'
             UNION ALL
             SELECT d.id, d.name, d.slug, g.level, 'everyone', NULL
               FROM grants g
               JOIN directories d ON d.id = g.directory_id
               JOIN teams t ON t.id = g.subject_id AND t.everyone
               JOIN users u ON u.org_id = t.org_id AND u.id = $1
              WHERE g.subject_kind = 'team'",
        )
        .bind(person)
        .fetch_all(&self.pool)
        .await
        .context("reading what somebody can work in")?;

        let mut directories: Vec<ReachedDirectory> = Vec::new();
        for r in rows {
            let id: String = r.get("id");
            let level = Level::parse(&r.get::<String, _>("level")).unwrap_or(Level::Viewer);
            let route = match r.get::<String, _>("how").as_str() {
                "direct" => HowReached::Direct,
                "everyone" => HowReached::Everyone,
                _ => HowReached::Team {
                    name: r.get::<Option<String>, _>("team").unwrap_or_default(),
                },
            };
            match directories.iter_mut().find(|d| d.directory_id == id) {
                Some(found) => {
                    if level.rank() > found.level.rank() {
                        found.level = level;
                    }
                    found.through.push(route);
                }
                None => directories.push(ReachedDirectory {
                    directory_id: id,
                    name: r.get("name"),
                    slug: r.get("slug"),
                    level,
                    through: vec![route],
                }),
            }
        }
        directories.sort_by_key(|d| d.name.to_lowercase());

        let mut exceptions = Vec::new();
        let mut keys = vec![(format!("u/{slug}"), HowReached::Direct)];
        for (team_slug, name) in &team_slugs {
            keys.push((
                format!("t/{team_slug}"),
                HowReached::Team { name: name.clone() },
            ));
        }
        for (key, route) in keys {
            exceptions.extend(self.named_by(&key, route).await?);
        }

        let administers = sqlx::query(
            "SELECT d.id, d.name, d.slug,
                    (SELECT count(*) FROM directory_access o
                      WHERE o.directory_id = d.id AND o.rank = 3 AND o.user_id <> $1) = 0
                      AS alone
               FROM directory_access a
               JOIN directories d ON d.id = a.directory_id
              WHERE a.user_id = $1 AND a.rank = 3
              ORDER BY lower(d.name)",
        )
        .bind(person)
        .fetch_all(&self.pool)
        .await
        .context("reading what somebody administers")?
        .into_iter()
        .map(|r| Administered {
            directory_id: r.get("id"),
            name: r.get("name"),
            slug: r.get("slug"),
            alone: r.get("alone"),
        })
        .collect();

        // Theirs by creation and filed elsewhere. Agent accounts carry no
        // `created_by`: the person who connected one is `user_id`, and that is
        // already how they are found.
        let mine = format!("u.{slug}");
        let created = sqlx::query(
            "SELECT 'workspace' AS kind, w.id, w.path::text, w.name, w.repo AS detail,
                    NULL::text AS owner_name
               FROM workspaces w
              WHERE w.created_by = $1 AND w.path IS NOT NULL AND NOT (w.path <@ $2::ltree)
             UNION ALL
             SELECT 'machine', h.id, h.path::text, h.name, NULL, NULL
               FROM hosts h
              WHERE h.created_by = $1 AND h.path IS NOT NULL AND NOT (h.path <@ $2::ltree)
             UNION ALL
             SELECT 'secret', s.scope || '/' || s.name || '/' || s.owner, s.path::text,
                    s.scope || '/' || s.name, s.scope, NULL
               FROM secrets s
              WHERE s.created_by = $1 AND s.path IS NOT NULL AND NOT (s.path <@ $2::ltree)
             ORDER BY kind, name",
        )
        .bind(person)
        .bind(&mine)
        .fetch_all(&self.pool)
        .await
        .context("reading what somebody made and filed elsewhere")?
        .into_iter()
        .map(|r| {
            Ok(Filed {
                kind: FiledKind::parse(&r.get::<String, _>("kind"))?,
                id: r.get("id"),
                path: ResourcePath::from_stored(r.get::<String, _>("path")),
                name: r.get("name"),
                detail: r.get("detail"),
                owner_name: r.get("owner_name"),
            })
        })
        .collect::<Result<Vec<_>>>()?;

        Ok(Reach {
            teams,
            directories,
            exceptions,
            owns: self.filed_under(&mine).await?,
            administers,
            created,
        })
    }

    /// Everything whose `extra_perms` names one key.
    async fn named_by(&self, key: &str, through: HowReached) -> Result<Vec<Named>> {
        let rows = sqlx::query(
            "SELECT 'workspace' AS kind, w.id, w.name, w.extra_perms ->> $1 AS level
               FROM workspaces w WHERE w.extra_perms ? $1
             UNION ALL
             SELECT 'machine', h.id, h.name, h.extra_perms ->> $1 FROM hosts h WHERE h.extra_perms ? $1
             UNION ALL
             SELECT 'agentAccount', a.id, a.name, a.extra_perms ->> $1
               FROM agent_accounts a WHERE a.extra_perms ? $1
             UNION ALL
             SELECT 'secret', s.scope || '/' || s.name || '/' || s.owner, s.scope || '/' || s.name,
                    s.extra_perms ->> $1
               FROM secrets s WHERE s.extra_perms ? $1",
        )
        .bind(key)
        .fetch_all(&self.pool)
        .await
        .context("reading what names somebody directly")?;

        rows.into_iter()
            .map(|r| {
                Ok(Named {
                    kind: FiledKind::parse(&r.get::<String, _>("kind"))?,
                    id: r.get("id"),
                    name: r.get("name"),
                    level: Level::parse(&r.get::<Option<String>, _>("level").unwrap_or_default())
                        .unwrap_or(Level::Viewer),
                    through: through.clone(),
                })
            })
            .collect()
    }

    /// Who `u/<slug>` is, as an id and a name to read.
    pub async fn person_by_slug(&self, slug: &str) -> Result<Option<(String, String)>> {
        sqlx::query_as("SELECT id, name FROM principals WHERE slug = $1 AND kind = 'user'")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await
            .context("looking up whose space this is")
    }

    /// What to call a principal, live or retired.
    pub async fn principal_name(&self, id: &str) -> Result<Option<String>> {
        sqlx::query_scalar("SELECT name FROM principals WHERE id = $1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("looking up a name")
    }

    /// The root of somebody's own space — `u/<their slug>`.
    pub async fn personal_root(&self, person: &str) -> Result<String> {
        let slug: Option<String> = sqlx::query_scalar("SELECT slug FROM principals WHERE id = $1")
            .bind(person)
            .fetch_optional(&self.pool)
            .await
            .context("looking up a person's slug")?;
        slug.ok_or_else(|| anyhow::anyhow!("{person} is not somebody here"))
    }

    /// Write the identity a person or a team is known by, forever.
    ///
    /// **This runs before the `users` or `teams` row**, because both reference
    /// it. It is the whole of what somebody needs on the way in: there is no
    /// directory to create and no grant to write, because `u/<slug>` is
    /// implicit — the simplification paths bought over a row per person.
    ///
    /// The loop is how a taken slug is settled. It is not a race: the unique
    /// index on `(org_id, slug)` is what decides, and a conflict simply costs
    /// another attempt. That index spans retired principals too, which is why a
    /// second Ana gets `ana_2` rather than the first Ana's access.
    pub async fn provision_principal(
        tx: &mut Transaction<'_, Postgres>,
        org: &OrgId,
        id: &str,
        kind: SubjectKind,
        name: &str,
    ) -> Result<String> {
        let base = ft_core::slug(name);
        for attempt in 0..20u32 {
            let slug = if attempt == 0 {
                base.clone()
            } else {
                format!("{base}_{}", attempt + 1)
            };
            let done = sqlx::query(
                "INSERT INTO principals (id, org_id, kind, slug, name)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
            )
            .bind(id)
            .bind(org.as_str())
            .bind(match kind {
                SubjectKind::Person => "user",
                SubjectKind::Team => "team",
            })
            .bind(&slug)
            .bind(name)
            .execute(&mut **tx)
            .await
            .context("writing an identity")?;
            if done.rows_affected() == 1 {
                return Ok(slug);
            }
        }
        bail!("could not find a free name for {name}")
    }

    /// Mark a principal as gone, keeping the row so its slug is never reissued.
    ///
    /// The `users` or `teams` row is deleted by the caller — cascades take the
    /// sessions and memberships with it. This is what survives, and it is the
    /// reason an exception written on somebody else's resource cannot land on a
    /// new person with the same name.
    pub async fn retire_principal(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<()> {
        sqlx::query(
            "UPDATE principals SET retired_at = now() WHERE id = $1 AND retired_at IS NULL",
        )
        .bind(id)
        .execute(&mut **tx)
        .await
        .context("retiring an identity")?;
        Ok(())
    }

    /// The one row an organisation cannot work without, plus the team that is
    /// everybody.
    pub async fn provision_organization(
        tx: &mut Transaction<'_, Postgres>,
        org: &OrgId,
    ) -> Result<(TeamId, DirectoryId)> {
        let team = TeamId::new();
        Self::provision_principal(tx, org, team.as_str(), SubjectKind::Team, "Everyone").await?;
        sqlx::query(
            "INSERT INTO teams (id, org_id, name, everyone) VALUES ($1, $2, 'Everyone', TRUE)",
        )
        .bind(team.as_str())
        .bind(org.as_str())
        .execute(&mut **tx)
        .await
        .context("creating the everyone team")?;

        let directory = DirectoryId::new();
        sqlx::query(
            "INSERT INTO directories (id, org_id, name, slug) VALUES ($1, $2, 'Shared', 'shared')",
        )
        .bind(directory.as_str())
        .bind(org.as_str())
        .execute(&mut **tx)
        .await
        .context("creating the shared directory")?;

        // Writer, not viewer. This is where compute goes when somebody shares
        // it, and everybody could always run on every machine — a viewer grant
        // here would be a permission system that took something away on the
        // way in.
        sqlx::query(
            "INSERT INTO grants (directory_id, subject_kind, subject_id, level)
             VALUES ($1, 'team', $2, 'writer')",
        )
        .bind(directory.as_str())
        .bind(team.as_str())
        .execute(&mut **tx)
        .await
        .context("opening the shared directory to everybody")?;

        Ok((team, directory))
    }

    /// File something somewhere else, and take its attachments with it.
    ///
    /// **The one place a transfer happens.** SQL cascades a delete and cannot
    /// cascade a move: nothing in the schema can say "when this changes hands,
    /// so does that". So the knowledge of what hangs off what lives here, in
    /// one function, the way `filed_where` is the one place access is defined.
    /// A reviewer checks this file, not thirty call sites.
    ///
    /// What moves with what:
    ///
    /// * an **agent account** carries its credential — the secret at
    ///   `agent/<credential_key>`, which is not a thing anybody files on its own
    ///   and would otherwise be left behind in the old owner's name, leaving a
    ///   subscription filed in one place whose token opens in another;
    /// * a **secret** is itself re-sealed, because its owner is in the
    ///   associated data of both crypto layers — see [`Vault::hand_over`];
    /// * a **workspace** and a **machine** carry nothing: what hangs off them —
    ///   runs, events, usage — are records of what happened, and a record of
    ///   the past does not change hands.
    ///
    /// Nothing about the thing itself moves either way: a workspace keeps its
    /// worktree, its branch and the agents running in it. What changes is who
    /// can reach it.
    pub async fn transfer(
        &self,
        vault: &crate::vault::Vault,
        kind: FiledKind,
        id: &str,
        to: &ResourcePath,
        by: &str,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        self.transfer_in(&mut tx, vault, kind, id, to, by).await?;
        tx.commit().await?;
        Ok(())
    }

    /// The same, inside somebody else's transaction — see [`Vault::hand_over_in`].
    pub async fn transfer_in(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        vault: &crate::vault::Vault,
        kind: FiledKind,
        id: &str,
        to: &ResourcePath,
        // `by` is who did it, spelled the way a person reads it: it ends up in
        // the vault's access log, which is read by somebody trying to find out
        // who moved a credential, and an id there is a lookup they cannot do.
        by: &str,
    ) -> Result<()> {
        // Who the new root *is*, for anything sealed against an owner. A person
        // or a directory: both are ids, and the vault does not care which.
        let holder: String = match to.root() {
            Some((ft_core::path::PERSONAL, slug)) => {
                sqlx::query_scalar("SELECT id FROM principals WHERE slug = $1 AND kind = 'user'")
                    .bind(slug)
                    .fetch_optional(&mut **tx)
                    .await?
                    .with_context(|| format!("no person at u/{slug}"))?
            }
            Some((ft_core::path::DIRECTORY, slug)) => {
                sqlx::query_scalar("SELECT id FROM directories WHERE slug = $1")
                    .bind(slug)
                    .fetch_optional(&mut **tx)
                    .await?
                    .with_context(|| format!("no directory at d/{slug}"))?
            }
            _ => bail!("a path starts with u/ or d/"),
        };

        match kind {
            FiledKind::Secret => {
                let (scope, name, addressed) = split_secret(id)?;
                let owner: String = sqlx::query_scalar(
                    "SELECT owner FROM secrets
                      WHERE scope = $1 AND name = $2 AND owner = $3",
                )
                .bind(scope)
                .bind(name)
                .bind(addressed)
                .fetch_optional(&mut **tx)
                .await?
                .context("no secret here to hand over")?;

                if owner != holder {
                    vault
                        .hand_over(
                            crate::vault::Key::of(scope, name, &owner),
                            &holder,
                            &format!("filed at {to} by {by}"),
                        )
                        .await?;
                }
                // `holder`, not the owner it had: `hand_over` moves the row,
                // because the owner is half the primary key. Either way the row
                // to file is the holder's by the time we are here — and naming
                // it by scope and name alone filed every namesake with it,
                // which is two people's GitHub token on one person's move.
                sqlx::query(
                    "UPDATE secrets SET path = $1::ltree
                      WHERE scope = $2 AND name = $3 AND owner = $4",
                )
                .bind(to.to_ltree())
                .bind(scope)
                .bind(name)
                .bind(&holder)
                .execute(&mut **tx)
                .await?;
            }
            FiledKind::AgentAccount => {
                // The credential's owner is read from the row that has it, and
                // never from `agent_accounts.user_id`.
                //
                // `user_id` is who connected the subscription, which stops being
                // who holds its credential the first time one is filed. Taking
                // an account *back* then compared `user_id` with itself, found
                // them equal, and quietly moved nothing — so the account came
                // home and its key stayed with the directory, where its owner
                // could no longer see it and no later move could find it either.
                let credential: String =
                    sqlx::query_scalar("SELECT credential_key FROM agent_accounts WHERE id = $1")
                        .bind(id)
                        .fetch_optional(&mut **tx)
                        .await?
                        .context("no agent account here")?;

                let owner: Option<String> =
                    sqlx::query_scalar("SELECT owner FROM secrets WHERE scope = $1 AND name = $2")
                        .bind(crate::vault::AGENT)
                        .bind(&credential)
                        .fetch_optional(&mut **tx)
                        .await?;

                // The credential follows the subscription. It is attached, not
                // filed: it has no path, and this is the only thing that ever
                // moves it. Nothing stored yet is nothing to move — a first
                // `connect` writes it under whoever holds the account then.
                if let Some(owner) = owner.filter(|o| o != &holder) {
                    vault
                        .hand_over(
                            crate::vault::Key::of(crate::vault::AGENT, &credential, &owner),
                            &holder,
                            &format!("its subscription was filed at {to} by {by}"),
                        )
                        .await?;
                }

                sqlx::query("UPDATE agent_accounts SET path = $1::ltree WHERE id = $2")
                    .bind(to.to_ltree())
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
            other => {
                let table = Self::table(other);
                let done = sqlx::query(&format!(
                    "UPDATE {table} SET path = $1::ltree WHERE id = $2"
                ))
                .bind(to.to_ltree())
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(|_| anyhow::anyhow!("there is already something filed at {to}"))?;
                anyhow::ensure!(
                    done.rows_affected() == 1,
                    "no {} here to file",
                    other.singular()
                );
            }
        }
        Ok(())
    }

    // ── exceptions ─────────────────────────────────────────────────────

    /// The key a principal is named by inside `extra_perms`.
    ///
    /// `u/<slug>` and `t/<slug>` — the same spelling a path uses, because they
    /// name the same things. Built here and nowhere else.
    async fn exception_key(&self, principal: &str) -> Result<String> {
        let found: Option<(String, String)> = sqlx::query_as(
            "SELECT kind, slug FROM principals WHERE id = $1 AND retired_at IS NULL",
        )
        .bind(principal)
        .fetch_optional(&self.pool)
        .await
        .context("looking up who an exception is for")?;
        let (kind, slug) = found.context("there is nobody here to let in")?;
        Ok(match kind.as_str() {
            "team" => format!("t/{slug}"),
            _ => format!("u/{slug}"),
        })
    }

    /// Who is named on this resource, over and above where it is filed.
    pub async fn exceptions_on(&self, kind: FiledKind, id: &str) -> Result<Vec<Exception>> {
        let table = Self::table(kind);
        let row: Option<serde_json::Value> = match kind {
            FiledKind::Secret => {
                let (scope, name, owner) = split_secret(id)?;
                sqlx::query_scalar(
                    "SELECT extra_perms FROM secrets
                      WHERE scope = $1 AND name = $2 AND owner = $3",
                )
                .bind(scope)
                .bind(name)
                .bind(owner)
                .fetch_optional(&self.pool)
                .await?
            }
            _ => {
                sqlx::query_scalar(&format!("SELECT extra_perms FROM {table} WHERE id = $1"))
                    .bind(id)
                    .fetch_optional(&self.pool)
                    .await?
            }
        };
        let Some(serde_json::Value::Object(map)) = row else {
            return Ok(Vec::new());
        };
        if map.is_empty() {
            return Ok(Vec::new());
        }

        // One read for every name, rather than one per entry. The slug is what
        // the blob holds; a person reads the name.
        let slugs: Vec<String> = map
            .keys()
            .filter_map(|k| k.split_once('/').map(|(_, s)| s.to_string()))
            .collect();
        let named: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT id, kind, slug FROM principals WHERE slug = ANY($1) AND retired_at IS NULL",
        )
        .bind(&slugs)
        .fetch_all(&self.pool)
        .await?;

        let mut out = Vec::new();
        for (principal, kind_of, slug) in named {
            let key = if kind_of == "team" {
                format!("t/{slug}")
            } else {
                format!("u/{slug}")
            };
            let Some(level) = map.get(&key).and_then(|v| v.as_str()) else {
                continue;
            };
            out.push(Exception {
                subject_kind: if kind_of == "team" {
                    SubjectKind::Team
                } else {
                    SubjectKind::Person
                },
                subject_id: principal,
                level: parse_level(level)?,
            });
        }
        Ok(out)
    }

    /// Let somebody into one resource, without moving it.
    ///
    /// **Capped at writer.** `admin` is not spellable here: administration
    /// belongs to the path, so exactly one place answers "who may change
    /// permissions". Somebody admin-by-exception could otherwise rewrite the
    /// grants of a directory they were only an exception to.
    pub async fn set_exception(
        &self,
        kind: FiledKind,
        id: &str,
        principal: &str,
        level: Level,
    ) -> Result<()> {
        anyhow::ensure!(
            level < Level::Admin,
            "somebody let into one thing cannot administer it — share the directory it is in instead"
        );
        let key = self.exception_key(principal).await?;
        self.write_exception(kind, id, &key, Some(level)).await
    }

    /// Take one back. Nothing else about the resource changes.
    pub async fn remove_exception(&self, kind: FiledKind, id: &str, principal: &str) -> Result<()> {
        let key = self.exception_key(principal).await?;
        self.write_exception(kind, id, &key, None).await
    }

    async fn write_exception(
        &self,
        kind: FiledKind,
        id: &str,
        key: &str,
        level: Option<Level>,
    ) -> Result<()> {
        let table = Self::table(kind);
        // `||` merges a key in, `-` takes one out. Either way the rest of the
        // blob is untouched, so two people editing different entries at once do
        // not overwrite each other.
        let set = match level {
            Some(_) => "extra_perms = extra_perms || jsonb_build_object($1::text, $2::text)",
            None => "extra_perms = extra_perms - $1::text",
        };
        let level = level.map(|l| l.as_str()).unwrap_or("");

        let done = match kind {
            FiledKind::Secret => {
                let (scope, name, owner) = split_secret(id)?;
                sqlx::query(&format!(
                    "UPDATE secrets SET {set}
                      WHERE scope = $3 AND name = $4 AND owner = $5"
                ))
                .bind(key)
                .bind(level)
                .bind(scope)
                .bind(name)
                .bind(owner)
                .execute(&self.pool)
                .await?
            }
            _ => {
                sqlx::query(&format!("UPDATE {table} SET {set} WHERE id = $3"))
                    .bind(key)
                    .bind(level)
                    .bind(id)
                    .execute(&self.pool)
                    .await?
            }
        };
        anyhow::ensure!(done.rows_affected() == 1, "no {} here", kind.singular());
        Ok(())
    }

    /// Take a departed principal out of every blob that named them.
    ///
    /// **Hygiene, not the guarantee.** What makes a stale `{"u/ana": "writer"}`
    /// harmless is that `ana` is never issued to anybody again — see
    /// `principals`. This keeps the rows tidy and the screens honest; if a table
    /// is ever added and forgotten here, the cost is a dead entry rather than a
    /// stranger's access.
    pub async fn forget_exceptions(tx: &mut Transaction<'_, Postgres>, key: &str) -> Result<()> {
        for table in ["workspaces", "hosts", "agent_accounts", "secrets"] {
            sqlx::query(&format!(
                "UPDATE {table} SET extra_perms = extra_perms - $1::text WHERE extra_perms ? $1"
            ))
            .bind(key)
            .execute(&mut **tx)
            .await
            .with_context(|| format!("forgetting exceptions in {table}"))?;
        }
        Ok(())
    }

    // ── grants ─────────────────────────────────────────────────────────

    /// Who may do what here, people first, then teams, by name.
    pub async fn grants_on(&self, directory: &str) -> Result<Vec<Grant>> {
        let rows = sqlx::query(
            "SELECT g.subject_kind, g.subject_id, g.level,
                    COALESCE(p.name, '(gone)') AS subject_name
               FROM grants g
               LEFT JOIN principals p ON p.id = g.subject_id
              WHERE g.directory_id = $1
              ORDER BY g.subject_kind, lower(COALESCE(p.name, ''))",
        )
        .bind(directory)
        .fetch_all(&self.pool)
        .await
        .context("reading the grants on a directory")?;

        rows.into_iter()
            .map(|r| {
                Ok(Grant {
                    subject_kind: parse_subject(&r.get::<String, _>("subject_kind"))?,
                    subject_id: r.get("subject_id"),
                    subject_name: r.get("subject_name"),
                    level: parse_level(&r.get::<String, _>("level"))?,
                })
            })
            .collect()
    }

    /// Give a person or a team a level here, replacing whatever they had.
    ///
    /// Refuses to leave a directory with nobody to administer it. That is the
    /// same rule as the last administrator of the organisation, for the same
    /// reason: a directory nobody can change the grants on is a locked room,
    /// and the things filed in it are inside.
    pub async fn set_grant(
        &self,
        directory: &str,
        kind: SubjectKind,
        subject: &str,
        level: Level,
        by: &UserId,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        // Locked for the length of the check, so two people demoting the last
        // two administrators at once cannot both find somebody else still there.
        sqlx::query("SELECT 1 FROM directories WHERE id = $1 FOR UPDATE")
            .bind(directory)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| anyhow::anyhow!("no directory here"))?;

        Self::exists(&mut tx, kind, subject).await?;

        if level < Level::Admin {
            Self::keep_an_administrator(&mut tx, directory, kind, subject).await?;
        }

        sqlx::query(
            "INSERT INTO grants (directory_id, subject_kind, subject_id, level, granted_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (directory_id, subject_kind, subject_id)
             DO UPDATE SET level = $4, granted_by = $5, granted_at = now()",
        )
        .bind(directory)
        .bind(kind.as_str())
        .bind(subject)
        .bind(level.as_str())
        .bind(by.as_str())
        .execute(&mut *tx)
        .await
        .context("writing a grant")?;

        tx.commit().await?;
        Ok(())
    }

    pub async fn revoke(&self, directory: &str, kind: SubjectKind, subject: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        sqlx::query("SELECT 1 FROM directories WHERE id = $1 FOR UPDATE")
            .bind(directory)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| anyhow::anyhow!("no directory here"))?;

        Self::keep_an_administrator(&mut tx, directory, kind, subject).await?;

        sqlx::query(
            "DELETE FROM grants WHERE directory_id = $1 AND subject_kind = $2 AND subject_id = $3",
        )
        .bind(directory)
        .bind(kind.as_str())
        .bind(subject)
        .execute(&mut *tx)
        .await
        .context("revoking a grant")?;

        tx.commit().await?;
        Ok(())
    }

    /// Whether the thing a grant is about to name is really there, and still is.
    ///
    /// `grants.subject_id` now carries a foreign key to `principals`, so the
    /// database catches an id that was never anybody. What it cannot catch is an
    /// id that *was* somebody — a principal is never deleted — so this is the
    /// check that they have not left.
    async fn exists(
        tx: &mut Transaction<'_, Postgres>,
        kind: SubjectKind,
        subject: &str,
    ) -> Result<()> {
        let live: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM principals WHERE id = $1 AND kind = $2 AND retired_at IS NULL",
        )
        .bind(subject)
        .bind(match kind {
            SubjectKind::Person => "user",
            SubjectKind::Team => "team",
        })
        .fetch_optional(&mut **tx)
        .await?;
        if live.is_none() {
            bail!(
                "there is no {} here to grant anything to",
                match kind {
                    SubjectKind::Person => "person",
                    SubjectKind::Team => "team",
                }
            );
        }
        Ok(())
    }

    /// Refuse if taking *this* grant down would leave nobody administering.
    ///
    /// Only when the subject is an administrator here now. A directory with no
    /// administrator at all is not something to defend — it is the state this
    /// rule exists to get out of, and the shared directory a first boot makes is
    /// exactly that: one `writer` grant to the team that is everybody, and no
    /// admin. Counting "others" without first asking whether this subject is one
    /// made every grant on it refuse, which is the locked room the rule was
    /// written to prevent rather than to cause.
    ///
    /// Who unsticks such a directory is an administrator of the organisation —
    /// see `may_administer` in `api::access`, which lets them in without a
    /// grant and leaves a row with their name on it when they give themselves
    /// one.
    async fn keep_an_administrator(
        tx: &mut Transaction<'_, Postgres>,
        directory: &str,
        kind: SubjectKind,
        subject: &str,
    ) -> Result<()> {
        let is_admin_here: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM grants
                             WHERE directory_id = $1 AND level = 'admin'
                               AND subject_kind = $2 AND subject_id = $3)",
        )
        .bind(directory)
        .bind(kind.as_str())
        .bind(subject)
        .fetch_one(&mut **tx)
        .await?;

        if !is_admin_here {
            return Ok(());
        }

        let others: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM grants
              WHERE directory_id = $1 AND level = 'admin'
                AND NOT (subject_kind = $2 AND subject_id = $3)",
        )
        .bind(directory)
        .bind(kind.as_str())
        .bind(subject)
        .fetch_one(&mut **tx)
        .await?;

        if others == 0 {
            bail!("somebody has to be able to administer this directory");
        }
        Ok(())
    }
}

/// `scope/name`, as `Filed::id` spells a secret.
///
/// Split once from the left: a scope never contains a slash and a name may —
/// `env:r_01.../DATABASE_URL` is one of ours — so splitting from the right
/// would cut the name in half.
/// `scope/name/owner` — the whole of what identifies a secret.
///
/// **The owner is not optional.** `secrets` is keyed `(scope, name, owner)`
/// precisely so that two people can each authorize GitHub as themselves, so a
/// `scope/name` names *a set of rows*, not a row. It was addressed that way,
/// and the consequence was not a wrong answer but a dangerous one: naming
/// somebody on `global/GITHUB_TOKEN` updated every row with that scope and
/// name, then failed the "exactly one row" check *after* the write and with no
/// transaction to undo it — so the caller saw "no secret here" and the person
/// they named silently gained everybody's.
///
/// The owner is a user id, a directory id, or empty for the install's own —
/// none of which may contain a `/`, so the last segment is the owner and
/// whatever precedes it splits once into scope and name.
fn split_secret(id: &str) -> Result<(&str, &str, &str)> {
    let (head, owner) = id
        .rsplit_once('/')
        .ok_or_else(|| anyhow::anyhow!("{id} does not name a secret"))?;
    let (scope, name) = head
        .split_once('/')
        .ok_or_else(|| anyhow::anyhow!("{id} does not name a secret"))?;
    Ok((scope, name, owner))
}

/// A name somebody typed, trimmed, or a sentence saying why not.
fn check_name(name: &str, what: &str) -> Result<String> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "{what} needs a name");
    anyhow::ensure!(name.chars().count() <= 80, "that name is too long");
    Ok(name.to_string())
}

fn directory_from_row(r: sqlx::postgres::PgRow) -> Result<Directory> {
    Ok(Directory {
        id: DirectoryId::from_stored(r.get::<String, _>("id")),
        name: r.get("name"),
        slug: r.get("slug"),
        // `try_get`, because `level` is what *this person* may do here and not
        // every read asks. A query that leaves it out means "nothing was asked",
        // which is exactly what `None` says — `get` panics instead, and one
        // query that forgot the column took down every request that reached it.
        level: r
            .try_get::<Option<String>, _>("level")
            .ok()
            .flatten()
            .map(|l| parse_level(&l))
            .transpose()?,
        workspaces: r.get("workspaces"),
        hosts: r.get("hosts"),
        agent_accounts: r.get("agent_accounts"),
        secrets: r.get("secrets"),
    })
}

/// What is in the way of removing a directory, in words.
fn what_it_holds(directory: &Directory) -> String {
    let mut parts = Vec::new();
    for (n, one, many) in [
        (directory.workspaces, "workspace", "workspaces"),
        (directory.hosts, "machine", "machines"),
        (directory.agent_accounts, "agent account", "agent accounts"),
        (directory.secrets, "secret", "secrets"),
    ] {
        if n > 0 {
            parts.push(format!("{n} {}", if n == 1 { one } else { many }));
        }
    }
    parts.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::Accounts;
    use crate::db::Db;
    use crate::vault::{crypto::RootKey, Key, Vault};

    /// A database with an organisation, an administrator, and the two rows a
    /// first boot makes.
    async fn set_up() -> (Db, Access, Accounts, OrgId, UserId) {
        let (db, admin) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let access = Access::new(db.pool().clone());
        let org = OrgId::from_stored(db.org().await.unwrap());
        (db, access, accounts, org, UserId::from_stored(admin))
    }

    /// A vault, for the tests that move something sealed.
    fn vault(db: &Db) -> Vault {
        Vault::new(db.pool().clone(), RootKey::generate())
    }

    async fn person(accounts: &Accounts, org: &OrgId, name: &str) -> UserId {
        accounts
            .create_user(org, name, &format!("{name}@example.test"), "member")
            .await
            .unwrap()
            .0
            .id
    }

    /// The state a first boot leaves: everybody with a root of their own that
    /// has no row, and one directory everybody works in.
    #[tokio::test]
    async fn everybody_has_a_root_of_their_own_and_one_they_share() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;

        assert_eq!(access.personal_root(admin.as_str()).await.unwrap(), "admin");
        assert_eq!(access.personal_root(ana.as_str()).await.unwrap(), "ana");

        // There is no row to find, and that is the simplification paths bought:
        // nothing to create on the way in, nothing to clean up on the way out,
        // and no directory anybody can accidentally delete.
        let all = access
            .directories_in(org.as_str(), admin.as_str())
            .await
            .unwrap();
        assert_eq!(all.len(), 1, "one directory exists: the shared one");
        assert_eq!(all[0].slug, "shared");

        // Reached through the team that is everybody — and `ana` was created
        // after both, with no membership row written for her.
        let shared = access.shared(org.as_str()).await.unwrap();
        assert_eq!(
            access
                .level_on(ana.as_str(), shared.as_str())
                .await
                .unwrap(),
            Some(Level::Writer),
            "everybody works in the shared directory, including whoever joins later"
        );
        drop(db);
    }

    /// The whole of what a path is for: where a thing is decides who sees it.
    #[tokio::test]
    async fn where_it_is_filed_is_who_can_reach_it() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let vault = vault(&db);

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();
        assert_eq!(
            host.path.as_str(),
            "u/admin/fire_01",
            "a machine is personal until somebody shares it"
        );

        let seen = |who: &UserId| {
            let db = db.clone();
            let who = who.clone();
            async move { db.hosts_for(who.as_str(), Level::Viewer).await.unwrap() }
        };
        assert_eq!(seen(&admin).await.len(), 1, "his own");
        assert!(seen(&ana).await.is_empty(), "and nobody else's");

        // Filed into the directory everybody works in, and now she has it.
        let shared = access.shared(org.as_str()).await.unwrap();
        let to = host.path.moved_to(ft_core::path::DIRECTORY, "shared");
        access
            .transfer(&vault, FiledKind::Machine, host.id.as_str(), &to, "admin")
            .await
            .unwrap();
        assert_eq!(seen(&ana).await.len(), 1, "shared is everybody's");

        // And the directory says so, without a join: the counts are `<@`
        // against the path index.
        let held = access.directory(shared.as_str()).await.unwrap().unwrap();
        assert_eq!(held.hosts, 1);
        let inside = access.filed_in("shared").await.unwrap();
        assert_eq!(inside.len(), 1);
        assert_eq!(inside[0].name, "fire-01");
        assert_eq!(inside[0].path.as_str(), "d/shared/fire_01");
    }

    /// Filing something hands it over. The person who did it keeps whatever the
    /// directory grants them, and nothing else — which is the Windmill rule and
    /// the reason there is only ever one source of authority over a thing.
    #[tokio::test]
    async fn filing_something_hands_it_over() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let vault = vault(&db);

        // Hers, in her own space, and his to administer only because he
        // administers the organisation.
        let backend = access
            .create_directory(&org, "Backend", &ana, &[])
            .await
            .unwrap();
        assert_eq!(backend.slug, "backend");

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();
        let to = host.path.moved_to(ft_core::path::DIRECTORY, &backend.slug);
        access
            .transfer(&vault, FiledKind::Machine, host.id.as_str(), &to, "admin")
            .await
            .unwrap();

        assert_eq!(
            db.hosts_for(ana.as_str(), Level::Writer)
                .await
                .unwrap()
                .len(),
            1,
            "she administers Backend, so it is hers now"
        );
        assert!(
            db.hosts_for(admin.as_str(), Level::Viewer)
                .await
                .unwrap()
                .is_empty(),
            "and he gave it away — he holds no grant on Backend"
        );

        // What survives the change of hands is who made it.
        let made_by: Option<String> =
            sqlx::query_scalar("SELECT created_by FROM hosts WHERE id = $1")
                .bind(host.id.as_str())
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(made_by.as_deref(), Some(admin.as_str()));
    }

    /// A subscription's credential is *attached*: it has no path, and moving
    /// the account is the only thing that ever moves it.
    ///
    /// The failure this prevents is a subscription filed in one directory whose
    /// token still opens under the person who connected it — a borrowed account
    /// that reports itself as needing to be set up.
    #[tokio::test]
    async fn a_subscription_takes_its_credential_with_it() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let vault = vault(&db);

        let backend = access
            .create_directory(&org, "Backend", &ana, &[])
            .await
            .unwrap();

        let id = ulid::Ulid::new().to_string();
        let key = format!("account:{id}");
        sqlx::query(
            "INSERT INTO agent_accounts (id, user_id, kind, name, mode, credential_key, state, path)
             VALUES ($1, $2, 'ClaudeCode', 'Work', 'Subscription', $3, 'connected',
                     ('u.admin.work_' || substr($1, 1, 8))::ltree)",
        )
        .bind(&id)
        .bind(admin.as_str())
        .bind(&key)
        .execute(db.pool())
        .await
        .unwrap();
        vault
            .put(
                crate::vault::Key::of(crate::vault::AGENT, &key, admin.as_str()),
                "a-token",
                "connecting",
            )
            .await
            .unwrap();

        let at = access
            .path_of(FiledKind::AgentAccount, &id)
            .await
            .unwrap()
            .unwrap();
        access
            .transfer(
                &vault,
                FiledKind::AgentAccount,
                &id,
                &at.moved_to(ft_core::path::DIRECTORY, &backend.slug),
                "admin",
            )
            .await
            .unwrap();

        // Sealed under the directory now, and it still opens — a transfer is
        // open-then-seal, not an `UPDATE`, because the owner is in the
        // associated data of both crypto layers.
        let held = crate::vault::Key::of(crate::vault::AGENT, &key, backend.id.as_str());
        assert_eq!(
            vault
                .get(held, "checking it followed")
                .await
                .unwrap()
                .as_deref()
                .map(|s| s.to_string()),
            Some("a-token".to_string())
        );
        assert!(
            !vault
                .holds(crate::vault::Key::of(
                    crate::vault::AGENT,
                    &key,
                    admin.as_str()
                ))
                .await
                .unwrap(),
            "and it is not left behind in his name"
        );

        // It is attached, so it is not something the directory lists: the
        // subscription is.
        let inside = access.filed_in(&backend.slug).await.unwrap();
        assert_eq!(inside.len(), 1);
        assert_eq!(inside[0].kind, FiledKind::AgentAccount);
    }

    /// Looking a directory up by the slug in a path must not need a person.
    ///
    /// The regression: `directory_by_slug` did not select `level` — what *this
    /// person* may do here, which this read has no person to answer for — and
    /// the row reader took it with `get`, which panics. Every request that
    /// reached it died with an empty reply, and the one that reaches it is a
    /// member asking to move something. An administrator never got there:
    /// `may_share` answers for them a line earlier.
    #[tokio::test]
    async fn a_directory_can_be_found_by_its_slug_without_anybody_asking() {
        let (_db, access, _accounts, org, admin) = set_up().await;
        access
            .create_directory(&org, "Ledger work", &admin, &[])
            .await
            .unwrap();

        let found = access
            .directory_by_slug(org.as_str(), "ledger_work")
            .await
            .expect("looking one up is not an error")
            .expect("it is there");

        assert_eq!(found.name, "Ledger work");
        assert_eq!(
            found.level, None,
            "nobody was named, so there is nothing to say about what they may do"
        );
        assert!(access
            .directory_by_slug(org.as_str(), "nosuch")
            .await
            .unwrap()
            .is_none());
    }

    /// A path five labels deep grants nothing extra, and that is the whole
    /// reason the access check is one indexed predicate.
    #[tokio::test]
    async fn only_the_first_two_labels_decide_anything() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let vault = vault(&db);

        let backend = access
            .create_directory(&org, "Backend", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                backend.id.as_str(),
                SubjectKind::Person,
                ana.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .unwrap();

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();
        // Deliberately nested: extra labels are a name with separators in it.
        let deep = ResourcePath::from_stored("d.backend.eu.west.fire_01");
        access
            .transfer(&vault, FiledKind::Machine, host.id.as_str(), &deep, "admin")
            .await
            .unwrap();

        assert_eq!(
            db.hosts_for(ana.as_str(), Level::Viewer)
                .await
                .unwrap()
                .len(),
            1,
            "her grant on `backend` reaches every depth under it"
        );
        assert!(
            db.hosts_for(ana.as_str(), Level::Writer)
                .await
                .unwrap()
                .is_empty(),
            "and depth never adds to what the grant said"
        );
        assert_eq!(
            access
                .directory(backend.id.as_str())
                .await
                .unwrap()
                .unwrap()
                .hosts,
            1,
            "a directory counts what is under it, however deep"
        );
    }

    /// The case the whole feature was added for.
    ///
    /// Bob makes a workspace and wants Lisa to see it. Before exceptions the
    /// only route was: create a directory holding them both, and hand the
    /// workspace to it — a lot of machinery for "let Lisa in", and it transfers
    /// ownership as a side effect. Now it is one entry, Bob keeps his workspace,
    /// and nothing moves.
    #[tokio::test]
    async fn one_person_can_be_let_into_one_thing() {
        let (db, access, accounts, org, _admin) = set_up().await;
        let bob = person(&accounts, &org, "bob").await;
        let lisa = person(&accounts, &org, "lisa").await;

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, bob.as_str())
            .await
            .unwrap();
        assert!(
            db.hosts_for(lisa.as_str(), Level::Viewer)
                .await
                .unwrap()
                .is_empty(),
            "it is his"
        );

        access
            .set_exception(
                FiledKind::Machine,
                host.id.as_str(),
                lisa.as_str(),
                Level::Writer,
            )
            .await
            .unwrap();

        assert_eq!(
            db.hosts_for(lisa.as_str(), Level::Writer)
                .await
                .unwrap()
                .len(),
            1,
            "she is named on it"
        );
        // And it is still his. An exception is access, never ownership.
        let after = db.host_by_name("fire-01").await.unwrap().unwrap();
        assert_eq!(after.path.as_str(), "u/bob/fire_01");

        let named = access
            .exceptions_on(FiledKind::Machine, host.id.as_str())
            .await
            .unwrap();
        assert_eq!(named.len(), 1);
        assert_eq!(named[0].subject_id, lisa.as_str());
        assert_eq!(named[0].level, Level::Writer);

        access
            .remove_exception(FiledKind::Machine, host.id.as_str(), lisa.as_str())
            .await
            .unwrap();
        assert!(db
            .hosts_for(lisa.as_str(), Level::Viewer)
            .await
            .unwrap()
            .is_empty());
    }

    /// A team can be named too, and it reaches everybody in it.
    #[tokio::test]
    async fn a_team_can_be_let_into_one_thing() {
        let (db, access, accounts, org, _admin) = set_up().await;
        let bob = person(&accounts, &org, "bob").await;
        let lisa = person(&accounts, &org, "lisa").await;
        let backend = access.create_team(&org, "Backend").await.unwrap();
        access
            .add_member(backend.id.as_str(), lisa.as_str())
            .await
            .unwrap();

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, bob.as_str())
            .await
            .unwrap();
        access
            .set_exception(
                FiledKind::Machine,
                host.id.as_str(),
                backend.id.as_str(),
                Level::Viewer,
            )
            .await
            .unwrap();

        assert_eq!(
            db.hosts_for(lisa.as_str(), Level::Viewer)
                .await
                .unwrap()
                .len(),
            1,
            "through the team she is in"
        );
        assert!(
            db.hosts_for(lisa.as_str(), Level::Writer)
                .await
                .unwrap()
                .is_empty(),
            "and only as far as the exception said"
        );
    }

    /// The fourth route reaches a secret, not only a machine.
    ///
    /// Every kind reads through [`filed_where`], so this cannot be true of one
    /// and false of another — but a secret is the one where being wrong is
    /// expensive, and until this the exception route was only ever exercised on
    /// a host. It is also the one kind addressed by something other than an id,
    /// which is its own way to be wrong.
    #[tokio::test]
    async fn one_person_can_be_let_into_one_secret() {
        let (db, access, accounts, org, _admin) = set_up().await;
        let bob = person(&accounts, &org, "bob").await;
        let lisa = person(&accounts, &org, "lisa").await;
        let vault = vault(&db);

        vault
            .put(
                Key::of("global", "STRIPE_KEY", bob.as_str()),
                "sk_live_not_a_real_one",
                "a test",
            )
            .await
            .unwrap();

        assert!(
            vault
                .names_for(lisa.as_str(), Level::Viewer)
                .await
                .unwrap()
                .is_empty(),
            "bob's own space is nobody else's"
        );

        access
            .set_exception(
                FiledKind::Secret,
                &format!("global/STRIPE_KEY/{bob}"),
                lisa.as_str(),
                Level::Viewer,
            )
            .await
            .unwrap();

        assert_eq!(
            vault
                .names_for(lisa.as_str(), Level::Viewer)
                .await
                .unwrap()
                .len(),
            1,
            "named on the one secret, and reaching it"
        );
        assert!(
            vault
                .names_for(lisa.as_str(), Level::Writer)
                .await
                .unwrap()
                .is_empty(),
            "and only as far as the exception said"
        );

        access
            .remove_exception(
                FiledKind::Secret,
                &format!("global/STRIPE_KEY/{bob}"),
                lisa.as_str(),
            )
            .await
            .unwrap();
        assert!(vault
            .names_for(lisa.as_str(), Level::Viewer)
            .await
            .unwrap()
            .is_empty());
    }

    /// Two people each authorizing GitHub as themselves is the point of the
    /// owner being half the key — so naming somebody on one must not name them
    /// on the other.
    ///
    /// It did. `scope/name` matched both rows, the `UPDATE` wrote to both, and
    /// the "exactly one row" check fired afterwards with nothing to roll it
    /// back: the caller was told "no secret here" while the person they named
    /// quietly gained everybody's.
    #[tokio::test]
    async fn naming_somebody_on_one_secret_does_not_name_them_on_a_namesake() {
        let (db, access, accounts, org, _admin) = set_up().await;
        let bob = person(&accounts, &org, "bob").await;
        let ana = person(&accounts, &org, "ana").await;
        let lisa = person(&accounts, &org, "lisa").await;
        let vault = vault(&db);

        for who in [&bob, &ana] {
            vault
                .put(
                    Key::of("global", "GITHUB_TOKEN", who.as_str()),
                    "t",
                    "a test",
                )
                .await
                .unwrap();
        }

        access
            .set_exception(
                FiledKind::Secret,
                &format!("global/GITHUB_TOKEN/{bob}"),
                lisa.as_str(),
                Level::Viewer,
            )
            .await
            .unwrap();

        let seen = vault.names_for(lisa.as_str(), Level::Viewer).await.unwrap();
        assert_eq!(seen.len(), 1, "bob's, and not ana's");
        assert_eq!(seen[0].owner, bob.as_str());

        assert_eq!(
            access
                .exceptions_on(FiledKind::Secret, &format!("global/GITHUB_TOKEN/{ana}"))
                .await
                .unwrap()
                .len(),
            0,
            "ana's namesake is untouched"
        );
    }

    /// An *attached* thing has no path, and asking where it is filed is a fair
    /// question with a plain answer.
    ///
    /// It used to be a decoding error: `path` is nullable on every kind, and a
    /// null was read as a broken column rather than as "nowhere". The install's
    /// own SSH identity — the one that opens every machine in the fleet — was
    /// the row that produced it.
    #[tokio::test]
    async fn something_filed_nowhere_says_so_rather_than_failing() {
        let (db, access, _accounts, _org, _admin) = set_up().await;
        let vault = vault(&db);
        vault
            .put(Key::shared("firetower", "ssh-identity"), "k", "a test")
            .await
            .unwrap();

        assert!(access
            .path_of(FiledKind::Secret, "firetower/ssh-identity/")
            .await
            .unwrap()
            .is_none());
        assert!(access
            .path_of(FiledKind::Secret, "firetower/nothing-here/")
            .await
            .unwrap()
            .is_none());
    }

    /// Filing one person's token does not file everybody's.
    ///
    /// The move wrote `path` by scope and name, so two people who had each
    /// authorized GitHub as themselves were one `UPDATE` — one of them filed
    /// something and handed over the other's with it.
    #[tokio::test]
    async fn filing_one_secret_leaves_a_namesake_where_it_was() {
        let (db, access, accounts, org, admin) = set_up().await;
        let bob = person(&accounts, &org, "bob").await;
        let ana = person(&accounts, &org, "ana").await;
        let vault = vault(&db);

        for who in [&bob, &ana] {
            vault
                .put(Key::of("git", "github", who.as_str()), "t", "a test")
                .await
                .unwrap();
        }

        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();
        let there = ft_core::path::ResourcePath::from_stored(format!("d.{}.github", shelf.slug));
        access
            .transfer(
                &vault,
                FiledKind::Secret,
                &format!("git/github/{bob}"),
                &there,
                "admin",
            )
            .await
            .unwrap();

        let moved = access
            .path_of(FiledKind::Secret, &format!("git/github/{}", shelf.id))
            .await
            .unwrap()
            .expect("bob's, under the directory that now owns it");
        assert!(
            moved.as_str().starts_with(&format!("d/{}", shelf.slug)),
            "filed where it was sent: {}",
            moved.as_str()
        );

        let untouched = access
            .path_of(FiledKind::Secret, &format!("git/github/{ana}"))
            .await
            .unwrap()
            .expect("ana's is still ana's");
        assert!(
            untouched.as_str().starts_with("u/"),
            "and still in her own space, not dragged along: {}",
            untouched.as_str()
        );
    }

    /// A subscription taken back brings its credential home.
    ///
    /// It did not: the move compared `agent_accounts.user_id` with where the
    /// account was going, and on the way back those are the same person — so it
    /// moved nothing, and the key stayed sealed to the directory while the
    /// account sat in its owner's space. They could no longer see it, and the
    /// next move could not find it either.
    #[tokio::test]
    async fn taking_a_subscription_back_brings_its_credential_with_it() {
        let (db, access, _accounts, org, admin) = set_up().await;
        let vault = vault(&db);
        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();

        let id = "acct_for_the_take_back";
        sqlx::query(
            "INSERT INTO agent_accounts(id,user_id,kind,name,mode,credential_key,state,path) \
             VALUES($1,$2,'ClaudeCode','Mine','Subscription',$1,'pending', \
                    ('u.' || (SELECT slug FROM principals WHERE id=$2) || '.mine')::ltree)",
        )
        .bind(id)
        .bind(admin.as_str())
        .execute(db.pool())
        .await
        .unwrap();
        let key = id.to_string();
        vault
            .put(
                Key::of(crate::vault::AGENT, &key, admin.as_str()),
                "t",
                "a test",
            )
            .await
            .unwrap();

        let owner_now = || async {
            sqlx::query_scalar::<_, String>(
                "SELECT owner FROM secrets WHERE scope = $1 AND name = $2",
            )
            .bind(crate::vault::AGENT)
            .bind(&key)
            .fetch_one(db.pool())
            .await
            .unwrap()
        };

        let there = ft_core::path::ResourcePath::from_stored(format!("d.{}.mine", shelf.slug));
        access
            .transfer(&vault, FiledKind::AgentAccount, id, &there, "admin")
            .await
            .unwrap();
        assert_eq!(
            owner_now().await,
            shelf.id.as_str(),
            "filed: the directory holds it"
        );

        let home = ft_core::path::ResourcePath::from_stored("u.admin.mine");
        access
            .transfer(&vault, FiledKind::AgentAccount, id, &home, "admin")
            .await
            .unwrap();
        assert_eq!(
            owner_now().await,
            admin.as_str(),
            "taken back: so is the key"
        );
    }

    /// One API key a team shares: filed into a directory, it answers for
    /// everybody the directory lets in, and for nobody else.
    ///
    /// This is what `Vault::owner_for` is for, and what the tracker reads now
    /// ask instead of assuming the key is the asker's. A Linear workspace key
    /// belongs to the workspace; five people pasting the same string is not an
    /// arrangement a product should require.
    #[tokio::test]
    async fn a_filed_api_key_answers_for_the_directory() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let bob = person(&accounts, &org, "bob").await;
        let vault = vault(&db);

        vault
            .put(
                Key::of(crate::vault::TRACKER, "linear", ana.as_str()),
                "lin_key",
                "a test",
            )
            .await
            .unwrap();

        let resolve = |who: String| {
            let vault = &vault;
            async move {
                vault
                    .owner_for(crate::vault::TRACKER, "linear", &who, Level::Viewer)
                    .await
                    .unwrap()
            }
        };

        assert_eq!(
            resolve(ana.to_string()).await.as_deref(),
            Some(ana.as_str())
        );
        assert!(
            resolve(bob.to_string()).await.is_none(),
            "not while it is ana's alone"
        );

        let team = access
            .create_directory(&org, "Team", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                team.id.as_str(),
                SubjectKind::Person,
                bob.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .unwrap();
        let there =
            ft_core::path::ResourcePath::from_stored(format!("d.{}.tracker.linear", team.slug));
        access
            .transfer(
                &vault,
                FiledKind::Secret,
                &format!("tracker/linear/{ana}"),
                &there,
                "ana",
            )
            .await
            .unwrap();

        assert_eq!(
            resolve(bob.to_string()).await.as_deref(),
            Some(team.id.as_str()),
            "filed where he works, so it answers for him"
        );

        let cleo = person(&accounts, &org, "cleo").await;
        assert!(
            resolve(cleo.to_string()).await.is_none(),
            "and for nobody the directory does not let in"
        );
    }

    /// What one person reaches, and *how* — which is the only part that helps
    /// when the question is how to take it away.
    ///
    /// `directory_access` takes the most generous route and throws the rest
    /// away. That is right for enforcement and useless for offboarding:
    /// revoking a grant somebody never held changes nothing, and a screen that
    /// cannot say "through Backend" sends an administrator to undo the wrong
    /// thing.
    #[tokio::test]
    async fn what_somebody_reaches_says_how_they_reach_it() {
        let (db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let vault = vault(&db);

        let backend = access.create_team(&org, "Backend").await.unwrap();
        access
            .add_member(backend.id.as_str(), ana.as_str())
            .await
            .unwrap();

        let prod = access
            .create_directory(&org, "Production", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                prod.id.as_str(),
                SubjectKind::Team,
                backend.id.as_str(),
                Level::Writer,
                &admin,
            )
            .await
            .unwrap();

        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Person,
                ana.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .unwrap();

        // Hers, so it is what a deletion would take.
        vault
            .put(Key::of("git", "github", ana.as_str()), "t", "a test")
            .await
            .unwrap();

        let reach = access.reach(ana.as_str()).await.unwrap();

        assert_eq!(reach.teams.len(), 1, "Backend");
        let prod_row = reach
            .directories
            .iter()
            .find(|d| d.slug == prod.slug)
            .expect("Production");
        assert!(
            matches!(prod_row.through.as_slice(), [HowReached::Team { name }] if name == "Backend"),
            "through the team and not directly: {:?}",
            prod_row.through
        );
        let shelf_row = reach
            .directories
            .iter()
            .find(|d| d.slug == shelf.slug)
            .expect("Shelf");
        assert!(matches!(shelf_row.through.as_slice(), [HowReached::Direct]));

        assert_eq!(reach.owns.len(), 1, "her own token goes with her");
        assert_eq!(reach.owns[0].kind, FiledKind::Secret);

        // Shelf is hers to administer and nobody else's — `admin` holds the
        // grant that created it, so she is not alone there.
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Person,
                ana.as_str(),
                Level::Admin,
                &admin,
            )
            .await
            .unwrap();
        let reach = access.reach(ana.as_str()).await.unwrap();
        let shelf_admin = reach
            .administers
            .iter()
            .find(|a| a.slug == shelf.slug)
            .expect("she administers Shelf");
        assert!(
            !shelf_admin.alone,
            "whoever made it administers it too, so she is not the only one"
        );

        // A machine she added and then filed into a directory. It belongs to
        // the directory now, so it is not hers and does not go with her.
        let host = db
            .ensure_host("fire-02", ft_core::Compute::Local, ana.as_str())
            .await
            .unwrap();
        let there = ft_core::path::ResourcePath::from_stored(format!("d.{}.fire_02", shelf.slug));
        access
            .transfer(&vault, FiledKind::Machine, host.id.as_str(), &there, "ana")
            .await
            .unwrap();

        let reach = access.reach(ana.as_str()).await.unwrap();
        assert!(
            reach.owns.iter().all(|o| o.kind != FiledKind::Machine),
            "filed away, so not hers to decide about"
        );
        assert_eq!(reach.created.len(), 1, "but still shown: she made it");
        assert_eq!(reach.created[0].kind, FiledKind::Machine);
    }

    /// `admin` is not spellable as an exception: administration belongs to the
    /// path, so one place answers "who may change permissions".
    #[tokio::test]
    async fn an_exception_cannot_make_somebody_an_administrator() {
        let (db, access, accounts, org, _admin) = set_up().await;
        let bob = person(&accounts, &org, "bob").await;
        let lisa = person(&accounts, &org, "lisa").await;
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, bob.as_str())
            .await
            .unwrap();

        let refused = access
            .set_exception(
                FiledKind::Machine,
                host.id.as_str(),
                lisa.as_str(),
                Level::Admin,
            )
            .await
            .expect_err("capped at writer");
        assert!(refused.to_string().contains("administer"), "{refused}");
    }

    /// The most generous route wins, and an exception is just a fourth route —
    /// so it can raise what a directory gave, and never lower it.
    #[tokio::test]
    async fn an_exception_adds_to_what_a_directory_already_gave() {
        let (db, access, accounts, org, admin) = set_up().await;
        let lisa = person(&accounts, &org, "lisa").await;
        let vault = vault(&db);

        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Person,
                lisa.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .unwrap();

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();
        access
            .transfer(
                &vault,
                FiledKind::Machine,
                host.id.as_str(),
                &host.path.moved_to(ft_core::path::DIRECTORY, &shelf.slug),
                "admin",
            )
            .await
            .unwrap();

        assert!(
            db.hosts_for(lisa.as_str(), Level::Writer)
                .await
                .unwrap()
                .is_empty(),
            "the directory gave her a look, no more"
        );

        access
            .set_exception(
                FiledKind::Machine,
                host.id.as_str(),
                lisa.as_str(),
                Level::Writer,
            )
            .await
            .unwrap();
        assert_eq!(
            db.hosts_for(lisa.as_str(), Level::Writer)
                .await
                .unwrap()
                .len(),
            1,
            "and the exception raises it, without touching the directory"
        );
    }

    #[tokio::test]
    async fn a_team_carries_a_grant_to_everybody_in_it() {
        let (_db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let bob = person(&accounts, &org, "bob").await;

        let backend = access.create_team(&org, "Backend").await.unwrap();
        access
            .add_member(backend.id.as_str(), ana.as_str())
            .await
            .unwrap();

        let shelf = access
            .create_directory(&org, "Ledger work", &admin, &[])
            .await
            .unwrap();
        assert_eq!(
            shelf.slug, "ledger_work",
            "a name with a space in it is not a label, so a slug is derived once"
        );
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Team,
                backend.id.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .unwrap();

        assert_eq!(
            access
                .level_on(ana.as_str(), shelf.id.as_str())
                .await
                .unwrap(),
            Some(Level::Viewer)
        );
        assert_eq!(
            access
                .level_on(bob.as_str(), shelf.id.as_str())
                .await
                .unwrap(),
            None,
            "bob is not in the team"
        );

        // And taking the team away takes the access with it, which is the
        // whole reason a team is worth having.
        access.delete_team(backend.id.as_str()).await.unwrap();
        assert_eq!(
            access
                .level_on(ana.as_str(), shelf.id.as_str())
                .await
                .unwrap(),
            None
        );
    }

    /// Somebody can arrive by several routes at once. The most they were
    /// deliberately given is what they have — which is why two grants never
    /// need a tie-break rule.
    #[tokio::test]
    async fn the_most_generous_route_in_is_the_one_that_counts() {
        let (_db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;

        let readers = access.create_team(&org, "Readers").await.unwrap();
        access
            .add_member(readers.id.as_str(), ana.as_str())
            .await
            .unwrap();

        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Team,
                readers.id.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .unwrap();
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Person,
                ana.as_str(),
                Level::Writer,
                &admin,
            )
            .await
            .unwrap();

        assert_eq!(
            access
                .level_on(ana.as_str(), shelf.id.as_str())
                .await
                .unwrap(),
            Some(Level::Writer),
            "named directly, she gets more than her team does"
        );
    }

    /// The same rule as the last administrator of the organisation, and for the
    /// same reason: a directory nobody can change the grants on is a locked
    /// room with things inside it.
    #[tokio::test]
    async fn a_directory_cannot_be_left_with_nobody_to_administer_it() {
        let (_db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();

        assert!(
            access
                .revoke(shelf.id.as_str(), SubjectKind::Person, admin.as_str())
                .await
                .is_err(),
            "the only administrator cannot revoke themselves"
        );
        assert!(
            access
                .set_grant(
                    shelf.id.as_str(),
                    SubjectKind::Person,
                    admin.as_str(),
                    Level::Viewer,
                    &admin
                )
                .await
                .is_err(),
            "nor demote themselves"
        );

        // With a second administrator, both are fine — and the first can now
        // step out.
        access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Person,
                ana.as_str(),
                Level::Admin,
                &admin,
            )
            .await
            .unwrap();
        access
            .revoke(shelf.id.as_str(), SubjectKind::Person, admin.as_str())
            .await
            .unwrap();
        assert_eq!(
            access
                .level_on(admin.as_str(), shelf.id.as_str())
                .await
                .unwrap(),
            None
        );
    }

    /// The shared directory a first boot makes has no administrator — one
    /// `writer` grant to the team that is everybody — and every grant on it used
    /// to be refused for that reason. That is the locked room, not the defence
    /// against it.
    #[tokio::test]
    async fn a_directory_with_no_administrator_can_still_be_given_one() {
        let (_db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let shared = access.shared(org.as_str()).await.unwrap();

        access
            .set_grant(
                shared.as_str(),
                SubjectKind::Person,
                ana.as_str(),
                Level::Viewer,
                &admin,
            )
            .await
            .expect("nothing is being taken away here");

        // `max` still wins: she is in the team that is everybody, which has
        // writer, so a personal viewer grant does not demote her.
        assert_eq!(
            access
                .level_on(ana.as_str(), shared.as_str())
                .await
                .unwrap(),
            Some(Level::Writer),
            "the most generous route in is the one that counts"
        );

        // And once somebody does administer it, the rule bites again.
        access
            .set_grant(
                shared.as_str(),
                SubjectKind::Person,
                admin.as_str(),
                Level::Admin,
                &admin,
            )
            .await
            .unwrap();
        assert!(
            access
                .revoke(shared.as_str(), SubjectKind::Person, admin.as_str())
                .await
                .is_err(),
            "the only administrator cannot step out"
        );
    }

    /// `grants.subject_id` carries no foreign key, so this is the check that
    /// would otherwise be the database's.
    #[tokio::test]
    async fn a_grant_to_nobody_is_refused_rather_than_stored() {
        let (_db, access, _accounts, org, admin) = set_up().await;
        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();

        assert!(access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Person,
                "u_nobody",
                Level::Writer,
                &admin
            )
            .await
            .is_err());
        assert!(access
            .set_grant(
                shelf.id.as_str(),
                SubjectKind::Team,
                "t_nobody",
                Level::Writer,
                &admin
            )
            .await
            .is_err());
    }

    /// Removing a directory with things in it would leave them filed at a root
    /// that no longer exists, reachable by nobody and listed nowhere.
    #[tokio::test]
    async fn a_directory_holding_something_is_not_removable() {
        let (db, access, _accounts, org, admin) = set_up().await;
        let vault = vault(&db);
        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();

        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();
        let to = host.path.moved_to(ft_core::path::DIRECTORY, &shelf.slug);
        access
            .transfer(&vault, FiledKind::Machine, host.id.as_str(), &to, "admin")
            .await
            .unwrap();

        let refused = access
            .delete_directory(shelf.id.as_str())
            .await
            .expect_err("a directory holding a machine cannot be removed");
        assert!(
            refused.to_string().contains("1 machine"),
            "the refusal has to say what is in the way, got: {refused}"
        );

        // Taken back into his own space, and now it goes.
        access
            .transfer(
                &vault,
                FiledKind::Machine,
                host.id.as_str(),
                &to.moved_to(ft_core::path::PERSONAL, "admin"),
                "admin",
            )
            .await
            .unwrap();
        access.delete_directory(shelf.id.as_str()).await.unwrap();
    }

    /// Two teams called `Backend` and `backend` are a mistake being made, not a
    /// distinction being drawn.
    #[tokio::test]
    async fn names_collide_without_regard_to_case() {
        let (_db, access, _accounts, org, admin) = set_up().await;
        access.create_team(&org, "Backend").await.unwrap();
        assert!(access.create_team(&org, "backend").await.is_err());

        access
            .create_directory(&org, "Ledger", &admin, &[])
            .await
            .unwrap();
        assert!(access
            .create_directory(&org, "LEDGER", &admin, &[])
            .await
            .is_err());
    }

    /// Making a directory with people already in it — what the desktop does when
    /// somebody picks "A new directory" while sharing.
    #[tokio::test]
    async fn a_directory_can_be_made_with_its_people_at_once() {
        let (_db, access, accounts, org, bob) = set_up().await;
        let lisa = person(&accounts, &org, "lisa").await;
        let delivery = access.create_team(&org, "Delivery").await.unwrap();

        let made = access
            .create_directory(
                &org,
                "Ledger rounding",
                &bob,
                &[
                    NewGrant {
                        subject_kind: SubjectKind::Person,
                        subject_id: lisa.as_str().to_string(),
                        level: Level::Writer,
                    },
                    NewGrant {
                        subject_kind: SubjectKind::Team,
                        subject_id: delivery.id.as_str().to_string(),
                        level: Level::Viewer,
                    },
                ],
            )
            .await
            .unwrap();

        assert_eq!(made.slug, "ledger_rounding");
        assert_eq!(
            access
                .level_on(bob.as_str(), made.id.as_str())
                .await
                .unwrap(),
            Some(Level::Admin),
            "whoever made it administers it, so they keep what they put in it"
        );
        assert_eq!(
            access
                .level_on(lisa.as_str(), made.id.as_str())
                .await
                .unwrap(),
            Some(Level::Writer)
        );

        let on_it = access.grants_on(made.id.as_str()).await.unwrap();
        assert_eq!(on_it.len(), 3, "bob, lisa, and the team");
    }

    /// Nothing is written when one of the people named is not real — the whole
    /// call is one transaction, so a half-made directory cannot survive it.
    #[tokio::test]
    async fn a_directory_is_not_made_at_all_if_somebody_in_it_is_not() {
        let (_db, access, _accounts, org, bob) = set_up().await;

        let refused = access
            .create_directory(
                &org,
                "Ledger rounding",
                &bob,
                &[NewGrant {
                    subject_kind: SubjectKind::Person,
                    subject_id: "u_nobody".into(),
                    level: Level::Writer,
                }],
            )
            .await
            .expect_err("there is no such person");
        assert!(refused.to_string().contains("no person"), "{refused}");

        assert!(
            access
                .directory_by_slug(org.as_str(), "ledger_rounding")
                .await
                .unwrap()
                .is_none(),
            "and the directory was rolled back with it"
        );
    }

    /// Two names, one slug — and the refusal has to name the directory that
    /// actually holds it, not the name that was just typed.
    #[tokio::test]
    async fn a_slug_collision_names_the_directory_in_the_way() {
        let (_db, access, _accounts, org, bob) = set_up().await;
        access
            .create_directory(&org, "Ledger work", &bob, &[])
            .await
            .unwrap();

        let refused = access
            .create_directory(&org, "Ledger  Work!", &bob, &[])
            .await
            .expect_err("both are d/ledger_work");
        let said = refused.to_string();
        assert!(
            said.contains("Ledger work"),
            "names the one in the way: {said}"
        );
        assert!(said.contains("d/ledger_work"), "and says why: {said}");
    }

    /// Two names that slug the same would be two roots spelled one way, and
    /// every path under them would be ambiguous.
    #[tokio::test]
    async fn two_directories_cannot_share_a_slug() {
        let (_db, access, _accounts, org, admin) = set_up().await;
        access
            .create_directory(&org, "Ledger work", &admin, &[])
            .await
            .unwrap();
        let refused = access
            .create_directory(&org, "Ledger  Work!", &admin, &[])
            .await
            .expect_err("both slug to `ledger_work`");
        assert!(refused.to_string().contains("already"), "{refused}");
    }

    /// Two people whose usernames slug the same still get roots of their own.
    #[tokio::test]
    async fn two_people_never_share_a_root() {
        let (_db, access, accounts, org, _admin) = set_up().await;
        let first = person(&accounts, &org, "ana.lopez").await;
        let second = person(&accounts, &org, "ana-lopez").await;

        let a = access.personal_root(first.as_str()).await.unwrap();
        let b = access.personal_root(second.as_str()).await.unwrap();
        assert_eq!(a, "ana_lopez");
        assert_eq!(b, "ana_lopez_2", "the second is numbered, not overwritten");
    }

    /// The team that is everybody has no membership rows, and adding one would
    /// be a second, disagreeing account of who is in it.
    #[tokio::test]
    async fn nobody_is_added_to_the_team_that_is_everybody() {
        let (_db, access, accounts, org, _admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let everyone = access.everyone_team(org.as_str()).await.unwrap();

        assert!(access
            .add_member(everyone.as_str(), ana.as_str())
            .await
            .is_err());
        assert!(
            access
                .rename_team(everyone.as_str(), "Nobody")
                .await
                .is_err(),
            "nor renamed"
        );
        assert!(
            access.delete_team(everyone.as_str()).await.is_err(),
            "nor removed"
        );

        // It still counts everybody, without a row each.
        let teams = access.teams(org.as_str()).await.unwrap();
        let everybody = teams.iter().find(|t| t.everyone).unwrap();
        assert_eq!(everybody.members, 2, "the administrator and ana");
    }

    /// Renaming a directory changes what people read, never where things are.
    ///
    /// The slug is in every path underneath it. Rewriting those on a rename
    /// would move everything filed there, which is the one thing a rename must
    /// not do.
    #[tokio::test]
    async fn renaming_a_directory_leaves_every_path_alone() {
        let (db, access, _accounts, org, admin) = set_up().await;
        let vault = vault(&db);
        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();
        access
            .transfer(
                &vault,
                FiledKind::Machine,
                host.id.as_str(),
                &host.path.moved_to(ft_core::path::DIRECTORY, &shelf.slug),
                "admin",
            )
            .await
            .unwrap();

        access
            .rename_directory(shelf.id.as_str(), "Long-term storage")
            .await
            .unwrap();

        let after = access.directory(shelf.id.as_str()).await.unwrap().unwrap();
        assert_eq!(after.name, "Long-term storage");
        assert_eq!(after.slug, "shelf", "the label in the path does not move");
        assert_eq!(after.hosts, 1, "and what was filed here is still here");
    }

    /// An administrator's list has to show a directory they have no grant in,
    /// or one whose last administrator has left is invisible to the only person
    /// who could fix it.
    #[tokio::test]
    async fn an_administrator_can_see_a_directory_they_cannot_open() {
        let (_db, access, accounts, org, admin) = set_up().await;
        let ana = person(&accounts, &org, "ana").await;
        let hers = access
            .create_directory(&org, "Hers", &ana, &[])
            .await
            .unwrap();

        let mine = access.directories_for(admin.as_str()).await.unwrap();
        assert!(
            !mine.iter().any(|d| d.id.as_str() == hers.id.as_str()),
            "her directory is not in what is granted to me"
        );

        let all = access
            .directories_in(org.as_str(), admin.as_str())
            .await
            .unwrap();
        let hers_seen = all
            .iter()
            .find(|d| d.id.as_str() == hers.id.as_str())
            .expect("an administrator's list is every directory");
        assert_eq!(
            hers_seen.level, None,
            "listed, and still not something they may open"
        );
    }

    /// Nothing may be filed at a root that grants nobody anything.
    #[tokio::test]
    async fn a_path_with_no_root_behind_it_is_refused() {
        let (db, access, _accounts, _org, admin) = set_up().await;
        let vault = vault(&db);
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, admin.as_str())
            .await
            .unwrap();

        for nowhere in ["d.nosuch.fire_01", "u.nobody.fire_01", "x.y.fire_01"] {
            let refused = access
                .transfer(
                    &vault,
                    FiledKind::Machine,
                    host.id.as_str(),
                    &ResourcePath::from_stored(nowhere),
                    "admin",
                )
                .await
                .expect_err("there is nothing at {nowhere}");
            assert!(
                refused.to_string().contains("no ") || refused.to_string().contains("starts with"),
                "{nowhere}: {refused}"
            );
        }
    }
}
