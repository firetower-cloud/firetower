//! Who read what, and why — as a chain nobody can quietly edit.
//!
//! An access log matters most when the person editing rows is the person you
//! are logging. A plain table doesn't survive that: `DELETE` leaves no trace.
//! So each entry carries a digest over its own fields *and the digest before
//! it*. Remove an entry, change a reason, reorder two rows, and every digest
//! after the change stops matching.
//!
//! The digest is keyed with a value derived from the root key, which is the
//! part that does the work. An unkeyed hash chain is only re-computable by
//! anyone — including whoever just edited the row — so they would simply
//! rewrite the rest of the chain. Keyed, that needs the root key, and the root
//! key is the one thing not in the database.
//!
//! What this is not: prevention. Someone with the root key and write access can
//! forge a consistent chain. It makes tampering *evident*, which is the honest
//! promise, and it is the promise [`super::Vault::verify`] checks.

use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const DIGEST_LEN: usize = 32;

/// Length-prefixed so the parts can't be shuffled into each other — `("ab","c")`
/// and `("a","bc")` have to produce different digests, or two different entries
/// could share one.
pub fn mac(key: &[u8], parts: &[&[u8]]) -> [u8; DIGEST_LEN] {
    let mut mac = <Hmac<Sha256>>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in parts {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

/// One line of the log, before it has a digest.
pub struct Entry<'a> {
    pub scope: &'a str,
    pub name: &'a str,
    pub action: &'a str,
    /// Why it was touched, in words — "starting session s_01…", "cloning
    /// acme/backend". Never a value; see [`super::Vault`].
    pub reason: &'a str,
    pub at: chrono::DateTime<chrono::Utc>,
}

impl Entry<'_> {
    /// This entry's link in the chain. `previous` is the digest of the row
    /// before it, absent only for the very first.
    pub fn digest(&self, key: &[u8], previous: Option<&[u8]>) -> [u8; DIGEST_LEN] {
        mac(
            key,
            &[
                previous.unwrap_or(b"firetower/vault/genesis"),
                self.scope.as_bytes(),
                self.name.as_bytes(),
                self.action.as_bytes(),
                self.reason.as_bytes(),
                self.at.to_rfc3339().as_bytes(),
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at() -> chrono::DateTime<chrono::Utc> {
        "2026-08-14T09:00:00Z".parse().unwrap()
    }

    fn entry() -> Entry<'static> {
        Entry {
            scope: "agent",
            name: "ClaudeCode",
            action: "Read",
            reason: "starting session s_01",
            at: at(),
        }
    }

    #[test]
    fn the_same_entry_always_hashes_the_same() {
        assert_eq!(entry().digest(b"key", None), entry().digest(b"key", None));
    }

    #[test]
    fn every_field_is_covered() {
        let base = entry().digest(b"key", None);

        let changes = [
            Entry {
                scope: "git",
                ..entry()
            },
            Entry {
                name: "Codex",
                ..entry()
            },
            Entry {
                action: "Write",
                ..entry()
            },
            Entry {
                reason: "curiosity",
                ..entry()
            },
            Entry {
                at: at() + chrono::Duration::seconds(1),
                ..entry()
            },
        ];

        for changed in changes {
            assert_ne!(base, changed.digest(b"key", None));
        }
    }

    #[test]
    fn the_chain_moves_when_what_came_before_moves() {
        let first = entry().digest(b"key", None);
        let second = entry().digest(b"key", Some(&first));
        let forged = entry().digest(b"key", Some(&[0u8; DIGEST_LEN]));

        assert_ne!(second, forged, "a rewritten predecessor changes the link");
        assert_ne!(second, first);
    }

    #[test]
    fn without_the_key_the_chain_cannot_be_recomputed() {
        assert_ne!(entry().digest(b"key", None), entry().digest(b"other", None));
    }

    #[test]
    fn parts_cannot_be_shuffled_into_each_other() {
        assert_ne!(mac(b"k", &[b"ab", b"c"]), mac(b"k", &[b"a", b"bc"]));
    }
}
