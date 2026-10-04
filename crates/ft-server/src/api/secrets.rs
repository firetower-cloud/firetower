//! What Firetower holds, and every time it was touched.
//!
//! Names and history are ordinary reads. A value comes back from exactly one
//! route, and that one writes to the access log before it answers — which is
//! the only thing standing between a stored token and a quiet copy of it.

use super::access::whoever;
use super::{ApiError, ApiResult, ErrorCode};
use crate::access::Level;
use crate::accounts::User;
use crate::auth::Principal;
use crate::vault::{Key, Vault};
use crate::{vault, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A credential Firetower holds. Its name, and nothing else.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeldSecret {
    /// `scope/name/owner`, which is how everything else addresses it.
    ///
    /// A secret has no id column: it is keyed by all three, because two people
    /// each authorizing GitHub as themselves is the point. So a screen that
    /// wants to file one or say who can reach it has to name the owner too —
    /// `scope/name` names a *set* of rows, and addressing it that way let
    /// somebody be named on everybody's at once.
    ///
    /// A handle, not a label. `mine` is what the screen says.
    pub id: String,
    pub scope: String,
    pub name: String,
    /// Yours rather than somebody else's or the install's. What the screen
    /// says, so it never has to show an account id.
    pub mine: bool,
    /// Where it is filed, so a screen can say who else can reach it and offer
    /// to file it elsewhere.
    ///
    /// Absent for an *attached* one — an agent account's credential, a
    /// repository's variable, the install's own. Those move with what they
    /// belong to and cannot be filed on their own.
    pub path: Option<String>,
}

/// One line of the access log.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AccessEntry {
    pub id: i64,
    pub scope: String,
    pub name: String,
    /// `Write`, `Read`, `Delete`, or `Failed`.
    pub action: String,
    /// What the credential was wanted for, in words.
    pub reason: String,
    pub at: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultView {
    /// Where the key that unlocks all of this lives — in words, never the key.
    pub root_key: String,
    pub held: Vec<HeldSecret>,
    pub access: Vec<AccessEntry>,
    /// Whether the log's chain of digests still holds end to end.
    pub intact: bool,
    /// The first entry that doesn't follow from the one before it, if any.
    pub broken_at: Option<i64>,
}

/// What is stored, and every time it was touched.
///
/// Names and history only. A value comes back from exactly one route, which is
/// `reveal_secret` below, and that one writes to the log before it answers.
#[utoipa::path(
    get, path = "/api/v1/secrets", tag = "secrets",
    responses((status = 200, body = VaultView)),
)]
pub(super) async fn list_secrets(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<VaultView>> {
    // Theirs, and whatever is filed where they may work. Somebody else's git
    // token is not something this screen has any business naming, let alone
    // revealing — and the install's own is nobody's to read, so it is here only
    // for an administrator.
    let me = whoever(&principal)?;
    let mine = me.id.as_str();
    let (intact, broken_at) = match state.vault.verify().await? {
        vault::Verification::Intact { .. } => (true, None),
        vault::Verification::Broken { at } => (false, Some(at)),
    };

    let mut held = state.vault.names_for(mine, Level::Viewer).await?;
    if me.role == "admin" {
        // The deployment's own: the SSH identity every worker is reached with,
        // the OAuth client this install registered. An administrator's, because
        // one of them opens every machine in the fleet.
        held.extend(
            state
                .vault
                .names()
                .await?
                .into_iter()
                .filter(|h| h.owner.is_empty()),
        );
    }

    Ok(Json(VaultView {
        root_key: state.key_source.to_string(),
        held: held
            .into_iter()
            .map(|held| HeldSecret {
                path: held.path.as_ref().map(|p| p.as_str().to_string()),
                id: format!("{}/{}/{}", held.scope, held.name, held.owner),
                scope: held.scope,
                name: held.name,
                // So the screen can say "yours" rather than showing an
                // account id nobody reads.
                mine: held.owner == mine,
            })
            .collect(),
        access: state
            .vault
            .access(100)
            .await?
            .into_iter()
            .filter(|a| a.owner == mine || (a.owner.is_empty() && me.role == "admin"))
            .map(|a| AccessEntry {
                id: a.id,
                scope: a.scope,
                name: a.name,
                action: a.action,
                reason: a.reason,
                at: a.at.to_rfc3339(),
            })
            .collect(),
        intact,
        broken_at,
    }))
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceSecret {
    /// What to store from now on. The previous value is not recoverable.
    pub value: String,
}

/// A value, on its way to a person who asked for it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevealedSecret {
    pub scope: String,
    pub name: String,
    pub value: String,
}

/// Whose row a screen means by a scope and a name.
///
/// A scope and a name do not identify a row — the owner is the third part of the
/// key, so two people can each authorize GitHub as themselves — and the request
/// carries no owner, so something has to choose. What chooses is who is asking:
/// their own first, then one filed where they may work, and the install's own
/// only for an administrator.
///
/// Returns an owner rather than a [`Key`] because the answer is a `String` the
/// caller has to keep alive; a `Key` borrows it.
///
/// **Never anybody else's.** A member asking for `git/github` gets their own or
/// nothing, which is what stops this route being a way to read a colleague's
/// token by guessing its name.
async fn whose(vault: &Vault, scope: &str, name: &str, me: &User) -> Result<String, ApiError> {
    if let Some(owner) = vault
        .owner_for(scope, name, me.id.as_str(), Level::Writer)
        .await?
    {
        return Ok(owner);
    }
    if me.role == "admin" && vault.holds(Key::shared(scope, name)).await? {
        return Ok(String::new());
    }
    Err(ApiError::not_found("secret"))
}

/// Which row a write means, and whether anything is there yet.
///
/// Same order as [`which`], because a write has to land on the row the next read
/// will find: yours if you have one, then the install's. A row that exists keeps
/// its owner — storing a personal copy over the install's own value would leave
/// the old one sitting there unread and unrotated. A name nothing holds yet
/// becomes yours, because a credential is a person's and two people adding
/// `git/github` have to be able to add different ones.
///
/// The `bool` is what the caller would otherwise ask for a third time: whether
/// this is a replacement or something new.
async fn which_to_store(
    vault: &Vault,
    scope: &str,
    name: &str,
    me: &User,
) -> Result<(String, bool), ApiError> {
    if let Some(owner) = vault
        .owner_for(scope, name, me.id.as_str(), Level::Writer)
        .await?
    {
        return Ok((owner, true));
    }
    if me.role == "admin" && vault.holds(Key::shared(scope, name)).await? {
        return Ok((String::new(), true));
    }
    Ok((me.id.as_str().to_string(), false))
}

/// A scope or a name somebody can type again tomorrow.
///
/// Only checked when a row is being created. Whatever is already stored is
/// addressed by the path exactly as it is, so a name from before this existed
/// can still be revealed, replaced and removed.
fn nameable(what: &str, value: &str) -> Result<(), ApiError> {
    let unusable = value.is_empty()
        || value.chars().count() > 128
        || value.chars().any(|c| c.is_whitespace() || c.is_control());
    if unusable {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            format!("a {what} is one word, 128 characters or less"),
        ));
    }
    Ok(())
}

/// Put a credential on screen.
///
/// A `POST` because it changes something: it writes a `Reveal` into the access
/// log, which is what makes this defensible at all. A `GET` would also sit in
/// browser history and proxy logs, which a credential shouldn't.
///
/// This is the one route that hands a stored value back, and it exists because
/// a credential you cannot inspect is one you cannot verify or copy elsewhere.
/// The cost is real: anything that can reach this API can read every token
/// here, and the log is what is left to notice it.
#[utoipa::path(
    post, path = "/api/v1/secrets/{scope}/{name}/reveal", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    responses((status = 200, body = RevealedSecret), (status = 404, body = ApiError)),
)]
pub(super) async fn reveal_secret(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((scope, name)): Path<(String, String)>,
) -> ApiResult<Json<RevealedSecret>> {
    let me = whoever(&principal)?;
    let owner = whose(&state.vault, &scope, &name, me).await?;

    let value = state
        .vault
        .reveal(
            Key::of(&scope, &name, &owner),
            "shown on the Secrets screen",
        )
        .await?
        .ok_or_else(|| ApiError::not_found("secret"))?;

    Ok(Json(RevealedSecret {
        scope,
        name,
        value: value.to_string(),
    }))
}

/// Store a credential, whether or not there is one under that name already.
///
/// A name nothing holds yet is created, because the Secrets screen offers to add
/// one and a button that refuses every name is not a feature. It used to refuse,
/// on the reasoning that what a credential is *for* is decided where it is used
/// — but that is an argument about which names are worth adding, and the answer
/// to it was a screen where adding did nothing at all.
///
/// A `PUT` rather than a `POST` to a collection because the path is the whole
/// identity: the scope and the name say which row, and sending the same value
/// twice leaves the same one credential.
#[utoipa::path(
    put, path = "/api/v1/secrets/{scope}/{name}", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    request_body = ReplaceSecret,
    responses((status = 204), (status = 400, body = ApiError)),
)]
pub(super) async fn replace_secret(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((scope, name)): Path<(String, String)>,
    Json(req): Json<ReplaceSecret>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let value = req.value.trim();
    if value.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "paste the value, or remove this credential instead",
        ));
    }

    let (owner, held) = which_to_store(&state.vault, &scope, &name, me).await?;
    if !held {
        nameable("scope", &scope)?;
        nameable("name", &name)?;
    }

    // The log is read by people, so it says which of the two happened rather
    // than one word covering both.
    let reason = if held {
        "replaced on the Secrets screen"
    } else {
        "added on the Secrets screen"
    };
    state
        .vault
        .put(Key::of(&scope, &name, &owner), value, reason)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Remove a credential.
///
/// Whatever used it goes back to having none — an agent shows as needing one
/// again, a git host shows as not authorized. The log entry stays.
#[utoipa::path(
    delete, path = "/api/v1/secrets/{scope}/{name}", tag = "secrets",
    params(
        ("scope" = String, Path, description = "Secret scope"),
        ("name" = String, Path, description = "Secret name"),
    ),
    responses((status = 204)),
)]
pub(super) async fn remove_secret(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((scope, name)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let me = whoever(&principal)?;
    let owner = whose(&state.vault, &scope, &name, me).await?;
    state
        .vault
        .forget(
            Key::of(&scope, &name, &owner),
            "removed on the Secrets screen",
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::Accounts;
    use crate::db::Db;
    use crate::vault::crypto::RootKey;
    use crate::vault::GIT;

    /// A vault over a database with people in it.
    ///
    /// Real rows rather than a bare pool, because resolving whose secret a scope
    /// and a name mean now goes through `users.slug` and the grant view — the
    /// thing being tested is which row is chosen, and that question does not
    /// exist without somebody to ask it for.
    async fn set_up() -> (Vault, Accounts, User) {
        let (db, _) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let admin = accounts.user_by_name("admin").await.unwrap().unwrap();
        let vault = Vault::new(db.pool().clone(), RootKey::generate());
        (vault, accounts, admin)
    }

    /// The bug this file was opened for: adding refused every name.
    ///
    /// `Add` on the Secrets screen sends the same `PUT` as `replace`, so a route
    /// that only accepted a name it already held meant the button could not
    /// work for the one thing it was there to do.
    #[tokio::test]
    async fn a_name_nothing_holds_is_created_as_your_own() {
        let (vault, _accounts, me) = set_up().await;

        let (owner, held) = which_to_store(&vault, "global", "STRIPE", &me)
            .await
            .unwrap();

        assert!(!held, "nothing is stored under that name yet");
        assert_eq!(owner, me.id.as_str());
    }

    /// Replacing the install's own value must not fork a personal copy.
    ///
    /// The next read resolves theirs first, so a second row would leave the
    /// original where it is, read by nobody and rotated by nobody.
    #[tokio::test]
    async fn an_existing_shared_row_is_replaced_where_it_is() {
        let (vault, _accounts, admin) = set_up().await;
        vault
            .put(Key::shared("repo:r_1", "DATABASE_URL"), "before", "setup")
            .await
            .unwrap();

        let (owner, held) = which_to_store(&vault, "repo:r_1", "DATABASE_URL", &admin)
            .await
            .unwrap();

        assert!(held);
        assert_eq!(owner, "", "the install's own row, not a copy of it");
    }

    /// Theirs wins over the install's, the same order `whose` reads in.
    #[tokio::test]
    async fn your_own_row_is_the_one_you_write_to() {
        let (vault, _accounts, me) = set_up().await;
        vault
            .put(Key::shared(GIT, "github"), "the install's", "setup")
            .await
            .unwrap();
        vault
            .put(Key::of(GIT, "github", me.id.as_str()), "hers", "setup")
            .await
            .unwrap();

        let (owner, held) = which_to_store(&vault, GIT, "github", &me).await.unwrap();

        assert!(held);
        assert_eq!(owner, me.id.as_str());
    }

    /// The install's own is an administrator's, and nobody else can even find it.
    ///
    /// It is not a credential somebody authorized — it is the deployment's, and
    /// one of them (`firetower/ssh-identity`) opens every machine in the fleet.
    /// A member asking for it by name gets their own row or nothing, which is
    /// what stops this route being a way to read one by guessing its name.
    #[tokio::test]
    async fn the_installs_own_row_is_not_a_members_to_find() {
        let (vault, accounts, _admin) = set_up().await;
        let org = ft_core::OrgId::from_stored(
            accounts
                .user_by_name("admin")
                .await
                .unwrap()
                .unwrap()
                .org_id
                .as_str()
                .to_string(),
        );
        let member = accounts
            .create_user(&org, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0;

        vault
            .put(Key::shared("global", "STRIPE"), "the install's", "setup")
            .await
            .unwrap();

        assert!(
            whose(&vault, "global", "STRIPE", &member).await.is_err(),
            "a member cannot reach the deployment's own credential"
        );

        // And a write under that name becomes theirs rather than landing on it.
        let (owner, held) = which_to_store(&vault, "global", "STRIPE", &member)
            .await
            .unwrap();
        assert!(!held);
        assert_eq!(owner, member.id.as_str());
    }

    /// What a new name may be. The scopes Firetower writes itself have to pass.
    #[test]
    fn a_name_has_to_be_typeable_again() {
        assert!(nameable("name", "STRIPE_SECRET_KEY").is_ok());
        assert!(nameable("scope", "repo:r_01k6m4").is_ok());
        assert!(nameable("scope", "global").is_ok());

        assert!(nameable("name", "").is_err());
        assert!(nameable("name", "TWO WORDS").is_err());
        assert!(nameable("name", "TRAILING ").is_err());
        assert!(nameable("name", "NEW\nLINE").is_err());
        assert!(nameable("name", &"N".repeat(129)).is_err());
    }
}
