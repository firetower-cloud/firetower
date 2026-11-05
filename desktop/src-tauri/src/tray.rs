//! The notification area, on Windows.
//!
//! The Mac does not get one. Its menu bar is already the strip a person looks
//! at for this sort of thing, and the dock carries the badge; a menu bar extra
//! would be the same answer given twice.
//!
//! Windows is the other way round. The taskbar is where ambient status lives
//! on that platform and it is where somebody looks first — so the tower sits
//! there, lit by the same count that lights the overlay on the taskbar
//! button, and it is a way back to a window that is merely behind something.

#![cfg(target_os = "windows")]

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

const ID: &str = "firetower";

/// Lit, or not. The same two states as the overlay on the taskbar button.
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
    let quit = MenuItem::with_id(app, "quit", "Quit Firetower", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;

    let mut tray = TrayIconBuilder::with_id(ID)
        .tooltip("Firetower")
        .menu(&menu)
        // Left click opens the app; the menu is the right button's job, which
        // is the convention every other tray icon on the platform follows.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => raise(app),
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
