//! The island: a pill that floats above every other app.
//!
//! Firetower's premise is that agents run on machines that are not this one, so
//! the app being closed is the normal case — and a dock badge only works when
//! you are looking at the dock. The island is the third member of the family
//! `set_badge` and `notify` already belong to, and the only one that is there
//! without being asked for.
//!
//! **This file is geometry and window flags. It holds no idea of what a session
//! is.** What to draw, where it should live, when to grow — all of that is in
//! `src/island/`, in TypeScript, where it can be tested without a window
//! server. The division is the same one `main.rs` already keeps: the shell does
//! what a web page cannot, and nothing else.
//!
//! What a web page cannot do here is four things: sit above the menu bar, know
//! where the notch is, survive a Space switch, and stay out of the way of the
//! keyboard. The rest is a webview.

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

/// The window's label, and the event target for everything sent to it.
pub const LABEL: &str = "island";

/// Pushed from the main window; the island is the only listener.
pub const STATE_EVENT: &str = "island://state";
/// Sent back when a row is clicked. The main window navigates.
pub const OPEN_EVENT: &str = "island://open";

/// One display, in the coordinates `set_position` speaks.
///
/// Tauri places windows in logical points from the top-left of the primary
/// display, y growing downward. AppKit measures from the bottom-left of the
/// primary display, y growing up. Everything here is converted once, on the way
/// out, so that no TypeScript ever has to know AppKit exists.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    /// `localizedName` — "Built-in Retina Display", "LG UltraFine". Used to
    /// recognise the display a remembered position belonged to.
    pub name: String,
    /// The one with the menu bar.
    pub primary: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// The frame minus the menu bar and the Dock. Where a floating pill may go.
    pub work_x: f64,
    pub work_y: f64,
    pub work_width: f64,
    pub work_height: f64,
    /// The notch's cutout, or zero on a display that has none. `notch_height`
    /// doubles as "does this display have a notch", which is why it is reported
    /// rather than derived from the model name.
    pub notch_width: f64,
    pub notch_height: f64,
}

/// Where the island is now, in the same coordinates.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Build the window, hidden.
///
/// Hidden because the renderer decides where it goes: it reads the remembered
/// position, checks that display still exists, and only then asks to be shown.
/// A window that appears first and moves second is a window that visibly jumps
/// on every launch.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("island.html".into()))
        .title("Firetower")
        .inner_size(220.0, 28.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        // macOS derives the shadow from the window's alpha channel, so a
        // transparent window with a rounded pill in it casts a correctly
        // shaped shadow and needs no bleed drawn around the content.
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        // Ordered in rather than made key: the island must never take the
        // keyboard from the terminal you are watching.
        .focused(false)
        .build()?;

    #[cfg(target_os = "macos")]
    perch(&window);

    Ok(())
}

/// Take the island down with the window it feeds.
///
/// Closing the main window has always quit Firetower, because it was the only
/// window and Tauri exits when the last one goes. The island is a second
/// window and would keep the process alive on its own — showing a fleet that
/// nothing is updating any more, with no way to get the app back. Keeping it
/// alive past the window is a tray icon and an accessory activation policy,
/// which is a product decision and not this one.
pub fn close_with<R: Runtime>(main: &tauri::WebviewWindow<R>) {
    let app = main.app_handle().clone();
    main.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(pill) = app.get_webview_window(LABEL) {
                let _ = pill.close();
            }
        }
    });
}

/// The four AppKit flags that separate a small window from an island.
///
/// Without these it is an ordinary window: it hides behind the menu bar, it
/// disappears when you switch Space, and it vanishes the moment another app
/// goes full screen. None of them have a Tauri equivalent.
#[cfg(target_os = "macos")]
fn perch<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let Ok(ptr) = window.ns_window() else { return };
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    // 25 = NSStatusWindowLevel. The menu bar is 24, so this clears it; menu bar
    // extras are also 25, which is the right company to keep — the island is
    // one of them in everything but implementation.
    ns.setLevel(25);

    ns.setCollectionBehavior(
        // On every Space, including other apps' full-screen ones. Without this
        // the island belongs to the desktop it was created on and silently
        // stops existing on the others, which reads as a crash.
        NSWindowCollectionBehavior::CanJoinAllSpaces
            // Does not slide with Spaces. It is furniture, not content.
            | NSWindowCollectionBehavior::Stationary
            // Stays put when an app takes the display full screen.
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            // Not a stop in Cmd-Tab or in Exposé.
            | NSWindowCollectionBehavior::IgnoresCycle,
    );

    // Firetower going to the background is not a reason to stop showing what
    // the fleet is doing — that is the entire point of the thing.
    ns.setHidesOnDeactivate(false);

    ns.setHasShadow(true);

    // Not `setMovable(false)`, tempting as it looks: an immovable window cannot
    // be dragged by `performWindowDragWithEvent:` either, which is exactly what
    // `startDragging` uses — the grab handle would go dead. Only the *implicit*
    // drag is turned off, so the pill moves by its handle and by nothing else.
    ns.setMovableByWindowBackground(false);
}

/// Every display, ready to be reasoned about.
#[tauri::command]
pub fn island_screens<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Screen>, String> {
    #[cfg(target_os = "macos")]
    {
        main_thread(&app, macos_screens)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The pill is platform-neutral and Windows is meant to run the same
        // component; only the notch and the flags above are macOS. Reading the
        // work area off Tauri's monitors is what that port starts from.
        let _ = &app;
        Ok(Vec::new())
    }
}

/// Size and position in one call.
///
/// Two calls means two frame changes, and on a transparent window the gap
/// between them is visible as a flicker of the old size at the new place.
#[tauri::command]
pub fn island_place<R: Runtime>(
    app: AppHandle<R>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("no island")?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;

    // The shadow is cached from the old shape. Without this the pill keeps the
    // silhouette it had before it grew, which is visible as a bar of shadow
    // across the middle of an expanded panel.
    #[cfg(target_os = "macos")]
    if let Ok(ptr) = window.ns_window() {
        use objc2_app_kit::NSWindow;
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.invalidateShadow();
    }
    Ok(())
}

/// Where it ended up, after AppKit has finished dragging it.
#[tauri::command]
pub fn island_bounds<R: Runtime>(app: AppHandle<R>) -> Result<Bounds, String> {
    let window = app.get_webview_window(LABEL).ok_or("no island")?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let position = window
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    Ok(Bounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// Show or hide it, without ever taking focus.
#[tauri::command]
pub fn island_visible<R: Runtime>(app: AppHandle<R>, show: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("no island")?;

    // Deliberately not `show()`/`hide()` on macOS. Tauri's `show()` ends in
    // `makeKeyAndOrderFront:`, which takes the keyboard from whatever you were
    // typing in — tolerable once at launch, not tolerable when the island
    // comes back out of "hide until something needs you" in the middle of a
    // sentence. `orderFrontRegardless` puts a window on screen without
    // activating the app it belongs to, which is the whole contract here.
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWindow;
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        if show {
            ns.orderFrontRegardless();
        } else {
            ns.orderOut(None);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        if show {
            window.show().map_err(|e| e.to_string())?;
        } else {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Keep the island out of screen recordings and shared screens.
///
/// A pill listing the repositories you are working on is a bad surprise in a
/// customer call, and the person who wants it hidden wants it hidden before
/// they remember to ask.
#[tauri::command]
pub fn island_sharing<R: Runtime>(app: AppHandle<R>, hidden: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSWindow, NSWindowSharingType};
        let window = app.get_webview_window(LABEL).ok_or("no island")?;
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.setSharingType(if hidden {
            NSWindowSharingType::None
        } else {
            NSWindowSharingType::ReadOnly
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (&app, hidden);
    Ok(())
}

/// The main window's view of the fleet, handed to the island.
///
/// Deliberately opaque: the shell relays JSON it does not read. The island
/// holds no token, opens no socket and polls nothing — `src/api/events.ts`
/// records what a second set of pollers did to the connection budget once
/// already, and a second webview with its own streams would do it again.
#[tauri::command]
pub fn island_push<R: Runtime>(app: AppHandle<R>, state: serde_json::Value) -> Result<(), String> {
    app.emit_to(
        tauri::EventTarget::webview_window(LABEL),
        STATE_EVENT,
        state,
    )
    .map_err(|e| e.to_string())
}

/// A row was clicked. Bring the app forward and tell it where to go.
#[tauri::command]
pub fn island_open<R: Runtime>(app: AppHandle<R>, target: serde_json::Value) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    app.emit_to(
        tauri::EventTarget::webview_window("main"),
        OPEN_EVENT,
        target,
    )
    .map_err(|e| e.to_string())
}

// ── macOS geometry ───────────────────────────────────────────────────────────

/// Run on the main thread, because AppKit answers nothing anywhere else.
///
/// Tauri's command handlers are not guaranteed a thread, and `NSScreen` read
/// off one that is not the main thread returns stale values on a good day.
#[cfg(target_os = "macos")]
fn main_thread<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    work: impl FnOnce(objc2::MainThreadMarker) -> T + Send + 'static,
) -> Result<T, String> {
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        return Ok(work(mtm));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let mtm = objc2::MainThreadMarker::new().expect("on the main thread");
        let _ = tx.send(work(mtm));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn macos_screens(mtm: objc2::MainThreadMarker) -> Vec<Screen> {
    use objc2_app_kit::NSScreen;

    let screens = NSScreen::screens(mtm);
    // `screens[0]` is the one with the menu bar, and AppKit's global origin is
    // its bottom-left corner. Everything below is measured against that.
    let Some(primary) = screens.iter().next() else {
        return Vec::new();
    };
    let ceiling = primary.frame().size.height;

    screens
        .iter()
        .enumerate()
        .map(|(index, screen)| {
            let frame = screen.frame();
            let visible = screen.visibleFrame();

            // The notch is the gap between the two areas that flank it, which is
            // the only way to learn its width; its height is the top safe-area
            // inset, and is zero on every display that does not have one.
            let insets = screen.safeAreaInsets();
            let left = screen.auxiliaryTopLeftArea();
            let right = screen.auxiliaryTopRightArea();
            let notch_width = if insets.top > 0.0 {
                (frame.size.width - left.size.width - right.size.width).max(0.0)
            } else {
                0.0
            };

            Screen {
                name: screen.localizedName().to_string(),
                primary: index == 0,
                x: frame.origin.x,
                y: ceiling - (frame.origin.y + frame.size.height),
                width: frame.size.width,
                height: frame.size.height,
                work_x: visible.origin.x,
                work_y: ceiling - (visible.origin.y + visible.size.height),
                work_width: visible.size.width,
                work_height: visible.size.height,
                notch_width,
                notch_height: insets.top,
            }
        })
        .collect()
}
