//! How much somebody may do, and who a grant is about.
//!
//! Here rather than in the control plane because both ends of the contract need
//! them: the server decides, and an interface has to draw the difference between
//! a workspace somebody may open and one they may work in.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// How much somebody may do in a directory.
///
/// Ordered, and the order is the point — every check is "at least this much".
/// `Ord` comes from the declaration order, so `Viewer < Writer < Admin` without
/// a comparison written anywhere.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, ToSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum Level {
    /// May find it, open it, and read what happened.
    Viewer,
    /// May also work in it — start an agent, answer one, use the terminal.
    Writer,
    /// May also change who else can, and what is filed there.
    Admin,
}

impl Level {
    /// The same numbers `level_rank` gives in the database.
    ///
    /// Two definitions of one order is one too many, and this is the side that
    /// has to agree with the other: the comparing happens in SQL, and this is
    /// what gets interpolated into it.
    pub fn rank(self) -> i32 {
        match self {
            Level::Viewer => 1,
            Level::Writer => 2,
            Level::Admin => 3,
        }
    }

    /// As it is stored, which is also as it is serialised.
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Viewer => "viewer",
            Level::Writer => "writer",
            Level::Admin => "admin",
        }
    }

    pub fn parse(text: &str) -> Result<Self, UnknownLevel> {
        Ok(match text {
            "viewer" => Level::Viewer,
            "writer" => Level::Writer,
            "admin" => Level::Admin,
            other => return Err(UnknownLevel(other.to_string())),
        })
    }
}

/// A level that is not one of the three.
///
/// Its own type rather than a string, so the control plane can turn it into
/// whatever it reports errors with and this crate takes no dependency on that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownLevel(pub String);

impl std::fmt::Display for UnknownLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is not viewer, writer or admin", self.0)
    }
}

impl std::error::Error for UnknownLevel {}

/// Whether a grant names one person or a whole team.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum SubjectKind {
    Person,
    Team,
}

impl SubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Person => "person",
            SubjectKind::Team => "team",
        }
    }

    /// In words, for a sentence somebody reads.
    pub fn singular(self) -> &'static str {
        match self {
            SubjectKind::Person => "person",
            SubjectKind::Team => "team",
        }
    }

    pub fn parse(text: &str) -> Result<Self, UnknownSubject> {
        Ok(match text {
            "person" => SubjectKind::Person,
            "team" => SubjectKind::Team,
            other => return Err(UnknownSubject(other.to_string())),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownSubject(pub String);

impl std::fmt::Display for UnknownSubject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} is not a person or a team", self.0)
    }
}

impl std::error::Error for UnknownSubject {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The comparison every check is written as.
    #[test]
    fn more_access_is_greater() {
        assert!(Level::Admin > Level::Writer);
        assert!(Level::Writer > Level::Viewer);
        assert!(Level::Viewer >= Level::Viewer);
    }

    /// What serde writes has to be what the database stores, or every read
    /// decodes to nothing — the failure `20260907200000_workspace_share_case`
    /// was written to undo.
    #[test]
    fn the_wire_and_the_column_agree() {
        for level in [Level::Viewer, Level::Writer, Level::Admin] {
            let json = serde_json::to_string(&level).unwrap();
            assert_eq!(json, format!("\"{}\"", level.as_str()));
            assert_eq!(Level::parse(level.as_str()).unwrap(), level);
        }
        for kind in [SubjectKind::Person, SubjectKind::Team] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
            assert_eq!(SubjectKind::parse(kind.as_str()).unwrap(), kind);
        }
    }

    #[test]
    fn ranks_match_the_order() {
        assert!(Level::Admin.rank() > Level::Writer.rank());
        assert!(Level::Writer.rank() > Level::Viewer.rank());
    }
}
