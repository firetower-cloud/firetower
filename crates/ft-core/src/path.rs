//! Where a thing lives, and therefore who can reach it.
//!
//! Two roots, and only two:
//!
//! ```text
//! u/kevin/ledger_rounding      nobody else's business
//! d/backend/ledger_rounding    whoever has a grant on `backend`
//! ```
//!
//! **The first two labels are the permission root.** Everything after them is a
//! name with separators in it, for people to read: `d/backend/ledger/rounding`
//! is filed in `backend`, full stop. That is what lets the access check be one
//! indexed predicate instead of a recursive query, and it is why there are no
//! deny rules to reason about — nothing below the root can take anything away,
//! because nothing below the root grants anything.
//!
//! **Two spellings, one value.** Postgres holds this as `ltree`, whose
//! separator is a dot and whose labels are `[A-Za-z0-9_-]`. People read paths
//! with slashes. So the column says `u.kevin.ledger_rounding`, every screen and
//! every API response says `u/kevin/ledger_rounding`, and the conversion lives
//! here rather than being done by hand at each end.

use serde::{Deserialize, Serialize};
use std::fmt;
use utoipa::ToSchema;

/// A person's own space. Implicit: there is no row for it and no grant on it.
pub const PERSONAL: &str = "u";
/// A directory. There is a row, and grants hang off it.
pub const DIRECTORY: &str = "d";

/// A path, as the wire and the interface spell it: `u/kevin/thing`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(transparent)]
pub struct ResourcePath(String);

/// So a row can be read straight into one.
///
/// `sqlx::FromRow` can derive a field as `#[sqlx(try_from = "String")]`, and
/// that is the only way a struct read by the derive can hold a path rather than
/// the raw `ltree` text. Without it the choice is to carry a `String` and hope
/// every reader remembers which spelling it is in — which is how every agent
/// account came to report a path no client could parse.
impl From<String> for ResourcePath {
    fn from(stored: String) -> Self {
        Self::from_stored(stored)
    }
}

impl ResourcePath {
    /// From what the database holds — dots.
    pub fn from_stored(ltree: impl AsRef<str>) -> Self {
        Self(ltree.as_ref().replace('.', "/"))
    }

    /// What to bind into a query. Dots, because the column is an `ltree`.
    pub fn to_ltree(&self) -> String {
        self.0.replace('/', ".")
    }

    /// Somebody's own.
    pub fn personal(user_slug: &str, leaf: &str) -> Self {
        Self(format!("{PERSONAL}/{user_slug}/{leaf}"))
    }

    /// In a directory.
    pub fn in_directory(directory_slug: &str, leaf: &str) -> Self {
        Self(format!("{DIRECTORY}/{directory_slug}/{leaf}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The first two labels — what decides who may reach this.
    ///
    /// `None` for a path with fewer than two, which is not something this type
    /// can build but is something a database row could hold if somebody wrote
    /// one by hand.
    pub fn root(&self) -> Option<(&str, &str)> {
        let mut parts = self.0.split('/');
        Some((parts.next()?, parts.next()?))
    }

    /// Whose personal space this is in, if it is in one.
    pub fn owner_slug(&self) -> Option<&str> {
        match self.root()? {
            (PERSONAL, who) => Some(who),
            _ => None,
        }
    }

    /// Which directory this is filed in, if it is in one.
    pub fn directory_slug(&self) -> Option<&str> {
        match self.root()? {
            (DIRECTORY, which) => Some(which),
            _ => None,
        }
    }

    /// The last label: what the thing is called, without where it lives.
    pub fn leaf(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    /// The same thing, filed somewhere else.
    ///
    /// Only the root moves. A thing keeps its name when it changes hands, which
    /// is what makes a move legible in a log: one prefix differs.
    pub fn moved_to(&self, root_kind: &str, root: &str) -> Self {
        let rest: Vec<&str> = self.0.split('/').skip(2).collect();
        Self(format!("{root_kind}/{root}/{}", rest.join("/")))
    }
}

impl fmt::Display for ResourcePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Make a label an `ltree` will accept.
///
/// Labels are `[A-Za-z0-9_-]`, so a display name cannot be one: `Ledger work`
/// is a syntax error, not a slow query. Every root carries a slug beside its
/// name for this reason, and this is the one place the rule is written.
pub fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('_');
            }
            gap = false;
            out.extend(ch.to_lowercase());
        } else {
            gap = true;
        }
    }
    if out.is_empty() {
        out.push_str("untitled");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_reads_with_slashes_and_is_stored_with_dots() {
        let p = ResourcePath::personal("kevin", "ledger_rounding");
        assert_eq!(p.as_str(), "u/kevin/ledger_rounding");
        assert_eq!(p.to_ltree(), "u.kevin.ledger_rounding");
        assert_eq!(ResourcePath::from_stored("u.kevin.ledger_rounding"), p);
    }

    #[test]
    fn the_root_is_the_first_two_labels_and_nothing_below_counts() {
        let deep = ResourcePath::in_directory("backend", "ledger/rounding/fix");
        assert_eq!(deep.root(), Some(("d", "backend")));
        assert_eq!(deep.directory_slug(), Some("backend"));
        assert_eq!(deep.owner_slug(), None);
        assert_eq!(deep.leaf(), "fix");
    }

    /// Moving keeps the name. One prefix differs, which is what makes a move
    /// readable in a log line.
    #[test]
    fn moving_changes_the_root_and_nothing_else() {
        let mine = ResourcePath::personal("kevin", "ledger/rounding");
        let theirs = mine.moved_to(DIRECTORY, "backend");
        assert_eq!(theirs.as_str(), "d/backend/ledger/rounding");
        assert_eq!(
            theirs.moved_to(PERSONAL, "ana").as_str(),
            "u/ana/ledger/rounding"
        );
    }

    /// `'Ledger work'::ltree` is a syntax error. This is what stands between a
    /// display name and that.
    #[test]
    fn a_slug_is_something_ltree_will_accept() {
        assert_eq!(slug("Ledger work"), "ledger_work");
        assert_eq!(slug("Kevin Piacentini"), "kevin_piacentini");
        assert_eq!(slug("acme/api"), "acme_api");
        assert_eq!(slug("  --  "), "untitled");
        assert!(slug("Ünïcode ✨ name")
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_'));
    }
}
