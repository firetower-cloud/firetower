//! The interface, inside the binary.
//!
//! `next build` writes a static export — an HTML file per route plus hashed
//! assets — and it is compiled in here rather than shipped beside the binary.
//! That is what makes a deployment one image and one port: the browser talks to
//! the same origin it loaded the page from, so there is no CORS to configure,
//! no API address baked in at build time, and no second process to keep
//! running and to upgrade in step.
//!
//! **The placeholder.** An export has to know every path when it is built, and
//! session ids are made at runtime. So `/sessions/[id]` is written once as
//! `sessions/_.html`, and any `/sessions/…` request is answered with that one
//! shell; the page reads the real id from the address bar. [`resolve`] is where
//! that happens, and it is the only clever thing in this file.
//!
//! **When the interface was never built**, the embedded folder is empty and
//! every path says so in a sentence, rather than 404ing and leaving someone to
//! guess whether the server is broken or the build step was skipped.

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use rust_embed::RustEmbed;

/// Empty in a checkout that has not run `pnpm build`; `just build` fills it.
///
/// The folder is committed with nothing in it precisely so that this compiles
/// either way — a contributor changing Rust should not have to build the web
/// application first.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/out"]
struct Assets;

/// Everything the API did not claim.
pub async fn serve(request: Request) -> Response {
    let path = request.uri().path();

    // An unknown API path is a mistake by something that speaks JSON, and
    // answering it with a page of HTML turns a clear 404 into a parse error in
    // whatever asked.
    if path.starts_with("/api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(crate::api::ApiError::new(
                crate::api::ErrorCode::NotFound,
                "no such endpoint",
            )),
        )
            .into_response();
    }

    if Assets::iter().next().is_none() {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "This Firetower was built without the interface. Run `just build`, or use the \
             development server on :3000.\n",
        )
            .into_response();
    }

    match resolve(request.uri()) {
        Some(file) => file.into_response(),
        // The export's own not-found page, so a mistyped address still looks
        // like Firetower. 200 would be a lie to anything crawling it.
        None => match Assets::get("404.html") {
            Some(page) => (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                page.data.into_owned(),
            )
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        },
    }
}

/// A file from the export, and the headers that go with it.
struct Asset {
    body: Vec<u8>,
    content_type: String,
    /// Hashed filenames never change contents; everything else must be
    /// re-checked or an upgrade is invisible until someone clears their cache.
    immutable: bool,
}

impl IntoResponse for Asset {
    fn into_response(self) -> Response {
        let cache = if self.immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };

        Response::builder()
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&self.content_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            )
            .header(header::CACHE_CONTROL, HeaderValue::from_static(cache))
            .body(Body::from(self.body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
    }
}

/// Find what to send for a path.
///
/// In order: the file itself, the file with `.html`, a directory's index, and
/// finally the dynamic-route shell — a path whose last segment matched nothing
/// is a runtime value, and the export wrote that route as `_`.
fn resolve(uri: &Uri) -> Option<Asset> {
    let path = uri.path().trim_start_matches('/');

    // `/` is the one path that is empty after trimming.
    let path = if path.is_empty() { "index.html" } else { path };

    // A path that climbs out of the export is not a mistake anyone makes by
    // accident. rust-embed would not find anything anyway, since it holds a
    // flat map rather than a filesystem, but refusing here means that stays
    // true if it is ever backed by one.
    if path.split('/').any(|segment| segment == "..") {
        return None;
    }

    let candidates = [
        path.to_string(),
        format!("{path}.html"),
        format!("{}/index.html", path.trim_end_matches('/')),
    ];

    for candidate in candidates {
        if let Some(asset) = load(&candidate) {
            return Some(asset);
        }
    }

    // `/sessions/01J8…` → `sessions/_.html`. Only one segment is replaced:
    // deeper guessing would start answering paths that genuinely are not there.
    let (parent, _) = path.rsplit_once('/')?;
    load(&format!("{parent}/_.html"))
}

fn load(name: &str) -> Option<Asset> {
    let file = Assets::get(name)?;

    Some(Asset {
        content_type: mime_guess::from_path(name)
            .first_or_octet_stream()
            .to_string(),
        // Next writes hashed filenames under this one directory, and nothing
        // else in the export is safe to pin.
        immutable: name.starts_with("_next/static/"),
        body: file.data.into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These run against whatever the export currently holds. In a checkout
    /// that has not built the web application there is nothing to serve, and
    /// asserting otherwise would fail for a reason that has nothing to do with
    /// the code under test.
    fn built() -> bool {
        Assets::iter().next().is_some()
    }

    fn resolve_path(path: &str) -> Option<Asset> {
        resolve(&path.parse::<Uri>().unwrap())
    }

    #[test]
    fn the_root_is_the_index() {
        if !built() {
            return;
        }
        let asset = resolve_path("/").expect("index.html");
        assert!(asset.content_type.starts_with("text/html"));
        assert!(!asset.immutable, "the shell must be re-checked every load");
    }

    #[test]
    fn a_route_resolves_to_its_page() {
        if !built() {
            return;
        }
        assert!(resolve_path("/secrets").is_some(), "secrets.html");
    }

    /// The reason this module has a resolver at all.
    #[test]
    fn any_session_gets_the_one_shell_that_was_built_for_all_of_them() {
        if !built() {
            return;
        }
        let asset =
            resolve_path("/sessions/01J8ZXQ2K3M4N5P6R7S8T9V0W1").expect("the placeholder shell");
        assert!(asset.content_type.starts_with("text/html"));
    }

    #[test]
    fn hashed_assets_are_pinned_and_nothing_else_is() {
        if !built() {
            return;
        }
        let hashed =
            Assets::iter().find(|name| name.starts_with("_next/static/") && name.ends_with(".js"));
        if let Some(name) = hashed {
            assert!(load(&name).unwrap().immutable);
        }
        assert!(!load("index.html").unwrap().immutable);
    }

    #[test]
    fn nothing_climbs_out_of_the_export() {
        assert!(resolve_path("/../../etc/passwd").is_none());
        assert!(resolve_path("/_next/../../../etc/passwd").is_none());
    }

    #[test]
    fn an_invented_top_level_path_is_not_answered() {
        if !built() {
            return;
        }
        assert!(
            resolve_path("/nonsense").is_none(),
            "only a path with a parent can be a dynamic route"
        );
    }
}
