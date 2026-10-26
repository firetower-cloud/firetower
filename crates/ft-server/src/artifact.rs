//! Serving an artifact.
//!
//! The other half of [`crate::preview`]: same door, same signature scheme,
//! same injected picker — and a completely different source of bytes. A
//! preview proxies to a port somebody is running. An artifact is read out of
//! storage, which is why it still answers when the worker is asleep, when the
//! session ended an hour ago, and when `reclaim.rs` has already taken the
//! workspace.
//!
//! **Why not one code path with a flag.** The lifetimes are opposites. A
//! preview cannot outlive its session and must not be stored; an artifact must
//! outlive it and is nothing but stored. Folding them together would put a
//! cascade from `sessions` next to a row that is deliberately exempt from one.

use axum::{
    extract::Request,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
};
use ft_core::ArtifactId;

use crate::AppState;

/// One file of one version, as stored.
pub struct Stored {
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Answer a request addressed to an artifact hostname.
pub async fn serve(state: AppState, artifact: ArtifactId, request: Request) -> Response {
    // The picker's own script, before anything is looked up: it is ours, not
    // the artifact's, and it must answer even for a path the artifact has no
    // file for.
    if request.uri().path() == crate::preview::annotations::RUNTIME_PATH {
        return crate::preview::annotations::runtime();
    }

    let Ok(Some(current)) = state.db.artifact_current(&artifact).await else {
        return gone("That artifact is not here any more.");
    };

    // `/` means the version's entry point. Everything else is an asset the
    // page reached for, resolved against the same origin — which is the whole
    // reason this is a hostname rather than a path prefix.
    let asked = request.uri().path().trim_start_matches('/');
    let wanted = if asked.is_empty() {
        current.entry.clone()
    } else {
        asked.to_string()
    };

    // A version's bytes cannot change — `20261023120000_artifacts.sql` makes a
    // version immutable and `publish_artifact` mints a new one rather than
    // editing this — so the version id *is* the validator. The path is in it
    // because one version holds many files and a cache in front of us should
    // never be able to confuse two of them.
    let tag = format!("\"{}:{}\"", current.id, wanted.replace('"', ""));

    // Answered before the body is read, which is the point of it: a revalidation
    // costs a primary-key lookup and an empty response rather than pulling the
    // bytes out of Postgres and running them through the rewriter again.
    if asked_for(request.headers(), &tag) {
        return (
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, tag),
                (header::CACHE_CONTROL, "no-cache".to_string()),
            ],
        )
            .into_response();
    }

    let file = match state.db.artifact_file(&current.id, &wanted).await {
        Ok(Some(file)) => file,
        Ok(None) => return missing(&wanted),
        Err(e) => {
            tracing::error!("reading an artifact file: {e:#}");
            return gone("Firetower could not read that artifact.");
        }
    };

    let is_html = file.content_type.starts_with("text/html");
    let response = (
        [(header::CONTENT_TYPE, file.content_type.clone())],
        file.body,
    )
        .into_response();

    // A capture is a top-level window, where the runtime disables itself on
    // `window.parent === window` anyway — so this is not about what ends up in
    // the photograph. It is the 21 KB of picker and the rewrite that produces
    // it, neither of which anything is going to use.
    let shooting = request.uri().query().is_some_and(|q| {
        q.split('&')
            .any(|p| p == "ft-shot" || p.starts_with("ft-shot="))
    });

    let mut response = if is_html && !shooting {
        // The same picker a preview gets, injected the same way. The artifact
        // never learns it is there, and no credential enters its origin.
        crate::preview::annotations::instrument(
            response,
            current.from_session.as_deref().unwrap_or(""),
            crate::preview::annotations::Target::Artifact(current.id.clone()),
            &state.public_url,
        )
    } else {
        response
    };

    // After `instrument`, never before: it strips the validators it was handed
    // because a proxied response's own `ETag` describes bytes it just rewrote.
    // This one is minted here, on the near side of that rewrite, so it is the
    // one thing in the response that does describe what is being sent.
    //
    // `no-cache` rather than `no-store`, which is what `instrument` leaves: the
    // address is the *artifact*, so what it points at changes when a new version
    // is published, and the client has to ask. It just no longer has to be
    // answered with 74 KB to be told nothing moved.
    if let Ok(tag) = header::HeaderValue::from_str(&tag) {
        let headers = response.headers_mut();
        headers.insert(header::ETAG, tag);
        headers.insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-cache"),
        );
    }
    response
}

/// Whether the asker already holds these bytes.
///
/// `If-None-Match` is a list, entries may be weak, and `*` means "anything you
/// have". Weak and strong compare alike here because there is only ever one
/// representation of a path within a version — there is no transfer-coding
/// variant for the distinction to be about.
fn asked_for(headers: &axum::http::HeaderMap, tag: &str) -> bool {
    let Some(held) = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    held.split(',')
        .map(|e| e.trim().trim_start_matches("W/"))
        .any(|e| e == "*" || e == tag)
}

/// Answer a request for an artifact's picture.
///
/// Unauthenticated and signed, like the artifact itself: an `<img>` cannot
/// carry a token, and the capability is in the name. Served from the
/// interface's own origin rather than the artifact's so that a library of
/// twenty tiles is twenty images on one connection instead of twenty origins.
pub async fn serve_poster(state: AppState, artifact: ArtifactId, request: Request) -> Response {
    let Ok(Some((version, png))) = state.db.artifact_poster(&artifact).await else {
        // No picture yet is the ordinary state of a version nothing has
        // rendered, and the client already draws a placeholder for it. 404 so
        // the `<img>` fails quietly rather than being cached as an error page.
        return StatusCode::NOT_FOUND.into_response();
    };

    // `immutable` is only true because the caller put the version in the
    // address — `present()` appends `?v=<version>`, and that is what makes
    // these bytes final *for this URL*.
    //
    // Said plainly because getting it wrong is silent: the first version of
    // this served `immutable` on the bare, artifact-addressed path, and a
    // browser holding v1's picture was told it could keep it for a year. It
    // did. The artifact moved to v3 and the library drew v1 with nothing
    // anywhere to suggest it was stale. A poster is immutable per *version*;
    // the path alone names the artifact, which is a different thing.
    //
    // The `ETag` is kept for the case the query string is dropped by something
    // in the middle: a revalidation then still costs an empty 304 rather than
    // the image.
    let tag = format!("\"{version}\"");
    if asked_for(request.headers(), &tag) {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, tag)]).into_response();
    }

    (
        [
            (header::CONTENT_TYPE, "image/png".to_string()),
            (header::ETAG, tag),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_string(),
            ),
        ],
        png,
    )
        .into_response()
}

/// A page, rather than a blank frame. Same reasoning as the preview's.
fn gone(why: &str) -> Response {
    page(StatusCode::NOT_FOUND, why, "Nothing is published here.")
}

fn missing(path: &str) -> Response {
    page(
        StatusCode::NOT_FOUND,
        "That file is not in this artifact.",
        &format!("It asked for {}.", html_escape(path)),
    )
}

fn page(status: StatusCode, title: &str, detail: &str) -> Response {
    let body = format!(
        "<!doctype html><meta charset=utf-8>\
         <title>No artifact</title>\
         <style>\
           html{{background:#131313;color:#e8e4dc;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}}\
           div{{max-width:44ch;margin:18vh auto;padding:0 2rem}}\
           p{{color:#8b8681;margin:.5rem 0 0}}\
         </style>\
         <div><strong>{}</strong><p>{}</p></div>",
        html_escape(title),
        detail
    );

    (
        status,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        body,
    )
        .into_response()
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// What a file's bytes should be served as.
///
/// From the extension, because that is all there is: the agent wrote a file,
/// not a content type. Anything unrecognised is `application/octet-stream`
/// rather than a guess — a wrong `text/html` would be an injection route.
pub fn content_type_of(path: &str) -> String {
    mime_guess::from_path(path)
        .first_raw()
        .map(|m| {
            if m.starts_with("text/") && !m.contains("charset") {
                format!("{m}; charset=utf-8")
            } else {
                m.to_string()
            }
        })
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_html_and_text_is_text() {
        assert!(content_type_of("index.html").starts_with("text/html"));
        assert!(content_type_of("style.css").starts_with("text/css"));
        assert!(content_type_of("app.js").contains("javascript"));
    }

    /// The charset matters: `instrument` only rewrites utf-8 html.
    #[test]
    fn text_carries_a_charset() {
        assert!(content_type_of("index.html").contains("charset=utf-8"));
    }

    /// Not a guess. A file we have no type for is bytes, never a document.
    #[test]
    fn something_unrecognised_is_not_called_html() {
        let t = content_type_of("notes.wat");
        assert_eq!(t, "application/octet-stream");
    }

    #[test]
    fn what_a_failure_says_is_escaped() {
        assert_eq!(html_escape("a <b> & c"), "a &lt;b&gt; &amp; c");
    }

    fn holding(value: &str) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::IF_NONE_MATCH, value.parse().unwrap());
        headers
    }

    #[test]
    fn nothing_held_is_not_a_match() {
        assert!(!asked_for(
            &axum::http::HeaderMap::new(),
            "\"v1:index.html\""
        ));
    }

    #[test]
    fn the_same_tag_is_a_match() {
        assert!(asked_for(
            &holding("\"v1:index.html\""),
            "\"v1:index.html\""
        ));
    }

    /// The case the whole thing is for: a new version means a new id, so what
    /// the browser is holding stops matching and it is sent the new bytes.
    #[test]
    fn another_version_is_not_a_match() {
        assert!(!asked_for(
            &holding("\"v1:index.html\""),
            "\"v2:index.html\""
        ));
    }

    /// One version holds many files, and two of them must never be confused
    /// for each other — which is why the path is in the tag at all.
    #[test]
    fn another_file_of_the_same_version_is_not_a_match() {
        assert!(!asked_for(
            &holding("\"v1:index.html\""),
            "\"v1:style.css\""
        ));
    }

    #[test]
    fn a_list_matches_on_any_of_its_entries() {
        assert!(asked_for(
            &holding("\"other\", \"v1:index.html\""),
            "\"v1:index.html\""
        ));
    }

    /// Weak and strong compare alike here: there is only one representation of
    /// a path within a version, so there is no distinction to preserve.
    #[test]
    fn a_weak_tag_still_matches() {
        assert!(asked_for(
            &holding("W/\"v1:index.html\""),
            "\"v1:index.html\""
        ));
    }

    #[test]
    fn a_star_matches_whatever_is_there() {
        assert!(asked_for(&holding("*"), "\"v1:index.html\""));
    }
}
