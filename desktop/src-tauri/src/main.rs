//! The shell.
//!
//! Everything the window does that a web page cannot: an inset title bar (its
//! own buttons on Windows), a translucent sidebar on macOS, a badge on the
//! dock, and a notification when an agent stops and asks for you.
//!
//! Deliberately thin. The renderer reaches this through `src/bridge.ts`, which
//! is eight calls wide — small enough that swapping this shell for an Electron
//! one is a day's work, and that swap stays cheap only while this file stays
//! boring.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[tauri::command]
fn set_title<R: Runtime>(window: WebviewWindow<R>, title: String) {
    let _ = window.set_title(&title);
}

/// Ember, on the dock.
///
/// The count is across every backend the client holds, because the person
/// glancing at the dock does not care which company's server stopped.
#[tauri::command]
fn set_badge<R: Runtime>(window: WebviewWindow<R>, count: Option<i64>) {
    // On the window rather than the app handle, which is where Tauri puts it.
    // Windows has no dock badge; the call is a no-op there and the count
    // stays in the title bar.
    let _ = window.set_badge_count(count.filter(|n| *n > 0));
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn minimize<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.minimize();
}

/// The keychain, for one thing: a server's token.
///
/// A token in a plain file next to the app is a token anything on the machine
/// can read. The OS keychain (Keychain Access on macOS, Credential Manager on
/// Windows, the secret service on Linux) is the place the platform already
/// guards, keyed by the server's id so the same server on a new address is
/// still the same entry.
const KEYCHAIN_SERVICE: &str = "cloud.firetower.desktop";

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn close<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.close();
}

#[tauri::command]
fn zoom<R: Runtime>(window: WebviewWindow<R>) {
    let maximized = window.is_maximized().unwrap_or(false);
    let _ = if maximized {
        window.unmaximize()
    } else {
        window.maximize()
    };
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // Links leave the app: a pull request opens in the browser, not in here.
        .plugin(tauri_plugin_opener::init())
        // Apps remember where they were; pages do not.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // A new build is offered from the GitHub release; the renderer asks.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");

            // A macOS sidebar is translucent, and a flat panel is the clearest
            // tell that something is a web page in a window. The renderer paints
            // its rail with `--color-panel-vibrant` so this shows through it.
            #[cfg(target_os = "macos")]
            {
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::Sidebar,
                    Some(NSVisualEffectState::Active),
                    None,
                );
            }

            let _ = window.set_title("Firetower");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_title, set_badge, notify, minimize, zoom, close, secret_get, secret_set, secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("firetower failed to start");
}
