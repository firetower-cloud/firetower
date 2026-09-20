//! Dictation: the key, and the tickets minted from it.
//!
//! Firetower is not in the audio path. The browser talks to OpenAI directly
//! and this mints the short-lived credential that lets it — which is the whole
//! of the control plane's involvement in somebody talking.
//!
//! **Why not relay.** Routing audio through here would put a round trip
//! between a word being said and the same word appearing, and dictation is the
//! one thing in this application where that is felt: at 400ms it reads as
//! alive, at 700ms as broken. It would also spend the control plane's
//! bandwidth and one held-open socket per talking person, for no gain — the
//! bytes are the same bytes.
//!
//! **What is kept by minting rather than relaying.** The key itself, which
//! never leaves this process. The session's settings — model, voice detection,
//! vocabulary — are fixed [`here`](session) at mint time, so a client cannot
//! quietly promote itself to a costlier model. One `Read` in the vault's
//! access log per dictation, with a reason a person can read. And the decision
//! to mint at all.
//!
//! **What is given up, honestly.** Once a ticket is spent, this cannot stop
//! the session it opened. The limits that matter — how long one dictation runs,
//! how long it may hear nothing — are enforced by the client, in
//! `desktop/src/ui/voice/useVoice.ts`, because that is the only place left that
//! can. A session is bounded above by OpenAI's own ceiling regardless.

use super::{ApiError, ApiResult, ErrorCode};
use crate::auth::Principal;
use crate::vault::Key;
use crate::AppState;
use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Where the key lives. A scope of its own: it is the install's, not a
/// person's, and it is not a git token, an agent token or a tracker key.
const SCOPE: &str = "voice";
const NAME: &str = "OPENAI_API_KEY";

/// Which model does the transcribing.
///
/// `gpt-live-transcribe` is the one built for this — OpenAI's own description
/// is "low-latency speech-to-text model for realtime transcription", against
/// `gpt-4o-transcribe`'s general-purpose speech-to-text. Latency is the whole
/// product here: at 400ms behind your voice this reads as alive, at 700ms as
/// broken, so the specialised model is the right default even though the
/// general one also works.
///
/// Named here rather than made a setting, because the client cannot choose it
/// — that is half the point of minting. Changing it is a deployment decision.
const MODEL: &str = "gpt-live-transcribe";

/// Where a ticket is minted.
///
/// This endpoint and the session document below are the part of this file most
/// likely to need revisiting: OpenAI's realtime surface moved from
/// `/v1/realtime/transcription_sessions` with a `transcription_session` body to
/// this. A mismatch surfaces as OpenAI's own words in `mint_failed` below,
/// which is why that error passes the upstream message through rather than
/// flattening it to "could not mint".
const MINT: &str = "https://api.openai.com/v1/realtime/client_secrets";

/// What dictation knows about itself before anybody presses anything.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    /// A key is held. Not whether it works — that is only known by using it.
    pub configured: bool,
    /// Whether this person may set or replace it. Administrators only.
    pub may_configure: bool,
}

/// A credential for one connection, with about a minute to use it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTicket {
    /// The ephemeral client secret, `ek_…`. Not the key, and not a secret this
    /// install stores: it is minted, handed over and forgotten.
    pub value: String,
    /// When it stops being usable, RFC 3339. Only the connection has to happen
    /// before this; the session it opens outlives it.
    pub expires_at: String,
    /// The `session.update` the client is to send once connected, verbatim.
    ///
    /// Handed over rather than left to the client to compose, so that the
    /// settings stay decided in one place — this file — even though it is the
    /// browser that sends them. The client echoes; it does not author.
    ///
    /// Sent at all because the documented transcription flow configures the
    /// session after connecting, and whether a pre-configured ephemeral token
    /// also suffices is not something the documentation commits to. Sending it
    /// is idempotent and costs one small frame; not sending it risks the
    /// failure that looks like nothing at all — audio going up, no words
    /// coming back, every layer apparently healthy.
    #[schema(value_type = Object)]
    pub session: serde_json::Value,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetVoiceKey {
    /// The OpenAI key. Replaces whatever is there; the old one is not recoverable.
    pub key: String,
}

fn admin_only(principal: &Principal) -> bool {
    match &principal.user {
        // Authentication off is a development mode; there is nobody to be.
        None => true,
        Some(user) => user.role == "admin",
    }
}

/// Whether dictation can be used here, and whether you can fix it if not.
///
/// [`vault::Vault::holds`] rather than a read: this is a screen asking whether
/// a button should work, and it decrypts nothing and writes no log line. A
/// microphone drawn on every composer must not cost an audit entry each time
/// one opens.
#[utoipa::path(
    get, path = "/api/v1/voice", tag = "voice",
    responses((status = 200, body = VoiceState)),
)]
pub(super) async fn voice_state(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> ApiResult<Json<VoiceState>> {
    Ok(Json(VoiceState {
        configured: state.vault.holds(Key::shared(SCOPE, NAME)).await?,
        may_configure: admin_only(&principal),
    }))
}

/// Hold a key for this install, or replace the one held.
#[utoipa::path(
    put, path = "/api/v1/voice/key", tag = "voice",
    request_body = SetVoiceKey,
    responses((status = 204), (status = 400, body = ApiError), (status = 403, body = ApiError)),
)]
pub(super) async fn set_voice_key(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<SetVoiceKey>,
) -> ApiResult<StatusCode> {
    if !admin_only(&principal) {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            "only an administrator can set the voice key",
        ));
    }
    let key = request.key.trim();
    if key.is_empty() {
        return Err(ApiError::new(
            ErrorCode::InvalidRequest,
            "a key is required",
        ));
    }

    state
        .vault
        .put(Key::shared(SCOPE, NAME), key, "set on the composer")
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What the ticket is minted *for*.
///
/// Every setting a dictation runs under is in here, fixed before the client
/// ever sees a credential. That is the trade the ticket makes: the browser
/// gets to connect directly, and gets no say in what it connects as.
fn update() -> serde_json::Value {
    let mut frame = session();
    frame["type"] = serde_json::json!("session.update");
    frame
}

fn session() -> serde_json::Value {
    serde_json::json!({
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    // 24kHz mono, which is what the worklet produces.
                    "format": { "type": "audio/pcm", "rate": 24_000 },
                    "noise_reduction": { "type": "near_field" },
                    "transcription": { "model": MODEL, "prompt": VOCABULARY },
                    /* Off, because this model refuses it outright: asking for
                       `server_vad` comes back "Turn detection is not supported
                       for this transcription model."

                       Which suits dictation anyway. Automatic turn detection
                       exists to decide where one *utterance* ends so the next
                       can begin; a person dictating a prompt is composing one
                       thing and decides themselves when it is finished, by
                       pressing stop. That press is the commit
                       (`input_audio_buffer.commit`), and the commit is what
                       produces the final transcript. */
                    "turn_detection": null
                }
            }
        }
    })
}

/// Words this model would otherwise get wrong.
///
/// A general transcription model has never heard of `ft-server`, and will
/// write "fire tower FT server" with total confidence. The prompt is free, and
/// the difference between a transcript you trust and one you proof-read is
/// mostly this list.
const VOCABULARY: &str =
    "Firetower, ft-server, ft-worker, ft-core, Tauri, orval, utoipa, axum, sqlx, \
     Claude Code, Codex, Opus, Sonnet, pnpm, vitest, worktree, workspace, composer, vault";

/// Mint one, for one connection.
#[utoipa::path(
    post, path = "/api/v1/voice/ticket", tag = "voice",
    responses(
        (status = 200, body = VoiceTicket),
        (status = 409, body = ApiError, description = "No key held, or OpenAI refused it"),
    ),
)]
pub(super) async fn voice_ticket(State(state): State<AppState>) -> ApiResult<Json<VoiceTicket>> {
    let key = state
        .vault
        .get(
            Key::shared(SCOPE, NAME),
            // One line in the access log per dictation, saying what for.
            "a live dictation session",
        )
        .await?
        .ok_or_else(|| {
            ApiError::new(
                ErrorCode::ProviderNotConfigured,
                "this Firetower has no voice key",
            )
        })?;

    /* A client per mint. One request, thirty seconds, then gone — a pooled
    client on `AppState` would be the right call if this were hot, and it is
    the opposite: once per dictation, started by a person pressing a
    button. `oauth::client` is the same shape for the same reason. */
    let http = crate::oauth::client()?;
    let response = http
        .post(MINT)
        .bearer_auth(key.as_str())
        .json(&session())
        .send()
        .await
        .map_err(|e| {
            ApiError::new(
                ErrorCode::HostUnreachable,
                format!("could not reach OpenAI: {e}"),
            )
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // OpenAI's own words, not ours. A revoked key, an exhausted account
        // and a request shape this build has outgrown are three different
        // problems, and only the upstream message tells them apart — this is
        // what the composer puts under "Voice input was refused".
        return Err(ApiError::new(ErrorCode::ActionFailed, mint_failed(&body)));
    }

    let minted: Minted = serde_json::from_str(&body).map_err(|e| {
        ApiError::new(
            ErrorCode::Internal,
            format!("OpenAI's answer did not parse: {e}"),
        )
    })?;

    Ok(Json(VoiceTicket {
        expires_at: chrono::DateTime::from_timestamp(minted.expires_at, 0)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339(),
        value: minted.value,
        session: update(),
    }))
}

#[derive(Deserialize)]
struct Minted {
    value: String,
    expires_at: i64,
}

/// The useful sentence out of a refusal, or the whole thing if there isn't one.
///
/// Its own function because it is the only part of this file with a wrong
/// answer worth testing: a refusal reported as `{"error":{"message":…}}` and a
/// refusal reported as a wall of HTML from a proxy both end up in front of
/// somebody, and the second must not be pasted into a dialog whole.
fn mint_failed(body: &str) -> String {
    #[derive(Deserialize)]
    struct Wrapped {
        error: Inner,
    }
    #[derive(Deserialize)]
    struct Inner {
        message: String,
    }
    match serde_json::from_str::<Wrapped>(body) {
        Ok(w) => w.error.message,
        Err(_) => {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                "OpenAI refused the request and said nothing about why.".into()
            } else {
                trimmed.chars().take(200).collect()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_reported_in_openais_own_words() {
        let said = mint_failed(r#"{"error":{"message":"Incorrect API key provided: sk-abc"}}"#);
        assert_eq!(said, "Incorrect API key provided: sk-abc");
    }

    #[test]
    fn a_refusal_that_is_not_json_is_cut_short() {
        let html = format!("<html>{}</html>", "x".repeat(500));
        assert_eq!(mint_failed(&html).chars().count(), 200);
    }

    #[test]
    fn a_silent_refusal_still_says_something() {
        assert!(!mint_failed("   ").is_empty());
    }

    #[test]
    fn the_update_frame_is_the_minted_session_with_a_type_on_it() {
        // The client echoes this verbatim. If the two ever drift, a session is
        // configured one way at mint and another way on the wire, and which one
        // wins is the sort of question nobody wants to be asking.
        let update = update();
        assert_eq!(update["type"], "session.update");
        assert_eq!(update["session"], session()["session"]);
    }

    #[test]
    fn the_client_is_told_nothing_it_could_change() {
        // Every setting that costs money is inside the minted session, which
        // means it is decided here. If this ever starts reading from a request
        // body, that is the moment the trade this module makes stops holding.
        let session = session();
        let input = &session["session"]["audio"]["input"];
        assert_eq!(input["transcription"]["model"], MODEL);
        assert_eq!(input["format"]["rate"], 24_000);
    }
}
