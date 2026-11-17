//! The import plan: what a dropped folder of profile bundles **would** do.
//!
//! A person drops `profiles/` on the Profiles screen, every `PROFILE.md` in it
//! arrives here, and what goes back is a classification of each bundle against
//! what this installation already holds. The apply is #356 and is not here.
//!
//! ## It writes nothing, ever
//!
//! The one property with no exceptions. Nothing in this module takes a `&mut`
//! anything, opens a transaction, or is handed a pool: [`plan`] is a pure
//! function over the drop and a read-only snapshot of what the asker can see
//! ([`Here`]), and the handler that calls it only ever `SELECT`s. That is why
//! the hard cases below are unit tests over a function rather than fixtures
//! over a schema.
//!
//! ## A plan is a presentation, never a capability
//!
//! #356 will re-derive every write from the submitted files and re-authorise
//! it, because **a plan that round-trips through a client can be modified** —
//! swapping in a machine, a subscription, a directory or a profile id the
//! caller holds no grant on. Four things keep the apply from being able to
//! trust one:
//!
//! * **The plan cannot be sent back.** Every type on the way out is
//!   `Serialize` and deliberately *not* `Deserialize`: there is no Rust type
//!   that can receive a [`ImportPlan`], so no endpoint can be written that accepts
//!   one without somebody adding the derive and noticing this paragraph.
//! * **It carries no handle.** No plan id, no token, no signature, nothing
//!   stored server-side. There is no plan to look up, so there is nothing to
//!   replay and nothing to tamper with between the two calls.
//! * **The apply's input is this endpoint's input.** [`ProfileDrop`] — the files, plus
//!   the person's answers to candidates — is the whole of it. The apply reads
//!   the files again and resolves again; it is handed no resolved ids.
//! * **It describes files, not operations.** An entry says *what this bundle
//!   is* against the library ("a rename of this row", "a candidate for that
//!   one"), keyed by the file it came from. It does not carry a list of writes
//!   with their targets filled in, because that is the shape whose obvious use
//!   is to execute it.
//!
//! The ids in a plan — [`PlanTarget::id`] and friends — are for display: a row the
//! review can draw, and the one value a client may legitimately echo back, as
//! the answer to a candidate. That answer is re-resolved against the asker's
//! own visible, writable set on the way in, here and again in the apply.
//!
//! ## Visibility filters before resolution, never after
//!
//! Every name a file writes is resolved **only across what the asker can
//! already see**, and the same goes for counting a collision and for proposing
//! a candidate. Resolving first and filtering afterwards would make the plan
//! distinguish "that does not exist" from "you may not have that", which is an
//! enumeration oracle for machines, subscriptions, directories and other
//! people's profiles. So the wording follows the rule: *no machine named
//! `mac-studio` is **available to you***, never *no such machine*.
//!
//! [`Here`] is that bound, made structural: it is built once per request from
//! the readers that already paste `access::filed_where` through their queries,
//! and this module can reach nothing else. Three things stay safe and are said
//! plainly, because withholding them tells the asker nothing they did not
//! supply or cannot already see:
//!
//! * echoing the value the file wrote, with its file and line;
//! * saying that an **already visible** directory needs Editor;
//! * saying that an **already visible** profile is not one they may write.
//!
//! It cuts the other way too: a profile somebody may write can name a machine
//! *they* cannot see, so a diff's "before" column renders an id that is not in
//! the snapshot as "a machine you cannot see" rather than as its name. An
//! overwrite diff is otherwise a way to read the fields of a row through a
//! shared profile.
//!
//! ## Identity is the folder name
//!
//! `profiles/<key>/PROFILE.md`, and the `<key>` is the profile's identity.
//! `name` is prose and may change freely, which is what makes a **rename** a
//! thing the plan can state rather than infer. Every row that exists today has
//! no key at all (`roles.author_key` is null everywhere — see
//! `migrations/server/20261117120000_profile_key.sql`), so a first import has
//! to fall back to the name, and where that is anything less than certain the
//! plan **proposes** the row and lets the person decide. Guessing an identity
//! is the one thing the matching rules exist to avoid.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use super::profile_md::{self, Field, Reading, Setting, Spelled, Spot};
use super::{Refused, Role};

// ── what the endpoint takes ─────────────────────────────────────────────

/// A drop: the files, and the answers to anything the last plan proposed.
///
/// **This is the apply's input too** (#356), which is the whole of why a plan
/// cannot be used as a capability: the second call is handed the same files and
/// the same answers, and does the resolution again. Nothing it needs comes back
/// through the client.
#[derive(Debug, Clone, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDrop {
    /// Every file in what was dropped, with the path it had inside the drop.
    pub files: Vec<DroppedFile>,
    /// What the person said about each candidate the previous plan proposed,
    /// keyed by the bundle's key. Empty on the first call.
    #[serde(default)]
    pub answers: Vec<CandidateAnswer>,
}

/// One file of a drop.
///
/// `text`, not base64 — which is how a skill's bundle travels, because one may
/// hold a font. A profile bundle is one UTF-8 markdown file; a `PROFILE.md`
/// that is not text is not a profile, and a client that cannot read it as text
/// has already found that out.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    /// Relative, inside the drop: `designer/PROFILE.md`. Never absolute and
    /// never climbing out.
    pub path: String,
    pub text: String,
}

/// What somebody decided about one candidate.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CandidateAnswer {
    /// The bundle this answers for — its folder name.
    pub key: String,
    pub answer: CandidateDecision,
}

/// The two answers a candidate takes.
///
/// There is no third and there is no default. An unanswered candidate blocks
/// the apply the way an unresolved name does, because a default answer is a
/// guess with a nicer name.
#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CandidateDecision {
    /// It is that profile: overwrite that row, and adopt the key onto it.
    ///
    /// `profile` is an id the client read off a [`PlanProposal`]. It is **not
    /// trusted**: it is looked up in the asker's own visible set and checked
    /// for Editor, here and again at apply. Any profile they could already
    /// overwrite through `PUT /api/v1/roles/{id}` is allowed, and nothing else.
    SameProfile { profile: String },
    /// It is a new profile: create it, and leave the proposed row alone.
    NewProfile,
}

// ── the limits, which are the endpoint's and not the client's ───────────

/// The most files one drop may hold.
///
/// A profile bundle is one file, so this is also the most profiles one import
/// can carry. `fstack` — the library this was designed against — holds five.
pub const MOST_FILES: usize = 200;

/// The most one file may be. The same figure `skills::BIGGEST_BODY` uses for a
/// `SKILL.md`, and for the same reason: it is the instructions that grow, and
/// the cap is deliberately far above any real one.
pub const BIGGEST_FILE: usize = 256 * 1024;

/// The most one drop may be, across every file in it.
pub const BIGGEST_DROP: usize = 8 * 1024 * 1024;

/// The deepest a path inside a drop may be, counted in segments.
///
/// `profiles/designer/PROFILE.md` is three. Somebody who drops a repository
/// rather than its `profiles/` folder is the case this bounds, and the refusal
/// says which file was too deep so they can see what they dropped.
pub const DEEPEST: usize = 8;

/// What this endpoint will take, said out loud so a client can refuse before it
/// asks rather than after.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub files: usize,
    pub file_bytes: usize,
    pub total_bytes: usize,
    pub depth: usize,
}

impl PlanLimits {
    fn ours() -> Self {
        Self {
            files: MOST_FILES,
            file_bytes: BIGGEST_FILE,
            total_bytes: BIGGEST_DROP,
            depth: DEEPEST,
        }
    }
}

// ── what the endpoint gives back ────────────────────────────────────────
//
// **Serialize only, every type below.** See the module doc: a plan that no
// type can receive is a plan no endpoint can be written to trust.

/// What a drop would do, bundle by bundle.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    /// Whether this drop could be applied as it stands.
    ///
    /// False while anything is blocked **or** any candidate is unanswered. It
    /// is a convenience for the review's footer and not a permission: the apply
    /// re-derives it, because this plan may be minutes old and a profile may
    /// have moved since.
    pub appliable: bool,
    /// Why it could not be, in sentences, when it could not be.
    pub why_not: Vec<String>,
    /// One entry per bundle, in path order.
    pub entries: Vec<PlanEntry>,
    /// Files in the drop that are part of no bundle — a README beside the
    /// folders, a `.DS_Store`. Named rather than dropped silently: somebody who
    /// expected one of these to be read should be able to see that it was not.
    pub ignored: Vec<String>,
    pub limits: PlanLimits,
}

/// One bundle, and what would happen to it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    /// The file, exactly as it was submitted. The entry's identity, and what
    /// every problem in it points at.
    pub path: String,
    /// The folder's name: this bundle's key, and the profile's identity.
    pub key: String,
    /// The `name` the file gives. Absent when the file did not parse, which is
    /// also when there are no field values to show.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub outcome: PlanOutcome,
    /// Worth saying and not worth stopping for. A warning never makes a plan
    /// unappliable.
    pub warnings: Vec<PlanProblem>,
}

/// The five things a bundle can be.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PlanOutcome {
    /// No profile in the library is this one. It would be created.
    New(PlanNew),
    /// Same key, different `name`. Stated as a rename rather than left for the
    /// screen to infer from a changed `name` row in the diff.
    Rename(PlanRename),
    /// Same key and same name.
    Overwrite(PlanOverwrite),
    /// Something the file names does not resolve, or a permission is missing.
    /// Nothing is ever silently degraded.
    Blocked(PlanBlocked),
    /// It may be an existing profile, and the importer must not decide.
    /// **Unanswered**, and an unanswered candidate makes the plan unappliable.
    Candidate(PlanCandidate),
}

/// A profile that would be created.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanNew {
    /// Where it would be filed: the directory the file names, or the person's
    /// own space when it names none.
    pub filed: String,
    /// Whether this is a create because somebody said so, rather than because
    /// nothing matched. Drawn differently: one is a finding, the other is an
    /// instruction being carried out.
    pub answered: bool,
}

/// A profile that would keep its key and change its name.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanRename {
    pub profile: PlanTarget,
    pub from: String,
    pub to: String,
    /// Every one of the sixteen fields, the same as an overwrite's.
    ///
    /// A rename is an overwrite whose `name` happens to differ, and the write
    /// behind it is the same whole-object update — so a rename row carrying no
    /// diff would hide the other fifteen fields changing underneath it, which
    /// is the silent failure this whole feature exists to remove. The `name`
    /// row in here is the rename, said once more where the diff can be read
    /// field by field.
    pub diff: Vec<FieldDiff>,
    /// Whether the key would be written onto a row that has none — see
    /// [`PlanOverwrite::adopts_key`].
    pub adopts_key: bool,
    pub answered: bool,
}

/// A profile that would be overwritten in place.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanOverwrite {
    pub profile: PlanTarget,
    /// All sixteen fields, with a reset marked as its own kind of change.
    pub diff: Vec<FieldDiff>,
    /// Whether this match came through the name and would write the key onto a
    /// row that has none.
    ///
    /// Worth drawing: it is the moment a row stops being matched by its name
    /// and starts being matched by its key, and it happens once per profile per
    /// installation.
    pub adopts_key: bool,
    /// Whether this is an overwrite because somebody answered a candidate.
    pub answered: bool,
}

/// A bundle that cannot be applied, and every reason why.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanBlocked {
    /// Every problem in the bundle, not the first — a file with three mistakes
    /// in it should take one round trip to fix, not three. Sorted by line.
    pub problems: Vec<PlanProblem>,
}

/// A bundle that may be an existing profile.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanCandidate {
    /// What it might be. Usually one.
    ///
    /// More than one is not a hypothetical: names are not unique, so two
    /// profiles the asker can see may both answer to the name in this file, and
    /// an importer that picked the first would be guessing on their behalf.
    pub proposals: Vec<PlanProposal>,
}

/// One existing profile a bundle may be, and why it was proposed.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanProposal {
    pub profile: PlanTarget,
    pub why: ProposalWhy,
    /// The same thing in a sentence, so a review can draw the reason without a
    /// table of its own and a client that has never heard of a new [`ProposalWhy`]
    /// still has something to show.
    pub says: String,
}

/// Why a profile was proposed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProposalWhy {
    /// The name matches exactly, and more than one row answers to it.
    Name,
    /// The name differs only by case or by surrounding whitespace.
    NearName,
    /// The words of the two names are the same words, or one name's are a
    /// subset of the other's — `QA` against a `qa-engineer/` folder.
    LikeName,
    /// The name matches, but that row already carries a key of its own and it
    /// is not this bundle's.
    OtherKey,
    /// Two profiles the asker can see carry this bundle's key.
    SameKey,
}

/// An existing profile, as a plan draws it.
///
/// **For display, and for one echo.** The id is how a review links to the row
/// and the only value a client may send back — as the answer to a candidate,
/// which is re-resolved and re-authorised on the way in. Nothing downstream
/// reads an id out of a plan to decide what to write.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanTarget {
    pub id: String,
    pub name: String,
    /// The key it carries, when it carries one. Null on every profile that
    /// predates the format, which is what makes the name fallback necessary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// Where it is filed, for a person to read: `u/kevin/designer_01m3qbzd`.
    pub path: String,
    /// Whether the asker may write it. A row they can see and cannot write
    /// blocks rather than being hidden — they already know it exists.
    pub may_write: bool,
}

/// One of the sixteen fields, as what it is now against what the file would
/// make it.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    /// The field, spelled the way a `PROFILE.md` spells it.
    pub field: String,
    pub change: FieldChange,
    /// What the profile is now, in the file's own vocabulary: names rather than
    /// ids, `here` rather than a column value. An id the asker cannot see
    /// renders as what it is — "a machine you cannot see" — and never as a
    /// name.
    pub before: String,
    /// What the file would make it, the same way.
    pub after: String,
    /// The four agent settings, when this is `settings`. They reset
    /// independently, so each carries its own [`FieldChange`].
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<SettingDiff>,
    /// The instructions, when this is `instructions`: a changed-line count that
    /// expands into a unified diff.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<BodyDiff>,
}

/// Which kind of change a field is.
///
/// **A reset is not an ordinary change and the screen draws it differently.**
/// It is stated here rather than left for a client to re-derive by comparing
/// against the defaults — that would be the server's knowledge of what an
/// absent key means leaking into every client that has to draw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub enum FieldChange {
    /// The file says what the profile already is.
    Unchanged,
    /// The file says something else. Includes a file that spells a field's
    /// default on purpose: somebody who writes the default has said something,
    /// and it is not a reset.
    Changed,
    /// The key is **absent from the file**, so the value returns to its
    /// documented default. A deleted line, which is a real change and the one
    /// that surprises people.
    Reset,
}

/// One agent setting under `settings`.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct SettingDiff {
    /// `model`, `effort`, `mode`, `sandbox`.
    pub setting: String,
    pub change: FieldChange,
    /// What it is now — **the resulting value**, named, rather than the words
    /// "the engine's default": a profile with an engine pinned resolves one, so
    /// a reset can say what will actually run.
    pub before: String,
    pub after: String,
}

/// The instructions, as a count and a diff.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BodyDiff {
    /// Lines added plus lines removed: the one number a row can carry.
    pub changed_lines: usize,
    pub added: usize,
    pub removed: usize,
    /// The unified diff the count expands into. Empty when nothing changed.
    pub unified: String,
}

/// Something wrong, or worth saying, about one place in one file.
///
/// **`path` and `line` are not optional**, which is the codec's rule
/// ([`profile_md::Problem`]) and holds for everything this module adds to it:
/// an error that cannot say which of twelve files it came from is not
/// actionable, and the review draws these beside the line they are about.
///
/// A type of its own rather than the codec's, so the wire contract is the API's
/// to keep stable while the codec stays free of serde.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanProblem {
    pub path: String,
    /// The line in the file, counting from 1.
    pub line: usize,
    /// The field at fault, written the way the file writes it — `placement`,
    /// `skills[2]`, `settings.model`. Absent for something about the file as a
    /// whole.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// What is wrong and what to do about it.
    pub says: String,
}

impl PlanProblem {
    fn at(path: &str, line: usize, key: Option<String>, says: impl Into<String>) -> Self {
        Self {
            path: path.to_string(),
            line,
            key,
            says: says.into(),
        }
    }
}

impl From<profile_md::Problem> for PlanProblem {
    fn from(p: profile_md::Problem) -> Self {
        Self {
            path: p.path,
            line: p.line,
            key: p.key,
            says: p.says,
        }
    }
}

// ── what the asker can see ──────────────────────────────────────────────

/// The library, the fleet and the subscriptions **as this person can see
/// them** — the whole of what resolution is allowed to know.
///
/// Built once per request by the handler, out of the readers that already paste
/// `access::filed_where` through their queries. Nothing in this module can
/// reach past it, which is what makes "visibility filters before resolution" a
/// property of the arrangement rather than a rule each lookup has to remember.
#[derive(Debug, Clone, Default)]
pub struct Here {
    pub me: Who,
    /// Every profile they may see, at Viewer or better, carrying `may_write`.
    pub profiles: Vec<Role>,
    /// Every machine they may run on, by name.
    pub machines: Vec<Named>,
    /// Every subscription they could actually spend.
    pub accounts: Vec<Subscription>,
    /// Every directory they may at least look in.
    pub directories: Vec<Dir>,
    /// Every skill they may reach, at Viewer or better.
    pub skills: Vec<SkillHere>,
}

/// Who is asking.
#[derive(Debug, Clone, Default)]
pub struct Who {
    pub id: String,
    /// Their path slug, which is where a new profile would be filed.
    pub slug: String,
}

/// Something with an id and a name, which is all resolution needs.
#[derive(Debug, Clone)]
pub struct Named {
    pub id: String,
    pub name: String,
}

/// One subscription, and the engine it authenticates.
#[derive(Debug, Clone)]
pub struct Subscription {
    pub id: String,
    pub name: String,
    /// `ClaudeCode`, `Codex` — the engine's own spelling.
    pub engine: String,
}

/// One directory, and what this person may do in it.
#[derive(Debug, Clone)]
pub struct Dir {
    pub id: String,
    pub name: String,
    /// The label in a path. A file may qualify by either.
    pub slug: String,
    /// Whether they may file something into it. Editor, which is what a create
    /// takes.
    pub may_write: bool,
}

/// One skill, and where it lives.
#[derive(Debug, Clone)]
pub struct SkillHere {
    pub id: String,
    pub name: String,
    /// `u/kevin/rust_review`, `d/firetower/dataviz`.
    pub path: String,
}

impl SkillHere {
    /// The directory it is filed in, when it is in one.
    fn directory(&self) -> Option<&str> {
        self.path
            .strip_prefix("d/")
            .and_then(|r| r.split('/').next())
    }

    /// How a file would have to write this one to name it unambiguously.
    fn qualified(&self) -> String {
        match self.directory() {
            Some(d) => format!("{d}/{}", self.name),
            None => self.name.clone(),
        }
    }
}

// ── reading a bundle ────────────────────────────────────────────────────

/// Read one bundle, as the codec reads one.
///
/// Parsing is **not** repeated here. `profile_md::read` hands back the profile
/// with every absent key already resolved to its documented default, plus
/// [`Spelled`] — which keys the file actually wrote, and where. The plan needs
/// both halves and neither is derivable from the other:
///
/// * a **reset** is a key the file does not have, and a key that spells its own
///   default is an ordinary value, because somebody who writes the default on
///   purpose has said something;
/// * every problem carries `{path, line}`, and a resolution failure is about
///   the line that named the thing — down to `skills[2]`, which [`Spot::Entry`]
///   addresses and the line of `skills:` could not.
fn read(path: &str, key: &str, text: &str) -> Result<Reading, Vec<PlanProblem>> {
    profile_md::read(std::path::Path::new(path), key, text)
        .map_err(|found| found.into_iter().map(PlanProblem::from).collect())
}

/// Where to point at one place in a file.
///
/// The codec answers for anything the file wrote. The fallbacks are for the
/// places it did not: an entry of a list the file wrote in flow style
/// (`skills: [a, b]`) has no line of its own, and the honest answer is the key
/// above it — then the first line of the frontmatter, which is where a key
/// nobody wrote is missing from.
fn at(spelled: &Spelled, spot: Spot) -> usize {
    let under = match spot {
        Spot::Field(_) => None,
        Spot::Entry(field, _) => Some(Spot::Field(field)),
        Spot::Setting(_) => Some(Spot::Field(Field::Settings)),
    };
    spelled
        .line(spot)
        .or_else(|| under.and_then(|up| spelled.line(up)))
        .unwrap_or_else(|| spelled.fields_begin())
}

// ── the plan ────────────────────────────────────────────────────────────

/// What this drop would do, against what this person can see.
///
/// Pure, and the only entry point. [`Refused`] is the whole drop refused — a
/// bound, named — and is the one answer that is not a plan: there is nothing to
/// classify when the input is larger than the endpoint takes.
pub fn plan(drop: &ProfileDrop, here: &Here) -> Result<ImportPlan, Refused> {
    check(drop)?;

    let (bundles, ignored) = bundles_in(drop);
    let mut entries: Vec<PlanEntry> = Vec::new();
    for bundle in &bundles {
        entries.push(classify(bundle, &bundles, drop, here));
    }
    same_target_blocks(&mut entries);
    same_name_warnings(&mut entries);

    let why_not = why_not(&entries);
    Ok(ImportPlan {
        appliable: why_not.is_empty() && !entries.is_empty(),
        why_not,
        entries,
        ignored,
        limits: PlanLimits::ours(),
    })
}

/// The bounds. Every one names the limit it is, because a refusal that does not
/// leaves somebody guessing which half of their drop to cut.
fn check(drop: &ProfileDrop) -> Result<(), Refused> {
    if drop.files.len() > MOST_FILES {
        return Err(Refused(format!(
            "this drop holds {} files and an import takes at most {MOST_FILES} — drop fewer \
             folders at once",
            drop.files.len()
        )));
    }
    let mut total = 0usize;
    for file in &drop.files {
        if file.path.trim().is_empty() {
            return Err(Refused("a file in this drop has no name".into()));
        }
        if file.path.starts_with('/') || file.path.contains('\\') || file.path.contains("..") {
            return Err(Refused(format!(
                "`{}` is not a path inside the folder that was dropped",
                briefly(&file.path)
            )));
        }
        if file.path.len() > crate::skills::LONGEST_PATH {
            return Err(Refused(format!(
                "`{}` is {} bytes long, and a path inside a drop is at most {} — the same cap a \
                 skill's bundle has",
                briefly(&file.path),
                file.path.len(),
                crate::skills::LONGEST_PATH
            )));
        }
        let depth = file.path.split('/').filter(|s| !s.is_empty()).count();
        if depth > DEEPEST {
            return Err(Refused(format!(
                "`{}` is {depth} folders deep and an import reads at most {DEEPEST} — drop the \
                 folder that holds the bundles rather than the repository around it",
                briefly(&file.path)
            )));
        }
        if file.text.len() > BIGGEST_FILE {
            return Err(Refused(format!(
                "`{}` is {} KB, and a file in a drop is at most {} KB",
                briefly(&file.path),
                file.text.len() / 1024,
                BIGGEST_FILE / 1024
            )));
        }
        total += file.text.len();
        if total > BIGGEST_DROP {
            return Err(Refused(format!(
                "this drop is over the {} MB an import takes — drop fewer folders at once",
                BIGGEST_DROP / 1024 / 1024
            )));
        }
    }
    Ok(())
}

/// The file a bundle is.
const PROFILE_MD: &str = "PROFILE.md";

/// One bundle of a drop, before anything has been decided about it.
struct Bundle {
    path: String,
    /// The folder's name, which is the key. Empty when the file is not in a
    /// folder, which is itself a problem.
    key: String,
    said: Result<Reading, Vec<PlanProblem>>,
}

/// Which files are bundles, and which are not part of one.
///
/// Spelled exactly `PROFILE.md`. A file whose name only folds onto that gets a
/// problem of its own rather than being ignored: `profile.md` is somebody's
/// bundle that would otherwise vanish out of the plan without a word, and the
/// folder on a filesystem that ignores case is the same file.
fn bundles_in(drop: &ProfileDrop) -> (Vec<Bundle>, Vec<String>) {
    let mut bundles = Vec::new();
    let mut ignored = Vec::new();
    for file in &drop.files {
        let segments: Vec<&str> = file.path.split('/').filter(|s| !s.is_empty()).collect();
        let Some(name) = segments.last() else {
            continue;
        };
        if *name != PROFILE_MD {
            if name.eq_ignore_ascii_case(PROFILE_MD) {
                bundles.push(Bundle {
                    path: file.path.clone(),
                    key: segments
                        .len()
                        .checked_sub(2)
                        .map(|i| segments[i].to_string())
                        .unwrap_or_default(),
                    said: Err(vec![PlanProblem::at(
                        &file.path,
                        1,
                        None,
                        format!(
                            "a bundle's file is spelled `{PROFILE_MD}`, in capitals. Rename \
                             `{name}` and drop the folder again."
                        ),
                    )]),
                });
            } else {
                ignored.push(file.path.clone());
            }
            continue;
        }
        let key = segments
            .len()
            .checked_sub(2)
            .map(|i| segments[i].to_string())
            .unwrap_or_default();
        let said = if key.is_empty() {
            Err(vec![PlanProblem::at(
                &file.path,
                1,
                None,
                format!(
                    "this `{PROFILE_MD}` is not inside a folder, and the folder's name is the \
                     profile's key. Put it in one named for the profile."
                ),
            )])
        } else {
            read(&file.path, &key, &file.text)
        };
        bundles.push(Bundle {
            path: file.path.clone(),
            key,
            said,
        });
    }
    bundles.sort_by(|a, b| a.path.cmp(&b.path));
    ignored.sort();
    (bundles, ignored)
}

/// One bundle, classified.
fn classify(
    bundle: &Bundle,
    drop_bundles: &[Bundle],
    drop: &ProfileDrop,
    here: &Here,
) -> PlanEntry {
    let said = match &bundle.said {
        // A file that does not parse reports its error and **no field values**.
        // It has none to report, and expanding one into a diff would mean
        // inventing them.
        Err(problems) => {
            return PlanEntry {
                path: bundle.path.clone(),
                key: bundle.key.clone(),
                name: None,
                outcome: PlanOutcome::Blocked(PlanBlocked {
                    problems: sorted(problems.clone()),
                }),
                warnings: Vec::new(),
            }
        }
        Ok(said) => said,
    };

    let mut problems: Vec<PlanProblem> = Vec::new();

    // Two bundles sharing a key are blocked, not impossible. A filesystem
    // folder cannot hold two folders of one name; an archive and a direct API
    // call both can.
    let twins: Vec<&Bundle> = drop_bundles
        .iter()
        .filter(|b| b.key == bundle.key && b.path != bundle.path)
        .collect();
    for twin in &twins {
        problems.push(PlanProblem::at(
            &bundle.path,
            1,
            None,
            format!(
                "`{}` is also a bundle for `{}` in this drop. One key is one profile, so neither \
                 can be applied until one of them is renamed or removed.",
                briefly(&twin.path),
                bundle.key
            ),
        ));
    }

    let matched = match_one(bundle, said, drop, here, &mut problems);
    problems.extend(resolve(bundle, said, drop_bundles, here, &matched));

    if !problems.is_empty() {
        return PlanEntry {
            path: bundle.path.clone(),
            key: bundle.key.clone(),
            name: Some(said.profile.name.clone()),
            outcome: PlanOutcome::Blocked(PlanBlocked {
                problems: sorted(problems),
            }),
            warnings: Vec::new(),
        };
    }

    let outcome = match matched {
        Matched::Create { answered } => PlanOutcome::New(PlanNew {
            filed: filed_where(said, here),
            answered,
        }),
        Matched::Propose(proposals) => PlanOutcome::Candidate(PlanCandidate { proposals }),
        Matched::Hit {
            row,
            adopts_key,
            answered,
        } => {
            let diff = diff(said, row, here);
            if row.name.trim() == said.profile.name {
                PlanOutcome::Overwrite(PlanOverwrite {
                    profile: target(row),
                    diff,
                    adopts_key,
                    answered,
                })
            } else {
                PlanOutcome::Rename(PlanRename {
                    profile: target(row),
                    from: row.name.clone(),
                    to: said.profile.name.clone(),
                    diff,
                    adopts_key,
                    answered,
                })
            }
        }
    };

    PlanEntry {
        path: bundle.path.clone(),
        key: bundle.key.clone(),
        name: Some(said.profile.name.clone()),
        outcome,
        warnings: Vec::new(),
    }
}

/// What a bundle turned out to be, before the rest of the file is resolved.
enum Matched<'a> {
    Create {
        answered: bool,
    },
    Hit {
        row: &'a Role,
        adopts_key: bool,
        answered: bool,
    },
    Propose(Vec<PlanProposal>),
}

/// Which existing profile, if any, this bundle is.
///
/// **Across every profile the asker can see**, not only the destination the
/// file names. The row to overwrite is wherever it already is — `directory` is
/// honoured when a profile is *created* and a move is a sharing operation
/// (`NewRole::directory`), so narrowing the search to the destination would
/// make the first import of a shared library create a duplicate of every
/// profile in it beside the originals. That is the failure this plan exists to
/// prevent, and the specification's "the directory picks the one scope to look
/// in" predates the key being the identity.
fn match_one<'a>(
    bundle: &Bundle,
    said: &Reading,
    drop: &ProfileDrop,
    here: &'a Here,
    problems: &mut Vec<PlanProblem>,
) -> Matched<'a> {
    let name = said.profile.name.trim();

    // An answer decides, and is re-authorised rather than trusted.
    if let Some(answer) = drop.answers.iter().find(|a| a.key == bundle.key) {
        match &answer.answer {
            CandidateDecision::NewProfile => return Matched::Create { answered: true },
            CandidateDecision::SameProfile { profile } => {
                match here.profiles.iter().find(|r| r.id == *profile) {
                    Some(row) => {
                        return Matched::Hit {
                            row,
                            adopts_key: row.key.is_none(),
                            answered: true,
                        }
                    }
                    None => {
                        problems.push(PlanProblem::at(
                            &bundle.path,
                            1,
                            None,
                            "the profile that answer names is not one available to you. Plan the \
                             drop again and choose from what it proposes."
                                .to_string(),
                        ));
                        return Matched::Create { answered: true };
                    }
                }
            }
        }
    }

    // The key is the identity. Unique within a parent path, so two of them is
    // two directories — which the importer must not choose between.
    let by_key: Vec<&Role> = here
        .profiles
        .iter()
        .filter(|r| r.key.as_deref() == Some(bundle.key.as_str()))
        .collect();
    match by_key.as_slice() {
        [row] => {
            return Matched::Hit {
                row,
                adopts_key: false,
                answered: false,
            }
        }
        [] => {}
        many => {
            return Matched::Propose(
                many.iter()
                    .map(|row| proposal(row, ProposalWhy::SameKey, &bundle.key))
                    .collect(),
            )
        }
    }

    // The fallback: the name, against rows that have no key of their own. A row
    // that already carries a *different* key is not matched by its name — it
    // has said what it is — but it is still worth proposing, because a renamed
    // folder is indistinguishable from a new profile and the person is the only
    // one who knows which it is.
    let mut exact: Vec<&Role> = Vec::new();
    let mut proposals: Vec<PlanProposal> = Vec::new();
    let mut near = 0usize;
    let ours = tokens(name)
        .into_iter()
        .chain(tokens(&bundle.key))
        .collect::<BTreeSet<_>>();
    for row in &here.profiles {
        let theirs = row.name.trim();
        match &row.key {
            None if theirs == name => exact.push(row),
            None if folded(theirs) == folded(name) => {
                near += 1;
                proposals.push(proposal(row, ProposalWhy::NearName, name));
            }
            None if resembles(&tokens(theirs), &ours) => {
                proposals.push(proposal(row, ProposalWhy::LikeName, name))
            }
            Some(key) if key != &bundle.key && folded(theirs) == folded(name) => {
                proposals.push(proposal(row, ProposalWhy::OtherKey, name))
            }
            _ => {}
        }
    }

    // One row of exactly this name, with nothing else answering to it: the
    // fallback is certain, and it adopts the key.
    if exact.len() == 1 && near == 0 && !proposals.iter().any(|p| p.why == ProposalWhy::OtherKey) {
        return Matched::Hit {
            row: exact[0],
            adopts_key: true,
            answered: false,
        };
    }
    for row in exact {
        proposals.insert(0, proposal(row, ProposalWhy::Name, name));
    }
    if proposals.is_empty() {
        Matched::Create { answered: false }
    } else {
        Matched::Propose(proposals)
    }
}

fn proposal(row: &Role, why: ProposalWhy, wrote: &str) -> PlanProposal {
    let name = row.name.trim();
    let says = match why {
        ProposalWhy::Name => format!(
            "`{name}` is already in your library under this name and carries no key of its own, \
             and so does another profile — so which of them this folder is, is yours to say."
        ),
        ProposalWhy::NearName => format!(
            "`{name}` differs from `{wrote}` only in capitals or spacing, which is usually the \
             same profile and is not always."
        ),
        ProposalWhy::LikeName => format!(
            "`{name}` is made of the same words as this bundle, so it may be the profile this \
             folder was written for."
        ),
        ProposalWhy::OtherKey => format!(
            "`{name}` has this name already, under the key `{}` — so this folder is either a \
             rename of it or a second profile.",
            row.key.as_deref().unwrap_or_default()
        ),
        ProposalWhy::SameKey => format!(
            "`{name}` carries the key `{wrote}`, and so does another profile you can see — so \
             which of them this folder is, is yours to say."
        ),
    };
    PlanProposal {
        profile: target(row),
        why,
        says,
    }
}

fn target(row: &Role) -> PlanTarget {
    PlanTarget {
        id: row.id.clone(),
        name: row.name.clone(),
        key: row.key.clone(),
        path: row.path.clone(),
        may_write: row.may_write,
    }
}

/// Two names that differ only by case or by surrounding whitespace.
fn folded(name: &str) -> String {
    name.trim().to_lowercase()
}

/// The words of a name, lowercased, with punctuation and separators gone.
fn tokens(name: &str) -> BTreeSet<String> {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Whether one name's words resemble another's enough to be worth proposing.
///
/// Containment in either direction **and the same first word**. Containment
/// alone proposes `Engineer` for a `qa-engineer/` folder, which is noise; the
/// anchor keeps the real case — `QA` against `qa-engineer` — and drops that
/// one. It only ever proposes, so a false one costs a click and a missed one
/// costs a duplicate profile.
fn resembles(theirs: &BTreeSet<String>, ours: &BTreeSet<String>) -> bool {
    if theirs.is_empty() || ours.is_empty() || theirs == ours {
        return false;
    }
    let (first, second) = (theirs.iter().next(), ours.iter().next());
    first == second && (theirs.is_subset(ours) || ours.is_subset(theirs))
}

/// Where a new profile would be filed, for a person to read.
fn filed_where(said: &Reading, here: &Here) -> String {
    match said.profile.directory.as_deref() {
        None => "your own space".to_string(),
        Some(name) => match directory(name, here) {
            Some(dir) => dir.name.clone(),
            None => name.to_string(),
        },
    }
}

/// A directory the asker can see, by the name or the slug a file wrote.
fn directory<'a>(wrote: &str, here: &'a Here) -> Option<&'a Dir> {
    let wanted = folded(wrote);
    here.directories
        .iter()
        .find(|d| folded(&d.name) == wanted || d.slug == wanted)
}

// ── resolution ──────────────────────────────────────────────────────────

/// Everything the file names, resolved against what the asker can see — plus
/// the drop itself, for the references that point inside it.
fn resolve(
    bundle: &Bundle,
    said: &Reading,
    drop_bundles: &[Bundle],
    here: &Here,
    matched: &Matched,
) -> Vec<PlanProblem> {
    let p = &bundle.path;
    let mut out: Vec<PlanProblem> = Vec::new();
    let profile = &said.profile;

    // Where the profile itself is filed.
    match (profile.directory.as_deref(), matched) {
        (Some(wrote), Matched::Create { .. }) => match directory(wrote, here) {
            None => out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Field(Field::Directory)),
                Some(Field::Directory.spelling().into()),
                format!(
                    "no directory named `{wrote}` is available to you. Write one you can file \
                     things in, or remove the line to keep this profile in your own space."
                ),
            )),
            // Visible and not writable is said out loud: they already know the
            // directory exists, so the only new fact is the grant they need —
            // and finding that out at apply would make an accepted plan one
            // that does not apply.
            Some(dir) if !dir.may_write => out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Field(Field::Directory)),
                Some(Field::Directory.spelling().into()),
                format!(
                    "you can look in `{}` but not file anything there. Ask for Editor on it, or \
                     remove the line to keep this profile in your own space.",
                    dir.name
                ),
            )),
            Some(_) => {}
        },
        // An existing profile is overwritten where it already is: `directory`
        // is honoured at creation and a move is a sharing operation, so a file
        // naming a different one is making a claim the import cannot honour.
        // Said rather than silently ignored, which is the whole rule.
        (Some(wrote), Matched::Hit { row, .. }) => {
            let filed = row.path.rsplit_once('/').map(|(up, _)| up).unwrap_or("");
            let theirs = row
                .path
                .split('/')
                .nth(1)
                .filter(|_| row.path.starts_with("d/"));
            let agrees = match theirs {
                Some(slug) => directory(wrote, here).is_some_and(|d| d.slug == slug),
                None => false,
            };
            if !agrees {
                out.push(PlanProblem::at(
                    p,
                    at(&said.spelled, Spot::Field(Field::Directory)),
                    Some(Field::Directory.spelling().into()),
                    format!(
                        "this bundle is `{}`, which is already filed at `{filed}`. An import \
                         cannot move a profile — move it with sharing, or write the directory it \
                         is in.",
                        row.name
                    ),
                ));
            }
        }
        _ => {}
    }

    // The machine its own workspace runs on.
    if let Some(wrote) = profile.machine.as_deref() {
        if resolve_named(wrote, &here.machines).is_none() {
            out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Field(Field::Machine)),
                Some(Field::Machine.spelling().into()),
                format!(
                    "no machine named `{wrote}` is available to you. Write one of yours, or `~` \
                     to leave the machine to whichever lead delegates to it."
                ),
            ));
        }
    }

    // The subscription its agent runs on.
    if let Some(wrote) = profile.account.as_deref() {
        match (&profile.engine, resolve_account(wrote, &here.accounts)) {
            // A subscription authenticates one engine, and `agent_account_id`
            // is refused without one on the write path too
            // (`api::roles::check_account`). Blocked here so the plan says it
            // rather than the apply.
            (None, _) => out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Field(Field::Account)),
                Some(Field::Account.spelling().into()),
                format!(
                    "`{wrote}` is a subscription for one engine, so this profile has to pin one \
                     too. Write `engine:`, or remove the account and the owner's default is used."
                ),
            )),
            (Some(_), None) => out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Field(Field::Account)),
                Some(Field::Account.spelling().into()),
                format!(
                    "no subscription named `{wrote}` is available to you. Write one you can \
                     spend, or `~` to run on the owner's default for the engine."
                ),
            )),
            (Some(engine), Some(account)) if account.engine != format!("{engine:?}") => {
                out.push(PlanProblem::at(
                    p,
                    at(&said.spelled, Spot::Field(Field::Account)),
                    Some(Field::Account.spelling().into()),
                    format!(
                        "`{wrote}` authenticates {} and this profile runs {engine:?}. Pick a \
                         subscription for {engine:?}, or change the engine.",
                        account.engine
                    ),
                ))
            }
            (Some(_), Some(_)) => {}
        }
    }

    // The teammates it may delegate to — against the installation **and the
    // drop itself**, so a profile naming another bundle in the same folder
    // resolves whether or not it exists here yet.
    for (n, wrote) in profile.delegates_to.iter().enumerate() {
        let here_now: Vec<&Role> = here
            .profiles
            .iter()
            .filter(|r| folded(&r.name) == folded(wrote))
            .collect();
        let in_drop = drop_bundles.iter().any(|b| match &b.said {
            Ok(other) => folded(&other.profile.name) == folded(wrote),
            Err(_) => false,
        });
        let key = Some(format!("{}[{n}]", Field::DelegatesTo.spelling()));
        if in_drop {
            continue;
        }
        match here_now.as_slice() {
            [_] => {}
            [] => out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Entry(Field::DelegatesTo, n)),
                key,
                format!(
                    "no profile named `{wrote}` is available to you, and no bundle in this drop \
                     is called that either. Write a teammate you can see, or drop its folder \
                     alongside this one."
                ),
            )),
            many => out.push(PlanProblem::at(
                p,
                at(&said.spelled, Spot::Entry(Field::DelegatesTo, n)),
                key,
                format!(
                    "{} profiles you can see are called `{wrote}` — {}. A profile delegates to \
                     one of them, so this has to say which.",
                    many.len(),
                    many.iter()
                        .map(|r| format!("`{}`", r.path))
                        .collect::<Vec<_>>()
                        .join(" and ")
                ),
            )),
        }
    }

    // The skills it loads. A skill is executable, so one the importer cannot
    // reach blocks rather than being silently stripped — the profile would
    // otherwise not do what the file says it does, and a reader of the file
    // could not tell.
    let mut resolved: Vec<(&SkillHere, usize)> = Vec::new();
    for (n, wrote) in profile.skills.iter().enumerate() {
        let key = Some(format!("{}[{n}]", Field::Skills.spelling()));
        let line = at(&said.spelled, Spot::Entry(Field::Skills, n));
        if let Some(qualifier) = wrote.directory.as_deref() {
            let Some(dir) = directory(qualifier, here) else {
                out.push(PlanProblem::at(
                    p,
                    line,
                    key,
                    format!(
                        "no directory named `{qualifier}` is available to you, so `{}` cannot be \
                         found in it.",
                        wrote.spelling()
                    ),
                ));
                continue;
            };
            let found: Vec<&SkillHere> = here
                .skills
                .iter()
                .filter(|s| {
                    folded(&s.name) == folded(&wrote.name) && s.directory() == Some(&dir.slug)
                })
                .collect();
            match found.as_slice() {
                [one] => resolved.push((one, n)),
                _ => out.push(PlanProblem::at(
                    p,
                    line,
                    key,
                    format!(
                        "no skill named `{}` in `{}` is available to you.",
                        wrote.name, dir.name
                    ),
                )),
            }
            continue;
        }
        let found: Vec<&SkillHere> = here
            .skills
            .iter()
            .filter(|s| folded(&s.name) == folded(&wrote.name))
            .collect();
        match found.as_slice() {
            [one] => resolved.push((one, n)),
            [] => out.push(PlanProblem::at(
                p,
                line,
                key,
                format!(
                    "no skill named `{}` is available to you. Write one you can use, or remove \
                     the entry.",
                    wrote.name
                ),
            )),
            many => out.push(PlanProblem::at(
                p,
                line,
                key,
                format!(
                    "{} skills you can see are called `{}` — {}. Put the directory in front of \
                     it to say which.",
                    many.len(),
                    wrote.name,
                    many.iter()
                        .map(|s| format!("`{}`", s.qualified()))
                        .collect::<Vec<_>>()
                        .join(" and ")
                ),
            )),
        }
    }

    // Two skills of one name, however they were written. A skill's folder on a
    // worker **is** its name, so only one of the two could be written and
    // `Skills::set_for_session` sends neither rather than picking — which is
    // why the write path refuses such a set as well (`check_skills`).
    let mut together: BTreeMap<String, Vec<(&SkillHere, usize)>> = BTreeMap::new();
    for (skill, n) in &resolved {
        together
            .entry(folded(&skill.name))
            .or_default()
            .push((skill, *n));
    }
    for (_, clashing) in together.iter().filter(|(_, v)| v.len() > 1) {
        let where_each = clashing
            .iter()
            .map(|(s, _)| format!("`{}`", s.qualified()))
            .collect::<Vec<_>>()
            .join(" and ");
        let first = clashing[0].1;
        out.push(PlanProblem::at(
            p,
            at(&said.spelled, Spot::Entry(Field::Skills, first)),
            Some(format!("{}[{first}]", Field::Skills.spelling())),
            format!(
                "two of the skills named share the name `{}` — {where_each}. A skill's folder on \
                 a worker is its name, so neither would be loaded. Drop one, or rename it in the \
                 library.",
                clashing[0].0.name
            ),
        ));
    }

    // An existing profile the asker may see and not write.
    if let Matched::Hit { row, .. } = matched {
        if !row.may_write {
            out.push(PlanProblem::at(
                p,
                1,
                None,
                format!(
                    "`{}` is the profile this bundle is, and you can look at it without being \
                     able to change it. Ask for Editor where it is filed.",
                    row.name
                ),
            ));
        }
    }

    out
}

/// A machine or anything else with a name, resolved the way `Roles::by_name`
/// resolves a profile: case-insensitively, and never ambiguously.
fn resolve_named<'a>(wrote: &str, among: &'a [Named]) -> Option<&'a Named> {
    let wanted = folded(wrote);
    let mut found = among.iter().filter(|n| folded(&n.name) == wanted);
    let first = found.next()?;
    match found.next() {
        None => Some(first),
        Some(_) => None,
    }
}

fn resolve_account<'a>(wrote: &str, among: &'a [Subscription]) -> Option<&'a Subscription> {
    let wanted = folded(wrote);
    let mut found = among.iter().filter(|a| folded(&a.name) == wanted);
    let first = found.next()?;
    match found.next() {
        None => Some(first),
        Some(_) => None,
    }
}

// ── the diff ────────────────────────────────────────────────────────────

/// The sixteen fields: what the profile is now against what the file would make
/// it.
///
/// Walked from [`Field::all`] so a field added to the codec cannot quietly drop
/// out of the diff, with `key` left out — it is the identity rather than a
/// field that changes — and the instructions added as the sixteenth, which is
/// exactly how the specification counts them.
fn diff(said: &Reading, row: &Role, here: &Here) -> Vec<FieldDiff> {
    let mut out = Vec::new();
    for field in Field::all() {
        if field == Field::Key {
            continue;
        }
        out.push(one_field(field, said, row, here));
    }
    out.push(body(said, row));
    out
}

fn change(before: &str, after: &str, spelled: bool) -> FieldChange {
    if before == after {
        FieldChange::Unchanged
    } else if spelled {
        FieldChange::Changed
    } else {
        FieldChange::Reset
    }
}

/// One field, rendered in the file's own vocabulary on both sides.
///
/// Exhaustive on [`Field`], so a field the codec gains does not compile until
/// this knows how to show it — the same discipline the codec's own reader and
/// writer are held to.
fn one_field(field: Field, said: &Reading, row: &Role, here: &Here) -> FieldDiff {
    let file = &said.profile;
    let spelled = said.spelled.wrote(Spot::Field(field));
    let open = "the lead's choice";
    let (before, after) = match field {
        // Carried by the identity, never shown as a change.
        Field::Key => (row.key.clone().unwrap_or_default(), file.key.clone()),
        Field::Name => (row.name.clone(), file.name.clone()),
        Field::Does => (row.does.clone(), file.does.clone()),
        Field::Directory => {
            let filed = match row.path.starts_with("d/") {
                true => row
                    .path
                    .split('/')
                    .nth(1)
                    .and_then(|slug| here.directories.iter().find(|d| d.slug == slug))
                    .map(|d| d.name.clone())
                    .unwrap_or_else(|| "a directory you cannot see".into()),
                false => "your own space".into(),
            };
            // An overwrite leaves a profile filed where it is — `directory` is
            // a create-time field on the write path — and a file that names a
            // different one is blocked rather than diffed, so this row is only
            // ever reached when the two agree.
            (filed.clone(), filed)
        }
        Field::Engine => (
            row.agent.clone().unwrap_or_else(|| open.into()),
            file.engine
                .map(|a| format!("{a:?}"))
                .unwrap_or_else(|| open.into()),
        ),
        Field::Placement => (row.placement.clone(), file.placement.spelling().to_string()),
        Field::Machine => (
            seen(
                row.machine.as_deref(),
                &here.machines,
                "a machine you cannot see",
                open,
            ),
            file.machine.clone().unwrap_or_else(|| open.into()),
        ),
        Field::Account => (
            match row.account.as_deref() {
                None => "the owner's default for the engine".to_string(),
                Some(id) => here
                    .accounts
                    .iter()
                    .find(|a| a.id == id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| "a subscription you cannot see".into()),
            },
            file.account
                .clone()
                .unwrap_or_else(|| "the owner's default for the engine".into()),
        ),
        Field::CanDelegate => (row.can_delegate.to_string(), file.can_delegate.to_string()),
        Field::DelegatesTo => (
            names(
                &row.delegate_scope,
                |id| {
                    here.profiles
                        .iter()
                        .find(|r| r.id == *id)
                        .map(|r| r.name.clone())
                },
                "a profile you cannot see",
                "any teammate the owner can see",
            ),
            match file.delegates_to.is_empty() {
                true => "any teammate the owner can see".to_string(),
                false => file.delegates_to.join(", "),
            },
        ),
        Field::IncludeAlwaysOn => (
            row.include_always_on.to_string(),
            file.include_always_on.to_string(),
        ),
        Field::IncludeRepoDefaults => (
            row.include_repo_defaults.to_string(),
            file.include_repo_defaults.to_string(),
        ),
        Field::Skills => (
            names(
                &row.skill_scope,
                |id| {
                    here.skills
                        .iter()
                        .find(|s| s.id == *id)
                        .map(SkillHere::qualified)
                },
                "a skill you cannot see",
                "none of its own",
            ),
            match file.skills.is_empty() {
                true => "none of its own".to_string(),
                false => file
                    .skills
                    .iter()
                    .map(profile_md::SkillRef::spelling)
                    .collect::<Vec<_>>()
                    .join(", "),
            },
        ),
        Field::OnUsageLimit => (
            row.on_usage_limit.clone(),
            file.on_usage_limit.spelling().to_string(),
        ),
        Field::OnChildLimit => (
            row.on_child_limit.clone(),
            file.on_child_limit.spelling().to_string(),
        ),
        Field::Settings => {
            let settings = settings(said, row);
            let changed = settings.iter().any(|s| s.change != FieldChange::Unchanged);
            let reset = changed && settings.iter().all(|s| s.change != FieldChange::Changed);
            return FieldDiff {
                field: field.spelling().to_string(),
                change: match (changed, reset) {
                    (false, _) => FieldChange::Unchanged,
                    (true, true) => FieldChange::Reset,
                    (true, false) => FieldChange::Changed,
                },
                before: settings
                    .iter()
                    .map(|s| format!("{} {}", s.setting, s.before))
                    .collect::<Vec<_>>()
                    .join(" · "),
                after: settings
                    .iter()
                    .map(|s| format!("{} {}", s.setting, s.after))
                    .collect::<Vec<_>>()
                    .join(" · "),
                settings,
                body: None,
            };
        }
    };
    FieldDiff {
        field: field.spelling().to_string(),
        change: change(&before, &after, spelled),
        before,
        after,
        settings: Vec::new(),
        body: None,
    }
}

/// An id rendered as its name, or as the fact that it is not visible.
fn seen(id: Option<&str>, among: &[Named], hidden: &str, absent: &str) -> String {
    match id {
        None => absent.to_string(),
        Some(id) => among
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.name.clone())
            .unwrap_or_else(|| hidden.to_string()),
    }
}

/// A list of ids rendered as names, with the ones the asker cannot see said as
/// such rather than named.
fn names(
    ids: &[String],
    name_of: impl Fn(&String) -> Option<String>,
    hidden: &str,
    empty: &str,
) -> String {
    if ids.is_empty() {
        return empty.to_string();
    }
    let mut out: Vec<String> = Vec::new();
    let mut unseen = 0;
    for id in ids {
        match name_of(id) {
            Some(name) => out.push(name),
            None => unseen += 1,
        }
    }
    for _ in 0..unseen {
        out.push(hidden.to_string());
    }
    out.join(", ")
}

/// The four agent settings, each with its own change.
///
/// A reset names **the resulting value**: a profile that pins an engine
/// resolves one through `controls::default_value`, which is the same default
/// `launch_headless` applies, so the row can say what will actually run rather
/// than the words "the engine's default". A profile that pins no engine has no
/// such value to name — whichever engine the lead picks decides — and saying so
/// is the only honest answer.
fn settings(said: &Reading, row: &Role) -> Vec<SettingDiff> {
    let mut out = Vec::new();
    let was = row.agent.as_deref().and_then(ft_core::Agent::from_name);
    let will = said.profile.engine;
    for setting in Setting::all() {
        let kind = kind_of(setting);
        let stored = match setting {
            Setting::Model => row.settings.model.as_deref(),
            Setting::Effort => row.settings.effort.as_deref(),
            Setting::Mode => row.settings.mode.as_deref(),
            Setting::Sandbox => row.settings.sandbox.as_deref(),
        };
        let written = match setting {
            Setting::Model => said.profile.settings.model.as_deref(),
            Setting::Effort => said.profile.settings.effort.as_deref(),
            Setting::Mode => said.profile.settings.mode.as_deref(),
            Setting::Sandbox => said.profile.settings.sandbox.as_deref(),
        };
        let spelled = said.spelled.wrote(Spot::Setting(setting));
        let before = resulting(stored, was, kind);
        let after = resulting(written, will, kind);
        out.push(SettingDiff {
            setting: setting.spelling().to_string(),
            change: change(&before, &after, spelled),
            before,
            after,
        });
    }
    out
}

/// Which control one setting is. One table, so the reader and this cannot
/// disagree about which is which.
fn kind_of(setting: Setting) -> ft_core::controls::ControlKind {
    use ft_core::controls::ControlKind;
    match setting {
        Setting::Model => ControlKind::Model,
        Setting::Effort => ControlKind::Effort,
        Setting::Mode => ControlKind::Mode,
        Setting::Sandbox => ControlKind::Sandbox,
    }
}

/// What a setting resolves to: the value written, or the value an unset one
/// takes for the engine this profile pins.
fn resulting(
    value: Option<&str>,
    engine: Option<ft_core::Agent>,
    kind: ft_core::controls::ControlKind,
) -> String {
    if let Some(value) = value {
        return label(engine, kind, value);
    }
    let Some(engine) = engine else {
        return "whichever engine the lead picks decides".to_string();
    };
    match ft_core::controls::default_value(engine, kind) {
        Some(default) => format!("{} (the default)", label(Some(engine), kind, default)),
        // Codex's model list arrives from the agent, so there is no value here
        // to name. Said rather than guessed.
        None => format!("{engine:?} decides when it starts"),
    }
}

/// What a picker calls a value, where it knows — so a diff reads `Opus` rather
/// than `opus[1m]` and still says the value when nothing offers it.
fn label(
    engine: Option<ft_core::Agent>,
    kind: ft_core::controls::ControlKind,
    value: &str,
) -> String {
    let Some(engine) = engine else {
        return value.to_string();
    };
    ft_core::controls::for_agent(engine, Vec::new(), Vec::new())
        .into_iter()
        .filter(|c| c.kind == kind)
        .flat_map(|c| c.choices)
        .find(|choice| choice.value == value)
        .map(|choice| format!("{} ({value})", choice.label))
        .unwrap_or_else(|| value.to_string())
}

/// The instructions: a changed-line count that expands into a unified diff.
fn body(said: &Reading, row: &Role) -> FieldDiff {
    let before = row.instructions.trim();
    let after = said.profile.instructions.trim();
    let diff = similar::TextDiff::from_lines(before, after);
    let mut added = 0usize;
    let mut removed = 0usize;
    for change in diff.iter_all_changes() {
        match change.tag() {
            similar::ChangeTag::Insert => added += 1,
            similar::ChangeTag::Delete => removed += 1,
            similar::ChangeTag::Equal => {}
        }
    }
    FieldDiff {
        field: "instructions".into(),
        // A body nobody wrote is the documented default, which is the empty
        // one — so deleting the markdown under the frontmatter is a reset, and
        // the screen draws it as the destructive thing it is.
        change: change(before, after, !after.is_empty()),
        before: measured(before),
        after: measured(after),
        settings: Vec::new(),
        body: Some(BodyDiff {
            changed_lines: added + removed,
            added,
            removed,
            unified: match added + removed {
                0 => String::new(),
                _ => unified(before, after),
            },
        }),
    }
}

/// The instructions, as a diff row's one line. The body itself is in the
/// unified diff beside it.
fn measured(text: &str) -> String {
    match text.is_empty() {
        true => "nothing".to_string(),
        false => format!("{} lines", text.lines().count()),
    }
}

/// A unified diff of two bodies.
fn unified(before: &str, after: &str) -> String {
    let diff = similar::TextDiff::from_lines(before, after);
    let mut out = String::new();
    for hunk in diff.unified_diff().context_radius(3).iter_hunks() {
        out.push_str(&format!("{}\n", hunk.header()));
        for change in hunk.iter_changes() {
            out.push(match change.tag() {
                similar::ChangeTag::Delete => '-',
                similar::ChangeTag::Insert => '+',
                similar::ChangeTag::Equal => ' ',
            });
            out.push_str(change.value());
            if !change.value().ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

// ── what only the whole drop can say ────────────────────────────────────

/// Two bundles that would write the same profile are both blocked.
///
/// Two different keys can select one row — through the name fallback, or
/// through two candidate answers naming it — and the last write would silently
/// win. Neither bundle is wrong on its own, which is why this is a pass over
/// the finished entries rather than a rule inside the match.
fn same_target_blocks(entries: &mut [PlanEntry]) {
    let mut targets: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in entries.iter() {
        if let Some(id) = hits(entry) {
            targets.entry(id).or_default().push(entry.path.clone());
        }
    }
    let clashing: BTreeMap<&String, &Vec<String>> = targets
        .iter()
        .filter(|(_, paths)| paths.len() > 1)
        .collect();
    if clashing.is_empty() {
        return;
    }
    for entry in entries.iter_mut() {
        let Some(id) = hits(entry) else { continue };
        let Some(paths) = clashing.get(&id) else {
            continue;
        };
        let others: Vec<String> = paths
            .iter()
            .filter(|p| **p != entry.path)
            .map(|p| format!("`{}`", briefly(p)))
            .collect();
        let name = match &entry.outcome {
            PlanOutcome::Overwrite(o) => o.profile.name.clone(),
            PlanOutcome::Rename(r) => r.profile.name.clone(),
            _ => String::new(),
        };
        entry.outcome = PlanOutcome::Blocked(PlanBlocked {
            problems: vec![PlanProblem::at(
                &entry.path,
                1,
                None,
                format!(
                    "this bundle and {} both resolve to the profile `{name}`. One of them would \
                     overwrite the other, so neither is applied — leave one out, or answer the \
                     match differently.",
                    others.join(" and ")
                ),
            )],
        });
    }
}

/// The profile an entry would write, when it would write one.
fn hits(entry: &PlanEntry) -> Option<String> {
    match &entry.outcome {
        PlanOutcome::Overwrite(o) => Some(o.profile.id.clone()),
        PlanOutcome::Rename(r) => Some(r.profile.id.clone()),
        _ => None,
    }
}

/// Two bundles sharing a `name` warn rather than block.
///
/// With the key as the identity they are simply two profiles, and either row
/// can be excluded — the rule that blocked them left Cancel as the only action.
fn same_name_warnings(entries: &mut [PlanEntry]) {
    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in entries.iter() {
        if let Some(name) = &entry.name {
            by_name
                .entry(folded(name))
                .or_default()
                .push(entry.path.clone());
        }
    }
    for entry in entries.iter_mut() {
        let Some(name) = entry.name.clone() else {
            continue;
        };
        let Some(paths) = by_name.get(&folded(&name)) else {
            continue;
        };
        if paths.len() < 2 {
            continue;
        }
        let others: Vec<String> = paths
            .iter()
            .filter(|p| **p != entry.path)
            .map(|p| format!("`{}`", briefly(p)))
            .collect();
        entry.warnings.push(PlanProblem::at(
            &entry.path,
            1,
            Some(Field::Name.spelling().into()),
            format!(
                "{} in this drop is also called `{name}`. Two profiles may share a name — they \
                 are told apart by their folder — so this is only worth knowing.",
                others.join(" and ")
            ),
        ));
    }
}

/// Why this plan cannot be applied, in sentences.
fn why_not(entries: &[PlanEntry]) -> Vec<String> {
    let blocked = entries
        .iter()
        .filter(|e| matches!(e.outcome, PlanOutcome::Blocked(_)))
        .count();
    let unanswered = entries
        .iter()
        .filter(|e| matches!(e.outcome, PlanOutcome::Candidate(_)))
        .count();
    let mut out = Vec::new();
    if blocked > 0 {
        out.push(match blocked {
            1 => "One bundle is blocked. Nothing is imported until it is fixed or left out."
                .to_string(),
            n => format!(
                "{n} bundles are blocked. Nothing is imported until they are fixed or left out."
            ),
        });
    }
    if unanswered > 0 {
        out.push(match unanswered {
            1 => "One bundle may be a profile you already have, and only you can say whether it \
                  is."
            .to_string(),
            n => format!(
                "{n} bundles may be profiles you already have, and only you can say whether they \
                 are."
            ),
        });
    }
    out
}

fn sorted(mut problems: Vec<PlanProblem>) -> Vec<PlanProblem> {
    problems.sort_by(|a, b| a.line.cmp(&b.line).then(a.key.cmp(&b.key)));
    problems
}

/// A path, short enough to put in a sentence.
fn briefly(path: &str) -> String {
    const MOST: usize = 80;
    match path.chars().count() > MOST {
        false => path.to_string(),
        true => format!("{}…", path.chars().take(MOST).collect::<String>()),
    }
}
