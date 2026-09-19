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
//! What a web page cannot do here is four things: sit above everything else,
//! know where the notch is, survive a Space switch, and stay out of the way of
//! the keyboard. The rest is a webview — the same one on both platforms.
//!
//! macOS and Windows want the same four things and spell all of them
//! differently:
//!
//! | | macOS | Windows |
//! |---|---|---|
//! | above everything | window level 25 | `HWND_TOPMOST`, via Tauri |
//! | never takes focus | `orderFrontRegardless` | `WS_EX_NOACTIVATE` |
//! | not in the app switcher | `IgnoresCycle` | `WS_EX_TOOLWINDOW` |
//! | on every desktop | `CanJoinAllSpaces` | *nothing* — see `perch` |

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use tauri::{LogicalPosition, LogicalSize};

/// The window's label, and the event target for everything sent to it.
pub const LABEL: &str = "island";

/// Pushed from the main window; the island is the only listener.
pub const STATE_EVENT: &str = "island://state";
/// Sent back when a row is clicked. The main window navigates.
pub const OPEN_EVENT: &str = "island://open";

/// Where the island was last put, and how tall the primary display is.
///
/// Both are written on the way through the commands that already know them —
/// `island_place` places the window, `island_screens` measures the displays —
/// so that `island_pointer` can answer "is the pointer over the pill" without
/// touching AppKit or a window handle from its own thread.
#[cfg(any(target_os = "macos", target_os = "windows"))]
static FRAME: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);
/// AppKit's flipped origin, and nobody else's: Windows measures from the
/// top-left with y going down already, so there is nothing to subtract from.
#[cfg(target_os = "macos")]
static CEILING: std::sync::Mutex<f64> = std::sync::Mutex::new(0.0);

/// The part of that window the pointer can actually see, as an **inset**.
///
/// Not the same rectangle as the window, and the difference is the whole of
/// `island_pointer` being right. The window is wider than the pill by the
/// melting corners, and is the size of the largest panel it has ever shown —
/// a transparent margin lying over whatever is behind it. Tested against the
/// window, the pointer is "on the island" while it is plainly over the app
/// below, so leaving downward re-opens what you just left.
///
/// Held relative to the window's own origin rather than the screen's, because
/// the window moves without anyone asking the renderer: a drag is AppKit
/// carrying it by the scruff, and the placement code stands well back while
/// that happens. An absolute rectangle would be left behind at the spot the
/// drag started, the pointer would read as outside, the window would make
/// itself transparent to the mouse — and the pill would drop out of your hand
/// and refuse to be picked up again.
#[cfg(any(target_os = "macos", target_os = "windows"))]
static HIT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

/// One display, in the coordinates `island_place` speaks.
///
/// Origin at the top-left of the primary display, y growing downward, on both
/// platforms — but not in the same unit, and that is deliberate rather than
/// sloppy.
///
/// macOS reports **logical points**: one scale factor for the desktop as far
/// as window placement is concerned, and AppKit's bottom-left origin converted
/// away here so no TypeScript ever learns it exists.
///
/// Windows reports **device pixels**. Per-monitor DPI means a 4K display at
/// 150% and a 1080p display at 100% share no logical space at all, so "logical
/// coordinates" there is a question with no answer — `LogicalPosition` would
/// have to pick one monitor's scale and be wrong about the other. Physical
/// pixels are the one space both monitors agree on. The renderer multiplies
/// its own measurements by `devicePixelRatio` to match (`shell.ts`).
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

/// A line in the island's log, for the machine you are not sitting at.
///
/// A window app on Windows has no console: `eprintln!` goes to a handle
/// nobody owns, and an installed build has no devtools to open — so when the
/// pill does not appear there is nothing at all to read, which is how a
/// missing display list cost a day. This writes the few decisions that
/// decide whether there is an island: what the displays were, where it was
/// put, whether it was asked to show. Six lines a session, appended, and the
/// renderer can add its own through `island_note`.
pub fn note<R: Runtime>(app: &AppHandle<R>, line: &str) {
    use std::io::Write;

    let Ok(dir) = app.path().app_log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("island.log"))
    else {
        return;
    };
    // Seconds since the epoch: no clock crate, and the only thing anybody
    // reading this needs is the order and the gaps.
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "{at} {line}");
}

/// The renderer's own line in the same file.
///
/// Its failures are the ones hardest to see from outside: a page that throws
/// on the way up draws nothing, says nothing, and leaves a window that was
/// never told where to go.
#[tauri::command]
pub fn island_note<R: Runtime>(app: AppHandle<R>, line: String) {
    note(&app, &format!("page: {line}"));
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
        /* The click acts, rather than only arriving.
           A window belonging to an inactive application spends the first
           click activating it and hands the view nothing, which is the
           standard behaviour and the right one for a document window. It is
           the wrong one here: the island is hovered and clicked from inside
           whatever you are actually working in, so every click was two —
           one to wake the app, one to mean something. It is also what stops
           the pill being picked up and dragged in a single gesture, because
           the grip's press is swallowed the same way.
           On Windows the flag is ignored; a window there does not eat the
           click that raises it. */
        .accept_first_mouse(true)
        .build()?;

    perch(&window);
    follow_frame(&window);
    note(app, "created");

    Ok(())
}

/// Keep `FRAME` true while the window is moved by something that is not us.
///
/// A drag is AppKit carrying the window, frame by frame, with no placement
/// called and the renderer standing back until it is over. Everything that
/// asks "is the pointer on the pill" reads `FRAME`, so without this it spends
/// the whole drag answering about where the pill used to be.
#[cfg(target_os = "macos")]
fn follow_frame<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        // Read fresh. Asked for once at creation this is 1.0 — the window has
        // not been put on a display yet and has no scale to report — and every
        // position after that comes out at twice life size, which puts the
        // pill's rectangle thousands of points from the pill.
        let scale = handle.scale_factor().unwrap_or(2.0);
        let mut held = FRAME.lock().unwrap();
        let Some(frame) = held.as_mut() else { return };
        match event {
            tauri::WindowEvent::Moved(at) => {
                let at = at.to_logical::<f64>(scale);
                frame.0 = at.x;
                frame.1 = at.y;
            }
            tauri::WindowEvent::Resized(to) => {
                let to = to.to_logical::<f64>(scale);
                frame.2 = to.width;
                frame.3 = to.height;
            }
            _ => {}
        }
    });
}

/// The same, in the space Windows already speaks.
///
/// No conversion: `island_place` is given device pixels there and the events
/// report device pixels, so what arrives is what was recorded. The macOS arm
/// above divides by a scale factor precisely because it is the one that does
/// not work that way.
#[cfg(target_os = "windows")]
fn follow_frame<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    window.on_window_event(move |event| {
        let mut held = FRAME.lock().unwrap();
        let Some(frame) = held.as_mut() else { return };
        match event {
            tauri::WindowEvent::Moved(at) => {
                frame.0 = at.x as f64;
                frame.1 = at.y as f64;
            }
            tauri::WindowEvent::Resized(to) => {
                frame.2 = to.width as f64;
                frame.3 = to.height as f64;
            }
            _ => {}
        }
    });
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn follow_frame<R: Runtime>(_window: &tauri::WebviewWindow<R>) {}

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

/// The flags that separate a small window from an island.
///
/// Without them it is an ordinary window: it hides under the menu bar, it
/// disappears when you switch desktop, and it takes the keyboard the first
/// time you touch it. None of them have a Tauri equivalent.
#[cfg(target_os = "macos")]
fn perch<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    let Ok(ptr) = window.ns_window() else { return };
    let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    // 25 = NSStatusWindowLevel. The menu bar is 24, so this clears it; menu bar
    // extras are also 25, which is the right company to keep — the island is
    // one of them in everything but implementation.
    ns.setLevel(25);

    /* Mouse-moved events, which a window is not sent unless it asks. The pill
       opens on a poll of the cursor rather than on `:hover`, but an *open*
       panel is a list whose rows have to light up under the pointer, and that
       is the document's own hover — which needs these. */
    ns.setAcceptsMouseMovedEvents(true);

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

/// The same four things, in Win32.
///
/// Two of them are one call. `WS_EX_NOACTIVATE` is the closest Windows has to
/// a non-activating panel: the window can be clicked without the foreground
/// moving to it, so the caret stays in the terminal you were watching.
/// `WS_EX_TOOLWINDOW` keeps it out of Alt-Tab and off the taskbar, which is
/// what `IgnoresCycle` buys on the Mac.
///
/// The fourth has no answer. macOS has `CanJoinAllSpaces`; Windows has no
/// public API for pinning a window to every virtual desktop —
/// `IVirtualDesktopManager` can *ask* which desktop a window is on and can
/// move it, but the interface that pins one is undocumented and changes
/// between builds. So on Windows the island belongs to the desktop it was
/// created on. That is a real difference in behaviour and not one worth
/// chasing an unversioned COM interface for.
#[cfg(target_os = "windows")]
fn perch<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    unsafe {
        let held = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            held | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize),
        );
    }
}

/// Everywhere else the pill is an ordinary always-on-top window.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn perch<R: Runtime>(_window: &tauri::WebviewWindow<R>) {}

/// Every display, ready to be reasoned about.
#[tauri::command]
pub fn island_screens<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Screen>, String> {
    let told = island_screens_inner(app.clone());
    match &told {
        Ok(found) => {
            // Once is enough: this is polled every four seconds, and a log
            // that repeats itself is a log nobody reads to the end.
            static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
                note(&app, &format!("screens {} {found:?}", found.len()));
            }
        }
        Err(e) => note(&app, &format!("screens FAILED {e}")),
    }
    told
}

fn island_screens_inner<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Screen>, String> {
    #[cfg(target_os = "macos")]
    {
        main_thread(&app, macos_screens)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // No AppKit and no notch: Tauri already reports everything needed, and
        // reports it in the device pixels this side of the world works in.
        let window = app.get_webview_window(LABEL).ok_or("no island")?;
        let monitors = window.available_monitors().map_err(|e| e.to_string())?;
        let first = window
            .primary_monitor()
            .map_err(|e| e.to_string())?
            .and_then(|m| m.name().cloned());

        Ok(monitors
            .into_iter()
            .enumerate()
            .map(|(index, monitor)| {
                let frame = monitor.size();
                let at = monitor.position();
                let work = monitor.work_area();
                // Two displays can share a model name. The index keeps the
                // remembered perch pointing at one of them rather than at
                // whichever answered first.
                let name = monitor
                    .name()
                    .cloned()
                    .unwrap_or_else(|| format!("display {}", index + 1));
                Screen {
                    primary: first.as_ref() == Some(&name),
                    name,
                    x: at.x as f64,
                    y: at.y as f64,
                    width: frame.width as f64,
                    height: frame.height as f64,
                    work_x: work.position.x as f64,
                    work_y: work.position.y as f64,
                    work_width: work.size.width as f64,
                    work_height: work.size.height as f64,
                    // No hole in the panel to work around.
                    notch_width: 0.0,
                    notch_height: 0.0,
                }
            })
            .collect())
    }
}

/// Come forward, so the pointer works *inside* the panel.
///
/// The island is built not to take focus, and that is still right for the
/// pill: it sits there all day and must never pull the keyboard out of the
/// terminal you are watching. But an expanded panel is a list you are meant
/// to point at, and AppKit gives a non-key window's webview no mouse-moved
/// events — so the rows do not light up and the thing you are hovering does
/// not know it. Opening is the moment that changes: you have already put the
/// pointer on it.
///
/// The island window is made key rather than the app's main one, so what
/// arrives is a window with no text input in it — the keyboard has nowhere to
/// go and nothing to type into.
#[tauri::command]
pub fn island_activate<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let window = app.get_webview_window(LABEL).ok_or("no island")?;
        main_thread(&app, move |mtm| {
            use objc2_app_kit::{NSApplication, NSWindow};

            // `activate` and not `activateIgnoringOtherApps`, which is
            // deprecated from macOS 14 and does nothing in some of the cases
            // it used to cover.
            NSApplication::sharedApplication(mtm).activate();
            if let Ok(ptr) = window.ns_window() {
                let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                ns.makeKeyAndOrderFront(None);
            }
        })?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
    Ok(())
}

/// Let the mouse through, everywhere except the pill.
///
/// The window is a stage, not a pill: it is the size of the largest panel and
/// it never changes, because any change to its width moves the content
/// centred inside it. Almost all of that is transparent, and a transparent
/// always-on-top rectangle across the top of the screen that swallows clicks
/// is a menu bar you cannot use.
///
/// So it ignores the cursor by default and stops ignoring it while the
/// pointer is over the pill — which the renderer already asks about sixteen
/// times a second to decide whether to open.
#[tauri::command]
pub fn island_click_through<R: Runtime>(app: AppHandle<R>, ignore: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("no island")?;
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

/// What part of the window the pointer should count as being over.
///
/// Sent by the renderer, which is the only half that knows: the shell places a
/// window, the page decides how much of it is pill and how much is the
/// transparent room an animation needs. Given as an offset from the window's
/// own top-left, so that it survives the window being moved by anything other
/// than a placement — a drag, most of all.
#[tauri::command]
pub fn island_hit(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        *HIT.lock().unwrap() = Some((x, y, width, height));
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (x, y, width, height);
    }
    Ok(())
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
    /* Every rectangle, and not just the first one.
       This was logged once a launch, which is quiet but answers the wrong
       question: an island nobody can find has usually been placed more than
       once, and it is the last placement that says where it went. Logging
       only on a change keeps it short — the pill is placed on every frame of
       an animation and most of those ask for the rectangle it already has. */
    {
        static SAID: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);
        let mut said = SAID.lock().unwrap();
        if *said != Some((x, y, width, height)) {
            *said = Some((x, y, width, height));
            drop(said);
            note(&app, &format!("placed {x} {y} {width} {height}"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        // One frame change. `set_size` and `set_position` are two, and AppKit
        // draws between them: the window takes its new width while still at
        // its old origin, so a pill that is centred by shrinking around its
        // middle visibly jumps sideways and back on every collapse. This is
        // what the doc comment above has always asked for and never did.
        let ceiling = *CEILING.lock().unwrap();
        let placed = if ceiling > 0.0 {
            window.ns_window().ok().map(|ptr| {
                use objc2_app_kit::NSWindow;
                use objc2_foundation::{NSPoint, NSRect, NSSize};

                let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
                // Back to AppKit's bottom-left origin, once, on the way out.
                let frame = NSRect::new(
                    NSPoint::new(x, ceiling - (y + height)),
                    NSSize::new(width, height),
                );
                ns.setFrame_display(frame, true);
            })
        } else {
            None
        };

        // Before the displays have been measured there is no flip to do, so
        // the two-call path stands in. It is only ever the first placement.
        if placed.is_none() {
            window
                .set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
            window
                .set_position(LogicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }

        // What `island_pointer` tests the cursor against.
        *FRAME.lock().unwrap() = Some((x, y, width, height));
    }
    // Physical, because that is the only space two monitors at different DPI
    // agree on. `LogicalSize` here would be scaled by whichever monitor Tauri
    // thinks the window is on, which is the wrong one exactly while the pill
    // is being dragged from one screen to the other.
    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_size(tauri::PhysicalSize::new(
                width.round() as u32,
                height.round() as u32,
            ))
            .map_err(|e| e.to_string())?;
        window
            .set_position(tauri::PhysicalPosition::new(
                x.round() as i32,
                y.round() as i32,
            ))
            .map_err(|e| e.to_string())?;

        // What `island_pointer` tests the cursor against, in the same space.
        #[cfg(target_os = "windows")]
        {
            *FRAME.lock().unwrap() = Some((x, y, width, height));
        }
    }

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
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    // Answered in the same unit `island_place` was asked in — points on macOS,
    // device pixels everywhere else. See `Screen`.
    #[cfg(target_os = "macos")]
    {
        let scale = window.scale_factor().map_err(|e| e.to_string())?;
        let position = position.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        Ok(Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }
    #[cfg(not(target_os = "macos"))]
    Ok(Bounds {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    })
}

/// Show or hide it, without ever taking focus.
#[tauri::command]
pub fn island_visible<R: Runtime>(app: AppHandle<R>, show: bool) -> Result<(), String> {
    let window = app.get_webview_window(LABEL).ok_or("no island")?;
    note(&app, &format!("visible {show}"));

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
    // `WS_EX_NOACTIVATE` already stops a click from moving the foreground, but
    // `ShowWindow` is a second way in: the default `SW_SHOW` activates. The
    // island coming back out of "hide until something needs you" must not take
    // the caret out of whatever is being typed into.
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, IsWindowVisible, SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOWNOACTIVATE,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            let _ = ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });

            /* Topmost, again. It is a position in the z-order and not a
               property of the window: another topmost window coming up puts
               itself above this one, and a window that is shown after having
               been hidden does not return to the front of that band. Saying
               it on every show costs nothing and is the difference between
               an island that is there and an island that is behind whatever
               was last raised. */
            if show {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }

            /* What Windows thinks, rather than what we asked for. Everything
               else in this file logs an intention; on a machine where the
               island cannot be found, the useful line is the one that went
               and read the window back. */
            let mut rect = RECT::default();
            let read = GetWindowRect(hwnd, &mut rect).is_ok();
            note(
                &app,
                &format!(
                    "shown visible={} rect={} {} {}x{} read={read}",
                    IsWindowVisible(hwnd).as_bool(),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                ),
            );
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    // Windows has `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, which is
    // the same idea, but it is honoured by some capture paths and ignored by
    // others — a privacy control that works most of the time is worse than one
    // that is plainly absent, so the menu item is macOS-only and this is a
    // no-op rather than a half-promise.
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

/// Where the pointer is, in the window's own space.
///
/// Asked for, rather than announced. The island is deliberately
/// non-activating — it must never take the keyboard from the terminal you are
/// watching — and the price is that AppKit sends its webview no mouse-moved
/// events until it has been clicked, so `:hover` never fires and the pill
/// only opens once you have already aimed at it twice.
///
/// The obvious answer is for the shell to watch the cursor and push, and that
/// is what this was first: a thread, `NSEvent::mouseLocation`, and an emit.
/// Nothing arrived. Neither an event nor a bare `eval` reaches this window
/// from Rust — both report success and the page never runs them — which is a
/// fault worth its own fix, and is also why the pill has been showing the
/// demo fleet rather than the real one.
///
/// So it is a command instead, and the renderer asks. Commands are the one
/// direction across this bridge that demonstrably works: it is how the window
/// gets placed at all. The cost is a poll, and the poll is two comparisons
/// against the rectangle `island_place` recorded on its way past — no window
/// handle, no main thread, no event tap, and no accessibility permission,
/// which is only ever needed to watch the keyboard.
///
/// It answers with the reading and not just the verdict. `inside` is what the
/// pill opens on, and has been all along. `x` and `y` are the same cursor
/// expressed as an offset from the window's top-left, which the renderer
/// needs for the half of the problem the verdict does not solve: an open
/// panel whose rows still will not light up, because `:hover` inside the
/// webview depends on the mouse-moved events that are the very thing not
/// arriving. Given the offset it can ask the document what is under the
/// cursor and say so itself, and that path does not care what is frontmost.
///
/// They are in the unit the renderer places in — points on macOS, device
/// pixels on Windows — because that is the unit of the rectangle they are
/// subtracted from. The renderer divides.
#[derive(Clone, Copy, Serialize)]
pub struct Spot {
    pub x: f64,
    pub y: f64,
    pub inside: bool,
}

/// Off the window by construction: no element is ever found at a negative
/// offset, so a reading that could not be taken styles nothing.
const NOWHERE: Spot = Spot {
    x: -1.0,
    y: -1.0,
    inside: false,
};

#[tauri::command]
pub fn island_pointer() -> Option<Spot> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSEvent;

        // Wherever the window is *now*, plus the inset that says which part of
        // it is pill. Without a window there is nothing to be over.
        let Some((wx, wy, ww, wh)) = *FRAME.lock().unwrap() else {
            return Some(NOWHERE);
        };
        let (x, y, width, height) = match *HIT.lock().unwrap() {
            Some((dx, dy, w, h)) => (wx + dx, wy + dy, w, h),
            // Before the renderer has said, the whole window counts.
            None => (wx, wy, ww, wh),
        };
        let ceiling = *CEILING.lock().unwrap();
        if ceiling <= 0.0 {
            return Some(NOWHERE);
        }

        // AppKit measures the cursor from the bottom-left of the primary
        // display; everything else here is measured from its top-left.
        let at = NSEvent::mouseLocation();
        let (px, py) = (at.x, ceiling - at.y);
        Some(Spot {
            x: px - wx,
            y: py - wy,
            inside: px >= x && px < x + width && py >= y && py < y + height,
        })
    }

    /* The same question, and an easier one to ask. Windows measures from the
       top-left with y going down already, and everything on this side is in
       device pixels, so there is no flip to undo and no scale to divide by:
       the rectangle the renderer recorded is in the space `GetCursorPos`
       answers in. */
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        let Some((wx, wy, ww, wh)) = *FRAME.lock().unwrap() else {
            return Some(NOWHERE);
        };
        let (x, y, width, height) = match *HIT.lock().unwrap() {
            Some((dx, dy, w, h)) => (wx + dx, wy + dy, w, h),
            None => (wx, wy, ww, wh),
        };

        let mut at = POINT::default();
        if unsafe { GetCursorPos(&mut at) }.is_err() {
            return Some(NOWHERE);
        }
        let (px, py) = (at.x as f64, at.y as f64);
        Some(Spot {
            x: px - wx,
            y: py - wy,
            inside: px >= x && px < x + width && py >= y && py < y + height,
        })
    }

    /* `None`, and not `false`. "The pointer is not on it" and "nobody here
       can tell you" are different answers, and the renderer needs the second
       to know it must go on listening to the document's own `:hover`. A
       `false` from everywhere was enough to convince it the shell was
       talking, so it stopped listening to the only thing that was. */
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

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
    // The same flip `island_pointer` needs, measured where it is already known.
    *CEILING.lock().unwrap() = ceiling;

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
