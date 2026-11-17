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
use crate::roles::{NewRole, Role};
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

/// The key this row carries, which on this branch is always none.
///
/// **One function, so #355's column has exactly one place to be wired in.** It
/// adds a nullable `author_key` and reads it onto `Role::key`; this becomes
/// `role.key.as_deref()` and nothing else about export changes.
///
/// A seam rather than a `None` written at the call site, because the failure it
/// guards against is silent. `key_of` takes the stored key and falls back to
/// deriving one from the name — so a merge that brings the column in and
/// leaves the call site alone would keep deriving, keep exporting `QA` into
/// `qa/` rather than `qa-engineer/`, and turn every re-import into a duplicate
/// with nothing failing anywhere. `grep stored_key` finds the one line that
/// has to change.
fn stored_key(_role: &Role) -> Option<&str> {
    None
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::access::{NewGrant, SubjectKind};
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
}
