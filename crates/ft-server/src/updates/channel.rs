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
//! | [`Read::Unreadable`] | The read went wrong — a rate limit, a network failure, a status that is not a 404. |
//! | [`Read::Malformed`] | Something came back and it is not this document. |
//! | [`Read::Incomplete`] | It is this document and it names no version. |
//!
//! The last three **stop and change nothing**. A read that goes wrong must
//! never be allowed to look like "general access is at version zero" — the
//! rule the desktop release workflow writes out at length, inherited here by
//! every reader.

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

    /// Whether moving here can be undone.
    ///
    /// Beta cannot: migrations are forward-only, so the image can be put back
    /// and the database cannot. The only route back is restoring a dump.
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
    pub const DEFAULT: &'static str = "https://github.com/firetower-cloud/firetower/releases/download/channels-latest/channels.json";

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
    Unreadable(String),
    Malformed(String),
    Incomplete(String),
}

/// The same five, as the API names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ManifestOutcome {
    Absent,
    Found,
    Unreadable,
    Malformed,
    Incomplete,
}

impl Read {
    pub fn outcome(&self) -> ManifestOutcome {
        match self {
            Read::Absent => ManifestOutcome::Absent,
            Read::Found(_) => ManifestOutcome::Found,
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
            Read::Unreadable(why) | Read::Malformed(why) | Read::Incomplete(why) => Some(why),
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
pub async fn fetch(http: &reqwest::Client, source: &Source) -> Read {
    let response = match http.get(&source.url).send().await {
        Ok(r) => r,
        Err(e) => {
            return Read::Unreadable(format!("the channel manifest could not be fetched: {e}"))
        }
    };
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Read::Absent;
    }
    if !response.status().is_success() {
        return Read::Unreadable(format!(
            "the channel manifest at {} answered {}",
            source.url,
            response.status()
        ));
    }
    match response.text().await {
        Ok(body) => read(&body),
        Err(e) => Read::Unreadable(format!("the channel manifest could not be read: {e}")),
    }
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
}

/// What the cache holds, for a screen.
#[derive(Debug, Clone)]
pub struct Seen {
    pub outcome: Option<Read>,
    pub held: Option<Manifest>,
    pub read_at: Option<DateTime<Utc>>,
}

impl Manifests {
    /// Ask again, and remember. Returns what this attempt said.
    pub async fn refresh(&self, http: &reqwest::Client, source: &Source) -> Read {
        let found = fetch(http, source).await;
        let mut held = self.0.write().await;
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

    pub async fn seen(&self) -> Seen {
        let held = self.0.read().await;
        Seen {
            outcome: held.last.clone(),
            held: held.held.clone(),
            read_at: held.read_at,
        }
    }

    /// What is held, reading it once if nothing ever has. A process that was
    /// just recreated has an empty cache and a screen in front of somebody.
    pub async fn or_read(&self, http: &reqwest::Client, source: &Source) -> Seen {
        if self.0.read().await.last.is_none() {
            self.refresh(http, source).await;
        }
        self.seen().await
    }
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
    /// Whether taking it cannot be undone.
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
    /// Whether this cannot be undone. True for beta, always.
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
    let seen = updates
        .channel_manifest
        .or_read(&updates.http, &updates.channel_source)
        .await;

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
                                 {holds} {} holds. Nothing is ever moved backwards.",
                                channel.name()
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

/// The version a channel holds for the control plane, from a read that may be
/// acted on. `Err` carries the reason nothing may move.
pub async fn offered(updates: &Updates, channel: Channel) -> Result<String> {
    let seen = updates
        .channel_manifest
        .or_read(&updates.http, &updates.channel_source)
        .await;
    offered_in(&seen, channel)
}

/// The same, on what a read actually said.
///
/// Only [`Read::Found`] names a version. **Not the held document** — a copy
/// of what was published an hour ago is not what is published now, and the
/// act this answers is irreversible. Every other outcome is a refusal that
/// says which one it was.
pub fn offered_in(seen: &Seen, channel: Channel) -> Result<String> {
    match &seen.outcome {
        Some(Read::Found(manifest)) => manifest
            .pin(Package::ControlPlane, channel)
            .map(str::to_string)
            .ok_or_else(|| anyhow!("the channel manifest names no control plane version")),
        Some(other) => Err(anyhow!(
            "{}. Nothing is being moved.",
            other
                .problem()
                .unwrap_or("no channel manifest has been published yet")
        )),
        None => Err(anyhow!("the channel manifest has not been read")),
    }
}

// ── the switch ───────────────────────────────────────────────────────

/// What moving to `to` would write and what it would move onto.
///
/// Returns the view for the screen and the file writes the run carries. The
/// two come from one computation on purpose: what is shown as a diff is the
/// bytes that would be written.
pub async fn plan(
    state: &AppState,
    to: Channel,
    choices: &[super::FileChoice],
) -> Result<(ChannelSwitch, Vec<FileWrite>, super::UpgradePlan)> {
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

    let version = offered(updates, to).await?;
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
        if !repositories.iter().any(|r| *r == repository) {
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
            fetch(&http, &source).await,
            Read::Absent,
            "a 404 is the bootstrap case and nothing else is"
        );
        serving.abort();

        let limited = body("429 Too Many Requests", "rate limited");
        let (source, serving) = host(Box::leak(limited.into_boxed_str())).await;
        match fetch(&http, &source).await {
            Read::Unreadable(why) => assert!(why.contains("429"), "{why}"),
            other => panic!("a rate limit is not {other:?}"),
        }
        serving.abort();

        let junk = body("200 OK", "<html>maintenance</html>");
        let (source, serving) = host(Box::leak(junk.into_boxed_str())).await;
        assert!(matches!(fetch(&http, &source).await, Read::Malformed(_)));
        serving.abort();

        let good = body(
            "200 OK",
            r#"{"schema_version":1,"control_plane":{"beta":"0.56.0","general":"0.54.1"}}"#,
        );
        let (source, serving) = host(Box::leak(good.into_boxed_str())).await;
        let Read::Found(manifest) = fetch(&http, &source).await else {
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
        assert!(matches!(fetch(&http, &nowhere).await, Read::Unreadable(_)));
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
        assert_eq!(seen.len(), 3, "and the three are not interchangeable");
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

    /// What a switch would move to. A read that went wrong must not answer
    /// this from the copy it kept — the version it would name is the one it
    /// would then install, and that act cannot be undone.
    #[test]
    fn only_a_document_that_read_names_a_version_to_move_to() {
        let manifest = held();
        let ahead = ahead();

        let good = Seen {
            outcome: Some(Read::Found(manifest.clone())),
            held: Some(manifest.clone()),
            read_at: None,
        };
        assert_eq!(offered_in(&good, Channel::Beta).unwrap(), ahead);

        for bad in [
            Read::Absent,
            Read::Unreadable("rate limited".into()),
            Read::Malformed("not this document".into()),
            Read::Incomplete("no version in it".into()),
        ] {
            // The held copy is still there, which is the trap: answering
            // from it would look exactly like a successful read.
            let seen = Seen {
                outcome: Some(bad.clone()),
                held: Some(manifest.clone()),
                read_at: None,
            };
            let refused = offered_in(&seen, Channel::Beta)
                .expect_err(&format!("{bad:?} must not name a version"))
                .to_string();
            assert!(!refused.contains(&ahead), "{bad:?}: {refused}");
        }

        // And a cache nobody has filled is not an empty document either.
        let never = Seen {
            outcome: None,
            held: None,
            read_at: None,
        };
        assert!(offered_in(&never, Channel::Beta).is_err());
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
        assert!(
            beta.reason
                .unwrap()
                .contains("Nothing is ever moved backwards"),
            "and it says why"
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
