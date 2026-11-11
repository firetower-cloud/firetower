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

mod capture;
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

/// What the OS keychain said when it was asked for a credential.
///
/// **Three answers and not two, and the third is the whole reason this type
/// exists.** This used to be a `Result<Option<String>, String>`, and
/// `keyring` returns `NoEntry` for exactly one situation — nothing is filed
/// under that name — while *every other* outcome is an error: no Secret
/// Service on the bus, a locked login keyring, a macOS keychain that will not
/// grant access without a prompt, a Windows Credential Manager a policy has
/// closed. The renderer flattened that error into `null` with a `.catch`, so
/// "the keychain is not there" and "the credential is not there" arrived as
/// the same answer — and the second one is permission to forget that somebody
/// signed out. One launch on a machine with no keyring was enough to lose it,
/// and the launch after that signed back in with the credential they had
/// declined.
///
/// So the distinction is carried in the type, in the *success* channel, where
/// no error handling can collapse it. `Unknown` is not a failure to be
/// swallowed; it is an answer, and the only safe thing to do with it is
/// nothing.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Said {
    /// The keychain has one, and this is it.
    Held { token: String },
    /// The keychain answered, and there is nothing filed under that name.
    Absent,
    /// The keychain could not be asked, or would not say. **Not `Absent`.**
    Unknown { why: String },
}

/// Whether a keychain write or deletion actually happened.
///
/// A second two-valued type rather than a `Result`, for the same reason as
/// above: the caller has to act on "it did not happen", and an error is the
/// shape that gets discarded on the way across. There is no third answer here
/// — a change either went through or it did not — and "did not" is always the
/// safe assumption.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "says", rename_all = "camelCase")]
pub enum Done {
    /// The keychain confirms it.
    Done,
    /// It did not happen, and this is what the platform said about it.
    Refused { why: String },
}

/// Read a `keyring` answer as one of the three things it can mean.
///
/// Its own function because it is the whole of the fix and the only part that
/// can be tested without a keychain. Every platform's failure — and `keyring`
/// is `#[non_exhaustive]`, so there will be failures this was not written
/// against — lands on `Unknown`. `Absent` is reachable from `NoEntry` and
/// from nothing else, which is the property `main.rs`'s tests assert against
/// the error shapes all three platforms actually produce.
fn said(answer: Result<String, keyring::Error>) -> Said {
    match answer {
        Ok(token) => Said::Held { token },
        Err(keyring::Error::NoEntry) => Said::Absent,
        Err(e) => Said::Unknown { why: e.to_string() },
    }
}

/// Read a `keyring` answer to a deletion the same way.
///
/// `NoEntry` is success here: the caller asked for the credential to be gone
/// and it is gone. Anything else is a refusal, including the one that matters
/// — a keyring that has left the bus since the credential was stored.
fn removed(answer: Result<(), keyring::Error>) -> Done {
    match answer {
        Ok(()) | Err(keyring::Error::NoEntry) => Done::Done,
        Err(e) => Done::Refused { why: e.to_string() },
    }
}

/// Answers `Said` rather than `Result`, so a rejection cannot become "absent".
#[tauri::command]
fn secret_get(key: String) -> Said {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key) {
        Ok(entry) => said(entry.get_password()),
        // Not even an entry handle. Nothing is known about what is stored.
        Err(e) => Said::Unknown { why: e.to_string() },
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Done {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key) {
        Ok(entry) => match entry.set_password(&value) {
            Ok(()) => Done::Done,
            Err(e) => Done::Refused { why: e.to_string() },
        },
        Err(e) => Done::Refused { why: e.to_string() },
    }
}

#[tauri::command]
fn secret_delete(key: String) -> Done {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key) {
        Ok(entry) => removed(entry.delete_credential()),
        Err(e) => Done::Refused { why: e.to_string() },
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

/// Fetch an artifact's HTML, for the renderer to show in an `srcdoc` iframe.
///
/// In local development an artifact is served over plain `http` on a signed
/// subdomain of `localhost`. The native shell is a *secure* context, and a
/// secure page refuses an insecure `http` subresource — mixed content — so an
/// `<iframe src="http://…">` comes up blank and no webview toggle changes that.
///
/// So the renderer reads the bytes here instead, where the mixed-content rule
/// does not exist, and drops them into an `srcdoc` iframe — whose document
/// inherits the shell's own (secure) origin, so nothing insecure is ever
/// loaded. Production serves artifacts over `https`, which frames directly, so
/// the renderer only takes this path for an `http` URL. The `?ft-shot` the
/// renderer appends asks the control plane for the page without its annotation
/// picker, which an `srcdoc` document cannot host anyway.
#[tauri::command]
async fn load_artifact(url: String) -> Result<String, String> {
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("could not reach the artifact: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("the artifact server answered {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("could not read the artifact: {e}"))
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
            capture::capture_supported,
            secret_get,
            secret_set,
            secret_delete,
            load_artifact,
        ])
        .run(tauri::generate_context!())
        .expect("firetower failed to start");
}

/// What the keychain's three answers are, against the errors each platform
/// really produces.
///
/// **These tests are the only instrument we have for Windows.** There is no
/// Windows machine on this fleet and nobody has driven the keychain there, so
/// the thing that has to be true — that a Credential Manager a policy has
/// closed is never read as "there is no credential here" — cannot be measured.
/// What can be asserted is the mapping it goes through, with the error shapes
/// `keyring` 3.6 hands up from each backend written down. They run on all
/// three CI legs.
///
/// The errors below are not invented. Each is the message the backend emits
/// for the situation named, carried in the `keyring::Error` variant that
/// backend uses for it: `NoStorageAccess` where the store exists and will not
/// open, `PlatformFailure` where the platform call itself failed.
#[cfg(test)]
mod tests {
    use super::{removed, said, Done, Said};

    fn boxed(why: &str) -> Box<dyn std::error::Error + Send + Sync> {
        Box::new(std::io::Error::other(why.to_string()))
    }

    /// The keychain answering "nothing is filed here" — the one and only way
    /// to `Absent`, and the only answer that permits anything.
    #[test]
    fn only_no_entry_means_the_credential_is_not_there() {
        assert_eq!(said(Err(keyring::Error::NoEntry)), Said::Absent);
        assert_eq!(
            said(Ok("ft_live_9c2bbe41".into())),
            Said::Held {
                token: "ft_live_9c2bbe41".into()
            }
        );
    }

    #[test]
    fn linux_without_a_secret_service_is_not_an_absent_credential() {
        // The common Linux case, and the one QA drove end to end: a minimal
        // desktop, a tiling window manager or an ssh session, where nothing
        // owns the name on the bus at all.
        let answer = said(Err(keyring::Error::NoStorageAccess(boxed(
            "DBus error: The name org.freedesktop.secrets was not provided by any .service files",
        ))));
        assert!(matches!(answer, Said::Unknown { .. }), "{answer:?}");
    }

    #[test]
    fn a_locked_linux_keyring_is_not_an_absent_credential() {
        // gnome-keyring installed, login keyring never unlocked. The prompt
        // is declined or there is no prompter to show it.
        let answer = said(Err(keyring::Error::NoStorageAccess(boxed(
            "DBus error: org.freedesktop.Secret.Error.IsLocked: Cannot get secret of a locked object",
        ))));
        assert!(matches!(answer, Said::Unknown { .. }), "{answer:?}");
    }

    #[test]
    fn a_locked_macos_keychain_is_not_an_absent_credential() {
        // `errSecInteractionNotAllowed`, -25308: the item is there and the
        // keychain will not hand it over without a prompt it cannot show.
        // QA confirmed this exact string against real Keychain Services, and
        // that it reaches `PlatformFailure` — -25308 is not one of the four
        // codes `macos.rs` maps to `NoStorageAccess`.
        let locked = said(Err(keyring::Error::PlatformFailure(boxed(
            "SecKeychainFindGenericPassword: User interaction is not allowed. (-25308)",
        ))));
        assert!(matches!(locked, Said::Unknown { .. }), "{locked:?}");

        // `errSecNotAvailable`, -25291 — one of the four that does arrive as
        // the store being shut. Both arms, because both exist.
        let shut = said(Err(keyring::Error::NoStorageAccess(boxed(
            "SecKeychainFindGenericPassword: No keychain is available. You may need to restart your computer. (-25291)",
        ))));
        assert!(matches!(shut, Said::Unknown { .. }), "{shut:?}");
    }

    #[test]
    fn a_closed_windows_credential_manager_is_not_an_absent_credential() {
        // A policy has shut Credential Manager: `CredRead` fails with
        // `ERROR_ACCESS_DENIED` (5), which `windows.rs` sends to the
        // catch-all — **not** `ERROR_NOT_FOUND` (1168), the one and only code
        // it turns into `NoEntry`. The two are a few digits apart in the
        // platform and must never be one answer here.
        let shut = said(Err(keyring::Error::PlatformFailure(boxed(
            "Windows error 5: Access is denied.",
        ))));
        assert!(matches!(shut, Said::Unknown { .. }), "{shut:?}");

        // `ERROR_NO_SUCH_LOGON_SESSION` (1312) is the single code it does
        // read as the store being unreachable.
        let gone = said(Err(keyring::Error::NoStorageAccess(boxed(
            "Windows error 1312: A specified logon session does not exist. It may already have been terminated.",
        ))));
        assert!(matches!(gone, Said::Unknown { .. }), "{gone:?}");
    }

    /// `keyring::Error` is `#[non_exhaustive]`, so the question is not whether
    /// these particular shapes are handled but whether the *default* is safe.
    #[test]
    fn anything_else_the_keychain_says_is_also_not_absent() {
        for answer in [
            said(Err(keyring::Error::BadEncoding(vec![0xff, 0xfe]))),
            said(Err(keyring::Error::TooLong("service".into(), 32))),
            said(Err(keyring::Error::Invalid(
                "target".into(),
                "cannot be empty".into(),
            ))),
            said(Err(keyring::Error::Ambiguous(vec![]))),
        ] {
            assert!(matches!(answer, Said::Unknown { .. }), "{answer:?}");
        }
    }

    /// Deleting is the other half: a credential that was not there is gone,
    /// and a keyring that refused has not removed anything.
    #[test]
    fn a_deletion_is_done_only_when_the_credential_is_gone() {
        assert_eq!(removed(Ok(())), Done::Done);
        assert_eq!(removed(Err(keyring::Error::NoEntry)), Done::Done);

        for refusal in [
            removed(Err(keyring::Error::NoStorageAccess(boxed(
                "DBus error: The name org.freedesktop.secrets was not provided by any .service files",
            )))),
            removed(Err(keyring::Error::PlatformFailure(boxed(
                "SecKeychainItemDelete: User interaction is not allowed. (-25308)",
            )))),
            removed(Err(keyring::Error::NoStorageAccess(boxed(
                "Windows error 5: Access is denied.",
            )))),
        ] {
            assert!(matches!(refusal, Done::Refused { .. }), "{refusal:?}");
        }
    }

    /// The shape the renderer actually receives, because the tag is what the
    /// TypeScript switches on and a rename here is a silent change there.
    #[test]
    fn the_renderer_sees_a_tagged_answer_it_can_switch_on() {
        let held = serde_json::to_string(&Said::Held {
            token: "ft_live_9c2bbe41".into(),
        })
        .unwrap();
        assert_eq!(held, r#"{"says":"held","token":"ft_live_9c2bbe41"}"#);
        assert_eq!(
            serde_json::to_string(&Said::Absent).unwrap(),
            r#"{"says":"absent"}"#
        );
        assert_eq!(
            serde_json::to_string(&Said::Unknown {
                why: "no bus".into()
            })
            .unwrap(),
            r#"{"says":"unknown","why":"no bus"}"#
        );
        assert_eq!(
            serde_json::to_string(&Done::Done).unwrap(),
            r#"{"says":"done"}"#
        );
        assert_eq!(
            serde_json::to_string(&Done::Refused {
                why: "locked".into()
            })
            .unwrap(),
            r#"{"says":"refused","why":"locked"}"#
        );
    }
}
