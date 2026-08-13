//! Tokens, in the operating system's keychain and nowhere else.
//!
//! Not the database, not a file, not a log line. The database is a rebuildable
//! cache and gets copied around; the keychain is the one place on the machine
//! built to hold this, with the operating system deciding who may read it.
//!
//! Every call here is blocking, and on some systems it blocks on a dialog
//! waiting for a human. So all of it goes through `spawn_blocking`: a keychain
//! prompt must never be able to stall the server, and calling these directly
//! from a handler is exactly how that happens.
//!
//! It also gets a deadline. On macOS the keychain asks permission when the
//! program touching an item isn't the one that created it — which, for a binary
//! rebuilt by `cargo watch`, is every rebuild, because the ad-hoc signature
//! changes each time. Nobody answers that dialog if it appeared behind a
//! browser window, so an unanswered prompt has to become an error someone can
//! read rather than a request that never returns.

use anyhow::{bail, Context, Result};
use std::time::Duration;

/// Long enough for a keychain that is merely slow, short enough that a dialog
/// nobody is looking at doesn't read as a hang.
const DEADLINE: Duration = Duration::from_secs(10);

/// Run a blocking keychain call off the async threads, and give up on it.
async fn off_thread<T, F>(what: &str, f: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    match tokio::time::timeout(DEADLINE, tokio::task::spawn_blocking(f)).await {
        Ok(joined) => joined?,
        Err(_) => bail!(
            "the system keychain didn't answer within {DEADLINE:?} while {what}. \
             It may be asking for permission in a window you can't see — look for \
             a dialog and choose Always Allow."
        ),
    }
}

/// Scoped by kind, so two credentials can share a name without colliding.
///
/// Only git tokens live here now. Agent credentials moved to the database:
/// every worker needs to be handed one, and a keychain doesn't exist on a
/// server. Git tokens will follow when the secret store is built properly —
/// they have the same problem, just not yet the same urgency.
pub const GIT: &str = "dev.firetower.git";

/// Where credentials live.
///
/// Keyed by scope and name, so another provider or agent is one more entry
/// rather than a schema change.
pub struct Secrets;

impl Secrets {
    fn entry(scope: &str, name: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(scope, name)
            .with_context(|| format!("opening the keychain entry for {name}"))
    }

    pub async fn store(scope: &str, name: &str, value: &str) -> Result<()> {
        let (scope, name, value) = (scope.to_string(), name.to_string(), value.to_string());
        off_thread("saving a credential", move || {
            Self::entry(&scope, &name)?
                .set_password(&value)
                .with_context(|| format!("saving the credential for {name}"))
        })
        .await
    }

    /// `None` when there isn't one — not an error, just not set up yet.
    ///
    /// Only call this when the value is actually needed. To find out whether
    /// one exists, ask the database — see the `credentials` table.
    pub async fn get(scope: &str, name: &str) -> Result<Option<String>> {
        let (scope, name) = (scope.to_string(), name.to_string());
        off_thread("reading a credential", move || {
            match Self::entry(&scope, &name)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e).with_context(|| format!("reading the credential for {name}")),
            }
        })
        .await
    }

    /// Missing is success — the desired state is "not there".
    pub async fn forget(scope: &str, name: &str) -> Result<()> {
        let (scope, name) = (scope.to_string(), name.to_string());
        off_thread("removing a credential", move || {
            match Self::entry(&scope, &name)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e).with_context(|| format!("removing the credential for {name}")),
            }
        })
        .await
    }
}
