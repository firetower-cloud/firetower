//! The shell.
//!
//! Everything the window does that a web page cannot: an inset title bar (its
//! own buttons on Windows), a translucent sidebar on macOS, a badge on the
//! dock, a notification when an agent stops and asks for you, and the island —
//! the same ember, on a pill that outlives the window (`island.rs`).
//!
//! Deliberately thin. The renderer reaches this through `src/bridge.ts`, which
//! is eight calls wide — small enough that swapping this shell for an Electron
//! one is a day's work, and that swap stays cheap only while this file stays
//! boring.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Runtime, WebviewWindow};

mod capture;
mod island;
mod tray;

#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

#[tauri::command]
fn set_title<R: Runtime>(window: WebviewWindow<R>, title: String) {
    let _ = window.set_title(&title);
}

/// Ember, on the dock — and on the taskbar button.
///
/// The count is across every backend the client holds, because the person
/// glancing at it does not care which company's server stopped.
#[tauri::command]
fn set_badge<R: Runtime>(window: WebviewWindow<R>, count: Option<i64>) {
    let waiting = count.filter(|n| *n > 0);

    // On the window rather than the app handle, which is where Tauri puts it.
    let _ = window.set_badge_count(waiting);

    // Windows has no dock badge — `set_badge_count` is a no-op there, which is
    // why this used to say the count stayed in the title bar. The taskbar's
    // own idea of a badge is an overlay icon on the button, so that is what it
    // gets: a dot, not a number. An overlay is drawn at 16x16, where a digit
    // is a smudge, and a count would be a second thing for ember to mean.
    #[cfg(target_os = "windows")]
    {
        let ember = tauri::image::Image::from_bytes(include_bytes!("../icons/ember.png")).ok();
        let _ = window.set_overlay_icon(if waiting.is_some() { ember } else { None });
        // And the tower in the tray, lit by the same count.
        tray::waiting(window.app_handle(), waiting.is_some());
    }
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

/// Save something out of a workspace, asking where first.
///
/// The fetch is here rather than in the renderer, which already has the token
/// and could do it in three lines. Two reasons it is worth the crossing:
///
///   * a webview has no filesystem. The renderer could hold the bytes and have
///     nowhere to put them — and the usual fix, granting the `fs` plugin a
///     write scope, hands *every* page in the window the ability to write to
///     the disk for the sake of one button;
///   * a hundred megabytes must not cross the IPC bridge. Command arguments
///     are serialised, so a zip passed through as bytes is copied, encoded and
///     held twice over before anything reaches a file.
///
/// So the renderer sends a URL and gets back where it landed. `None` means the
/// sheet was dismissed, which is not an error and must not be drawn as one.
#[tauri::command]
async fn save_download<R: Runtime>(
    app: tauri::AppHandle<R>,
    url: String,
    token: Option<String>,
    suggested: String,
    on_phase: tauri::ipc::Channel<&str>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // Asked before the request, so a dismissed sheet costs nothing. The other
    // order would download a zip somebody then declined to keep.
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name(&suggested)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });

    let picked = tokio::task::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| e.to_string())?;

    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|e| format!("that isn't somewhere this can write: {e}"))?;

    let client = reqwest::Client::new();
    let mut request = client.get(&url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }

    let answer = request
        .send()
        .await
        .map_err(|e| format!("couldn't reach Firetower: {e}"))?;

    // The control plane answers a refusal as JSON with a message in it, and
    // writing that to disk under a `.zip` is the worst of both: no error, and a
    // file that will not open. Read it out and say it instead.
    if !answer.status().is_success() {
        let status = answer.status();
        let body = answer.text().await.unwrap_or_default();
        let said = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            });
        return Err(said.unwrap_or_else(|| format!("Firetower answered {status}")));
    }

    // **Headers are the boundary between the two phases.**
    //
    // The archive endpoint cannot answer until the worker has finished
    // deflating — it owes the response a `content-length`, and a zip's size is
    // not known until the last entry is written. So the moment the headers
    // land is precisely the moment compressing stopped and bytes started, and
    // the renderer can say so without anybody guessing.
    //
    // After the status check, so a refusal never flashes "Downloading…" on its
    // way to being an error. A plain file has no first phase; its caller seeds
    // `downloading` itself and this confirms what it already said.
    let _ = on_phase.send("downloading");

    if let Err(e) = stream_to(&path, answer).await {
        // **A half-written file is worse than no file.** It is a `.zip` that
        // will not open or a video that will not play, sitting under the name
        // somebody asked for and dated now — so the next person to look finds
        // something that appears to be the download and is not.
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }

    Ok(Some(path.to_string_lossy().to_string()))
}

/// Write a response to a path as it arrives.
///
/// Streamed rather than buffered because the ceiling is ten gigabytes now.
/// `bytes()` would hold the whole download in this process before a byte
/// reached the disk, which at the old hundred-megabyte limit was merely rude
/// and at this one is the app being killed for memory halfway through a
/// render somebody waited twenty minutes for.
async fn stream_to(path: &std::path::Path, mut answer: reqwest::Response) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|e| format!("couldn't create that file: {e}"))?;

    while let Some(chunk) = answer
        .chunk()
        .await
        .map_err(|e| format!("the download stopped early: {e}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("couldn't write that file: {e}"))?;
    }

    // Explicitly, and checked. Dropping a `File` flushes on a best-effort
    // basis and throws the error away, which for the last chunk of a ten
    // gigabyte download is the one error worth having.
    file.flush()
        .await
        .map_err(|e| format!("couldn't finish writing that file: {e}"))
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
        // Apps remember where they were; pages do not. The island is exempt:
        // it resizes itself on every state change, so a remembered *size*
        // would be restored over the right one — and its position is
        // remembered by the renderer, which is the only part that knows
        // whether the display it was on still exists.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&[island::LABEL])
                .build(),
        )
        // A new build is offered from the GitHub release; the renderer asks.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // A file or a directory leaves a workspace through the save sheet.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Before the main window is touched: when this is on, nothing else
            // about this launch matters. See `capture::self_test`.
            capture::self_test(app.handle());

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

            // Built hidden. The renderer places it and then asks to be shown,
            // because where it goes depends on a display it has to check is
            // still there. A failure here must not take the app down with it:
            // the island is an addition to the window, never a condition of it.
            //
            // Not gated to macOS any more. The pill is the same component and
            // the same document on both; what differs is four window flags and
            // where it starts out, and both of those live in `island.rs`.
            if let Err(e) = island::create(app.handle()) {
                eprintln!("island: {e}");
            }
            island::close_with(&window);

            // The taskbar's notification area. Windows only — see `tray.rs`.
            #[cfg(target_os = "windows")]
            if let Err(e) = tray::create(app.handle()) {
                eprintln!("tray: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_title,
            set_badge,
            notify,
            minimize,
            zoom,
            close,
            save_download,
            capture::capture_poster,
            secret_get,
            secret_set,
            secret_delete,
            island::island_screens,
            island::island_place,
            island::island_bounds,
            island::island_visible,
            island::island_sharing,
            island::island_push,
            island::island_open,
            island::island_pointer,
            island::island_hit,
            island::island_activate,
            island::island_click_through,
            island::island_note,
        ])
        .run(tauri::generate_context!())
        .expect("firetower failed to start");
}
