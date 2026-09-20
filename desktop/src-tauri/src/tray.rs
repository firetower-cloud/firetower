//! The notification area, on Windows.
//!
//! The Mac does not get one. Its island already sits in the strip along the
//! top of the screen where a person looks for this sort of thing, and a menu
//! bar extra beside it would be the same answer given twice — two places
//! showing the same ember, neither of them obviously the real one.
//!
//! Windows is the other way round. The taskbar is where ambient status lives
//! on that platform, it is where somebody looks first, and it is the one
//! surface that is there whether or not the island has been dragged somewhere
//! forgettable. So the pill is the same on both and this is the half that is
//! genuinely Windows-shaped.
//!
//! It also closes a hole the Mac still has. "Hide until something needs you"
//! is reversible from the island's own menu, which needs the island to be on
//! screen — so on macOS the way back is to wait for ember. Here there is a
//! menu item for it that is always reachable.

#![cfg(target_os = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};

const ID: &str = "firetower";

/// Asks the island to clear "hide until something needs you".
///
/// Sent straight to the island, not round through the app. Hidden is not
/// destroyed — the webview is alive and listening the whole time it is off
/// screen — so it can undo its own preference, and `bridge.ts` does not have
/// to grow a third member for a menu item.
pub const WAKE_EVENT: &str = "island://wake";

/// Lit, or not. The same two states as the dot on the pill.
fn icon(waiting: bool) -> Option<Image<'static>> {
    let bytes: &[u8] = if waiting {
        include_bytes!("../icons/tray-waiting.png")
    } else {
        include_bytes!("../icons/tray-idle.png")
    };
    Image::from_bytes(bytes).ok()
}

fn raise<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

pub fn create<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Firetower", true, None::<&str>)?;
    let wake = MenuItem::with_id(app, "wake", "Show the island", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Firetower", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &wake, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("Firetower")
        .menu(&menu)
        // Left click opens the app; the menu is the right button's job, which
        // is the convention every other tray icon on the platform follows.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => raise(app),
            "wake" => {
                let _ = app.emit_to(
                    tauri::EventTarget::webview_window(crate::island::LABEL),
                    WAKE_EVENT,
                    (),
                );
            }
            // The one place in the app that ends the process on purpose.
            // Closing the window already does this; somebody who has the
            // window closed and only the tray left needs a way to say it too.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                raise(tray.app_handle());
            }
        });

    if let Some(image) = icon(false) {
        tray = tray.icon(image);
    }
    tray.build(app)?;
    Ok(())
}

/// Light the tower, or put it out. Driven by the same count as the dock badge.
pub fn waiting<R: Runtime>(app: &AppHandle<R>, any: bool) {
    if let Some(tray) = app.tray_by_id(ID) {
        let _ = tray.set_icon(icon(any));
    }
}
