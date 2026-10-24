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

    if is_html {
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
    }
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
}
