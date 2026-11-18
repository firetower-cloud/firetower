//! Which channel this installation is on, what each channel offers, and the
//! one act that moves it between them.
//!
//! ## The channel is the tag, and nothing stores it
//!
//! An installation's channel is the tag on the image the control plane is
//! actually running, read back through the updater — which is the only thing
//! that can see the container this process is in. There is no setting and no
//! row. One fact cannot disagree with itself: a stored `beta` beside a compose
//! file saying `:stable` would drift, and the operator would be shown an error
//! about image versions whose real cause was a stale row.
//!
//! What follows from that, and is not a defect:
//!
//! * an installation with no updater cannot be asked, so it is reported as
//!   general access — the safe answer — and as unable to switch, with the
//!   reason;
//! * a tag that names no channel (`latest`, `edge`, `0.55`, a local build)
//!   resolves to general access *and* says it was not recognised, rather than
//!   silently asserting a channel;
//! * an operator who hand-edits the image line has changed channel, with no
//!   confirmation and no record. What you are running is what you are running.
//!
//! ## Reading the channel manifest
//!
//! Which version each channel holds is a published document, not a scan of
//! release tags — a pin is a value, and deriving it by enumerating releases
//! breaks the day general access falls off the feed's first page. [`read`] has
//! four outcomes and they are **not interchangeable**:
//!
//! | Outcome | Meaning |
//! | --- | --- |
//! | [`Read::Absent`] | No document yet. The bootstrap case, and the only one that is not a problem: the installation keeps following the newest release, as it did before channels existed. |
//! | [`Read::Found`] | It read. That is the answer. |
//! | [`Read::Vanished`] | It was read before and is gone now. **Absence is the bootstrap case only on a first start** — a document that existed and does not any more has been destroyed, and somebody has to republish it. |
//! | [`Read::Unreadable`] | The read went wrong — a rate limit, a network failure, a status that is not a 404. |
//! | [`Read::Malformed`] | Something came back and it is not this document. |
//! | [`Read::Incomplete`] | It is this document and it names no version. |
//!
//! The last four **stop and change nothing**. A read that goes wrong must
//! never be allowed to look like "general access is at version zero" — the
//! rule the desktop release workflow writes out at length, inherited here by
//! every reader. They are kept apart because the answer to each is
//! different: retry a failed fetch, republish a destroyed document, fix a
//! malformed one.

use super::deploy;
use super::{client, version, Updates};
use crate::AppState;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use ft_updater_api::{tags, FileWrite, ImageRole, Status as UpdaterStatus};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use utoipa::ToSchema;

/// The compose file both image lines live in.
const COMPOSE_FILE: &str = "firetower.yml";

/// The most of a channel manifest worth reading.
///
/// The document is a few hundred bytes. This is the ceiling on what a host
/// that is not Firetower's can make this process allocate, which is the only
/// thing on this path that is not ours to begin with.
const MOST: usize = 64 * 1024;

/// How long one read of it may take. Explicit here rather than left to
/// whatever the shared client is configured with, because a fetch that never
/// returns is the other half of the same problem.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(20);

/// Remembered across restarts: this installation has read a channel manifest
/// at least once.
///
/// Durable, and that is the point — the process is replaced by the very
/// upgrades this governs, so an answer that lived only in memory would call
/// the first read after every upgrade a first start.
const EVER_READ: &str = "updates.channel_manifest_read";

// ── the channels ─────────────────────────────────────────────────────

/// The two channels. There is no third: `edge` is the tip of the trunk and is
/// deliberately not selectable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    /// The versions a maintainer has promoted. Where an installation is
    /// unless somebody deliberately moved it.
    General,
    /// Every release, as soon as it is cut.
    Beta,
}

impl Channel {
    pub const ALL: [Channel; 2] = [Channel::General, Channel::Beta];

    /// The image tag that *is* this channel.
    pub const fn tag(self) -> &'static str {
        match self {
            Channel::General => tags::STABLE,
            Channel::Beta => tags::BETA,
        }
    }

    /// The channel a tag names, if it names one. `latest`, `edge`, a
    /// two-part version and a bare version name none.
    pub fn of_tag(tag: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.tag() == tag)
    }

    /// The key this channel has in the channel manifest.
    const fn key(self) -> &'static str {
        match self {
            Channel::General => "general",
            Channel::Beta => "beta",
        }
    }

    /// What being on it means, in one line, for a screen to draw.
    pub const fn offers(self) -> &'static str {
        match self {
            Channel::General => "Releases a maintainer has promoted.",
            Channel::Beta => "Every release, as soon as it is cut.",
        }
    }

    /// Whether taking this channel can be undone *at the moment it is taken*.
    ///
    /// Beta cannot: it installs versions general access does not hold yet,
    /// and their migrations run forward on the database. What this is not is
    /// a permanent membership — leaving beta costs nothing once general
    /// access reaches the version the installation is holding, because the
    /// database is already on that schema. That is why nothing here hides
    /// the row: the refusal is [`Offer::reason`] on a move that would be a
    /// downgrade, and it lifts by itself.
    pub const fn irreversible(self) -> bool {
        matches!(self, Channel::Beta)
    }

    pub const fn name(self) -> &'static str {
        match self {
            Channel::General => "general access",
            Channel::Beta => "beta",
        }
    }
}

/// The packages that release separately, and so are pinned separately.
///
/// Mobile is deliberately absent: it has no general-access channel to be
/// promoted into. A later third package is what the document's schema version
/// exists to make safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Package {
    ControlPlane,
    Desktop,
}

impl Package {
    pub const ALL: [Package; 2] = [Package::ControlPlane, Package::Desktop];

    /// The key this package has in the channel manifest. Snake case, as the
    /// document is written — it is not this API's casing.
    const fn key(self) -> &'static str {
        match self {
            Package::ControlPlane => "control_plane",
            Package::Desktop => "desktop",
        }
    }
}

// ── the channel manifest ─────────────────────────────────────────────

/// Where the channel manifest is published.
///
/// A rolling release of its own holding one asset, replaced by a clobbering
/// upload on each promotion — it is mutable by design, so it cannot live at an
/// immutable ref. Overridable for a test or a mirror, the way the releases
/// feed already is, and deliberately **not** in `deploy/.env.example`: the
/// channel is derived rather than configured, so no installation needs a line
/// in `.env` for any of this.
#[derive(Clone, Debug)]
pub struct Source {
    pub url: String,
}

impl Source {
    pub const ENV: &'static str = "FIRETOWER_CHANNEL_MANIFEST";
    /// What the writer leaves on the release before it replaces the
    /// manifest. `docs/channels.md`: uploading an asset deletes the old one
    /// before it writes the new, so a failed upload can leave the release
    /// with no manifest — and **a release carrying this but no manifest is a
    /// destroyed manifest**, not a repository that has never promoted.
    pub const PREVIOUS: &'static str = "channels.previous.json";
    /// The release the promotion workflow uploads to, and the one asset on
    /// it. Named `channels` rather than `channels-latest`: the rolling
    /// releases beside it point at the newest of a *series*, and there is
    /// only ever one channel manifest.
    pub const DEFAULT: &'static str =
        "https://github.com/firetower-cloud/firetower/releases/download/channels/channels.json";

    /// The sibling asset, beside whatever this source names.
    pub fn previous(&self) -> String {
        match self.url.rfind('/') {
            Some(at) => format!("{}{}", &self.url[..=at], Self::PREVIOUS),
            None => Self::PREVIOUS.to_string(),
        }
    }

    pub fn from_env() -> Self {
        Self {
            url: std::env::var(Self::ENV)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| Self::DEFAULT.to_string()),
        }
    }
}

/// The document, as this control plane reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub packages: Vec<Pins>,
}

/// What one package's channels hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Pins {
    pub package: Package,
    pub beta: String,
    pub general: String,
    /// When general access last moved to what it holds. The only thing that
    /// makes a stuck promotion visible, and recorded nowhere else.
    pub general_promoted_at: Option<DateTime<Utc>>,
}

impl Manifest {
    /// What a channel holds for a package, if the document names it.
    pub fn pin(&self, package: Package, channel: Channel) -> Option<&str> {
        self.pins(package).map(|p| match channel {
            Channel::Beta => p.beta.as_str(),
            Channel::General => p.general.as_str(),
        })
    }

    pub fn pins(&self, package: Package) -> Option<&Pins> {
        self.packages.iter().find(|p| p.package == package)
    }
}

/// What a read of the channel manifest said. See the module header: these are
/// not interchangeable, and only [`Read::Absent`] is a bootstrap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Read {
    Absent,
    Found(Manifest),
    /// It was read before and is not there now. A separate state from
    /// [`Read::Unreadable`] because the answer to it is different: a fetch
    /// that failed is worth retrying, and a document that has been destroyed
    /// has to be republished before anything can move. Waiting makes that one
    /// worse.
    Vanished(String),
    Unreadable(String),
    Malformed(String),
    Incomplete(String),
}

/// The same six, as the API names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ManifestOutcome {
    /// Nothing published yet. The bootstrap case, and the only one that is
    /// not a problem — see [`Read::Absent`].
    Absent,
    Found,
    /// Published before, and gone now. The document every installation reads
    /// has been destroyed and has to be put back; this is the one state here
    /// that gets worse while nobody acts on it.
    Vanished,
    Unreadable,
    Malformed,
    Incomplete,
}

impl Read {
    pub fn outcome(&self) -> ManifestOutcome {
        match self {
            Read::Absent => ManifestOutcome::Absent,
            Read::Found(_) => ManifestOutcome::Found,
            Read::Vanished(_) => ManifestOutcome::Vanished,
            Read::Unreadable(_) => ManifestOutcome::Unreadable,
            Read::Malformed(_) => ManifestOutcome::Malformed,
            Read::Incomplete(_) => ManifestOutcome::Incomplete,
        }
    }

    /// Why it did not read, in words. `None` when it did, and when there is
    /// nothing published yet.
    pub fn problem(&self) -> Option<&str> {
        match self {
            Read::Absent | Read::Found(_) => None,
            Read::Vanished(why)
            | Read::Unreadable(why)
            | Read::Malformed(why)
            | Read::Incomplete(why) => Some(why),
        }
    }

    /// Whether anything may be acted on. A read that went wrong moves
    /// nothing, which is the whole of the rule.
    pub fn is_usable(&self) -> bool {
        matches!(self, Read::Found(_))
    }
}

/// Read a document. Separated from fetching it so it can be tested on what a
/// host actually returns rather than on a network.
pub fn read(body: &str) -> Read {
    let document: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return Read::Malformed(format!("the channel manifest is not JSON: {e}")),
    };
    let Some(object) = document.as_object() else {
        return Read::Malformed("the channel manifest is not an object".into());
    };
    // A document that does not say what shape it is cannot be read safely,
    // and this is the one field that could never be added afterwards.
    let Some(schema_version) = object.get("schema_version").and_then(|v| v.as_u64()) else {
        return Read::Malformed("the channel manifest has no schema_version".into());
    };
    if schema_version < 1 {
        return Read::Malformed(format!(
            "the channel manifest says schema_version {schema_version}"
        ));
    }

    let mut packages = Vec::new();
    for package in Package::ALL {
        let Some(entry) = object.get(package.key()) else {
            // A package this document does not name. Absent is only a
            // failure for the one whose version this control plane acts on;
            // anything else is a document written before that package had a
            // channel, which is exactly what the schema version is for.
            if package == Package::ControlPlane {
                return Read::Incomplete(format!(
                    "the channel manifest names no {} versions",
                    package.key()
                ));
            }
            continue;
        };
        let Some(entry) = entry.as_object() else {
            return Read::Malformed(format!(
                "the channel manifest's {} is not an object",
                package.key()
            ));
        };
        let version_of = |channel: Channel| -> Result<String, Read> {
            match entry.get(channel.key()).and_then(|v| v.as_str()) {
                Some(raw) if version::parse(raw).is_some() => Ok(raw.trim().to_string()),
                // Present and not a version is the same failure as absent,
                // and both have to stop: a reader that fell through here
                // would be reporting a channel it cannot name a version for.
                Some(raw) => Err(Read::Malformed(format!(
                    "the channel manifest's {}.{} is {raw:?}, which is not a version",
                    package.key(),
                    channel.key()
                ))),
                None => Err(Read::Incomplete(format!(
                    "the channel manifest names no {}.{} version",
                    package.key(),
                    channel.key()
                ))),
            }
        };
        let beta = match version_of(Channel::Beta) {
            Ok(v) => v,
            Err(stop) => return stop,
        };
        let general = match version_of(Channel::General) {
            Ok(v) => v,
            Err(stop) => return stop,
        };
        packages.push(Pins {
            package,
            beta,
            general,
            general_promoted_at: entry
                .get("general_promoted_at")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|t| t.with_timezone(&Utc)),
        });
    }

    Read::Found(Manifest {
        // Read optimistically past what this build knows: the document's
        // stated policy is additive, and a reader that refused a greater
        // number would be an installation that stopped reading the one
        // address it has the day a field was added.
        schema_version: schema_version.min(u32::MAX as u64) as u32,
        packages,
    })
}

/// Fetch it. A 404 is absence — the bootstrap case — and every other way a
/// read can fail is a reason to change nothing.
pub async fn fetch(http: &reqwest::Client, source: &Source) -> Fetched {
    let response = match http.get(&source.url).timeout(PATIENCE).send().await {
        Ok(r) => r,
        Err(e) => {
            return Fetched::nothing(Read::Unreadable(format!(
                "the channel manifest could not be fetched: {e}"
            )))
        }
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // Nothing at the address — but the writer leaves the document it is
        // replacing beside it, so a release carrying that and no manifest is
        // one whose upload failed part-way rather than one that has never
        // promoted. Server-side proof, which no local memory can supply to a
        // control plane that has only just been installed.
        return Fetched::nothing(match served(http, &source.previous()).await {
            Some(true) => Read::Vanished(format!(
                "the channel manifest has gone from {}, but {} is still on the release — so an \
                 upload failed part-way and the document has been destroyed rather than never \
                 published. Check {}, confirm it is what you expect, and re-upload it as the \
                 manifest. Nothing is being moved until it is back.",
                source.url,
                Source::PREVIOUS,
                Source::PREVIOUS,
            )),
            Some(false) => Read::Absent,
            // Could not tell whether the previous document is there. Absence
            // is the one answer that lets an installation move, so it is not
            // the one to guess at.
            None => Read::Unreadable(format!(
                "the channel manifest is not at {}, and whether {} is beside it could not be \
                 read — so whether this is a first start or a destroyed document is unknown",
                source.url,
                Source::PREVIOUS,
            )),
        });
    }
    if !response.status().is_success() {
        return Fetched::nothing(Read::Unreadable(format!(
            "the channel manifest at {} answered {}",
            source.url,
            response.status()
        )));
    }

    // A chunk at a time with a ceiling, rather than `text()`, which allocates
    // whatever the far end decides to send. This is the one input on this
    // path that Firetower does not produce: a release host that has been
    // taken over, or has simply gone wrong, must not be able to take the
    // control plane down by answering at length.
    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MOST {
                    return Fetched::served(Read::Unreadable(format!(
                        "the channel manifest at {} is longer than {MOST} bytes, so it is not \
                         being read. Nothing that size is this document.",
                        source.url
                    )));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                return Fetched::served(Read::Unreadable(format!(
                    "the channel manifest could not be read: {e}"
                )))
            }
        }
    }
    Fetched::served(match std::str::from_utf8(&body) {
        Ok(text) => read(text),
        Err(_) => Read::Malformed("the channel manifest is not text".into()),
    })
}

/// What one fetch produced, and whether the host served anything at all.
///
/// The second half is the part that matters: **a 200 is proof a document
/// exists at that address, whatever this process made of it.** A manifest
/// that answered and did not parse is still a manifest that exists, and an
/// installation that forgets that will read the next 404 as a first start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub read: Read,
    pub served: bool,
}

impl Fetched {
    fn served(read: Read) -> Self {
        Self { read, served: true }
    }

    fn nothing(read: Read) -> Self {
        Self {
            read,
            served: false,
        }
    }
}

/// Whether something is at an address. `None` when it could not be told,
/// which is never treated as "no".
async fn served(http: &reqwest::Client, url: &str) -> Option<bool> {
    let answered = http.get(url).timeout(PATIENCE).send().await.ok()?;
    if answered.status() == reqwest::StatusCode::NOT_FOUND {
        return Some(false);
    }
    answered.status().is_success().then_some(true)
}

/// What the last read said, and the last document that actually read.
///
/// In memory, like the agents' published versions beside it, and refreshed on
/// the same pass: this is a cache of somebody else's document, not a record of
/// anything this installation decided. A read that goes wrong leaves the held
/// document alone — and is still reported, because a reader acting on a stale
/// pin is exactly what must not happen quietly.
#[derive(Clone, Default)]
pub struct Manifests(Arc<tokio::sync::RwLock<Held>>);

#[derive(Default)]
struct Held {
    /// The most recent attempt. `None` until one has been made.
    last: Option<Read>,
    /// The last document that read, which a failed attempt does not disturb.
    held: Option<Manifest>,
    read_at: Option<DateTime<Utc>>,
    /// Tickets handed out, and the highest one whose result has been stored.
    ///
    /// Two reads can be in flight at once — the six-hourly check and
    /// somebody pressing the button — and they do not come back in the order
    /// they left. A slow answer that lands after a newer one has been stored
    /// is older news, and the dangerous shape of that is a first-start `404`
    /// arriving after a document has already read.
    given: u64,
    stored: u64,
}

/// What the cache holds, for a screen.
#[derive(Debug, Clone)]
pub struct Seen {
    pub outcome: Option<Read>,
    pub held: Option<Manifest>,
    pub read_at: Option<DateTime<Utc>>,
}

impl Manifests {
    /// Take a ticket for a read that is about to start.
    async fn ticket(&self) -> u64 {
        let mut held = self.0.write().await;
        held.given += 1;
        held.given
    }

    /// Store what a read said, unless something newer has already landed.
    ///
    /// Returns what the cache holds afterwards, which for a discarded answer
    /// is the newer one that beat it.
    async fn store(&self, ticket: u64, found: Read) -> Read {
        let mut held = self.0.write().await;
        if ticket <= held.stored {
            let newer = held.last.clone().unwrap_or(found);
            tracing::info!(
                "a channel manifest read came back after a newer one had landed; keeping the \
                 newer answer"
            );
            return newer;
        }
        held.stored = ticket;
        if let Read::Found(manifest) = &found {
            held.held = Some(manifest.clone());
        }
        if let Some(why) = found.problem() {
            tracing::warn!("{why}; nothing is being moved");
        }
        held.last = Some(found.clone());
        held.read_at = Some(Utc::now());
        found
    }

    /// Whether a document is held from an earlier read in this process.
    async fn holds_one(&self) -> bool {
        self.0.read().await.held.is_some()
    }

    pub async fn seen(&self) -> Seen {
        let held = self.0.read().await;
        Seen {
            outcome: held.last.clone(),
            held: held.held.clone(),
            read_at: held.read_at,
        }
    }

    /// Whether this process has ever asked.
    pub async fn never_asked(&self) -> bool {
        self.0.read().await.last.is_none()
    }
}

/// Ask the host again, and remember what it said.
///
/// The order here is the whole of what makes a bad read unable to pass for a
/// first start:
///
/// 1. take a ticket, then fetch;
/// 2. decide what absence means **after** the fetch, from the marker as it is
///    now — a `404` that overtook a successful read must not be classified
///    against the world as it was when it set off;
/// 3. record that a document read **before** acting on one, because a read
///    this installation could not record is one a restart would call a first
///    start;
/// 4. store, unless something newer has already landed.
pub async fn refresh(state: &AppState) -> Read {
    let updates = &state.updates;
    let ticket = updates.channel_manifest.ticket().await;
    let Fetched { read, served } = fetch(&updates.http, &updates.channel_source).await;

    let before = read_one_before(&state.accounts, updates.channel_manifest.holds_one().await).await;
    let found = classify(read, before, &updates.channel_source.url);

    // **Recorded on any 200, parsed or not.** The marker means "a manifest
    // has existed at this address", not "a manifest once parsed" — a
    // document that answered and would not parse is still proof it exists,
    // and forgetting that is what lets the next 404 read as a first start.
    let found = match served {
        true => acted_on(found, remember_a_read(&state.accounts).await),
        false => found,
    };

    updates.channel_manifest.store(ticket, found).await
}

/// What a fetch means, given whether this installation has read a manifest
/// before.
///
/// **Absence is the bootstrap case only the first time.** A document that has
/// been read before and is now a 404 has gone, which is a failure rather than
/// a fresh start — and treating it as a fresh start is precisely how an
/// installation comes to accept an older pin from a manifest somebody
/// destroyed.
fn classify(fetched: Read, read_one_before: bool, url: &str) -> Read {
    match fetched {
        Read::Absent if read_one_before => Read::Vanished(format!(
            "the channel manifest has gone from {url}. This installation has read one before, \
             so the document has been destroyed rather than never published — it has to be put \
             back, and waiting will not bring it back"
        )),
        other => other,
    }
}

/// Whether a document that read may be acted on.
///
/// Only if this installation managed to write down that it read one. A
/// document it could not record is one a restart would mistake for a first
/// start, and the next absence after that would read as a bootstrap — which
/// ends with a general-access installation being offered a beta. The cost of
/// refusing is one cycle.
fn acted_on(found: Read, recorded: Result<()>) -> Read {
    match recorded {
        Ok(()) => found,
        Err(e) => Read::Unreadable(format!(
            "the channel manifest read, but recording that it did failed: {e:#}. It is not \
             being acted on — a read this installation cannot write down is one a restart would \
             mistake for a first start"
        )),
    }
}

/// What is held, asking once if nothing in this process ever has. A control
/// plane that was just recreated has an empty cache and a screen in front of
/// somebody.
pub async fn seen(state: &AppState) -> Seen {
    if state.updates.channel_manifest.never_asked().await {
        refresh(state).await;
    }
    state.updates.channel_manifest.seen().await
}

/// Whether this installation has read a channel manifest before.
///
/// Two sources, and **both are needed**: a document already held in this
/// process, and the durable marker for every process before it. The cache
/// alone would forget across the recreate that an upgrade performs, which is
/// the restart that makes a destroyed manifest look like a first start.
async fn read_one_before(accounts: &crate::accounts::Accounts, holds_one: bool) -> bool {
    holds_one || !a_first_start(accounts).await
}

/// Whether absence may still mean "nothing has been published yet".
///
/// A database that will not answer counts as **has read one before**, which
/// is the conservative direction: being wrong that way costs a switch that
/// is not offered, and being wrong the other way costs an installation
/// accepting an older pin from a manifest that vanished.
async fn a_first_start(accounts: &crate::accounts::Accounts) -> bool {
    let marker = accounts.setting(EVER_READ).await;
    if let Err(e) = &marker {
        tracing::warn!("reading whether a channel manifest has ever been read: {e:#}");
    }
    never_read_one(&marker)
}

/// The decision on its own, so the answer to "the database would not say" is
/// a test rather than a reading.
fn never_read_one(marker: &Result<Option<String>>) -> bool {
    match marker {
        Ok(seen) => seen.is_none(),
        // When you cannot tell, refuse. Being wrong this way costs a switch
        // that is not offered; being wrong the other way costs an
        // installation accepting an older pin.
        Err(_) => false,
    }
}

/// Write down that a document read. **The failure is returned, not logged
/// and dropped** — see [`refresh`] for what is done about it.
async fn remember_a_read(accounts: &crate::accounts::Accounts) -> Result<()> {
    accounts
        .set_setting(EVER_READ, &Utc::now().to_rfc3339())
        .await
}

// ── what this installation is running ────────────────────────────────

/// The tag the control plane is running from, and what it means.
#[derive(Debug, Clone)]
pub struct Running {
    /// `ghcr.io/firetower-cloud/firetower:stable`. `None` when nothing could
    /// be asked.
    pub reference: Option<String>,
    pub repository: Option<String>,
    pub tag: Option<String>,
    /// The channel in force. General access when the tag does not name one,
    /// because that is the safe answer — paired with `recognised`, which says
    /// it is an assumption.
    pub channel: Channel,
    pub recognised: bool,
    /// The tag is an exact version, so the updater will refuse to move this
    /// container at all.
    pub pinned: bool,
    /// Why the channel had to be assumed, in words.
    pub problem: Option<String>,
    /// Every repository the deployment's own containers are on — what a
    /// switch rewrites the image lines of.
    pub repositories: Vec<String>,
    /// Whether the updater can be told which tag to fetch. An older one
    /// would pull the tag the container is already on, which is the one thing
    /// a switch must not do.
    pub updater_can_switch: bool,
}

impl Running {
    /// What to report when there is nothing to ask.
    fn unknown(problem: String) -> Self {
        Self {
            reference: None,
            repository: None,
            tag: None,
            channel: Channel::General,
            recognised: false,
            pinned: false,
            problem: Some(problem),
            repositories: Vec::new(),
            updater_can_switch: false,
        }
    }
}

/// Read the channel off an updater's status.
pub fn running_from(status: &UpdaterStatus) -> Running {
    let Some(image) = status
        .images
        .iter()
        .find(|i| i.role == ImageRole::ControlPlane)
    else {
        return Running::unknown(format!(
            "the updater beside this control plane is {} (contract version {}) and does not report \
             which image this control plane is running, so its channel cannot be read. Upgrading \
             the control plane brings the updater with it.",
            status.version, status.api_version
        ));
    };
    let (repository, tag) = ft_updater_api::split_reference(&image.reference);
    let recognised = Channel::of_tag(&tag);
    let pinned = ft_updater_api::is_pinned(&tag);
    Running {
        problem: match recognised {
            Some(_) => None,
            None => Some(format!(
                ":{tag} does not name a channel, so this Firetower is treated as general access — \
                 which is the safe answer, and an assumption rather than a reading.",
            )),
        },
        channel: recognised.unwrap_or(Channel::General),
        recognised: recognised.is_some(),
        pinned,
        repositories: status
            .images
            .iter()
            .map(|i| ft_updater_api::split_reference(&i.reference).0)
            .collect(),
        updater_can_switch: status.api_version >= 2,
        reference: Some(image.reference.clone()),
        repository: Some(repository),
        tag: Some(tag),
    }
}

/// What an installation with no updater beside it is told.
///
/// The same treatment `docs/updates.md` already gives an upgrade it cannot
/// carry out: general access is the assumption, and the screen says what to
/// do about it rather than hiding the row.
fn without_an_updater(absent: &client::Absent) -> String {
    format!(
        "The updater is what reports the image this Firetower is running, so without one the \
         channel cannot be read and cannot be changed from here. General access is the \
         assumption. {}",
        absent.explain()
    )
}

/// Ask the updater what this control plane is running. Never cached: a
/// container that was recreated since the last ask is the case this exists
/// for, and a remembered answer is the stored setting the design refuses.
pub async fn running(updates: &Updates, status: Option<&UpdaterStatus>) -> Running {
    if let Some(status) = status {
        return running_from(status);
    }
    match &updates.updater {
        Err(absent) => Running::unknown(without_an_updater(absent)),
        Ok(updater) => match updater.status().await {
            Ok(status) => running_from(&status),
            Err(e) => Running::unknown(format!(
                "the updater is not answering, so the channel cannot be read: {e:#}"
            )),
        },
    }
}

// ── what the API says ────────────────────────────────────────────────

/// Which channel this installation is on, and what each channel offers.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    /// The channel in force, derived from the tag on the running image.
    /// General access when it could not be read, which `recognised` and
    /// `problem` qualify.
    pub channel: Channel,
    /// The tag that image was created from. `None` when nothing could be
    /// asked — which is a third answer, not a false one.
    pub tag: Option<String>,
    /// The whole reference, for a screen that names it.
    pub image: Option<String>,
    /// Whether the tag names a channel. False makes `channel` an assumption.
    pub recognised: bool,
    /// The image line names an exact version, so no upgrade can move this
    /// installation until it is changed.
    pub pinned: bool,
    /// Why the channel is an assumption, in words. `None` when it was read.
    pub problem: Option<String>,
    /// Whether this server would carry out a switch at all, from anybody.
    pub switchable: bool,
    /// Why it would not. `None` when it would.
    pub reason: Option<String>,
    /// Whether the person asking may take it. Only an administrator: the
    /// channel is the whole deployment's, not a resource anybody holds a
    /// grant on.
    #[serde(default)]
    pub may_change: bool,
    pub manifest: ManifestView,
    /// One per channel, in a fixed order: general access, then beta.
    pub offers: Vec<Offer>,
}

/// What the last read of the channel manifest said, and what it holds.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManifestView {
    /// The outcome of the most recent read. Five, and they are not
    /// interchangeable — see this module's header.
    pub outcome: ManifestOutcome,
    /// Why it did not read, in words.
    pub problem: Option<String>,
    /// The shape of the document that read.
    pub schema_version: Option<u32>,
    /// Every package's pins, from the last document that read. A failed read
    /// leaves these alone rather than emptying them, and `outcome` is what
    /// says the figures may be behind.
    pub packages: Vec<Pins>,
    pub read_at: Option<DateTime<Utc>>,
    /// Where it is published. Reported so an installation that cannot read it
    /// can say what it could not reach.
    pub url: String,
}

/// One channel, as a row on a screen.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub channel: Channel,
    /// The image tag that is this channel.
    pub tag: String,
    /// What being on it means, in one line.
    pub offers: String,
    /// The version it holds for the control plane. `None` when the manifest
    /// could not be read — never a zero, and never the newest release.
    pub version: Option<String>,
    /// When general access last moved to what it holds. Always `None` for
    /// beta: every release reaches beta, so the date a beta build appeared is
    /// its own release date and the manifest does not record it twice.
    pub since: Option<DateTime<Utc>>,
    /// Whether this is the channel in force.
    pub on: bool,
    /// What can be done about this row, if anything.
    pub action: Option<Act>,
    /// Whether taking it cannot be undone at the moment it is taken. See
    /// [`Channel::irreversible`] — it is the version that cannot be walked
    /// back, not the membership.
    pub irreversible: bool,
    /// Why there is nothing to do here, in words.
    pub reason: Option<String>,
}

/// The two shapes the one act takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum Act {
    /// Move to the other channel.
    Switch,
    /// Stay on this channel and make the image line say so. What an
    /// installation on an unrecognised tag needs: it is being treated as
    /// general access, and this is how it comes to actually be on it.
    Pin,
}

/// What a switch would write, and what it would move to.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSwitch {
    pub channel: Channel,
    /// The channel it is leaving. The same as `channel` when the act is a
    /// pin rather than a move.
    pub from: Channel,
    pub act: Act,
    /// The tag both image lines are being moved to.
    pub tag: String,
    /// The version this installation would be moved onto, in the same act.
    pub version: String,
    /// Whether this cannot be undone at the moment it is taken. True for
    /// beta, always — see [`Channel::irreversible`].
    pub irreversible: bool,
    /// The deployment file being rewritten.
    pub file: String,
    /// The image lines, as they are and as they would be.
    pub lines: Vec<ImageLine>,
    /// The same, as a unified diff — the way every other change to this file
    /// is shown.
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageLine {
    pub from: String,
    pub to: String,
}

/// Everything about this installation's channel, in one answer.
///
/// `updater` is the status this request has already read, when it has — the
/// Updates screen asks for both at once and there is no reason to ask the
/// updater twice.
pub async fn status(state: &AppState, updater: Option<&UpdaterStatus>) -> ChannelStatus {
    let updates = &state.updates;
    let running = running(updates, updater).await;
    let seen = seen(state).await;

    // A read nobody has made is not a read that found nothing. Deliberately
    // not `unwrap_or(Read::Absent)`: absence is the bootstrap case, and
    // anything that collapsed into it would be a reason to go ahead.
    let outcome = seen
        .outcome
        .clone()
        .unwrap_or_else(|| Read::Unreadable("the channel manifest has not been read yet".into()));
    // Nor is a database that will not answer an absence of runs. #383 is the
    // same shape: a failed query became "nothing is there", and what the
    // reader saw was an empty list rather than a failure.
    let busy = match updates.store.active_runs().await {
        Ok(runs) => Ok(runs.into_iter().next().map(|r| r.id)),
        Err(e) => Err(format!("{e:#}")),
    };

    let (reason, offers) = decide(
        &running,
        &outcome,
        seen.held.as_ref(),
        busy,
        &updates.channel_source.url,
    );

    ChannelStatus {
        channel: running.channel,
        tag: running.tag,
        image: running.reference,
        recognised: running.recognised,
        pinned: running.pinned,
        problem: running.problem,
        switchable: reason.is_none(),
        reason,
        may_change: false,
        manifest: ManifestView {
            outcome: outcome.outcome(),
            problem: outcome.problem().map(str::to_string),
            schema_version: seen.held.as_ref().map(|m| m.schema_version),
            packages: seen.held.map(|m| m.packages).unwrap_or_default(),
            read_at: seen.read_at,
            url: updates.channel_source.url.clone(),
        },
        offers,
    }
}

/// Whether a switch could be taken at all, and what each channel row says.
///
/// Everything this decides is in its arguments, so every outcome has a test
/// rather than a screenshot. `busy` is `Err` when the database would not say
/// — which refuses, because "it did not answer" is not "nothing is running".
fn decide(
    running: &Running,
    outcome: &Read,
    held: Option<&Manifest>,
    busy: Result<Option<String>, String>,
    url: &str,
) -> (Option<String>, Vec<Offer>) {
    // Why a switch could not be carried out at all, in the order the operator
    // would have to fix them.
    let reason = if running.reference.is_none() {
        running.problem.clone()
    } else if !running.updater_can_switch {
        Some(
            "the updater beside this control plane is too old to be told which image to fetch, so \
             a channel switch cannot be carried out. Upgrade this Firetower first; the updater is \
             brought with it."
                .into(),
        )
    } else if running.pinned {
        Some(format!(
            "{} is pinned to :{} in {COMPOSE_FILE}, which the updater will not move. Change that \
             line to :{} for general access, or to :{}, and the switch can be taken.",
            running.repository.clone().unwrap_or_default(),
            running.tag.clone().unwrap_or_default(),
            tags::STABLE,
            tags::BETA,
        ))
    } else if let Some(why) = outcome.problem() {
        // A rate limit, a network failure, a document that is not this one, a
        // document with no version in it. Each of them stops, and says which
        // it was.
        Some(format!("{why}. Nothing is being moved."))
    } else if matches!(outcome, Read::Absent) {
        // The bootstrap case, and the only one that is not a failure: there
        // is nothing published to move onto yet.
        Some(format!(
            "no channel manifest has been published yet, so neither channel names a version. This \
             Firetower follows the newest release, as it did before channels existed. ({url})"
        ))
    } else {
        match busy {
            Ok(Some(run)) => Some(format!(
                "an upgrade is in progress ({run}); a channel can be changed once it has finished"
            )),
            Ok(None) => None,
            Err(e) => Some(format!(
                "whether an upgrade is already in progress could not be read: {e}"
            )),
        }
    };

    let current = version::current();
    let pins = held.and_then(|m| m.pins(Package::ControlPlane));
    let offers = Channel::ALL
        .into_iter()
        .map(|channel| {
            let on = channel == running.channel;
            // Only ever from a document that read. A held copy beside a
            // failed read is still reported — `outcome` says the figures may
            // be behind — but `reason` above has already refused the act.
            let holds = pins.map(|p| match channel {
                Channel::Beta => p.beta.clone(),
                Channel::General => p.general.clone(),
            });
            let (action, why) = match (&reason, &holds) {
                (Some(reason), _) => (None, Some(reason.clone())),
                (None, None) => (
                    None,
                    Some("the channel manifest names no version for the control plane".into()),
                ),
                (None, Some(holds)) => {
                    let backwards =
                        version::parse(holds).is_some_and(|v| version::is_newer(&current, &v));
                    match (on, running.recognised, backwards) {
                        (_, _, true) => (
                            None,
                            Some(format!(
                                "this Firetower is running {current}, which is newer than the \
                                 {holds} {name} holds. Nothing is ever moved backwards — this \
                                 becomes an ordinary switch once {name} reaches {current}.",
                                name = channel.name()
                            )),
                        ),
                        (true, true, _) => (
                            None,
                            Some(format!("this Firetower is on {}", channel.name())),
                        ),
                        // Being treated as a channel is not being on it: the
                        // image line still says something else, and this is
                        // the press that makes the two agree.
                        (true, false, _) => (Some(Act::Pin), None),
                        (false, _, _) => (Some(Act::Switch), None),
                    }
                }
            };
            Offer {
                channel,
                tag: channel.tag().to_string(),
                offers: channel.offers().to_string(),
                version: holds,
                since: match channel {
                    Channel::General => pins.and_then(|p| p.general_promoted_at),
                    Channel::Beta => None,
                },
                on,
                action,
                irreversible: channel.irreversible(),
                reason: why,
            }
        })
        .collect();

    (reason, offers)
}

/// The version an offer would take, from the offer that was validated.
///
/// **The whole of the race this exists to close.** A switch used to be
/// validated against one read of the manifest and then planned against
/// another: the refresh is periodic, so a run could be accepted after a
/// check against `0.55.0` and target whatever the next read named — an older
/// pin included, which is the one move migrations cannot survive. The
/// version is now carried from the snapshot that was checked, and this is
/// the only place it comes from.
fn version_to_take(offer: &Offer) -> Result<String> {
    anyhow::ensure!(
        offer.action.is_some(),
        "{}",
        offer
            .reason
            .clone()
            .unwrap_or_else(|| "this channel cannot be taken from here".into())
    );
    offer
        .version
        .clone()
        .context("the channel manifest names no control plane version")
}

// ── the switch ───────────────────────────────────────────────────────

/// What moving to `to` would write and what it would move onto.
///
/// Returns the view for the screen and the file writes the run carries. The
/// two come from one computation on purpose: what is shown as a diff is the
/// bytes that would be written.
/// `offer` is a row from a [`ChannelStatus`] the caller has already read and
/// checked. It is passed whole, rather than a channel to look up again,
/// because looking it up again is the race — see [`version_to_take`].
pub async fn plan(
    state: &AppState,
    offer: &Offer,
    choices: &[super::FileChoice],
) -> Result<(ChannelSwitch, Vec<FileWrite>, super::UpgradePlan)> {
    let to = offer.channel;
    let updates = &state.updates;
    let running = running(updates, None).await;
    let updater = updates
        .updater
        .as_ref()
        .map_err(|absent| anyhow!("{}", absent.explain()))?;
    anyhow::ensure!(
        !running.repositories.is_empty(),
        "{}",
        running
            .problem
            .unwrap_or_else(|| "the updater does not say what this Firetower is running".into())
    );

    let version = version_to_take(offer)?;
    let to_version =
        version::parse(&version).with_context(|| format!("{version} is not a version"))?;

    // The release's own changes to the deployment files come first, so a
    // switch that also moves a release writes one file rather than fighting
    // over it. The image lines are then moved on top of whichever copy is
    // going to be on the machine.
    let planned = super::status::plan(state, &to_version, true).await?;
    let mut writes =
        super::status::files_from_plan(state, &to_version, planned.clone(), choices).await?;
    let local = updater
        .deploy_files()
        .await?
        .files
        .into_iter()
        .find(|f| f.name == COMPOSE_FILE)
        .and_then(|f| f.content)
        .with_context(|| format!("the deployment has no {COMPOSE_FILE} to change"))?;
    let base = writes
        .iter()
        .find(|f| f.name == COMPOSE_FILE)
        .map(|f| f.content.clone())
        .unwrap_or_else(|| local.clone());

    let (rewritten, lines) = retag(&base, &running.repositories, to.tag())?;
    writes.retain(|f| f.name != COMPOSE_FILE);
    writes.push(FileWrite {
        name: COMPOSE_FILE.to_string(),
        content: rewritten.clone(),
    });

    Ok((
        ChannelSwitch {
            channel: to,
            from: running.channel,
            act: if to == running.channel {
                Act::Pin
            } else {
                Act::Switch
            },
            tag: to.tag().to_string(),
            version,
            irreversible: to.irreversible(),
            file: COMPOSE_FILE.to_string(),
            lines,
            diff: deploy::unified_diff(COMPOSE_FILE, &local, &rewritten),
        },
        writes,
        planned,
    ))
}

/// Move every Firetower image line in a compose file onto one tag.
///
/// Only lines naming a repository the updater reported are touched, so the
/// database's image and anything else an operator keeps in this file are left
/// exactly as they are. A repository with no line to move is refused rather
/// than quietly left behind: the two images are published together and may
/// never be on different channels.
pub fn retag(
    compose: &str,
    repositories: &[String],
    tag: &str,
) -> Result<(String, Vec<ImageLine>)> {
    let mut out = String::with_capacity(compose.len());
    let mut lines = Vec::new();
    let mut found: Vec<String> = Vec::new();

    for line in compose.split_inclusive('\n') {
        let Some(image) = ImageValue::read(line) else {
            out.push_str(line);
            continue;
        };
        let (repository, was) = ft_updater_api::split_reference(image.reference);
        if !repositories.contains(&repository) {
            out.push_str(line);
            continue;
        }
        found.push(repository.clone());
        let moved = format!("{repository}:{tag}");
        if was != tag {
            lines.push(ImageLine {
                from: image.reference.to_string(),
                to: moved.clone(),
            });
        }
        out.push_str(&image.rewritten(&moved));
    }

    for repository in repositories {
        anyhow::ensure!(
            found.iter().any(|f| f == repository),
            "{COMPOSE_FILE} has no `image:` line for {repository}, so the channel cannot be \
             changed from here. Put the line back, or edit it on the machine."
        );
    }

    Ok((out, lines))
}

/// One `image:` line, taken apart so only the reference in it moves.
///
/// Everything around it is the operator's: the indentation, a trailing
/// comment and the spacing before it, a quoted value, the line ending. Two
/// lines of this file are being changed and nothing else about it may be.
struct ImageValue<'a> {
    indent: &'a str,
    quote: &'a str,
    reference: &'a str,
    spacing: &'a str,
    comment: &'a str,
    ending: &'a str,
}

impl<'a> ImageValue<'a> {
    fn read(line: &'a str) -> Option<Self> {
        let body = line.trim_end_matches(['\n', '\r']);
        let ending = &line[body.len()..];
        let indent = &body[..body.len() - body.trim_start().len()];
        let value = body.trim_start().strip_prefix("image:")?;
        // A `#` only starts a comment after whitespace; one inside a
        // reference is part of it.
        let at = value
            .char_indices()
            .find(|(i, c)| *c == '#' && value[..*i].ends_with(char::is_whitespace))
            .map(|(i, _)| i);
        let (head, comment) = match at {
            Some(at) => value.split_at(at),
            None => (value, ""),
        };
        let spacing = &head[head.trim_end().len()..];
        let trimmed = head.trim();
        let quote = match trimmed.chars().next() {
            Some(q @ ('"' | '\'')) if trimmed.len() > 1 && trimmed.ends_with(q) => &trimmed[..1],
            _ => "",
        };
        Some(Self {
            indent,
            quote,
            reference: trimmed[quote.len()..trimmed.len() - quote.len()].trim(),
            spacing,
            comment,
            ending,
        })
    }

    fn rewritten(&self, reference: &str) -> String {
        let Self {
            indent,
            quote,
            spacing,
            comment,
            ending,
            ..
        } = self;
        format!("{indent}image: {quote}{reference}{quote}{spacing}{comment}{ending}")
    }
}

/// The tag the control plane's image line will name once a run's writes have
/// landed — which is the tag the updater has to fetch from.
///
/// The compose file is the intent and the container is the fact, and they
/// differ at exactly two moments: a switch, which rewrites the line in the
/// same run, and the release that first moves an installation off the general
/// floating tag. Both want the file's answer.
///
/// Answered whenever the line can be read at all, rather than only when it
/// differs from the container — the two containers are not always on the same
/// tag as each other. An installation that switched channel while both
/// channels held one version has an updater still created from the tag it was
/// left on, and a comparison against the *control plane's* container would
/// say "no tag needed" and send that updater to fetch the channel it is no
/// longer on. `None` only when there is no line to read, which leaves the
/// updater fetching what it always fetched.
pub async fn fetch_tag(state: &AppState, writes: &[FileWrite]) -> Option<String> {
    let updates = &state.updates;
    let running = running(updates, None).await;
    let repository = running.repository.as_ref()?;
    let on_disk = async {
        updates
            .updater
            .as_ref()
            .ok()?
            .deploy_files()
            .await
            .ok()?
            .files
            .into_iter()
            .find(|f| f.name == COMPOSE_FILE)
            .and_then(|f| f.content)
    };
    let compose = match writes.iter().find(|f| f.name == COMPOSE_FILE) {
        Some(write) => write.content.clone(),
        None => on_disk.await?,
    };
    image_tag(&compose, repository)
}

/// The tag a compose file's `image:` line gives a repository.
fn image_tag(compose: &str, repository: &str) -> Option<String> {
    compose.lines().find_map(|line| {
        let value = line.trim_start().strip_prefix("image:")?;
        let reference = value.trim().split(" #").next().unwrap_or("").trim();
        let (repo, tag) = ft_updater_api::split_reference(reference);
        (repo == repository).then_some(tag)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host that answers at length cannot be allowed to decide how much of
    /// this process it uses. The body is read with a ceiling and what runs
    /// past it is not a manifest.
    #[tokio::test]
    async fn a_body_that_runs_past_the_ceiling_is_not_read() {
        let http = reqwest::Client::new();
        let huge = "x".repeat(MOST + 1024);
        let answer = body("200 OK", &huge);
        let (source, serving) = host(Box::leak(answer.into_boxed_str())).await;
        match fetch(&http, &source).await.read {
            Read::Unreadable(why) => {
                assert!(why.contains("longer than"), "{why}");
                assert!(
                    why.contains(&MOST.to_string()),
                    "it says the ceiling: {why}"
                );
            }
            other => panic!("a body that size must not be read: {other:?}"),
        }
        serving.abort();

        // And the document itself, which is nowhere near it, still reads.
        let fine = body(
            "200 OK",
            r#"{"schema_version":1,"control_plane":{"beta":"0.56.0","general":"0.54.1"}}"#,
        );
        let (source, serving) = host(Box::leak(fine.into_boxed_str())).await;
        assert!(matches!(fetch(&http, &source).await.read, Read::Found(_)));
        serving.abort();
    }

    /// Absence is the bootstrap case the first time and a failure every time
    /// after. A manifest that has gone must not read as a fresh start, which
    /// is how an installation comes to accept an older pin from a document
    /// somebody destroyed.
    #[test]
    fn a_manifest_that_disappears_is_not_a_first_start() {
        let url = "http://example.test/channels.json";

        assert_eq!(
            classify(Read::Absent, false, url),
            Read::Absent,
            "nothing published yet, and nothing read before: a bootstrap"
        );

        match classify(Read::Absent, true, url) {
            Read::Vanished(why) => {
                assert!(why.contains("has gone"), "{why}");
                assert!(
                    why.contains("put back"),
                    "the sentence is the value of this state — it has to say what to do: {why}"
                );
            }
            other => panic!("a manifest that vanished is not absence: {other:?}"),
        }

        // It is its own answer, not a kind of unreadable: a fetch that failed
        // is worth retrying, and a document somebody destroyed is not.
        assert_eq!(
            Read::Vanished("x".into()).outcome(),
            ManifestOutcome::Vanished
        );
        assert_ne!(
            Read::Vanished("x".into()).outcome(),
            ManifestOutcome::Unreadable
        );

        // Everything else passes through whatever this installation has read
        // before — only absence changes meaning.
        for other in [
            Read::Unreadable("rate limited".into()),
            Read::Malformed("not this document".into()),
            Read::Incomplete("no version in it".into()),
        ] {
            assert_eq!(classify(other.clone(), true, url), other);
            assert_eq!(classify(other.clone(), false, url), other);
        }
    }

    /// A document that read and could not be written down is not acted on.
    /// Acting on it is what makes the restart case possible: the next process
    /// does not know a manifest was ever read, so the next 404 is a bootstrap.
    #[test]
    fn a_read_this_installation_cannot_record_is_not_acted_on() {
        let manifest = held();
        assert!(matches!(
            acted_on(Read::Found(manifest.clone()), Ok(())),
            Read::Found(_)
        ));

        match acted_on(
            Read::Found(manifest),
            Err(anyhow!("connection pool timed out")),
        ) {
            Read::Unreadable(why) => {
                assert!(why.contains("connection pool timed out"), "{why}");
                assert!(
                    why.contains("first start"),
                    "it says what it is avoiding: {why}"
                );
            }
            other => panic!("a read that could not be recorded must not be acted on: {other:?}"),
        }
    }

    /// Two reads can be in flight at once, and they do not come back in the
    /// order they left. A first-start `404` that lands after a document has
    /// already read is older news and classifies nothing.
    #[tokio::test]
    async fn a_read_that_lands_after_a_newer_one_is_discarded() {
        let manifests = Manifests::default();
        let slow = manifests.ticket().await;
        let quick = manifests.ticket().await;
        assert!(slow < quick, "tickets order by when a read set off");

        let manifest = held();
        manifests.store(quick, Read::Found(manifest.clone())).await;

        // The slow one comes back now, with the answer the world gave it
        // before the quick one landed.
        let kept = manifests.store(slow, Read::Absent).await;
        assert!(
            matches!(kept, Read::Found(_)),
            "the newer answer is what is kept: {kept:?}"
        );
        let seen = manifests.seen().await;
        assert!(
            matches!(seen.outcome, Some(Read::Found(_))),
            "and the cache is not disturbed by it: {:?}",
            seen.outcome
        );
        assert!(seen.held.is_some());

        // A read that set off later still lands, in either direction.
        let later = manifests.ticket().await;
        let gone = manifests
            .store(later, Read::Vanished("it has gone".into()))
            .await;
        assert!(matches!(gone, Read::Vanished(_)));
    }

    /// The database would not say. Refuse rather than bootstrap: being wrong
    /// this way costs a switch that is not offered.
    #[test]
    fn a_marker_that_cannot_be_read_counts_as_having_read_one() {
        assert!(never_read_one(&Ok(None)), "a fresh installation");
        assert!(!never_read_one(&Ok(Some("2026-11-18T00:00:00Z".into()))));
        assert!(
            !never_read_one(&Err(anyhow!("connection refused"))),
            "when you cannot tell, you have read one"
        );
    }

    /// **The persistence itself**, against a real database rather than a flag
    /// handed in. The process is replaced by the very upgrades this governs,
    /// so an answer that does not survive a restart is no answer: this is the
    /// test that fails if the write is ever removed.
    #[tokio::test]
    async fn that_a_manifest_read_survives_the_process() {
        let (db, _owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let accounts = crate::accounts::Accounts::new(db.pool().clone());

        assert!(
            a_first_start(&accounts).await,
            "a database nothing has written to is a first start"
        );

        assert!(
            !read_one_before(&accounts, false).await,
            "nothing held and nothing recorded"
        );
        assert!(
            read_one_before(&accounts, true).await,
            "a document held in this process counts on its own"
        );

        remember_a_read(&accounts).await.expect("the marker writes");

        // A second `Accounts` over the same database is what the control
        // plane has after it has been recreated: no memory, same rows.
        let restarted = crate::accounts::Accounts::new(db.pool().clone());
        assert!(
            !a_first_start(&restarted).await,
            "a manifest read before this process started, and the next absence is not a bootstrap"
        );
        // The live path's own question, with an empty cache — this is what a
        // recreated control plane asks, and the durable answer is the only
        // one it has.
        assert!(
            read_one_before(&restarted, false).await,
            "the marker is what survives the recreate, so it has to be consulted"
        );
        assert_eq!(
            classify(Read::Absent, read_one_before(&restarted, false).await, "u").outcome(),
            ManifestOutcome::Vanished,
            "and a 404 after a restart is a destroyed document, not a first start"
        );
    }

    /// `docs/channels.md`, binding on anything that reads this document: the
    /// writer leaves the copy it is replacing on the release, so a release
    /// carrying that and no manifest is an upload that failed part-way
    /// rather than a repository that has never promoted.
    ///
    /// Server-side proof, which is the only kind a control plane installed
    /// five minutes ago can have.
    #[tokio::test]
    async fn a_release_holding_the_previous_document_and_no_manifest_is_a_destroyed_one() {
        let http = reqwest::Client::new();
        let gone = Box::leak(body("404 Not Found", "Not Found").into_boxed_str());
        let kept = Box::leak(body("200 OK", r#"{"schema_version":1}"#).into_boxed_str());

        // The manifest is gone and the document it replaced is still there.
        let (source, serving) = host_pair(gone, kept).await;
        match fetch(&http, &source).await.read {
            Read::Vanished(why) => {
                assert!(why.contains(Source::PREVIOUS), "{why}");
                assert!(why.contains("re-upload"), "it says how to recover: {why}");
            }
            other => panic!("an upload that failed part-way is not absence: {other:?}"),
        }
        serving.abort();

        // Neither is there: nothing has ever been published here.
        let (source, serving) = host_pair(gone, gone).await;
        assert_eq!(
            fetch(&http, &source).await.read,
            Read::Absent,
            "a release with neither document is a first start"
        );
        serving.abort();

        // And whether it is beside it could not be told. Absence is the one
        // answer that lets an installation move, so it is not guessed at.
        let refused = Box::leak(body("500 Internal Server Error", "nope").into_boxed_str());
        let (source, serving) = host_pair(gone, refused).await;
        assert!(matches!(
            fetch(&http, &source).await.read,
            Read::Unreadable(_)
        ));
        serving.abort();

        assert_eq!(
            Source {
                url: "https://host/releases/download/channels/channels.json".into()
            }
            .previous(),
            "https://host/releases/download/channels/channels.previous.json"
        );
    }

    /// **A 200 is proof a document exists, whatever this process made of
    /// it.** A manifest that answered and would not parse, followed by a
    /// delete, is two ordinary checks — no race, no restart, no write
    /// failure — and it is the most reachable way to the bootstrap arm,
    /// because the writer replaces by deleting first.
    #[tokio::test]
    async fn a_document_that_will_not_parse_is_still_proof_one_exists() {
        let http = reqwest::Client::new();

        for (what, answer) in [
            ("malformed", body("200 OK", "<html>maintenance</html>")),
            (
                "incomplete",
                body("200 OK", r#"{"schema_version":1,"control_plane":{}}"#),
            ),
            ("oversized", body("200 OK", &"x".repeat(MOST + 16))),
        ] {
            let (source, serving) = host_pair(Box::leak(answer.into_boxed_str()), "").await;
            let fetched = fetch(&http, &source).await;
            assert!(
                fetched.served,
                "{what}: the host served a document, so one exists at that address"
            );
            assert!(
                !fetched.read.is_usable(),
                "{what}: and it is still not usable"
            );
            serving.abort();
        }

        // What is *not* proof: a 404, and a host that refused.
        let gone = Box::leak(body("404 Not Found", "x").into_boxed_str());
        let (source, serving) = host_pair(gone, gone).await;
        assert!(!fetch(&http, &source).await.served);
        serving.abort();

        let refused = Box::leak(body("503 Service Unavailable", "x").into_boxed_str());
        let (source, serving) = host_pair(refused, refused).await;
        assert!(
            !fetch(&http, &source).await.served,
            "a host that refused has not shown this installation a document"
        );
        serving.abort();
    }

    /// The sequence QA reproduced, end to end through the real pieces: a
    /// document that answered and would not parse, then a delete. Two
    /// ordinary checks, and the second one must not be a first start.
    #[tokio::test]
    async fn a_malformed_document_then_a_delete_is_not_a_first_start() {
        let (db, _owner) = crate::db::Db::open_for_test_owned().await.unwrap();
        let accounts = crate::accounts::Accounts::new(db.pool().clone());
        let http = reqwest::Client::new();

        // Check one: 200, and it does not parse.
        let junk = Box::leak(body("200 OK", "<html>half a document</html>").into_boxed_str());
        let (source, serving) = host_pair(junk, "").await;
        let first = fetch(&http, &source).await;
        assert!(matches!(first.read, Read::Malformed(_)));
        assert!(first.served);
        if first.served {
            remember_a_read(&accounts).await.unwrap();
        }
        serving.abort();

        // Check two: it has been deleted, and the previous document is not
        // there either — so the address alone says nothing.
        let gone = Box::leak(body("404 Not Found", "x").into_boxed_str());
        let (source, serving) = host_pair(gone, gone).await;
        let second = fetch(&http, &source).await;
        assert_eq!(
            second.read,
            Read::Absent,
            "the address says only that it is gone"
        );

        // What this installation remembers is what makes it a destruction.
        let before = read_one_before(&accounts, false).await;
        assert!(
            before,
            "a document answered here once, and that was written down"
        );
        assert_eq!(
            classify(second.read, before, &source.url).outcome(),
            ManifestOutcome::Vanished,
            "the document got worse and the trust must not go up"
        );
        serving.abort();
    }

    /// The one address this reader and the workflow that publishes have to    /// The one address this reader and the workflow that publishes have to
    /// agree on, written out so a change to either has to change a test that
    /// says why.
    ///
    /// Getting it wrong is silent: the read 404s, a 404 is correctly absence,
    /// and absence is the bootstrap case — so the installation would go on
    /// following the newest release while looking as though it had read a
    /// manifest and found nothing to move to.
    #[test]
    fn the_manifest_is_read_from_the_release_the_promotion_uploads_to() {
        assert!(
            Source::DEFAULT.ends_with("/releases/download/channels/channels.json"),
            "the release is `channels` and the asset is `channels.json`: {}",
            Source::DEFAULT
        );
        // And nothing needs it in `.env` — the channel is derived, not
        // configured, so the override exists for a test or a mirror.
        assert_eq!(Source::from_env().url, Source::DEFAULT);
        assert_eq!(Source::ENV, "FIRETOWER_CHANNEL_MANIFEST");
    }

    /// A host that answers one canned response and goes away.
    ///
    /// On a socket rather than against a mocked client: what separates a 404
    /// from a 429 from a connection that is refused is the network, and the
    /// three have to stay apart all the way out to the API.
    async fn host(answer: &'static str) -> (Source, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let serving = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut scratch = [0u8; 1024];
                let _ = socket.read(&mut scratch).await;
                let _ = socket.write_all(answer.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (
            Source {
                url: format!("http://127.0.0.1:{port}/channels.json"),
            },
            serving,
        )
    }

    /// A host that answers the manifest and the document beside it
    /// differently, which is the pair the writer leaves on a release.
    async fn host_pair(
        manifest: &'static str,
        previous: &'static str,
    ) -> (Source, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let serving = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut scratch = [0u8; 1024];
                let read = socket.read(&mut scratch).await.unwrap_or(0);
                let asked = String::from_utf8_lossy(&scratch[..read]).to_string();
                let answer = if asked.contains(Source::PREVIOUS) {
                    previous
                } else {
                    manifest
                };
                let _ = socket.write_all(answer.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (
            Source {
                url: format!("http://127.0.0.1:{port}/channels.json"),
            },
            serving,
        )
    }

    fn body(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    /// Every way the host can answer, and the outcome each has to produce.
    /// Without this, a 429 collapsing into "there is no document yet" would
    /// pass every other test in this file.
    #[tokio::test]
    async fn what_the_host_answers_decides_which_outcome_it_is() {
        let http = reqwest::Client::new();

        let absent = body("404 Not Found", "Not Found");
        let (source, serving) = host(Box::leak(absent.into_boxed_str())).await;
        assert_eq!(
            fetch(&http, &source).await.read,
            Read::Absent,
            "a 404 with nothing beside it is the bootstrap case and nothing else is"
        );
        serving.abort();

        let limited = body("429 Too Many Requests", "rate limited");
        let (source, serving) = host(Box::leak(limited.into_boxed_str())).await;
        match fetch(&http, &source).await.read {
            Read::Unreadable(why) => assert!(why.contains("429"), "{why}"),
            other => panic!("a rate limit is not {other:?}"),
        }
        serving.abort();

        let junk = body("200 OK", "<html>maintenance</html>");
        let (source, serving) = host(Box::leak(junk.into_boxed_str())).await;
        assert!(matches!(
            fetch(&http, &source).await.read,
            Read::Malformed(_)
        ));
        serving.abort();

        let good = body(
            "200 OK",
            r#"{"schema_version":1,"control_plane":{"beta":"0.56.0","general":"0.54.1"}}"#,
        );
        let (source, serving) = host(Box::leak(good.into_boxed_str())).await;
        let Read::Found(manifest) = fetch(&http, &source).await.read else {
            panic!("a document that reads is the answer");
        };
        assert_eq!(
            manifest.pin(Package::ControlPlane, Channel::General),
            Some("0.54.1")
        );
        serving.abort();

        // Nothing listening at all: a failure to reach it is not an absence
        // of anything.
        let nowhere = Source {
            url: "http://127.0.0.1:1/channels.json".into(),
        };
        assert!(matches!(
            fetch(&http, &nowhere).await.read,
            Read::Unreadable(_)
        ));
    }

    fn document() -> String {
        serde_json::json!({
            "schema_version": 1,
            "control_plane": {
                "beta": "0.56.0",
                "general": "0.54.1",
                "general_promoted_at": "2026-11-13T09:00:00Z"
            },
            "desktop": {
                "beta": "0.30.0",
                "general": "0.29.1",
                "general_promoted_at": "2026-11-01T09:00:00Z"
            }
        })
        .to_string()
    }

    #[test]
    fn a_document_that_reads_is_the_answer() {
        let Read::Found(manifest) = read(&document()) else {
            panic!("it reads");
        };
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(
            manifest.pin(Package::ControlPlane, Channel::Beta),
            Some("0.56.0")
        );
        assert_eq!(
            manifest.pin(Package::ControlPlane, Channel::General),
            Some("0.54.1")
        );
        assert_eq!(
            manifest.pin(Package::Desktop, Channel::General),
            Some("0.29.1")
        );
        assert_eq!(
            manifest
                .pins(Package::ControlPlane)
                .unwrap()
                .general_promoted_at
                .unwrap()
                .to_rfc3339(),
            "2026-11-13T09:00:00+00:00"
        );
    }

    /// The four that are not the answer, and the one of them that is a
    /// bootstrap. A read that goes wrong must never look like "general access
    /// is at version zero".
    #[test]
    fn the_ways_a_read_can_go_wrong_are_all_different() {
        // Not JSON at all, and JSON that is not this document.
        assert!(matches!(read("<html>429</html>"), Read::Malformed(_)));
        assert!(matches!(read("[]"), Read::Malformed(_)));
        assert!(matches!(
            read(r#"{"control_plane":{"beta":"1.0.0","general":"1.0.0"}}"#),
            Read::Malformed(why) if why.contains("schema_version")
        ));
        // This document, with no version in it.
        assert!(matches!(
            read(r#"{"schema_version":1,"control_plane":{"beta":"0.56.0"}}"#),
            Read::Incomplete(why) if why.contains("general")
        ));
        assert!(matches!(
            read(r#"{"schema_version":1,"desktop":{"beta":"0.1.0","general":"0.1.0"}}"#),
            Read::Incomplete(why) if why.contains("control_plane")
        ));
        // Present, and not a version.
        assert!(matches!(
            read(r#"{"schema_version":1,"control_plane":{"beta":"","general":"0.1.0"}}"#),
            Read::Malformed(_)
        ));

        for bad in [
            Read::Vanished("it has gone".into()),
            Read::Unreadable("rate limited".into()),
            Read::Malformed("not json".into()),
            Read::Incomplete("no version".into()),
        ] {
            assert!(!bad.is_usable(), "{bad:?} must move nothing");
            assert!(bad.problem().is_some(), "{bad:?} must say why");
        }
        // Absence is the bootstrap: not a problem, and still not usable as a
        // version.
        assert!(Read::Absent.problem().is_none());
        assert!(!Read::Absent.is_usable());
        assert_eq!(Read::Absent.outcome(), ManifestOutcome::Absent);
    }

    /// A later document may name packages or fields this build does not know.
    /// Refusing it would be an installation that stopped reading the one
    /// address it has.
    #[test]
    fn a_newer_document_is_still_read() {
        let newer = serde_json::json!({
            "schema_version": 2,
            "control_plane": {"beta": "0.56.0", "general": "0.54.1", "rolled_out_to": 7},
            "desktop": {"beta": "0.30.0", "general": "0.29.1"},
            "mobile": {"beta": "0.9.0", "general": "0.8.0"}
        })
        .to_string();
        let Read::Found(manifest) = read(&newer) else {
            panic!("it reads");
        };
        assert_eq!(manifest.schema_version, 2);
        assert_eq!(
            manifest.pin(Package::ControlPlane, Channel::Beta),
            Some("0.56.0")
        );
        // A package this build has no name for is left out rather than
        // refused.
        assert_eq!(manifest.packages.len(), 2);
    }

    /// A desktop-only document is readable by a control plane that only needs
    /// its own pins — but one missing the control plane's is not.
    #[test]
    fn a_package_this_build_does_not_need_may_be_absent() {
        let only_cp =
            r#"{"schema_version":1,"control_plane":{"beta":"0.56.0","general":"0.54.1"}}"#;
        let Read::Found(manifest) = read(only_cp) else {
            panic!("it reads");
        };
        assert!(manifest.pins(Package::Desktop).is_none());
    }

    #[test]
    fn a_tag_names_a_channel_or_it_does_not() {
        assert_eq!(Channel::of_tag("stable"), Some(Channel::General));
        assert_eq!(Channel::of_tag("beta"), Some(Channel::Beta));
        for not_a_channel in ["latest", "edge", "0.55", "0.55.0", "my-build", ""] {
            assert_eq!(Channel::of_tag(not_a_channel), None, "{not_a_channel}");
        }
        assert!(Channel::Beta.irreversible());
        assert!(!Channel::General.irreversible());
    }

    fn updater_status(reference: &str, api_version: u32) -> UpdaterStatus {
        UpdaterStatus {
            version: "0.55.0".into(),
            api_version,
            project: "firetower".into(),
            deploy_dir: "/opt/firetower".into(),
            config_files: vec!["/opt/firetower/firetower.yml".into()],
            docker_version: "28.0.0".into(),
            busy: None,
            images: if reference.is_empty() {
                Vec::new()
            } else {
                vec![
                    ft_updater_api::ServiceImage {
                        role: ImageRole::ControlPlane,
                        service: "firetower".into(),
                        reference: reference.into(),
                    },
                    ft_updater_api::ServiceImage {
                        role: ImageRole::Updater,
                        service: "updater".into(),
                        reference: reference.replace("firetower:", "firetower-updater:"),
                    },
                ]
            },
        }
    }

    /// Every reference the splitter has to survive, and what each means.
    #[test]
    fn the_channel_is_read_off_the_running_image() {
        let cases = [
            (
                "ghcr.io/firetower-cloud/firetower:stable",
                Channel::General,
                true,
                false,
            ),
            (
                "ghcr.io/firetower-cloud/firetower:beta",
                Channel::Beta,
                true,
                false,
            ),
            // Not channels: general access is the safe answer, and it is an
            // assumption rather than a reading.
            (
                "ghcr.io/firetower-cloud/firetower:latest",
                Channel::General,
                false,
                false,
            ),
            (
                "ghcr.io/firetower-cloud/firetower:edge",
                Channel::General,
                false,
                false,
            ),
            (
                "ghcr.io/firetower-cloud/firetower:0.55",
                Channel::General,
                false,
                false,
            ),
            // A bare repository is `:latest` to Docker, and a registry with a
            // port must not come apart at the wrong colon.
            ("firetower", Channel::General, false, false),
            ("localhost:5000/firetower:beta", Channel::Beta, true, false),
            // An exact version pins the container, which no upgrade can move.
            (
                "ghcr.io/firetower-cloud/firetower:0.55.0",
                Channel::General,
                false,
                true,
            ),
        ];
        for (reference, channel, recognised, pinned) in cases {
            let running = running_from(&updater_status(reference, 2));
            assert_eq!(running.channel, channel, "{reference}");
            assert_eq!(running.recognised, recognised, "{reference}");
            assert_eq!(running.pinned, pinned, "{reference}");
            assert_eq!(running.problem.is_none(), recognised, "{reference}");
            assert!(running.updater_can_switch);
        }

        assert_eq!(
            running_from(&updater_status("localhost:5000/firetower:beta", 2)).repository,
            Some("localhost:5000/firetower".into()),
            "the colon in a registry's port is not the tag's"
        );
    }

    /// An updater that cannot say what is running is a third answer, not a
    /// false one.
    #[test]
    fn an_updater_that_cannot_say_is_not_an_answer() {
        let running = running_from(&updater_status("", 1));
        assert_eq!(running.channel, Channel::General);
        assert!(!running.recognised);
        assert!(
            running.tag.is_none(),
            "no tag was read, so none is reported"
        );
        assert!(!running.updater_can_switch);
        assert!(running.problem.unwrap().contains("channel cannot be read"));
    }

    /// A document whose general access is what this build is, and whose beta
    /// is one minor ahead — so the rows mean what they would on a real
    /// installation whatever version the crate is at.
    fn held() -> Manifest {
        let here = version::current();
        let ahead = semver::Version::new(here.major, here.minor + 1, 0);
        Manifest {
            schema_version: 1,
            packages: vec![
                Pins {
                    package: Package::ControlPlane,
                    beta: ahead.to_string(),
                    general: here.to_string(),
                    general_promoted_at: Some(
                        DateTime::parse_from_rfc3339("2026-11-13T09:00:00Z")
                            .unwrap()
                            .with_timezone(&Utc),
                    ),
                },
                Pins {
                    package: Package::Desktop,
                    beta: "0.30.0".into(),
                    general: "0.29.1".into(),
                    general_promoted_at: None,
                },
            ],
        }
    }

    fn ahead() -> String {
        let here = version::current();
        semver::Version::new(here.major, here.minor + 1, 0).to_string()
    }

    fn on(reference: &str) -> Running {
        running_from(&updater_status(reference, 2))
    }

    fn row(offers: &[Offer], channel: Channel) -> Offer {
        offers
            .iter()
            .find(|o| o.channel == channel)
            .unwrap()
            .clone()
    }

    /// The reason this module exists. Each way a read can go wrong has to
    /// reach the screen as itself — a rate limit is not an empty document,
    /// and neither is "general access is at version zero".
    #[test]
    fn every_failed_read_refuses_and_says_which_one_it_was() {
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let cases = [
            (
                Read::Vanished("the channel manifest has gone from …; put it back".into()),
                ManifestOutcome::Vanished,
                "has gone",
            ),
            (
                Read::Unreadable("the channel manifest at … answered 429 Too Many Requests".into()),
                ManifestOutcome::Unreadable,
                "429",
            ),
            (
                Read::Malformed("the channel manifest is not JSON: expected value".into()),
                ManifestOutcome::Malformed,
                "not JSON",
            ),
            (
                Read::Incomplete(
                    "the channel manifest names no control_plane.general version".into(),
                ),
                ManifestOutcome::Incomplete,
                "names no control_plane.general",
            ),
        ];
        let mut seen: Vec<ManifestOutcome> = Vec::new();
        for (outcome, named, quoted) in cases {
            assert_eq!(outcome.outcome(), named);
            seen.push(named);
            let (reason, offers) = decide(&stable, &outcome, None, Ok(None), "https://x/y.json");
            let reason = reason.expect("a read that went wrong moves nothing");
            assert!(reason.contains(quoted), "{reason}");
            assert!(reason.contains("Nothing is being moved"), "{reason}");
            for channel in Channel::ALL {
                let row = row(&offers, channel);
                assert!(row.action.is_none(), "{channel:?} must offer nothing");
                assert!(
                    row.version.is_none(),
                    "{channel:?} must not name a version from a read that failed"
                );
            }
        }
        seen.dedup();
        assert_eq!(seen.len(), 4, "and the four are not interchangeable");
    }

    /// Absence is the bootstrap case: not a failure, and still not a version
    /// to move onto.
    #[test]
    fn absence_is_the_bootstrap_and_is_not_a_failure() {
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let (reason, offers) = decide(&stable, &Read::Absent, None, Ok(None), "https://x/y.json");
        let reason = reason.expect("there is nothing published to move onto");
        assert!(
            reason.contains("no channel manifest has been published yet"),
            "{reason}"
        );
        assert!(
            !reason.contains("Nothing is being moved"),
            "absence is not a failure to report as one: {reason}"
        );
        assert!(
            reason.contains("https://x/y.json"),
            "it says what it read: {reason}"
        );
        assert!(row(&offers, Channel::Beta).action.is_none());
        assert_ne!(Read::Absent.outcome(), ManifestOutcome::Unreadable);
    }

    /// The collapse this is written against: a document that read last time,
    /// a read that fails now. The figures stay — they are what was last
    /// published — and the act is refused, rather than the numbers vanishing
    /// or the failure passing for a bootstrap.
    #[test]
    fn a_read_that_fails_after_one_that_worked_changes_nothing() {
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let manifest = held();
        let (reason, offers) = decide(
            &stable,
            &Read::Unreadable("connection refused".into()),
            Some(&manifest),
            Ok(None),
            "https://x/y.json",
        );
        assert!(reason.unwrap().contains("connection refused"));
        let beta = row(&offers, Channel::Beta);
        assert_eq!(beta.version, Some(ahead()), "what it last held");
        assert!(beta.action.is_none(), "and nothing may be taken on it");
    }

    /// What a switch would move to comes from the row that was checked, and
    /// from nothing else. A row that could not be acted on when it was read
    /// cannot become one on the way to the plan.
    #[test]
    fn a_switch_takes_the_version_on_the_row_that_was_checked() {
        let manifest = held();
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let (_, offers) = decide(
            &stable,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Ok(None),
            "u",
        );
        let beta = row(&offers, Channel::Beta);
        assert_eq!(version_to_take(&beta).unwrap(), ahead());

        // The same row, as every failed read leaves it: no action, and so
        // nothing to take — whatever version is still being displayed beside
        // it from the document that last read.
        for bad in [
            Read::Absent,
            Read::Vanished("it has gone".into()),
            Read::Unreadable("rate limited".into()),
            Read::Malformed("not this document".into()),
            Read::Incomplete("no version in it".into()),
        ] {
            let (_, offers) = decide(&stable, &bad, Some(&manifest), Ok(None), "u");
            let beta = row(&offers, Channel::Beta);
            assert!(
                version_to_take(&beta).is_err(),
                "{bad:?} must not name a version to move to"
            );
        }

        // And a row whose action was refused for its own reason.
        let backwards = Offer {
            action: None,
            reason: Some("nothing is ever moved backwards".into()),
            ..row(&offers, Channel::Beta)
        };
        assert!(version_to_take(&backwards)
            .unwrap_err()
            .to_string()
            .contains("backwards"));
    }

    #[test]
    fn a_document_that_read_says_what_each_channel_holds_and_what_can_be_done() {
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let manifest = held();
        let (reason, offers) = decide(
            &stable,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Ok(None),
            "u",
        );
        assert!(reason.is_none(), "{reason:?}");

        let general = row(&offers, Channel::General);
        assert!(general.on);
        assert_eq!(general.version, Some(version::current().to_string()));
        assert!(
            general.since.is_some(),
            "promoted_at is what shows a stuck promotion"
        );
        assert!(general.action.is_none());
        assert_eq!(
            general.reason.as_deref(),
            Some("this Firetower is on general access")
        );
        assert!(!general.irreversible);

        let beta = row(&offers, Channel::Beta);
        assert!(!beta.on);
        assert_eq!(beta.version, Some(ahead()));
        assert_eq!(beta.action, Some(Act::Switch));
        assert!(
            beta.irreversible,
            "the one-way fact is on the row, before it is taken"
        );
        assert!(
            beta.since.is_none(),
            "the manifest records no beta timestamp"
        );
    }

    /// An installation on a tag that names no channel is treated as general
    /// access — and the press it needs is the one that makes the image line
    /// say so, not a switch to somewhere else.
    #[test]
    fn an_unrecognised_tag_is_offered_the_pin_that_fixes_it() {
        let latest = on("ghcr.io/firetower-cloud/firetower:latest");
        let manifest = held();
        let (reason, offers) = decide(
            &latest,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Ok(None),
            "u",
        );
        assert!(reason.is_none());
        let general = row(&offers, Channel::General);
        assert!(general.on, "it is being treated as general access");
        assert_eq!(general.action, Some(Act::Pin));
        assert_eq!(row(&offers, Channel::Beta).action, Some(Act::Switch));
    }

    #[test]
    fn an_installation_with_no_updater_is_general_access_and_cannot_switch() {
        for absent in [client::Absent::NotConfigured, client::Absent::NoToken] {
            let said = without_an_updater(&absent);
            assert!(said.contains("channel cannot be read"), "{said}");
            assert!(
                said.contains("General access is the assumption"),
                "the safe answer, said as an assumption: {said}"
            );
            // And it still says what to do about it, as the screen already
            // does for an upgrade it cannot carry out.
            assert!(said.contains(&absent.explain()), "{said}");

            let nothing = Running::unknown(said.clone());
            assert_eq!(nothing.channel, Channel::General);
            assert!(
                nothing.tag.is_none(),
                "nothing was read, so nothing is reported"
            );
            let manifest = held();
            let (reason, offers) = decide(
                &nothing,
                &Read::Found(manifest.clone()),
                Some(&manifest),
                Ok(None),
                "u",
            );
            assert_eq!(reason.as_deref(), Some(said.as_str()));
            assert!(offers.iter().all(|o| o.action.is_none()));
        }
    }

    /// An updater that cannot be told which image to fetch would pull the tag
    /// it is already on, which for a switch is the channel being left.
    #[test]
    fn an_updater_too_old_to_be_told_a_tag_refuses_the_switch() {
        let old = running_from(&updater_status(
            "ghcr.io/firetower-cloud/firetower:stable",
            1,
        ));
        let manifest = held();
        let (reason, _) = decide(
            &old,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Ok(None),
            "u",
        );
        assert!(
            reason
                .unwrap()
                .contains("too old to be told which image to fetch"),
            "it says what to do about it"
        );
    }

    #[test]
    fn a_pinned_image_line_is_refused_with_the_tag_to_use() {
        let pinned = on("ghcr.io/firetower-cloud/firetower:0.55.0");
        let manifest = held();
        let (reason, _) = decide(
            &pinned,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Ok(None),
            "u",
        );
        let reason = reason.unwrap();
        assert!(reason.contains(":0.55.0"), "{reason}");
        assert!(
            reason.contains(":stable") && reason.contains(":beta"),
            "{reason}"
        );
    }

    /// Not an empty list of runs. A query that would not answer is a reason
    /// to refuse, not permission to go ahead.
    #[test]
    fn a_database_that_will_not_answer_refuses_the_switch() {
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let manifest = held();
        let (reason, _) = decide(
            &stable,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Err("connection pool timed out".into()),
            "u",
        );
        assert!(reason.unwrap().contains("connection pool timed out"));

        let (reason, _) = decide(
            &stable,
            &Read::Found(manifest.clone()),
            Some(&manifest),
            Ok(Some("upg_1".into())),
            "u",
        );
        assert!(reason.unwrap().contains("upg_1"));
    }

    /// A control plane ahead of what a channel holds is not moved back to it.
    #[test]
    fn nothing_is_ever_moved_backwards() {
        let stable = on("ghcr.io/firetower-cloud/firetower:stable");
        let behind = Manifest {
            schema_version: 1,
            packages: vec![Pins {
                package: Package::ControlPlane,
                beta: "0.0.1".into(),
                general: "0.0.1".into(),
                general_promoted_at: None,
            }],
        };
        let (reason, offers) = decide(
            &stable,
            &Read::Found(behind.clone()),
            Some(&behind),
            Ok(None),
            "u",
        );
        assert!(reason.is_none(), "the installation itself is fine");
        let beta = row(&offers, Channel::Beta);
        assert!(beta.action.is_none());
        let why = beta.reason.unwrap();
        assert!(why.contains("Nothing is ever moved backwards"), "{why}");
        // And when it stops being refused. A refusal with no end to it reads
        // as a permanent membership, which is the thing this is not.
        assert!(
            why.contains("once beta reaches") && why.contains(&version::current().to_string()),
            "it has to say what lifts it: {why}"
        );
    }

    const COMPOSE: &str = "name: firetower\n\
                           services:\n  \
                             firetower:\n    \
                               image: ghcr.io/firetower-cloud/firetower:latest\n    \
                               restart: unless-stopped\n  \
                             updater:\n    \
                               image: ghcr.io/firetower-cloud/firetower-updater:latest  # the pair move together\n  \
                             postgres:\n    \
                               image: postgres:17-alpine\n";

    #[test]
    fn both_image_lines_move_and_nothing_else_does() {
        let repositories = vec![
            "ghcr.io/firetower-cloud/firetower".to_string(),
            "ghcr.io/firetower-cloud/firetower-updater".to_string(),
        ];
        let (rewritten, lines) = retag(COMPOSE, &repositories, "beta").unwrap();
        assert_eq!(lines.len(), 2, "both lines, and only both: {lines:?}");
        assert!(rewritten.contains("image: ghcr.io/firetower-cloud/firetower:beta\n"));
        assert!(rewritten.contains(
            "image: ghcr.io/firetower-cloud/firetower-updater:beta  # the pair move together"
        ));
        assert!(
            rewritten.contains("image: postgres:17-alpine"),
            "the database is not ours to move: {rewritten}"
        );
        // Indentation, comments and every other line survive: this is two
        // lines of a file somebody may have edited.
        assert_eq!(rewritten.lines().count(), COMPOSE.lines().count());
        assert!(rewritten.contains("    restart: unless-stopped"));

        // And the diff is those two lines and nothing else, which is what
        // the screen shows before anybody agrees to it.
        let diff = deploy::unified_diff(COMPOSE_FILE, COMPOSE, &rewritten);
        let changed: Vec<&str> = diff
            .lines()
            .filter(|l| {
                (l.starts_with('-') || l.starts_with('+'))
                    && !l.starts_with("---")
                    && !l.starts_with("+++")
            })
            .collect();
        assert_eq!(changed.len(), 4, "two lines, out and in: {diff}");
    }

    /// Somebody's own file, with the value quoted. Refusing it would send an
    /// operator to the machine for a line this can read perfectly well.
    #[test]
    fn a_quoted_image_line_keeps_its_quotes() {
        let quoted =
            "services:\n  firetower:\n    image: \"ghcr.io/firetower-cloud/firetower:latest\"\n";
        let (rewritten, lines) = retag(
            quoted,
            &["ghcr.io/firetower-cloud/firetower".to_string()],
            "beta",
        )
        .unwrap();
        assert_eq!(
            rewritten,
            "services:\n  firetower:\n    image: \"ghcr.io/firetower-cloud/firetower:beta\"\n"
        );
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].from, "ghcr.io/firetower-cloud/firetower:latest");
    }

    #[test]
    fn a_file_missing_one_of_the_two_is_refused_rather_than_half_moved() {
        let repositories = vec![
            "ghcr.io/firetower-cloud/firetower".to_string(),
            "ghcr.io/firetower-cloud/firetower-updater".to_string(),
        ];
        let without = COMPOSE
            .lines()
            .filter(|l| !l.contains("firetower-updater"))
            .collect::<Vec<_>>()
            .join("\n");
        let said = retag(&without, &repositories, "beta")
            .expect_err("one line is not both")
            .to_string();
        assert!(said.contains("firetower-updater"), "{said}");
    }

    /// Switching from an unrecognised tag has to move the line even though
    /// the channel it reports is already the one being pinned.
    #[test]
    fn pinning_from_an_unrecognised_tag_still_rewrites() {
        let repositories = vec![
            "ghcr.io/firetower-cloud/firetower".to_string(),
            "ghcr.io/firetower-cloud/firetower-updater".to_string(),
        ];
        let (rewritten, lines) = retag(COMPOSE, &repositories, tags::STABLE).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(rewritten.contains("firetower:stable"));
        assert_eq!(lines[0].from, "ghcr.io/firetower-cloud/firetower:latest");
        assert_eq!(lines[0].to, "ghcr.io/firetower-cloud/firetower:stable");
    }

    #[test]
    fn the_tag_to_fetch_is_the_one_the_file_names() {
        assert_eq!(
            image_tag(COMPOSE, "ghcr.io/firetower-cloud/firetower"),
            Some("latest".into())
        );
        let (moved, _) = retag(
            COMPOSE,
            &[
                "ghcr.io/firetower-cloud/firetower".to_string(),
                "ghcr.io/firetower-cloud/firetower-updater".to_string(),
            ],
            "beta",
        )
        .unwrap();
        assert_eq!(
            image_tag(&moved, "ghcr.io/firetower-cloud/firetower"),
            Some("beta".into())
        );
        assert_eq!(image_tag(COMPOSE, "ghcr.io/nobody/else"), None);
    }
}
