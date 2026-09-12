/**
 * What is actually in the workspace.
 *
 * Enough of each file to read like a real one — a header comment, the shape of
 * the thing, the lines the agent touched — because a file preview that shows
 * three lines of lorem teaches nothing about whether code is comfortable to
 * read at this size in this window.
 *
 * `changed` marks the lines this session wrote, which is what the gutter draws.
 */
export type FileText = {
  path: string;
  lang: "rust" | "sql" | "ts" | "toml" | "make" | "text";
  text: string;
  /** 1-based line numbers this session touched. */
  changed?: number[];
};

const AUTH_RS = `//! Who is allowed in.
//!
//! Two ways to satisfy this, and a deployment picks one: signing in, or a
//! header a proxy we believe already set. Both produce a \`Principal\` carrying
//! the **user**, not a yes — a password that only answered "somebody" would
//! make every later question about who did what unanswerable.

use crate::accounts::{Accounts, User};
use axum::http::HeaderName;
use std::sync::Arc;

/// Set to \`none\` to serve with no authentication at all.
pub const MODE_ENV: &str = "FIRETOWER_AUTH";

/// The header a trusted proxy sets to say who the request is from.
pub const HEADER_ENV: &str = "FIRETOWER_TRUSTED_PROXY_HEADER";

/// Who made a request, once something has vouched for them.
#[derive(Debug, Clone)]
pub struct Principal {
    pub subject: Arc<str>,
    pub via: Via,
    /// Absent only when authentication is off.
    pub user: Option<User>,
}

impl Principal {
    /// Whose secrets and sessions this request acts on.
    pub fn owner(&self) -> Option<&str> {
        self.user.as_ref().map(|u| u.id.as_str())
    }

    pub fn must_change_password(&self) -> bool {
        self.user.as_ref().map(|u| u.must_change_password).unwrap_or(false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// Signed in with a password.
    Session,
    /// Named by a proxy we believe.
    Proxy,
    /// Authentication is off.
    Open,
}
`;

const API_AUTH_RS = `//! Signing in, and letting a device in.

use super::{ApiError, AppState, ErrorCode};
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

/// A device waiting to be let in.
///
/// Symmetric to the flow we already consume against GitHub: the app asks for a
/// code, a person approves it in a browser, and the app polls until there is a
/// token. The difference is which side we are on.
#[derive(Serialize)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verify_url: String,
    pub expires_in: u32,
}

/// Ten minutes. Long enough to walk to another machine, short enough that a
/// code left on a screen is not a standing invitation.
const LIVES_FOR: Duration = Duration::from_secs(600);

#[utoipa::path(post, path = "/api/v1/auth/device", tag = "auth")]
pub async fn device_start(
    State(state): State<AppState>,
    Json(body): Json<DeviceName>,
) -> Result<Json<DeviceStart>, ApiError> {
    let code = DeviceCode::new();
    state.accounts.begin_device(&code, &body.device_name, LIVES_FOR).await?;

    Ok(Json(DeviceStart {
        device_code: code.secret().to_string(),
        user_code: code.spoken().to_string(),
        verify_url: state.public_url("/device"),
        expires_in: LIVES_FOR.as_secs() as u32,
    }))
}

/// Polled by the app until somebody approves it.
///
/// A code is spent on the first successful exchange: a poll that arrives twice
/// gets one token, and the second attempt is refused rather than minting a
/// second session nobody asked for.
#[utoipa::path(post, path = "/api/v1/auth/device/token", tag = "auth")]
pub async fn device_token(
    State(state): State<AppState>,
    Json(body): Json<DeviceExchange>,
) -> Result<Json<Session>, ApiError> {
    match state.accounts.claim_device(&body.device_code).await? {
        Claim::Pending => Err(ApiError::new(ErrorCode::AuthorizationPending)),
        Claim::Expired => Err(ApiError::new(ErrorCode::Expired)),
        Claim::Ready(user) => Ok(Json(state.accounts.open_session(&user).await?)),
    }
}
`;

const DEVICE_SQL = `-- A device waiting to be let in.
--
-- Beside \`user_sessions\` rather than inside it: a code is not a session, it is
-- the thing that becomes one. Keeping them apart means an expired code sweeps
-- without touching anybody's login.

create table device_codes (
    code_hash   text primary key,
    -- What the person reads off the screen and types into the browser.
    -- Unique so two devices cannot be told the same thing.
    user_code   text not null unique,
    device_name text not null,
    -- Null until somebody approves it. Set once, and the row is spent.
    user_id     text references users(id) on delete cascade,
    claimed_at  timestamptz,
    created_at  timestamptz not null default now(),
    expires_at  timestamptz not null
);

create index device_codes_by_expiry on device_codes (expires_at);

-- Whoever is holding the other end of a token.
create table devices (
    id          text primary key,
    user_id     text not null references users(id) on delete cascade,
    name        text not null,
    platform    text not null,
    push_token  text,
    created_at  timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create index devices_by_user on devices (user_id);
`;

const CARGO = `[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.package]
version = "0.32.2"
edition = "2021"
license = "AGPL-3.0-only"

[workspace.dependencies]
anyhow = "1"
axum = { version = "0.8", features = ["ws", "macros"] }
serde = { version = "1", features = ["derive"] }
sqlx = { version = "0.8", features = ["postgres", "runtime-tokio"] }
tokio = { version = "1", features = ["full"] }
tracing = "0.1"
`;

const JUSTFILE = `# Everything you need while working on Firetower.

# The interface on :3000, the control plane on :4400.
dev:
    just gen
    pnpm --dir web dev & cargo run -p ft-server

# The Rust types are the source of truth; this writes the client from them.
gen:
    cargo run -p ft-server --bin openapi > api/openapi.json
    pnpm --dir web orval

check:
    cargo clippy --all-targets -- -D warnings
    pnpm --dir web tsc --noEmit
    just check-style

# Six type sizes, and nothing else.
check-style:
    ./scripts/check-style.sh
`;

const RECONCILE = `import { cursorFor, type Tenant } from "./cursor";
import { round } from "./rounding";

/**
 * Reconcile the ledger against what the bank says.
 *
 * Was one global cursor, which meant one slow tenant held up everybody else.
 */
export async function reconcile(tenant: Tenant) {
  const cursor = await cursorFor(tenant);
  const rows = await ledger.since(cursor, { tenant });

  for (const row of rows) {
    const stated = await statements.find(row.reference);
    if (!stated) continue;

    // The two sides disagree at the third decimal, and which one is
    // authoritative is not a thing this function should be deciding.
    if (round(row.amount) !== round(stated.amount)) {
      await flag(row, stated);
    }
  }

  return rows.length;
}
`;

export const CONTENT: FileText[] = [
  { path: "crates/ft-server/src/api/auth.rs", lang: "rust", text: API_AUTH_RS, changed: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 26, 27, 28, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56] },
  { path: "crates/ft-server/src/auth.rs", lang: "rust", text: AUTH_RS },
  { path: "migrations/server/20260912160000_device_codes.sql", lang: "sql", text: DEVICE_SQL, changed: Array.from({ length: 40 }, (_, i) => i + 1) },
  { path: "Cargo.toml", lang: "toml", text: CARGO },
  { path: "justfile", lang: "make", text: JUSTFILE },
  { path: "src/ledger/reconcile.ts", lang: "ts", text: RECONCILE, changed: [9, 10] },
];

export function fileAt(path: string): FileText | null {
  const hit = CONTENT.find((f) => f.path === path || f.path.endsWith(`/${path}`));
  if (hit) return hit;
  // A file we have no fixture for still opens; it just says so.
  return null;
}

/** Every path in the workspace, for quick-open. */
export const PATHS = CONTENT.map((f) => f.path);
