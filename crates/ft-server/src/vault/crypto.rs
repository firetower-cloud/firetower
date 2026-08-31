//! Envelope encryption, and nothing else.
//!
//! No database, no filesystem, no clock. Everything here is a pure function of
//! its arguments, which is what makes the guarantees below testable — and they
//! are the guarantees the rest of the vault rests on.
//!
//! **The shape.** A root key never touches a secret. Each secret gets its own
//! randomly generated key; that key encrypts the value, and the root key
//! encrypts the key. Rotating the root then means re-encrypting a few dozen
//! small keys rather than every value, and a leaked ciphertext leaks one
//! secret rather than the file.
//!
//! **The binding.** Both layers are sealed with the secret's identity as
//! associated data — scope, name, and version. Associated data isn't stored;
//! it is supplied again at open time and the tag only verifies if it matches.
//! So a row copied from `git/github` into `agent/ClaudeCode`, or an old version
//! replayed into a new one, fails to open rather than quietly yielding the
//! wrong token. Without it, anyone with `UPDATE` on one table could point an
//! agent at a credential they were never granted.
//!
//! **The cipher.** XChaCha20-Poly1305. The 24-byte nonce is the reason: nonces
//! here are random, and at 24 bytes the chance of ever repeating one is not a
//! thing that needs managing. It is also constant-time in software, so it does
//! not depend on the host having AES instructions — and hosts here include
//! whatever server someone points Firetower at.

use anyhow::{anyhow, bail, Context, Result};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use zeroize::{Zeroize, Zeroizing};

/// XChaCha20-Poly1305: 32-byte key, 24-byte nonce.
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 24;

/// Changing anything about how bytes are laid out means changing this, so that
/// old ciphertexts fail loudly instead of decrypting into nonsense.
const DOMAIN: &[u8] = b"firetower/vault/v1";

/// Which envelope a tag belongs to.
///
/// Both layers share an identity, so without this a wrapped key and a value
/// would be interchangeable to the cipher — and swapping them is exactly the
/// kind of thing an attacker with write access would try.
#[derive(Clone, Copy)]
enum Layer {
    Wrap = 1,
    Value = 2,
}

/// What a secret is, for the purpose of proving a ciphertext belongs to it.
#[derive(Clone, Copy, Debug)]
pub struct Identity<'a> {
    pub scope: &'a str,
    pub name: &'a str,
    /// Whose it is. Empty for the install's own.
    ///
    /// Sealed in with the rest so one person's row cannot be put in another's
    /// place and still open: the ciphertext is bound to the owner, not only to
    /// the column that claims one.
    pub owner: &'a str,
    pub version: i32,
}

impl Identity<'_> {
    /// Length-prefixed, so `("gi", "thub")` and `("git", "hub")` are different
    /// bytes. Concatenating without lengths is the classic way to make two
    /// distinct identities collide.
    fn associated_data(&self, layer: Layer) -> Vec<u8> {
        let mut out = Vec::with_capacity(
            DOMAIN.len() + self.scope.len() + self.name.len() + self.owner.len() + 20,
        );
        out.extend_from_slice(DOMAIN);
        out.push(layer as u8);
        for part in [self.scope, self.name, self.owner] {
            out.extend_from_slice(&(part.len() as u32).to_be_bytes());
            out.extend_from_slice(part.as_bytes());
        }
        out.extend_from_slice(&self.version.to_be_bytes());
        out
    }
}

/// One sealed secret, as it is stored.
///
/// Two opaque blobs. Neither is useful without the root key, and neither is
/// useful in another row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    /// The secret's own key, encrypted under the root key.
    pub wrapped_key: Vec<u8>,
    /// The value, encrypted under the secret's own key.
    pub ciphertext: Vec<u8>,
}

/// The one key that isn't in the database.
///
/// Zeroed on drop. That is a smaller promise than it sounds — a moved value
/// leaves copies behind, and nothing stops the operating system paging it out —
/// but it shortens the window in which a core dump contains it.
#[derive(Clone)]
pub struct RootKey([u8; KEY_LEN]);

impl Drop for RootKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Never printed. A key that can appear in a log line is a key that will.
impl std::fmt::Debug for RootKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RootKey(…)")
    }
}

impl RootKey {
    pub fn generate() -> Self {
        Self(*random_key())
    }

    /// A key for something that is not a secret in the vault.
    ///
    /// Derived rather than the root itself, and separated by purpose, so that
    /// whatever holds one of these cannot read a stored credential with it and
    /// two purposes cannot be made to agree.
    pub fn derive(&self, purpose: &str) -> [u8; KEY_LEN] {
        let mut mac = <hmac::Hmac<sha2::Sha256>>::new_from_slice(&self.0)
            .expect("HMAC accepts any key length");
        hmac::Mac::update(&mut mac, purpose.as_bytes());
        hmac::Mac::finalize(mac).into_bytes().into()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let bytes: [u8; KEY_LEN] = bytes
            .try_into()
            .map_err(|_| anyhow!("a root key is {KEY_LEN} bytes; this one is {}", bytes.len()))?;
        Ok(Self(bytes))
    }

    /// How the key is written down: base64, the one form that survives an
    /// environment variable and a copy-paste unchanged.
    pub fn decode(text: &str) -> Result<Self> {
        let bytes =
            Zeroizing::new(ft_proto::decode(text.trim()).context("a root key must be base64")?);
        Self::from_bytes(&bytes)
    }

    pub fn encode(&self) -> Zeroizing<String> {
        Zeroizing::new(ft_proto::encode(&self.0))
    }

    /// Encrypt a value under a fresh key of its own.
    pub fn seal(&self, id: Identity<'_>, plaintext: &[u8]) -> Result<Sealed> {
        let secret_key = random_key();

        Ok(Sealed {
            wrapped_key: encrypt(
                Key::from_slice(&self.0),
                &id.associated_data(Layer::Wrap),
                &*secret_key,
            )?,
            ciphertext: encrypt(
                Key::from_slice(&*secret_key),
                &id.associated_data(Layer::Value),
                plaintext,
            )?,
        })
    }

    /// Decrypt, or say why not.
    ///
    /// Every failure reads the same from the outside — a wrong key, a tampered
    /// byte, and a row moved between names are all "this didn't verify" — which
    /// is deliberate. What went wrong is a detail an attacker would like.
    pub fn open(&self, id: Identity<'_>, sealed: &Sealed) -> Result<Zeroizing<Vec<u8>>> {
        let secret_key = Zeroizing::new(decrypt(
            Key::from_slice(&self.0),
            &id.associated_data(Layer::Wrap),
            &sealed.wrapped_key,
        )?);

        let key: [u8; KEY_LEN] = secret_key
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("this secret didn't verify"))?;

        Ok(Zeroizing::new(decrypt(
            Key::from_slice(&key),
            &id.associated_data(Layer::Value),
            &sealed.ciphertext,
        )?))
    }

    /// The access log's key, derived rather than reused, so a compromise of one
    /// is not automatically a compromise of the other.
    pub(super) fn log_key(&self) -> Zeroizing<[u8; KEY_LEN]> {
        Zeroizing::new(super::log::mac(
            &self.0,
            &[b"firetower/vault/access-log/v1"],
        ))
    }
}

/// A fresh 32 bytes from the operating system.
fn random_key() -> Zeroizing<[u8; KEY_LEN]> {
    let mut bytes = Zeroizing::new([0u8; KEY_LEN]);
    bytes.copy_from_slice(&XChaCha20Poly1305::generate_key(&mut OsRng));
    bytes
}

/// `nonce || ciphertext`, so a stored blob is self-describing.
fn encrypt(key: &Key, aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key);
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);

    let mut out = nonce.to_vec();
    out.extend_from_slice(
        &cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| anyhow!("encrypting"))?,
    );
    Ok(out)
}

fn decrypt(key: &Key, aad: &[u8], blob: &[u8]) -> Result<Vec<u8>> {
    if blob.len() <= NONCE_LEN {
        bail!("this secret didn't verify");
    }
    let (nonce, body) = blob.split_at(NONCE_LEN);

    XChaCha20Poly1305::new(key)
        .decrypt(XNonce::from_slice(nonce), Payload { msg: body, aad })
        .map_err(|_| anyhow!("this secret didn't verify"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &[u8] = b"sk-ant-oat01-not-a-real-token";

    fn id() -> Identity<'static> {
        Identity {
            owner: "",
            scope: "agent",
            name: "ClaudeCode",
            version: 1,
        }
    }

    #[test]
    fn what_goes_in_comes_back_out() {
        let root = RootKey::generate();
        let sealed = root.seal(id(), TOKEN).unwrap();
        assert_eq!(&*root.open(id(), &sealed).unwrap(), TOKEN);
    }

    #[test]
    fn the_value_is_nowhere_in_the_stored_bytes() {
        let root = RootKey::generate();
        let sealed = root.seal(id(), TOKEN).unwrap();
        for blob in [&sealed.wrapped_key, &sealed.ciphertext] {
            assert!(
                !blob.windows(TOKEN.len()).any(|w| w == TOKEN),
                "the plaintext survived into storage"
            );
        }
    }

    #[test]
    fn another_root_key_opens_nothing() {
        let sealed = RootKey::generate().seal(id(), TOKEN).unwrap();
        assert!(RootKey::generate().open(id(), &sealed).is_err());
    }

    /// The point of the associated data: a row moved to another name is not a
    /// credential for that name.
    #[test]
    fn a_secret_will_not_open_under_another_identity() {
        let root = RootKey::generate();
        let sealed = root.seal(id(), TOKEN).unwrap();

        let elsewhere = [
            Identity {
                scope: "git",
                ..id()
            },
            Identity {
                name: "Codex",
                ..id()
            },
            Identity { version: 2, ..id() },
        ];

        for other in elsewhere {
            assert!(
                root.open(other, &sealed).is_err(),
                "opened under {other:?}, which is not where it was sealed"
            );
        }
    }

    #[test]
    fn one_byte_changed_anywhere_fails() {
        let root = RootKey::generate();
        let sealed = root.seal(id(), TOKEN).unwrap();

        for i in 0..sealed.ciphertext.len() {
            let mut bad = sealed.clone();
            bad.ciphertext[i] ^= 1;
            assert!(root.open(id(), &bad).is_err(), "byte {i} of the value");
        }
        for i in 0..sealed.wrapped_key.len() {
            let mut bad = sealed.clone();
            bad.wrapped_key[i] ^= 1;
            assert!(root.open(id(), &bad).is_err(), "byte {i} of the key");
        }
    }

    /// Two rows, two keys. Taking the key from one and the value from the other
    /// gets you neither.
    #[test]
    fn the_envelopes_of_two_secrets_do_not_interchange() {
        let root = RootKey::generate();
        let other = Identity {
            name: "Codex",
            ..id()
        };

        let a = root.seal(id(), TOKEN).unwrap();
        let b = root.seal(other, b"another token").unwrap();

        assert!(root
            .open(
                id(),
                &Sealed {
                    wrapped_key: b.wrapped_key.clone(),
                    ciphertext: a.ciphertext.clone(),
                }
            )
            .is_err());
        assert!(root
            .open(
                id(),
                &Sealed {
                    wrapped_key: a.wrapped_key,
                    ciphertext: b.ciphertext,
                }
            )
            .is_err());
    }

    /// And the two layers of one row do not interchange either — that is what
    /// the layer byte in the associated data buys.
    #[test]
    fn the_two_layers_of_one_secret_do_not_interchange() {
        let root = RootKey::generate();
        let sealed = root.seal(id(), TOKEN).unwrap();

        assert!(root
            .open(
                id(),
                &Sealed {
                    wrapped_key: sealed.ciphertext.clone(),
                    ciphertext: sealed.wrapped_key.clone(),
                }
            )
            .is_err());
    }

    #[test]
    fn the_same_value_sealed_twice_stores_differently() {
        let root = RootKey::generate();
        let once = root.seal(id(), TOKEN).unwrap();
        let twice = root.seal(id(), TOKEN).unwrap();

        assert_ne!(once.ciphertext, twice.ciphertext, "nonces must not repeat");
        assert_ne!(once.wrapped_key, twice.wrapped_key);
    }

    #[test]
    fn truncated_blobs_are_refused_rather_than_panicking() {
        let root = RootKey::generate();
        let sealed = root.seal(id(), TOKEN).unwrap();

        for len in 0..=NONCE_LEN {
            let bad = Sealed {
                wrapped_key: sealed.wrapped_key[..len].to_vec(),
                ciphertext: sealed.ciphertext.clone(),
            };
            assert!(root.open(id(), &bad).is_err());
        }
    }

    #[test]
    fn a_root_key_survives_being_written_down() {
        let root = RootKey::generate();
        let text = root.encode();
        let sealed = root.seal(id(), TOKEN).unwrap();

        let read_back = RootKey::decode(&text).unwrap();
        assert_eq!(&*read_back.open(id(), &sealed).unwrap(), TOKEN);
    }

    #[test]
    fn a_root_key_of_the_wrong_size_is_refused_at_the_door() {
        assert!(RootKey::decode("not base64 at all !!").is_err());
        assert!(RootKey::decode(&ft_proto::encode(b"too short")).is_err());
        assert!(RootKey::decode(&ft_proto::encode(&[0u8; 64])).is_err());
    }

    #[test]
    fn the_log_key_is_not_the_root_key() {
        let root = RootKey::generate();
        assert_ne!(&*root.log_key(), &root.0, "derive, never reuse");
        assert_ne!(&*root.log_key(), &*RootKey::generate().log_key());
        assert_eq!(&*root.log_key(), &*root.log_key(), "and it is stable");
    }

    #[test]
    fn a_key_never_prints_itself() {
        assert_eq!(format!("{:?}", RootKey::generate()), "RootKey(…)");
    }
}
