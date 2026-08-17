//! Identifiers.
//!
//! ULIDs rather than UUIDs, so `ORDER BY id` is chronological and an id in a log
//! line sorts next to the ones around it.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use utoipa::ToSchema;

macro_rules! id_type {
    ($name:ident, $prefix:literal, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            /// Mint a new one.
            pub fn new() -> Self {
                Self(format!(
                    "{}_{}",
                    $prefix,
                    ulid::Ulid::new().to_string().to_lowercase()
                ))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            /// Wrap a string that came from the database or the wire.
            pub fn from_stored(s: impl Into<String>) -> Self {
                Self(s.into())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl FromStr for $name {
            type Err = std::convert::Infallible;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(Self(s.to_string()))
            }
        }

        impl From<$name> for String {
            fn from(v: $name) -> String {
                v.0
            }
        }
    };
}

id_type!(
    SessionId,
    "s",
    "Identifies a session — the unit of work you talk to."
);
id_type!(
    WorkspaceId,
    "w",
    "Identifies a workspace — the compute a session runs on."
);
id_type!(HostId, "h", "Identifies a host.");
id_type!(RepoId, "r", "Identifies a connected repository.");
id_type!(UserId, "u", "Identifies someone who can sign in.");
id_type!(OrgId, "o", "Identifies an organisation.");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_carry_their_prefix() {
        assert!(SessionId::new().as_str().starts_with("s_"));
        assert!(HostId::new().as_str().starts_with("h_"));
    }

    #[test]
    fn ids_sort_chronologically() {
        let first = SessionId::new();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = SessionId::new();
        assert!(first.as_str() < second.as_str());
    }

    #[test]
    fn ids_round_trip_through_storage() {
        let id = SessionId::new();
        assert_eq!(SessionId::from_stored(id.as_str()), id);
    }
}
