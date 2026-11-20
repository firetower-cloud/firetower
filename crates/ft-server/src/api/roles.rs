//! Roles: the saved kinds of agent a lead can start.
//!
//! Every read pastes `filed_where` through `crate::roles`, so a role somebody
//! has no grant on is absent rather than refused — the same rule as every
//! other kind. Filing one into a directory is not here: a role is
//! `FiledKind::Role`, so the sharing endpoints that already exist do it.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Level;
use crate::auth::Principal;
use crate::roles::{import, NewRole, Role};
use crate::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};

/// A refusal somebody can act on, rather than a 500 with a backtrace in it.
fn refused(e: crate::roles::Refused) -> ApiError {
    ApiError::new(ErrorCode::InvalidRequest, e.to_string())
}

/// The same, for a refusal the write itself raised.
///
/// `crate::roles` reads a foreign key violation on `host_id` back as a
/// [`crate::roles::Refused`] naming the machine — see `refused_by_constraint`
/// for why that is read off the violation rather than checked beforehand. It
/// arrives here as an `anyhow::Error` like any other, so it is asked for by
/// name; anything else is still the 500 it was.
fn wrote(e: anyhow::Error) -> ApiError {
    match e.downcast::<crate::roles::Refused>() {
        Ok(no) => refused(no),
        Err(e) => e.into(),
    }
}

/// A pinned subscription has to be one this person may use and has to be for
/// the profile's engine. Absent is fine — it means the owner's default at
/// launch, which is what an agent-authored profile gets.
async fn check_account(
    state: &AppState,
    owner: &str,
    new: &crate::roles::NewRole,
) -> ApiResult<()> {
    let Some(account) = new.account.as_deref().filter(|a| !a.is_empty()) else {
        return Ok(());
    };
    let agent = new
        .agent
        .as_deref()
        .and_then(ft_core::Agent::from_name)
        .ok_or_else(|| ApiError::new(ErrorCode::InvalidRequest, "pick an agent first"))?;
    super::accounts::validate(state, owner, account, agent).await?;
    Ok(())
}

/// Every skill a profile names has to be one this person can actually see.
///
/// **A tick grants now, so it needs authorising.** Under the intersection this
/// replaces, `skill_scope` needed no check at all: a spawn took the owner's own
/// defaults and kept only the ids on the list, so an id they could not reach
/// dropped out on its own and the list could only ever subtract. A tick now
/// *introduces* a skill, profiles are shareable (`roles.rs` — a role is Placed),
/// and a skill is executable (`docs/skills.md` §8). Without this, somebody with
/// Writer on a shared profile could name a skill only they can see, and a
/// colleague who started that profile would materialise and run it on their own
/// worker under their own credentials.
///
/// Refused rather than quietly filtered, which is the opposite of what the
/// session's own skill selection does — and right for the opposite reason. That
/// one is a live choice about one conversation; this one is written down and
/// read by everybody who can reach the profile, so a save that silently kept
/// less than the screen showed would be a profile that does not do what the
/// person was told it does. `skills_for` and `set_for_session` filter at spawn
/// as well: this is the half that can explain itself to somebody.
async fn check_skills(state: &AppState, owner: &str, new: &NewRole) -> ApiResult<()> {
    if new.skill_scope.is_empty() {
        return Ok(());
    }
    let reachable: std::collections::HashMap<String, String> = state
        .skills
        .visible(owner, Level::Viewer)
        .await?
        .into_iter()
        .map(|s| (s.id.as_str().to_string(), s.name))
        .collect();
    let out: Vec<&str> = new
        .skill_scope
        .iter()
        .filter(|id| !reachable.contains_key(*id))
        .map(String::as_str)
        .collect();
    if !out.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} of the skills named aren't ones you can use, so this profile can't load \
                 them: {}",
                out.len(),
                out.join(", "),
            ),
        ));
    }

    // Two of one name is a profile that cannot do what it says: a skill's
    // folder on a worker is its name, so only one of them can be written and
    // `Skills::set_for_session` sends neither rather than picking. A collision
    // is a warning at import and never a refusal (`docs/skills.md` §1), so the
    // library really does hold two — and a profile is read by everybody who
    // can reach it, which is why this is refused here and filtered there.
    //
    // Only the list. The two switches resolve per viewer against whoever
    // *starts* the run, so a tick that collides with somebody else's always-on
    // set is not knowable from here; the editor's count says so instead.
    let mut together: std::collections::BTreeMap<&str, Vec<&str>> = Default::default();
    for id in &new.skill_scope {
        if let Some(name) = reachable.get(id) {
            together.entry(name.as_str()).or_default().push(id);
        }
    }
    let clashing: Vec<String> = together
        .iter()
        .filter(|(_, ids)| ids.len() > 1)
        .map(|(name, ids)| format!("{name} ({})", ids.join(", ")))
        .collect();
    if !clashing.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "two of the skills named share a name, and a skill's folder on a worker is its \
                 name — so neither could be loaded. Drop one, or rename it in the library: {}",
                clashing.join("; "),
            ),
        ));
    }
    Ok(())
}

#[utoipa::path(
    get, path = "/api/v1/roles", tag = "roles",
    responses((status = 200, body = Vec<Role>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_roles(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<Vec<Role>>> {
    let me = whoever(&principal)?;
    Ok(Json(
        state.roles.visible(me.id.as_str(), Level::Viewer).await?,
    ))
}

#[utoipa::path(
    post, path = "/api/v1/roles", tag = "roles",
    request_body = NewRole,
    responses((status = 201, body = Role), (status = 400, body = ApiError)),
)]
pub(super) async fn create_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(new): Json<NewRole>,
) -> ApiResult<(StatusCode, Json<Role>)> {
    let me = whoever(&principal)?;
    crate::roles::check(&new).map_err(refused)?;
    check_account(&state, me.id.as_str(), &new).await?;
    check_skills(&state, me.id.as_str(), &new).await?;

    let id = state
        .roles
        .create(me.org_id.as_str(), me.id.as_str(), &me.slug, &new)
        .await
        .map_err(wrote)?;

    // Hand it to a directory, when one was named — the same operation the
    // sharing sheet performs later, at the one moment nobody has to be told it
    // changed hands. Only where this person may write; a directory they cannot
    // reach is "not found" rather than a different error.
    if let Some(directory) = new.directory.as_deref().filter(|d| !d.is_empty()) {
        let target = state
            .access
            .directory(directory)
            .await?
            .ok_or_else(|| ApiError::not_found("directory"))?;
        let may = matches!(
            state.access.level_on(me.id.as_str(), directory).await?,
            Some(level) if level >= Level::Writer
        );
        if !may {
            return Err(ApiError::not_found("directory"));
        }
        let from = state
            .access
            .path_of(crate::access::FiledKind::Role, id.as_str())
            .await?
            .ok_or_else(|| ApiError::not_found("role"))?;
        let whose = principal
            .user
            .as_ref()
            .map(|u| u.username.clone())
            .unwrap_or_else(|| me.id.as_str().to_string());
        state
            .access
            .transfer(
                &state.vault,
                crate::access::FiledKind::Role,
                id.as_str(),
                &from.moved_to(ft_core::path::DIRECTORY, &target.slug),
                &whose,
            )
            .await?;
    }

    let made = state
        .roles
        .one(me.id.as_str(), id.as_str(), Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("role"))?;
    Ok((StatusCode::CREATED, Json(made)))
}

#[utoipa::path(
    put, path = "/api/v1/roles/{id}", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    request_body = NewRole,
    responses((status = 200, body = Role), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn update_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(new): Json<NewRole>,
) -> ApiResult<Json<Role>> {
    let me = whoever(&principal)?;
    crate::roles::check(&new).map_err(refused)?;
    check_account(&state, me.id.as_str(), &new).await?;
    check_skills(&state, me.id.as_str(), &new).await?;

    // Absent rather than refused when they may not change it, for the reason
    // every other read gives: a role you cannot reach is one you are not told
    // exists.
    if !state
        .roles
        .update(me.id.as_str(), &id, &new)
        .await
        .map_err(wrote)?
    {
        return Err(ApiError::not_found("role"));
    }
    let now = state
        .roles
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("role"))?;
    Ok(Json(now))
}

/// Turn this profile into the person's default for new workspaces, or off.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoleDefault {
    pub on: bool,
}

#[utoipa::path(
    put, path = "/api/v1/roles/{id}/default", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    request_body = RoleDefault,
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn set_default_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    Json(body): Json<RoleDefault>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    if !state
        .roles
        .set_default(me.id.as_str(), &id, body.on)
        .await?
    {
        return Err(ApiError::not_found("role"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete, path = "/api/v1/roles/{id}", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    if !state.roles.delete(me.id.as_str(), &id).await? {
        return Err(ApiError::not_found("role"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Where this profile sits: one entry per position it holds, in a team this
/// person can see.
///
/// The drawer's *In teams* tab, and the confirmation before a delete. It
/// answers both in one request, which is the point: the alternative reads
/// every team's whole tree and filters it in the window, at a request a team,
/// and moves the rules about withheld names there at the same time.
///
/// A profile this person cannot see is **not found**, as every other read of
/// one is. What comes back is already narrowed to the teams they may see.
#[utoipa::path(
    get, path = "/api/v1/roles/{id}/positions", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    responses(
        (status = 200, body = Vec<crate::agent_teams::ProfilePosition>),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn role_positions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<crate::agent_teams::ProfilePosition>>> {
    let me = whoever(&principal)?;
    if state
        .roles
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("role"));
    }
    Ok(Json(
        state
            .agent_teams
            .profile_positions(me.id.as_str(), &id)
            .await?,
    ))
}

/// A profile as the file that describes it, ready to be written into a
/// repository.
///
/// The text and the path it belongs at, rather than a download: the folder
/// name is the profile's identity, so a client that is handed only
/// `PROFILE.md` has to work out where to put it, and this is the one place
/// that knows.
#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileFile {
    /// The folder name, which is the profile's identity.
    pub key: String,
    /// Where the bundle belongs: `profiles/<key>/PROFILE.md`.
    pub path: String,
    /// The file.
    pub text: String,
}

/// Every name this profile's references have, under this person's own grants.
///
/// **Resolved at Viewer, and a reference this person cannot see refuses the
/// whole export.** An exported file carries the *names* of the machines,
/// subscriptions, directories, teammates and skills a profile points at, so
/// somebody who may read a profile but not the machine it pins would learn
/// that machine's name.
///
/// **The reimport argument settles it on its own**: substituting `~` or
/// dropping the line gives a file that imports cleanly and silently changes
/// the profile, so the only safe answers are "resolve it" or "refuse", and
/// refusing is the one that discloses nothing.
///
/// Viewer is the level because this module is not the first to need the
/// distinction. Three functions in `api/accounts.rs` draw it with
/// `filed_where` and say why in their own words: `list_accounts` reads at
/// `Level::Viewer` (:334) "because a screen saying a colleague has one is
/// telling you it exists", while `usable` (:190) and `spendable` (:286) demand
/// `Level::Writer`, the first of them noting "being allowed to see that it
/// exists is deliberately not enough". **Knowing a resource exists is a Viewer
/// act; using it is a Writer act**, and a name is the first of those.
///
/// Not the `usable` in `desktop/src/api/accounts.ts`, which is a different
/// function with the same name: a readiness predicate over `enabled`, `state`
/// and `credentialSet` that holds no grant and never asks who is asking. Said
/// here because the two are easy to mistake for each other, and this paragraph
/// is the one that would be wrong if they were.
///
/// **What it must not do is degrade.** Writing `~` or dropping the line for a
/// reference this person cannot see would produce a file that imports cleanly
/// and silently changes the profile, which is worse than refusing. So this
/// returns a complete set of names or a refusal that says what is in the way.
///
/// The one exception is an id with nothing behind it. `delegate_scope` and
/// `skill_scope` are `text[]` with no foreign key, and the `profile_scope`
/// migration says what that costs: "a stale id simply drops out", because
/// every read intersects the list with what is actually visible. A file that
/// mentioned a deleted teammate would describe something the profile does not
/// do, so those are left out — and `which_exist` is what tells that case from
/// the one above it.
async fn named_for(
    state: &AppState,
    me: &str,
    org: &str,
    role: &Role,
) -> ApiResult<crate::roles::profile_md::Named> {
    use crate::roles::profile_md::SkillRef;

    // What this person may not see, said as the thing it is rather than as the
    // id they cannot look up.
    let mut hidden: Vec<String> = Vec::new();

    let machine = match role.machine.as_deref() {
        None => None,
        // `host_named` rather than a scan of `hosts_for`: that list drops the
        // retired local host, and the migration that retired it left every
        // profile pinned to it pinned, so asking it would report a machine
        // somebody can see perfectly well as one they cannot.
        Some(id) => {
            let found = state.db.host_named(me, id).await?.map(|h| h.name);
            if found.is_none() {
                hidden.push("the machine it runs on".into());
            }
            found
        }
    };

    let account = match role.account.as_deref() {
        None => None,
        Some(id) => {
            let found = super::accounts::nameable(&state.db, me, id)
                .await?
                .map(|a| a.name);
            if found.is_none() {
                hidden.push("the subscription it runs on".into());
            }
            found
        }
    };

    // A profile filed in a directory names it; one in somebody's own space
    // leaves the key open, which is what the importer's own space means.
    //
    // This person can always see it: a profile is only visible through the
    // same grant, so a directory that could not be read here is a profile that
    // was never returned. The arm stays because "always" is a fact about
    // another module.
    let directory = match ft_core::ResourcePath::from_stored(&role.path).directory_slug() {
        None => None,
        Some(slug) => {
            let found = state
                .access
                .directory_by_slug(org, slug)
                .await?
                .map(|d| d.name);
            if found.is_none() {
                hidden.push("the directory it is filed in".into());
            }
            found
        }
    };

    let mut delegates_to: Vec<String> = Vec::new();
    if !role.delegate_scope.is_empty() {
        let named: std::collections::HashMap<String, String> = state
            .roles
            .visible(me, Level::Viewer)
            .await?
            .into_iter()
            .map(|r| (r.id, r.name))
            .collect();
        let still_there = state.roles.which_exist(&role.delegate_scope).await?;
        let mut unseen = 0;
        for id in &role.delegate_scope {
            match named.get(id) {
                Some(name) => delegates_to.push(name.clone()),
                None if !still_there.contains(id) => {}
                None => unseen += 1,
            }
        }
        if unseen > 0 {
            hidden.push(format!("{unseen} of the profiles on its team",));
        }
    }

    let mut skills: Vec<SkillRef> = Vec::new();
    if !role.skill_scope.is_empty() {
        let reachable = state.skills.visible(me, Level::Viewer).await?;
        // A name that more than one reachable skill answers to has to be
        // written with its directory in front of it, or the file would name
        // something the plan cannot resolve. `slug` is unique per installation
        // and `name` is not — "two people may each own a dataviz".
        let mut how_many: std::collections::HashMap<&str, usize> = Default::default();
        for skill in &reachable {
            *how_many.entry(skill.name.as_str()).or_default() += 1;
        }
        let directories: std::collections::HashMap<String, String> = state
            .access
            .directories_in(org, me)
            .await?
            .into_iter()
            .map(|d| (d.slug, d.name))
            .collect();
        let still_there = state.skills.which_exist(&role.skill_scope).await?;
        let mut unseen = 0;
        for id in &role.skill_scope {
            let Some(skill) = reachable.iter().find(|s| s.id.as_str() == id) else {
                if still_there.contains(id) {
                    unseen += 1;
                }
                continue;
            };
            let qualifier = (how_many.get(skill.name.as_str()).copied().unwrap_or(0) > 1)
                .then(|| {
                    ft_core::ResourcePath::from_stored(&skill.path)
                        .directory_slug()
                        .and_then(|slug| directories.get(slug).cloned())
                })
                .flatten();
            skills.push(SkillRef {
                directory: qualifier,
                name: skill.name.clone(),
            });
        }
        if unseen > 0 {
            hidden.push(format!("{unseen} of the skills it loads"));
        }
    }

    if !hidden.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "This profile points at things you can't see, so the file would describe a \
                 different profile: {}. Ask whoever shared it to export it, or to share what \
                 it points at.",
                hidden.join(", ")
            ),
        ));
    }

    Ok(crate::roles::profile_md::Named {
        machine,
        account,
        directory,
        delegates_to,
        skills,
    })
}

/// The key this row carries: the folder its author's bundle was in.
///
/// **Wired in**, which is what this seam existed for. `author_key` is
/// `Role::key` (#355), and `key_of` prefers it over deriving one from the name
/// — so a profile imported from `qa-engineer/` exports back into
/// `qa-engineer/` rather than into `qa/` because it is called `QA`.
///
/// The failure this guards against is silent and was reproduced over HTTP
/// before the two halves met: with the column present and this function still
/// answering `None`, every profile whose key and name agree round-trips
/// perfectly and the one where they differ comes back from the plan as **new**,
/// which a review would let somebody accept. A second `QA`, through export, is
/// the duplicate folder-as-identity exists to prevent — so
/// `the_round_trip_holds_for_the_row_whose_key_and_name_disagree` asserts the
/// plan's verdict on export's own output rather than this function's answer. A
/// unit test over `key_of` passes whether or not anything calls it.
fn stored_key(role: &Role) -> Option<&str> {
    role.key.as_deref()
}

/// A profile as a `PROFILE.md`, so it can be committed and read in a diff.
///
/// Read access and nothing more: this writes a file and changes nothing. What
/// it carries about the things the profile points at is `named_for`'s
/// business, and the policy is stated there.
#[utoipa::path(
    get, path = "/api/v1/roles/{id}/export", tag = "roles",
    params(("id" = String, Path, description = "Role id")),
    responses(
        (status = 200, body = ProfileFile),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
    ),
)]
pub(super) async fn export_role(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<ProfileFile>> {
    use crate::roles::profile_md;

    let me = whoever(&principal)?;
    // Absent rather than refused, the same as every other read: a profile you
    // cannot reach is one you are not told exists.
    let role = state
        .roles
        .one(me.id.as_str(), &id, Level::Viewer)
        .await?
        .ok_or_else(|| ApiError::not_found("role"))?;

    let named = named_for(&state, me.id.as_str(), me.org_id.as_str(), &role).await?;
    let key = profile_md::key_of(stored_key(&role), &role.name);
    let profile = profile_md::of_role(&role, &key, named).map_err(refused)?;

    Ok(Json(ProfileFile {
        path: profile_md::path_of(&profile.key),
        key: profile.key.clone(),
        text: profile_md::serialize(&profile),
    }))
}

// ── importing a folder of bundles ───────────────────────────────────────

/// What this person can see, as the plan's resolution is allowed to know it.
///
/// **Six reads, every one of them already filtered**, which is the whole of the
/// arrangement: `roles::visible`, `db::hosts_for`, `accounts::spendable`,
/// `access::directories_for` and `skills::visible` each paste
/// `access::filed_where` through their own query, so nothing reaches
/// `import::plan` that the asker could not already list through an endpoint
/// they have. Resolution therefore cannot distinguish "that does not exist"
/// from "you may not have that" — it never learns the difference.
///
/// Subscriptions are read at **Editor** (`spendable`), not Viewer, and that is
/// deliberate: a profile naming one spends somebody's quota, which is the bar
/// `usable` and `check_account` already set on the write path. A plan that
/// resolved a subscription the apply would then refuse has offered a choice
/// that was never there.
async fn visible_to(state: &AppState, me: &crate::accounts::User) -> ApiResult<import::Here> {
    let who = me.id.as_str();
    Ok(import::Here {
        profiles: state.roles.visible(who, Level::Viewer).await?,
        machines: state
            .db
            .hosts_for(who, Level::Viewer)
            .await?
            .into_iter()
            .map(named)
            .collect(),
        // Read separately rather than folded in, because a file may name one
        // and it still blocks: see `import::Here::retired`.
        retired: state
            .db
            .retired_hosts(who, Level::Viewer)
            .await?
            .into_iter()
            .map(named)
            .collect(),
        accounts: super::accounts::spendable(state, who)
            .await?
            .into_iter()
            .map(|a| import::Subscription {
                id: a.id,
                name: a.name,
                engine: a.kind,
            })
            .collect(),
        directories: state
            .access
            .directories_for(who)
            .await?
            .into_iter()
            .map(|d| import::Dir {
                may_write: matches!(d.level, Some(level) if level >= Level::Writer),
                id: d.id.as_str().to_string(),
                name: d.name,
                slug: d.slug,
            })
            .collect(),
        skills: state
            .skills
            .visible(who, Level::Viewer)
            .await?
            .into_iter()
            .map(|s| import::SkillHere {
                id: s.id.as_str().to_string(),
                name: s.name,
                path: s.path,
            })
            .collect(),
    })
}

/// A machine, as resolution needs it: an id and the name a file would write.
fn named(host: ft_core::Host) -> import::Named {
    import::Named {
        id: host.id.as_str().to_string(),
        name: host.name,
    }
}

/// What a dropped folder of profile bundles would do.
///
/// **Read-only, with no exceptions.** It takes the files, says what each one is
/// against the library, and writes nothing — see `roles::import` for why the
/// plan it returns cannot be used as a capability by the apply (#356).
#[utoipa::path(
    post, path = "/api/v1/roles/import/plan", tag = "roles",
    request_body = import::ProfileDrop,
    responses(
        (status = 200, body = import::ImportPlan),
        (status = 400, body = ApiError),
        (status = 401, body = ApiError),
    ),
)]
pub(super) async fn plan_role_import(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(dropped): Json<import::ProfileDrop>,
) -> ApiResult<Json<import::ImportPlan>> {
    let me = whoever(&principal)?;
    let here = visible_to(&state, me).await?;
    import::plan(&dropped, &here).map(Json).map_err(refused)
}

/// What an import will take, before anything is dropped.
///
/// **So a client can refuse before it asks rather than after**, which is what
/// [`import::PlanLimits`] has always said it was for and what nothing could
/// read until there was an endpoint for it. The desktop needs the figures
/// *before* it expands an archive: a zip that unpacks into more than this is a
/// drop that is refused, and inflating it first to find that out is the denial
/// of service the threat model's fifth finding is about.
///
/// The same figures the plan carries, from the same constants. Nothing about
/// this installation is in them, so it needs no authorisation beyond being
/// signed in.
#[utoipa::path(
    get, path = "/api/v1/roles/import/limits", tag = "roles",
    responses((status = 200, body = import::PlanLimits), (status = 401, body = ApiError)),
)]
pub(super) async fn role_import_limits(
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<import::PlanLimits>> {
    whoever(&principal)?;
    Ok(Json(import::PlanLimits::ours()))
}

/// Apply a drop somebody has reviewed.
///
/// **The plan is a presentation, and this is where that pays for itself.** The
/// input is the plan endpoint's input plus the fingerprint of what was shown:
/// no resolved ids, no overwrite targets, no permission flags. Every write
/// below is derived here, by `import::decide` over those same files and a
/// snapshot of what this person can see *now*, and then authorised again
/// against the row it would overwrite inside the transaction that overwrites
/// it.
///
/// Three gates, in this order, and each one answers a different question:
///
/// 1. **Is this drop appliable at all**, as read at this moment? A bundle that
///    has become blocked since the review stops the set.
/// 2. **Is it still what was reviewed?** The fingerprint of every entry
///    derived here against the ones handed back. A profile that was filed
///    elsewhere, or whose pinned machine was deleted, changes an entry without
///    changing `updated_at` — see [`import::PlanEntry::digest`].
/// 3. **May this person still perform each write?** Writer on every row
///    overwritten and Editor on the directory anything new is filed in, read
///    inside the transaction, plus `check_account` and `check_skills` — the
///    same two the editor's own save goes through, so an import cannot be a
///    way around either.
///
/// Then one transaction, two passes: every profile written, then every team
/// wired, because a team may name a profile from the same drop. The set
/// applies whole or not at all.
#[utoipa::path(
    post, path = "/api/v1/roles/import/apply", tag = "roles",
    request_body = import::AcceptedDrop,
    responses(
        (status = 200, body = import::ImportDone),
        (status = 400, body = ApiError),
        (status = 401, body = ApiError),
    ),
)]
pub(super) async fn apply_role_import(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(accepted): Json<import::AcceptedDrop>,
) -> ApiResult<Json<import::ImportDone>> {
    let me = whoever(&principal)?;
    let here = visible_to(&state, me).await?;
    let decided = import::decide(&accepted.drop, &here).map_err(refused)?;

    if !decided.plan.appliable {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!(
                "{} Nothing was written. Drop the folder again to see what it would do now.",
                decided.plan.why_not.join(" ")
            ),
        ));
    }
    // **What is applied is what was reviewed, row for row.** Set equality
    // both ways: a row whose fingerprint has moved is one the library changed
    // underneath, and a row the accept never names is one nobody looked at.
    let mut reviewed = accepted.reviewed.clone();
    let mut derived: Vec<String> = decided
        .plan
        .entries
        .iter()
        .map(|entry| entry.digest.clone())
        .collect();
    reviewed.sort();
    derived.sort();
    if reviewed != derived {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "what this drop would do has changed since it was reviewed, so nothing was written. \
             Drop the folder again and read the plan before accepting it."
                .to_string(),
        ));
    }

    // The editor's own two checks, on the way in, before anything is opened.
    // Not a second opinion: they are the gates `create_role` and `update_role`
    // apply, and an import that skipped them would be a way to pin a skill or
    // spend a subscription the Profiles screen refuses.
    for write in &decided.writes {
        check_account(&state, me.id.as_str(), &write.asked).await?;
        check_skills(&state, me.id.as_str(), &write.asked).await?;
    }

    let mut tx = state.db.pool().begin().await?;
    let mut made: std::collections::BTreeMap<&str, String> = Default::default();
    let mut done: Vec<import::WroteProfile> = Vec::new();

    // **One pass, in the plan's order**, which is path order: a deterministic
    // order to take row locks in, so two imports of overlapping drops wait for
    // each other rather than deadlocking.
    for write in &decided.writes {
        let created = matches!(write.onto, import::Onto::Create);
        let id = match &write.onto {
            import::Onto::Create => {
                let filed = match &write.filed {
                    None => None,
                    Some(directory) => {
                        // Read in the transaction, so a grant withdrawn since
                        // the review refuses rather than filing a profile
                        // where this person may no longer write.
                        let may = matches!(
                            crate::access::level_on_in(&mut *tx, me.id.as_str(), &directory.id)
                                .await?,
                            Some(level) if level >= Level::Writer
                        );
                        if !may {
                            return Err(ApiError::new(
                                ErrorCode::InvalidRequest,
                                format!(
                                    "you can no longer file anything in `{}`, so nothing was \
                                     written. Ask for Editor on it, or remove the `directory:` \
                                     line from `{}` and the profile stays in your own space.",
                                    directory.name, write.path
                                ),
                            ));
                        }
                        Some(directory.slug.as_str())
                    }
                };
                let parent = match &write.filed {
                    Some(directory) => format!("d.{}", directory.slug),
                    None => format!("u.{}", me.slug),
                };
                if let Some(held) =
                    crate::roles::keyed_already(&mut *tx, &parent, &write.key, None).await?
                {
                    return Err(key_clash(Some(&held), write, &write.filed));
                }
                crate::roles::create_in(
                    &mut *tx,
                    me.org_id.as_str(),
                    me.id.as_str(),
                    &me.slug,
                    crate::roles::Filing {
                        directory: filed,
                        key: Some(&write.key),
                    },
                    &write.asked,
                )
                .await
                .map_err(|e| taken_meanwhile(e, write, &write.filed))?
                .as_str()
                .to_string()
            }
            import::Onto::Replace {
                profile,
                was,
                adopts_key,
            } => {
                // Writer, now, through the one predicate — and inside the
                // transaction, so the answer cannot change between the check
                // and the write it decides.
                if !crate::roles::may_write_in(&mut *tx, me.id.as_str(), profile).await? {
                    return Err(ApiError::new(
                        ErrorCode::InvalidRequest,
                        format!(
                            "`{}` is no longer a profile you can change, so nothing was written. \
                             Ask for Editor where it is filed, or leave `{}` out of the drop.",
                            write.asked.name, write.path
                        ),
                    ));
                }
                // And it is still the row the review was about. The lock is
                // held to the commit, so what is checked here is what is
                // written below.
                let standing = crate::roles::standing_in(&mut *tx, profile).await?;
                if standing.as_ref() != Some(was) {
                    return Err(ApiError::new(
                        ErrorCode::InvalidRequest,
                        format!(
                            "`{}` changed while this drop was being reviewed, so nothing was \
                             written. Drop the folder again to see what it would do now.",
                            write.asked.name
                        ),
                    ));
                }
                if *adopts_key {
                    let parent =
                        crate::roles::filed_beside(&ft_core::ResourcePath::from_stored(&was.path));
                    if let Some(held) =
                        crate::roles::keyed_already(&mut *tx, &parent, &write.key, Some(profile))
                            .await?
                    {
                        return Err(key_clash(Some(&held), write, &filed_in(&was.path, &here)));
                    }
                }
                crate::roles::replace_in(
                    &mut *tx,
                    profile,
                    adopts_key.then_some(write.key.as_str()),
                    &write.asked,
                )
                .await
                .map_err(|e| taken_meanwhile(e, write, &filed_in(&was.path, &here)))?;
                profile.clone()
            }
        };
        made.insert(write.path.as_str(), id.clone());
        done.push(import::WroteProfile {
            path: write.path.clone(),
            key: write.key.clone(),
            profile: id,
            name: write.asked.name.clone(),
            created,
        });
    }

    // The second pass. Every id exists now, including the ones this drop made,
    // which is the whole reason there are two.
    for write in &decided.writes {
        if write.team.is_empty() {
            continue;
        }
        let mut team: Vec<String> = Vec::new();
        for mate in &write.team {
            match mate {
                import::Teammate::Here(id) => team.push(id.clone()),
                // Resolution found the bundle, and the pass above wrote it.
                // Absent is a bug rather than a state: it would mean the two
                // passes disagreed about what the drop holds, and writing a
                // short team would quietly widen what the profile may
                // delegate to — `delegate_scope = []` is *any* profile the
                // owner can see.
                import::Teammate::InDrop(path) => match made.get(path.as_str()) {
                    Some(id) => team.push(id.clone()),
                    None => {
                        return Err(ApiError::new(
                            ErrorCode::InvalidRequest,
                            format!(
                                "`{}` names a teammate this drop no longer holds, so nothing was \
                                 written. Drop the folder again to see what it would do now.",
                                write.path
                            ),
                        ))
                    }
                },
            }
        }
        crate::roles::set_team_in(&mut *tx, &made[write.path.as_str()], &team).await?;
    }

    tx.commit().await?;
    Ok(Json(import::ImportDone { wrote: done }))
}

/// A write the key's own index refused, in the window `key_is_taken` cannot
/// close: another import committing the same key in the same directory between
/// the read above and this write. Rare, and it is the one failure that would
/// otherwise reach somebody as a constraint name.
fn taken_meanwhile(
    e: anyhow::Error,
    write: &import::Write,
    filed: &Option<import::Dir>,
) -> ApiError {
    match crate::roles::key_already_filed_there(&e) {
        true => key_clash(None, write, filed),
        false => wrote(e),
    }
}

/// What a key already in use says.
///
/// A key is one profile within one directory, so two of them is a question
/// about folder names rather than a fault in either file.
fn key_clash(
    held_by: Option<&str>,
    write: &import::Write,
    filed: &Option<import::Dir>,
) -> ApiError {
    let somewhere = match filed {
        Some(directory) => format!("`{}`", directory.name),
        None => "your own space".to_string(),
    };
    // Named when it is known. The write's own refusal arrives from the index
    // with the transaction already aborted, so there is nothing left to look
    // the profile up with — and a sentence that cannot name it still names the
    // key, the place and both ways out.
    let holder = match held_by {
        Some(name) => format!("already holds `{name}`, which carries"),
        None => "already holds a profile carrying".to_string(),
    };
    ApiError::new(
        ErrorCode::InvalidRequest,
        format!(
            "{somewhere} {holder} the key `{}`. Two profiles filed together cannot share one, so \
             nothing was written. Rename the folder `{}` is in, or file one of the two somewhere \
             else.",
            write.key, write.path
        ),
    )
}

/// The directory a path is filed in, as this person sees it.
fn filed_in(path: &str, here: &import::Here) -> Option<import::Dir> {
    let slug = ft_core::ResourcePath::from_stored(path)
        .directory_slug()?
        .to_string();
    here.directories.iter().find(|d| d.slug == slug).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{NewGrant, SubjectKind};
    use crate::roles::import::{DroppedFile, FieldChange, FieldDiff, PlanOutcome, ProfileDrop};
    use crate::roles::profile_md;
    use std::sync::Arc;

    /// A database with an organisation and an administrator, and the state to
    /// call a handler with — the arrangement `annotations.rs` uses, minus the
    /// session and the worker, neither of which a profile has.
    async fn fixture() -> (AppState, Principal) {
        let (db, _admin) = crate::db::Db::open_for_test_owned().await.unwrap();
        let accounts = crate::accounts::Accounts::new(db.pool().clone());
        let user = accounts.user_by_name("admin").await.unwrap().unwrap();
        let principal = Principal {
            subject: "admin".into(),
            via: crate::auth::Via::Session,
            user: Some(user),
        };
        let vault = Arc::new(crate::vault::Vault::new(
            db.pool().clone(),
            crate::vault::crypto::RootKey::generate(),
        ));
        let names = crate::preview::Names::from_vault(&vault);
        let connections = crate::providers::Connections::opened(db.pool().clone())
            .await
            .unwrap();
        let fleet = crate::fleet::Fleet::new(db.clone());
        (
            AppState {
                skills: crate::skills::Skills::new(db.pool().clone()),
                roles: crate::roles::Roles::new(db.pool().clone()),
                agent_teams: crate::agent_teams::AgentTeams::new(db.pool().clone()),
                updates: crate::updates::Updates::new(db.pool().clone()),
                policy: crate::auth::Policy::open(),
                access: crate::access::Access::new(db.pool().clone()),
                connections,
                db,
                accounts,
                fleet,
                vault,
                names,
                key_source: "test".into(),
                home: std::env::temp_dir(),
                pending: Default::default(),
                renewals: Default::default(),
                forwards: Default::default(),
                previews: Default::default(),
                public_url: "http://localhost:3000".into(),
            },
            principal,
        )
    }

    /// Somebody who is not an administrator, and the principal to ask as them.
    async fn colleague(state: &AppState, name: &str) -> Principal {
        let org = ft_core::OrgId::from_stored(state.db.org().await.unwrap());
        let (user, _) = state
            .accounts
            .create_user(&org, name, &format!("{name}@example.test"), "member")
            .await
            .unwrap();
        Principal {
            subject: name.into(),
            via: crate::auth::Via::Session,
            user: Some(user),
        }
    }

    fn asked_for(name: &str) -> NewRole {
        NewRole {
            name: name.into(),
            does: "Orchestrates feature delivery from request to draft PRs.".into(),
            placement: "new".into(),
            agent: Some("ClaudeCode".into()),
            machine: None,
            account: None,
            instructions: "# Manager\n\nYou own delivery.".into(),
            on_usage_limit: Some("engine".into()),
            on_child_limit: Some("reroute".into()),
            can_delegate: true,
            delegate_scope: vec![],
            include_always_on: Some(false),
            include_repo_defaults: Some(true),
            skill_scope: vec![],
            settings: Default::default(),
            directory: None,
        }
    }

    async fn made(state: &AppState, who: &Principal, new: &NewRole) -> String {
        let me = whoever(who).unwrap();
        state
            .roles
            .create(me.org_id.as_str(), me.id.as_str(), &me.slug, new)
            .await
            .unwrap()
            .as_str()
            .to_string()
    }

    /// **A profile exports as a file that reads back as the same profile.**
    ///
    /// The governing property of #354, through the endpoint rather than over a
    /// fixture: every field of the row reaches the file, and the file parses to
    /// what the row says.
    #[tokio::test]
    async fn a_profile_exports_as_a_file_that_parses_back() {
        let (state, admin) = fixture().await;
        let id = made(&state, &admin, &asked_for("Engineering Manager")).await;

        let Json(file) = export_role(
            State(state.clone()),
            Extension(admin.clone()),
            Path(id.clone()),
        )
        .await
        .expect("a profile of my own exports");

        assert_eq!(file.key, "engineering-manager");
        assert_eq!(file.path, "profiles/engineering-manager/PROFILE.md");

        let read = profile_md::parse(std::path::Path::new(&file.path), &file.key, &file.text)
            .expect("a file export wrote parses");
        assert_eq!(read.name, "Engineering Manager");
        assert_eq!(
            read.does,
            "Orchestrates feature delivery from request to draft PRs."
        );
        assert_eq!(read.instructions, "# Manager\n\nYou own delivery.");
        assert_eq!(read.engine, Some(ft_core::Agent::ClaudeCode));
        assert_eq!(read.placement, profile_md::Placement::New);
        assert!(read.can_delegate);
        assert!(!read.include_always_on);
        assert!(read.include_repo_defaults);
        // Filed in nobody's directory, so the key is open rather than guessed.
        assert_eq!(read.directory, None);
    }

    /// A machine is written by the name somebody gave it, never by its id.
    #[tokio::test]
    async fn a_pinned_machine_is_written_by_name() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let host = state
            .db
            .ensure_test_host("fire-01", me.id.as_str())
            .await
            .unwrap();
        let mut new = asked_for("Engineering Manager");
        new.machine = Some(host.id.as_str().to_string());
        let id = made(&state, &admin, &new).await;

        let Json(file) = export_role(State(state.clone()), Extension(admin), Path(id))
            .await
            .unwrap();
        assert!(file.text.contains("machine: fire-01"), "{}", file.text);
        assert!(
            !file.text.contains(host.id.as_str()),
            "an id reached the file: {}",
            file.text
        );
    }

    /// **A reference the asker cannot see refuses the whole export.**
    ///
    /// The policy #354's threat model asked for, asserted rather than
    /// described. The alternative — writing `~` or dropping the line — would
    /// produce a file that imports cleanly and silently unpins the machine,
    /// which is worse than refusing.
    #[tokio::test]
    async fn a_reference_you_cannot_see_refuses_the_export() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let ana = colleague(&state, "ana").await;
        let hers = whoever(&ana).unwrap();

        // The administrator's own machine, in their own space.
        let host = state
            .db
            .ensure_test_host("fire-01", me.id.as_str())
            .await
            .unwrap();

        // A profile pinning it, filed where Ana can read it.
        let shelf = state
            .access
            .create_directory(
                &me.org_id,
                "Platform",
                &me.id,
                &[NewGrant {
                    subject_kind: SubjectKind::Person,
                    subject_id: hers.id.as_str().to_string(),
                    level: Level::Viewer,
                }],
            )
            .await
            .unwrap();
        let mut new = asked_for("Engineering Manager");
        new.machine = Some(host.id.as_str().to_string());
        let id = made(&state, &admin, &new).await;
        let from = state
            .access
            .path_of(crate::access::FiledKind::Role, &id)
            .await
            .unwrap()
            .unwrap();
        state
            .access
            .transfer(
                &state.vault,
                crate::access::FiledKind::Role,
                &id,
                &from.moved_to(ft_core::path::DIRECTORY, &shelf.slug),
                "admin",
            )
            .await
            .unwrap();

        // She can read the profile.
        assert!(state
            .roles
            .one(hers.id.as_str(), &id, Level::Viewer)
            .await
            .unwrap()
            .is_some());

        let no = export_role(State(state.clone()), Extension(ana), Path(id.clone()))
            .await
            .expect_err("the machine is not hers to see");
        let said = format!("{no:?}");
        assert!(said.contains("the machine it runs on"), "{said}");

        // And the owner still gets a complete file.
        let Json(file) = export_role(State(state), Extension(admin), Path(id))
            .await
            .unwrap();
        assert!(file.text.contains("machine: fire-01"), "{}", file.text);
    }

    /// A teammate who was deleted is left out, not refused.
    ///
    /// `delegate_scope` has no foreign key behind it, and every read already
    /// intersects it with what is visible — so a file naming a profile that no
    /// longer exists would describe something this profile does not do. The
    /// case next to it, a teammate that exists and is not visible, refuses.
    #[tokio::test]
    async fn a_teammate_that_no_longer_exists_is_left_out() {
        let (state, admin) = fixture().await;
        let designer = made(&state, &admin, &asked_for("Designer")).await;
        let mut new = asked_for("Engineering Manager");
        new.delegate_scope = vec![designer.clone(), "role_deleted".into()];
        // The same for a skill, which is the other `text[]` with no foreign key
        // behind it — and the one `Skills::which_exist` answers for.
        new.skill_scope = vec!["skill_deleted".into()];
        let id = made(&state, &admin, &new).await;

        let Json(file) = export_role(State(state), Extension(admin), Path(id))
            .await
            .expect("a stale id is not a reason to refuse a file");
        assert!(file.text.contains("- Designer"), "{}", file.text);
        assert!(!file.text.contains("role_deleted"), "{}", file.text);
        assert!(file.text.contains("skills: []"), "{}", file.text);
        assert!(!file.text.contains("skill_deleted"), "{}", file.text);
    }

    /// **A machine no list offers is still a machine with a name.**
    ///
    /// The retired local host is filtered out of every list of machines to run
    /// on, and `20261106120000_retire_local_host.sql` left every profile
    /// pinned to it pinned, on the grounds that repinning somebody's profile
    /// is their decision. So this is a real row an export has to be able to
    /// name, and reading it off a list of machines-to-run-on reported it as
    /// one the person could not see.
    #[tokio::test]
    async fn a_retired_machine_is_still_named() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let host = state
            .db
            .ensure_host("localhost", ft_core::Compute::Local, me.id.as_str())
            .await
            .unwrap();
        // What the migration did, which is what takes it out of the fleet.
        assert!(
            !state
                .db
                .hosts_for(me.id.as_str(), Level::Viewer)
                .await
                .unwrap()
                .iter()
                .any(|h| h.id == host.id),
            "a retired machine is in no list of machines to run on"
        );

        let mut new = asked_for("Engineering Manager");
        new.machine = Some(host.id.as_str().to_string());
        let id = made(&state, &admin, &new).await;

        let Json(file) = export_role(State(state), Extension(admin), Path(id))
            .await
            .expect("retired is not the same as hidden");
        assert!(file.text.contains("machine: localhost"), "{}", file.text);
    }

    /// A profile nobody may read is not one they are told exists.
    #[tokio::test]
    async fn a_profile_you_cannot_read_is_not_found() {
        let (state, admin) = fixture().await;
        let id = made(&state, &admin, &asked_for("Engineering Manager")).await;
        let ana = colleague(&state, "ana").await;

        let no = export_role(State(state), Extension(ana), Path(id))
            .await
            .expect_err("not hers to read");
        assert!(format!("{no:?}").contains("not_found") || format!("{no:?}").contains("NotFound"));
    }

    // ── export and the plan, as one round trip ──────────────────────────

    /// A profile with the key an import adopted onto it, whatever it is called.
    async fn keyed(state: &AppState, who: &Principal, name: &str, key: &str) -> String {
        let id = made(state, who, &asked_for(name)).await;
        sqlx::query("UPDATE roles SET author_key = $2 WHERE id = $1")
            .bind(&id)
            .bind(key)
            .execute(state.db.pool())
            .await
            .unwrap();
        id
    }

    /// The file export writes for one profile.
    async fn exported(state: &AppState, who: &Principal, id: &str) -> ProfileFile {
        export_role(
            State(state.clone()),
            Extension(who.clone()),
            Path(id.to_string()),
        )
        .await
        .expect("a profile of my own exports")
        .0
    }

    /// **Export reads the stored key, not the name.**
    ///
    /// The live divergence: `fstack`'s bundle is `qa-engineer/` and the profile
    /// is called `QA`. Over the endpoint rather than over `key_of`, because the
    /// defect this pins was not in `key_of` — it was in nothing calling it with
    /// the column.
    #[tokio::test]
    async fn export_writes_the_folder_the_key_names_rather_than_the_name() {
        let (state, admin) = fixture().await;
        let id = keyed(&state, &admin, "QA", "qa-engineer").await;

        let file = exported(&state, &admin, &id).await;
        assert_eq!(file.key, "qa-engineer");
        assert_eq!(file.path, "profiles/qa-engineer/PROFILE.md");
        // And the file says so too, so a bundle read away from its folder
        // still knows what it is.
        let read = profile_md::parse(std::path::Path::new(&file.path), &file.key, &file.text)
            .expect("export's own file parses");
        assert_eq!(read.key, "qa-engineer");
        assert_eq!(read.name, "QA");
    }

    /// **The round trip, on the row whose key and name disagree.**
    ///
    /// The regression test for the whole class, and the one that matters:
    /// `a_stored_key_outranks_the_name_it_disagrees_with` proves `key_of`, and
    /// nothing proved that anything *called* it. A unit test over a function
    /// passes whether or not it is wired, which is how a silent duplicate
    /// survived a green suite — so this asserts the **plan's verdict on
    /// export's own output**: an overwrite of the profile it came from, with
    /// nothing changing. Before the column was wired in this came back `new`,
    /// `appliable: true`, which a review would have let somebody accept.
    #[tokio::test]
    async fn the_round_trip_holds_for_the_row_whose_key_and_name_disagree() {
        let (state, admin) = fixture().await;
        let id = keyed(&state, &admin, "QA", "qa-engineer").await;
        let file = exported(&state, &admin, &id).await;

        let plan = plan_role_import(
            State(state.clone()),
            Extension(admin.clone()),
            Json(plan_for(vec![DroppedFile {
                path: file.path.clone(),
                text: file.text.clone(),
            }])),
        )
        .await
        .unwrap()
        .0;

        // The outcome first, deliberately: it is the sentence somebody needs
        // when this breaks. Asserting the folder first fails with `"qa" !=
        // "qa-engineer"`, which is true and says nothing about what it costs.
        let entry = &plan.entries[0];
        let PlanOutcome::Overwrite(over) = &entry.outcome else {
            panic!(
                "Firetower's own export of `QA` came back as {:#?} rather than an overwrite of \
                 the profile it was written from — which is a second QA that a review would let \
                 somebody accept",
                entry.outcome
            )
        };
        assert_eq!(entry.key, "qa-engineer");
        assert_eq!(over.profile.id, id);
        assert!(!over.adopts_key, "the row already carries the key");
        assert!(
            over.diff.iter().all(|f| f.change == FieldChange::Unchanged),
            "{:#?}",
            over.diff
                .iter()
                .filter(|f| f.change != FieldChange::Unchanged)
                .collect::<Vec<_>>()
        );
        assert!(plan.appliable);
    }

    /// And all five of `fstack`'s profiles at once: export every one, drop the
    /// five files back in, and get five overwrites with nothing changing.
    ///
    /// The set matters as well as the rows. `qa-engineer`/`QA` is the one that
    /// diverges, and a drop where four bundles are right and one is a create is
    /// exactly what a person would accept without reading closely.
    #[tokio::test]
    async fn the_five_fstack_profiles_export_and_re_plan_to_five_empty_overwrites() {
        let (state, admin) = fixture().await;
        // Their real folders, and the name each live profile actually has —
        // `qa-engineer` is called `QA`, which is the whole point of the set.
        let library = [
            ("designer", "Designer"),
            ("engineer", "Engineer"),
            ("engineering-manager", "Engineering Manager"),
            ("qa-engineer", "QA"),
            ("security-advisor", "Security Advisor"),
        ];
        let mut ids = Vec::new();
        for (key, name) in library {
            ids.push((key, keyed(&state, &admin, name, key).await));
        }

        let mut files = Vec::new();
        for (key, id) in &ids {
            let file = exported(&state, &admin, id).await;
            assert_eq!(&file.key, key, "export put `{key}` in the wrong folder");
            files.push(DroppedFile {
                path: file.path,
                text: file.text,
            });
        }

        let plan = plan_role_import(
            State(state.clone()),
            Extension(admin.clone()),
            Json(plan_for(files)),
        )
        .await
        .unwrap()
        .0;

        assert_eq!(plan.entries.len(), 5);
        for entry in &plan.entries {
            let PlanOutcome::Overwrite(over) = &entry.outcome else {
                panic!(
                    "`{}` came back as {:#?} rather than an overwrite",
                    entry.key, entry.outcome
                )
            };
            let changed: Vec<&FieldDiff> = over
                .diff
                .iter()
                .filter(|f| f.change != FieldChange::Unchanged)
                .collect();
            assert!(
                changed.is_empty(),
                "`{}` round-tripped with changes: {:#?}",
                entry.key,
                changed
            );
            assert!(
                over.diff.iter().all(|f| f
                    .settings
                    .iter()
                    .all(|s| s.change == FieldChange::Unchanged)),
                "`{}` round-tripped with a setting changing",
                entry.key
            );
            assert!(entry.warnings.is_empty(), "{:#?}", entry.warnings);
        }
        assert!(plan.appliable);
    }

    // ── the import plan ─────────────────────────────────────────────────

    fn bundle(key: &str, name: &str) -> DroppedFile {
        DroppedFile {
            path: format!("profiles/{key}/PROFILE.md"),
            text: format!("---\nname: {name}\ndoes: does the thing\n---\n\nInstructions.\n"),
        }
    }

    fn plan_for(files: Vec<DroppedFile>) -> ProfileDrop {
        ProfileDrop {
            files,
            answers: vec![],
        }
    }

    /// Every row of `roles`, as a fingerprint — so "writes nothing" can be
    /// asserted against the table rather than against the absence of a call.
    async fn every_row(state: &AppState) -> Vec<(String, String, Option<String>, String)> {
        sqlx::query_as("SELECT id, name, author_key, updated_at::text FROM roles ORDER BY id")
            .fetch_all(state.db.pool())
            .await
            .unwrap()
    }

    /// **The property with no exceptions.** A plan that would create one
    /// profile and overwrite another leaves the table exactly as it was.
    #[tokio::test]
    async fn the_plan_endpoint_writes_nothing() {
        let (state, principal) = fixture().await;
        let made = create_role(
            State(state.clone()),
            Extension(principal.clone()),
            Json(NewRole {
                name: "Designer".into(),
                does: "designs".into(),
                placement: "lead".into(),
                agent: None,
                machine: None,
                account: None,
                settings: Default::default(),
                instructions: String::new(),
                on_usage_limit: None,
                on_child_limit: None,
                can_delegate: false,
                delegate_scope: vec![],
                include_always_on: None,
                include_repo_defaults: None,
                skill_scope: vec![],
                directory: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(made.0, StatusCode::CREATED);

        let before = every_row(&state).await;
        assert_eq!(before.len(), 1);

        let plan = plan_role_import(
            State(state.clone()),
            Extension(principal.clone()),
            Json(plan_for(vec![
                bundle("designer", "Designer"),
                bundle("engineer", "Engineer"),
            ])),
        )
        .await
        .unwrap()
        .0;

        // It said it would overwrite the one that is here and create the one
        // that is not...
        let kinds: Vec<(&str, &str)> = plan
            .entries
            .iter()
            .map(|e| {
                (
                    e.key.as_str(),
                    match e.outcome {
                        PlanOutcome::New(_) => "new",
                        PlanOutcome::Overwrite(_) => "overwrite",
                        PlanOutcome::Rename(_) => "rename",
                        PlanOutcome::Blocked(_) => "blocked",
                        PlanOutcome::Candidate(_) => "candidate",
                    },
                )
            })
            .collect();
        assert_eq!(
            kinds,
            [("designer", "overwrite"), ("engineer", "new")],
            "{:#?}",
            plan.entries
        );
        assert!(plan.appliable);

        // ...and did neither.
        assert_eq!(every_row(&state).await, before);
    }

    /// The column, against the index that holds it: unique within the parent
    /// path, and every existing row's null colliding with nothing.
    #[tokio::test]
    async fn a_key_is_unique_within_its_parent_and_nulls_never_collide() {
        let (state, principal) = fixture().await;
        let who = whoever(&principal).unwrap().id.as_str().to_string();
        let org = state.db.org().await.unwrap();
        async fn mine(
            state: &AppState,
            org: &str,
            who: &str,
            path: &str,
            key: Option<&str>,
        ) -> Result<sqlx::postgres::PgQueryResult, sqlx::Error> {
            sqlx::query(
                "INSERT INTO roles (id, org_id, path, created_by, name, slug, does, author_key) \
                 VALUES ($1, $2, $3::ltree, $4, 'Designer', $1, 'designs', $5)",
            )
            .bind(ft_core::RoleId::new().as_str())
            .bind(org)
            .bind(path)
            .bind(who)
            .bind(key)
            .execute(state.db.pool())
            .await
        }
        let mine = |path: &'static str, key: Option<&'static str>| {
            let (state, org, who) = (&state, org.as_str(), who.as_str());
            async move { mine(state, org, who, path, key).await }
        };

        mine("u.kevin.designer_1", Some("designer")).await.unwrap();
        // The same key, in somebody else's space: the ordinary case, and the
        // whole reason the index is per parent rather than per installation.
        mine("u.ana.designer_2", Some("designer")).await.unwrap();
        // ...and in the same space, refused.
        let again = mine("u.kevin.designer_3", Some("designer")).await;
        assert!(
            again.is_err_and(|e| e
                .as_database_error()
                .is_some_and(|db| db.is_unique_violation())),
            "a second `designer` in one space has to be refused"
        );
        // Every row that predates the format is null, and nulls are distinct.
        mine("u.kevin.a_1", None).await.unwrap();
        mine("u.kevin.b_1", None).await.unwrap();
    }

    /// A key written onto a row is read back as the identity: the plan matches
    /// by it, and does not ask about the name.
    #[tokio::test]
    async fn a_row_that_carries_a_key_is_matched_by_it_and_not_by_its_name() {
        let (state, principal) = fixture().await;
        let who = whoever(&principal).unwrap().id.as_str().to_string();
        let org = state.db.org().await.unwrap();
        let id = ft_core::RoleId::new();
        sqlx::query(
            "INSERT INTO roles (id, org_id, path, created_by, name, slug, does, author_key) \
             VALUES ($1, $2, ('u.' || (SELECT slug FROM principals WHERE id = $3) || \
             '.designer_x')::ltree, $3, 'Something Else', $1, 'designs', 'designer')",
        )
        .bind(id.as_str())
        .bind(&org)
        .bind(&who)
        .execute(state.db.pool())
        .await
        .unwrap();

        let plan = plan_role_import(
            State(state.clone()),
            Extension(principal),
            Json(plan_for(vec![bundle("designer", "Designer")])),
        )
        .await
        .unwrap()
        .0;
        let PlanOutcome::Rename(renamed) = &plan.entries[0].outcome else {
            panic!("expected a rename, got {:#?}", plan.entries[0].outcome)
        };
        assert_eq!(renamed.from, "Something Else");
        assert_eq!(renamed.to, "Designer");
        assert_eq!(renamed.profile.key.as_deref(), Some("designer"));
        assert!(!renamed.adopts_key, "it already had one");
    }

    /// **Visibility filters before resolution.** A colleague's profile of the
    /// same name is not matched, not proposed, and not mentioned — the plan
    /// cannot tell the asker that it exists, because it never saw it.
    #[tokio::test]
    async fn a_colleagues_profile_of_the_same_name_is_neither_matched_nor_named() {
        let (state, principal) = fixture().await;
        let org = state.db.org().await.unwrap();
        let them = whoever(&colleague(&state, "them").await).unwrap().clone();
        let theirs = state
            .roles
            .create(
                &org,
                them.id.as_str(),
                &them.slug,
                &NewRole {
                    name: "Designer".into(),
                    does: "designs".into(),
                    placement: "lead".into(),
                    agent: None,
                    machine: None,
                    account: None,
                    settings: Default::default(),
                    instructions: String::new(),
                    on_usage_limit: None,
                    on_child_limit: None,
                    can_delegate: false,
                    delegate_scope: vec![],
                    include_always_on: None,
                    include_repo_defaults: None,
                    skill_scope: vec![],
                    directory: None,
                },
            )
            .await
            .unwrap();

        let plan = plan_role_import(
            State(state.clone()),
            Extension(principal),
            Json(plan_for(vec![bundle("designer", "Designer")])),
        )
        .await
        .unwrap()
        .0;
        assert!(
            matches!(plan.entries[0].outcome, PlanOutcome::New(_)),
            "{:#?}",
            plan.entries[0].outcome
        );
        let drawn = serde_json::to_string(&plan).unwrap();
        assert!(
            !drawn.contains(theirs.as_str()),
            "the plan named a profile the asker cannot see"
        );
    }

    // ── applying one ────────────────────────────────────────────────────

    /// The two calls a person makes, in order: plan it, then accept exactly
    /// what came back.
    async fn applied(
        state: &AppState,
        who: &Principal,
        drop: ProfileDrop,
    ) -> ApiResult<import::ImportDone> {
        let plan = planned(state, who, drop.clone()).await;
        accept(state, who, drop, reviewing(&plan)).await
    }

    /// What an accept hands back: the fingerprint of every row it is
    /// importing, which is every row of the plan when nothing was excluded.
    fn reviewing(plan: &import::ImportPlan) -> Vec<String> {
        plan.entries.iter().map(|e| e.digest.clone()).collect()
    }

    async fn planned(state: &AppState, who: &Principal, drop: ProfileDrop) -> import::ImportPlan {
        plan_role_import(State(state.clone()), Extension(who.clone()), Json(drop))
            .await
            .expect("a plan")
            .0
    }

    async fn accept(
        state: &AppState,
        who: &Principal,
        drop: ProfileDrop,
        reviewed: Vec<String>,
    ) -> ApiResult<import::ImportDone> {
        apply_role_import(
            State(state.clone()),
            Extension(who.clone()),
            Json(import::AcceptedDrop { drop, reviewed }),
        )
        .await
        .map(|json| json.0)
    }

    /// One profile, by id, as the person who asked sees it.
    async fn row(state: &AppState, who: &Principal, id: &str) -> Role {
        let me = whoever(who).unwrap();
        state
            .roles
            .one(me.id.as_str(), id, Level::Viewer)
            .await
            .unwrap()
            .expect("the profile is there")
    }

    /// Whatever a refusal said, as text to assert on. Folded, because a
    /// sentence that leads a message and one that follows another differ by a
    /// capital and no test is about that.
    fn said(e: &ApiError) -> String {
        format!("{e:?}").to_lowercase()
    }

    /// **The whole feature, through both calls.** Five profiles arrive from
    /// five files, every field is what the file says, and the two teams point
    /// at profiles the same drop created.
    #[tokio::test]
    async fn a_drop_writes_every_profile_and_wires_a_team_from_the_same_drop() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let host = state
            .db
            .ensure_test_host("fire-01", me.id.as_str())
            .await
            .unwrap();

        // A manager naming two teammates that do not exist yet. The order is
        // deliberate: `engineering-manager` sorts before the two folders it
        // names, so the team cannot be wired as the rows are written.
        let manager = DroppedFile {
            path: "profiles/engineering-manager/PROFILE.md".into(),
            text: "---\nname: Engineering Manager\ndoes: runs delivery\nengine: ClaudeCode\n\
                   placement: new\nmachine: fire-01\ncan_delegate: true\n\
                   delegates_to:\n  - Designer\n  - Engineer\n\
                   include_always_on: false\non_usage_limit: engine\non_child_limit: reroute\n\
                   settings:\n  model: opus\n  effort: high\n---\n\n# Manager\n\nYou own delivery.\n"
                .into(),
        };
        let done = applied(
            &state,
            &admin,
            plan_for(vec![
                manager,
                bundle("designer", "Designer"),
                bundle("engineer", "Engineer"),
            ]),
        )
        .await
        .expect("a drop of three applies");

        assert_eq!(done.wrote.len(), 3);
        assert!(done.wrote.iter().all(|w| w.created));

        let library = state
            .roles
            .visible(me.id.as_str(), Level::Viewer)
            .await
            .unwrap();
        assert_eq!(library.len(), 3);

        let lead = library
            .iter()
            .find(|r| r.name == "Engineering Manager")
            .unwrap();
        // The key is the folder's name, written here and nowhere else.
        assert_eq!(lead.key.as_deref(), Some("engineering-manager"));
        assert_eq!(lead.does, "runs delivery");
        assert_eq!(lead.agent.as_deref(), Some("ClaudeCode"));
        assert_eq!(lead.placement, "new");
        assert_eq!(lead.machine.as_deref(), Some(host.id.as_str()));
        assert!(lead.can_delegate);
        assert!(!lead.include_always_on);
        assert!(lead.include_repo_defaults);
        assert_eq!(lead.on_usage_limit, "engine");
        assert_eq!(lead.on_child_limit, "reroute");
        assert_eq!(lead.settings.model.as_deref(), Some("opus"));
        assert_eq!(lead.settings.effort.as_deref(), Some("high"));
        assert_eq!(lead.instructions, "# Manager\n\nYou own delivery.");

        // The second pass: both teammates, by the ids this drop just made.
        let designer = library.iter().find(|r| r.name == "Designer").unwrap();
        let engineer = library.iter().find(|r| r.name == "Engineer").unwrap();
        let mut team = lead.delegate_scope.clone();
        team.sort();
        let mut wanted = vec![designer.id.clone(), engineer.id.clone()];
        wanted.sort();
        assert_eq!(team, wanted, "a team naming its own drop resolves");
    }

    /// Cycles are a library somebody might mean, so they apply.
    #[tokio::test]
    async fn two_profiles_that_delegate_to_each_other_both_apply() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let pair = |key: &str, name: &str, mate: &str| DroppedFile {
            path: format!("profiles/{key}/PROFILE.md"),
            text: format!(
                "---\nname: {name}\ndoes: half of a pair\ncan_delegate: true\n\
                 delegates_to:\n  - {mate}\n---\n\nInstructions.\n"
            ),
        };
        applied(
            &state,
            &admin,
            plan_for(vec![
                pair("designer", "Designer", "Engineer"),
                pair("engineer", "Engineer", "Designer"),
            ]),
        )
        .await
        .expect("A to B and B to A is a legal library");

        let library = state
            .roles
            .visible(me.id.as_str(), Level::Viewer)
            .await
            .unwrap();
        let designer = library.iter().find(|r| r.name == "Designer").unwrap();
        let engineer = library.iter().find(|r| r.name == "Engineer").unwrap();
        assert_eq!(designer.delegate_scope, vec![engineer.id.clone()]);
        assert_eq!(engineer.delegate_scope, vec![designer.id.clone()]);
    }

    /// **A profile matched by its name gains the folder's key**, which is the
    /// one moment a row stops being matched by one and starts being matched by
    /// the other. `qa-engineer/` against the library's `QA` is the live case.
    #[tokio::test]
    async fn a_profile_matched_by_its_name_adopts_the_folders_key() {
        let (state, admin) = fixture().await;
        let id = made(&state, &admin, &asked_for("QA")).await;
        assert_eq!(row(&state, &admin, &id).await.key, None);

        let done = applied(&state, &admin, plan_for(vec![bundle("qa-engineer", "QA")]))
            .await
            .expect("an exact name match is the only candidate");

        assert_eq!(done.wrote.len(), 1);
        assert!(!done.wrote[0].created, "it overwrote the row it matched");
        assert_eq!(done.wrote[0].profile, id);
        let now = row(&state, &admin, &id).await;
        assert_eq!(now.key.as_deref(), Some("qa-engineer"));
        // And the next export writes it back into the folder it came from.
        assert_eq!(exported(&state, &admin, &id).await.key, "qa-engineer");
    }

    /// **Changing only the name is a rename, and leaves one profile.**
    ///
    /// The key is the identity, so a file whose `name` moved is the same
    /// profile under a new name — not a second one beside it. The plan says
    /// so in words rather than leaving a changed `name` row to be inferred,
    /// and the apply writes the row it named.
    #[tokio::test]
    async fn changing_only_the_name_renames_the_profile_it_is() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let id = keyed(&state, &admin, "QA", "qa-engineer").await;

        let renamed = DroppedFile {
            path: "profiles/qa-engineer/PROFILE.md".into(),
            text: format!(
                "---\nname: Quality\ndoes: {}\n---\n\n{}\n",
                asked_for("QA").does,
                asked_for("QA").instructions
            ),
        };
        let plan = planned(&state, &admin, plan_for(vec![renamed.clone()])).await;
        let PlanOutcome::Rename(rename) = &plan.entries[0].outcome else {
            panic!("{:#?}", plan.entries[0].outcome)
        };
        assert_eq!(
            (rename.from.as_str(), rename.to.as_str()),
            ("QA", "Quality")
        );

        accept(&state, &admin, plan_for(vec![renamed]), reviewing(&plan))
            .await
            .expect("a rename applies");

        let library = state
            .roles
            .visible(me.id.as_str(), Level::Viewer)
            .await
            .unwrap();
        assert_eq!(library.len(), 1, "a rename is one profile, not two");
        assert_eq!(library[0].id, id);
        assert_eq!(library[0].name, "Quality");
        assert_eq!(library[0].key.as_deref(), Some("qa-engineer"));
    }

    /// **Firetower's own export, fed straight back, through the accept.**
    ///
    /// The round trip the whole format rests on, and the half that could not
    /// be asserted before there was an apply: five overwrites with empty
    /// diffs, accepted, and nothing about any row different afterwards.
    /// `qa-engineer`/`QA` is in the set because it is the one that diverges.
    #[tokio::test]
    async fn the_five_fstack_profiles_export_and_apply_back_with_nothing_changing() {
        let (state, admin) = fixture().await;
        let library = [
            ("designer", "Designer"),
            ("engineer", "Engineer"),
            ("engineering-manager", "Engineering Manager"),
            ("qa-engineer", "QA"),
            ("security-advisor", "Security Advisor"),
        ];
        let mut ids = Vec::new();
        for (key, name) in library {
            ids.push(keyed(&state, &admin, name, key).await);
        }
        let mut files = Vec::new();
        for id in &ids {
            let file = exported(&state, &admin, id).await;
            files.push(DroppedFile {
                path: file.path,
                text: file.text,
            });
        }

        let mut before = Vec::new();
        for id in &ids {
            before.push(row(&state, &admin, id).await);
        }

        let plan = planned(&state, &admin, plan_for(files.clone())).await;
        assert_eq!(plan.entries.len(), 5);
        assert!(plan.appliable);
        for entry in &plan.entries {
            let PlanOutcome::Overwrite(over) = &entry.outcome else {
                panic!(
                    "`{}` is {:#?} rather than an overwrite",
                    entry.key, entry.outcome
                )
            };
            assert!(
                over.diff.iter().all(|f| f.change == FieldChange::Unchanged),
                "`{}` round-tripped with changes",
                entry.key
            );
            assert!(!over.adopts_key, "every row already carries its key");
        }

        let done = accept(&state, &admin, plan_for(files), reviewing(&plan))
            .await
            .expect("five empty overwrites apply");
        assert_eq!(done.wrote.len(), 5);
        assert!(done.wrote.iter().all(|w| !w.created));

        for (was, id) in before.iter().zip(&ids) {
            let now = row(&state, &admin, id).await;
            // **Every column, read off the response model** rather than a
            // list written here: a field added to a profile is covered by
            // this the day it is added. All but the timestamp, which an
            // overwrite in place moves whether or not a column changed.
            assert_eq!(
                but_the_clock(&now),
                but_the_clock(was),
                "`{}` changed when it was imported back",
                was.name
            );
        }
    }

    /// One profile as everything about it except when it was last written.
    fn but_the_clock(role: &Role) -> serde_json::Value {
        let mut said = serde_json::to_value(role).expect("a profile serialises");
        said.as_object_mut().expect("an object").remove("updatedAt");
        said
    }

    /// **An edit between the review and the accept refuses.**
    ///
    /// Somebody changes one of the profiles while the review is on screen, so
    /// the diff that was accepted is no longer the diff that would happen. The
    /// fingerprint is what catches it, before anything is opened — and the
    /// profile that was *not* edited is not written either, because the set is
    /// one unit.
    #[tokio::test]
    async fn an_edit_between_the_review_and_the_accept_refuses_rather_than_overwriting() {
        let (state, admin) = fixture().await;
        let designer = made(&state, &admin, &asked_for("Designer")).await;
        let engineer = made(&state, &admin, &asked_for("Engineer")).await;

        // `designer/` sorts first, so it is written before `engineer/` is
        // reached: a half-applied set would leave it changed.
        let files = vec![
            bundle("designer", "Designer"),
            bundle("engineer", "Engineer"),
        ];
        let plan = planned(&state, &admin, plan_for(files.clone())).await;
        assert!(plan.appliable);

        // Somebody edits the second one while the review is on screen.
        sqlx::query("UPDATE roles SET does = 'edited by somebody else', updated_at = updated_at + interval '1 second' WHERE id = $1")
            .bind(&engineer)
            .execute(state.db.pool())
            .await
            .unwrap();

        let before = every_row(&state).await;
        let no = accept(&state, &admin, plan_for(files), reviewing(&plan))
            .await
            .expect_err("an edited row is not overwritten blind");
        assert!(said(&no).contains("nothing was written"), "{}", said(&no));

        assert_eq!(
            before,
            every_row(&state).await,
            "a write survived the refusal"
        );
        let first = row(&state, &admin, &designer).await;
        assert_eq!(first.does, asked_for("Designer").does);
        assert_eq!(first.key, None, "the key adoption rolled back too");
    }

    /// **Nothing survives a refusal in the middle of the set.**
    ///
    /// The one test atomicity needs: a drop whose first bundle is written and
    /// whose second is refused *inside the transaction*, which is where the
    /// `&self.pool` trap bites. `architect/` sorts first and creates cleanly;
    /// `designer/` is then refused for a key already filed where it would go.
    /// With either write taking a connection of its own, the architect stays
    /// behind — half a library, from a drop that was refused.
    #[tokio::test]
    async fn nothing_survives_a_refusal_in_the_middle_of_the_set() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let shelf = state
            .access
            .create_directory(&me.org_id, "Platform", &me.id, &[])
            .await
            .unwrap();
        crate::roles::create_in(
            state.db.pool(),
            me.org_id.as_str(),
            me.id.as_str(),
            &me.slug,
            crate::roles::Filing {
                directory: Some(&shelf.slug),
                key: Some("designer"),
            },
            &asked_for("Design System"),
        )
        .await
        .unwrap();
        // A second row carrying the key, so the bundle is a question rather
        // than a match and the answer below can file a third one.
        keyed(&state, &admin, "Designer", "designer").await;

        let before = every_row(&state).await;
        let drop = ProfileDrop {
            files: vec![
                bundle("architect", "Architect"),
                DroppedFile {
                    path: "profiles/designer/PROFILE.md".into(),
                    text: "---\nname: Fresh Designer\ndoes: designs\ndirectory: Platform\n---\n\nHello.\n"
                        .into(),
                },
            ],
            answers: vec![import::CandidateAnswer {
                key: "designer".into(),
                answer: import::CandidateDecision::NewProfile,
            }],
        };
        let no = applied(&state, &admin, drop)
            .await
            .expect_err("the second bundle cannot be filed, so neither is");
        assert!(said(&no).contains("nothing was written"), "{}", said(&no));
        assert_eq!(
            before,
            every_row(&state).await,
            "the first profile of the drop survived a refusal of the second"
        );
        assert!(
            state
                .roles
                .by_name(me.id.as_str(), "Architect")
                .await
                .unwrap()
                .is_none(),
            "a half-imported library"
        );
    }

    /// **Leaving a blocked bundle out imports the rest**, which is what the
    /// banner's own button offers. The two that are left are the two that were
    /// reviewed, so they still match what was on screen.
    #[tokio::test]
    async fn excluding_a_blocked_bundle_imports_the_rest() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let broken = DroppedFile {
            path: "profiles/broken/PROFILE.md".into(),
            text: "Just some prose, and no frontmatter at all.\n".into(),
        };
        let good = vec![
            bundle("designer", "Designer"),
            bundle("engineer", "Engineer"),
        ];
        let mut all = good.clone();
        all.push(broken);

        let plan = planned(&state, &admin, plan_for(all)).await;
        assert!(!plan.appliable, "a blocked bundle stops the set");
        // What the screen sends after the person unticks it: the files of the
        // rows that are left, and the fingerprints of those rows.
        let kept: Vec<String> = plan
            .entries
            .iter()
            .filter(|e| !matches!(e.outcome, PlanOutcome::Blocked(_)))
            .map(|e| e.digest.clone())
            .collect();
        assert_eq!(kept.len(), 2);

        let done = accept(&state, &admin, plan_for(good), kept)
            .await
            .expect("the two that were reviewed import");
        assert_eq!(done.wrote.len(), 2);
        let library = state
            .roles
            .visible(me.id.as_str(), Level::Viewer)
            .await
            .unwrap();
        assert_eq!(library.len(), 2);
        assert!(!library.iter().any(|r| r.key.as_deref() == Some("broken")));
    }

    /// **Leaving out the bundle another one named is not a smaller import.**
    ///
    /// The manager's team no longer resolves, so what it would do has changed
    /// — and it is refused rather than written with a team it was never shown.
    #[tokio::test]
    async fn excluding_the_teammate_a_profile_names_refuses_rather_than_writing_it() {
        let (state, admin) = fixture().await;
        let manager = DroppedFile {
            path: "profiles/engineering-manager/PROFILE.md".into(),
            text: "---\nname: Engineering Manager\ndoes: runs delivery\ncan_delegate: true\n\
                   delegates_to:\n  - Designer\n---\n\nYou own delivery.\n"
                .into(),
        };
        let both = vec![manager.clone(), bundle("designer", "Designer")];
        let plan = planned(&state, &admin, plan_for(both)).await;
        assert!(plan.appliable, "the teammate is in the drop");
        let lead = plan
            .entries
            .iter()
            .find(|e| e.key == "engineering-manager")
            .unwrap();

        let before = every_row(&state).await;
        let no = accept(
            &state,
            &admin,
            plan_for(vec![manager]),
            vec![lead.digest.clone()],
        )
        .await
        .expect_err("its team came out of the drop with it");
        assert!(said(&no).contains("nothing was written"), "{}", said(&no));
        assert!(said(&no).contains("drop the folder again"), "{}", said(&no));
        assert_eq!(before, every_row(&state).await);
    }

    /// **Filing moves a path and leaves the timestamp alone**, so a check that
    /// rested on `updated_at` would have overwritten this one.
    #[tokio::test]
    async fn a_profile_filed_elsewhere_refuses_though_its_timestamp_never_moved() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let id = made(&state, &admin, &asked_for("Designer")).await;
        let files = vec![bundle("designer", "Designer")];
        let plan = planned(&state, &admin, plan_for(files.clone())).await;
        assert!(plan.appliable);

        let was = row(&state, &admin, &id).await;
        let shelf = state
            .access
            .create_directory(&me.org_id, "Platform", &me.id, &[])
            .await
            .unwrap();
        let from = state
            .access
            .path_of(crate::access::FiledKind::Role, &id)
            .await
            .unwrap()
            .unwrap();
        state
            .access
            .transfer(
                &state.vault,
                crate::access::FiledKind::Role,
                &id,
                &from.moved_to(ft_core::path::DIRECTORY, &shelf.slug),
                "admin",
            )
            .await
            .unwrap();

        let now = row(&state, &admin, &id).await;
        assert_ne!(now.path, was.path, "it moved");
        assert_eq!(now.updated_at, was.updated_at, "and the timestamp did not");

        let no = accept(&state, &admin, plan_for(files), reviewing(&plan))
            .await
            .expect_err("a plan about where it was is not a plan about where it is");
        assert!(
            said(&no).contains("has changed since it was reviewed"),
            "{}",
            said(&no)
        );
        assert_eq!(row(&state, &admin, &id).await.does, was.does);
    }

    /// **A deleted machine clears a pin through a foreign key**, which changes
    /// what the accepted diff meant while the timestamp stays put.
    #[tokio::test]
    async fn a_pin_cleared_by_a_deleted_machine_refuses_though_its_timestamp_never_moved() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let host = state
            .db
            .ensure_test_host("fire-01", me.id.as_str())
            .await
            .unwrap();
        let mut new = asked_for("Designer");
        new.machine = Some(host.id.as_str().to_string());
        new.placement = "new".into();
        let id = made(&state, &admin, &new).await;

        // The file leaves the machine to the lead, so the plan's diff reads
        // `fire-01` on the left — which is the value that is about to vanish.
        let files = vec![bundle("designer", "Designer")];
        let plan = planned(&state, &admin, plan_for(files.clone())).await;
        let PlanOutcome::Overwrite(over) = &plan.entries[0].outcome else {
            panic!("{:#?}", plan.entries[0].outcome)
        };
        let machine = over.diff.iter().find(|f| f.field == "machine").unwrap();
        assert_eq!(machine.before, "fire-01");
        assert_eq!(machine.change, FieldChange::Reset);

        let was = row(&state, &admin, &id).await;
        sqlx::query("DELETE FROM hosts WHERE id = $1")
            .bind(host.id.as_str())
            .execute(state.db.pool())
            .await
            .unwrap();
        let now = row(&state, &admin, &id).await;
        assert_eq!(now.machine, None, "the foreign key cleared the pin");
        assert_eq!(
            now.updated_at, was.updated_at,
            "and the timestamp did not move"
        );

        let no = accept(&state, &admin, plan_for(files), reviewing(&plan))
            .await
            .expect_err("the reset that was accepted is no longer the reset that would happen");
        assert!(
            said(&no).contains("has changed since it was reviewed"),
            "{}",
            said(&no)
        );
    }

    /// A fingerprint nobody produced is not a review.
    #[tokio::test]
    async fn an_accept_that_was_never_reviewed_writes_nothing() {
        let (state, admin) = fixture().await;
        let before = every_row(&state).await;
        let no = accept(
            &state,
            &admin,
            plan_for(vec![bundle("designer", "Designer")]),
            vec!["not a plan this server produced".to_string()],
        )
        .await
        .expect_err("an accept carries the plan it accepted");
        assert!(said(&no).contains("nothing was written"), "{}", said(&no));
        assert_eq!(before, every_row(&state).await);
    }

    /// **The High finding, asserted.** A caller who hands back an answer
    /// naming somebody else's profile overwrites nothing: the id is re-resolved
    /// against what *they* can see, and a profile they cannot see is not there.
    #[tokio::test]
    async fn an_answer_naming_a_profile_you_cannot_see_writes_nothing() {
        let (state, admin) = fixture().await;
        let ana = colleague(&state, "ana").await;
        let hers = made(&state, &ana, &asked_for("Designer")).await;
        let was = row(&state, &ana, &hers).await;

        let drop = ProfileDrop {
            files: vec![bundle("designer", "Her Designer")],
            answers: vec![import::CandidateAnswer {
                key: "designer".into(),
                answer: import::CandidateDecision::SameProfile {
                    profile: hers.clone(),
                },
            }],
        };
        // The plan says so first, in a sentence, and the apply refuses rather
        // than taking the id.
        let plan = planned(&state, &admin, drop.clone()).await;
        assert!(!plan.appliable);
        let no = accept(&state, &admin, drop, reviewing(&plan))
            .await
            .expect_err("an id from a plan is not a capability");
        assert!(said(&no).contains("nothing was written"), "{}", said(&no));

        let now = row(&state, &ana, &hers).await;
        assert_eq!(
            (&now.name, &now.does, &now.key),
            (&was.name, &was.does, &was.key)
        );
    }

    /// A profile somebody may read and not write is not overwritten by a
    /// bundle that matches its name.
    #[tokio::test]
    async fn a_profile_you_may_read_and_not_write_is_not_overwritten() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let ana = colleague(&state, "ana").await;
        let hers = whoever(&ana).unwrap();

        // Hers, filed where the administrator can look and not write.
        let shelf = state
            .access
            .create_directory(
                &hers.org_id,
                "Ana's shelf",
                &hers.id,
                &[crate::access::NewGrant {
                    subject_kind: crate::access::SubjectKind::Person,
                    subject_id: me.id.as_str().to_string(),
                    level: Level::Viewer,
                }],
            )
            .await
            .unwrap();
        let id = made(&state, &ana, &asked_for("Designer")).await;
        let from = state
            .access
            .path_of(crate::access::FiledKind::Role, &id)
            .await
            .unwrap()
            .unwrap();
        state
            .access
            .transfer(
                &state.vault,
                crate::access::FiledKind::Role,
                &id,
                &from.moved_to(ft_core::path::DIRECTORY, &shelf.slug),
                "ana",
            )
            .await
            .unwrap();

        let was = row(&state, &ana, &id).await;
        let before = every_row(&state).await;
        let no = applied(
            &state,
            &admin,
            plan_for(vec![bundle("designer", "Designer")]),
        )
        .await
        .expect_err("a profile you cannot write is not one you can import onto");
        assert!(said(&no).contains("nothing was written"), "{}", said(&no));
        assert_eq!(before, every_row(&state).await);
        assert_eq!(row(&state, &ana, &id).await.does, was.does);
    }

    /// **A key is one profile within one directory**, and this is the ticket
    /// that writes the first keys, so it owns the refusal. Reached through a
    /// candidate answered *a new profile*: two visible rows carry the key, so
    /// the bundle is a question rather than a match, and the answer files a
    /// third beside one of them.
    #[tokio::test]
    async fn a_key_already_filed_in_that_directory_refuses_and_names_the_profile() {
        let (state, admin) = fixture().await;
        let me = whoever(&admin).unwrap();
        let shelf = state
            .access
            .create_directory(&me.org_id, "Platform", &me.id, &[])
            .await
            .unwrap();

        // One `designer` on the shelf, and one of their own: two rows carrying
        // the key, which is what makes the bundle a candidate.
        crate::roles::create_in(
            state.db.pool(),
            me.org_id.as_str(),
            me.id.as_str(),
            &me.slug,
            crate::roles::Filing {
                directory: Some(&shelf.slug),
                key: Some("designer"),
            },
            &asked_for("Design System"),
        )
        .await
        .unwrap();
        keyed(&state, &admin, "Designer", "designer").await;

        let drop = ProfileDrop {
            files: vec![DroppedFile {
                path: "profiles/designer/PROFILE.md".into(),
                text:
                    "---\nname: Fresh Designer\ndoes: designs\ndirectory: Platform\n---\n\nHello.\n"
                        .into(),
            }],
            answers: vec![import::CandidateAnswer {
                key: "designer".into(),
                answer: import::CandidateDecision::NewProfile,
            }],
        };
        let before = every_row(&state).await;
        let no = applied(&state, &admin, drop)
            .await
            .expect_err("two profiles filed together cannot share a key");
        let says = said(&no);
        assert!(
            says.contains("design system"),
            "it names the profile: {says}"
        );
        assert!(says.contains("designer"), "and the key: {says}");
        assert!(says.contains("rename the folder"), "and what to do: {says}");
        assert!(
            !says.contains("roles_author_key"),
            "not a constraint: {says}"
        );
        assert_eq!(before, every_row(&state).await);
    }
}
