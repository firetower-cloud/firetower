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
//! HTML file per route plus hashed assets. Three routes are left of it:
//! `/login`, `/setup` and `/account`. It used to carry `/` and six
//! `/organization/…` pages as well; the renderer carries those subjects now,
//! nothing linked to them, and they were deleted rather than left to rot. `/`
//! had already moved here — it is the renderer's shell — and the site no
//! longer exports an `index.html` at all.
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
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

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

/// What a page served from here may load, and from where.
///
/// **Derived from the policy the desktop shell already ships**
/// (`desktop/src-tauri/tauri.conf.json`, `app.security.csp`, which
/// `desktop/src/shell-csp.test.ts` asserts) rather than invented, because that
/// string is the one proven against this application in a shipped build. Two
/// things are dropped from it: `ipc:` and `http://ipc.localhost`, which are
/// Tauri's own transport and address nothing over HTTP.
///
/// **This is a production-only failure class, and it has bitten this project
/// before.** `shell-csp.test.ts` exists because of it: Tauri injects its policy
/// only into documents it serves itself, so `pnpm dev` carries none, and
/// `img-src` was once too narrow — a release drew a placeholder for every
/// artifact tile while development drew the picture. Nothing errors. A
/// directive that is too narrow is simply a feature that does not work for
/// everybody except the person who wrote it. So every allowance below is
/// either carried across from that string or measured against the bundles as
/// built, and both bundles were driven in a browser against a non-dev server
/// with the violation reporter wired up before this was committed.
///
/// What each is load-bearing for:
///
/// - `img-src … http: https:` — the incident above. A thumbnail is an `<img>`
///   against whichever control plane the artifact lives on.
/// - `img-src … data: blob:` — a screenshot pasted into the composer, and a
///   picture read through the API with a bearer token.
/// - `connect-src … http: https: ws: wss:` — the API and the event stream.
///   Same-origin now that the control plane serves the page, but
///   multi-installation switching is still in the product and still reaches
///   another Firetower.
/// - `frame-src 'self' http: https:` — `PreviewTab` and `ArtifactTab` both
///   embed an `<iframe>`, and a preview and an artifact are each a whole
///   hostname of their own. Narrowing this would empty both tabs. Neither is
///   reachable on a fresh install with no worker, so neither was driven here;
///   carrying the shipped string across verbatim is what keeps that surface's
///   constraints exactly as they are today.
/// - `style-src 'unsafe-inline'` — React writes `style` attributes and xterm
///   injects a stylesheet. Not optional for either bundle.
///
/// `fonts.googleapis.com` and `fonts.gstatic.com` are carried across and appear
/// to be referenced by nothing: both applications ship their own woff2 and a
/// grep of the built bundles and of both sources finds neither host. They are
/// kept anyway, deliberately. Removing an allowance is the direction that fails
/// invisibly in a release, which is the whole subject of this comment, and the
/// saving is two font hosts. They are the first thing to drop for somebody who
/// can watch a real deployment afterwards.
///
/// **`eval` stays blocked, and that was measured rather than assumed.** Driving
/// both bundles turned up one violation and only one, on every page of both:
/// `script-src blocked eval`, from a zero-argument `Function()` inside a lazy
/// `get value` getter in each bundle's vendor chunk — a feature probe. Nothing
/// is thrown, every page renders with live data, signing in works, and a `POST`
/// issued from a page under this policy comes back 200. It is also not a
/// regression for the renderer: the shell ships `default-src 'self'` with no
/// `script-src` either, which blocks `eval` in exactly the same way, so the
/// renderer has run against this in every release. `'unsafe-eval'` would buy
/// nothing and is in neither policy.
///
/// No `script-src` here, so scripts fall back to `default-src 'self'` — the
/// same arrangement the shell ships, and the same thing
/// `shell-csp.test.ts`'s "does not let anything execute from off the machine"
/// is about. [`SITE_POLICY`] is where that is not true.
const POLICY: &str = "default-src 'self'; \
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
font-src 'self' https://fonts.gstatic.com; \
img-src 'self' data: blob: http: https:; \
connect-src 'self' http: https: ws: wss:; \
frame-src 'self' http: https:; \
frame-ancestors 'none'; \
base-uri 'self'; \
object-src 'none'";

/// [`POLICY`] with one directive in front of it, for the administration site.
///
/// **Its export cannot run without inline script.** Every one of the five
/// exported pages carries two inline `<script>` blocks — `self.__next_f.push(…)`,
/// the server-component payload the page hydrates from — and no usable nonce:
/// the only `nonce` in the HTML is an escaped string inside that payload, and a
/// static export written at build time could not carry a per-request one
/// anyway. Under `default-src 'self'` alone the browser refuses both, and the
/// administration site renders an empty page. In production. Only.
///
/// Hashing them instead was considered and is not worth it: the payload differs
/// per page and changes on every build, so it would be a hash per page to
/// regenerate whenever anybody edits a screen, and a stale one fails exactly
/// the same silent way.
///
/// So this is scoped to the bundle that needs it rather than granted to both.
/// The renderer has no inline script at all — its shell is three `src=`
/// references — and it is the surface growing the controls that invite a
/// person and change a role, so it is the one that keeps the strict rule. This
/// directive goes away with the administration site.
const SITE_POLICY: &str = "script-src 'self' 'unsafe-inline'; \
default-src 'self'; \
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; \
font-src 'self' https://fonts.gstatic.com; \
img-src 'self' data: blob: http: https:; \
connect-src 'self' http: https: ws: wss:; \
frame-src 'self' http: https:; \
frame-ancestors 'none'; \
base-uri 'self'; \
object-src 'none'";

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

    /// What a document from this bundle is allowed to load, and from where.
    fn policy(self) -> &'static str {
        match self {
            Bundle::Renderer => POLICY,
            Bundle::Site => SITE_POLICY,
        }
    }

    fn load(self, name: &str) -> Option<Asset> {
        let file = self.get(name)?;
        Some(self.describe(name, file.data.into_owned()))
    }

    /// The headers a file of this name gets, whatever its bytes turn out to be.
    ///
    /// Split out of [`load`](Self::load) so that every step from a filename to
    /// a `Cache-Control` can be read back with no bundle on disk. That is not a
    /// tidiness: `backend-ci` is the only job that runs `cargo test
    /// --workspace` and it builds neither front end, so a test that has to find
    /// a real hashed file to assert anything asserts nothing there — which is
    /// the one place it would ever catch somebody. See
    /// `the_cache_rule_holds_with_no_bundle_on_disk`.
    fn describe(self, name: &str, body: Vec<u8>) -> Asset {
        Asset {
            content_type: mime_guess::from_path(name)
                .first_or_octet_stream()
                .to_string(),
            immutable: self.hashed(name),
            policy: self.policy(),
            body,
        }
    }
}

/// Everything the API did not claim.
pub async fn serve(request: Request) -> Response {
    let path = request.uri().path();

    // An unknown API path is a mistake by something that speaks JSON, and
    // answering it with a page of HTML turns a clear 404 into a parse error in
    // whatever asked.
    if path.starts_with("/api/") {
        return hardened(
            (
                StatusCode::NOT_FOUND,
                Json(crate::api::ApiError::new(
                    crate::api::ErrorCode::NotFound,
                    "no such endpoint",
                )),
            )
                .into_response(),
            POLICY,
        );
    }

    if let Some(sentence) = unbuilt(Bundle::Renderer.built(), Bundle::Site.built()) {
        return hardened(
            (
                StatusCode::NOT_FOUND,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                sentence,
            )
                .into_response(),
            POLICY,
        );
    }

    match resolve(request.uri()) {
        Some(file) => file.into_response(),
        // The export's own not-found page, so a mistyped address still looks
        // like Firetower. 200 would be a lie to anything crawling it. It is the
        // administration site's — the renderer ships no such page, because a
        // hash router cannot be asked for a path it does not have.
        // Its policy is the site's, because the page is: it hydrates from the
        // same two inline scripts every other exported page does.
        None => match Site::get("404.html") {
            Some(page) => hardened(
                (
                    StatusCode::NOT_FOUND,
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    page.data.into_owned(),
                )
                    .into_response(),
                SITE_POLICY,
            ),
            None => hardened(StatusCode::NOT_FOUND.into_response(), POLICY),
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

/// A short fingerprint of the interface this binary carries.
///
/// **A version number cannot tell two builds apart, and that is what this is
/// for.** `CARGO_PKG_VERSION` names the last release, so every image built
/// from `main` between two releases reports the same one — the `edge` tag is
/// rebuilt on every push and calls itself whatever the previous release was
/// called. A deployment that pulled a new image and a deployment that failed
/// to therefore show the same *Version* on the deployment screen, and the
/// question that screen exists to answer ("is what I deployed actually
/// running?") cannot be answered there.
///
/// Taken from the embedded filenames rather than from git, because git is not
/// present where the answer is needed: `.dockerignore` keeps `.git` out of the
/// build context, so a SHA read at compile time would be blank in exactly the
/// image whose identity is in doubt. Both bundlers write a content hash into
/// the filenames they emit — which is the same property [`Bundle::hashed`]
/// relies on to pin them forever — so the set of names changes whenever the
/// interface does, and is available wherever the bundles are.
///
/// Names only, not bodies: the names already carry the hashes, and hashing a
/// few hundred short strings costs nothing beside re-reading several megabytes.
/// Sorted, because `RustEmbed`'s iteration order is not promised to be stable.
///
/// `None` when neither bundle was built, which is every `cargo test` run and
/// every `cargo run` without a prior `just build`. There is no interface to
/// fingerprint there, and a constant standing in for one would be a lie told
/// on the screen that is meant to settle this.
pub fn interface_build() -> Option<&'static str> {
    static BUILD: OnceLock<Option<String>> = OnceLock::new();
    BUILD
        .get_or_init(|| {
            fingerprint(
                [Bundle::Renderer, Bundle::Site]
                    .into_iter()
                    .flat_map(|bundle| bundle.names()),
            )
        })
        .as_deref()
}

/// The digest itself, over whatever names it is handed.
///
/// Separate from [`interface_build`] so that it can be driven with names: the
/// bundles are absent under `cargo test` — which is the point of
/// [`unbuilt`] — so a test calling the public function could only ever observe
/// the `None` branch, and the properties worth holding are all in this one.
fn fingerprint<'a>(names: impl Iterator<Item = std::borrow::Cow<'a, str>>) -> Option<String> {
    let mut names: Vec<_> = names.collect();
    if names.is_empty() {
        return None;
    }
    // `RustEmbed`'s iteration order is not promised, and two orderings of one
    // interface must not read as two interfaces.
    names.sort_unstable();

    let mut digest = Sha256::new();
    for name in names {
        digest.update(name.as_bytes());
        // A separator, so two different splits of the same concatenated text
        // cannot collide: `ab` + `c` and `a` + `bc` are different sets of
        // files and have to hash differently.
        digest.update([0]);
    }
    // Six bytes of it, as hex. Long enough that two interfaces will not
    // collide, short enough to read off a screen and compare.
    Some(
        digest.finalize()[..6]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// A file from a bundle, and the headers that go with it.
struct Asset {
    body: Vec<u8>,
    content_type: String,
    /// Hashed filenames never change contents; everything else must be
    /// re-checked or an upgrade is invisible until someone clears their cache.
    immutable: bool,
    /// Which bundle's content policy this file is served under.
    policy: &'static str,
}

/// The headers every response from this module carries, whatever it is.
///
/// Stamped in one place, on the way out, rather than at each of the four points
/// that build a response here — the same argument as checking `..` once above
/// both bundles. A header set that has to be remembered per branch is one that
/// will be missing from the branch added next, and "which responses carry a
/// frame rule" is not a question anybody should have to answer by reading.
///
/// **Framing is the one that is genuinely new.** A Tauri window cannot be put
/// in somebody else's page; a web page can, and the page now being served is
/// the one growing the controls that invite a person and change their role. A
/// clickjacked administrator is the concrete risk, so the frame rule is said
/// twice: `frame-ancestors` for browsers that read the policy, and
/// `X-Frame-Options` for the older ones that only read the header. Neither
/// touches artifacts or previews — those are answered by `preview_first` and
/// `artifact::serve`, before anything reaches this module, and they are
/// embedded *by* the application rather than embedding it.
///
/// **`nosniff` matters here specifically.** `load` falls back to
/// `application/octet-stream` for a name whose type it cannot guess, and a
/// browser left to sniff may conclude something else entirely — which turns an
/// unrecognised file in a bundle into whatever the sniffer decides it is.
///
/// `Referrer-Policy: same-origin` because an address here can carry a session
/// or workspace id in its path, and nothing in either bundle needs a referrer
/// to arrive at another origin. Not `no-referrer`: same-origin requests keep
/// theirs, which costs nothing and leaves ordinary navigation legible in a log.
fn hardened(mut response: Response, policy: &'static str) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(policy),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    response
}

impl IntoResponse for Asset {
    fn into_response(self) -> Response {
        let cache = if self.immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };

        let policy = self.policy;
        let response = Response::builder()
            .header(
                header::CONTENT_TYPE,
                HeaderValue::from_str(&self.content_type)
                    .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
            )
            .header(header::CACHE_CONTROL, HeaderValue::from_static(cache))
            .body(Body::from(self.body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());

        hardened(response, policy)
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
/// `the_bundles_claim_no_name_in_common` asserts that none do. It used to
/// assert that `index.html` was the one — the root, contested because both
/// bundles had a shell. The site no longer exports a root page, so the
/// collision is gone rather than merely decided, and the test now says so.
/// Anything colliding later fails it by name, here, rather than becoming a
/// page that quietly came from the wrong application.
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
    // application's. Still spelled out rather than left to the lookups below:
    // an empty name is in neither bundle, so without this the root would 404.
    // The site's own `index.html` — a download page telling a new self-hoster
    // to go and install something else — was deleted once this stopped
    // reaching it.
    if path.is_empty() {
        return Bundle::Renderer.load("index.html");
    }

    if let Some(asset) = Bundle::Renderer.load(path) {
        return Some(asset);
    }

    site_candidates(path)
        .iter()
        .find_map(|candidate| Bundle::Site.load(candidate))
}

/// The names the administration site is asked for, in order, for one path.
///
/// Three lines with a name on them rather than three lines inside [`resolve`],
/// because the collision guard in the tests below has to ask the same question
/// the router asks, and for a while it asked a narrower one: `Site::get(name)`
/// for each of the renderer's raw names. Those are two different notions of
/// "the site carries this", and the gap between them is exactly one file.
///
/// An extensionless name in `desktop/public/` — `login`, `account`, `setup` —
/// is copied to the root of the renderer's bundle, wins that path ahead of the
/// site, and was invisible to the guard, because `Site::get("account")` is
/// `None` while the site answers `/account` out of `account.html`. The route
/// would quietly start serving a renderer asset and the test nominated as what
/// makes the one-directional precedence safe would have nothing to say. One
/// definition, asked twice, is the whole fix; `resolve` behaves exactly as it
/// did.
fn site_candidates(path: &str) -> [String; 3] {
    [
        path.to_string(),
        format!("{path}.html"),
        format!("{}/index.html", path.trim_end_matches('/')),
    ]
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
            // The site's own shells, by the names it exports now. It had an
            // `index.html` until `/` became the renderer's and the download
            // page behind it was deleted; `login.html` is the one route that
            // answers whether or not there is a session, so it is the one that
            // always exists.
            assert!(!Bundle::Site.load("login.html").unwrap().immutable);
            assert!(!Bundle::Site.load("account.html").unwrap().immutable);
            assert!(!Bundle::Site.load("404.html").unwrap().immutable);
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

    /// Whether the administration site would answer this path — the question
    /// `resolve` asks, which is not the question `Site::get` answers.
    fn site_answers(path: &str) -> bool {
        site_candidates(path)
            .iter()
            .any(|candidate| Site::get(candidate).is_some())
    }

    /// What makes the precedence in `resolve` safe to state in one direction.
    ///
    /// Asked through `site_candidates`, because the router is. Asking
    /// `Site::get` alone let an extensionless file in `desktop/public/` take a
    /// route the site serves as `<name>.html`: dropping a file called `account`
    /// in there hijacked `/account` and the whole suite stayed green, including
    /// this test and including `an_administration_route_resolves_to_its_page`,
    /// which only enumerates four routes and does not enumerate that one.
    ///
    /// **The one contested name has gone rather than been decided.** This used
    /// to assert `["index.html"]` — both bundles had a shell and `resolve`
    /// hands the root to the renderer on purpose. The administration site no
    /// longer exports a root page at all, so there is nothing left to contest,
    /// and the list is empty. That is a stronger claim than the old one and is
    /// asserted the same way: a name arriving in both bundles later fails
    /// here, by name.
    #[test]
    fn the_bundles_claim_no_name_in_common() {
        if !Bundle::Renderer.built() || !Bundle::Site.built() {
            return;
        }
        let shared: Vec<_> = Bundle::Renderer
            .names()
            .filter(|name| site_answers(name))
            .collect();
        let none: [std::borrow::Cow<'static, str>; 0] = [];
        assert_eq!(
            shared, none,
            "nothing is contested now that the site exports no root page; \
             anything here is an administration route quietly served out of \
             the renderer's bundle"
        );
    }

    /// And the reason it is empty, said directly, so that the deletion is what
    /// a failure points at.
    ///
    /// Without this the test above would also pass if the renderer stopped
    /// shipping an `index.html` — which is a different and much worse world.
    #[test]
    fn the_site_exports_no_root_page() {
        if !Bundle::Site.built() {
            return;
        }
        assert!(
            Site::get("index.html").is_none(),
            "the site's root was a download page, the renderer serves `/` now, \
             and a page here again is a page nothing can reach"
        );
        if Bundle::Renderer.built() {
            assert!(
                Renderer::get("index.html").is_some(),
                "and the root the application answers with is still there"
            );
        }
    }

    /// The routes the site still has, and the ones it stopped having.
    ///
    /// **Both halves, because the deletion is the change.** The first is the
    /// property that was always here — the site answers its own paths out of
    /// its own export — over the set that is left. `/account` is in it now and
    /// was not before: it holds the only voluntary password form in the
    /// product and is what the desktop app's *change password* opens.
    ///
    /// The second is what this commit did. A deleted route must come back as
    /// nothing from `resolve`, which is a 404 — the alternative, had the
    /// export kept half of itself, is a page served out of a bundle that no
    /// longer has the component behind it.
    #[test]
    fn an_administration_route_resolves_to_its_page() {
        if !Bundle::Site.built() {
            return;
        }
        for path in ["/login", "/setup", "/account"] {
            let asset = resolve_path(path).unwrap_or_else(|| panic!("{path} must still resolve"));
            assert!(asset.content_type.starts_with("text/html"), "{path}");
        }
    }

    #[test]
    fn a_deleted_administration_route_is_not_served() {
        if !Bundle::Site.built() {
            return;
        }
        for path in [
            "/organization",
            "/organization/people",
            "/organization/teams",
            "/organization/access",
            "/organization/usage",
            "/organization/settings",
        ] {
            assert!(
                resolve_path(path).is_none(),
                "{path} was deleted; the renderer carries its subject now"
            );
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

    /// **The cache rule, as a rule.** This is the one that has to work on the
    /// branch.
    ///
    /// Every test above that reads a name out of an embed returns early on
    /// `backend-ci`, which runs `cargo test --workspace` and builds neither
    /// front end — so they are the developer-machine check and nothing more.
    /// Measured, not assumed: with both bundles absent, re-applying the
    /// `_next/static/` regression to the renderer's rule passed 12 of 12. The
    /// guard written to stop the specification's silent trap returning was
    /// blind in the only place it would ever catch anybody.
    ///
    /// So the decision is tested where it actually lives. It is a pure
    /// predicate over a filename; these filenames are invented, and the shapes
    /// they are invented in are the shapes each bundler really writes.
    /// What the fingerprint is for, stated as the thing that must not happen.
    ///
    /// The defect it answers: an `edge` image built from `main` reports the
    /// previous release's version, so a deployment that pulled it and one that
    /// did not show the same *Version* on the deployment screen. Two different
    /// interfaces must therefore produce two different strings, and one
    /// interface must produce one — whatever order it arrives in.
    mod the_interface_fingerprint {
        use super::super::{fingerprint, interface_build, Bundle};
        use std::borrow::Cow;

        fn of(names: &[&'static str]) -> Option<String> {
            fingerprint(names.iter().map(|name| Cow::Borrowed(*name)))
        }

        /// The assertion a constant would fail. A changed asset name is a
        /// changed interface, which is every rebuild of either bundler.
        #[test]
        fn two_interfaces_do_not_share_a_fingerprint() {
            assert_ne!(
                of(&["assets/index-a1b2c3.js", "index.html"]),
                of(&["assets/index-d4e5f6.js", "index.html"]),
            );
        }

        /// And one interface is one answer, however it was iterated.
        /// `RustEmbed` promises no order, so an unsorted digest would have
        /// reported a fresh build on a rebuild of identical files.
        #[test]
        fn one_interface_reads_the_same_in_any_order() {
            assert_eq!(of(&["a.js", "b.js", "c.js"]), of(&["c.js", "a.js", "b.js"]),);
        }

        /// The separator earns itself here. Concatenated with nothing between
        /// them, these two different sets of files are the same bytes.
        #[test]
        fn a_differently_split_set_of_names_is_a_different_interface() {
            assert_ne!(of(&["ab", "c"]), of(&["a", "bc"]));
        }

        /// Six bytes, as hex, so it can be read off a screen and compared.
        #[test]
        fn it_is_twelve_hexadecimal_characters() {
            let id = of(&["index.html"]).expect("names were given");
            assert_eq!(id.len(), 12);
            assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        }

        /// **No bundle is no answer**, rather than a constant standing in for
        /// one. A binary built without the interface has nothing to identify,
        /// and the screen this feeds is the one somebody reads to settle what
        /// is deployed — a stable string there would be the lie it exists to
        /// catch. This is the state `unbuilt` already explains in prose.
        #[test]
        fn nothing_built_is_no_fingerprint() {
            assert_eq!(of(&[]), None);
        }

        /// The public function agrees with the bundles it actually has, on
        /// whichever machine this runs: none under `backend-ci`, possibly both
        /// on a laptop that has run `just build`.
        #[test]
        fn the_binary_claims_a_build_exactly_when_it_carries_one() {
            let carries = Bundle::Renderer.built() || Bundle::Site.built();
            assert_eq!(interface_build().is_some(), carries);
        }
    }

    #[test]
    fn the_cache_rule_holds_with_no_bundle_on_disk() {
        use Bundle::{Renderer, Site};

        #[rustfmt::skip]
        let cases = [
            // Vite's content-hashed output, which is the whole of what the
            // renderer may pin.
            (Renderer, "assets/index-ZZ5k_kTa.js",            true),
            (Renderer, "assets/index-CUoiwNfh.css",           true),
            (Renderer, "assets/xterm-DudyGoOt.js",            true),
            (Renderer, "assets/archivo-BEIDiHaE.woff2",       true),
            // Its shell, and `public/` copied through under its own names.
            // Neither carries a hash, so pinning either strands a browser on a
            // version it can never be told about.
            (Renderer, "index.html",                          false),
            (Renderer, "voice-worklet.js",                    false),
            // The other tree's prefix means nothing in this one. This is the
            // entry that fails first if the two rules are ever collapsed back
            // into one.
            (Renderer, "_next/static/chunks/main-abc123.js",  false),

            // Next writes hashed filenames under exactly one directory.
            (Site, "_next/static/chunks/29iev1wdi1r0p.js",    true),
            (Site, "_next/static/css/4f2a9c1b.css",           true),
            (Site, "_next/static/media/archivo.d41d8cd9.woff2", true),
            // Its sibling under the build id is named by route, not by hash:
            // the directory moves every build and the file inside keeps its
            // name, so a pin there outlives the bytes it was taken from.
            (Site, "_next/WRo8u728hRf0gc5ixbXTK/index.txt",   false),
            // Shells. A pinned one hides an upgrade. The nested name is not a
            // route the site exports today — it exports three and all of them
            // are flat — but the rule is a prefix test over a filename and has
            // to keep answering for the shape, or the first nested page added
            // back is pinned forever.
            (Site, "404.html",                                false),
            (Site, "account.html",                            false),
            (Site, "login.html",                              false),
            (Site, "account/tokens.html",                     false),
            (Site, "fonts/archivo.woff2",                     false),
            (Site, "favicon.ico",                             false),
            // And Vite's prefix means nothing here either.
            (Site, "assets/index-ZZ5k_kTa.js",                false),

            // The prefix is a prefix, not a substring. `starts_with` quietly
            // widened to `contains` would pin a file somebody put inside a
            // directory that merely shares the name.
            (Renderer, "public/assets/index-ZZ5k_kTa.js",     false),
            (Site, "docs/_next/static/chunks/main.js",        false),

            // "Anything with a dot in it" is the rule the specification tells
            // us not to write, and these are what it would have got wrong.
            (Renderer, "index.html",                          false),
            (Site, "account.txt",                             false),

            // Nothing is not something.
            (Renderer, "",                                    false),
            (Site, "",                                        false),
        ];

        for (bundle, name, immutable) in cases {
            assert_eq!(
                bundle.hashed(name),
                immutable,
                "{bundle:?} got {name:?} wrong: it should{} be pinned",
                if immutable { "" } else { " not" }
            );
        }
    }

    /// And that the decision reaches a header, which is the half of the chain
    /// the predicate above cannot see.
    ///
    /// Through `describe`, so this needs no bundle either — `immutable: false`
    /// written straight into `load` would be the same defect arriving one line
    /// further down, and on `backend-ci` nothing else would notice.
    #[test]
    fn a_name_reaches_its_cache_header_with_no_bundle_on_disk() {
        let cache = |bundle: Bundle, name: &str| {
            let asset = bundle.describe(name, Vec::new());
            let response = asset.into_response();
            response
                .headers()
                .get(header::CACHE_CONTROL)
                .expect("every asset says how long it keeps")
                .to_str()
                .unwrap()
                .to_string()
        };

        assert_eq!(
            cache(Bundle::Renderer, "assets/index-ZZ5k_kTa.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            cache(Bundle::Site, "_next/static/chunks/29iev1wdi1r0p.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(cache(Bundle::Renderer, "index.html"), "no-cache");
        assert_eq!(cache(Bundle::Site, "account.html"), "no-cache");

        // The type comes off the name as well, which is what makes the shell a
        // page rather than a download.
        assert!(Bundle::Renderer
            .describe("index.html", Vec::new())
            .content_type
            .starts_with("text/html"));
    }

    /// The site's candidates, without a bundle — the shapes `resolve` asks for
    /// and `site_answers` has to agree with.
    #[test]
    fn the_site_is_asked_for_three_names() {
        assert_eq!(
            site_candidates("account"),
            ["account", "account.html", "account/index.html"]
        );
        // Nested, which the site does not export today — `/login`, `/setup`
        // and `/account` are all flat. Kept because `resolve` asks the same
        // three questions of whatever it is given and `site_answers` has to
        // agree with it for a name of any shape, not only for the three that
        // exist this week.
        assert_eq!(
            site_candidates("account/tokens"),
            [
                "account/tokens",
                "account/tokens.html",
                "account/tokens/index.html"
            ]
        );
        // A trailing slash must not produce `account//index.html`.
        assert_eq!(site_candidates("account/")[2], "account/index.html");
    }

    /// The sources a directive names, or nothing if it has no directive.
    ///
    /// Written the way `desktop/src/shell-csp.test.ts` writes it, because this
    /// is the same job on the other side of the same policy: the shipped shell
    /// asserts the string it injects, and this asserts the string the control
    /// plane sends.
    fn sources(policy: &str, directive: &str) -> Vec<String> {
        policy
            .split(';')
            .map(str::trim)
            .find(|d| *d == directive || d.starts_with(&format!("{directive} ")))
            .map(|d| d.split_whitespace().skip(1).map(String::from).collect())
            .unwrap_or_default()
    }

    /// Whether a directive would let a page load an address.
    ///
    /// Only the shapes these policies are written in — a bare scheme, a
    /// keyword, an exact origin — for the reason the shell's copy of this
    /// gives: a general CSP evaluator is a second implementation to be wrong in
    /// its own way. Anything else answers false and the test that cares fails
    /// loudly, which is the right way round.
    fn allows(policy: &str, directive: &str, address: &str) -> bool {
        let scheme = address.split(':').next().unwrap_or_default();
        let origin = address
            .split_once("://")
            .map(|(s, rest)| format!("{s}://{}", rest.split('/').next().unwrap_or_default()));
        sources(policy, directive).iter().any(|src| {
            src == "*" || src == &format!("{scheme}:") || Some(src.as_str()) == origin.as_deref()
        })
    }

    /// **What both bundles are known to ask for, against the policy they are
    /// actually served under.**
    ///
    /// The point of this test is the sentence at the top of
    /// `desktop/src/shell-csp.test.ts`: a policy reaches only what a shipped
    /// build serves, so every mistake in one is invisible to the person making
    /// it and arrives as a feature that quietly does not work. That already
    /// happened here once — `img-src` was `'self' data: blob:` and a release
    /// drew a placeholder for every artifact tile while development drew the
    /// picture.
    ///
    /// So these are addresses the applications really fetch, not a reading of
    /// the directives. Somebody tightening this finds out here rather than from
    /// somebody whose tiles are blank.
    #[test]
    fn the_policy_permits_what_both_bundles_ask_for() {
        for policy in [POLICY, SITE_POLICY] {
            // The incident, both ways: a thumbnail is an `<img>` against
            // whichever control plane the artifact lives on, and most
            // Firetowers are http on a port nobody can predict.
            let poster = "/__firetower/poster/a_01jc-3f2a9c81d0e4b7a6.png?v=v_01jc";
            assert!(allows(
                policy,
                "img-src",
                &format!("https://firetower.example.com{poster}")
            ));
            assert!(allows(
                policy,
                "img-src",
                &format!("http://10.0.0.4:3000{poster}")
            ));
            // A screenshot pasted into the composer, and a picture read
            // through the API with a bearer token.
            assert!(allows(
                policy,
                "img-src",
                "data:image/png;base64,iVBORw0KGgo="
            ));
            assert!(allows(
                policy,
                "img-src",
                "blob:http://localhost:4400/8f2c-1d"
            ));

            // The API and the event stream.
            assert!(allows(
                policy,
                "connect-src",
                "https://firetower.example.com/api/v1/bootstrap"
            ));
            assert!(allows(
                policy,
                "connect-src",
                "wss://firetower.example.com/api/v1/events"
            ));
            assert!(allows(
                policy,
                "connect-src",
                "ws://localhost:4400/api/v1/events"
            ));

            // `PreviewTab` and `ArtifactTab` each embed an iframe, and a
            // preview and an artifact are each a hostname of their own.
            assert!(allows(
                policy,
                "frame-src",
                "https://s-1-8080-ab12.firetower.example.com/"
            ));
            assert!(allows(policy, "frame-src", "http://127.0.0.1:4400/a_01jc"));

            // React writes `style` attributes and xterm injects a stylesheet.
            assert!(
                sources(policy, "style-src")
                    .iter()
                    .any(|s| s == "'unsafe-inline'"),
                "both bundles write inline styles"
            );

            // The frame rule, which is the new thing here. Said in the policy
            // and again in a header beside it, for browsers that read only one.
            assert_eq!(sources(policy, "frame-ancestors"), ["'none'"]);
            assert_eq!(sources(policy, "object-src"), ["'none'"]);
            assert_eq!(sources(policy, "base-uri"), ["'self'"]);

            // Tauri's own transport, which addresses nothing over HTTP.
            assert!(!policy.contains("ipc:"), "{policy}");
            assert!(!policy.contains("ipc.localhost"), "{policy}");
            // Never, in either: the shell ships without it and so does this.
            assert!(!policy.contains("'unsafe-eval'"), "{policy}");
        }
    }

    /// The one difference between the two, and why it is one.
    ///
    /// The administration site's export carries two inline `<script>` blocks on
    /// every page — the payload it hydrates from — with no usable nonce, so
    /// `'unsafe-inline'` is what stands between a release and a blank page. The
    /// renderer has no inline script at all and therefore keeps the strict
    /// rule, which matters because it is the surface the administration
    /// controls are moving on to.
    #[test]
    fn only_the_administration_site_may_run_inline_script() {
        assert_eq!(sources(POLICY, "script-src"), Vec::<String>::new());
        assert_eq!(sources(POLICY, "default-src"), ["'self'"]);
        assert_eq!(
            sources(SITE_POLICY, "script-src"),
            ["'self'", "'unsafe-inline'"]
        );

        // Stated as "the strict one plus one directive" rather than written out
        // twice and hoped about: a directive added to one and forgotten in the
        // other is a production-only difference between two halves of one
        // address.
        assert_eq!(
            SITE_POLICY,
            format!("script-src 'self' 'unsafe-inline'; {POLICY}"),
            "the site's policy is the strict one with exactly one addition"
        );
    }

    /// A GET, which is the only kind of request that reaches this module.
    fn get(path: &str) -> Request {
        Request::builder()
            .uri(path)
            .body(Body::empty())
            .expect("a request")
    }

    /// Whatever came back carries all four headers, and a policy that is one
    /// of the two this module has rather than something invented.
    fn assert_hardened(response: &Response, path: &str) {
        let headers = response.headers();
        let policy = headers
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap_or_else(|| panic!("{path} left here with no content policy"))
            .to_str()
            .expect("a readable policy");
        assert!(
            policy == POLICY || policy == SITE_POLICY,
            "{path} left here with a policy that is neither bundle's: {policy}"
        );
        assert_eq!(headers[header::X_FRAME_OPTIONS], "DENY", "{path}");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff", "{path}");
        assert_eq!(headers[header::REFERRER_POLICY], "same-origin", "{path}");
    }

    /// Every response this module can produce carries the headers, **asked of
    /// [`serve`]**, which is the only way into it.
    ///
    /// **It used to call `hardened` directly and never `serve` at all.** That
    /// is a test of a four-line function that inserts four headers, which has
    /// never been the part anybody gets wrong: what goes wrong is a branch
    /// that forgets to call it. QA stripped `hardened` from the 404 branch and
    /// this module stayed green at eighteen passing tests while the served
    /// page came back with no policy, no `X-Frame-Options` and no `nosniff` —
    /// on the commit whose whole purpose is these headers.
    ///
    /// So the paths below are one per branch `serve` can take, and the request
    /// goes in at the front door.
    ///
    /// **Which of them are reachable depends on what is embedded**, and that
    /// is the point of asserting on all of them rather than on the one this
    /// checkout happens to have: with both bundles built, `/` and `/login` are
    /// files and an unknown path is the site's own 404 page; with neither —
    /// which is every `backend-ci` run — all five non-API paths are the
    /// unbuilt sentence. Both arrangements are a branch of `serve`, both are
    /// asserted, and neither can be the one nobody checks.
    ///
    /// Proved by the method that found the hole, rather than by adding an
    /// assertion and trusting it: `hardened` was stripped from each branch in
    /// turn and this was watched to fail. Four of the five fail — the API
    /// 404, a served file, and the site's 404 page with the bundles built;
    /// the unbuilt sentence with them moved aside, which is the only branch a
    /// `backend-ci` run reaches at all. The fifth is the bare `StatusCode`
    /// fallback under `Site::get("404.html")`, and it did not fail because it
    /// cannot be reached: it needs the site bundle present *and* missing its
    /// own 404 page, which a `next build` export always has. It is a belt on
    /// braces rather than a branch, and worth saying so here so the next
    /// reader does not spend an afternoon trying to drive it.
    #[tokio::test]
    async fn nothing_leaves_here_unhardened() {
        for path in [
            // An API path nothing claimed: JSON, and never a page.
            "/api/nope",
            // The application's shell, or the sentence where it was not built.
            "/",
            "/index.html",
            // The administration site keeps its own paths.
            "/login",
            // Nothing by either name: the site's 404 page, or a bare one.
            "/assets/nothing-is-here.js",
            "/deep/unknown/path",
        ] {
            assert_hardened(&serve(get(path)).await, path);
        }
    }

    /// And a file carries **its own bundle's** policy rather than a default.
    ///
    /// Apart from the sweep above, which can only say the policy is one of the
    /// two: this is the half that says which, and it is the difference between
    /// the administration site being allowed its inline scripts and the
    /// application being allowed them too.
    #[test]
    fn each_bundle_keeps_its_own_policy() {
        let site = Bundle::Site
            .describe("account.html", b"<!doctype html>".to_vec())
            .into_response();
        assert_eq!(site.headers()[header::CONTENT_SECURITY_POLICY], SITE_POLICY);
        let app = Bundle::Renderer
            .describe("index.html", b"<!doctype html>".to_vec())
            .into_response();
        assert_eq!(app.headers()[header::CONTENT_SECURITY_POLICY], POLICY);
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
