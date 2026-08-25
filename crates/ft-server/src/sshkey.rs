//! The key Firetower dials out with.
//!
//! Until this existed, a host named a key by path — and that was right while
//! the control plane ran on the operator's machine. In a container it is not:
//! the path is read inside the container, `~/.ssh/id_ed25519` resolves to a
//! file that only exists on their machine, and no path they can type would
//! work. The two filesystems are not the same one.
//!
//! So Firetower makes a key for itself. That is a narrower thing than holding
//! the operator's key, and worth the distinction: this one is scoped to this
//! installation, opens nothing else they own, and is revoked by deleting one
//! line on one machine.
//!
//! One pair per installation, not per host. Revoking then cuts every host at
//! once, which is the behaviour somebody reaching for revocation wants; a key
//! per host would be finer and would multiply the work of adding a machine by
//! the size of the fleet.
//!
//! No passphrase. There is nobody at the keyboard when the control plane
//! reconnects to twelve hosts after a restart, and a passphrase stored beside
//! the key it protects is decoration.

use anyhow::{Context, Result};
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

use crate::vault::{Key, Vault};

/// Where the pair lives in the vault. One row, this installation's.
const SCOPE: &str = "firetower";
const NAME: &str = "ssh-identity";

/// What a person may see.
///
/// The private half is not here and is not returned by anything: it goes from
/// the vault to a file ssh reads, and back out of existence. Every field below
/// is safe on a screen, in a screenshot, and in a provider's web form.
#[derive(Debug, Clone, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PublicIdentity {
    /// `ssh-ed25519 AAAAC3… firetower`, exactly as `authorized_keys` wants it.
    pub public_key: String,
    /// `SHA256:…`, to match against `ssh-keygen -lf` on the other machine when
    /// the two disagree about what was installed.
    pub fingerprint: String,
    pub algorithm: String,
}

/// The comment on the key, so it is identifiable in a file of them.
const COMMENT: &str = "firetower";

fn describe(key: &PrivateKey) -> Result<PublicIdentity> {
    Ok(PublicIdentity {
        public_key: key
            .public_key()
            .to_openssh()
            .context("encoding the public key")?,
        fingerprint: key.fingerprint(Default::default()).to_string(),
        algorithm: key.algorithm().to_string(),
    })
}

/// Read the pair, making it the first time.
///
/// Generated at start-up rather than when a host is first added, so that
/// `firetower install` can print the public half with the credentials — the
/// very next thing anyone does is add a machine, and the key has to exist
/// before it can be put on one.
pub async fn ensure(vault: &Vault) -> Result<PublicIdentity> {
    if let Some(existing) = load(vault, "reading Firetower's own ssh key").await? {
        return describe(&existing);
    }

    // ed25519: small enough to paste into a provider's web form without
    // wrapping, and the default every modern sshd accepts.
    let mut key = PrivateKey::random(&mut ssh_key::rand_core::OsRng, Algorithm::Ed25519)
        .context("generating an ssh key")?;
    key.set_comment(COMMENT);

    let openssh = key
        .to_openssh(LineEnding::LF)
        .context("encoding the private key")?;

    vault
        .put(
            Key::shared(SCOPE, NAME),
            &openssh,
            "creating Firetower's own ssh key",
        )
        .await?;

    let described = describe(&key)?;
    tracing::info!(fingerprint = %described.fingerprint, "made an ssh key");

    Ok(described)
}

/// The public half, or `None` when no pair has been made yet.
pub async fn public(vault: &Vault) -> Result<Option<PublicIdentity>> {
    match load(vault, "showing Firetower's own ssh key").await? {
        Some(key) => Ok(Some(describe(&key)?)),
        None => Ok(None),
    }
}

/// The private half, in OpenSSH's format, for writing where ssh will read it.
///
/// `Zeroizing` all the way through: this is the one string in the process worth
/// being careful about, and it exists only long enough to reach a file.
pub async fn private(vault: &Vault, reason: &str) -> Result<Option<Zeroizing<String>>> {
    vault.get(Key::shared(SCOPE, NAME), reason).await
}

/// Write a held key where ssh can read it, and return that path.
///
/// ssh takes a key from a file and offers no way to hand it one otherwise, so
/// there has to be a file. It should not be on the volume: the volume is what
/// gets backed up, and a plaintext key sitting in a backup undoes the point of
/// sealing it in the first place.
///
/// `/dev/shm` is tmpfs — memory, never written to a disk, and empty again after
/// a restart. Where there is no `/dev/shm` (a non-Linux host running the binary
/// directly) it falls back to the state directory, and says so, because that is
/// a different promise and worth one line in the log.
///
/// Written on every connect rather than cached: a rotation has to take effect
/// without a restart, and a few hundred bytes to tmpfs is not worth the
/// staleness. The write is atomic — a temporary file and a rename — so two
/// hosts connecting at once cannot read a half-written key.
pub async fn materialise(vault: &Vault, home: &Path, reason: &str) -> Result<PathBuf> {
    let key = private(vault, reason)
        .await?
        .context("Firetower has no ssh key of its own yet")?;

    let (dir, in_memory) = match Path::new("/dev/shm") {
        shm if shm.is_dir() => (shm.join("firetower"), true),
        _ => (home.join("ssh"), false),
    };

    std::fs::create_dir_all(&dir).with_context(|| format!("making {}", dir.display()))?;
    restrict(&dir, 0o700)?;

    if !in_memory {
        tracing::debug!(
            path = %dir.display(),
            "no /dev/shm, so the ssh key is written under the state directory instead"
        );
    }

    let path = dir.join("id_ed25519");
    let temporary = dir.join("id_ed25519.writing");

    std::fs::write(&temporary, key.as_bytes())
        .with_context(|| format!("writing {}", temporary.display()))?;
    // Tightened before the rename, so the key is never readable at the name ssh
    // will read it from.
    restrict(&temporary, 0o600)?;
    std::fs::rename(&temporary, &path)
        .with_context(|| format!("renaming into {}", path.display()))?;

    Ok(path)
}

/// ssh refuses a key other accounts can read, and it is right to.
fn restrict(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .with_context(|| format!("setting {mode:o} on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);

    Ok(())
}

async fn load(vault: &Vault, reason: &str) -> Result<Option<PrivateKey>> {
    let Some(stored) = vault.get(Key::shared(SCOPE, NAME), reason).await? else {
        return Ok(None);
    };

    let key = PrivateKey::from_openssh(stored.as_str())
        .context("Firetower's stored ssh key could not be read")?;

    Ok(Some(key))
}

/// Replace it, and say which hosts now have to be told.
///
/// Rotating does not touch any host: every machine still holds the old public
/// key and none holds the new one, so the fleet is unreachable until each is
/// updated. The caller names them, which is why this returns nothing but the
/// new identity — the list is the caller's to build from its own view of the
/// fleet.
pub async fn rotate(vault: &Vault) -> Result<PublicIdentity> {
    let mut key = PrivateKey::random(&mut ssh_key::rand_core::OsRng, Algorithm::Ed25519)
        .context("generating an ssh key")?;
    key.set_comment(COMMENT);

    let openssh = key
        .to_openssh(LineEnding::LF)
        .context("encoding the private key")?;

    vault
        .put(
            Key::shared(SCOPE, NAME),
            &openssh,
            "rotating Firetower's own ssh key",
        )
        .await?;

    let described = describe(&key)?;
    tracing::warn!(
        fingerprint = %described.fingerprint,
        "rotated the ssh key — every host must be given the new one"
    );

    Ok(described)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The generated pair has to satisfy ssh itself, not merely round-trip
    /// through this crate. Encoding OpenSSH's private key format is the kind of
    /// thing to get subtly wrong once and find out on somebody else's server.
    #[test]
    fn the_pair_is_one_ssh_would_accept() {
        let mut key =
            PrivateKey::random(&mut ssh_key::rand_core::OsRng, Algorithm::Ed25519).unwrap();
        key.set_comment(COMMENT);

        let private = key.to_openssh(LineEnding::LF).unwrap();
        assert!(private.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(private.ends_with("-----END OPENSSH PRIVATE KEY-----\n"));

        // Read back the way ssh would.
        let reread = PrivateKey::from_openssh(private.as_str()).unwrap();
        assert_eq!(reread.public_key(), key.public_key());
        assert_eq!(reread.comment(), COMMENT);

        let described = describe(&key).unwrap();

        // One line, and the shape authorized_keys wants.
        assert!(described
            .public_key
            .starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"));
        assert!(described.public_key.ends_with(" firetower"));
        assert!(!described.public_key.contains('\n'));

        assert!(described.fingerprint.starts_with("SHA256:"));
        assert_eq!(described.algorithm, "ssh-ed25519");
    }

    /// The real arbiter. `ssh-key` and `ssh` are different implementations, and
    /// the one that has to accept this key is the one on the far machine.
    #[test]
    fn ssh_keygen_reads_what_we_wrote() {
        use std::os::unix::fs::PermissionsExt;

        let Ok(found) = std::process::Command::new("ssh-keygen").arg("-?").output() else {
            eprintln!("no ssh-keygen here; skipping");
            return;
        };
        let _ = found;

        let mut key =
            PrivateKey::random(&mut ssh_key::rand_core::OsRng, Algorithm::Ed25519).unwrap();
        key.set_comment(COMMENT);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        // `-y` derives the public half from the private one. It fails outright
        // on a private key it cannot parse, which is the thing being checked.
        let derived = std::process::Command::new("ssh-keygen")
            .arg("-y")
            .arg("-f")
            .arg(&path)
            .output()
            .unwrap();

        assert!(
            derived.status.success(),
            "ssh-keygen refused the private key: {}",
            String::from_utf8_lossy(&derived.stderr)
        );

        // ssh-keygen -y drops the comment, so compare the two fields that carry
        // the key itself.
        let ours = describe(&key).unwrap().public_key;
        let theirs = String::from_utf8(derived.stdout).unwrap();

        let field = |line: &str| {
            line.split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(field(&ours), field(theirs.trim()));
    }

    #[test]
    fn two_installations_do_not_share_a_key() {
        let one = PrivateKey::random(&mut ssh_key::rand_core::OsRng, Algorithm::Ed25519).unwrap();
        let two = PrivateKey::random(&mut ssh_key::rand_core::OsRng, Algorithm::Ed25519).unwrap();
        assert_ne!(one.public_key(), two.public_key());
    }
}
