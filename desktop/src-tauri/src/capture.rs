//! Photographing an artifact, so the library does not have to run one.
//!
//! The thumbnail in the library and in the transcript used to be the published
//! page itself in an iframe, scaled down — a page load, a set of scripts and
//! the injected picker's layout timer, per tile, for as long as the window was
//! open. This takes one picture per *version* instead, and because a version's
//! bytes are immutable the picture is taken once and then cached forever.
//!
//! **Why here and not on the control plane.** `docs/artifacts.md` rejects
//! putting a headless browser on the server, and it is right to: that is a
//! browser to ship, patch and sandbox on every installation. The objection is
//! about the *server*, though, and every client already is a browser. This
//! borrows the one that is running.
//!
//! **The window is offscreen rather than hidden, and that is not a style
//! choice.** Both platform APIs capture what has been composited, and a window
//! built with `visible: false` is never asked to draw. So it is a real window
//! that is really on screen — just at a coordinate no display covers.

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// What the page is laid out at before being scaled down.
///
/// The same 1180 the iframe used, and for the same reason: an artifact is
/// written for a desktop reading frame, and laying it out at thumbnail width
/// would photograph its narrow layout — a picture of a page nobody will see
/// when they open it.
const PAGE: f64 = 1180.0;
const TALL: f64 = 737.0;

/// What comes back, in **points**, which on a Retina display is half as many
/// points as the pixels that arrive.
///
/// Sized against the largest place a poster is ever drawn — the card in the
/// transcript, at `max-w-[26rem]`, so 416 CSS px — which at 2x wants about 830
/// pixels. 420 points lands there. 640 was the first guess and produced a
/// 1280px, 170 KB image to be drawn into a 224px tile.
const POSTER: f64 = 420.0;

/// Far enough left that no arrangement of displays reaches it.
const AWAY: f64 = -8000.0;

/// How long to wait for the page before giving up on it.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(20);

/// How long after "loaded" to let the page finish being a page.
///
/// `PageLoadEvent::Finished` is the document, not the paint: webfonts, images
/// decoding and anything a chart draws on `DOMContentLoaded` are all still to
/// come. Photographing on the event itself reliably caught a half-drawn page.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(600);

/// Take a picture of a page, as PNG bytes.
///
/// One at a time by construction — the caller holds a queue — because this
/// puts a real webview on a real screen and two of them racing is two pages
/// competing for the same main thread.
///
/// Answers with [`tauri::ipc::Response`] rather than a `Vec<u8>`, which is the
/// difference between handing the renderer an `ArrayBuffer` and handing it a
/// JSON array of a hundred thousand numbers to parse. `save_download` avoids
/// the bridge entirely for the same reason.
#[tauri::command]
pub async fn capture_poster(
    app: tauri::AppHandle,
    url: String,
) -> Result<tauri::ipc::Response, String> {
    shoot(app, url).await.map(tauri::ipc::Response::new)
}

async fn shoot(app: tauri::AppHandle, url: String) -> Result<Vec<u8>, String> {
    // Before a window is opened, not after it has rendered.
    //
    // The refusal used to come from `platform::snapshot`, which is the last
    // step — so a platform with no capture built still opened an offscreen
    // window, loaded the whole artifact into it, waited for it to settle, and
    // only then said it could not photograph anything. Every ten minutes, per
    // artifact, for nothing. That is worse than having no capture at all.
    if !platform::SUPPORTED {
        return Err(platform::WHY.to_string());
    }

    // Unique, because a label is an identity: a second capture while one is
    // closing would otherwise be refused the name.
    let label = format!("ft-shot-{}", ulid_ish());

    let (loaded, is_loaded) = tokio::sync::oneshot::channel::<()>();
    let loaded = std::sync::Mutex::new(Some(loaded));

    let parsed = url
        .parse()
        .map_err(|_| format!("that is not an address: {url}"))?;

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title("")
        .inner_size(PAGE, TALL)
        .position(AWAY, AWAY)
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .focused(false)
        // Never steals the window somebody is working in. Without this the
        // capture flashes to the front on macOS even at a coordinate nobody
        // can see, because ordering is independent of position.
        .always_on_top(false)
        .visible(true)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Ok(mut held) = loaded.lock() {
                    // Only the first: a page that navigates would otherwise
                    // send twice into a channel that takes one.
                    if let Some(tell) = held.take() {
                        let _ = tell.send(());
                    }
                }
            }
        })
        .build()
        .map_err(|e| format!("could not open a window to render in: {e}"))?;

    // Whatever happens below, the window goes. An early return that left one
    // behind would leave a webview running the artifact forever, which is the
    // bug this whole change is about.
    let shot = capture_once(&window, is_loaded).await;
    let _ = window.close();
    shot
}

async fn capture_once(
    window: &tauri::WebviewWindow,
    loaded: tokio::sync::oneshot::Receiver<()>,
) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(PATIENCE, loaded).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) => return Err("the window went before the page arrived".into()),
        Err(_) => return Err("that page did not finish loading".into()),
    }
    tokio::time::sleep(SETTLE).await;

    let (done, answer) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let done = std::sync::Mutex::new(Some(done));

    window
        .with_webview(move |webview| {
            let hand = move |result: Result<Vec<u8>, String>| {
                if let Ok(mut held) = done.lock() {
                    if let Some(tell) = held.take() {
                        let _ = tell.send(result);
                    }
                }
            };
            platform::snapshot(&webview, hand);
        })
        .map_err(|e| format!("could not reach the webview: {e}"))?;

    match tokio::time::timeout(PATIENCE, answer).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the capture was dropped before it answered".into()),
        Err(_) => Err("the capture did not answer".into()),
    }
}

/// A label that will not collide, without pulling in a generator for it.
fn ulid_ish() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{now:x}")
}

/// Photograph one page and quit, for checking the native path by hand.
///
/// `capture_poster` is the only unsafe, platform-specific thing in this
/// application and the only part of it an automated test cannot reach: it
/// needs a compositor, a real window and a real display. This is how somebody
/// changing it finds out whether it still works, without a control plane, a
/// database or a published artifact:
///
/// ```text
/// FIRETOWER_SHOOT=http://localhost:8000/ \
/// FIRETOWER_SHOOT_TO=/tmp/shot.png       \
///     cargo run
/// ```
///
/// Off unless both are set, so it costs an ordinary launch two `env::var`
/// calls and nothing else.
pub fn self_test(app: &tauri::AppHandle) {
    let (Ok(url), Ok(into)) = (
        std::env::var("FIRETOWER_SHOOT"),
        std::env::var("FIRETOWER_SHOOT_TO"),
    ) else {
        return;
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let code = match shoot(app.clone(), url).await {
            Ok(png) => match std::fs::write(&into, &png) {
                Ok(()) => {
                    println!("shot {} bytes -> {into}", png.len());
                    0
                }
                Err(e) => {
                    eprintln!("could not write {into}: {e}");
                    1
                }
            },
            Err(e) => {
                eprintln!("capture failed: {e}");
                1
            }
        };
        app.exit(code);
    });
}

#[cfg(target_os = "macos")]
mod platform {
    use super::POSTER;

    /// Whether this platform can photograph a page at all.
    pub const SUPPORTED: bool = true;
    pub const WHY: &str = "";

    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::{NSData, NSDictionary, NSNumber};

    /// `NSBitmapImageFileType::PNG`.
    const PNG: usize = 4;

    /// `-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`.
    ///
    /// The supported route, rather than `cacheDisplayInRect:`: a WKWebView
    /// draws out of process and the AppKit caching calls come back blank for
    /// it, which is the failure that looks like an empty thumbnail rather than
    /// an error.
    ///
    /// `snapshotWidth` is what does the downscaling, so the page is laid out at
    /// 1180 and handed back at 640 without a resampling step of our own.
    pub fn snapshot(
        webview: &tauri::webview::PlatformWebview,
        hand: impl FnOnce(Result<Vec<u8>, String>) + 'static,
    ) {
        let view = webview.inner() as *mut AnyObject;
        if view.is_null() {
            hand(Err("there is no webview to photograph".into()));
            return;
        }

        unsafe {
            let config: *mut AnyObject = msg_send![class!(WKSnapshotConfiguration), new];
            if config.is_null() {
                hand(Err("WebKit would not make a snapshot configuration".into()));
                return;
            }
            let width = NSNumber::new_f64(POSTER);
            let _: () = msg_send![config, setSnapshotWidth: &*width];

            // `FnOnce` cannot be called from a block that is typed as callable
            // more than once, and Objective-C makes no promise about how many
            // times it will call this. The cell is what makes it safe to say
            // "the first time only" — a plain `Option` would make the closure
            // `FnMut`, and a block has to be `Fn`. WebKit runs this on the main
            // queue, which is the thread that installed it, so a `RefCell` is
            // the right weight of borrow check for it.
            let hand = std::cell::RefCell::new(Some(hand));
            let block = RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
                let Some(hand) = hand.borrow_mut().take() else {
                    return;
                };
                if !error.is_null() || image.is_null() {
                    hand(Err("WebKit could not photograph that page".into()));
                    return;
                }
                hand(png_of(image));
            });

            let _: () = msg_send![
                view,
                takeSnapshotWithConfiguration: config,
                completionHandler: &*block,
            ];
            let _: () = msg_send![config, release];
        }
    }

    /// An `NSImage` as PNG bytes.
    ///
    /// Through a bitmap rep because `NSImage` is a drawing instruction rather
    /// than pixels — it has no encoder of its own, and the TIFF it will give
    /// up is the only handle on what it would draw.
    unsafe fn png_of(image: *mut AnyObject) -> Result<Vec<u8>, String> {
        let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
        if tiff.is_null() {
            return Err("that snapshot had nothing in it".into());
        }
        let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        if rep.is_null() {
            return Err("that snapshot could not be read as pixels".into());
        }
        let empty = NSDictionary::<objc2_foundation::NSString, AnyObject>::new();
        let png: *mut NSData = msg_send![rep, representationUsingType: PNG, properties: &*empty];
        if png.is_null() {
            return Err("that snapshot would not encode".into());
        }
        Ok((*png).to_vec())
    }
}

#[cfg(windows)]
mod platform {
    /// Nothing here can photograph a page yet, and `shoot` checks this before
    /// it opens a window rather than after it has rendered one.
    pub const SUPPORTED: bool = false;
    pub const WHY: &str = "photographing an artifact is not built on Windows yet";

    /// Not built yet.
    ///
    /// WebView2's `ICoreWebView2::CapturePreview` is the equivalent and takes
    /// the same shape — an async call handing back PNG into a stream — but it
    /// is COM rather than Objective-C and none of it has been run. A clear
    /// refusal is better than untested `unsafe`: the library falls back to the
    /// placeholder tile, which is a worse thumbnail and a working application.
    pub fn snapshot(
        _webview: &tauri::webview::PlatformWebview,
        hand: impl FnOnce(Result<Vec<u8>, String>) + 'static,
    ) {
        hand(Err(
            "photographing an artifact is not built on Windows yet".into()
        ));
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub const SUPPORTED: bool = false;
    pub const WHY: &str = "photographing an artifact is not built on this platform";

    pub fn snapshot(
        _webview: &tauri::webview::PlatformWebview,
        hand: impl FnOnce(Result<Vec<u8>, String>) + 'static,
    ) {
        hand(Err(
            "photographing an artifact is not built on this platform".into(),
        ));
    }
}
