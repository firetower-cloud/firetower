//! The interface, inside the binary.
//!
//! Two bundles are compiled in here rather than shipped beside the binary.
//! That is what makes a deployment one image and one port: the browser talks to
//! the same origin it loaded the page from, so there is no CORS to configure,
//! no API address baked in at build time, and no second process to keep
//! running and to upgrade in step.
//!
//! **The application** is `desktop/dist` — the renderer, built for the web by
//! Vite. It takes `/`. It is a hash router (`desktop/src/shims/next-navigation.ts`,
//! which also folds bare-path `pushState` writes into the hash), so every route
//! it has lives after a `#` and the browser never sends one. The server owes it
//! exactly two things: its shell at `/`, and the files of its own bundle.
//!
//! **The administration site** is `web/out` — a `next build` static export, an
//! HTML file per route plus hashed assets. It keeps every path it answers
//! today except `/`.
//!
//! **No single-page fallback, deliberately.** It would be the obvious thing to
//! add and it is wrong here: a catch-all would swallow the administration
//! site's own paths, unknown `/api/…` paths, preview routing and artifact
//! routing. A hash router does not need one — there is no path to recover,
//! because there was never a path. The specification's end state is a path
//! router with a catch-all, and that arrives with the change that deletes the
//! administration site, not before.
//!
//! **When the interface was never built**, an embedded folder is empty and
//! every path says so in a sentence naming what to run, rather than 404ing and
//! leaving someone to guess whether the server is broken or a build step was
//! skipped.

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use rust_embed::RustEmbed;

/// The application. Empty until `cd desktop && pnpm build`; `just build` fills it.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../desktop/dist"]
struct Renderer;

/// The administration site. Empty until `cd web && pnpm build`; `just build`
/// fills it.
///
/// Both folders are created by `build.rs` rather than committed with something
/// in them, precisely so that this compiles either way — a contributor changing
/// Rust should not have to build two front ends first. The tests below are
/// written to that: each skips when the bundle it is about is absent.
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/out"]
struct Site;

/// Which bundle a file came from, and therefore which rules apply to it.
///
/// The caching rule below is the reason this exists as a type rather than as a
/// pair of prefixes in one function. There is one rule per bundler, each only
/// meaningful inside the tree its bundler wrote, and a union of both applied to
/// both trees would be a rule nobody could check: `assets/` means
/// content-hashed in Vite's output and means nothing at all in Next's.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Bundle {
    Renderer,
    Site,
}

impl Bundle {
    fn get(self, name: &str) -> Option<rust_embed::EmbeddedFile> {
        match self {
            Bundle::Renderer => Renderer::get(name),
            Bundle::Site => Site::get(name),
        }
    }

    fn names(self) -> Box<dyn Iterator<Item = std::borrow::Cow<'static, str>>> {
        match self {
            Bundle::Renderer => Box::new(Renderer::iter()),
            Bundle::Site => Box::new(Site::iter()),
        }
    }

    fn built(self) -> bool {
        self.names().next().is_some()
    }

    /// Whether this name is a content-hashed filename, and so safe to pin
    /// forever.
    ///
    /// **Read from where each bundler actually writes a hash into a filename**,
    /// which is the whole of the rule and is not guessable from the extension.
    ///
    /// - Vite writes `assets/<name>-<hash>.<ext>` and nothing else is hashed —
    ///   `index.html` names those files, and `public/` is copied through
    ///   verbatim under its own names (`voice-worklet.js` today).
    /// - Next writes hashed filenames under `_next/static/` and nothing else in
    ///   the export is safe to pin. Its `_next/<build id>/` siblings are route
    ///   payloads named by route, not by hash: the directory moves on each
    ///   build but the file inside it keeps its name, so pinning one would pin
    ///   a path that the next build reuses.
    ///
    /// There were two trees and one rule for a while, which is what this is
    /// here to prevent coming back: the surviving prefix was Next's, so every
    /// file in the renderer's bundle — which is all of its JavaScript — came
    /// back `no-cache` and revalidated on every single load. Nothing errors
    /// when that happens. It is only slower, forever.
    ///
    /// Both shells must keep coming out false, because a pinned shell makes an
    /// upgrade invisible until somebody clears their cache. That holds
    /// structurally rather than by a second check: neither hashed tree contains
    /// an `.html` file at all, and `nothing_marks_a_shell_immutable` asserts it
    /// over whatever is embedded.
    fn hashed(self, name: &str) -> bool {
        match self {
            Bundle::Renderer => name.starts_with("assets/"),
            Bundle::Site => name.starts_with("_next/static/"),
        }
    }

    fn load(self, name: &str) -> Option<Asset> {
        let file = self.get(name)?;

        Some(Asset {
            content_type: mime_guess::from_path(name)
                .first_or_octet_stream()
                .to_string(),
            immutable: self.hashed(name),
            body: file.data.into_owned(),
        })
    }
}

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

    if let Some(sentence) = unbuilt(Bundle::Renderer.built(), Bundle::Site.built()) {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            sentence,
        )
            .into_response();
    }

    match resolve(request.uri()) {
        Some(file) => file.into_response(),
        // The export's own not-found page, so a mistyped address still looks
        // like Firetower. 200 would be a lie to anything crawling it. It is the
        // administration site's — the renderer ships no such page, because a
        // hash router cannot be asked for a path it does not have.
        None => match Site::get("404.html") {
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

/// The sentence to say instead of serving anything, or `None` when both bundles
/// are here.
///
/// **A missing half stops everything, rather than serving the other half.** A
/// binary carrying one of the two is not a deployment anybody wants, and what
/// it looks like from a browser is either a blank root or a bare 404 on every
/// administration path — the two guesses ("is the server broken, or was a build
/// step skipped?") that this sentence exists to answer. Both `just build` and
/// the release image build both bundles, so the only way to reach this state is
/// to have built one by hand, which is exactly the person the sentence can
/// help.
///
/// Taking what it found rather than asking means every branch here can be read
/// back by a test on a machine that has built neither, which is every machine
/// running `backend-ci`.
fn unbuilt(renderer: bool, site: bool) -> Option<&'static str> {
    match (renderer, site) {
        (true, true) => None,
        (false, false) => Some(
            "This Firetower was built without the interface. Run `just build`, or use a \
             development server — the application on :5273, the administration site on :3000.\n",
        ),
        (false, true) => Some(
            "This Firetower was built without the application. Run `just build`, or \
             `cd desktop && pnpm build` for that half alone, or use the development server \
             on :5273.\n",
        ),
        (true, false) => Some(
            "This Firetower was built without the administration site. Run `just build`, or \
             `cd web && pnpm build` for that half alone, or use the development server \
             on :3000.\n",
        ),
    }
}

/// A file from a bundle, and the headers that go with it.
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
/// **Which bundle answers, stated once.** `/` is the application's shell. Any
/// other path is the application's if it names a file the application's bundle
/// actually carries, and the administration site's otherwise — where it is
/// still resolved as the file, the file with `.html`, or a directory's index,
/// because that is what a static export needs and the application needs none
/// of it.
///
/// The application's claim is read from its bundle rather than written down
/// here as `/assets/` and `/`, and that is deliberate. `desktop/public/` is
/// copied through to the root of the bundle under its own names, so a prefix
/// list silently 404s whatever is put there: `/voice-worklet.js` is in it
/// today, fetched by `ui/voice/capture.ts` through `addModule`, and the failure
/// would be dictation not working with nothing in the log to connect it to a
/// caching rule in a Rust file.
///
/// **What keeps that from being "try one, then the other".** Order only
/// decides anything where both bundles carry the same name, and
/// `the_bundles_claim_one_name_in_common` asserts that `index.html` is the only
/// one — the root, which is the single path this change deliberately takes off
/// the administration site. Anything else colliding later fails that test by
/// name, here, rather than becoming a page that quietly came from the wrong
/// application.
fn resolve(uri: &Uri) -> Option<Asset> {
    let path = uri.path().trim_start_matches('/');

    // A path that climbs out of a bundle is not a mistake anyone makes by
    // accident. rust-embed would not find anything anyway, since it holds a
    // flat map rather than a filesystem, but refusing here means that stays
    // true if either is ever backed by one — and it is checked once, above
    // both, so neither bundle can be given a lookup the other was guarded
    // against.
    if path.split('/').any(|segment| segment == "..") {
        return None;
    }

    // `/` is the one path that is empty after trimming, and it is the
    // application's. This is the one thing that used to resolve and now
    // resolves elsewhere: the administration site's `index.html` is its
    // download page, which tells a new self-hoster to go and install something
    // else, and not needing to is the point of the whole change.
    if path.is_empty() {
        return Bundle::Renderer.load("index.html");
    }

    if let Some(asset) = Bundle::Renderer.load(path) {
        return Some(asset);
    }

    let candidates = [
        path.to_string(),
        format!("{path}.html"),
        format!("{}/index.html", path.trim_end_matches('/')),
    ];

    candidates
        .iter()
        .find_map(|candidate| Bundle::Site.load(candidate))
}

#[cfg(test)]
mod tests {
    //! Most of these run against whatever is embedded, so each one skips when
    //! the bundle it is about is absent — `Bundle::built` is the guard.
    //!
    //! That is not padding. `backend-ci` builds neither front end before
    //! `cargo test --workspace`, and a checkout being changed for a Rust reason
    //! usually has not built them either; asserting regardless would fail for a
    //! reason that has nothing to do with the code under test, every time, for
    //! everybody. The two with nothing to read out of a bundle — the traversal
    //! guard and the sentence — assert unconditionally.
    use super::*;

    fn resolve_path(path: &str) -> Option<Asset> {
        resolve(&path.parse::<Uri>().unwrap())
    }

    /// A name from `bundle` that its own rule calls content-hashed.
    ///
    /// Taken from the bundle instead of written out, because a hash is not
    /// something a test can know — it is this build's and nothing else's, and a
    /// name spelled out here would be a test that passed once.
    fn a_hashed_file(bundle: Bundle) -> Option<String> {
        bundle
            .names()
            .find(|name| bundle.hashed(name) && name.ends_with(".js"))
            .map(|name| name.into_owned())
    }

    #[test]
    fn the_root_is_the_applications_shell() {
        if !Bundle::Renderer.built() {
            return;
        }
        let asset = resolve_path("/").expect("desktop/dist/index.html");
        assert!(asset.content_type.starts_with("text/html"));
        assert!(!asset.immutable, "the shell must be re-checked every load");
        // Not merely *a* shell. The administration site has an `index.html`
        // too, and serving that one is the bug this whole change is about.
        assert_eq!(
            asset.body,
            Renderer::get("index.html").unwrap().data.into_owned(),
            "the root is the application's shell, not the site's download page"
        );
    }

    #[test]
    fn a_hashed_application_asset_is_pinned() {
        if !Bundle::Renderer.built() {
            return;
        }
        let name = a_hashed_file(Bundle::Renderer).expect("Vite writes assets/<name>-<hash>.js");
        assert!(
            Bundle::Renderer.load(&name).unwrap().immutable,
            "{name} is content-hashed and must come back immutable"
        );
        // Through `resolve`, not only through `load`: a rule that is right in
        // isolation and unreachable through routing is still the slow build.
        assert!(
            resolve_path(&format!("/{name}")).unwrap().immutable,
            "/{name} must reach the application's bundle"
        );
    }

    #[test]
    fn a_hashed_administration_asset_is_still_pinned() {
        if !Bundle::Site.built() {
            return;
        }
        let name = a_hashed_file(Bundle::Site).expect("Next writes _next/static/…");
        assert!(Bundle::Site.load(&name).unwrap().immutable);
        assert!(resolve_path(&format!("/{name}")).unwrap().immutable);
    }

    #[test]
    fn neither_shell_is_pinned() {
        if Bundle::Renderer.built() {
            assert!(!Bundle::Renderer.load("index.html").unwrap().immutable);
        }
        if Bundle::Site.built() {
            assert!(!Bundle::Site.load("index.html").unwrap().immutable);
            assert!(!Bundle::Site.load("organization.html").unwrap().immutable);
        }
    }

    /// The general form of the two above, over everything embedded rather than
    /// over the names this test could think of. An upgrade nobody sees until
    /// they clear their cache is the worst outcome in this file, and it would
    /// arrive as one `.html` file landing inside a hashed tree.
    #[test]
    fn nothing_marks_a_shell_immutable() {
        for bundle in [Bundle::Renderer, Bundle::Site] {
            for name in bundle.names() {
                if name.ends_with(".html") {
                    assert!(
                        !bundle.hashed(&name),
                        "{bundle:?} would pin {name}, and a pinned shell hides an upgrade"
                    );
                }
            }
        }
    }

    /// Nothing an unhashed file is served with may be pinned either — the
    /// renderer copies `desktop/public/` through to the root of its bundle
    /// under unchanged names, and `voice-worklet.js` is fetched by that name.
    #[test]
    fn a_passthrough_file_is_not_pinned() {
        if !Bundle::Renderer.built() {
            return;
        }
        let asset = resolve_path("/voice-worklet.js").expect("copied from desktop/public");
        assert!(
            !asset.immutable,
            "its name carries no hash, so a new one would never be fetched"
        );
    }

    /// What makes the precedence in `resolve` safe to state in one direction.
    #[test]
    fn the_bundles_claim_one_name_in_common() {
        if !Bundle::Renderer.built() || !Bundle::Site.built() {
            return;
        }
        let shared: Vec<_> = Bundle::Renderer
            .names()
            .filter(|name| Site::get(name).is_some())
            .collect();
        assert_eq!(
            shared,
            ["index.html"],
            "only the root is contested, and the application wins it on purpose; \
             anything else here is a path served from whichever bundle happens to \
             be asked first"
        );
    }

    #[test]
    fn an_administration_route_resolves_to_its_page() {
        if !Bundle::Site.built() {
            return;
        }
        for path in ["/organization", "/organization/people", "/login", "/setup"] {
            let asset = resolve_path(path).unwrap_or_else(|| panic!("{path} must still resolve"));
            assert!(asset.content_type.starts_with("text/html"), "{path}");
        }
    }

    #[test]
    fn a_path_nobody_exported_is_not_served() {
        if !Bundle::Site.built() {
            return;
        }
        assert!(resolve_path("/sessions/01J8ZXQ2K3M4N5P6R7S8T9V0W1").is_none());
    }

    #[test]
    fn nothing_climbs_out_of_either_bundle() {
        assert!(resolve_path("/../../etc/passwd").is_none());
        assert!(resolve_path("/_next/../../../etc/passwd").is_none());
        assert!(resolve_path("/assets/../../../etc/passwd").is_none());
        // Percent-encoded, which `Uri::path` does not decode — so this is not
        // the `..` guard firing, it is there being no file by that literal
        // name. Asserted anyway: the pair of them is what a scanner sends, and
        // a later change that starts decoding the path has to keep both
        // answers.
        assert!(resolve_path("/assets/..%2f..%2fetc/passwd").is_none());
    }

    #[test]
    fn an_invented_top_level_path_is_not_answered() {
        if !Bundle::Site.built() {
            return;
        }
        assert!(
            resolve_path("/nonsense").is_none(),
            "neither bundle carries it, and nothing falls back to a shell"
        );
    }

    /// The sentence names the half that is missing, because "run `just build`"
    /// on a checkout where one of them *was* built reads as already done.
    ///
    /// All four states, which is why `unbuilt` is asked rather than told: a
    /// test that could only exercise whichever state this checkout happens to
    /// be in would assert nothing at all on `backend-ci`, where neither front
    /// end is built and the only reachable branch is the one nobody reads.
    #[test]
    fn the_sentence_names_the_half_that_is_missing() {
        assert!(unbuilt(true, true).is_none(), "nothing to say");

        let renderer = unbuilt(false, true).expect("a sentence");
        assert!(renderer.contains("without the application"), "{renderer}");
        assert!(renderer.contains("cd desktop && pnpm build"), "{renderer}");

        let site = unbuilt(true, false).expect("a sentence");
        assert!(site.contains("without the administration site"), "{site}");
        assert!(site.contains("cd web && pnpm build"), "{site}");

        // With both gone there is no half to name, so it names neither and
        // points at the one command that builds them together.
        let both = unbuilt(false, false).expect("a sentence");
        assert!(both.contains("without the interface"), "{both}");
        assert!(both.contains("just build"), "{both}");
    }
}
