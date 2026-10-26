//! What somebody has published, and where to open it.
//!
//! Listed by owner rather than by session: an artifact outlives the workspace
//! that produced it, so "the artifacts in this session" is a filter on the
//! list and not the shape of it.

use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::sessions::session_context;
use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::db::ArtifactRow;
use crate::AppState;

/// One artifact, with the address it can be opened at.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    #[serde(flatten)]
    pub row: ArtifactRow,
    /// Ready to put in an `iframe` or paste into a tab.
    pub url: String,
    /// Where the picture of it is, for an `<img>` in a library or a transcript.
    ///
    /// Always an address, even before anything has rendered the page —
    /// `hasPoster` is what says whether it answers yet. Two fields rather than
    /// an optional URL because the client needs to tell "no picture taken" from
    /// "no picture possible", and only the first of those is worth queueing.
    pub poster_url: String,
}

/// One row, as the API presents it.
///
/// Built in one place because four handlers return this shape and three of
/// them used to assemble it by hand — which is how `posterUrl` would have
/// arrived on the list and been missing from the thing `publish` hands back.
fn present(state: &AppState, headers: &HeaderMap, row: ArtifactRow) -> Artifact {
    let id = ft_core::ArtifactId::from_stored(row.id.clone());

    // **The version has to be in the address.**
    //
    // The path alone names the *artifact*, and the picture is served with
    // `immutable` — which was a straightforward lie, because publishing a new
    // version changes what that one path answers with. A browser that had v1's
    // poster was told it could keep it for a year, so it never asked again:
    // the artifact moved to v3 and the library went on drawing v1 with nothing
    // to say it was stale.
    //
    // A query string rather than a second signed path: it costs nothing to
    // verify, the signature still covers the only thing that grants access,
    // and the server ignores it — it always serves whatever is current. All it
    // does is make the cache key move when the version does, which is exactly
    // what `immutable` needs to be true.
    let poster_url = match &row.version_id {
        Some(version) => format!("{}?v={version}", state.names.poster_path(&id)),
        None => state.names.poster_path(&id),
    };

    Artifact {
        url: state
            .names
            .artifact_url(scheme_of(headers), port_of(headers), &id),
        poster_url,
        row,
    }
}

/// Everything this person has published.
#[utoipa::path(
    get, path = "/api/v1/artifacts", tag = "artifacts",
    responses((status = 200, body = Vec<Artifact>), (status = 401, body = ApiError)),
)]
pub(super) async fn list_artifacts(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<Artifact>>> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to see your artifacts."))?;

    let rows = state.db.artifacts_of(owner).await?;

    Ok(Json(
        rows.into_iter()
            .map(|row| present(&state, &headers, row))
            .collect(),
    ))
}

/// Where one artifact can be opened.
#[utoipa::path(
    get, path = "/api/v1/artifacts/{id}/address", tag = "artifacts",
    params(("id" = String, Path, description = "Artifact id")),
    responses((status = 200, body = Artifact), (status = 404, body = ApiError)),
)]
pub(super) async fn artifact_address(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Artifact>> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to open an artifact."))?;

    let row = state
        .db
        .artifact_of(owner, &ft_core::ArtifactId::from_stored(id))
        .await?
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    Ok(Json(present(&state, &headers, row)))
}

/// The same two questions `forwards.rs` answers, for the same reason: only the
/// request that arrived knows what address the browser is actually using.
fn scheme_of(headers: &HeaderMap) -> &'static str {
    let forwarded = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if forwarded.eq_ignore_ascii_case("https") {
        "https"
    } else {
        "http"
    }
}

fn port_of(headers: &HeaderMap) -> Option<u16> {
    if let Some(p) = headers
        .get("x-forwarded-port")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
    {
        return Some(p);
    }
    let host = headers.get(axum::http::header::HOST)?.to_str().ok()?;
    let (_, port) = host.rsplit_once(':')?;
    port.parse().ok()
}

/// A new name for an artifact.
///
/// **Not `Rename`.** A host already registers one of those, and utoipa keys a
/// schema by its short name — so a second `Rename` silently becomes whichever
/// the generator reached last, and the clients typecheck against a shape the
/// server never sends. `SkillNaming` exists for the same reason.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactNaming {
    pub title: String,
}

/// Rename an artifact.
///
/// The title is what a person calls it. The slug — the folder the agent writes
/// into, and what a republish is matched on — is deliberately untouched.
#[utoipa::path(
    patch, path = "/api/v1/artifacts/{id}", tag = "artifacts",
    params(("id" = String, Path, description = "Artifact id")),
    request_body = ArtifactNaming,
    responses((status = 200, body = Artifact), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn rename_artifact(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ArtifactNaming>,
) -> ApiResult<Json<Artifact>> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to rename."))?;

    let title = body.title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a title is between one and two hundred characters",
        ));
    }

    let artifact = ft_core::ArtifactId::from_stored(id.clone());
    if !state.db.rename_artifact(owner, &artifact, title).await? {
        // Not found and not allowed answer the same way on purpose: telling
        // somebody a thing exists but is not theirs is itself a disclosure.
        return Err(ApiError::not_found("artifact"));
    }

    let row = state
        .db
        .artifact_of(owner, &artifact)
        .await?
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    Ok(Json(present(&state, &headers, row)))
}

/// Remove an artifact.
///
/// There is no undo and nothing to restore from: the bytes live here and
/// nowhere else once the workspace that produced them is gone. The client
/// asks before calling this; the server does not ask twice.
#[utoipa::path(
    delete, path = "/api/v1/artifacts/{id}", tag = "artifacts",
    params(("id" = String, Path, description = "Artifact id")),
    responses((status = 204), (status = 404, body = ApiError)),
)]
pub(super) async fn delete_artifact(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<axum::http::StatusCode> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to delete."))?;

    let artifact = ft_core::ArtifactId::from_stored(id);
    if !state.db.delete_artifact(owner, &artifact).await? {
        // Not found and not permitted answer alike: saying "it exists but is
        // not yours" is itself a disclosure.
        return Err(ApiError::not_found("artifact"));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// Where a session writes the artifacts it publishes.
///
/// Under the session's own directory, which is already outside git — the same
/// reasoning `attachments.rs` gives: a mock-up is an output of the work, not
/// part of it, and should never turn up in the pull request.
pub const DIR: &str = ".firetower/artifacts";

/// The most one version may weigh. Past this it is an asset, not a document.
const BIGGEST: u64 = 5 * 1024 * 1024;

/// How many files one artifact may be. A page and its handful of assets.
const MOST_FILES: usize = 40;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Publish {
    /// The folder under `.firetower/artifacts/`.
    pub slug: String,
    /// What a person should call it. Falls back to the slug.
    #[serde(default)]
    pub title: Option<String>,
}

/// Publish what a session wrote, as a new version.
///
/// The bytes are *copied* out of the workspace rather than read on every
/// request. That is the whole difference between this and a preview: a minute
/// after the last session in a workspace ends, `reclaim.rs` takes the
/// workspace — and the artifact has to still be there.
#[utoipa::path(
    post, path = "/api/v1/sessions/{id}/artifacts", tag = "artifacts",
    params(("id" = String, Path, description = "Session id")),
    request_body = Publish,
    responses((status = 201, body = Artifact), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn publish_artifact(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(req): Json<Publish>,
) -> ApiResult<(axum::http::StatusCode, Json<Artifact>)> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to publish."))?
        .to_string();
    let session = ft_core::SessionId::from_stored(id.clone());
    let (session_row, host) = session_context(&state, &principal, &session).await?;

    // One label and nothing else: this becomes a directory to read and, later,
    // a row keyed by it. A separator here would reach outside the folder.
    let slug = req.slug.trim().to_string();
    if slug.is_empty()
        || slug.len() > 64
        || !slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "an artifact's folder is lowercase letters, digits and hyphens",
        ));
    }

    let root = format!("{DIR}/{slug}");
    let listing = state
        .fleet
        .list_files(&host, &session, &root)
        .await
        .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
        .map_err(|why| ApiError::new(ErrorCode::InvalidRequest, why))?;

    let mut files = Vec::new();
    let mut total = 0u64;
    for entry in listing.iter().filter(|e| !e.directory && !e.link) {
        if files.len() >= MOST_FILES {
            break;
        }
        total += entry.size;
        if total > BIGGEST {
            return Err(ApiError::new(
                ErrorCode::InvalidRequest,
                format!(
                    "that artifact is over {} MB. Inline what it needs, or make it smaller —                      this is a document, not a bundle",
                    BIGGEST / 1_048_576
                ),
            ));
        }
        let path = format!("{root}/{}", entry.name);
        let (_, mut chunks) = state
            .fleet
            .read_file(&host, &session, &path)
            .await
            .map_err(|e| ApiError::new(ErrorCode::HostUnreachable, format!("{e:#}")))?
            .map_err(|why| ApiError::new(ErrorCode::InvalidRequest, why))?;

        let mut body = Vec::new();
        while let Some(chunk) = chunks.recv().await {
            body.extend_from_slice(&chunk);
        }
        files.push((
            entry.name.clone(),
            crate::artifact::content_type_of(&entry.name),
            body,
        ));
    }

    // A page is what makes this an artifact rather than a folder of assets.
    let entry = if files.iter().any(|(p, _, _)| p == "index.html") {
        "index.html".to_string()
    } else {
        files
            .iter()
            .find(|(p, _, _)| p.ends_with(".html"))
            .map(|(p, _, _)| p.clone())
            .ok_or_else(|| {
                ApiError::new(
                    ErrorCode::InvalidRequest,
                    format!("nothing in {root} is an HTML page. An artifact needs an index.html"),
                )
            })?
    };

    let org = state
        .db
        .org_of_user(&owner)
        .await?
        .ok_or_else(|| ApiError::new(ErrorCode::NotFound, "no organisation"))?;
    let title = req
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&slug)
        .to_string();

    let (artifact, version) = state
        .db
        .publish_artifact(
            &owner,
            &org,
            &slug,
            &title,
            &entry,
            &files,
            Some(session.as_str()),
            Some(session_row.name.as_str()),
        )
        .await?;

    tracing::info!(artifact = %artifact, version, files = files.len(), "published an artifact");

    let row = state
        .db
        .artifact_of(&owner, &artifact)
        .await?
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(present(&state, &headers, row)),
    ))
}

/// The most a picture of a page may weigh.
///
/// A 1180-wide render scaled to 640 lands well under this. The cap is here so
/// that a client which hands back a full-resolution screen, or something that
/// is not a thumbnail at all, is refused rather than stored.
const BIGGEST_POSTER: usize = 4 * 1024 * 1024;

/// Keep a picture of a version.
///
/// Uploaded by whichever client rendered it rather than taken here: the
/// control plane has no browser and `docs/artifacts.md` is right that it
/// should not grow one. Every client already is one.
///
/// Addressed by *version*, not by artifact, because that is what the picture
/// is of. A republish makes a new version with no poster, which is the signal
/// to take another — there is no invalidation to perform and no way for this
/// to overwrite a picture of bytes somebody is still looking at.
#[utoipa::path(
    put, path = "/api/v1/artifact-versions/{id}/poster", tag = "artifacts",
    params(("id" = String, Path, description = "Artifact version id")),
    request_body(content = Vec<u8>, content_type = "image/png"),
    responses((status = 204), (status = 400, body = ApiError), (status = 404, body = ApiError)),
)]
pub(super) async fn put_artifact_poster(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> ApiResult<axum::http::StatusCode> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to publish."))?;

    if body.len() > BIGGEST_POSTER {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "that is larger than a thumbnail should ever be",
        ));
    }

    // Checked rather than trusted, because this is served back with an
    // `image/png` content type: storing whatever arrived would let a caller
    // choose the bytes a browser is told to read as an image.
    if !body.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a poster is a PNG",
        ));
    }

    if state
        .db
        .artifact_version_visible_to(owner, &id)
        .await?
        .is_none()
    {
        return Err(ApiError::not_found("artifact"));
    }

    // `false` means somebody else photographed it first, which is a success
    // from here: the version has its picture and this one is redundant.
    state.db.set_artifact_poster(&id, &body).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// One artifact folder a session has written, and whether it has changed.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub name: String,
    /// Changes whenever the folder's contents do.
    ///
    /// Sizes and modification times of the files inside, not of the directory:
    /// editing a file in place leaves the directory's own mtime untouched, so
    /// a fingerprint taken from the directory would say "unchanged" for
    /// exactly the edit somebody just asked for.
    pub fingerprint: String,
}

/// Which artifact folders a session has written, and a fingerprint of each.
///
/// The client polls this rather than the control plane watching the stream:
/// a guess that misses costs a card appearing late, never a lost artifact.
#[utoipa::path(
    get, path = "/api/v1/sessions/{id}/artifacts", tag = "artifacts",
    params(("id" = String, Path, description = "Session id")),
    responses((status = 200, body = Vec<Folder>), (status = 404, body = ApiError)),
)]
pub(super) async fn session_artifact_folders(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Folder>>> {
    let session = ft_core::SessionId::from_stored(id);
    let (_, host) = session_context(&state, &principal, &session).await?;

    // Nothing there is the ordinary case and not an error: most sessions never
    // publish anything.
    let listing = match state.fleet.list_files(&host, &session, DIR).await {
        Ok(Ok(entries)) => entries,
        _ => return Ok(Json(Vec::new())),
    };

    // **All at once, not one after another.** This is polled every few seconds
    // for as long as a workspace is open, and it used to `await` each folder's
    // listing in turn — so a session with four artifacts paid four round trips
    // to the worker, serially, every time, and the whole thing took as long as
    // the slowest machine four times over. They do not depend on each other.
    //
    // The protocol has no recursive listing and adding one would mean a wire
    // change that every already-deployed worker would have to understand, so
    // this is the version of the fix that needs nothing on the other end:
    // still N requests, now one request's worth of waiting.
    let inside =
        futures::future::join_all(listing.into_iter().filter(|e| e.directory && !e.link).map(
            |entry| {
                let state = &state;
                let host = &host;
                let session = &session;
                async move {
                    let files = state
                        .fleet
                        .list_files(host, session, &format!("{DIR}/{}", entry.name))
                        .await;
                    (entry.name, files)
                }
            },
        ))
        .await;

    let mut folders = Vec::new();
    for (name, files) in inside {
        let Ok(Ok(files)) = files else { continue };
        let mut parts: Vec<String> = files
            .iter()
            .filter(|f| !f.directory)
            .map(|f| {
                format!(
                    "{}:{}:{}",
                    f.name,
                    f.size,
                    f.modified.map(|m| m.timestamp_millis()).unwrap_or(0)
                )
            })
            .collect();
        parts.sort();
        folders.push(Folder {
            name,
            fingerprint: parts.join("|"),
        });
    }

    // Order is the directory's, which `join_all` preserves, but the listing
    // itself is the worker's — so sort to make the response stable. The client
    // compares fingerprints per folder, not the list, but a stable order is
    // what makes two responses diffable by eye when one of them is wrong.
    folders.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(Json(folders))
}

/// An artifact as a file somebody can send to anyone.
///
/// **This is the only sharing that reaches outside your network.** The control
/// plane is deliberately not on the public internet, so a link — signed,
/// unauthenticated, "public" — is still only openable by somebody who can
/// reach this machine. For a client, or a friend, the URL is not partly useful
/// but useless, and an export is the whole answer.
///
/// Always a zip, even for the one-file case. A download that is sometimes an
/// `.html` and sometimes a `.zip` is two behaviours to explain and two paths to
/// get wrong, and the saving is a few hundred bytes.
#[utoipa::path(
    get, path = "/api/v1/artifacts/{id}/download", tag = "artifacts",
    params(("id" = String, Path, description = "Artifact id")),
    responses((status = 200, description = "A zip of the current version"), (status = 404, body = ApiError)),
)]
pub(super) async fn download_artifact(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let owner = principal
        .owner()
        .ok_or_else(|| ApiError::new(ErrorCode::Unauthorized, "Sign in to download."))?;

    // Ownership is checked here even though serving the artifact itself is not:
    // this endpoint is on the authenticated API, and an export is the one place
    // where "whose is this" is both answerable and cheap.
    let artifact = ft_core::ArtifactId::from_stored(id);
    if state.db.artifact_of(owner, &artifact).await?.is_none() {
        return Err(ApiError::not_found("artifact"));
    }

    let (slug, version, files) = state
        .db
        .artifact_bundle(&artifact)
        .await?
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    let bytes = {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let mut buffer = std::io::Cursor::new(Vec::new());
        let mut zipped = zip::ZipWriter::new(&mut buffer);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (path, body) in &files {
            zipped
                .start_file(path, options)
                .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e}")))?;
            zipped
                .write_all(body)
                .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e}")))?;
        }
        // `finish` consumes the writer and hands the sink back, which is also
        // what releases the borrow on the buffer.
        zipped
            .finish()
            .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e}")))?;
        buffer.into_inner()
    };

    let name = format!("{slug}-v{version}.zip");
    axum::response::Response::builder()
        .header(axum::http::header::CONTENT_TYPE, "application/zip")
        .header(axum::http::header::CONTENT_LENGTH, bytes.len())
        .header(
            axum::http::header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", name.replace('"', "")),
        )
        .body(axum::body::Body::from(bytes))
        .map_err(|e| ApiError::new(ErrorCode::Internal, format!("{e:#}")))
}
