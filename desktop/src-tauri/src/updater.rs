//! The update path, behind Firetower's own commands.
//!
//! **Why this exists at all.** A copy of the app has a channel of its own, and
//! a channel is an address: beta's manifest lives at one URL, general access's
//! at another. Choosing that address at runtime is possible, documented, and
//! takes effect per check with no restart — but it is available *only* here,
//! from the shell language. The scripting-side options accept no endpoint, and
//! the plugin cannot be initialised with one either, so the renderer cannot
//! reach it however it asks.
//!
//! **And "just the check" was not available.** An update is a resource whose
//! handle this side owns: `download` and `install` are methods on it, so a
//! check performed here cannot hand the stock path something it can continue
//! with. That is why the whole check / download / install sequence moved, and
//! not only the one call that needed the address.
//!
//! Three things are deliberately *not* done here:
//!
//!   * **The compiled endpoint is kept** (`tauri.conf.json`, pointing at the
//!     permanent general-access alias). It is optional and a runtime call
//!     replaces it wholesale, so keeping it means a path that bypasses these
//!     commands still works — and works on the safe channel. It is also the
//!     fallback when the channel preference is missing or unreadable, which is
//!     why [`check`] takes an `Option` rather than a required address.
//!   * **No downgrade allowance.** `version_comparator` is left unset, so the
//!     plugin's own "only if newer" rule stands. That rule is the whole
//!     meaning of switching a copy back: leaving beta stops new betas, it does
//!     not put an older build over this one.
//!   * **No signing-key work.** The key is per configuration, not per
//!     endpoint, so a manifest fetched from the beta address verifies against
//!     the key already in the bundle.
//!
//! The renderer reaches this through `src/update-shell.ts`, which is three
//! calls wide and is the seam `update.test.ts` mocks — deliberately, so the
//! tests keep asserting through a module boundary rather than against the
//! shape of an inter-process call.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The event the renderer listens on while an install is downloading.
///
/// Forwarded rather than dropped: the stock path reported progress through the
/// plugin's own channel, and moving the sequence behind a command would have
/// lost it — leaving a button that says "Downloading…" for a hundred megabytes
/// with nothing behind it.
pub const PROGRESS: &str = "update://progress";

/// What the last check found, held for the install rather than fetched twice.
///
/// One at a time, and the one being replaced is dropped: a window open for a
/// day asks a hundred and forty-four times, and a hundred and forty-four of
/// these left alive is a leak nobody sees until the shell runs out of them.
#[derive(Default)]
pub struct Held(Mutex<Option<Arc<Update>>>);

/// One check's answer, as the renderer reads it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// The version announced by the manifest.
    pub version: String,
    /// The version this copy is running, as the shell knows it.
    pub current_version: String,
    /// The release's notes, when the manifest carries them.
    pub notes: Option<String>,
    /// **The channel the manifest names, for display only.**
    ///
    /// There is no first-class channel concept in the updater or its manifest
    /// format — Firetower's channel is a local preference plus a second
    /// manifest at a second address. The plugin ignores unknown manifest
    /// fields and hands the whole document up, which is the only reason this
    /// is readable at all. **Nothing acts on it, here or anywhere**: it exists
    /// so a copy can answer "why do I have this build and my colleague does
    /// not", and a field the plugin ignores is one somebody will otherwise
    /// mistake for a mechanism.
    pub channel: Option<String>,
}

/// How far along a download is. One per chunk, which is often.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub downloaded: u64,
    /// `None` when the server would not say how big the payload is.
    pub total: Option<u64>,
}

/// Ask the channel's address whether there is a newer build.
///
/// `endpoint` replaces the compiled one wholesale for this check only; `None`
/// keeps the compiled one, which is the general-access alias. Nothing is
/// stored on this side — the preference lives in the renderer, so the address
/// is chosen per check and a channel change needs no restart.
#[tauri::command]
pub async fn update_check<R: Runtime>(
    app: AppHandle<R>,
    held: State<'_, Held>,
    endpoint: Option<String>,
) -> Result<Option<Found>, String> {
    let mut builder = app.updater_builder();
    if let Some(address) = endpoint {
        let url = reqwest::Url::parse(&address)
            .map_err(|e| format!("{address} is not an update address: {e}"))?;
        builder = builder
            .endpoints(vec![url])
            .map_err(|e| format!("that update address was refused: {e}"))?;
    }
    let updater = builder.build().map_err(say)?;
    let found = updater.check().await.map_err(say)?;

    let answer = found.as_ref().map(|u| Found {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        channel: u
            .raw_json
            .get("channel")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    });

    // Replacing what is held drops the previous one. Taken and released, so
    // the guard is never alive across an await.
    *held.0.lock().map_err(|_| poisoned())? = found.map(Arc::new);
    Ok(answer)
}

/// Download what the last check found, install it, and say so.
///
/// The handle is cloned out of the lock before anything is awaited, so a check
/// arriving mid-download does not block on this one — it replaces what is held
/// and this install carries on with the copy it took.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    held: State<'_, Held>,
) -> Result<(), String> {
    let update = {
        let holding = held.0.lock().map_err(|_| poisoned())?;
        holding.clone()
    }
    .ok_or_else(|| "There is nothing to install — check again.".to_string())?;

    let mut downloaded: u64 = 0;
    let to = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = to.emit(PROGRESS, Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(say)?;

    // What was installed is no longer there to install again. On Windows the
    // process has already been asked to exit by this point, so this is for the
    // platforms where it has not.
    if let Ok(mut holding) = held.0.lock() {
        *holding = None;
    }
    Ok(())
}

/// Every call takes this, so the shell's state is registered in one place.
pub fn hold<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Held::default());
}

/// A plugin error, as the sentence the screen will put in front of somebody.
///
/// `{e}` rather than `{e:?}`: every reader of a failure in this app asks for a
/// message, and the one that matters most — an installation this account
/// cannot write to — is the platform's own words, which `Display` keeps and
/// `Debug` buries.
fn say(e: tauri_plugin_updater::Error) -> String {
    e.to_string()
}

/// A lock a panicking caller left broken. Said rather than unwrapped, because
/// an update that cannot be installed is a sentence on a screen, not a crash.
fn poisoned() -> String {
    "The update this window was holding was lost. Check again.".to_string()
}
