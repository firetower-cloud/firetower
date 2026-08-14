//! Where the one key that isn't in the database comes from.
//!
//! Two places, in order:
//!
//! 1. `FIRETOWER_ROOT_KEY` — base64. This is how a container, a hosted
//!    deployment, or anything with a key manager in front of it supplies one.
//!    Nothing is written to disk.
//! 2. `~/.firetower/root.key`, mode `0600`, created on first run. This is the
//!    workstation case, and it is the same arrangement as an ssh private key:
//!    a file only your account can read, sitting outside the thing it protects.
//!
//! **Why not the system keychain.** It was the first design, and it is a real
//! step better — the operating system gates access per application. It is also
//! unusable here. On macOS the keychain re-asks for permission whenever the
//! binary's signature changes, which is every rebuild, so a developer gets a
//! dialog on every restart and a headless Linux server gets no keychain at all.
//! A prompt nobody can answer isn't security, it's an outage. The file is the
//! honest trade: weaker against another process running as you, and it works
//! everywhere Firetower runs.
//!
//! **What losing it costs.** Every secret. There is no recovery and that is the
//! point — a backup of the database is not a backup of the credentials. Back
//! the key up separately if the secrets are worth keeping.

use super::crypto::RootKey;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// The environment variable that overrides everything.
pub const ENV: &str = "FIRETOWER_ROOT_KEY";

const FILE: &str = "root.key";

/// Which of the two answered, so start-up can say so out loud.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Environment,
    File(PathBuf),
    /// Created just now. Worth a different line in the log: it means anything
    /// sealed under a previous key is no longer readable.
    NewFile(PathBuf),
}

impl std::fmt::Display for Source {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Environment => write!(f, "{ENV}"),
            Self::File(p) | Self::NewFile(p) => write!(f, "{}", p.display()),
        }
    }
}

/// Find the root key, or make one.
pub async fn load(home: &Path) -> Result<(RootKey, Source)> {
    if let Ok(text) = std::env::var(ENV) {
        if !text.trim().is_empty() {
            let key = RootKey::decode(&text)
                .with_context(|| format!("reading {ENV}"))
                .context(
                    "that value is not a Firetower root key. Unset it to fall back to the \
                     key file, or set it to a key this deployment sealed its secrets with",
                )?;
            return Ok((key, Source::Environment));
        }
    }

    let path = home.join(FILE);

    match tokio::fs::read_to_string(&path).await {
        Ok(text) => {
            let key = RootKey::decode(&text).with_context(|| {
                format!(
                    "{} is not a root key. It has not been touched — every secret in the \
                     database is sealed with whatever used to be in it, so restore that file \
                     rather than deleting it",
                    path.display()
                )
            })?;
            tighten(&path).await?;
            Ok((key, Source::File(path)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = RootKey::generate();
            write_new(&path, &key).await?;
            Ok((key, Source::NewFile(path)))
        }
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Write the key where nothing can half-write it.
///
/// Into a neighbouring file first, then rename. A crash partway through a
/// direct write would leave a truncated key, and a truncated root key is every
/// secret gone — the one failure here with no way back.
async fn write_new(path: &Path, key: &RootKey) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent)
        .await
        .with_context(|| format!("creating {}", parent.display()))?;

    // Restricted before anything is in it, rather than written and then
    // narrowed — the gap between those two is a window where the key is
    // readable, and it is avoidable.
    let temp = path.with_extension("key.new");
    restrict(&temp).await?;
    tokio::fs::write(&temp, format!("{}\n", &*key.encode()))
        .await
        .with_context(|| format!("writing {}", temp.display()))?;

    tokio::fs::rename(&temp, path)
        .await
        .with_context(|| format!("moving the new key into {}", path.display()))?;
    Ok(())
}

/// Create the file empty at `0600`, whatever the umask would have made it.
#[cfg(unix)]
async fn restrict(path: &Path) -> Result<()> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .await
        .with_context(|| format!("creating {}", path.display()))?;
    Ok(())
}

/// `0600`, on a file that already existed. A key someone else on the machine
/// can read is not a key, and this is where that gets noticed.
#[cfg(unix)]
async fn tighten(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = tokio::fs::metadata(path).await?.permissions().mode() & 0o777;
    if mode != 0o600 {
        tracing::warn!(
            path = %path.display(),
            "the root key was readable beyond this account (mode {mode:o}); tightening it"
        );
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .await
            .with_context(|| format!("restricting {}", path.display()))?;
    }
    Ok(())
}

/// Elsewhere the filesystem has no equivalent, so this is left to the
/// account's own profile directory.
#[cfg(not(unix))]
async fn restrict(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(not(unix))]
async fn tighten(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::crypto::Identity;

    fn id() -> Identity<'static> {
        Identity {
            scope: "test",
            name: "one",
            version: 1,
        }
    }

    /// These tests set a process-wide environment variable, so they take turns.
    async fn lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        LOCK.lock().await
    }

    #[tokio::test]
    async fn the_first_run_makes_a_key_and_the_second_finds_it() {
        let _guard = lock().await;
        std::env::remove_var(ENV);
        let home = tempfile::tempdir().unwrap();

        let (first, source) = load(home.path()).await.unwrap();
        assert!(matches!(source, Source::NewFile(_)), "{source:?}");

        let sealed = first.seal(id(), b"a token").unwrap();

        let (again, source) = load(home.path()).await.unwrap();
        assert!(matches!(source, Source::File(_)), "{source:?}");
        assert_eq!(
            &*again.open(id(), &sealed).unwrap(),
            b"a token",
            "restarting must not orphan what was already sealed"
        );
    }

    #[tokio::test]
    async fn the_environment_wins_and_writes_nothing() {
        let _guard = lock().await;
        let home = tempfile::tempdir().unwrap();
        let key = RootKey::generate();
        std::env::set_var(ENV, &*key.encode());

        let (loaded, source) = load(home.path()).await.unwrap();
        std::env::remove_var(ENV);

        assert_eq!(source, Source::Environment);
        assert!(
            !home.path().join(FILE).exists(),
            "a supplied key must not be copied to disk"
        );

        let sealed = key.seal(id(), b"a token").unwrap();
        assert_eq!(&*loaded.open(id(), &sealed).unwrap(), b"a token");
    }

    /// The dangerous case: a damaged key file must stop the server, not be
    /// replaced with a fresh one that silently orphans every secret.
    #[tokio::test]
    async fn a_damaged_key_file_is_never_overwritten() {
        let _guard = lock().await;
        std::env::remove_var(ENV);
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(FILE);

        tokio::fs::write(&path, "half a k").await.unwrap();

        assert!(load(home.path()).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(&path).await.unwrap(),
            "half a k",
            "the file must be exactly as it was"
        );
    }

    #[tokio::test]
    async fn a_nonsense_environment_value_stops_start_up() {
        let _guard = lock().await;
        std::env::set_var(ENV, "obviously not a key");
        let home = tempfile::tempdir().unwrap();

        let result = load(home.path()).await;
        std::env::remove_var(ENV);

        assert!(result.is_err(), "better to refuse than to seal under junk");
    }

    #[tokio::test]
    async fn an_empty_environment_value_falls_through_to_the_file() {
        let _guard = lock().await;
        std::env::set_var(ENV, "");
        let home = tempfile::tempdir().unwrap();

        let result = load(home.path()).await;
        std::env::remove_var(ENV);

        assert!(matches!(result.unwrap().1, Source::NewFile(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_key_file_is_only_readable_by_this_account() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = lock().await;
        std::env::remove_var(ENV);
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(FILE);

        load(home.path()).await.unwrap();
        let mode = || std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(), 0o600);

        // And a file loosened behind our back is tightened on the next start.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        load(home.path()).await.unwrap();
        assert_eq!(mode(), 0o600);
    }
}
