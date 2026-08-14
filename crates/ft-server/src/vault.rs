//! The secret store.
//!
//! Everything Firetower holds on your behalf lives here: the token a git host
//! issued, the token an agent authenticates with. One table, encrypted, with a
//! log of every time a value was read and what it was read for.
//!
//! **Why the database and not the system keychain.** A keychain belongs to one
//! machine and one logged-in human. Firetower hands credentials to workers on
//! other machines, and to a container with no desktop session at all — so the
//! store has to be somewhere every part of the control plane can reach, and
//! that is the database. Which means the database now holds credentials, which
//! means they have to be encrypted, which is what [`crypto`] is for.
//!
//! **What is never in the log.** The value. Entries record what was touched and
//! why, never what it was, and nothing here writes a secret into a log line, an
//! error message, or a `Debug`.
//!
//! Three ways to open one, and they are different events on purpose:
//! [`Vault::holds`] decrypts nothing and is what a screen calls to ask whether
//! one is set; [`Vault::get`] is a session about to use a credential;
//! [`Vault::reveal`] is a person looking at one. Only the last two log.
//!
//! **What workers get.** A value, once, over the stream, at the moment a
//! workspace starts — as an environment variable for the process that needs it.
//! No worker stores one. Losing a worker loses nothing; the store is here.

pub mod crypto;
mod log;
pub mod root;

use anyhow::{Context, Result};
use crypto::{Identity, RootKey, Sealed};
use sqlx::{PgPool, Postgres, Row, Transaction};
use zeroize::Zeroizing;

/// Tokens for a git host, keyed by provider id.
pub const GIT: &str = "git";
/// Tokens an agent authenticates with, keyed by agent kind.
pub const AGENT: &str = "agent";

/// One entry in the access log. Note what is absent.
#[derive(Debug, Clone)]
pub struct Access {
    pub id: i64,
    pub scope: String,
    pub name: String,
    pub action: String,
    pub reason: String,
    pub at: chrono::DateTime<chrono::Utc>,
}

/// What walking the chain found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verification {
    Intact {
        entries: usize,
    },
    /// The first entry whose digest doesn't follow from the one before it.
    /// Everything after it is suspect too; this is where to start looking.
    Broken {
        at: i64,
    },
}

/// Postgres serialises appends to the log on this. A fixed number rather than a
/// row lock, because the first append has no row to lock and two of them would
/// otherwise both believe they are the start of the chain.
const APPEND_LOCK: i64 = 0x_f13e_7043;

pub struct Vault {
    pool: PgPool,
    root: RootKey,
}

impl Vault {
    pub fn new(pool: PgPool, root: RootKey) -> Self {
        Self { pool, root }
    }

    /// Store a value, replacing whatever was there.
    ///
    /// Replacing bumps the version, and the version is sealed into the
    /// ciphertext — so a copy of the row taken before a rotation cannot be put
    /// back afterwards and pass as current.
    pub async fn put(&self, scope: &str, name: &str, value: &str, reason: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let version: i32 =
            sqlx::query("SELECT version FROM secrets WHERE scope = $1 AND name = $2")
                .bind(scope)
                .bind(name)
                .fetch_optional(&mut *tx)
                .await?
                .map(|r| r.get::<i32, _>("version") + 1)
                .unwrap_or(1);

        let sealed = self.root.seal(
            Identity {
                scope,
                name,
                version,
            },
            value.as_bytes(),
        )?;

        sqlx::query(
            "INSERT INTO secrets (scope, name, version, wrapped_key, ciphertext, updated_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (scope, name) DO UPDATE SET version     = excluded.version,
                                                     wrapped_key = excluded.wrapped_key,
                                                     ciphertext  = excluded.ciphertext,
                                                     updated_at  = excluded.updated_at",
        )
        .bind(scope)
        .bind(name)
        .bind(version)
        .bind(&sealed.wrapped_key)
        .bind(&sealed.ciphertext)
        .execute(&mut *tx)
        .await?;

        self.append(&mut tx, scope, name, "Write", reason).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Read a value so something can use it, and say why.
    ///
    /// `reason` is not decoration — it is the whole point of the log. It should
    /// name the thing being done: `"starting session s_01…"`, not `"read"`.
    ///
    /// `None` means there is nothing stored, which is a normal state and not an
    /// error. A value that is there but doesn't decrypt *is* an error, and it
    /// is recorded before it is returned.
    pub async fn get(
        &self,
        scope: &str,
        name: &str,
        reason: &str,
    ) -> Result<Option<Zeroizing<String>>> {
        self.open(scope, name, "Read", reason).await
    }

    /// Read a value so a person can look at it.
    ///
    /// Logged as `Reveal` rather than `Read`, because they are not the same
    /// event and an audit that can't tell them apart is worth less. A session
    /// using a token is routine; a human putting one on screen is the thing you
    /// would want to find later.
    pub async fn reveal(
        &self,
        scope: &str,
        name: &str,
        reason: &str,
    ) -> Result<Option<Zeroizing<String>>> {
        self.open(scope, name, "Reveal", reason).await
    }

    async fn open(
        &self,
        scope: &str,
        name: &str,
        action: &str,
        reason: &str,
    ) -> Result<Option<Zeroizing<String>>> {
        let Some(row) = sqlx::query(
            "SELECT version, wrapped_key, ciphertext FROM secrets WHERE scope = $1 AND name = $2",
        )
        .bind(scope)
        .bind(name)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };

        let sealed = Sealed {
            wrapped_key: row.get("wrapped_key"),
            ciphertext: row.get("ciphertext"),
        };
        let id = Identity {
            scope,
            name,
            version: row.get("version"),
        };

        let opened = match self.root.open(id, &sealed) {
            Ok(bytes) => bytes,
            Err(e) => {
                // The most interesting line this log can hold: a stored secret
                // that no longer verifies means the root key changed or a row
                // was edited. Record it even though the read failed.
                self.record(scope, name, "Failed", reason).await?;
                return Err(e).with_context(|| {
                    format!(
                        "the stored {scope}/{name} did not verify. Either the root key is not \
                         the one it was sealed with, or the row was altered"
                    )
                });
            }
        };

        let value = Zeroizing::new(
            String::from_utf8(opened.to_vec()).context("a stored secret is not text")?,
        );

        self.record(scope, name, action, reason).await?;
        Ok(Some(value))
    }

    /// Whether one is set. Decrypts nothing, logs nothing, and is what a screen
    /// should ask — rendering a page is not a reason to touch a credential.
    pub async fn holds(&self, scope: &str, name: &str) -> Result<bool> {
        let row = sqlx::query("SELECT 1 FROM secrets WHERE scope = $1 AND name = $2")
            .bind(scope)
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    /// Remove a value. Absent is success — the wanted state is "not there".
    ///
    /// The log entry stays. A record of a credential having existed and been
    /// removed is exactly what an audit wants; deleting the trail with the
    /// secret would defeat the point.
    pub async fn forget(&self, scope: &str, name: &str, reason: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;

        let removed = sqlx::query("DELETE FROM secrets WHERE scope = $1 AND name = $2")
            .bind(scope)
            .bind(name)
            .execute(&mut *tx)
            .await?
            .rows_affected();

        if removed > 0 {
            self.append(&mut tx, scope, name, "Delete", reason).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// What has been stored, for a screen. Names only.
    pub async fn names(&self) -> Result<Vec<(String, String)>> {
        let rows = sqlx::query("SELECT scope, name FROM secrets ORDER BY scope, name")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| (r.get("scope"), r.get("name")))
            .collect())
    }

    /// The log, most recent first.
    pub async fn access(&self, limit: i64) -> Result<Vec<Access>> {
        let rows = sqlx::query(
            "SELECT id, scope, name, action, reason, at
             FROM secret_access ORDER BY id DESC LIMIT $1",
        )
        .bind(limit.clamp(1, 500))
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .iter()
            .map(|r| Access {
                id: r.get("id"),
                scope: r.get("scope"),
                name: r.get("name"),
                action: r.get("action"),
                reason: r.get("reason"),
                at: r.get("at"),
            })
            .collect())
    }

    /// Walk the chain from the beginning and report the first link that doesn't
    /// hold. Reads every row, so it is something you run, not something a page
    /// calls.
    pub async fn verify(&self) -> Result<Verification> {
        let key = self.root.log_key();
        let rows = sqlx::query(
            "SELECT id, scope, name, action, reason, at, digest
             FROM secret_access ORDER BY id ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut previous: Option<Vec<u8>> = None;

        for row in &rows {
            let (scope, name, action, reason): (String, String, String, String) = (
                row.get("scope"),
                row.get("name"),
                row.get("action"),
                row.get("reason"),
            );
            let entry = log::Entry {
                scope: &scope,
                name: &name,
                action: &action,
                reason: &reason,
                at: row.get("at"),
            };

            let expected = entry.digest(&*key, previous.as_deref());
            let stored: Vec<u8> = row.get("digest");

            if stored != expected {
                return Ok(Verification::Broken { at: row.get("id") });
            }
            previous = Some(stored);
        }

        Ok(Verification::Intact {
            entries: rows.len(),
        })
    }

    /// Append outside any transaction of ours — used when the work being logged
    /// already happened and must be recorded regardless.
    async fn record(&self, scope: &str, name: &str, action: &str, reason: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        self.append(&mut tx, scope, name, action, reason).await?;
        tx.commit().await?;
        Ok(())
    }

    /// One link. Serialised against other appends so the chain has one order.
    async fn append(
        &self,
        tx: &mut Transaction<'_, Postgres>,
        scope: &str,
        name: &str,
        action: &str,
        reason: &str,
    ) -> Result<()> {
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(APPEND_LOCK)
            .execute(&mut **tx)
            .await?;

        let previous: Option<Vec<u8>> =
            sqlx::query("SELECT digest FROM secret_access ORDER BY id DESC LIMIT 1")
                .fetch_optional(&mut **tx)
                .await?
                .map(|r| r.get("digest"));

        let at = chrono::Utc::now();
        let entry = log::Entry {
            scope,
            name,
            action,
            reason,
            at,
        };
        let digest = entry.digest(&*self.root.log_key(), previous.as_deref());

        sqlx::query(
            "INSERT INTO secret_access (scope, name, action, reason, at, previous, digest)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(scope)
        .bind(name)
        .bind(action)
        .bind(reason)
        .bind(at)
        .bind(previous)
        .bind(digest.as_slice())
        .execute(&mut **tx)
        .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    async fn vault() -> Vault {
        let db = Db::open_for_test().await.unwrap();
        Vault::new(db.pool().clone(), RootKey::generate())
    }

    #[tokio::test]
    async fn a_stored_secret_comes_back() {
        let vault = vault().await;
        vault
            .put(AGENT, "ClaudeCode", "a-token", "the user pasted it")
            .await
            .unwrap();

        assert_eq!(
            vault
                .get(AGENT, "ClaudeCode", "starting a session")
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("a-token")
        );
    }

    #[tokio::test]
    async fn nothing_stored_is_not_an_error() {
        let vault = vault().await;
        assert!(vault.get(GIT, "github", "cloning").await.unwrap().is_none());
        assert!(!vault.holds(GIT, "github").await.unwrap());
    }

    #[tokio::test]
    async fn the_value_is_not_in_the_row() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "gho_secret", "authorized")
            .await
            .unwrap();

        let row = sqlx::query("SELECT wrapped_key, ciphertext FROM secrets")
            .fetch_one(&vault.pool)
            .await
            .unwrap();

        for column in ["wrapped_key", "ciphertext"] {
            let blob: Vec<u8> = row.get(column);
            assert!(
                !blob.windows(10).any(|w| w == b"gho_secret"),
                "the token is readable in {column}"
            );
        }
    }

    #[tokio::test]
    async fn replacing_a_secret_bumps_the_version_and_returns_the_new_value() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "first", "authorized")
            .await
            .unwrap();
        vault
            .put(GIT, "github", "second", "re-authorized")
            .await
            .unwrap();

        assert_eq!(
            vault
                .get(GIT, "github", "cloning")
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("second")
        );
        let version: i32 = sqlx::query("SELECT version FROM secrets WHERE scope = $1")
            .bind(GIT)
            .fetch_one(&vault.pool)
            .await
            .unwrap()
            .get("version");
        assert_eq!(version, 2);
    }

    /// The reason the version is sealed in: putting yesterday's row back must
    /// not yield yesterday's still-valid token.
    #[tokio::test]
    async fn an_old_ciphertext_cannot_be_replayed_into_the_current_row() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "first", "authorized")
            .await
            .unwrap();

        let old = sqlx::query("SELECT wrapped_key, ciphertext FROM secrets")
            .fetch_one(&vault.pool)
            .await
            .unwrap();
        let (key, value): (Vec<u8>, Vec<u8>) = (old.get("wrapped_key"), old.get("ciphertext"));

        vault.put(GIT, "github", "second", "rotated").await.unwrap();

        sqlx::query("UPDATE secrets SET wrapped_key = $1, ciphertext = $2 WHERE scope = $3")
            .bind(&key)
            .bind(&value)
            .bind(GIT)
            .execute(&vault.pool)
            .await
            .unwrap();

        assert!(
            vault.get(GIT, "github", "cloning").await.is_err(),
            "a replayed ciphertext must not open"
        );
    }

    /// And moving a row to another name doesn't grant that name's credential.
    #[tokio::test]
    async fn a_row_moved_to_another_name_does_not_open() {
        let vault = vault().await;
        vault
            .put(AGENT, "ClaudeCode", "a-token", "pasted")
            .await
            .unwrap();

        sqlx::query("UPDATE secrets SET name = 'Codex' WHERE name = 'ClaudeCode'")
            .execute(&vault.pool)
            .await
            .unwrap();

        assert!(vault
            .get(AGENT, "Codex", "starting a session")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn another_root_key_reads_nothing() {
        let db = Db::open_for_test().await.unwrap();
        let ours = Vault::new(db.pool().clone(), RootKey::generate());
        ours.put(AGENT, "ClaudeCode", "a-token", "pasted")
            .await
            .unwrap();

        let theirs = Vault::new(db.pool().clone(), RootKey::generate());
        assert!(theirs.get(AGENT, "ClaudeCode", "starting").await.is_err());
        assert!(
            theirs.holds(AGENT, "ClaudeCode").await.unwrap(),
            "it still knows one is set — that much is not a secret"
        );
    }

    #[tokio::test]
    async fn forgetting_removes_the_value_and_keeps_the_trail() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "a-token", "authorized")
            .await
            .unwrap();
        vault.forget(GIT, "github", "signed out").await.unwrap();

        assert!(!vault.holds(GIT, "github").await.unwrap());
        assert!(vault
            .access(50)
            .await
            .unwrap()
            .iter()
            .any(|a| a.action == "Delete" && a.reason == "signed out"));
    }

    #[tokio::test]
    async fn forgetting_what_was_never_there_is_fine() {
        let vault = vault().await;
        vault.forget(GIT, "github", "signed out").await.unwrap();
        assert!(vault.access(50).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn every_touch_is_recorded_with_its_reason() {
        let vault = vault().await;
        vault
            .put(AGENT, "ClaudeCode", "a-token", "the user pasted it")
            .await
            .unwrap();
        vault
            .get(AGENT, "ClaudeCode", "starting session s_01")
            .await
            .unwrap();
        vault.holds(AGENT, "ClaudeCode").await.unwrap();

        let entries = vault.access(50).await.unwrap();
        let seen: Vec<_> = entries.iter().map(|a| (&*a.action, &*a.reason)).collect();

        assert_eq!(
            seen,
            vec![
                ("Read", "starting session s_01"),
                ("Write", "the user pasted it"),
            ],
            "asking whether one is set is not a read"
        );
    }

    /// A person looking at a credential and a session using one are different
    /// events, and an audit that couldn't tell them apart would be worth less.
    #[tokio::test]
    async fn revealing_is_recorded_as_its_own_kind_of_read() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "a-token", "authorized")
            .await
            .unwrap();

        assert_eq!(
            vault
                .reveal(GIT, "github", "shown on the Secrets screen")
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("a-token")
        );
        vault
            .get(GIT, "github", "cloning acme/backend")
            .await
            .unwrap();

        let seen: Vec<_> = vault
            .access(50)
            .await
            .unwrap()
            .iter()
            .map(|a| a.action.clone())
            .collect();

        assert_eq!(seen, vec!["Read", "Reveal", "Write"]);
    }

    #[tokio::test]
    async fn the_log_never_holds_the_value() {
        let vault = vault().await;
        vault
            .put(AGENT, "ClaudeCode", "sk-ant-oat01-abc", "pasted")
            .await
            .unwrap();
        vault.get(AGENT, "ClaudeCode", "starting").await.unwrap();

        for entry in vault.access(50).await.unwrap() {
            let line = format!("{entry:?}");
            assert!(!line.contains("sk-ant"), "the log leaked a value: {line}");
        }
    }

    #[tokio::test]
    async fn a_read_that_fails_is_still_recorded() {
        let db = Db::open_for_test().await.unwrap();
        let ours = Vault::new(db.pool().clone(), RootKey::generate());
        ours.put(AGENT, "ClaudeCode", "a-token", "pasted")
            .await
            .unwrap();

        let theirs = Vault::new(db.pool().clone(), RootKey::generate());
        let _ = theirs
            .get(AGENT, "ClaudeCode", "starting session s_01")
            .await;

        assert!(
            ours.access(50)
                .await
                .unwrap()
                .iter()
                .any(|a| a.action == "Failed"),
            "a credential that would not open is the entry worth having"
        );
    }

    #[tokio::test]
    async fn an_untouched_log_verifies() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "a-token", "authorized")
            .await
            .unwrap();
        vault.get(GIT, "github", "cloning").await.unwrap();
        vault.forget(GIT, "github", "signed out").await.unwrap();

        assert_eq!(
            vault.verify().await.unwrap(),
            Verification::Intact { entries: 3 }
        );
    }

    #[tokio::test]
    async fn an_edited_entry_is_found() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "a-token", "authorized")
            .await
            .unwrap();
        vault
            .get(GIT, "github", "cloning for the user")
            .await
            .unwrap();
        vault.get(GIT, "github", "cloning again").await.unwrap();

        let id: i64 = sqlx::query("SELECT id FROM secret_access ORDER BY id ASC OFFSET 1 LIMIT 1")
            .fetch_one(&vault.pool)
            .await
            .unwrap()
            .get("id");

        sqlx::query("UPDATE secret_access SET reason = 'something innocent' WHERE id = $1")
            .bind(id)
            .execute(&vault.pool)
            .await
            .unwrap();

        assert_eq!(
            vault.verify().await.unwrap(),
            Verification::Broken { at: id }
        );
    }

    #[tokio::test]
    async fn a_deleted_entry_is_found() {
        let vault = vault().await;
        vault
            .put(GIT, "github", "a-token", "authorized")
            .await
            .unwrap();
        vault
            .get(GIT, "github", "the read someone wants gone")
            .await
            .unwrap();
        vault.get(GIT, "github", "cloning again").await.unwrap();

        let ids: Vec<i64> = sqlx::query("SELECT id FROM secret_access ORDER BY id ASC")
            .fetch_all(&vault.pool)
            .await
            .unwrap()
            .iter()
            .map(|r| r.get("id"))
            .collect();

        sqlx::query("DELETE FROM secret_access WHERE id = $1")
            .bind(ids[1])
            .execute(&vault.pool)
            .await
            .unwrap();

        assert_eq!(
            vault.verify().await.unwrap(),
            Verification::Broken { at: ids[2] },
            "the entry after the hole is where the chain stops holding"
        );
    }

    /// Someone with the database but not the key cannot re-forge the chain.
    #[tokio::test]
    async fn a_rewritten_chain_without_the_root_key_does_not_verify() {
        let db = Db::open_for_test().await.unwrap();
        let ours = Vault::new(db.pool().clone(), RootKey::generate());
        ours.put(GIT, "github", "a-token", "authorized")
            .await
            .unwrap();

        // An impostor appends a plausible entry, computing digests the only way
        // they can: with a key of their own.
        let impostor = Vault::new(db.pool().clone(), RootKey::generate());
        impostor
            .record(GIT, "github", "Read", "entirely routine, honest")
            .await
            .unwrap();

        assert!(matches!(
            ours.verify().await.unwrap(),
            Verification::Broken { .. }
        ));
    }
}
