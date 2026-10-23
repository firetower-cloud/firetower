//! The git hosts Firetower can authorize against.
//!
//! Two halves, and the split is the whole design.
//!
//! A [`Kind`] is what is true of the *software*: the dialect its API speaks,
//! the shape of its URLs, what it calls a request to merge a branch, which ways
//! of signing in it has. There are three of them, they are `&'static`, and
//! adding a fourth is an entry in [`KINDS`].
//!
//! A [`Connection`] is one *instance* of a kind, and it is a row. Its address
//! cannot be compiled in — a GitLab somebody runs themselves is reachable at a
//! name only they know — and there can be more than one of them, which is what
//! a person with a personal and a work account has. The application it
//! authorizes against belongs here too, because it is registered on that
//! instance and nowhere else.
//!
//! The token belongs to neither. It stays in the vault at `git/<id>/<owner>`,
//! one per person per connection, exactly as it did when there was one host.
//! Which is why the built-in connection's id is the literal string `github`
//! rather than something generated: every key already written against it —
//! vault rows, `git_identities.provider`, the `github:` on a task key, the
//! `/api/v1/providers/github/…` paths three clients call — still resolves.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

/// How a person gets a token for a host.
///
/// A property of the *instance*, not of the kind, which is the thing that
/// surprised us: Gitea has no device flow at all, and GitLab only grew one in
/// 17.9 — so an operator with a 16.x instance and an operator with a 17.11 one
/// need different screens for the same software.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    /// The device authorization grant. One application registered for the
    /// installation, a short code approved in a browser, a token each.
    Device,
    /// Everybody makes a token on the host and pastes it. Nothing to register,
    /// and the only option on a host with no device flow.
    Token,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Device => "device",
            AuthMode::Token => "token",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "token" => AuthMode::Token,
            _ => AuthMode::Device,
        }
    }
}

/// Everything that differs between one git host *product* and another.
#[derive(Debug)]
pub struct Kind {
    /// Stable identifier. Also the id of the built-in connection for the kind
    /// that has one, which is what keeps every existing key resolving.
    pub id: &'static str,
    pub label: &'static str,
    /// What this host calls a request to merge a branch, in the singular and in
    /// lower case: the interface puts it in the middle of a sentence.
    ///
    /// Carried rather than looked up per screen because three clients draw it
    /// and "pull request" on a GitLab is the kind of wrongness that makes
    /// somebody distrust everything else on the panel.
    pub change_noun: &'static str,
    /// The ways in, best first. The first one a new connection defaults to.
    pub auth: &'static [AuthMode],
    /// The narrowest access that covers cloning, pushing a branch and opening a
    /// request. Only asked for by the device flow; a pasted token's scopes were
    /// chosen by whoever pasted it.
    pub scopes: &'static str,
    /// Git insists on a username beside the token, and all three hosts read the
    /// token out of the password and ignore this.
    ///
    /// Checked against a real Gitea 1.22, because that is the one this was
    /// expected to be wrong about: `tester`, `oauth2`, `x-access-token` and the
    /// token itself all clone and push a private repository. So it is a
    /// constant per kind, in whatever form that host's own documentation uses.
    pub git_username: &'static str,
    /// Where a device authorization starts, under the web address.
    pub device_path: &'static str,
    /// Where a device code is exchanged for a token, under the web address.
    pub token_path: &'static str,
    /// Where somebody makes a token by hand, under the web address.
    pub token_page: &'static str,
    /// Where somebody registers an application, under the web address.
    pub app_page: &'static str,
    /// How to make a token by hand, in the order it is done.
    ///
    /// The counterpart to `app_steps`, for the other way in. Gitea is why it
    /// exists: its tokens are scoped, the scopes are not obvious from what
    /// Firetower does, and the one people reach for first — repository only —
    /// produces a token that authenticates fine and then shows an empty
    /// repository picker, because listing your own repositories is a *user*
    /// endpoint. Checked against a real 1.22 rather than reasoned about; see
    /// the scope notes on each entry.
    ///
    /// Empty where the host needs no explanation beyond the link.
    pub token_steps: &'static [&'static str],
    /// How to register one, in the order it is done.
    ///
    /// Here rather than in the interface because it is dialect: the step that
    /// catches people out is different on each host, and three clients copying
    /// it is three copies to get wrong. On GitHub it is a checkbox below the
    /// fold that is off by default; on GitLab it is a checkbox that is *on* by
    /// default and has to come off. Both fail identically to a wrong client id,
    /// which is why they are written down rather than left to be discovered.
    pub app_steps: &'static [&'static str],
    /// Something cheap and unauthenticated under the API root, for finding out
    /// whether an address is this kind of host and which version of it.
    pub probe_path: &'static str,
    /// Whether a project can sit inside nested groups, so that a slug has more
    /// than two segments.
    ///
    /// GitLab's do. It is the reason a slug cannot be "the last two path
    /// segments" any more: `platform/infra/deploy` truncated to `infra/deploy`
    /// addresses nothing, and every call made with it comes back 404.
    pub nested_groups: bool,
    /// The hosted instance, for the kind that has one. `None` means the only
    /// way to have one of these is to say where it is.
    pub hosted: Option<Hosted>,
    /// What this kind is called when somebody runs it themselves.
    ///
    /// Not a cosmetic difference: "GitHub Enterprise Server" is the name of a
    /// product somebody bought, and a list that only said "GitHub" would never
    /// tell them it was supported. The same for Forgejo, which is Gitea's fork
    /// and answers the same API — nobody running one would think to look under
    /// "Gitea" unless the list says so.
    pub self_hosted_label: &'static str,
    /// Set at build time by whoever publishes Firetower.
    ///
    /// A device-flow client identifier is public by design — there is no paired
    /// secret and nothing to protect — which is exactly why this flow suits an
    /// application that ships as source.
    pub client_id: &'static str,
}

/// The instance of a kind that Firetower knows about without being told.
#[derive(Debug)]
pub struct Hosted {
    pub base_url: &'static str,
    /// Spelled out rather than derived: GitHub.com answers on `api.github.com`
    /// while GitHub Enterprise answers at `/api/v3` on the same host as the web
    /// interface. That is not a rule with an exception, it is two facts.
    pub api_base: &'static str,
    pub git_host: &'static str,
}

pub const KINDS: &[Kind] = &[
    Kind {
        id: "github",
        label: "GitHub",
        change_noun: "pull request",
        auth: &[AuthMode::Device, AuthMode::Token],
        // `repo` covers private repositories and ordinary branch pushes.
        // GitHub also requires `workflow` when a push adds or updates a file
        // under `.github/workflows/`, so request it with each new authorization.
        scopes: "repo workflow",
        git_username: "x-access-token",
        device_path: "/login/device/code",
        token_path: "/login/oauth/access_token",
        token_page: "/settings/tokens/new?scopes=repo,workflow&description=Firetower",
        // The link carries the scopes already ticked, so there is nothing to
        // explain that the page does not arrive with.
        token_steps: &[],
        app_page: "/settings/applications/new",
        app_steps: &[
            "Settings → Developer settings → OAuth Apps → New OAuth App.",
            "Name it anything. Both URLs go unused — this flow never redirects — so \
             put http://localhost in each.",
            "Tick **Enable Device Flow** — it is below the fold, and nothing works \
             without it.",
            "Register it, and copy the Client ID.",
        ],
        probe_path: "/meta",
        nested_groups: false,
        hosted: Some(Hosted {
            base_url: "https://github.com",
            api_base: "https://api.github.com",
            git_host: "github.com",
        }),
        self_hosted_label: "GitHub Enterprise Server",
        // Firetower's own, so a fresh install can authorize GitHub without
        // anybody registering anything first — which was a five-minute job the
        // README apologised for at length, and a place people gave up.
        //
        // **Public by design.** A device-flow application has no paired secret;
        // this identifier is sent in a request anybody can make, and holding it
        // grants nothing. No token ever reaches us: each one is minted straight
        // to the installation that asked and sealed in its own vault.
        //
        // Two things it costs, and both are why a stored one wins over it:
        //
        //   * the approval screen shows *our* name and asks for `repo`, which
        //     an organization reviewing third-party applications may refuse;
        //   * **50 authorizations an hour, shared by every installation that
        //     uses it** — GitHub's device flow limits verification-code
        //     submissions per application, not per user. Invisible at a
        //     trickle, and hit exactly on a good day. `oauth::start` says so
        //     in those words and points at the two ways through.
        //
        // Only ever offered to github.com itself — see `shipped_client_id`.
        client_id: "Ov23liX2nrAIOAlzx9Ya",
    },
    Kind {
        id: "gitlab",
        label: "GitLab",
        change_noun: "merge request",
        // Device first where it exists, but a GitLab older than 17.9 has no
        // such grant and answers the attempt with a refusal that reads like a
        // bad client id. The connect screen asks the instance before it offers
        // this, rather than letting somebody find out that way.
        auth: &[AuthMode::Device, AuthMode::Token],
        // `api` is GitLab's broad read-write scope, which is what listing
        // projects and opening merge requests needs; `write_repository` is what
        // pushing over https needs and is not implied by it.
        scopes: "api write_repository",
        // Ignored by GitLab, which reads the token out of the password. `oauth2`
        // is the form its own documentation uses, and it works for a personal
        // access token as well as for an OAuth one.
        git_username: "oauth2",
        device_path: "/oauth/authorize_device",
        token_path: "/oauth/token",
        token_page:
            "/-/user_settings/personal_access_tokens?name=Firetower&scopes=api,write_repository",
        // Also pre-ticked by the link.
        token_steps: &[],
        app_page: "/-/user_settings/applications",
        // No step about grant types, and that is deliberate: an earlier draft
        // told people to allow `device_code`, and GitLab's application form has
        // no such field — name, redirect URI, Confidential and scopes are all
        // of it, checked against a running 18.0. The grant is available on the
        // instance or it is not, which is what the version check is for.
        app_steps: &[
            "Group settings → Applications, or your own user settings for a personal one. \
             A group owns it longer than a person does.",
            "Name it. The redirect URI goes unused — http://localhost will do.",
            "**Untick Confidential.** It is ticked by default, and a confidential \
             application needs a secret this flow has none of.",
            "Tick the `api` and `write_repository` scopes.",
            "Copy the Application ID.",
        ],
        // Needs a token on most instances, so a 401 here is a success as far as
        // the probe is concerned: it proves something GitLab-shaped answered.
        probe_path: "/version",
        nested_groups: true,
        hosted: Some(Hosted {
            base_url: "https://gitlab.com",
            api_base: "https://gitlab.com/api/v4",
            git_host: "gitlab.com",
        }),
        self_hosted_label: "GitLab, self-managed",
        // Firetower's own, for gitlab.com only — see `shipped_client_id`. A
        // self-managed instance cannot use it: an application is registered on
        // one server and exists nowhere else, which is also why it is offered
        // to the hosted instance and nothing else.
        //
        // Registered as a *public* client. GitLab calls the opposite
        // "Confidential" and ticks it by default, and a confidential
        // application refuses the device flow outright — there is no secret to
        // send and GitLab will not proceed without one.
        client_id: "1b4d1313604825fa043fba4edab984c58ba013bfdd90a6f66f5b9fb7a2a05d32",
    },
    Kind {
        id: "gitea",
        label: "Gitea",
        change_noun: "pull request",
        // Gitea implements the authorization code grant with PKCE and nothing
        // else — there is no device flow to offer, at any version.
        auth: &[AuthMode::Token],
        scopes: "",
        // Gitea does not check it either, which is worth writing down because
        // it was expected to: its documentation shows the account's own login
        // here, so the first draft of this asked the host for it and kept it in
        // a column. Against a real 1.22 every username works, so the column
        // went.
        git_username: "token",
        device_path: "",
        token_path: "",
        token_page: "/user/settings/applications",
        // **Gitea cannot pre-tick anything**, so this is the one kind where
        // the steps have to carry the scopes — and getting them wrong is not
        // an error anybody can read. Each line below was checked against a
        // running 1.22:
        //
        //   * `user` Read — `/user` and `/user/repos`. Without it the picker
        //     is empty and the commit identity is unknown, and *both* still
        //     happen with full repository access, because listing your own
        //     repositories is a user endpoint rather than a repository one.
        //     This is the one people miss.
        //   * `repository` Read and Write — cloning, pushing a branch, and
        //     opening or amending a pull request. Read alone clones and is
        //     refused on push with a bare `Forbidden`.
        //   * `issue` Read — reading issues and pull requests as tasks. Only
        //     the Tasks screen needs it, so it is named as optional.
        token_steps: &[
            "Settings → Applications → Manage Access Tokens.",
            "Name it, then open **Select permissions**.",
            "Set **user** to Read — without it the repository list comes back \
             empty however much repository access the token has.",
            "Set **repository** to Read and Write — read alone clones but \
             cannot push.",
            "Set **issue** to Read if you want to pick up work from Gitea. \
             Cloning and pushing do not need it.",
            "Generate it, and copy the token before leaving the page.",
        ],
        app_page: "/user/settings/applications",
        // Gitea has no device flow, so there is no application to register and
        // nothing to explain. Everybody connects it with a token.
        app_steps: &[],
        probe_path: "/version",
        nested_groups: false,
        // No hosted instance worth defaulting to. gitea.com exists, but nobody
        // reaches for Gitea in order to use somebody else's.
        hosted: None,
        // Forgejo is Gitea's fork and answers the same API, so it connects as
        // one — and somebody running Forgejo would never find that out from a
        // list that only said "Gitea".
        self_hosted_label: "Gitea or Forgejo",
        client_id: "",
    },
];

pub fn kind(id: &str) -> Option<&'static Kind> {
    KINDS.iter().find(|k| k.id == id)
}

/// Where a kind's hosted instance sits in the list.
///
/// The same number the migrations seed — github.com 0, gitlab.com 1 — because
/// [`KINDS`] is the order those were written in. It is here so that taking a
/// shipped host out and putting it back restores its *place* as well as its id
/// and its `builtin` flag: a client reading the first entry is reading the
/// built-in GitHub, and a re-added one landing at the end of the list would
/// quietly point it at somebody else's host.
fn well_known_position(kind: &'static Kind) -> i32 {
    KINDS.iter().position(|k| k.id == kind.id).unwrap_or(0) as i32
}

/// Where an operator-supplied client id used to be kept.
///
/// Still written, never read. The client id lives on the connection row now,
/// and the migration copied this one onto it — but a control plane rolled back
/// to before that migration reads this key and has to still find the value
/// there. So [`crate::api::providers::set_client_id`] writes both for the
/// built-in host, and this is the breadcrumb half.
pub fn setting_key(id: &str) -> String {
    format!("{id}.client_id")
}

/// One git host this Firetower can reach.
#[derive(Debug, Clone)]
pub struct Connection {
    /// `github` for the built-in one, and a generated id for the rest.
    pub id: String,
    pub kind: &'static Kind,
    /// What everybody here sees. Theirs to choose, because two GitHubs in one
    /// list is the arrangement this exists to support and "GitHub" twice is
    /// not a list anybody can pick from.
    pub label: String,
    /// Where a person reads it in a browser. No trailing slash.
    pub base_url: String,
    pub api_base: String,
    pub git_host: String,
    pub auth: AuthMode,
    pub client_id: Option<String>,
    pub version: Option<String>,
    /// The compiled-in one. Its address is not somebody's to edit and it is not
    /// theirs to remove — signing out of it is a different thing, and still
    /// works.
    pub builtin: bool,
    pub position: i32,
}

impl Connection {
    /// Where a device authorization starts.
    pub fn device_code_url(&self) -> String {
        format!("{}{}", self.base_url, self.kind.device_path)
    }

    /// Where a device code is exchanged for a token.
    pub fn device_token_url(&self) -> String {
        format!("{}{}", self.base_url, self.kind.token_path)
    }

    /// Where somebody goes to make a token by hand.
    pub fn token_page(&self) -> String {
        format!("{}{}", self.base_url, self.kind.token_page)
    }

    /// Where somebody goes to register an application.
    pub fn app_page(&self) -> String {
        format!("{}{}", self.base_url, self.kind.app_page)
    }

    /// Where this application's access is reviewed on the host.
    ///
    /// The only place an organization that restricts third-party applications
    /// can be granted after the fact, and the address of it contains the client
    /// id. GitHub only: nothing equivalent exists on the other two, and a link
    /// to a page that is not there is worse than no link.
    pub fn access_page(&self) -> Option<String> {
        let id = self.client_id.as_deref()?.trim();
        (!id.is_empty() && self.kind.id == "github")
            .then(|| format!("{}/settings/connections/applications/{id}", self.base_url))
    }

    /// The identifier to authorize with, if there is one.
    ///
    /// What is stored on the row first, then whatever this build was compiled
    /// with. There is deliberately no environment variable: this is answered in
    /// the setup wizard, or on the connect screen at the moment it is missed,
    /// and a value that can also come from a file is a value someone will
    /// change in the interface and then find unchanged.
    pub fn client_id(&self) -> Option<String> {
        self.client_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| self.shipped_client_id().map(str::to_string))
    }

    /// The application Firetower ships, *if it applies to this host*.
    ///
    /// **Only to the rows that ship** — github.com and gitlab.com, both marked
    /// `builtin` by a migration. Two reasons, and they are different:
    ///
    /// An application is registered on one server and exists nowhere else, so
    /// the one Firetower registered on github.com means nothing to somebody's
    /// GitHub Enterprise, and a self-managed GitLab cannot use gitlab.com's.
    /// Without a guard, shipping a default made every Enterprise and
    /// self-managed host report itself configured and draw a Connect button
    /// that could only ever fail, with the host blaming the client id.
    ///
    /// And a host an administrator *adds* is theirs even where the address
    /// matches: a second github.com account under our application would carry
    /// our name on its approval screen, and would queue behind every other
    /// installation for GitHub's 50 authorizations an hour per application. So
    /// an added host is asked for its own, with the steps to make one.
    pub fn shipped_client_id(&self) -> Option<&'static str> {
        (self.builtin && !self.kind.client_id.trim().is_empty()).then_some(self.kind.client_id)
    }

    /// Whether the application in use is the one Firetower ships rather than
    /// one registered here.
    ///
    /// Sent to the interface so it can say so and offer to replace it: an
    /// application shows its owner's name on the approval screen and carries a
    /// rate limit shared with every other installation, and both are reasons
    /// somebody might want their own.
    pub fn uses_shipped_application(&self) -> bool {
        self.client_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
            && self.shipped_client_id().is_some()
    }

    /// Whether this host can be authorized at all, or is waiting on somebody to
    /// register an application for it.
    ///
    /// A token host is always ready: there is nothing to register, which is most
    /// of why it is the fallback everywhere.
    pub fn configured(&self) -> bool {
        match self.auth {
            AuthMode::Device => self.client_id().is_some(),
            AuthMode::Token => true,
        }
    }
}

/// What the interface needs to draw one before it has been saved.
#[derive(Debug, Clone)]
pub struct NewConnection {
    pub kind: &'static Kind,
    pub label: String,
    pub base_url: String,
    pub api_base: String,
    pub git_host: String,
    pub auth: AuthMode,
    pub client_id: Option<String>,
    pub version: Option<String>,
}

/// Normalize what somebody typed into a base address.
///
/// People paste `gitlab.acme.internal`, `https://gitlab.acme.internal/`, and
/// occasionally the whole address of a project page. The first two are the same
/// host and have to be treated as such, or the uniqueness check lets the same
/// instance in twice.
pub fn normalize_base(typed: &str) -> Result<(String, String)> {
    let trimmed = typed.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        anyhow::bail!("an address is needed");
    }

    // Default to https rather than refusing. A git host reached over plain http
    // is somebody's lab, and they can say so explicitly.
    let with_scheme = match trimmed.contains("://") {
        true => trimmed.to_string(),
        false => format!("https://{trimmed}"),
    };

    let (scheme, rest) = with_scheme
        .split_once("://")
        .context("that does not look like an address")?;
    if scheme != "http" && scheme != "https" {
        anyhow::bail!("{scheme} is not an address Firetower can reach");
    }

    // Keep any path prefix: a GitLab behind a reverse proxy at /gitlab is a
    // real deployment, and dropping the prefix makes every call 404.
    let rest = rest.trim_end_matches('/');

    // Read with the same function every lookup uses, rather than a second
    // parser beside it. The two disagreed about the port, which stored a host
    // as `localhost:3210` and then asked for `localhost` — so a repository on
    // it never found its token.
    let host = host_of(&with_scheme).with_context(|| format!("{typed} has no hostname in it"))?;

    Ok((format!("{scheme}://{rest}"), host))
}

/// Where a kind's API lives under a web address.
///
/// GitHub is the odd one: on github.com the API is on another hostname
/// entirely, and on an Enterprise install it is a path on the same one.
pub fn api_base_for(kind: &'static Kind, base_url: &str) -> String {
    match kind.id {
        "github" => match kind.hosted.as_ref().map(|h| h.base_url) == Some(base_url) {
            true => kind
                .hosted
                .as_ref()
                .map(|h| h.api_base.to_string())
                .unwrap_or_default(),
            false => format!("{base_url}/api/v3"),
        },
        "gitlab" => format!("{base_url}/api/v4"),
        "gitea" => format!("{base_url}/api/v1"),
        _ => base_url.to_string(),
    }
}

/// A device authorization waiting for someone to approve it in a browser.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PendingAuth {
    /// The short code. Always shown, even where the link below carries it, so
    /// somebody can check the page is showing the code they were given.
    ///
    /// Empty where there is no code to check: an agent login that is link-only
    /// — Cursor approves in the browser and hands the credential back — has
    /// nothing to type, and a client reads an empty string as "show the link".
    pub user_code: String,
    /// Where to type it.
    ///
    /// The host's page with the code already filled in, where the host offers
    /// one — GitLab does, GitHub does not — and the bare page otherwise. The
    /// interface opens this and does not need to know which it got.
    pub verification_uri: String,
}

/// What the interface shows on the connect screen, one per host.
///
/// Still called a provider, and still served from `/api/v1/providers`, because
/// three committed clients already read it under that name and a rename buys a
/// word. The fields after `may_set_application` are the new ones; everything
/// above it means what it always did.
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
    /// The identifier being authorized against, when there is one.
    ///
    /// Public by design: a device-flow application has no paired secret.
    pub client_id: Option<String>,
    /// Whether the caller may register the application this whole installation
    /// authorizes against.
    ///
    /// Sent rather than worked out by each client, the way `may_upgrade` is.
    /// The rule is the server's — one application per host, no owner, and
    /// whoever sets it decides what everybody here authorizes next — and a copy
    /// of it in three interfaces is three copies to keep in step.
    pub may_set_application: bool,
    /// Which software: `github`, `gitlab`, `gitea`. What decides the mark drawn
    /// beside the row and the dialect of everything underneath.
    pub kind: String,
    /// Where a person reads it in a browser.
    pub base_url: String,
    /// The hostname in a clone URL. Shown under the label, because it is the
    /// only thing that tells two GitHubs apart.
    pub git_host: String,
    pub auth: AuthMode,
    /// Every way this kind can be connected, so the edit screen can offer them
    /// without knowing what Firetower knows about Gitea.
    pub auth_modes: Vec<AuthMode>,
    /// What this host calls a request to merge a branch.
    pub change_noun: String,
    /// What the instance said it was, when one was last reached.
    pub version: Option<String>,
    /// The compiled-in host. Not removable, and its address is not editable.
    pub builtin: bool,
    /// Where somebody makes a token by hand, for a host that connects that way.
    pub token_page: String,
    /// Where somebody registers an application, for a host that needs one.
    pub app_page: String,
    /// Where this application's access is reviewed. GitHub only.
    pub access_page: Option<String>,
    /// The application in use is the one Firetower ships, not one registered
    /// here.
    ///
    /// Drawn as a line offering to replace it, because there are two reasons
    /// somebody would want to: the approval screen carries our name and asks
    /// for broad access, and the shared application's 50-authorizations-an-hour
    /// ceiling is drawn on by every other installation using it.
    pub shared_application: bool,
}

/// What can be added, for the kind picker on the add screen.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct KindInfo {
    pub id: String,
    pub label: String,
    pub change_noun: String,
    pub auth_modes: Vec<AuthMode>,
    /// The hosted instance's address, when there is one to offer as a default.
    pub hosted_base_url: Option<String>,
    /// Whether this kind needs an address typed in, which is every kind with no
    /// hosted instance and every self-hosted one of the others.
    pub self_hosted: bool,
    /// Where somebody registers an application on the hosted instance, and how.
    ///
    /// Relative to whatever address is being added, so the add screen can link
    /// straight at it once it knows where the host is.
    pub app_page: String,
    pub app_steps: Vec<String>,
    /// How to make a token by hand. Empty where the link does it for you.
    pub token_steps: Vec<String>,
    /// What it is called when somebody runs it themselves — `GitHub Enterprise
    /// Server`, `Gitea or Forgejo`.
    ///
    /// The add screen lists the hosted and the self-hosted forms as separate
    /// things to pick, because they are separate products to the person
    /// picking, and a list that collapsed them would never tell anybody that
    /// their Enterprise install or their Forgejo was supported at all.
    pub self_hosted_label: String,
}

pub fn kinds() -> Vec<KindInfo> {
    KINDS
        .iter()
        .map(|k| KindInfo {
            id: k.id.to_string(),
            label: k.label.to_string(),
            change_noun: k.change_noun.to_string(),
            auth_modes: k.auth.to_vec(),
            app_page: k.app_page.to_string(),
            app_steps: k.app_steps.iter().map(|s| s.to_string()).collect(),
            token_steps: k.token_steps.iter().map(|s| s.to_string()).collect(),
            hosted_base_url: k.hosted.as_ref().map(|h| h.base_url.to_string()),
            self_hosted: k.hosted.is_none(),
            self_hosted_label: k.self_hosted_label.to_string(),
        })
        .collect()
}

/// Every git host this Firetower knows about, and the lookups over them.
///
/// Cached because the answer is wanted on paths that run per repository and per
/// push, and it changes only when somebody adds a host. Loaded once at start-up
/// and replaced wholesale by [`Connections::reload`] — a whole new `Vec` behind
/// one `Arc`, so a reader holding the old one is never looking at a half-built
/// list.
#[derive(Clone)]
pub struct Connections {
    pool: sqlx::PgPool,
    cache: Arc<tokio::sync::RwLock<Arc<Vec<Arc<Connection>>>>>,
}

impl Connections {
    pub fn new(pool: sqlx::PgPool) -> Self {
        Self {
            pool,
            cache: Arc::new(tokio::sync::RwLock::new(Arc::new(Vec::new()))),
        }
    }

    /// Made and filled in one step.
    ///
    /// The migration guarantees the built-in host is there, so a failure here
    /// is a database that cannot be read at all — which every caller would
    /// rather hear about now than on the first push.
    pub async fn opened(pool: sqlx::PgPool) -> Result<Self> {
        let it = Self::new(pool);
        it.reload().await?;
        Ok(it)
    }

    /// Read every row and replace the cache.
    pub async fn reload(&self) -> Result<()> {
        let rows = sqlx::query(
            "SELECT id, kind, label, base_url, api_base, git_host, auth, client_id,
                    version, builtin, position
               FROM git_connections
              ORDER BY position, created_at",
        )
        .fetch_all(&self.pool)
        .await
        .context("reading the git hosts")?;

        let mut out: Vec<Arc<Connection>> = Vec::new();
        for r in &rows {
            use sqlx::Row;
            let kind_id: String = r.get("kind");
            // A row naming a kind this build does not have is skipped and said
            // out loud. Refusing to start would make a downgrade unrecoverable
            // for somebody who had added a Gitea.
            let Some(kind) = kind(&kind_id) else {
                tracing::warn!(
                    kind = kind_id,
                    "a git host names a kind this build does not know; skipping it"
                );
                continue;
            };
            out.push(Arc::new(Connection {
                id: r.get("id"),
                kind,
                label: r.get("label"),
                base_url: r.get("base_url"),
                api_base: r.get("api_base"),
                git_host: r.get("git_host"),
                auth: AuthMode::parse(&r.get::<String, _>("auth")),
                client_id: r.get("client_id"),
                version: r.get("version"),
                builtin: r.get("builtin"),
                position: r.get("position"),
            }));
        }

        *self.cache.write().await = Arc::new(out);
        Ok(())
    }

    /// Every host, built-in first.
    ///
    /// The order is load-bearing rather than cosmetic. A desktop or mobile
    /// build older than this change reads the first entry and ignores the rest,
    /// so the first entry has to be the host it was already using — otherwise
    /// upgrading the control plane silently repoints an old client at somebody's
    /// new GitLab.
    pub async fn all(&self) -> Arc<Vec<Arc<Connection>>> {
        self.cache.read().await.clone()
    }

    pub async fn get(&self, id: &str) -> Option<Arc<Connection>> {
        self.all().await.iter().find(|c| c.id == id).cloned()
    }

    /// Which host, if any, a clone URL belongs to.
    ///
    /// Matching on the hostname rather than remembering which host a repository
    /// came from means a remote pasted by hand still picks up the right token.
    /// A repository that *has* a row of its own is answered from that instead —
    /// see [`crate::api::connection_for_repo`] — because two accounts on
    /// github.com are two hosts with one hostname, and only the row can say
    /// which of them this repository is on.
    pub async fn for_remote(&self, remote: &str) -> Option<Arc<Connection>> {
        let host = host_of(remote)?;
        self.all()
            .await
            .iter()
            .find(|c| c.git_host.eq_ignore_ascii_case(&host))
            .cloned()
    }

    /// Every host sharing a hostname with this remote, in list order.
    ///
    /// For the caller that can narrow it further by asking who holds a token.
    pub async fn all_for_remote(&self, remote: &str) -> Vec<Arc<Connection>> {
        let Some(host) = host_of(remote) else {
            return Vec::new();
        };
        self.all()
            .await
            .iter()
            .filter(|c| c.git_host.eq_ignore_ascii_case(&host))
            .cloned()
            .collect()
    }

    /// Add one, and put it in the cache.
    /// Whether a host added at this address would take the kind's well-known
    /// id — and with it the application Firetower ships.
    ///
    /// Asked *before* the row is written as well as while writing it, because
    /// it decides more than the id: `shipped_client_id` reads `builtin`, so
    /// this is also the answer to "can this host be connected in a browser
    /// without anybody registering anything". `default_auth` needs that to
    /// pick a way in that works immediately — without it, removing the shipped
    /// GitHub and putting it back came back on the token path, with a browser
    /// flow that would have worked sitting unoffered behind a menu.
    pub async fn would_be_builtin(&self, kind: &'static Kind, base_url: &str) -> bool {
        kind.hosted.as_ref().is_some_and(|h| h.base_url == base_url)
            && self.get(kind.id).await.is_none()
    }

    pub async fn create(&self, new: NewConnection) -> Result<Arc<Connection>> {
        // **The well-known id, where it is free.**
        //
        // A kind's hosted instance takes the kind's own name — `github` for
        // github.com — because that is what everything written before this
        // table existed is keyed on: vault rows at `git/github/<owner>`,
        // `git_identities.provider`, the `github:` on a task key, the
        // `/api/v1/providers/github/…` paths three clients call.
        //
        // It is *reuse* rather than a special case for the migration's row, and
        // that is what makes the built-in host removable. Take it out and put
        // it back and the id comes back with it, so every identity and task key
        // that referred to it is adopted again rather than stranded. Without
        // this, removing it was a one-way door and the only safe answer was to
        // forbid it — which left one row in everybody's list with no Remove on
        // it and no reason anybody outside this file could see.
        let well_known = self.would_be_builtin(new.kind, &new.base_url).await;

        let id = match well_known {
            true => new.kind.id.to_string(),
            false => format!(
                "{}_{}",
                new.kind.id,
                ulid::Ulid::new().to_string().to_lowercase()
            ),
        };

        sqlx::query(
            "INSERT INTO git_connections
                 (id, kind, label, base_url, api_base, git_host, auth, client_id, version,
                  builtin, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     coalesce($11, (SELECT coalesce(max(position), 0) + 1
                                    FROM git_connections)))",
        )
        .bind(&id)
        .bind(new.kind.id)
        .bind(new.label.trim())
        .bind(&new.base_url)
        .bind(&new.api_base)
        .bind(&new.git_host)
        .bind(new.auth.as_str())
        .bind(
            new.client_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        )
        .bind(new.version.as_deref())
        // **The flag travels with the id.** Taking the well-known id back
        // without it restored the row and silently lost the application
        // Firetower ships — `shipped_client_id` reads `builtin` — so removing
        // the shipped GitHub and putting it back left a host that looked right
        // and could not be connected.
        .bind(well_known)
        // **And its place in the list.** Last is right for a host somebody is
        // adding, and wrong for one coming back: the first entry is what a
        // client that has never heard of this table reads, and it has to still
        // be the built-in host afterwards.
        .bind(well_known.then(|| well_known_position(new.kind)))
        .execute(&self.pool)
        .await
        .context("adding the git host")?;

        self.reload().await?;
        self.get(&id)
            .await
            .context("the git host vanished after being added")
    }

    /// Change what somebody may change. Absent means "leave it alone".
    pub async fn update(
        &self,
        id: &str,
        label: Option<&str>,
        auth: Option<AuthMode>,
        client_id: Option<&str>,
    ) -> Result<()> {
        if let Some(label) = label.map(str::trim).filter(|s| !s.is_empty()) {
            sqlx::query("UPDATE git_connections SET label = $1 WHERE id = $2")
                .bind(label)
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        if let Some(auth) = auth {
            sqlx::query("UPDATE git_connections SET auth = $1 WHERE id = $2")
                .bind(auth.as_str())
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        if let Some(client_id) = client_id {
            // An empty string clears it, which is how somebody takes an
            // application back off a host they would rather connect by token.
            let value = client_id.trim();
            sqlx::query("UPDATE git_connections SET client_id = $1 WHERE id = $2")
                .bind((!value.is_empty()).then_some(value))
                .bind(id)
                .execute(&self.pool)
                .await?;
        }
        self.reload().await
    }

    /// What the instance last said it was. Written when a probe reaches one.
    pub async fn remember_version(&self, id: &str, version: &str) -> Result<()> {
        sqlx::query("UPDATE git_connections SET version = $1 WHERE id = $2")
            .bind(version)
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.reload().await
    }

    /// Remove one.
    ///
    /// Including the one the migration made. It used to be exempt, which put a
    /// row in everybody's list with no Remove on it and no rationale anybody
    /// outside this crate could see — and an installation that does not use
    /// GitHub at all could never be rid of it. The exemption was protecting an
    /// id rather than a person: re-adding gave a fresh one and stranded
    /// whatever referred to the old. [`Connections::create`] reusing the
    /// well-known id removes that reason.
    pub async fn delete(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM git_connections WHERE id = $1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.reload().await
    }

    /// Whether this address is already connected under this kind.
    pub async fn address_taken(&self, kind: &str, git_host: &str, label: &str) -> bool {
        self.all().await.iter().any(|c| {
            c.kind.id == kind
                && c.git_host.eq_ignore_ascii_case(git_host)
                && c.label.trim().eq_ignore_ascii_case(label.trim())
        })
    }
}

/// The host out of a clone URL, in either of git's two shapes — **with its
/// port**, when it has one.
///
/// The port is part of the answer because it is part of the host: two instances
/// on two ports of one machine are two hosts, which is the ordinary shape of
/// somebody's lab. Leaving it off had `git_host` stored as `localhost:3210`
/// while every lookup asked for `localhost`, so a repository on it never found
/// its token.
///
/// The awkward case is git's scp-like form, where the `:` is a path separator
/// rather than a port: `git@github.com:acme/backend.git`. A port is all digits,
/// and `acme` is not, which is the whole of how they are told apart.
pub fn host_of(remote: &str) -> Option<String> {
    let remote = remote.trim();

    // A path on the machine, before anything else. `../sibling` splits into a
    // first segment of `..`, which has a dot in it and would otherwise read as
    // a hostname — and a repository matched to a host it is not on is handed a
    // token that opens nothing.
    if remote.starts_with('/') || remote.starts_with('.') || remote.starts_with('~') {
        return None;
    }

    let after_scheme = remote.split_once("://").map_or(remote, |(_, rest)| rest);
    let after_user = after_scheme
        .split_once('@')
        .map_or(after_scheme, |(_, rest)| rest);

    // Up to the first `/`: everything the authority can be.
    let authority = after_user.split('/').next()?;
    let (host, port) = match authority.split_once(':') {
        // All digits is a port. Anything else is the scp form's path, and the
        // host is what came before the colon.
        Some((host, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => {
            (host, Some(tail))
        }
        Some((host, _)) => (host, None),
        None => (authority, None),
    };

    // A name, not a path fragment: a label either side of a dot, or localhost.
    let named = host
        .split_once('.')
        .is_some_and(|(before, after)| !before.is_empty() && !after.is_empty() && after != ".");
    if !named && host != "localhost" {
        return None;
    }

    Some(match port {
        Some(port) => format!("{}:{port}", host.to_ascii_lowercase()),
        None => host.to_ascii_lowercase(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github() -> Connection {
        Connection {
            id: "github".into(),
            kind: kind("github").unwrap(),
            label: "GitHub".into(),
            base_url: "https://github.com".into(),
            api_base: "https://api.github.com".into(),
            git_host: "github.com".into(),
            auth: AuthMode::Device,
            client_id: Some("Ov23liEXAMPLE".into()),
            version: None,
            builtin: true,
            position: 0,
        }
    }

    /// The whole of the backward-compatibility argument, in one assertion. The
    /// built-in host's id is what every vault row, every `git_identities` row
    /// and every task key already written is keyed on, and a generated id here
    /// would orphan all of them.
    #[test]
    fn the_built_in_host_is_still_called_github() {
        assert_eq!(kind("github").unwrap().id, "github");
    }

    #[test]
    fn a_remote_finds_its_host_in_either_url_form() {
        for remote in [
            "https://github.com/acme/backend.git",
            "git@github.com:acme/backend.git",
            "ssh://git@github.com/acme/backend.git",
        ] {
            assert_eq!(host_of(remote).as_deref(), Some("github.com"), "{remote}");
        }
    }

    /// `../sibling` has a dot in its first segment, so a hostname read off it
    /// naively comes out as `..` — and a repository matched to a host it is not
    /// on is handed a token that opens nothing.
    #[test]
    fn a_local_path_is_not_a_host() {
        for remote in [
            "/Users/someone/code/backend",
            "../sibling",
            "./here",
            "~/work/api",
            ".",
            "..",
        ] {
            assert!(host_of(remote).is_none(), "{remote}");
        }
    }

    /// A bare name with no dot is not a host either — except localhost, which
    /// is where somebody's lab instance actually is.
    #[test]
    fn localhost_is_a_host_and_a_bare_word_is_not() {
        assert_eq!(
            host_of("http://localhost:3000/acme/web").as_deref(),
            Some("localhost:3000")
        );
        assert_eq!(
            host_of("http://localhost/acme/web").as_deref(),
            Some("localhost")
        );
        assert!(host_of("backend").is_none());
        assert!(host_of("my-repo/thing").is_none());
    }

    /// The port is part of the host, and the scp form's colon is not a port.
    ///
    /// Found against a real Gitea on `localhost:3210`: the connection was
    /// stored with `git_host = "localhost:3210"` while every lookup asked for
    /// `localhost`, so the repository on it never found its token and every
    /// clone fell back to whatever credentials the worker happened to have.
    #[test]
    fn a_port_is_part_of_the_host_and_a_path_is_not() {
        // A port, kept.
        assert_eq!(
            host_of("http://localhost:3210/tester/infra.git").as_deref(),
            Some("localhost:3210")
        );
        assert_eq!(
            host_of("https://git.acme.internal:8443/acme/web.git").as_deref(),
            Some("git.acme.internal:8443")
        );
        // The scp form, where `:` separates the path. `acme` is not a port.
        assert_eq!(
            host_of("git@github.com:acme/backend.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            host_of("git@git.acme.internal:platform/infra/deploy.git").as_deref(),
            Some("git.acme.internal")
        );
        // ssh with a port is a URL, so the port is a port.
        assert_eq!(
            host_of("ssh://git@git.acme.internal:2222/acme/web.git").as_deref(),
            Some("git.acme.internal:2222")
        );
    }

    /// The two parsers have to agree, which is why one of them calls the other.
    #[test]
    fn an_address_and_a_remote_on_it_read_the_same_host() {
        for (typed, remote) in [
            (
                "http://localhost:3210",
                "http://localhost:3210/tester/infra.git",
            ),
            (
                "https://git.acme.internal",
                "https://git.acme.internal/acme/web.git",
            ),
            (
                "https://git.acme.internal:8443",
                "https://git.acme.internal:8443/acme/web.git",
            ),
            (
                "https://acme.example/gitlab",
                "https://acme.example/gitlab/acme/web.git",
            ),
        ] {
            let (_, from_address) = normalize_base(typed).unwrap();
            assert_eq!(
                Some(from_address.as_str()),
                host_of(remote).as_deref(),
                "{typed} vs {remote}"
            );
        }
    }

    /// A self-hosted host is told apart by its name, so the match has to be on
    /// the whole of it.
    #[test]
    fn a_self_hosted_remote_keeps_its_own_hostname() {
        assert_eq!(
            host_of("https://git.internal.example/acme/backend.git").as_deref(),
            Some("git.internal.example")
        );
    }

    #[test]
    fn an_address_is_normalized_whatever_was_pasted() {
        for typed in [
            "gitlab.acme.internal",
            "https://gitlab.acme.internal",
            "https://gitlab.acme.internal/",
            "  gitlab.acme.internal/  ",
        ] {
            let (base, host) = normalize_base(typed).unwrap();
            assert_eq!(base, "https://gitlab.acme.internal", "{typed}");
            assert_eq!(host, "gitlab.acme.internal", "{typed}");
        }
    }

    /// A GitLab behind a proxy at a path prefix is a real deployment, and
    /// dropping the prefix makes every call it ever does 404.
    #[test]
    fn a_path_prefix_survives_normalization() {
        let (base, host) = normalize_base("https://acme.example/gitlab").unwrap();
        assert_eq!(base, "https://acme.example/gitlab");
        assert_eq!(host, "acme.example");
        assert_eq!(
            api_base_for(kind("gitlab").unwrap(), &base),
            "https://acme.example/gitlab/api/v4"
        );
    }

    #[test]
    fn http_is_allowed_and_nonsense_is_not() {
        assert!(normalize_base("http://git.lab").is_ok());
        assert!(normalize_base("ftp://git.lab").is_err());
        assert!(normalize_base("").is_err());
        assert!(normalize_base("not an address").is_err());
    }

    /// GitHub.com answers on another hostname; an Enterprise install answers at
    /// a path. Getting this the wrong way round makes every call fail on
    /// whichever one you did not test.
    #[test]
    fn githubs_api_lives_in_two_different_places() {
        let k = kind("github").unwrap();
        assert_eq!(
            api_base_for(k, "https://github.com"),
            "https://api.github.com"
        );
        assert_eq!(
            api_base_for(k, "https://ghe.acme.com"),
            "https://ghe.acme.com/api/v3"
        );
    }

    /* ── the registry, against a real schema ───────────────────────────── */

    async fn registry() -> (crate::db::Db, Connections) {
        let db = crate::db::Db::open_for_test().await.unwrap();
        let connections = Connections::opened(db.pool().clone()).await.unwrap();
        (db, connections)
    }

    /// The migration's whole job. Every install that upgrades has exactly one
    /// host, it is called `github`, and it points where it always pointed —
    /// because every vault row, `git_identities` row and task key already
    /// written is keyed on that string.
    #[tokio::test]
    async fn an_upgraded_install_has_the_host_it_already_had() {
        let (_db, connections) = registry().await;
        let all = connections.all().await;

        // Built-in first, which an old client depends on: it reads entry zero
        // and ignores the rest, so entry zero has to be the host it was already
        // using. gitlab.com ships beside it and must not displace it.
        let github = &all[0];
        assert_eq!(github.id, "github", "the id every existing key is under");
        assert_eq!(github.kind.id, "github");
        assert_eq!(github.git_host, "github.com");
        assert_eq!(github.api_base, "https://api.github.com");
        assert!(github.builtin);
        assert_eq!(github.auth, AuthMode::Device);

        // And gitlab.com, so a fresh install can authorize it with nothing
        // registered and the product says somewhere that GitLab is supported.
        let gitlab = connections
            .get("gitlab")
            .await
            .expect("gitlab.com ships too");
        assert_eq!(gitlab.git_host, "gitlab.com");
        assert!(gitlab.builtin);
    }

    /// The client id an install already had, carried onto the row by the
    /// migration — so somebody who registered an application before upgrading
    /// does not have to do it again.
    #[tokio::test]
    async fn a_client_id_set_before_the_upgrade_is_still_there_after_it() {
        let db = crate::db::Db::open_for_test().await.unwrap();
        let accounts = crate::accounts::Accounts::new(db.pool().clone());

        // What an install that predates this looks like: the value in settings
        // and no row carrying it. Written after the migration has run, so the
        // copy is done by hand here — the point under test is that the two
        // places agree, not the order they were filled in.
        accounts
            .set_setting(&setting_key("github"), "Ov23liALREADYSET")
            .await
            .unwrap();
        sqlx::query("UPDATE git_connections SET client_id = $1 WHERE id = 'github'")
            .bind("Ov23liALREADYSET")
            .execute(db.pool())
            .await
            .unwrap();

        let connections = Connections::opened(db.pool().clone()).await.unwrap();
        let github = connections.get("github").await.unwrap();
        assert_eq!(github.client_id().as_deref(), Some("Ov23liALREADYSET"));
        assert!(github.configured());

        // And the setting is left where it was, so a control plane rolled back
        // to before the migration still finds it.
        assert_eq!(
            accounts
                .setting(&setting_key("github"))
                .await
                .unwrap()
                .as_deref(),
            Some("Ov23liALREADYSET")
        );
    }

    /// A second host of the same kind at the same address — a personal and a
    /// work GitHub — which is the whole of what "many GitHub accounts" needs.
    #[tokio::test]
    async fn two_accounts_on_one_hostname_are_two_hosts() {
        let (_db, connections) = registry().await;

        let work = connections
            .create(NewConnection {
                kind: kind("github").unwrap(),
                label: "GitHub (work)".into(),
                base_url: "https://github.com".into(),
                api_base: "https://api.github.com".into(),
                git_host: "github.com".into(),
                auth: AuthMode::Device,
                client_id: Some("Ov23liWORK".into()),
                version: None,
            })
            .await
            .unwrap();

        assert_ne!(work.id, "github", "a second host gets an id of its own");
        assert!(!work.builtin);

        // Built-in first, which an old client depends on: it reads entry zero
        // and ignores the rest, so entry zero has to be what it was using.
        assert_eq!(connections.all().await[0].id, "github");

        // Both match the remote, in list order. Narrowing past this needs the
        // repository's own row, or a token — see `api::connection_for_repo`.
        let both = connections
            .all_for_remote("https://github.com/acme/web.git")
            .await;
        assert_eq!(both.len(), 2);
        assert_eq!(both[0].id, "github");
    }

    /// Same address, same name: there would be no way to tell them apart in
    /// the one place anybody ever picks between them.
    #[tokio::test]
    async fn a_second_host_needs_a_name_of_its_own() {
        let (_db, connections) = registry().await;
        assert!(
            connections
                .address_taken("github", "github.com", "GitHub")
                .await
        );
        assert!(
            connections
                .address_taken("github", "GITHUB.COM", "  github  ")
                .await,
            "case and padding are not a different host"
        );
        assert!(
            !connections
                .address_taken("github", "github.com", "GitHub (work)")
                .await
        );
        // A different kind at the same address is a different host.
        assert!(
            !connections
                .address_taken("gitea", "github.com", "GitHub")
                .await
        );
    }

    /// A self-hosted GitLab, which is the thing none of this could express
    /// before: its address is known only to the person who runs it.
    #[tokio::test]
    async fn a_self_hosted_host_is_found_by_its_own_hostname() {
        let (_db, connections) = registry().await;

        connections
            .create(NewConnection {
                kind: kind("gitlab").unwrap(),
                label: "GitLab (internal)".into(),
                base_url: "https://git.acme.internal".into(),
                api_base: "https://git.acme.internal/api/v4".into(),
                git_host: "git.acme.internal".into(),
                auth: AuthMode::Token,
                client_id: None,
                version: Some("17.4.1".into()),
            })
            .await
            .unwrap();

        let found = connections
            .for_remote("https://git.acme.internal/platform/infra/deploy.git")
            .await
            .unwrap();
        assert_eq!(found.kind.id, "gitlab");
        assert_eq!(found.kind.change_noun, "merge request");
        assert!(found.kind.nested_groups);
        // Connected by token, so it needs no application registered and is
        // ready the moment it exists.
        assert!(found.configured());

        // And GitHub is still GitHub.
        assert_eq!(
            connections
                .for_remote("https://github.com/acme/web.git")
                .await
                .unwrap()
                .id,
            "github"
        );
    }

    /// **Removable, and re-addable to the same id.**
    ///
    /// It used to be exempt, which put a row in everybody's list with no Remove
    /// on it and no reason visible from the interface — and an installation
    /// that does not use GitHub could never be rid of it. The exemption was
    /// protecting an id, not a person: everything written before this table
    /// existed is keyed on the string `github`, and re-adding used to mint a
    /// fresh one. Reuse is what made the exemption unnecessary.
    #[tokio::test]
    async fn the_shipped_host_can_be_removed_and_comes_back_under_its_own_id() {
        let (_db, connections) = registry().await;
        assert!(connections.get("github").await.unwrap().builtin);

        connections.delete("github").await.unwrap();
        assert!(connections.get("github").await.is_none(), "it goes");

        let back = connections
            .create(NewConnection {
                kind: kind("github").unwrap(),
                label: "GitHub".into(),
                base_url: "https://github.com".into(),
                api_base: "https://api.github.com".into(),
                git_host: "github.com".into(),
                auth: AuthMode::Device,
                client_id: None,
                version: None,
            })
            .await
            .unwrap();

        // The same id, so every `git_identities` row and task key that said
        // `github` is adopted again rather than stranded — and `builtin` with
        // it, so the application Firetower ships applies again. Restoring the
        // id alone left a host that looked right and could not be connected.
        assert_eq!(back.id, "github");
        assert!(back.builtin, "the flag travels with the id");
        assert_eq!(
            back.shipped_client_id(),
            Some(kind("github").unwrap().client_id).filter(|s| !s.is_empty())
        );
    }

    /// A second account on the same address is a different host, so it gets an
    /// id of its own — the reuse is for the well-known one only, and only while
    /// it is free.
    #[tokio::test]
    async fn a_second_host_at_the_same_address_does_not_take_the_well_known_id() {
        let (_db, connections) = registry().await;
        let work = connections
            .create(NewConnection {
                kind: kind("github").unwrap(),
                label: "GitHub (work)".into(),
                base_url: "https://github.com".into(),
                api_base: "https://api.github.com".into(),
                git_host: "github.com".into(),
                auth: AuthMode::Device,
                client_id: None,
                version: None,
            })
            .await
            .unwrap();
        assert_ne!(work.id, "github");
        assert!(
            connections.get("github").await.is_some(),
            "the first is untouched"
        );
    }

    /// **A host somebody adds is theirs, including its application.**
    ///
    /// Even at the same address. Ours is for the rows that ship: an added
    /// second account under our application would carry our name on its
    /// approval screen, and would queue behind every other installation for
    /// GitHub's 50 authorizations an hour — which are per application.
    /// **Gitea's token scopes, which are not guessable from what Firetower
    /// does.** Checked against a running 1.22 before they were written down:
    ///
    ///   * `user` Read is needed for `/user/repos` — the repository picker —
    ///     as well as for `/user`. A token with full repository access and no
    ///     `user` scope connects happily and then lists nothing, which is the
    ///     failure this text exists to prevent, so the step that sets it must
    ///     stay marked.
    ///   * `repository` Read and Write: read alone clones a private repository
    ///     and is refused on push with a bare `Forbidden`, and on
    ///     `POST /pulls` with a 403.
    ///   * `issue` Read only for reading work; cloning and pushing do not need
    ///     it, so it is offered as optional rather than demanded.
    ///
    /// The other two kinds put their scopes in the link instead, so steps
    /// there would describe a page that already has the boxes ticked.
    #[test]
    fn gitea_says_which_scopes_a_token_needs() {
        let gitea = kind("gitea").unwrap();
        let steps = gitea.token_steps.join(" ");

        assert!(
            !gitea.token_steps.is_empty(),
            "Gitea cannot pre-tick scopes"
        );
        assert!(steps.contains("Manage Access Tokens"), "{steps}");
        // The three scopes, each named and each marked.
        assert!(
            steps.contains("**user**"),
            "the one people miss, marked: {steps}"
        );
        assert!(steps.contains("**repository**"), "{steps}");
        assert!(steps.contains("**issue**"), "{steps}");
        // "Read" against "Read and Write" is what decides whether a push works.
        assert!(steps.contains("Read and Write"), "{steps}");

        // The hosts whose link carries the scopes explain nothing extra.
        for id in ["github", "gitlab"] {
            let k = kind(id).unwrap();
            assert!(
                k.token_steps.is_empty(),
                "{id} pre-ticks its scopes in `token_page`, so steps would be noise"
            );
            assert!(
                k.token_page.contains("scope"),
                "{id} is only allowed empty steps because its link carries the scopes"
            );
        }
    }

    #[tokio::test]
    async fn the_shipped_application_is_for_the_shipped_rows_only() {
        let (_db, connections) = registry().await;

        let shipped = connections.get("github").await.unwrap();
        if kind("github").unwrap().client_id.trim().is_empty() {
            return; // a build that ships none has nothing to assert
        }
        assert!(shipped.uses_shipped_application());

        let added = connections
            .create(NewConnection {
                kind: kind("github").unwrap(),
                label: "GitHub (work)".into(),
                base_url: "https://github.com".into(),
                api_base: "https://api.github.com".into(),
                git_host: "github.com".into(),
                auth: AuthMode::Device,
                client_id: None,
                version: None,
            })
            .await
            .unwrap();

        assert!(!added.uses_shipped_application());
        assert!(added.client_id().is_none(), "theirs to register");
        assert!(
            !added.configured(),
            "so it says so rather than offering Connect"
        );
    }

    #[tokio::test]
    async fn a_host_can_be_renamed_and_have_its_application_cleared() {
        let (_db, connections) = registry().await;

        connections
            .update("github", Some("GitHub.com"), None, Some("Ov23liNEW"))
            .await
            .unwrap();
        let github = connections.get("github").await.unwrap();
        assert_eq!(github.label, "GitHub.com");
        assert_eq!(github.client_id().as_deref(), Some("Ov23liNEW"));

        // An empty string clears it, which is how somebody moves a host to
        // token auth and takes the application back off it.
        connections
            .update("github", None, Some(AuthMode::Token), Some(""))
            .await
            .unwrap();
        let github = connections.get("github").await.unwrap();
        assert_eq!(github.auth, AuthMode::Token);
        assert!(
            github.client_id().is_none() || !kind("github").unwrap().client_id.is_empty(),
            "cleared, unless this build ships one of its own"
        );
    }

    /// Checked against a real Gitea 1.22 rather than assumed, because this is
    /// the thing the first draft got wrong.
    ///
    /// Gitea's documentation shows the account's own login as the username, so
    /// the first version of this asked the host for it on every push and kept
    /// it in a column on `git_identities`. Against an actual instance, `tester`,
    /// `oauth2`, `x-access-token` and the token itself all clone *and push* a
    /// private repository — Gitea reads the token out of the password and
    /// ignores the name beside it, exactly like the other two. So the column
    /// went, and this is a constant.
    #[test]
    fn every_kind_names_a_git_username_it_can_hard_code() {
        for k in KINDS {
            assert!(
                !k.git_username.is_empty(),
                "{} has no username to put beside a token",
                k.id
            );
            // Git refuses a username with a colon in it — basic auth is
            // `user:pass`, and one here would split in the wrong place.
            assert!(!k.git_username.contains(':'), "{} has a colon in it", k.id);
        }
    }

    /* ── the application Firetower ships ───────────────────────────────── */

    /// An application lives on one server and nowhere else, so the one
    /// registered on github.com means nothing to somebody's Enterprise install.
    ///
    /// Without this, shipping a default made every Enterprise host report
    /// itself configured and draw a Connect button that could only fail — with
    /// GitHub blaming the client id, which is the one thing that was not wrong.
    #[test]
    fn the_shipped_application_is_offered_to_the_hosted_instance_only() {
        let dotcom = github();
        let enterprise = Connection {
            id: "gh_ghes".into(),
            base_url: "https://ghe.acme.com".into(),
            api_base: "https://ghe.acme.com/api/v3".into(),
            git_host: "ghe.acme.com".into(),
            builtin: false,
            client_id: None,
            ..github()
        };

        assert_eq!(
            dotcom.shipped_client_id(),
            Some(kind("github").unwrap().client_id).filter(|s| !s.is_empty()),
            "github.com gets whatever this build ships"
        );
        assert_eq!(
            enterprise.shipped_client_id(),
            None,
            "an Enterprise server has never heard of it"
        );

        // So an Enterprise host with nothing registered is *not* ready, and
        // says so rather than drawing a button that cannot work.
        assert!(enterprise.client_id().is_none());
        assert!(!enterprise.configured());
    }

    /// A kind with no hosted instance has nothing to ship against at all.
    #[test]
    fn a_self_hosted_only_kind_is_never_given_a_shipped_application() {
        let gitea = Connection {
            kind: kind("gitea").unwrap(),
            base_url: "https://tea.acme.internal".into(),
            client_id: None,
            ..github()
        };
        assert_eq!(gitea.shipped_client_id(), None);
        assert!(!gitea.uses_shipped_application());
    }

    /// One registered here wins, and the screen stops calling it shared — which
    /// is the whole of the promise that an installation can use its own.
    #[test]
    fn an_application_registered_here_replaces_the_shipped_one() {
        let mut c = github();
        c.client_id = None;
        let shipped = c.shipped_client_id();

        if shipped.is_some() {
            assert!(c.uses_shipped_application());
            assert_eq!(c.client_id().as_deref(), shipped);
        }

        c.client_id = Some("Ov23liTHEIRS".into());
        assert_eq!(c.client_id().as_deref(), Some("Ov23liTHEIRS"));
        assert!(
            !c.uses_shipped_application(),
            "theirs is in use, so nothing should offer to replace ours"
        );
    }

    #[test]
    fn every_kind_can_say_how_to_connect_it() {
        for k in KINDS {
            assert!(!k.auth.is_empty(), "{} offers no way in", k.id);
            assert!(
                !k.token_page.is_empty(),
                "{} cannot say where to make a token",
                k.id
            );
            assert!(
                !k.change_noun.is_empty(),
                "{} has no word for a change",
                k.id
            );
            // A kind offering the device flow needs the two paths it runs over.
            if k.auth.contains(&AuthMode::Device) {
                assert!(!k.device_path.is_empty(), "{} has no device path", k.id);
                assert!(!k.token_path.is_empty(), "{} has no token path", k.id);
                assert!(!k.scopes.is_empty(), "{} asks for no access", k.id);
            }
        }
    }

    /// Gitea has no device flow at any version. Offering one would draw a
    /// button whose only outcome is a refusal nobody can act on.
    #[test]
    fn gitea_is_token_only() {
        assert_eq!(kind("gitea").unwrap().auth, &[AuthMode::Token]);
        assert!(kind("gitea").unwrap().hosted.is_none());
    }

    /// A token host has nothing to register, so it is never waiting on an
    /// administrator the way a device host can be.
    ///
    /// Asked of an Enterprise host rather than github.com, because github.com
    /// now has an application compiled in and so is *never* unconfigured —
    /// which would have made this pass for the wrong reason.
    #[test]
    fn a_token_host_is_configured_the_moment_it_exists() {
        let mut c = Connection {
            base_url: "https://ghe.acme.com".into(),
            git_host: "ghe.acme.com".into(),
            client_id: None,
            builtin: false,
            ..github()
        };

        c.auth = AuthMode::Device;
        assert!(
            !c.configured(),
            "a device host with no application is not ready"
        );
        c.auth = AuthMode::Token;
        assert!(c.configured(), "a token host needs nothing registered");
    }

    #[test]
    fn a_status_carries_the_identifier_it_authorizes_against() {
        let c = github();
        let status = ProviderStatus {
            id: c.id.clone(),
            label: c.label.clone(),
            connected: true,
            configured: c.configured(),
            pending: None,
            client_id: c.client_id(),
            may_set_application: false,
            kind: c.kind.id.to_string(),
            base_url: c.base_url.clone(),
            git_host: c.git_host.clone(),
            auth: c.auth,
            auth_modes: c.kind.auth.to_vec(),
            change_noun: c.kind.change_noun.to_string(),
            version: None,
            builtin: true,
            token_page: c.token_page(),
            app_page: c.app_page(),
            access_page: c.access_page(),
            shared_application: c.uses_shipped_application(),
        };

        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["clientId"], "Ov23liEXAMPLE");
        // Carried in the shape the interfaces read it under. Spelled out here
        // because it decides whether a field is drawn at all, and a rename
        // would quietly draw it for everybody again.
        assert_eq!(json["maySetApplication"], false);
        assert_eq!(json["kind"], "github");
        assert_eq!(json["changeNoun"], "pull request");
        assert_eq!(json["auth"], "device");
        assert_eq!(
            json["accessPage"],
            "https://github.com/settings/connections/applications/Ov23liEXAMPLE"
        );
    }

    /// The link is built out of the client id and exists on GitHub only. Drawn
    /// for a GitLab it would go to a page that has never existed.
    #[test]
    fn only_github_has_an_application_access_page() {
        let mut c = github();
        assert!(c.access_page().is_some());
        c.client_id = None;
        assert!(
            c.access_page().is_none(),
            "nothing to build the address from"
        );

        let gitlab = Connection {
            kind: kind("gitlab").unwrap(),
            client_id: Some("abc".into()),
            base_url: "https://gitlab.com".into(),
            ..github()
        };
        assert!(gitlab.access_page().is_none());
    }

    /// Each kind's device flow runs over its own two paths, under whatever
    /// address the instance is at — which is the thing a compiled-in URL could
    /// not express.
    #[test]
    fn a_self_hosted_host_builds_its_own_urls() {
        let c = Connection {
            id: "gitlab_x".into(),
            kind: kind("gitlab").unwrap(),
            label: "GitLab (internal)".into(),
            base_url: "https://git.acme.internal".into(),
            api_base: "https://git.acme.internal/api/v4".into(),
            git_host: "git.acme.internal".into(),
            auth: AuthMode::Device,
            client_id: Some("abc".into()),
            version: Some("17.4.1".into()),
            builtin: false,
            position: 1,
        };
        assert_eq!(
            c.device_code_url(),
            "https://git.acme.internal/oauth/authorize_device"
        );
        assert_eq!(
            c.device_token_url(),
            "https://git.acme.internal/oauth/token"
        );
        assert!(c
            .token_page()
            .starts_with("https://git.acme.internal/-/user_settings"));
    }
}
