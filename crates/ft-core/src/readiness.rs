//! Facts measured in the environment that will run a session.
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Execution {
    Container,
    Host,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub name: String,
    pub available: bool,
    /// Optional tools are useful for installation, but don't prevent launch.
    pub required: bool,
    pub detail: String,
    pub remedy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub checks: Vec<Requirement>,
    pub user: Option<String>,
}

impl Readiness {
    pub fn ready(&self) -> bool {
        self.checks.iter().all(|c| !c.required || c.available)
    }

    pub fn missing(&self) -> String {
        self.checks
            .iter()
            .filter(|c| c.required && !c.available)
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}
