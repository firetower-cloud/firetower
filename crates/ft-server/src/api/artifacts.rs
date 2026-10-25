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
    let scheme = scheme_of(&headers);
    let port = port_of(&headers);

    Ok(Json(
        rows.into_iter()
            .map(|row| {
                let id = ft_core::ArtifactId::from_stored(row.id.clone());
                Artifact {
                    url: state.names.artifact_url(scheme, port, &id),
                    row,
                }
            })
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
        .artifacts_of(owner)
        .await?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    let artifact = ft_core::ArtifactId::from_stored(row.id.clone());
    Ok(Json(Artifact {
        url: state
            .names
            .artifact_url(scheme_of(&headers), port_of(&headers), &artifact),
        row,
    }))
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
        .artifacts_of(owner)
        .await?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    Ok(Json(Artifact {
        url: state
            .names
            .artifact_url(scheme_of(&headers), port_of(&headers), &artifact),
        row,
    }))
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
        .artifacts_of(&owner)
        .await?
        .into_iter()
        .find(|r| r.id == artifact.as_str())
        .ok_or_else(|| ApiError::not_found("artifact"))?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(Artifact {
            url: state
                .names
                .artifact_url(scheme_of(&headers), port_of(&headers), &artifact),
            row,
        }),
    ))
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

    let mut folders = Vec::new();
    for entry in listing.into_iter().filter(|e| e.directory && !e.link) {
        let inside = match state
            .fleet
            .list_files(&host, &session, &format!("{DIR}/{}", entry.name))
            .await
        {
            Ok(Ok(files)) => files,
            _ => continue,
        };
        let mut parts: Vec<String> = inside
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
            name: entry.name,
            fingerprint: parts.join("|"),
        });
    }

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
    if !state
        .db
        .artifacts_of(owner)
        .await?
        .iter()
        .any(|r| r.id == id)
    {
        return Err(ApiError::not_found("artifact"));
    }

    let artifact = ft_core::ArtifactId::from_stored(id);
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
