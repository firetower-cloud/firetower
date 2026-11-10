//! Listing what somebody could work on.
//!
//! A thin handler on purpose: everything about *what a task is* lives in
//! `crate::tasks`, so adding a second tracker is implementing a trait and
//! adding a line here rather than reworking a screen.

use axum::{
    extract::{Query as Params, State},
    Extension, Json,
};
use serde::Deserialize;

use crate::api::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::tasks::{self, Source, TaskKind, TaskState};
use crate::trackers::{self, Resolved};
use crate::vault::Key;
use crate::AppState;

/// Whose tasks. The same shape every handler here uses.
fn owner(principal: &Principal) -> Result<&str, ApiError> {
    principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "sign in to use this Firetower"))
}

/// This person's credential for a tracker, or the reason there isn't one.
///
/// Asked with their own credential so the answer is what *they* can see, and
/// charged to their own rate limit rather than to a pool.
///
/// Wrapped as the vault handed it over, rather than unwrapped for
/// convenience: it derefs to `&str` at every call site that needs one, and
/// keeping the wrapper is what erases it from memory afterwards.
pub(super) async fn credential_for(
    state: &AppState,
    principal: &Principal,
    tracker: &Resolved,
    why: &str,
) -> Result<zeroize::Zeroizing<String>, ApiError> {
    let me = owner(principal)?;
    let holder = whose(state, tracker, me).await?;
    credential_held_by(state, tracker, &holder, why).await
}

/// The same, for a caller that has already worked out whose key answers.
///
/// **A git host's credential is renewed on the way out, a tracker's is not.**
/// They come from the same vault scope — a GitLab reads work with the token it
/// pushes with, which is the point of not storing a second copy — but only one
/// of them expires: GitLab mints a two-hour token and Linear's API key has no
/// end date. So a git host goes through `api::git_token`, which renews it, and
/// everything else is read straight.
pub(super) async fn credential_held_by(
    state: &AppState,
    tracker: &Resolved,
    holder: &str,
    why: &str,
) -> Result<zeroize::Zeroizing<String>, ApiError> {
    let missing = || {
        ApiError::new(
            ErrorCode::ProviderNotConnected,
            format!("{} hasn't been connected yet", tracker.label),
        )
    };

    if let Some(conn) = tracker.connection.as_deref() {
        return super::git_token(state, conn, holder, why)
            .await
            .ok_or_else(missing);
    }

    state
        .vault
        .get(Key::of(tracker.vault_scope(), &tracker.id, holder), why)
        .await?
        .ok_or_else(missing)
}

/// Whose key answers for this person: their own, or one filed where they work.
///
/// **A key is not always the asker's.** A git host's is — a token that pushes
/// commits has to be attributable to a human, so every person connects their
/// own. An API key is frequently the organisation's: one Linear workspace key
/// that a team shares, filed into a directory, is the arrangement the product
/// should have rather than five people pasting the same string.
///
/// `owner_for` is the resolution, and it already prefers theirs — so somebody
/// who has connected their own keeps using it, and somebody who has not falls
/// through to whatever the directories they work in hold.
pub(super) async fn whose(
    state: &AppState,
    tracker: &Resolved,
    me: &str,
) -> Result<String, ApiError> {
    Ok(state
        .vault
        .owner_for(
            tracker.vault_scope(),
            &tracker.id,
            me,
            crate::access::Level::Viewer,
        )
        .await?
        .unwrap_or_else(|| me.to_string()))
}

/// A tracker's failure, as the answer a person can act on.
///
/// A credential the tracker refused is "connect again" (409, the same code a
/// key refused at connect time gets), carrying the sentence the tracker's
/// module wrote. Anything else is Firetower's or the network's trouble.
pub(super) fn provider_error(e: anyhow::Error) -> ApiError {
    let code = if e.downcast_ref::<tasks::Refused>().is_some() {
        ErrorCode::ProviderNotConnected
    } else {
        ErrorCode::Internal
    };
    ApiError::new(code, format!("{e:#}"))
}

/// This install's Trello app key, or the reason there is none.
pub(super) fn trello_app_key() -> anyhow::Result<String> {
    trackers::trello_app_key()
        .ok_or_else(|| anyhow::anyhow!("Trello is not set up on this install: it has no app key."))
}

/// One page from whichever tracker was asked for.
///
/// A `match` rather than a boxed trait object: [`Source`] returns an opaque
/// future per implementation, and a few arms are cheaper than the indirection
/// that would make it object-safe.
pub(super) async fn list_from(
    tracker: &Resolved,
    credential: &str,
    query: &tasks::Query,
) -> anyhow::Result<tasks::Page> {
    match (&tracker.connection, tracker.tracker) {
        (Some(conn), _) => match conn.kind.id {
            "gitlab" => tasks::GitLab { conn }.list(credential, query).await,
            "gitea" => tasks::Gitea { conn }.list(credential, query).await,
            _ => tasks::GitHub { conn }.list(credential, query).await,
        },
        (None, Some(t)) => match t.id {
            "linear" => tasks::Linear { tracker: t }.list(credential, query).await,
            "trello" => {
                let app_key = trello_app_key()?;
                tasks::Trello {
                    tracker: t,
                    app_key,
                }
                .list(credential, query)
                .await
            }
            _ => anyhow::bail!("{} reads from nowhere", tracker.label),
        },
        (None, None) => anyhow::bail!("{} reads from nowhere", tracker.label),
    }
}

pub(super) async fn one_from(
    tracker: &Resolved,
    credential: &str,
    url: &str,
) -> anyhow::Result<tasks::Task> {
    match (&tracker.connection, tracker.tracker) {
        (Some(conn), _) => match conn.kind.id {
            "gitlab" => tasks::GitLab { conn }.one(credential, url).await,
            "gitea" => tasks::Gitea { conn }.one(credential, url).await,
            _ => tasks::GitHub { conn }.one(credential, url).await,
        },
        (None, Some(t)) => match t.id {
            "linear" => tasks::Linear { tracker: t }.one(credential, url).await,
            "trello" => {
                let app_key = trello_app_key()?;
                tasks::Trello {
                    tracker: t,
                    app_key,
                }
                .one(credential, url)
                .await
            }
            _ => anyhow::bail!("{} reads from nowhere", tracker.label),
        },
        (None, None) => anyhow::bail!("{} reads from nowhere", tracker.label),
    }
}

/// What to list.
///
/// `q` is passed to the source rather than parsed. The chips on screen write
/// into it and it is one string either way, which is what lets a second source
/// keep the same controls and speak its own dialect.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Listing {
    /// Which tracker: `github`, `linear` or `trello`.
    pub source: Option<String>,
    /// `acme/web`, when the source has repositories.
    pub repo: Option<String>,
    /// A team or a board, by the tracker's own key: `ENG`, when the source has
    /// teams or boards.
    pub team: Option<String>,
    /// `issue`, `pullRequest` or `ticket`.
    pub kind: Option<TaskKind>,
    /// `open` or `closed`.
    pub state: Option<TaskState>,
    /// Only what this person is assigned.
    #[serde(default)]
    pub mine: bool,
    /// The query box, verbatim.
    pub q: Option<String>,
    /// One column, by the key `/trackers/{id}/columns` gave it.
    pub status: Option<String>,
    #[serde(default)]
    pub page: u32,
    /// Where the last page stopped, for a source that pages by cursor.
    pub cursor: Option<String>,
}

/// What could be worked on.
///
/// Read from the tracker every time rather than from a copy here. Issues are
/// somebody else's source of truth and change under us; a conditional request
/// that has not changed costs nothing, and one that has is exactly the moment
/// the new data is wanted.
#[utoipa::path(
    get, path = "/api/v1/tasks", tag = "tasks",
    params(
        ("source" = Option<String>, Query, description = "Which tracker; github by default"),
        ("repo" = Option<String>, Query, description = "acme/web, when the source has repositories"),
        ("team" = Option<String>, Query, description = "ENG, when the source has teams"),
        ("kind" = Option<TaskKind>, Query, description = "issue, pullRequest or ticket"),
        ("state" = Option<TaskState>, Query, description = "open or closed"),
        ("mine" = Option<bool>, Query, description = "Only what you are assigned"),
        ("q" = Option<String>, Query, description = "The query box, passed to the source verbatim"),
        ("status" = Option<String>, Query, description = "One column, by the key /trackers/{id}/columns gave it"),
        ("page" = Option<u32>, Query, description = "One-based"),
        ("cursor" = Option<String>, Query, description = "Where the last page stopped, for a source that pages by cursor"),
    ),
    responses(
        (status = 200, body = tasks::Page),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn list_tasks(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Params(ask): Params<Listing>,
) -> ApiResult<Json<tasks::Page>> {
    // The built-in git host by default, which is what it has always been. With
    // a second host connected the screen names one; with none named this is the
    // first in the list, and the list is built-in-first.
    let id = ask.source.as_deref().unwrap_or("github");
    let tracker = trackers::find(&state, id)
        .await
        .ok_or_else(|| ApiError::not_found("source"))?;

    let credential =
        credential_for(&state, &principal, &tracker, "listing tasks to work on").await?;

    // Scoped to what this Firetower is connected to unless somebody narrows it
    // further. A task list that answers about repositories you have never heard
    // of is not a task list. Trackers with teams rather than repositories
    // already default to the ones you are a member of.
    let connected = match tracker.scope_kind {
        trackers::ScopeKind::Repos => state
            .db
            .repos_of(owner(&principal)?)
            .await?
            .into_iter()
            .map(|r| r.slug)
            .collect(),
        trackers::ScopeKind::Teams | trackers::ScopeKind::Boards => Vec::new(),
    };

    let query = tasks::Query {
        repo: ask.repo,
        connected,
        team: ask.team,
        kind: ask.kind,
        state: ask.state,
        mine: ask.mine,
        raw: ask.q,
        status: ask.status,
        page: ask.page,
        cursor: ask.cursor,
    };

    list_from(&tracker, &credential, &query)
        .await
        .map(Json)
        .map_err(provider_error)
}

/// What to look up. A link, because a link is what gets stored and pasted.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Locating {
    /// Which tracker. Worked out from the link when it is left off.
    pub source: Option<String>,
    /// Where a person would read it: `https://github.com/acme/web/issues/32`.
    pub url: String,
}

/// One task, by its link.
///
/// A workspace remembers the task it was cut for as a key and a URL — two
/// facts of ours that survive the tracker going down. Everything a person
/// wants to *see* about it (what it is called, whether it is still open) is
/// somebody else's, and is asked for here.
///
/// Whoever calls this must be able to carry on without it: an issue that
/// cannot be read is still an issue you can reference by number.
#[utoipa::path(
    get, path = "/api/v1/tasks/one", tag = "tasks",
    params(
        ("source" = Option<String>, Query, description = "Which tracker; github by default"),
        ("url" = String, Query, description = "Where a person would read it"),
    ),
    responses(
        (status = 200, body = tasks::Task),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn get_task(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Params(ask): Params<Locating>,
) -> ApiResult<Json<tasks::Task>> {
    // The link says which tracker it came from, so a caller holding only a
    // stored URL does not have to have recorded that separately.
    let tracker = match ask.source.as_deref() {
        Some(id) => trackers::find(&state, id).await,
        None => trackers::for_url(&state, &ask.url).await,
    }
    .ok_or_else(|| ApiError::not_found("source"))?;

    let credential = credential_for(&state, &principal, &tracker, "reading a task").await?;

    let mut task = one_from(&tracker, &credential, &ask.url)
        .await
        .map_err(provider_error)?;
    // Only here: this is the read behind starting work, the one place that
    // shows them. Best effort, because a card without its attachments is
    // still the card.
    task.attachments = or_none(attachments_from(&tracker, &credential, &ask.url).await);
    Ok(Json(task))
}

/// What is attached to a task, from a tracker that lists attachments. The
/// others hold none, which is not an error.
async fn attachments_from(
    tracker: &Resolved,
    credential: &str,
    url: &str,
) -> anyhow::Result<Vec<tasks::TaskAttachment>> {
    match tracker.tracker {
        Some(t) if t.id == "trello" => {
            tasks::trello_card_attachments(t.api_base, &trello_app_key()?, credential, url).await
        }
        _ => Ok(Vec::new()),
    }
}

/// Attachments that could not be read are no attachments: said at debug and
/// dropped, so the task itself still answers. A refused token is the
/// download's to report, as 409, when somebody asks for the bytes.
fn or_none(read: anyhow::Result<Vec<tasks::TaskAttachment>>) -> Vec<tasks::TaskAttachment> {
    read.unwrap_or_else(|e| {
        tracing::debug!("a task's attachments could not be read: {e:#}");
        Vec::new()
    })
}

/// Which attachment, on which card.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Fetching {
    /// The card it is on, as `/tasks/one` was asked for it.
    pub url: String,
    /// The attachment's id, as `/tasks/one` listed it.
    pub id: String,
}

/// An attachment's failure, as the answer a person can act on.
///
/// Not on the card and not a file are both "not found": the caller asked for
/// something this card does not hold. Too big is a request that cannot be
/// met, said as the sentence. Everything else is a tracker's failure.
fn attachment_error(e: anyhow::Error) -> ApiError {
    match e.downcast_ref::<tasks::TrelloUnserved>() {
        Some(tasks::TrelloUnserved::NotACard) => {
            ApiError::new(ErrorCode::NotFound, format!("{e:#}"))
        }
        Some(tasks::TrelloUnserved::NotOnCard | tasks::TrelloUnserved::NotAFile) => {
            ApiError::not_found("attachment")
        }
        Some(tasks::TrelloUnserved::TooBig) => {
            ApiError::new(ErrorCode::InvalidRequest, format!("{e:#}"))
        }
        None => provider_error(e),
    }
}

/// A file attached to a task, through Firetower.
///
/// Trello asks for the credential even to download an attachment, so the
/// person's machine cannot fetch it itself. This takes the card and the
/// attachment's id, never an address: the card's own list is read again and
/// only an id on it is downloaded, so nothing here can be pointed elsewhere.
#[utoipa::path(
    get, path = "/api/v1/tasks/attachment", tag = "tasks",
    params(
        ("url" = String, Query, description = "The card, as /tasks/one was asked for it"),
        ("id" = String, Query, description = "The attachment's id, as /tasks/one listed it"),
    ),
    responses(
        (status = 200, description = "The file's bytes, under its own type and name"),
        (status = 400, body = ApiError),
        (status = 404, body = ApiError),
        (status = 409, body = ApiError),
    ),
)]
pub(super) async fn get_task_attachment(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Params(ask): Params<Fetching>,
) -> Result<axum::response::Response, ApiError> {
    let tracker = trackers::for_url(&state, &ask.url)
        .await
        .ok_or_else(|| ApiError::not_found("source"))?;
    // Only Trello lists attachments today; anything else holds none.
    if tracker.tracker.map(|t| t.id) != Some("trello") {
        return Err(ApiError::not_found("attachment"));
    }

    let credential =
        credential_for(&state, &principal, &tracker, "bringing a task's attachment").await?;
    let api_base = tracker.tracker.map(|t| t.api_base).unwrap_or_default();
    let app_key = trello_app_key().map_err(provider_error)?;

    let (found, bytes) =
        tasks::trello_attachment(api_base, &app_key, &credential, &ask.url, &ask.id)
            .await
            .map_err(attachment_error)?;

    axum::response::Response::builder()
        .header(
            axum::http::header::CONTENT_TYPE,
            served_type(found.mime.as_deref()),
        )
        // The type above is the whole story: no browser may guess a page
        // out of somebody's upload.
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(axum::http::header::CONTENT_LENGTH, bytes.len())
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            disposition(&found.name),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}

/// The kinds of file served as what they are. Pictures the first message
/// carries, a PDF and plain text; nothing a browser would run.
const SERVED_AS_THEMSELVES: [&str; 6] = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
];

/// The `content-type` an attachment is served under.
///
/// The type is whatever the uploader's machine said, so anything outside
/// [`SERVED_AS_THEMSELVES`] (an HTML page, an SVG with a script in it) goes
/// out as bytes and nothing more.
fn served_type(mime: Option<&str>) -> &'static str {
    let mime = mime.unwrap_or("").trim().to_ascii_lowercase();
    SERVED_AS_THEMSELVES
        .into_iter()
        .find(|kind| *kind == mime)
        .unwrap_or("application/octet-stream")
}

/// `content-disposition` for a name somebody gave a file.
///
/// The plain `filename` keeps only what every header parser reads (no quote,
/// no backslash, nothing outside printable ASCII), and `filename*` carries
/// the real name, accents and all, for the clients that read it.
fn disposition(name: &str) -> String {
    let plain: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{plain}\"; filename*=UTF-8''{encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_credential_answers_409_with_the_sentence() {
        let e = provider_error(
            tasks::Refused("Trello refused the token. It may have been revoked.".into()).into(),
        );
        assert!(matches!(e.code, ErrorCode::ProviderNotConnected));
        assert_eq!(
            e.message,
            "Trello refused the token. It may have been revoked."
        );
    }

    #[test]
    fn a_refusal_wrapped_in_context_is_still_a_refusal() {
        let wrapped =
            anyhow::Error::new(tasks::Refused("Linear refused the key.".into())).context("listing");
        assert!(matches!(
            provider_error(wrapped).code,
            ErrorCode::ProviderNotConnected
        ));
    }

    #[test]
    fn any_other_failure_stays_a_server_error() {
        assert!(matches!(
            provider_error(anyhow::anyhow!("asking Trello")).code,
            ErrorCode::Internal
        ));
    }

    #[test]
    fn an_attachment_not_on_the_card_is_not_found() {
        for why in [
            tasks::TrelloUnserved::NotOnCard,
            tasks::TrelloUnserved::NotAFile,
        ] {
            assert!(matches!(
                attachment_error(why.into()).code,
                ErrorCode::NotFound
            ));
        }
    }

    #[test]
    fn an_attachment_too_big_says_so() {
        let e = attachment_error(tasks::TrelloUnserved::TooBig.into());
        assert!(matches!(e.code, ErrorCode::InvalidRequest));
        assert_eq!(e.message, "That attachment is over 25 MB.");
    }

    #[test]
    fn a_refused_token_on_an_attachment_is_still_409() {
        let e = attachment_error(
            tasks::Refused("Trello refused the token. It may have been revoked.".into()).into(),
        );
        assert!(matches!(e.code, ErrorCode::ProviderNotConnected));
    }

    #[test]
    fn a_files_name_is_quoted_safely_in_the_header() {
        let d = disposition("Capture d\u{e9}cran \"1\".png");
        assert_eq!(
            d,
            "attachment; filename=\"Capture d_cran _1_.png\"; filename*=UTF-8''Capture%20d%C3%A9cran%20%221%22.png"
        );
        assert!(axum::http::HeaderValue::from_str(&d).is_ok());
    }

    #[test]
    fn a_link_that_is_not_a_card_is_not_found_with_a_sentence() {
        let e = attachment_error(tasks::TrelloUnserved::NotACard.into());
        assert!(matches!(e.code, ErrorCode::NotFound));
        assert_eq!(e.message, "That link is not a Trello card.");
    }

    #[test]
    fn only_plain_kinds_of_file_are_served_as_themselves() {
        for kind in [
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "application/pdf",
            "text/plain",
        ] {
            assert_eq!(served_type(Some(kind)), kind);
        }
        assert_eq!(served_type(Some("IMAGE/PNG")), "image/png");
        for kind in [
            "text/html",
            "image/svg+xml",
            "application/javascript",
            "text/plain\r\nx: y",
            "",
        ] {
            assert_eq!(
                served_type(Some(kind)),
                "application/octet-stream",
                "{kind}"
            );
        }
        assert_eq!(served_type(None), "application/octet-stream");
    }

    #[test]
    fn a_line_break_in_a_name_cannot_start_a_header() {
        let d = disposition("evil\r\nSet-Cookie: x.png");
        assert!(!d.contains('\r') && !d.contains('\n'), "{d}");
        assert!(
            d.contains("filename*=UTF-8''evil%0D%0ASet-Cookie%3A%20x.png"),
            "{d}"
        );
        assert!(axum::http::HeaderValue::from_str(&d).is_ok());
    }

    #[test]
    fn attachments_that_cannot_be_read_leave_the_task_without_them() {
        let refused: anyhow::Result<Vec<tasks::TaskAttachment>> = Err(tasks::Refused(
            "Trello refused the token. It may have been revoked.".into(),
        )
        .into());
        assert!(or_none(refused).is_empty());
        assert!(or_none(Err(anyhow::anyhow!("Trello answered 429"))).is_empty());
    }
}
