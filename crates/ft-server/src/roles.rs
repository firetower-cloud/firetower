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

pub mod import;
pub mod profile_md;

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

/// Where a role's child runs. A profile commits to one of the two — `here`,
/// the lead's own workspace, or `new`, one of its own — or leaves the question
/// open with `lead`, and whichever lead delegates to it decides.
///
/// `lead` is the column's own default
/// (`migrations/server/20261029120000_roles.sql:42`) and has always been
/// readable; this is what makes it writable too. It is a **profile-only**
/// value: a lead passes `here` or `new` to `spawn`, never `lead`.
pub const PLACEMENT: [&str; 3] = ["lead", "here", "new"];

/// What a lead may do about a child of this profile that has run out of
/// allowance, in order of how much latitude each grants.
///
/// **A ladder, not a two-state field.** None of the three means "not decided",
/// so none of them is *Let the lead choose* and none wears the open mark: a
/// profile saying `wait` has decided, firmly, that nobody moves its children
/// without a person. The field two above it in the form already grades three
/// ways for the same reason — `Mode` is ask-before-writing, ask-before-running,
/// don't-ask.
pub const ON_USAGE_LIMIT: [&str; 3] = ["wait", "same", "engine"];

/// Whether a Manager spends that latitude itself, or stops and puts the choice
/// to the person. Meaningless on a profile that cannot delegate, and kept
/// anyway — a profile that stops being a Manager and becomes one again should
/// not have quietly lost the answer somebody gave.
pub const ON_CHILD_LIMIT: [&str; 2] = ["ask", "reroute"];

/// A role, as the interface and the spawn tool read it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub path: String,
    pub name: String,
    /// The key its author gave it: the name of the folder its `PROFILE.md` sits
    /// in. Absent on every profile made in the interface, which is all of them
    /// until an import adopts one — see
    /// `migrations/server/20261117120000_profile_key.sql` for why `slug` cannot
    /// serve.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
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
    /// What a lead may do about a child of this profile that has run out of
    /// allowance: `wait` (nobody moves it without a person), `same` (the lead
    /// may move it to another subscription for the same engine) or `engine`
    /// (and to another engine).
    pub on_usage_limit: String,
    /// Whether this Manager re-routes a spent child itself (`reroute`) or
    /// stops and asks the person which subscription to spend (`ask`). Only
    /// read when `can_delegate`.
    pub on_child_limit: String,
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
    /// Where a delegated child runs: "here" (the lead's workspace), "new" (its
    /// own), or "lead" to let the lead choose. Empty when omitted, so `check`
    /// says so.
    #[serde(default)]
    pub placement: String,
    /// The engine it runs on. Null lets the lead choose, and a child then runs
    /// whatever its lead names, or the lead's own engine.
    #[serde(default)]
    pub agent: Option<String>,
    /// The machine its own workspace runs on, by host id. Null lets the lead
    /// choose: it may name one, and otherwise Firetower picks a machine that
    /// can run the engine.
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
    /// What a lead may do about a child of this profile that has run out:
    /// `wait`, `same` or `engine`.
    ///
    /// **Absent means leave it as it is** — on an update, whatever is stored;
    /// on a create, `wait`. `Option` for the same reason `include_always_on`
    /// is: this is a whole-object write, and a client that has never heard of
    /// the field must not be able to revoke a grant somebody made by omitting
    /// it.
    #[serde(default)]
    pub on_usage_limit: Option<String>,
    /// Whether this Manager re-routes a spent child itself (`reroute`) or
    /// asks the person first (`ask`).
    ///
    /// **Absent means leave it as it is**, for the reason `on_usage_limit`
    /// gives.
    #[serde(default)]
    pub on_child_limit: Option<String>,
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

/// What a *new* profile is when it says nothing about either limit field:
/// exactly what every profile does today, which is what makes the
/// `profile_usage_limit` migration a pair of defaults and nothing else. Named
/// here, like `INHERITS`, because these have to agree with the column
/// defaults and this is the one place the server repeats them.
const WAITS_FOR_A_PERSON: &str = "wait";
const ASKS_THE_PERSON: &str = "ask";

/// Why a role was refused, in a sentence somebody can act on.
#[derive(Debug)]
pub struct Refused(pub String);

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refused {}

/// A write the database refused, said as a sentence rather than dumped.
///
/// `roles.host_id` references `hosts(id)`, so a machine id no row answers to
/// came back as a 500 with the constraint's name in it. The editor only ever
/// offers real ids, but `create_profile` and `update_profile` take one from a
/// Manager by hand — and a machine this server cannot honour being *named* is
/// the same promise the spawn path already makes (`delegate.rs`).
///
/// **Read off the violation rather than checked before the write.** A `SELECT`
/// first would race: `host_id` is `on delete set null`, so a machine removed
/// between the look and the insert puts the raw error back — more rarely, and
/// so more confusingly. This is the repository's own idiom for the shape
/// (`api/accounts.rs`, on a unique violation), and it costs no round trip.
///
/// Only the one constraint. `roles` has four foreign keys and the other three
/// are the server's own doing, not something a caller named, so they stay
/// whatever they were.
fn refused_by_constraint(e: &sqlx::Error, new: &NewRole) -> Option<Refused> {
    let db = e.as_database_error()?;
    if !db.is_foreign_key_violation() || db.constraint() != Some("roles_host_id_fkey") {
        return None;
    }
    Some(Refused(format!(
        "there is no machine \"{}\" — name one of yours, or leave it out and the machine is \
         the lead's to choose",
        new.machine.as_deref().unwrap_or_default()
    )))
}

/// Either the refusal above, or the error as it was, with its context.
fn written(e: sqlx::Error, new: &NewRole, doing: &'static str) -> anyhow::Error {
    match refused_by_constraint(&e, new) {
        Some(refused) => anyhow::Error::new(refused),
        None => anyhow::Error::new(e).context(doing),
    }
}

/// What can be said about one settings value, for one profile's engine.
///
/// Four cases, read off `controls::has_control` and `controls::choices_for`
/// rather than restating either. The pair already carries the distinction this
/// depends on — "empty means the server cannot enumerate it, which is a third
/// answer and not the same as the control being absent" — and the import used
/// to keep a private copy that re-derived both from `controls::for_agent`. A
/// second spelling of one question is how two readers come to disagree.
///
/// **[`Offer::Values`] is the picker's list, not the accepted set.** Which of
/// the four a setting is in says what is *knowable* here, and nothing on its
/// own about whether a value outside the list is a mistake — see
/// [`ft_core::controls::can_widen`], which is the question that decides that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Offer {
    /// The values this engine's picker offers.
    Values(Vec<String>),
    /// The engine lists them itself once running, so nothing here can judge
    /// the value. Codex's models and efforts, and only those.
    WhenItStarts,
    /// No engine is pinned, so which set applies is the lead's to decide.
    WhenALeadPicks,
    /// This engine has no such control, so the line would do nothing.
    NotThisEngine,
}

/// Which of the four a setting is in, for this profile's engine.
pub fn offered(engine: Option<ft_core::Agent>, kind: ft_core::controls::ControlKind) -> Offer {
    let Some(engine) = engine else {
        return Offer::WhenALeadPicks;
    };
    if !ft_core::controls::has_control(engine, kind) {
        return Offer::NotThisEngine;
    }
    match ft_core::controls::choices_for(engine, kind) {
        values if values.is_empty() => Offer::WhenItStarts,
        values => Offer::Values(values),
    }
}

/// What a control is called in a refusal, with its article, so the sentence
/// reads as one.
pub fn named(kind: ft_core::controls::ControlKind) -> &'static str {
    use ft_core::controls::ControlKind;
    match kind {
        ControlKind::Model => "a model",
        ControlKind::Effort => "an effort",
        ControlKind::Mode => "a permission mode",
        ControlKind::Sandbox => "a sandbox",
    }
}

/// Everything a well-formed role must be.
///
/// Shape only — everything answerable without the database. Two fields need it
/// and neither is here: `skill_scope`, whose ids have to be skills the person
/// saving can actually see, is `api::roles::check_skills`, called beside this
/// on both write paths; and `machine`, which has to be a machine, is the
/// foreign key itself, read back by `refused_by_constraint` at the write.
/// Said here because this is where somebody looks to find out what is
/// validated, and the answer "not here" is only useful with the "over there".
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
    // Each of the three may be a commitment or left open, and open is a real
    // answer rather than a field nobody filled in: a profile that says nothing
    // about the placement, the machine or the engine hands that choice to
    // whichever lead delegates to it.
    if !PLACEMENT.contains(&new.placement.as_str()) {
        return Err(Refused(format!(
            "\"{}\" is not a placement. It is \"here\" (the lead's workspace), \"new\" (its \
             own), or \"lead\" (let the lead choose).",
            new.placement
        )));
    }
    // Open is not unvalidated. Absent lets the lead choose; a name this build
    // does not know is a pin that could never be honoured, and saying so here
    // is the only place anybody finds out.
    match &new.agent {
        None => {}
        Some(agent) if ft_core::Agent::from_name(agent).is_some() => {}
        Some(agent) => return Err(Refused(format!("{agent} is not an agent Firetower runs"))),
    }
    // Absent is "leave it as it is" on both of these, so only a value that was
    // actually sent is judged. Neither has an open state to allow for: every
    // rung is a commitment, which is why neither takes `PLACEMENT`'s shape.
    // Named, not merely listed. A refusal that gives only the legal values
    // leaves the caller to diff two lists and guess which of its arguments
    // was at fault — the engine refusal above has always named the value, and
    // these are read by the same agents.
    if let Some(on) = &new.on_usage_limit {
        if !ON_USAGE_LIMIT.contains(&on.as_str()) {
            return Err(Refused(format!(
                "\"{on}\" is not something that can happen at a usage limit. It is \"wait\" \
                 (for a person), \"same\" (the lead may move it to another subscription for \
                 the same engine) or \"engine\" (and to another engine)."
            )));
        }
    }
    if let Some(on) = &new.on_child_limit {
        if !ON_CHILD_LIMIT.contains(&on.as_str()) {
            return Err(Refused(format!(
                "\"{on}\" is not something a Manager does when a child runs out. It is \
                 \"ask\" (put the choice to the person) or \"reroute\" (pick a subscription \
                 and carry on)."
            )));
        }
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
    // **A profile is a closed set.** Its own list, and nothing else.
    //
    // It used to be the union of three sources governed by two switches, and
    // the arithmetic was hard enough to predict that the editor spent 925
    // lines explaining it before anybody could act. Worse, it was not
    // reproducible: the other two lists are the *starter's*, so two people
    // beginning the same profile got two different agents — and "why does
    // Rowan's QA agent behave differently from mine" is the support question
    // that never ends.
    //
    // What a person's own defaults are for is the session they start without
    // a profile. Both are **defaults** rather than layers: the set is
    // prefilled when work starts and anybody may untick a row before they
    // send, so there is nothing here to resolve.
    //
    // `always_on` and `repo_defaults` are still taken, and still ignored: the
    // callers read them for the ad-hoc path, and a signature that kept only
    // what this function uses would move the decision back out to them.
    let _ = (always_on, repo_defaults);
    role.skill_scope
        .iter()
        .filter(|id| reachable.contains(*id))
        .cloned()
        .collect()
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

/// What a position adds to what its profile already carries.
///
/// **The third of the three levels.** An ad-hoc session opens with everything
/// its owner has; a profile *replaces* that with a closed set; a position
/// *adds* to whatever its profile carries, for one team only — so a Sheets
/// expert stays the Sheets expert everywhere, and the position that also wants
/// Figma says so without forking the profile.
///
/// **Bounded by `reachable`.** A team must not hand a running agent something
/// the person starting it could not have chosen themselves, so an id outside
/// that set is dropped rather than granted. Order is the profile's first, then
/// the extras as the position lists them, and nothing is added twice.
pub fn with_position_extras(
    mut set: Vec<String>,
    extra: &[String],
    reachable: &std::collections::HashSet<String>,
) -> Vec<String> {
    for id in extra {
        if reachable.contains(id) && !set.iter().any(|s| s == id) {
            set.push(id.clone());
        }
    }
    set
}

/// The skills one person can reach, by id.
///
/// Split out because a position's extras are bounded by the same set a
/// profile's own list is — a team may add to what an agent carries, and never
/// beyond what the person starting it could have chosen themselves.
pub async fn reachable_ids(
    skills: &crate::skills::Skills,
    person: &str,
) -> Result<std::collections::HashSet<String>> {
    Ok(skills
        .visible(person, Level::Viewer)
        .await
        .context("reading the skills somebody can reach for a position")?
        .into_iter()
        .map(|s| s.id.as_str().to_string())
        .collect())
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

const FIELDS: &str = "r.id, r.path::text AS path, r.name, r.author_key, r.does, \
                      r.placement, r.agent, r.host_id, r.agent_account_id, \
                      r.pref_model, r.pref_effort, r.pref_mode, r.pref_sandbox, r.instructions, \
                      r.can_delegate, r.delegate_scope, r.skill_scope, \
                      r.include_always_on, r.include_repo_defaults, \
                      r.on_usage_limit, r.on_child_limit, \
                      r.created_at, r.updated_at";

fn read(row: sqlx::postgres::PgRow) -> Result<Role> {
    Ok(Role {
        id: row.get("id"),
        // Slashes on the wire, dots in the database — the same conversion every
        // other Placed kind makes, so the sharing sheet reads a role's path the
        // way it reads a skill's rather than seeing `d.backend.x` and giving up.
        path: ft_core::ResourcePath::from_stored(row.get::<String, _>("path")).to_string(),
        name: row.get("name"),
        key: row.get("author_key"),
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
        on_usage_limit: row.get("on_usage_limit"),
        on_child_limit: row.get("on_child_limit"),
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

    /// One role, whoever may see it.
    ///
    /// **For the run-time path only**, which has no person to ask about. What
    /// a running agent may hand work to was decided when somebody who could
    /// see both the team and the profiles put them in it; asking again as the
    /// session's owner would mean a team shared with a colleague stopped
    /// working the moment that colleague started it. `agent_teams::at_position`
    /// is the only caller, and its doc comment carries the same argument.
    pub async fn unscoped(&self, id: &str) -> Result<Option<Role>> {
        let sql = format!(
            "SELECT {FIELDS}, FALSE AS may_write, FALSE AS may_share, FALSE AS is_default \
               FROM roles r WHERE r.id = $1"
        );
        let row = sqlx::query(&sql)
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a role for a running session")?;
        row.map(read).transpose()
    }

    /// One role, if this person may see it.
    /// Which of these ids are profiles at all, whoever may see them.
    ///
    /// `delegate_scope` holds ids with no foreign key behind them, so an entry whose
    /// profile was deleted stays on the row — and the `profile_scope` migration
    /// says what that costs: "a stale id simply drops out", because every read
    /// intersects the list with what is actually visible.
    ///
    /// Export is the one caller that has to tell those two cases apart. An id
    /// it cannot resolve to a name is either something that is gone, which
    /// every reader already ignores and which the file should not mention, or
    /// something this person may not see, which is the disclosure question
    /// #354 settled by refusing. Unscoped deliberately, and it discloses
    /// nothing: whoever is asking is holding these ids already, off the
    /// profile's own response.
    pub async fn which_exist(&self, ids: &[String]) -> Result<std::collections::HashSet<String>> {
        if ids.is_empty() {
            return Ok(Default::default());
        }
        Ok(
            sqlx::query_scalar::<_, String>("SELECT id FROM roles WHERE id = ANY($1)")
                .bind(ids)
                .fetch_all(&self.pool)
                .await
                .context("reading which profiles still exist")?
                .into_iter()
                .collect(),
        )
    }

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
        create_in(&self.pool, org, person, person_slug, Filing::default(), new).await
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
        if !may_write_in(&self.pool, person, id).await? {
            return Ok(false);
        }
        replace_in(&self.pool, id, None, new).await?;
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

// ── the writes, against a pool or a transaction ─────────────────────────
//
// **Free-standing and executor-generic, which is what makes an import
// atomic.** `Roles` holds a pool, so every method on it takes a connection of
// its own per query: a `create` called between somebody else's `BEGIN` and
// `COMMIT` runs on a second connection, outside that transaction, and commits
// on its own. `profiles-as-code`'s threat model names that trap, and this is
// the answer it asked for — the helpers learn to take an executor rather than
// the import growing a second copy of the column list, which is the thing most
// likely to drift the day a field is added.
//
// The pair above (`Roles::create`, `Roles::update`) is now these three with
// the pool handed in, so there is exactly one spelling of what a profile's
// columns are.

/// What an import knows about a profile that neither write path does: where it
/// is filed at creation, and the key its author gave it.
///
/// `directory` is a **slug**, not an id, and a create files the row at its
/// destination in one insert. `api::roles::create_role` creates and then moves
/// because filing is a separate, later act there; inside an import the move
/// would be a second write to roll back, and `access::transfer` for a role is
/// an `UPDATE` of the path and nothing else.
#[derive(Debug, Clone, Copy, Default)]
pub struct Filing<'a> {
    /// The directory to file it in, by slug. `None` is the person's own space.
    pub directory: Option<&'a str>,
    /// The folder name its `PROFILE.md` sat in. `None` for a profile nobody
    /// imported, which is every one made in the interface.
    pub key: Option<&'a str>,
}

/// Insert one role.
pub async fn create_in<'e, E>(
    x: E,
    org: &str,
    person: &str,
    person_slug: &str,
    filing: Filing<'_>,
    new: &NewRole,
) -> Result<ft_core::RoleId>
where
    E: sqlx::PgExecutor<'e>,
{
    let id = ft_core::RoleId::new();
    let slug = slug_of(&new.name, id.as_str());
    let path = match filing.directory {
        Some(directory) => ft_core::ResourcePath::in_directory(directory, &slug),
        None => ft_core::ResourcePath::personal(person_slug, &slug),
    };
    sqlx::query(
        "INSERT INTO roles \
           (id, org_id, path, created_by, name, slug, does, \
            placement, agent, host_id, agent_account_id, instructions, can_delegate, \
            delegate_scope, skill_scope, include_always_on, include_repo_defaults, \
            on_usage_limit, on_child_limit, \
            pref_model, pref_effort, pref_mode, pref_sandbox, author_key) \
         VALUES ($1, $2, $3::ltree, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, \
                 $16, $17, $18, $19, $20, $21, $22, $23, $24)",
    )
    .bind(id.as_str())
    .bind(org)
    .bind(path.to_ltree())
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
    // Nothing to leave alone on a row that does not exist yet, so an absent
    // switch resolves to the column's default.
    .bind(new.include_always_on.unwrap_or(INHERITS))
    .bind(new.include_repo_defaults.unwrap_or(INHERITS))
    // Nothing to leave alone on a row that does not exist yet, so an absent
    // grant resolves to the column's default — which is the whole of the
    // migration and the whole of the compatibility story.
    .bind(new.on_usage_limit.as_deref().unwrap_or(WAITS_FOR_A_PERSON))
    .bind(new.on_child_limit.as_deref().unwrap_or(ASKS_THE_PERSON))
    .bind(nonblank(&new.settings.model))
    .bind(nonblank(&new.settings.effort))
    .bind(nonblank(&new.settings.mode))
    .bind(nonblank(&new.settings.sandbox))
    .bind(filing.key)
    .execute(x)
    .await
    .map_err(|e| written(e, new, "writing a role"))?;
    Ok(id)
}

/// Whether this person may change this role: Writer where it is filed, through
/// the one predicate the interface's `may_write` is drawn from.
pub async fn may_write_in<'e, E>(x: E, person: &str, id: &str) -> Result<bool>
where
    E: sqlx::PgExecutor<'e>,
{
    let sql = format!(
        "SELECT EXISTS (SELECT 1 FROM roles r WHERE r.id = $2 AND {visible})",
        visible = filed_where("r", 1, Level::Writer),
    );
    sqlx::query_scalar::<_, bool>(&sql)
        .bind(person)
        .bind(id)
        .fetch_one(x)
        .await
        .context("reading whether somebody may change a role")
}

/// Replace every column of a role with what was sent.
///
/// **No authorisation.** The two callers do it themselves, one line above:
/// `Roles::update` through `may_write_in`, and the import inside its own
/// transaction so the answer cannot change between the check and the write.
///
/// `key` is an author's key to adopt, and `None` leaves whatever the row
/// carries. A profile matched by its *name* gains its key the first time an
/// import recognises it, which happens once per profile per installation;
/// nothing else writes one, and nothing clears one.
pub async fn replace_in<'e, E>(x: E, id: &str, key: Option<&str>, new: &NewRole) -> Result<()>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query(
        "UPDATE roles SET name=$2, does=$3, \
           placement=$4, agent=$5, host_id=$6, agent_account_id=$7, instructions=$8, \
           can_delegate=$9, delegate_scope=$10, skill_scope=$11, \
           include_always_on=COALESCE($12, include_always_on), \
           include_repo_defaults=COALESCE($13, include_repo_defaults), \
           on_usage_limit=COALESCE($14, on_usage_limit), \
           on_child_limit=COALESCE($15, on_child_limit), \
           pref_model=$16, pref_effort=$17, pref_mode=$18, pref_sandbox=$19, \
           author_key=COALESCE($20, author_key), \
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
    // `COALESCE`d for the reason the two switches above are: this is a
    // whole-object write, and an absent grant has to mean "leave it" —
    // otherwise every save by a client that predates the field revokes it.
    .bind(&new.on_usage_limit)
    .bind(&new.on_child_limit)
    .bind(nonblank(&new.settings.model))
    .bind(nonblank(&new.settings.effort))
    .bind(nonblank(&new.settings.mode))
    .bind(nonblank(&new.settings.sandbox))
    .bind(key)
    .execute(x)
    .await
    .map_err(|e| written(e, new, "updating a role"))?;
    Ok(())
}

/// Write a Manager's team, once every profile it names exists.
///
/// The second pass of an import: a profile's team may name a profile from the
/// same drop, so the ids are only all known after every row is written. One
/// transaction, so the two passes are never observable apart.
pub async fn set_team_in<'e, E>(x: E, id: &str, team: &[String]) -> Result<()>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query("UPDATE roles SET delegate_scope = $2 WHERE id = $1")
        .bind(id)
        .bind(team)
        .execute(x)
        .await
        .context("wiring a profile's team")?;
    Ok(())
}

/// What a role is right now, held for the rest of the transaction.
///
/// `FOR UPDATE`: an import compares these against what it planned over and
/// then writes, and a concurrent edit between the two would be the overwrite
/// nobody reviewed. The three columns are the ones a timestamp cannot stand in
/// for — **filing moves `path` without touching `updated_at`**, and a key is
/// adopted once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub path: String,
    pub key: Option<String>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

pub async fn standing_in<'e, E>(x: E, id: &str) -> Result<Option<Standing>>
where
    E: sqlx::PgExecutor<'e>,
{
    let row = sqlx::query(
        "SELECT path::text AS path, author_key, updated_at FROM roles WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(x)
    .await
    .context("reading a profile before overwriting it")?;
    Ok(row.map(|r| Standing {
        // Slashes, the way a `Role` carries one, so the two can be compared
        // at all: the column is an `ltree` and reads back with dots.
        path: ft_core::ResourcePath::from_stored(r.get::<String, _>("path")).to_string(),
        key: r.get("author_key"),
        updated_at: r.get("updated_at"),
    }))
}

/// Whichever profile already carries this key where one is being filed.
///
/// **One spelling of the question, asked by both writers of keys**: the import
/// (`api::roles::apply_role_import`) and a move (`access::transfer_in`).
/// `roles_author_key` is unique within the parent path, and the index answers
/// a clash with a constraint name once the transaction is already aborted — so
/// nothing can be looked up to explain it. Asked first instead, while the
/// profile in the way can still be named.
///
/// `parent` is everything but the leaf, as an `ltree`: `u.kevin`, `d.fstack`.
/// [`filed_beside`] is that.
pub async fn keyed_already<'e, E>(
    x: E,
    parent: &str,
    key: &str,
    except: Option<&str>,
) -> Result<Option<String>>
where
    E: sqlx::PgExecutor<'e>,
{
    sqlx::query_scalar::<_, String>(
        "SELECT name FROM roles \
          WHERE subpath(path, 0, nlevel(path) - 1) = $1::ltree AND author_key = $2 \
            AND ($3::text IS NULL OR id <> $3) \
          LIMIT 1",
    )
    .bind(parent)
    .bind(key)
    .bind(except)
    .fetch_optional(x)
    .await
    .context("reading which profile already carries a key")
}

/// The key one profile carries, if it carries one.
pub async fn key_of_role<'e, E>(x: E, id: &str) -> Result<Option<String>>
where
    E: sqlx::PgExecutor<'e>,
{
    Ok(
        sqlx::query_scalar::<_, Option<String>>("SELECT author_key FROM roles WHERE id = $1")
            .bind(id)
            .fetch_optional(x)
            .await
            .context("reading a profile's key")?
            .flatten(),
    )
}

/// Everything but the leaf of a path, as an `ltree`: the scope a key is unique
/// in.
pub fn filed_beside(path: &ft_core::ResourcePath) -> String {
    let labels: Vec<&str> = path.as_str().split('/').collect();
    labels[..labels.len().saturating_sub(1)].join(".")
}

/// Whether a write was refused because that key is already filed there.
///
/// `roles_author_key` is unique within the parent path — see
/// `migrations/server/20261117120000_profile_key.sql`. Asked rather than
/// guessed, and the sentence is the caller's: this layer knows the constraint
/// and the caller knows which profile and which directory a person is looking
/// at.
pub fn key_already_filed_there(e: &anyhow::Error) -> bool {
    e.downcast_ref::<sqlx::Error>().is_some_and(|e| {
        e.as_database_error()
            .is_some_and(|db| db.is_unique_violation() && db.constraint() == Some(KEY_IS_UNIQUE))
    })
}

/// The index that makes a key one profile within one directory.
pub const KEY_IS_UNIQUE: &str = "roles_author_key";

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
            on_usage_limit: None,
            on_child_limit: None,
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
            key: None,
            does: "reviews a branch".into(),
            placement: "here".into(),
            agent: Some("ClaudeCode".into()),
            machine: None,
            account: None,
            settings: Default::default(),
            instructions: String::new(),
            on_usage_limit: "wait".into(),
            on_child_limit: "ask".into(),
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

    /// **A standing reads a path the way a profile carries one.**
    ///
    /// Dots in the database, slashes everywhere else. The import compares the
    /// two, so a standing in the column's own spelling makes every overwrite
    /// refuse as a profile that has moved — which is what it did, until this.
    #[tokio::test]
    async fn a_standing_reads_the_path_a_profile_carries() {
        let (db, admin) = Db::open_for_test_owned().await.unwrap();
        let roles = Roles::new(db.pool().clone());
        let org = db.org().await.unwrap();
        let id = roles
            .create(&org, &admin, "admin", &new("Designer"))
            .await
            .unwrap();

        let row = roles
            .one(&admin, id.as_str(), Level::Viewer)
            .await
            .unwrap()
            .unwrap();
        let standing = standing_in(db.pool(), id.as_str()).await.unwrap().unwrap();
        assert_eq!(standing.path, row.path);
        assert_eq!(standing.key, row.key);
        assert_eq!(standing.updated_at, row.updated_at);
        assert!(standing.path.contains('/'), "{}", standing.path);
    }

    /// **A profile is a closed set**, and these are what that means.
    ///
    /// They replace five tests that asserted the union of three sources
    /// governed by two switches. That model is gone, and the reason is worth
    /// keeping: the other two lists belong to whoever *starts* the profile,
    /// so two people beginning the same one got two different agents. A saved
    /// kind of agent that is not the same agent for everybody is not a saved
    /// kind of agent.
    /// A position adds to its profile, and cannot add past what the person
    /// starting it can reach.
    ///
    /// Asserted against `with_position_extras` itself — the function the
    /// spawn path calls — rather than a copy of its rule written here, which
    /// would pass for ever while the real one drifted.
    #[test]
    fn a_position_adds_to_its_profile_and_never_past_what_is_reachable() {
        let reachable: std::collections::HashSet<String> = ["sheets", "figma", "drive"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let profile = || vec!["sheets".to_string()];
        let want = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert_eq!(
            with_position_extras(profile(), &want(&["figma"]), &reachable),
            want(&["sheets", "figma"]),
            "the position adds to the profile, and the profile's own survives"
        );
        assert_eq!(
            with_position_extras(profile(), &want(&["secrets"]), &reachable),
            want(&["sheets"]),
            "a team cannot hand an agent what its owner could not choose"
        );
        assert_eq!(
            with_position_extras(profile(), &want(&["sheets"]), &reachable),
            want(&["sheets"]),
            "naming what the profile already has adds nothing twice"
        );
        assert_eq!(
            with_position_extras(profile(), &[], &reachable),
            profile(),
            "a position with nothing to add leaves the profile exactly as it was"
        );
    }

    #[test]
    fn a_profile_loads_its_own_list_and_nothing_else() {
        let mut role = profile();
        role.skill_scope = ids(&["make-ugc"]);
        let got = skills_for(
            &role,
            // Both still passed, and both ignored. The starter's own defaults
            // are what an *ad-hoc* session opens with; a profile decides for
            // itself or it is not a decision.
            &ids(&["dataviz", "treg"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "treg", "rust-review", "make-ugc"]),
        );
        assert_eq!(got, ids(&["make-ugc"]));
    }

    /// Two people, one profile, one answer. The property the union could not
    /// hold, written as a test rather than as a comment.
    #[test]
    fn two_people_starting_one_profile_get_the_same_agent() {
        let mut role = profile();
        role.skill_scope = ids(&["make-ugc", "dataviz"]);
        let seen = reachable(&["dataviz", "treg", "rust-review", "make-ugc"]);

        let kevin = skills_for(
            &role,
            &ids(&["dataviz", "treg"]),
            &ids(&["rust-review"]),
            &seen,
        );
        let rowan = skills_for(&role, &ids(&[]), &ids(&[]), &seen);
        assert_eq!(kevin, rowan);
        assert_eq!(kevin, ids(&["make-ugc", "dataviz"]));
    }

    /// An empty list means nothing, and has to come back as an empty set
    /// rather than as "no opinion" — `NewSession.skills` honours
    /// `Some(vec![])` as nothing, which is what carries the decision.
    #[test]
    fn a_profile_that_names_nothing_loads_nothing() {
        let got = skills_for(
            &profile(),
            &ids(&["dataviz"]),
            &ids(&["rust-review"]),
            &reachable(&["dataviz", "rust-review"]),
        );
        assert!(got.is_empty(), "{got:?}");
    }

    /// The order on the screen is the order it loads in.
    #[test]
    fn the_list_keeps_the_order_it_was_written_in() {
        let mut role = profile();
        role.skill_scope = ids(&["treg", "dataviz"]);
        let got = skills_for(
            &role,
            &ids(&[]),
            &ids(&[]),
            &reachable(&["dataviz", "treg"]),
        );
        assert_eq!(got, ids(&["treg", "dataviz"]));
    }

    /// One a person cannot reach is dropped however it got onto the profile.
    ///
    /// The case that makes this a security question rather than a tidiness
    /// one: a profile is shareable, so a Writer on one filed in a directory
    /// could otherwise tick something only they can see and have a colleague
    /// materialise and run it on their own worker, under their own
    /// credentials.
    #[test]
    fn a_bundle_the_starter_cannot_reach_is_never_in_the_set() {
        let mut role = profile();
        role.skill_scope = ids(&["treg", "theirs"]);
        let got = skills_for(&role, &ids(&[]), &ids(&[]), &reachable(&["treg"]));
        assert_eq!(got, ids(&["treg"]));
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

    /// The inverse of what this used to assert, kept in one piece because half
    /// of it is still true: **open is accepted, unknown is still refused.**
    ///
    /// A profile may leave the engine, the machine and the placement open —
    /// each is a question handed to whichever lead delegates to it — and the
    /// only thing left to refuse is a value nothing could honour.
    #[test]
    fn a_profile_may_leave_a_field_open_but_not_an_unknown_one() {
        // No engine: the lead's own runs it.
        let mut r = new("reviewer");
        r.agent = None;
        assert!(check(&r).is_ok());

        // An engine by a name this build does not run is still refused, and
        // the refusal says which name. Open must not mean unvalidated.
        let mut r = new("reviewer");
        r.agent = Some("Claude".into());
        let refused = check(&r).unwrap_err().0;
        assert!(
            refused.contains("Claude is not an agent Firetower runs"),
            "{refused}"
        );

        // "lead" is a placement a profile may hold: the lead decides.
        let mut r = new("reviewer");
        r.placement = "lead".into();
        assert!(check(&r).is_ok());

        // Anything else is not, and the refusal names all three.
        let mut r = new("reviewer");
        r.placement = "own".into();
        let refused = check(&r).unwrap_err().0;
        assert!(refused.contains("placement"), "{refused}");
        assert!(refused.contains("lead"), "{refused}");

        // Its own workspace, no machine: Firetower picks one that can run it.
        let mut r = new("reviewer");
        r.placement = "new".into();
        r.machine = None;
        assert!(check(&r).is_ok());

        // And every field committed is still accepted, which is the half of
        // the old invariant that never changed.
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
            display_name: None,
            kind: None,
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
        // **Its own list, and nothing else.** `everywhere` is Ana's always-on
        // and `in_repo` is her default for this repository; neither is on the
        // profile, so neither loads. That is the closed set: a profile is the
        // same agent whoever starts it, which it cannot be while two of its
        // three sources belong to the starter.
        //
        // And the admin's skill is absent though it is named, because Ana
        // cannot reach it — a tick introduces a bundle and a bundle is
        // executable, so it is filtered against the starter either way.
        let resolved = skills_at_spawn(&skills, &profile, &ana, std::slice::from_ref(&repo_id))
            .await
            .unwrap();
        assert_eq!(resolved, vec![named.clone()]);
        assert!(
            !resolved.contains(&everywhere) && !resolved.contains(&in_repo),
            "the starter's own defaults are what an ad-hoc session opens with, not a profile"
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
