//! Tokens, in the operating system's keychain and nowhere else.
//!
//! Not the database, not a file, not a log line. The database is a rebuildable
//! cache and gets copied around; the keychain is the one place on the machine
//! built to hold this, with the operating system deciding who may read it.

use anyhow::{Context, Result};

const SERVICE: &str = "dev.firetower.git";

/// Where a git host's token lives.
///
/// Keyed by provider so a second host is another entry rather than a schema
/// change, and so signing out of one leaves the other alone.
pub struct Secrets;

impl Secrets {
    fn entry(provider: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, provider)
            .with_context(|| format!("opening the keychain entry for {provider}"))
    }

    pub fn store(provider: &str, token: &str) -> Result<()> {
        Self::entry(provider)?
            .set_password(token)
            .with_context(|| format!("saving the {provider} token"))
    }

    /// `None` when there isn't one — not an error, just not connected yet.
    pub fn get(provider: &str) -> Result<Option<String>> {
        match Self::entry(provider)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading the {provider} token")),
        }
    }

    /// Signing out. Missing is success — the desired state is "not there".
    pub fn forget(provider: &str) -> Result<()> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e).with_context(|| format!("removing the {provider} token")),
        }
    }
}
