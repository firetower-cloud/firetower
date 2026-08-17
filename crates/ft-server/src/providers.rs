//! The git hosts Firetower can authorize against.
//!
//! Everything host-specific lives in this table, so adding another one is a new
//! entry rather than a new code path. What varies between hosts is only ever
//! four URLs, the scopes to ask for, and the username git expects to see
//! alongside a token.

use serde::Serialize;
use utoipa::ToSchema;

/// Everything that differs between one git host and another.
pub struct Provider {
    /// Stable identifier, used in URLs and as the name in the secret store.
    pub id: &'static str,
    /// What it's called in the interface.
    pub label: &'static str,
    /// Where a device authorization starts.
    pub device_code_url: &'static str,
    /// Where a device code is exchanged for a token.
    pub token_url: &'static str,
    /// Root of the REST API, for listing repositories.
    pub api_base: &'static str,
    /// The narrowest access that covers cloning and pushing a branch.
    pub scopes: &'static str,
    /// Git wants a username next to a token even when it's ignored.
    pub git_username: &'static str,
    /// The hostname in a clone URL, which is how a remote is matched to a token.
    pub git_host: &'static str,
    /// Set at build time by whoever publishes Firetower.
    ///
    /// A device-flow client identifier is public by design — there is no paired
    /// secret and nothing to protect — which is exactly why this flow suits an
    /// application that ships as source.
    pub client_id: &'static str,
}

/// Where an operator-supplied client id is kept.
pub fn setting_key(id: &str) -> String {
    format!("{id}.client_id")
}

/// The identifier to authorize with, if there is one.
///
/// The stored one first, then whatever this build was compiled with. There is
/// deliberately no environment variable: this is answered in the setup wizard,
/// or in the connect-a-repository screen at the moment it is missed, and a
/// value that can also come from a file is a value someone will change in the
/// interface and then find unchanged.
pub async fn client_id(accounts: &crate::accounts::Accounts, id: &str) -> Option<String> {
    let stored = accounts
        .setting(&setting_key(id))
        .await
        .unwrap_or_else(|e| {
            tracing::error!("could not read the {id} client id: {e:#}");
            None
        })
        .filter(|s| !s.trim().is_empty());

    stored.or_else(|| {
        find(id)
            .map(|p| p.client_id.to_string())
            .filter(|s| !s.trim().is_empty())
    })
}

pub const PROVIDERS: &[Provider] = &[Provider {
    id: "github",
    label: "GitHub",
    device_code_url: "https://github.com/login/device/code",
    token_url: "https://github.com/login/oauth/access_token",
    api_base: "https://api.github.com",
    // `repo` covers reading a private repository and pushing the session's
    // branch. Asking for the write half now avoids a second authorization
    // later, when the branch is ready and the interruption is worst.
    scopes: "repo",
    git_username: "x-access-token",
    git_host: "github.com",
    // Empty means every install has to register its own application before it
    // can authorize GitHub — a five-minute job the README apologises for at
    // length, and a place people give up.
    //
    // This is the one line to change to end that. A device-flow client id is
    // public by design and has no paired secret, so a Firetower-owned one can
    // ship in the source and in the image; anyone who would rather use their
    // own still enters it in the interface, and a stored one wins over this.
    // What it costs is that the approval screen shows our application's name,
    // and its rate limit is shared.
    client_id: "",
}];

pub fn find(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// Which host, if any, a clone URL belongs to.
///
/// Matching on the hostname rather than remembering which provider a repository
/// came from means a remote pasted by hand still picks up the right token.
pub fn for_remote(remote: &str) -> Option<&'static Provider> {
    // Peel off the scheme, then any `user@`, and whatever is left up to the
    // first `/` or `:` is the host. Covers both URL shapes and leaves a local
    // path matching nothing, which is what we want.
    let after_scheme = remote.split_once("://").map_or(remote, |(_, rest)| rest);
    let after_user = after_scheme
        .split_once('@')
        .map_or(after_scheme, |(_, rest)| rest);
    let host = after_user.split(['/', ':']).next()?;

    PROVIDERS.iter().find(|p| p.git_host == host)
}

/// What the interface shows on the connect screen.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub label: String,
    /// We hold a token for it.
    pub connected: bool,
    /// False when nobody has registered an application for this build, which is
    /// a setup problem rather than something the person using it did wrong.
    pub configured: bool,
    /// Set while an authorization is in flight.
    pub pending: Option<PendingAuth>,
}

/// A device authorization waiting for someone to approve it in a browser.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuth {
    /// The short code to type. Shown, not clicked.
    pub user_code: String,
    /// Where to type it.
    pub verification_uri: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With nothing compiled in and nothing stored, the flow has to refuse
    /// rather than send an empty client_id and get a confusing answer back.
    #[tokio::test]
    async fn an_unconfigured_build_says_so_rather_than_authorizing_with_nothing() {
        let db = crate::db::Db::open_for_test().await.unwrap();
        let accounts = crate::accounts::Accounts::new(db.pool().clone());

        if find("github").unwrap().client_id.is_empty() {
            assert!(client_id(&accounts, "github").await.is_none());
        }

        // And a stored one is what it then uses.
        accounts
            .set_setting(&setting_key("github"), "Ov23liSTORED")
            .await
            .unwrap();
        assert_eq!(
            client_id(&accounts, "github").await.as_deref(),
            Some("Ov23liSTORED")
        );
    }

    #[test]
    fn a_remote_finds_its_host_in_either_url_form() {
        for remote in [
            "https://github.com/acme/backend.git",
            "git@github.com:acme/backend.git",
            "ssh://git@github.com/acme/backend.git",
        ] {
            assert_eq!(for_remote(remote).map(|p| p.id), Some("github"), "{remote}");
        }
    }

    #[test]
    fn a_remote_we_host_nothing_for_matches_nothing() {
        // A self-hosted remote or a local path has no token, and must not
        // silently borrow one belonging to somewhere else.
        for remote in [
            "https://git.internal.example/acme/backend.git",
            "/Users/someone/code/backend",
        ] {
            assert!(for_remote(remote).is_none(), "{remote}");
        }
    }

    #[test]
    fn every_provider_has_the_four_urls_it_needs() {
        for p in PROVIDERS {
            for url in [p.device_code_url, p.token_url, p.api_base] {
                assert!(url.starts_with("https://"), "{} has {url}", p.id);
            }
            assert!(!p.scopes.is_empty(), "{} asks for no access", p.id);
        }
    }
}
