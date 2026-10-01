//! Who can sign in, and what being signed in consists of.
//!
//! One organisation and one administrator today. The shape is what matters:
//! every request resolves to a *user*, so the second of either is rows rather
//! than a redesign.
//!
//! **Passwords are argon2id.** Deliberately slow, with a random 16-byte salt
//! per password and the cost parameters encoded alongside it — which is what
//! lets those be raised later while every password already stored still
//! verifies under the parameters it was made with.
//!
//! **A signed-in browser is a row.** Not a self-contained token: signing out
//! has to actually end access, and "sign me out everywhere", which is what a
//! password change does, cannot be expressed by something the server does not
//! hold. What is stored is the hash of the token, never the token — anyone
//! with the value is the user, so the database keeps what lets it compare
//! rather than what lets it impersonate.

use anyhow::{bail, Context, Result};
use argon2::Argon2;
use ft_core::{OrgId, UserId};
use password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use serde::Serialize;
use sqlx::{PgPool, Row};
use utoipa::ToSchema;

/// How long a browser stays signed in without being used.
///
/// Long, because this is a tool someone leaves open for weeks, and short
/// enough that a laptop lost in a drawer eventually stops being a way in.
const SESSION_LIFETIME: chrono::Duration = chrono::Duration::days(30);

/// The minimum for a password somebody *chooses*.
///
/// Length only. Requiring a symbol and a digit produces `Passw0rd!` across a
/// whole company and nothing else.
///
/// Low on purpose. This is a tool people run for themselves, usually on a
/// machine only they can reach, and a rule that turns setting it up into an
/// argument is a rule that gets worked around. What actually keeps a Firetower
/// closed is that it is behind a proxy or on a private network, not the length
/// of this.
///
/// Deliberately not applied to the one seeded from the environment. That one is
/// temporary by construction, and enforcing it there meant a control plane that
/// would not start because of a short string in a file.
pub const MINIMUM_PASSWORD: usize = 5;

/// Someone who can sign in.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: UserId,
    pub org_id: OrgId,
    pub username: String,
    /// The label their own space is named with — the `kevin` in
    /// `u/kevin/ledger_rounding`.
    ///
    /// Sent because a client cannot otherwise tell whether a path it is looking
    /// at is *theirs*. "Is this mine" is the first half of "may I decide where
    /// this goes", and a client that has to guess gets it wrong in the generous
    /// direction: it offers a control that the server then refuses.
    ///
    /// Not the username. That is chosen by people and may yet become an email
    /// address; this is derived once and never changes, so renaming somebody
    /// never moves anything.
    pub slug: String,
    /// Where to write to them. Absent on accounts made before one was asked
    /// for, and never filled in with a guess: a placeholder address cannot be
    /// told apart from a real one that bounces.
    pub email: Option<String>,
    pub role: String,
    /// True while the password in use was chosen by somebody other than its
    /// owner: out of a file for the first administrator, and by an
    /// administrator for everybody invited or reset since.
    ///
    /// Nothing but replacing it is permitted until this clears, and replacing
    /// it is done on the control plane's own interface — the native clients
    /// read this to send people there rather than offering a form of their
    /// own.
    pub must_change_password: bool,
    /// Switched off by an administrator: cannot sign in, keeps what they made.
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: OrgId,
    pub name: String,
}

/// Everything account-shaped, over the control plane's pool.
#[derive(Clone)]
pub struct Accounts {
    pool: PgPool,
}

impl Accounts {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    // ── setting up ─────────────────────────────────────────────────────

    /// Whether anybody can sign in yet.
    pub async fn any_user(&self) -> Result<bool> {
        let row = sqlx::query("SELECT EXISTS (SELECT 1 FROM users) AS present")
            .fetch_one(&self.pool)
            .await
            .context("looking for a user")?;
        Ok(row.get::<bool, _>("present"))
    }

    /// The organisation, if setting up has finished.
    pub async fn organization(&self) -> Result<Option<Organization>> {
        // `named_at`, not merely the row: the installation is bound to its
        // organization from the first boot, because a host coming up has to
        // know which one it belongs to. Being *named* is the separate event,
        // and it is what "set up" means.
        let row = sqlx::query(
            "SELECT o.id, o.name FROM installation i JOIN organizations o ON o.id = i.org_id
             WHERE i.named_at IS NOT NULL",
        )
        .fetch_optional(&self.pool)
        .await
        .context("reading the organisation")?;

        Ok(row.map(|r| Organization {
            id: OrgId::from_stored(r.get::<String, _>("id")),
            name: r.get("name"),
        }))
    }

    /// Create the first administrator.
    ///
    /// The organisation comes with it, unnamed, because a user needs one to
    /// belong to and naming it is a question for whoever signs in. `installation`
    /// stays empty until they answer — that row is what "setting up is
    /// finished" means.
    ///
    /// Refuses if anyone already exists. Called once, at start-up, before the
    /// listener binds: there is deliberately no moment where this control plane
    /// is answering with no owner.
    pub async fn create_first_admin(&self, username: &str, password: &str) -> Result<User> {
        let username = username.trim();
        anyhow::ensure!(!username.is_empty(), "an administrator needs a username");
        anyhow::ensure!(!password.is_empty(), "an administrator needs a password");

        // No length required of this one, unlike a password somebody chooses.
        // It exists to be replaced — the account can do nothing else until it
        // is — and refusing to create it would mean refusing to start over a
        // value in a file, which helps nobody.

        let mut tx = self.pool.begin().await?;

        // Inside the transaction, so two processes starting together cannot
        // both find nobody and both insert.
        let taken: bool = sqlx::query("SELECT EXISTS (SELECT 1 FROM users) AS present")
            .fetch_one(&mut *tx)
            .await?
            .get("present");
        if taken {
            bail!("this Firetower already has a user");
        }

        let org_id = OrgId::new();
        sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, $2)")
            .bind(org_id.as_str())
            // Replaced in the wizard. Not left empty, so an interface that
            // renders it before then has something to render.
            .bind("Firetower")
            .execute(&mut *tx)
            .await?;

        let id = UserId::new();

        // The identity first. `users.id` references `principals`, and the slug
        // every path of theirs begins with lives there — so it is written
        // before the account rather than patched onto it afterwards.
        let slug = crate::access::Access::provision_principal(
            &mut tx,
            &org_id,
            id.as_str(),
            crate::access::SubjectKind::Person,
            username,
        )
        .await?;

        sqlx::query(
            "INSERT INTO users (id, org_id, username, password_hash, role,
                                must_change_password)
             VALUES ($1, $2, $3, $4, 'admin', TRUE)",
        )
        .bind(id.as_str())
        .bind(org_id.as_str())
        .bind(username)
        .bind(hash_password(password)?)
        .execute(&mut *tx)
        .await?;

        // Bound to its organization now rather than at the end of the wizard.
        // A host registering itself at boot has to know which organization it
        // belongs to, and that happens long before anybody has named one.
        sqlx::query("INSERT INTO installation (org_id) VALUES ($1)")
            .bind(org_id.as_str())
            .execute(&mut *tx)
            .await?;

        // The team that is everybody and the directory they share, then this
        // person's own label. In the same transaction as the organisation
        // because an organisation without them cannot say "all of us" and has
        // nowhere to share anything — a first boot that got halfway would leave
        // a Firetower that looks set up and cannot share any work.
        crate::access::Access::provision_organization(&mut tx, &org_id).await?;

        tx.commit().await?;

        Ok(User {
            id,
            org_id,
            username: username.to_string(),
            slug,
            // Made at first boot, before there is anybody to ask. They add one
            // on the People screen, where the prompt is waiting.
            email: None,
            role: "admin".into(),
            must_change_password: true,
            disabled: false,
        })
    }

    // ── the organisation, and who is in it ─────────────────────────────

    /// Rename the organisation. Setting up is not involved: that was `finish_setup`, once.
    pub async fn rename_organization(&self, org: &OrgId, name: &str) -> Result<Organization> {
        let name = name.trim();
        anyhow::ensure!(!name.is_empty(), "an organisation needs a name");
        anyhow::ensure!(name.chars().count() <= 80, "that name is too long");
        sqlx::query("UPDATE organizations SET name = $1 WHERE id = $2")
            .bind(name)
            .bind(org.as_str())
            .execute(&self.pool)
            .await?;
        Ok(Organization {
            id: org.clone(),
            name: name.to_string(),
        })
    }

    /// Everyone in the organisation, administrators first, then by name.
    pub async fn users_of(&self, org: &OrgId) -> Result<Vec<User>> {
        let rows = sqlx::query(
            "SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.org_id = $1
             ORDER BY (role = 'admin') DESC, lower(username)",
        )
        .bind(org.as_str())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(user_from_row).collect())
    }

    /// How many administrators could still sign in, for the checks below.
    async fn active_admins(tx: &mut sqlx::PgConnection, org: &OrgId) -> Result<i64> {
        Ok(sqlx::query(
            "SELECT count(*) AS n FROM users WHERE org_id = $1 AND role = 'admin' AND NOT disabled",
        )
        .bind(org.as_str())
        .fetch_one(tx)
        .await?
        .get("n"))
    }

    /// A new member or administrator, with a password made here and said
    /// once. They have to replace it the first time they sign in, so the
    /// administrator who passed it on is not left holding a working one.
    pub async fn create_user(
        &self,
        org: &OrgId,
        username: &str,
        email: &str,
        role: &str,
    ) -> Result<(User, String)> {
        let username = username.trim();
        anyhow::ensure!(!username.is_empty(), "a user needs a username");
        anyhow::ensure!(username.chars().count() <= 64, "that username is too long");
        anyhow::ensure!(
            username
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')),
            "a username is letters, digits, and . _ - @"
        );
        anyhow::ensure!(
            matches!(role, "admin" | "member"),
            "a role is admin or member"
        );

        // Shaped, not validated. Anything stricter rejects addresses that work
        // — plus signs, dots, new top-level domains — and the only test that
        // settles it is sending a message, which this installation may not yet
        // be able to do.
        let email = email.trim();
        anyhow::ensure!(!email.is_empty(), "a person needs an email address");
        anyhow::ensure!(email.chars().count() <= 254, "that address is too long");
        anyhow::ensure!(
            email.split_once('@').is_some_and(|(before, after)| {
                !before.is_empty() && after.contains('.') && !after.starts_with('.')
            }),
            "that does not look like an email address"
        );
        let password = temporary_password();
        let id = UserId::new();

        // One transaction for the account and the label its paths are built
        // from. Separately, a failure between them leaves somebody who can sign
        // in and whose own space is named after their id — and nothing would
        // ever retry it.
        let mut tx = self.pool.begin().await?;
        let slug = crate::access::Access::provision_principal(
            &mut tx,
            org,
            id.as_str(),
            crate::access::SubjectKind::Person,
            username,
        )
        .await?;

        let done = sqlx::query(
            "INSERT INTO users (id, org_id, username, email, password_hash, role,
                                must_change_password)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE)
             ON CONFLICT (org_id, username) DO NOTHING",
        )
        .bind(id.as_str())
        .bind(org.as_str())
        .bind(username)
        .bind(email)
        .bind(hash_password(&password)?)
        .bind(role)
        .execute(&mut *tx)
        .await;

        // Two ways to already exist, and they are different sentences. The
        // username collision is the `DO NOTHING` above; the address is a unique
        // index, and a database error nobody translates reads as "that didn't
        // work" to the person who typed it.
        let done = match done {
            Err(e) if is_duplicate_email(&e) => {
                bail!("{email} is already somebody's here")
            }
            other => other?,
        };
        if done.rows_affected() == 0 {
            bail!("there is already a user called {username}");
        }
        tx.commit().await?;

        Ok((
            User {
                id,
                org_id: org.clone(),
                username: username.to_string(),
                slug,
                email: Some(email.to_string()),
                role: role.to_string(),
                must_change_password: true,
                disabled: false,
            },
            password,
        ))
    }

    /// Admin or member. The last administrator cannot be made a member —
    /// an organisation nobody can administer is a locked room.
    /// Give somebody an address, or change the one they have.
    ///
    /// The same checks `create_user` makes, because an address added later is
    /// the same thing as one added at the start. The only difference is that
    /// nobody was asked for it at the time.
    pub async fn set_email(&self, id: &UserId, email: &str) -> Result<User> {
        let email = email.trim();
        anyhow::ensure!(!email.is_empty(), "a person needs an email address");
        anyhow::ensure!(email.chars().count() <= 254, "that address is too long");
        anyhow::ensure!(
            email.split_once('@').is_some_and(|(before, after)| {
                !before.is_empty() && after.contains('.') && !after.starts_with('.')
            }),
            "that does not look like an email address"
        );

        let row = sqlx::query(
            "UPDATE users u SET email = $2 FROM principals p
              WHERE p.id = u.id AND u.id = $1
          RETURNING u.*, p.slug",
        )
        .bind(id.as_str())
        .bind(email)
        .fetch_optional(&self.pool)
        .await;
        match row {
            Err(e) if is_duplicate_email(&e) => bail!("{email} is already somebody's here"),
            other => other?
                .map(user_from_row)
                .context("there is nobody here with that id"),
        }
    }

    pub async fn set_role(&self, id: &UserId, role: &str) -> Result<User> {
        anyhow::ensure!(
            matches!(role, "admin" | "member"),
            "a role is admin or member"
        );
        let mut tx = self.pool.begin().await?;
        let user = sqlx::query("SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.id = $1 FOR UPDATE OF u")
            .bind(id.as_str())
            .fetch_optional(&mut *tx)
            .await?
            .map(user_from_row)
            .context("no such user")?;
        if user.role == "admin"
            && role != "admin"
            && Self::active_admins(&mut tx, &user.org_id).await? <= 1
        {
            bail!("{} is the only administrator", user.username);
        }
        sqlx::query("UPDATE users SET role = $1 WHERE id = $2")
            .bind(role)
            .bind(id.as_str())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(User {
            role: role.to_string(),
            ..user
        })
    }

    /// Switch a user off or back on. Off ends their sessions at once; what
    /// they made stays theirs. The last administrator cannot be switched off.
    pub async fn set_disabled(&self, id: &UserId, disabled: bool) -> Result<User> {
        let mut tx = self.pool.begin().await?;
        let user = sqlx::query("SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.id = $1 FOR UPDATE OF u")
            .bind(id.as_str())
            .fetch_optional(&mut *tx)
            .await?
            .map(user_from_row)
            .context("no such user")?;
        if disabled
            && user.role == "admin"
            && !user.disabled
            && Self::active_admins(&mut tx, &user.org_id).await? <= 1
        {
            bail!("{} is the only administrator", user.username);
        }
        sqlx::query("UPDATE users SET disabled = $1 WHERE id = $2")
            .bind(disabled)
            .bind(id.as_str())
            .execute(&mut *tx)
            .await?;
        if disabled {
            sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
                .bind(id.as_str())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(User { disabled, ..user })
    }

    /// A new temporary password, said once; every session of theirs ends and
    /// the next sign-in has to replace it.
    pub async fn reset_password(&self, id: &UserId) -> Result<String> {
        let password = temporary_password();
        let mut tx = self.pool.begin().await?;
        let done = sqlx::query(
            "UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2",
        )
        .bind(hash_password(&password)?)
        .bind(id.as_str())
        .execute(&mut *tx)
        .await?;
        if done.rows_affected() == 0 {
            bail!("no such user");
        }
        sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(password)
    }

    /// Gone for good, with everything filed in their own space.
    ///
    /// Most of it the database cascades. What it cannot is dealt with below, and
    /// the reason is the one thing to know here: a slug is freed when its row
    /// goes, so anything left at `u/<their slug>` would be handed to the next
    /// person who slugs the same way.
    ///
    /// Refused for the last administrator.
    pub async fn delete_user(&self, id: &UserId) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        self.delete_user_in(&mut tx, id).await?;
        tx.commit().await?;
        Ok(())
    }

    /// The same, inside somebody else's transaction.
    ///
    /// Offboarding hands things over first and removes the account second, and
    /// a failure between the two would leave somebody's work transferred to a
    /// colleague and the account still able to sign in — or, worse, the account
    /// gone and half its work still at a root nobody can reach.
    pub async fn delete_user_in(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        id: &UserId,
    ) -> Result<()> {
        let user = sqlx::query("SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.id = $1 FOR UPDATE OF u")
            .bind(id.as_str())
            .fetch_optional(&mut **tx)
            .await?
            .map(user_from_row)
            .context("no such user")?;
        if user.role == "admin"
            && !user.disabled
            && Self::active_admins(tx, &user.org_id).await? <= 1
        {
            bail!("{} is the only administrator", user.username);
        }
        // Their grants go with them. `grants.subject_id` names a user or a
        // team depending on the row, so it carries no foreign key and the
        // database cannot cascade this — which left a grant naming somebody who
        // no longer exists. It resolved to no access, because `directory_access`
        // joins `users`, so nothing was reachable by it; what it did do was
        // appear on the list of who can see a directory, as a row with no name.
        sqlx::query("DELETE FROM grants WHERE subject_kind = 'person' AND subject_id = $1")
            .bind(id.as_str())
            .execute(&mut **tx)
            .await?;

        // What is still filed at `u/<their slug>` has to leave with them, and
        // this is why.
        //
        // Their workspaces and subscriptions cascade — those rows carry
        // `user_id`. Two kinds do not: a **machine** belongs to the
        // organisation and a `created_by` that goes null does not move it, and a
        // **secret** is keyed by an owner with no foreign key on it (the
        // install's own owner is the empty string, which a null could not be).
        //
        // Left alone, both would sit at a root nobody can reach — and the slug
        // is freed the moment the row goes, so the next person called `ana`
        // would be given `u/ana` and inherit whatever was still under it. That
        // is the failure: not an orphan, but somebody else's machine and
        // somebody else's tokens quietly becoming a new colleague's.
        //
        // A machine goes to the shared directory, because compute is real and
        // the organisation is still running on it. A secret goes, because it was
        // that person's credential, nothing else can open it, and keeping it
        // would be keeping a token nobody can rotate.
        // Twice, and the second one is why this cannot fail: `hosts_path_unique`
        // would refuse `d.shared.fire_01` if something were already filed there,
        // and a delete that dies on a name collision is a person nobody can
        // remove. The first pass takes the readable path where it is free; the
        // second takes whatever is left and puts the machine's own id on the end,
        // which nothing can collide with.
        //
        // This becomes the fallback rather than the rule once offboarding lands:
        // an administrator reassigns what should survive, and whatever they
        // leave takes this route.
        // Deleted, not handed to the organisation.
        //
        // These used to be swept into `d/shared`, on the grounds that compute is
        // real and somebody is still running on it. That is an unconsented
        // transfer of something personal, and the rule is that what is at
        // `u/<them>/…` is theirs: an administrator may destroy it along with the
        // account, and may never pass it to anybody else. The machine itself is
        // untouched — this is a row, and whoever wants it back adds it again.
        sqlx::query(
            "DELETE FROM hosts
              WHERE path <@ ('u.' || (SELECT slug FROM principals WHERE id = $1))::ltree",
        )
        .bind(id.as_str())
        .execute(&mut **tx)
        .await
        .context("removing the machines that were theirs")?;

        sqlx::query(
            "DELETE FROM secrets
              WHERE owner = $1
                 OR path <@ ('u.' || (SELECT slug FROM principals WHERE id = $1))::ltree",
        )
        .bind(id.as_str())
        .execute(&mut **tx)
        .await
        .context("removing their credentials")?;

        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(id.as_str())
            .execute(&mut **tx)
            .await?;

        // The account goes; the identity stays, retired. That row is what keeps
        // `kevin` from ever being issued again — so an exception somebody wrote
        // on their own workspace, `{"u/kevin": "writer"}`, can never land on a
        // new colleague who happens to have the same name. Sweeping those
        // entries is hygiene; this is the guarantee.
        crate::access::Access::forget_exceptions(tx, &format!("u/{}", user.slug)).await?;
        crate::access::Access::retire_principal(tx, id.as_str()).await?;

        Ok(())
    }

    /// Name the organisation and mark setting up as finished.
    ///
    /// The `installation` row is a table whose primary key can hold one value,
    /// so a second attempt fails in Postgres rather than in a check we wrote.
    pub async fn finish_setup(&self, org: &OrgId, name: &str) -> Result<Organization> {
        let name = name.trim();
        anyhow::ensure!(!name.is_empty(), "an organisation needs a name");

        let mut tx = self.pool.begin().await?;

        sqlx::query("UPDATE organizations SET name = $1 WHERE id = $2")
            .bind(name)
            .bind(org.as_str())
            .execute(&mut *tx)
            .await?;

        // Exactly once, decided by the database rather than by a check we
        // wrote: two requests arriving together, only one updates a row.
        let claimed = sqlx::query(
            "UPDATE installation SET named_at = now() WHERE org_id = $1 AND named_at IS NULL",
        )
        .bind(org.as_str())
        .execute(&mut *tx)
        .await
        .context("finishing setup")?;

        if claimed.rows_affected() == 0 {
            bail!("this Firetower has already been set up")
        }

        tx.commit().await?;

        Ok(Organization {
            id: org.clone(),
            name: name.to_string(),
        })
    }

    // ── signing in ─────────────────────────────────────────────────────

    pub async fn user_by_name(&self, username: &str) -> Result<Option<User>> {
        let row = sqlx::query("SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.username = $1")
            .bind(username.trim())
            .fetch_optional(&self.pool)
            .await
            .context("looking up a user")?;
        Ok(row.map(user_from_row))
    }

    pub async fn user_by_id(&self, id: &UserId) -> Result<Option<User>> {
        let row = sqlx::query(
            "SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.id = $1",
        )
        .bind(id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(user_from_row))
    }

    /// The password, checked.
    ///
    /// Returns the user or nothing — never *why* not. "No such user" and "wrong
    /// password" are the same answer to whoever is asking, because the
    /// difference is how you learn which usernames exist.
    pub async fn authenticate(&self, username: &str, password: &str) -> Result<Option<User>> {
        let row = sqlx::query("SELECT u.*, p.slug FROM users u JOIN principals p ON p.id = u.id WHERE u.username = $1")
            .bind(username.trim())
            .fetch_optional(&self.pool)
            .await?;

        let Some(row) = row else {
            // Hash anyway. Answering a missing username faster than a wrong
            // password is how an unauthenticated caller enumerates accounts
            // with a stopwatch.
            let _ = hash_password("a password that is not anybody's");
            return Ok(None);
        };

        let stored: String = row.get("password_hash");
        if !verify_password(password, &stored)? {
            return Ok(None);
        }
        let user = user_from_row(row);
        // Switched off reads as a wrong password from outside, for the same
        // reason a missing username does: nothing to enumerate.
        if user.disabled {
            return Ok(None);
        }
        Ok(Some(user))
    }

    /// Replace a password, and sign every *other* browser out.
    ///
    /// A password is changed because the old one may be known, so the sessions
    /// it opened have to go. Every one of them, including the caller's — and
    /// then a fresh session is issued for whoever asked, and returned.
    ///
    /// Which is not the same as sparing theirs. The old token dies too, so a
    /// stolen one is no more use after this than a stolen password. What the
    /// caller gets back is new.
    ///
    /// Doing it any other way meant the first step of setting up threw you out
    /// halfway through it, which is how this was found.
    pub async fn set_password(&self, id: &UserId, password: &str) -> Result<String> {
        check_password(password)?;

        let mut tx = self.pool.begin().await?;

        sqlx::query(
            "UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2",
        )
        .bind(hash_password(password)?)
        .bind(id.as_str())
        .execute(&mut *tx)
        .await?;

        sqlx::query("DELETE FROM user_sessions WHERE user_id = $1")
            .bind(id.as_str())
            .execute(&mut *tx)
            .await?;

        // In the same transaction: a password that changed without leaving the
        // person who changed it a way back in is the failure this replaced.
        let token = mint_token();
        sqlx::query(
            "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)",
        )
        .bind(fingerprint(&token))
        .bind(id.as_str())
        .bind(chrono::Utc::now() + SESSION_LIFETIME)
        .execute(&mut *tx)
        .await?;

        tx.commit().await?;
        Ok(token)
    }

    // ── being signed in ────────────────────────────────────────────────

    /// Start a session and hand back the token. Said once; only its hash is
    /// kept.
    pub async fn open_session(&self, user: &UserId) -> Result<String> {
        let token = mint_token();

        sqlx::query(
            "INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,$3)",
        )
        .bind(fingerprint(&token))
        .bind(user.as_str())
        .bind(chrono::Utc::now() + SESSION_LIFETIME)
        .execute(&self.pool)
        .await
        .context("opening a session")?;

        Ok(token)
    }

    /// Who this token belongs to, if it is still good.
    ///
    /// Slides the expiry forward: a tool someone uses every day should not sign
    /// them out on a schedule that started the first time they signed in.
    pub async fn session_user(&self, token: &str) -> Result<Option<User>> {
        let hash = fingerprint(token);

        let row = sqlx::query(
            "UPDATE user_sessions
                SET last_seen_at = now(), expires_at = $2
              WHERE token_hash = $1 AND expires_at > now()
          RETURNING user_id",
        )
        .bind(&hash)
        .bind(chrono::Utc::now() + SESSION_LIFETIME)
        .fetch_optional(&self.pool)
        .await
        .context("checking a session")?;

        let Some(row) = row else {
            return Ok(None);
        };

        // Switched off since this token was last checked: the sessions went
        // then, but belt and braces.
        Ok(self
            .user_by_id(&UserId::from_stored(row.get::<String, _>("user_id")))
            .await?
            .filter(|u| !u.disabled))
    }

    pub async fn close_session(&self, token: &str) -> Result<()> {
        sqlx::query("DELETE FROM user_sessions WHERE token_hash = $1")
            .bind(fingerprint(token))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Clear out what has expired. Nothing depends on this being prompt — an
    /// expired row is already refused — so it is housekeeping, not a deadline.
    pub async fn sweep_sessions(&self) -> Result<u64> {
        let done = sqlx::query("DELETE FROM user_sessions WHERE expires_at < now()")
            .execute(&self.pool)
            .await?;
        Ok(done.rows_affected())
    }

    // ── settings ───────────────────────────────────────────────────────

    /// Whether somebody has been through onboarding.
    ///
    /// Separate from `installation`, which is written when the organisation is
    /// named — that happens partway through, and the steps after it are
    /// skippable. This records reaching the end, however much was skipped on
    /// the way, so a finished onboarding stays finished.
    pub const ONBOARDED: &'static str = "setup.completed";

    pub async fn onboarded(&self) -> Result<bool> {
        Ok(self.setting(Self::ONBOARDED).await?.is_some())
    }

    pub async fn mark_onboarded(&self) -> Result<()> {
        self.set_setting(Self::ONBOARDED, &chrono::Utc::now().to_rfc3339())
            .await
    }

    pub async fn setting(&self, key: &str) -> Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM settings WHERE key = $1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get::<String, _>("value")))
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
        )
        .bind(key)
        .bind(value.trim())
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn user_from_row(r: sqlx::postgres::PgRow) -> User {
    User {
        id: UserId::from_stored(r.get::<String, _>("id")),
        org_id: OrgId::from_stored(r.get::<String, _>("org_id")),
        username: r.get("username"),
        slug: r.get("slug"),
        email: r.try_get("email").ok().flatten(),
        role: r.get("role"),
        must_change_password: r.get("must_change_password"),
        disabled: r.try_get("disabled").unwrap_or(false),
    }
}

/// Whether a database error is the email index refusing a second copy.
fn is_duplicate_email(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .and_then(|d| d.constraint())
        .is_some_and(|c| c == "users_by_email")
}

/// A password for somebody else to replace: long, from the same alphabet as a
/// token, readable enough to be passed on by hand.
fn temporary_password() -> String {
    mint_token().chars().take(20).collect()
}

/// Long enough to be worth having, with nothing else asked of it.
///
/// For passwords a person picks: the wizard, and `firetower passwd`. What the
/// environment seeds is exempt — see [`MINIMUM_PASSWORD`].
pub fn check_password(password: &str) -> Result<()> {
    anyhow::ensure!(
        password.chars().count() >= MINIMUM_PASSWORD,
        "a password needs at least {MINIMUM_PASSWORD} characters"
    );
    Ok(())
}

/// argon2id, with a random salt this generates and stores in the result.
pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hashing a password: {e}"))
}

pub fn verify_password(password: &str, stored: &str) -> Result<bool> {
    let parsed =
        PasswordHash::new(stored).map_err(|e| anyhow::anyhow!("reading a stored password: {e}"))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok())
}

/// 32 bytes of OS randomness, in the alphabet that survives a URL.
fn mint_token() -> String {
    use password_hash::rand_core::RngCore;

    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);

    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    bytes
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

/// SHA-256, hex. What is stored for a session token.
///
/// No salt and no work factor: this is 32 bytes of randomness rather than
/// something a person chose, so there is no dictionary to run and nothing a
/// slow hash would buy.
fn fingerprint(token: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    async fn accounts() -> Accounts {
        let db = Db::open_for_test().await.unwrap();
        Accounts::new(db.pool().clone())
    }

    /// The invariant `principals` exists for.
    ///
    /// An exception written on somebody else's workspace — `{"u/ana": "writer"}`
    /// — outlives Ana entirely, because nothing in the database can reach into a
    /// JSON blob to clean it up. If her slug were reissued, the next Ana would
    /// inherit a stranger's access silently, and the workspace's owner would see
    /// nothing change. The retired principal is what makes that impossible.
    /// One mailbox, one account, whatever the capitalisation.
    ///
    /// `Kevin@westlabs.com` and `kevin@westlabs.com` are the same inbox, and
    /// somebody signing up twice by shifting a key is a support ticket nobody
    /// should have to answer.
    #[tokio::test]
    async fn an_address_belongs_to_one_person() {
        let (db, _admin) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let org = OrgId::from_stored(db.org().await.unwrap());

        accounts
            .create_user(&org, "ana", "ana@westlabs.com", "member")
            .await
            .unwrap();

        let refused = accounts
            .create_user(&org, "ana2", "Ana@Westlabs.com", "member")
            .await
            .expect_err("the same mailbox, shouted");
        assert!(
            refused.to_string().contains("already somebody's"),
            "{refused}"
        );

        // And an address is still optional for whoever was here first.
        let first = accounts.user_by_name("admin").await.unwrap().unwrap();
        assert!(first.email.is_none(), "nothing was invented for them");

        let now = accounts
            .set_email(&first.id, "  kevin@westlabs.com ")
            .await
            .unwrap();
        assert_eq!(now.email.as_deref(), Some("kevin@westlabs.com"), "trimmed");

        let refused = accounts
            .set_email(&first.id, "not-an-address")
            .await
            .expect_err("shaped like nothing");
        assert!(refused.to_string().contains("email address"), "{refused}");
    }

    #[tokio::test]
    async fn a_slug_is_never_issued_twice() {
        let (db, _admin) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let org = OrgId::from_stored(db.org().await.unwrap());

        let first = accounts
            .create_user(&org, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0;
        assert_eq!(first.slug, "ana");

        accounts.delete_user(&first.id).await.unwrap();

        // The account is gone; the identity is not.
        assert!(accounts.user_by_name("ana").await.unwrap().is_none());
        let retired: (String, Option<chrono::DateTime<chrono::Utc>>) =
            sqlx::query_as("SELECT slug, retired_at FROM principals WHERE id = $1")
                .bind(first.id.as_str())
                .fetch_one(db.pool())
                .await
                .unwrap();
        assert_eq!(retired.0, "ana");
        assert!(retired.1.is_some(), "retired, not deleted");

        // So the next Ana is a different person, and is named like one.
        let second = accounts
            .create_user(&org, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0;
        assert_eq!(second.slug, "ana_2");
        assert_ne!(second.id.as_str(), first.id.as_str());
    }

    /// A grant naming somebody who has left resolves to nothing rather than to
    /// access — the row survives, because it references a principal, but they
    /// have no `users` row for `directory_access` to join.
    #[tokio::test]
    async fn a_grant_to_somebody_who_left_reaches_nothing() {
        let (db, admin) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let access = crate::access::Access::new(db.pool().clone());
        let org = OrgId::from_stored(db.org().await.unwrap());
        let admin = UserId::from_stored(admin);

        let ana = accounts
            .create_user(&org, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0;
        let shelf = access
            .create_directory(&org, "Shelf", &admin, &[])
            .await
            .unwrap();
        access
            .set_grant(
                shelf.id.as_str(),
                crate::access::SubjectKind::Person,
                ana.id.as_str(),
                crate::access::Level::Writer,
                &admin,
            )
            .await
            .unwrap();
        assert!(access
            .level_on(ana.id.as_str(), shelf.id.as_str())
            .await
            .unwrap()
            .is_some());

        accounts.delete_user(&ana.id).await.unwrap();

        assert_eq!(
            access
                .level_on(ana.id.as_str(), shelf.id.as_str())
                .await
                .unwrap(),
            None,
            "the identity survives; the access does not"
        );
    }

    /// A slug is freed when its row goes, so anything still filed at
    /// `u/<their slug>` would be handed to the next person who slugs the same
    /// way. This is the test for the sweep that stops that.
    #[tokio::test]
    async fn nothing_is_left_behind_at_a_deleted_persons_root() {
        let (db, admin) = Db::open_for_test_owned().await.unwrap();
        let accounts = Accounts::new(db.pool().clone());
        let org = OrgId::from_stored(db.org().await.unwrap());
        let ana = accounts
            .create_user(&org, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0
            .id;

        // A machine she added, and a credential she authorized.
        let host = db
            .ensure_host("fire-01", ft_core::Compute::Local, ana.as_str())
            .await
            .unwrap();
        assert_eq!(host.path.as_str(), "u/ana/fire_01");
        let vault =
            crate::vault::Vault::new(db.pool().clone(), crate::vault::crypto::RootKey::generate());
        vault
            .put(
                crate::vault::Key::of(crate::vault::GIT, "github", ana.as_str()),
                "a-token",
                "test setup",
            )
            .await
            .unwrap();

        accounts.delete_user(&ana).await.unwrap();

        // The machine was at her own root, so it goes with her. It used to be
        // swept into `d/shared` on the grounds that compute is real — but that
        // is handing something personal to the organisation without asking,
        // and what is at `u/<them>/…` is theirs. The server itself is
        // untouched; this is a row, and whoever wants it back adds it again.
        assert!(db.host_by_name("fire-01").await.unwrap().is_none());

        // Her token goes. Nothing else can open it, and a credential nobody can
        // rotate is worse than no credential.
        assert!(!vault
            .holds(crate::vault::Key::of(
                crate::vault::GIT,
                "github",
                ana.as_str()
            ))
            .await
            .unwrap());

        // And the next `ana` inherits nothing, which is the whole point.
        let again = accounts
            .create_user(&org, "ana", "ana@example.test", "member")
            .await
            .unwrap()
            .0
            .id;
        assert!(db
            .hosts_for(again.as_str(), crate::access::Level::Viewer)
            .await
            .unwrap()
            .iter()
            .all(|h| h.path.as_str() != "u/ana/fire_01"));
        drop(admin);
    }

    #[test]
    fn a_password_is_salted_so_the_same_one_hashes_differently() {
        let once = hash_password("correct horse battery").unwrap();
        let twice = hash_password("correct horse battery").unwrap();

        assert_ne!(once, twice, "two identical passwords must not collide");
        assert!(once.starts_with("$argon2id$"), "{once}");
        assert!(verify_password("correct horse battery", &once).unwrap());
        assert!(verify_password("correct horse battery", &twice).unwrap());
        assert!(!verify_password("something else entirely", &once).unwrap());
    }

    #[test]
    fn short_passwords_are_refused() {
        assert!(check_password("four").is_err());
        assert!(check_password("short").is_ok(), "five is the minimum");
    }

    #[tokio::test]
    async fn the_first_administrator_can_only_be_created_once() {
        let accounts = accounts().await;
        assert!(!accounts.any_user().await.unwrap());

        let admin = accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        assert!(
            admin.must_change_password,
            "it came from a file, not a person"
        );
        assert!(accounts.any_user().await.unwrap());

        assert!(
            accounts
                .create_first_admin("someone-else", "another long password")
                .await
                .is_err(),
            "a second one would be a way in nobody asked for"
        );
    }

    /// A short one from the environment is allowed, because it is temporary by
    /// construction — and a control plane that will not start because of a
    /// string in a file is a worse failure than the weak password itself.
    #[tokio::test]
    async fn a_seeded_password_may_be_short_but_a_chosen_one_may_not() {
        let accounts = accounts().await;

        let admin = accounts.create_first_admin("admin", "admin").await.unwrap();
        assert!(admin.must_change_password, "it still has to be replaced");
        assert!(accounts
            .authenticate("admin", "admin")
            .await
            .unwrap()
            .is_some());

        // What replaces it is held to the real minimum.
        assert!(accounts.set_password(&admin.id, "four").await.is_err());
        assert!(accounts
            .set_password(&admin.id, "a long enough password")
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn signing_in_needs_the_right_password() {
        let accounts = accounts().await;
        accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();

        assert!(accounts
            .authenticate("kevin", "a long enough password")
            .await
            .unwrap()
            .is_some());
        assert!(accounts
            .authenticate("kevin", "a long enough passworD")
            .await
            .unwrap()
            .is_none());
        assert!(
            accounts
                .authenticate("nobody", "a long enough password")
                .await
                .unwrap()
                .is_none(),
            "an unknown username is the same answer as a wrong password"
        );
    }

    #[tokio::test]
    async fn a_session_identifies_its_user_and_can_be_ended() {
        let accounts = accounts().await;
        let admin = accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();

        let token = accounts.open_session(&admin.id).await.unwrap();
        let who = accounts
            .session_user(&token)
            .await
            .unwrap()
            .expect("signed in");
        assert_eq!(who.id, admin.id);

        accounts.close_session(&token).await.unwrap();
        assert!(
            accounts.session_user(&token).await.unwrap().is_none(),
            "signing out has to actually end it"
        );
    }

    #[tokio::test]
    async fn a_token_is_never_stored_as_itself() {
        let accounts = accounts().await;
        let admin = accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        let token = accounts.open_session(&admin.id).await.unwrap();

        let found: Option<String> =
            sqlx::query("SELECT token_hash FROM user_sessions WHERE user_id = $1")
                .bind(admin.id.as_str())
                .fetch_one(&accounts.pool)
                .await
                .unwrap()
                .get("token_hash");

        let stored = found.unwrap();
        assert_ne!(stored, token, "the database must not hold a usable session");
        assert_eq!(stored, fingerprint(&token));
    }

    #[tokio::test]
    async fn changing_a_password_signs_every_other_browser_out() {
        let accounts = accounts().await;
        let admin = accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();

        let laptop = accounts.open_session(&admin.id).await.unwrap();
        let phone = accounts.open_session(&admin.id).await.unwrap();

        let fresh = accounts
            .set_password(&admin.id, "a different long password")
            .await
            .unwrap();

        assert!(accounts.session_user(&laptop).await.unwrap().is_none());
        assert!(accounts.session_user(&phone).await.unwrap().is_none());
        assert!(
            accounts.session_user(&fresh).await.unwrap().is_some(),
            "whoever changed it gets a way back in, or the first step of \
             setting up throws you out halfway through"
        );

        let after = accounts.user_by_id(&admin.id).await.unwrap().unwrap();
        assert!(!after.must_change_password, "that was the change it wanted");
        assert!(accounts
            .authenticate("kevin", "a different long password")
            .await
            .unwrap()
            .is_some());
    }

    /// The sequence that was broken: sign in with what the environment seeded,
    /// replace it, name the organisation, finish. Nothing in the middle may
    /// sign anybody out, and afterwards setting up has to stay finished.
    ///
    /// There was no test walking this, which is why a first step that hung up
    /// on itself was committed.
    #[tokio::test]
    async fn the_whole_of_setting_up_can_be_done_in_one_sitting() {
        let accounts = accounts().await;

        // Seeded from the environment, so it must be replaced before anything.
        let admin = accounts.create_first_admin("admin", "admin").await.unwrap();
        let signed_in = accounts.open_session(&admin.id).await.unwrap();
        assert!(
            accounts
                .session_user(&signed_in)
                .await
                .unwrap()
                .unwrap()
                .must_change_password
        );

        // Step one. The session it hands back is what the rest of the wizard
        // carries on with.
        let carried_on = accounts
            .set_password(&admin.id, "something they chose")
            .await
            .unwrap();
        let who = accounts
            .session_user(&carried_on)
            .await
            .unwrap()
            .expect("still signed in");
        assert!(!who.must_change_password);

        // Step two.
        assert!(accounts.organization().await.unwrap().is_none());
        accounts
            .finish_setup(&who.org_id, "Westlabs")
            .await
            .unwrap();
        assert_eq!(
            accounts.organization().await.unwrap().unwrap().name,
            "Westlabs"
        );

        // And the end, which has to stick.
        assert!(!accounts.onboarded().await.unwrap());
        accounts.mark_onboarded().await.unwrap();
        assert!(accounts.onboarded().await.unwrap());
    }

    #[tokio::test]
    async fn setting_up_finishes_exactly_once() {
        let accounts = accounts().await;
        let admin = accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();

        assert!(
            accounts.organization().await.unwrap().is_none(),
            "an admin exists, but nobody has finished setting up"
        );

        let org = accounts
            .finish_setup(&admin.org_id, "Westlabs")
            .await
            .unwrap();
        assert_eq!(org.name, "Westlabs");
        assert_eq!(
            accounts.organization().await.unwrap().unwrap().name,
            "Westlabs"
        );

        assert!(
            accounts
                .finish_setup(&admin.org_id, "Someone Else")
                .await
                .is_err(),
            "the second attempt is refused by the database, not by us"
        );
    }

    #[tokio::test]
    async fn an_expired_session_is_refused_and_swept() {
        let accounts = accounts().await;
        let admin = accounts
            .create_first_admin("kevin", "a long enough password")
            .await
            .unwrap();
        let token = accounts.open_session(&admin.id).await.unwrap();

        sqlx::query("UPDATE user_sessions SET expires_at = now() - interval '1 hour'")
            .execute(&accounts.pool)
            .await
            .unwrap();

        assert!(accounts.session_user(&token).await.unwrap().is_none());
        assert_eq!(accounts.sweep_sessions().await.unwrap(), 1);
    }

    #[tokio::test]
    async fn a_setting_survives_being_written_twice() {
        let accounts = accounts().await;
        assert!(accounts
            .setting("github.client_id")
            .await
            .unwrap()
            .is_none());

        accounts
            .set_setting("github.client_id", "Ov23li")
            .await
            .unwrap();
        accounts
            .set_setting("github.client_id", "Ov23liTWO")
            .await
            .unwrap();

        assert_eq!(
            accounts
                .setting("github.client_id")
                .await
                .unwrap()
                .as_deref(),
            Some("Ov23liTWO")
        );
    }
}
