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
//! ### Three states, not two, and the one pair that must read alike
//!
//! The rule above was decided over two states. A machine the fleet **used to
//! have** is a third, and it is neither of them: it was legitimately named, it
//! is on the asker's own Compute screen, and it has gone. So a name that does
//! not resolve is one of three things, and the wording carries them as **two**
//! sentences:
//!
//! | the state | what it says |
//! |---|---|
//! | you may not see it | *no machine named `fire_01` is available to you* |
//! | it never existed | the same sentence, deliberately |
//! | it left the fleet | *`fire_01` was removed from the fleet, so nothing runs there any more* |
//!
//! **The first two have to stay identical** — that pair *is* the enumeration
//! oracle, and the threat model's Low finding is about exactly it. The third is
//! distinguished on a judgement that was made deliberately rather than fallen
//! into: it discloses, to somebody already authenticated inside a single-tenant
//! installation, that a name they guessed was once real. Taken, because the
//! harm the other way is concrete and immediate — *"not available to you"*
//! about a decommissioned machine sends somebody to ask an administrator for
//! access they will never be given, and nothing in the sentence says why. It is
//! also the honest answer: the file was right when it was written, and what
//! changed is the fleet rather than their grants.
//!
//! **Where to be careful if this grows a fourth state.** The test to apply is
//! not "are these different facts" — it is "does telling them apart answer a
//! question the asker could not already answer". Retirement passes because the
//! machine is already on their screen. A *hidden* machine never does, which is
//! why no amount of helpfulness may split the first two.
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
    /// Every profile they may see, at Viewer or better, carrying `may_write`.
    pub profiles: Vec<Role>,
    /// Every machine they may run on, by name.
    pub machines: Vec<Named>,
    /// The machines they can see that were **removed from the fleet**.
    ///
    /// A separate list rather than a flag, because the two answer different
    /// questions and only one of them is "may this profile run here". A
    /// retired machine is not hidden — `20261106120000_retire_local_host.sql`
    /// left every profile pinned to the retired local host pinned, because
    /// nulling them "would silently repin somebody's profile" — so a file can
    /// legitimately name one, and `Db::host_named` is export writing exactly
    /// that. It still blocks, because nothing can run there; what it must not
    /// do is say "not available to you" about a machine sitting on the asker's
    /// own Compute screen.
    pub retired: Vec<Named>,
    /// Every subscription they could actually spend.
    pub accounts: Vec<Subscription>,
    /// Every directory they may at least look in.
    pub directories: Vec<Dir>,
    /// Every skill they may reach, at Viewer or better.
    pub skills: Vec<SkillHere>,
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
fn line_of(spelled: &Spelled, spot: Spot) -> usize {
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

    // **`appliable` is derived, never set.** It is exactly "there is no reason
    // not to", so an unappliable plan with no reason in it cannot be
    // constructed — which is the shape of #349 and was reachable here: an
    // empty drop came back unappliable and silent, and a screen given no
    // sentence draws a dead button with nothing beside it.
    let why_not = why_not(&entries, &ignored);
    Ok(ImportPlan {
        appliable: why_not.is_empty(),
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
            "this drop holds {} files, and an import takes at most {MOST_FILES}. Drop fewer \
             folders at once.",
            drop.files.len()
        )));
    }
    let mut total = 0usize;
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for file in &drop.files {
        if file.path.trim().is_empty() {
            return Err(Refused("a file in this drop has no name".into()));
        }
        // One path, one file. Two rows for one path is a malformed request
        // rather than a bundle with a problem — there is no way to say which of
        // the two the plan is about, and the entries would differ only by the
        // order they arrived in.
        if !seen.insert(file.path.as_str()) {
            return Err(Refused(format!(
                "`{}` is in this drop twice, so there is no saying which of the two to read",
                briefly(&file.path)
            )));
        }
        if file.path.starts_with('/') || file.path.contains('\\') || file.path.contains("..") {
            return Err(Refused(format!(
                "`{}` is not a path inside the folder that was dropped",
                briefly(&file.path)
            )));
        }
        if file.path.len() > crate::skills::LONGEST_PATH {
            return Err(Refused(format!(
                "`{}` is {} bytes long, and a path inside a drop is at most {}. Drop the folder \
                 that holds the bundles rather than the tree above it.",
                briefly(&file.path),
                file.path.len(),
                crate::skills::LONGEST_PATH
            )));
        }
        let depth = file.path.split('/').filter(|s| !s.is_empty()).count();
        if depth > DEEPEST {
            return Err(Refused(format!(
                "`{}` is {depth} folders deep, and an import reads at most {DEEPEST}. Drop the \
                 folder that holds the bundles rather than the repository around it.",
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
                "this drop is over the {} MB an import takes. Drop fewer folders at once.",
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

    let mut warnings = said_about_settings(bundle, said);
    let outcome = match matched {
        Matched::Create { answered } => {
            warnings.extend(same_name_as_the_library(bundle, said, here));
            PlanOutcome::New(PlanNew {
                filed: filed_where(said, here),
                answered,
            })
        }
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
        warnings,
    }
}

/// A profile already here under this name, which this bundle is about to put a
/// second one beside.
///
/// A warning rather than a question: the key is the identity, so a row that
/// carries a different one has said what it is and a renamed folder makes a new
/// profile (#358). Two profiles of one name is legal — they are told apart by
/// their folder — and rarely what somebody meant, which is exactly the shape of
/// thing a warning is for.
///
/// Only rows the asker can already see, so this adds nothing they could not
/// read off the Profiles screen.
fn same_name_as_the_library(bundle: &Bundle, said: &Reading, here: &Here) -> Vec<PlanProblem> {
    let name = said.profile.name.trim();
    let theirs: Vec<&Role> = here
        .profiles
        .iter()
        .filter(|r| folded(&r.name) == folded(name) && r.key.is_some())
        .collect();
    if theirs.is_empty() {
        return Vec::new();
    }
    vec![PlanProblem::at(
        &bundle.path,
        line_of(&said.spelled, Spot::Field(Field::Name)),
        Some(Field::Name.spelling().to_string()),
        format!(
            "`{name}` is already in your library, under the key `{}`. This folder is called \
             `{}`, so it makes a second profile of that name rather than changing that one.",
            theirs[0].key.as_deref().unwrap_or_default(),
            bundle.key
        ),
    )]
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

    // The fallback: the name, against rows that have **no key of their own**.
    //
    // A row that already carries a different key is never matched by its name
    // and never proposed: it has said what it is, and renaming a folder makes a
    // new profile beside the original rather than editing it (#358). That is
    // worth *knowing* — two profiles of one name is rarely what somebody meant
    // — so it is a warning on the entry (`same_name_as_the_library`) rather
    // than a question that would block the drop.
    let mut exact: Vec<&Role> = Vec::new();
    let mut proposals: Vec<PlanProposal> = Vec::new();
    let mut near = 0usize;
    // A bundle says what it is twice — its `name` and its folder — and either
    // may be the one that resembles a profile already here. `qa-engineer/`
    // holding a `name: QA Engineer` is the live case, and both of its spellings
    // point at the library's `QA`.
    let ours = [words(name), words(&bundle.key)];
    for row in &here.profiles {
        let theirs = row.name.trim();
        match &row.key {
            None if theirs == name => exact.push(row),
            None if folded(theirs) == folded(name) => {
                near += 1;
                proposals.push(proposal(row, ProposalWhy::NearName, name));
            }
            None if ours.iter().any(|ours| resembles(&words(theirs), ours)) => {
                proposals.push(proposal(row, ProposalWhy::LikeName, name))
            }
            _ => {}
        }
    }

    // One row of exactly this name, with nothing else answering to it.
    //
    // **An exact, unique name match is not a guess — it is the only
    // candidate.** "Never guess an identity" is the rule this whole function
    // exists for, and it bites where there are *zero* matches or *several*: a
    // resemblance, a difference of capitals, two rows answering to one name.
    // Here there is one answer, the review shows the whole diff before
    // anything is written, and the alternative costs a compulsory question per
    // profile on every first import — because export writes the live `name`,
    // so every bundle of an exported library matches exactly.
    //
    // This is where the key is adopted: the one moment a row stops being
    // matched by its name and starts being matched by its key.
    if exact.len() == 1 && near == 0 {
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
             and so does another profile. Which of them this folder is, is yours to say."
        ),
        ProposalWhy::NearName => format!(
            "`{name}` differs from `{wrote}` only in capitals or spacing, which is usually the \
             same profile and is not always."
        ),
        ProposalWhy::LikeName => format!(
            "`{name}` is made of the same words as this bundle, so it may be the profile this \
             folder was written for."
        ),
        ProposalWhy::SameKey => format!(
            "`{name}` carries the key `{wrote}`, and so does another profile you can see. Which \
             of them this folder is, is yours to say."
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

/// The words of a name, lowercased, **in the order they are written**.
///
/// Ordered, which matters: the resemblance rule below anchors on the first
/// word, and a set would anchor on the alphabetically first one instead —
/// which proposed `Engineer` for a `QA Engineer` bundle and not `QA`, the exact
/// pair of answers the rule exists to get right.
fn words(name: &str) -> Vec<String> {
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
fn resembles(theirs: &[String], ours: &[String]) -> bool {
    if theirs.is_empty() || ours.is_empty() || theirs == ours {
        return false;
    }
    if theirs.first() != ours.first() {
        return false;
    }
    let (theirs, ours): (BTreeSet<&String>, BTreeSet<&String>) =
        (theirs.iter().collect(), ours.iter().collect());
    theirs.is_subset(&ours) || ours.is_subset(&theirs)
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
                line_of(&said.spelled, Spot::Field(Field::Directory)),
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
                line_of(&said.spelled, Spot::Field(Field::Directory)),
                Some(Field::Directory.spelling().into()),
                format!(
                    "you can look in `{}` but not file anything there. Ask for Editor on it, or \
                     remove the line to keep this profile in your own space.",
                    dir.name
                ),
            )),
            Some(_) => {}
        },
        // An existing profile is overwritten **where it already is**, and a
        // file naming a different directory is making a claim the import
        // cannot honour. Said rather than silently ignored, which is the whole
        // rule.
        //
        // **`directory` is placement, not configuration, so
        // absent-means-the-default never covered it.** That rule exists so one
        // file fully describes a profile's *configuration* on any
        // installation; `directory` says where the resource sits in the
        // sharing tree, and the write path cannot perform a move at all
        // (`NewRole::directory` — "only honoured at creation; move it later
        // with sharing"). So `directory` is creation-only, an absent
        // `directory:` leaves a row filed where it is, and the `directory` row
        // of an overwrite's diff is `unchanged`. Reading it as a default would
        // un-share a shared profile on every import, silently, with nothing in
        // the diff to show it.
        (Some(wrote), Matched::Hit { row, .. }) => {
            // Where the row actually is, said the way a person reads it: the
            // directory's **name**, or their own space. Never `u/admin`, which
            // is a path the server computes and nobody types.
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
                // And an instruction that can be followed. `directory` is
                // create-only, so the two ways out are to name where the row
                // already is — which only exists when it is in a directory —
                // or to remove the line, which leaves it where it is.
                let ways_out = match theirs
                    .and_then(|slug| here.directories.iter().find(|d| d.slug == slug))
                {
                    Some(dir) => format!(
                        "it is in `{}`, so write `directory: {}` or remove the line.",
                        dir.name, dir.name
                    ),
                    None if theirs.is_some() => "it is in a directory you cannot see, so remove \
                                                 the line and it stays where it is."
                        .to_string(),
                    None => "it is in your own space, which is what an absent `directory:` \
                             means, so remove the line."
                        .to_string(),
                };
                out.push(PlanProblem::at(
                    p,
                    line_of(&said.spelled, Spot::Field(Field::Directory)),
                    Some(Field::Directory.spelling().into()),
                    format!(
                        "this bundle is the profile `{}` and says `directory: {wrote}`, which \
                         would move it. An import cannot move a profile, and {ways_out}",
                        row.name
                    ),
                ));
            }
        }
        // A candidate has not been answered, so there is no answer to the
        // question this check asks: "same profile" overwrites a row that is
        // already filed somewhere, and "a new profile" needs Editor where the
        // file says. Asked again on the next plan, when the answer is in.
        _ => {}
    }

    // The machine its own workspace runs on.
    if let Some(wrote) = profile.machine.as_deref() {
        let found: Vec<&Named> = among(wrote, &here.machines, |m| &m.name);
        let line = line_of(&said.spelled, Spot::Field(Field::Machine));
        let key = Some(Field::Machine.spelling().to_string());
        match found.len() {
            1 => {}
            // **The third state**, and the one place the plan tells any two
            // apart: see the module doc. A retired machine is on the asker's
            // own Compute screen, so saying it left the fleet answers nothing
            // they could not already answer — and it stops "not available to
            // you" sending them to an administrator for access to a
            // decommissioned machine. The two states above it stay one
            // sentence, which is the enumeration oracle the threat model is
            // about. Both block: nothing runs on a machine that is gone.
            0 if !among(wrote, &here.retired, |m| &m.name).is_empty() => out.push(PlanProblem::at(
                p,
                line,
                key,
                format!(
                    "`{wrote}` was removed from the fleet, so nothing runs there any more. \
                         Write a machine that is still in it, or `~` to leave the choice to \
                         whichever lead delegates to it."
                ),
            )),
            0 => out.push(PlanProblem::at(
                p,
                line,
                key,
                format!(
                    "no machine named `{wrote}` is available to you. Write one of yours, or `~` \
                     to leave the machine to whichever lead delegates to it."
                ),
            )),
            // Ambiguity is not absence, and saying "not available to you" about
            // something there are two of would be a sentence nobody could act
            // on. Only names the asker can already see are in `found`.
            n => out.push(PlanProblem::at(
                p,
                line,
                key,
                format!(
                    "{n} machines you can see are called `{wrote}`, so this cannot say which one \
                     to run on. Rename one in Compute."
                ),
            )),
        }
    }

    // The subscription its agent runs on.
    //
    // **Does it exist, then is it ambiguous, then is it for this engine.** In
    // that order, because the engine question is about a subscription and
    // asking it first says one exists: a name that resolves to nothing used to
    // come back as "`X` *is* a subscription for one engine, so this profile has
    // to pin one too", which is not unhelpful but false, and somebody would go
    // looking for `X`. A name that resolves to nothing reads as nothing, the
    // same way a hidden one does.
    if let Some(wrote) = profile.account.as_deref() {
        let found: Vec<&Subscription> = among(wrote, &here.accounts, |a| &a.name);
        let line = line_of(&said.spelled, Spot::Field(Field::Account));
        let key = Some(Field::Account.spelling().to_string());
        let says = match (found.as_slice(), &profile.engine) {
            ([], _) => Some(format!(
                "no subscription named `{wrote}` is available to you. Write one you can spend, \
                 or `~` to run on the owner's default for the engine."
            )),
            (many, _) if many.len() > 1 => Some(format!(
                "{} subscriptions you can see are called `{wrote}`, so this cannot say which one \
                 to spend. Rename one in Subscriptions.",
                many.len()
            )),
            // One of that name, and nothing to check it against. A
            // subscription authenticates one engine, and `agent_account_id` is
            // refused without one on the write path too
            // (`api::roles::check_account`), so the plan says it rather than
            // the apply.
            ([_], None) => Some(format!(
                "`{wrote}` is a subscription for one engine, so this profile has to pin one too. \
                 Write `engine:`, or remove the line and the owner's default for the engine is \
                 used."
            )),
            ([one], Some(engine)) if one.engine != format!("{engine:?}") => Some(format!(
                "`{wrote}` authenticates {} and this profile runs {engine:?}. Write a \
                 subscription for {engine:?}, or change the engine.",
                one.engine
            )),
            _ => None,
        };
        if let Some(says) = says {
            out.push(PlanProblem::at(p, line, key, says));
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

        // **A profile naming itself is refused. A cycle between profiles is
        // not.**
        //
        // Deliberately two different rules, and not an inconsistency for
        // somebody to tidy up later: `A → B → A` is a library somebody might
        // actually mean, and nested delegation is coming, so cycles are
        // permitted. `A → A` is a copy-paste error almost every time — and
        // nothing is lost by refusing it, because the same effect becomes
        // reachable through nesting anyway. If these two ever have to agree,
        // the direction to move is *permitting* self-delegation, never
        // blocking cycles.
        //
        // Both ways of naming yourself count. The file's own `name` is the
        // obvious one; the other is a rename — a file that renames `Designer`
        // to `Product Designer` and still writes `delegates_to: [Designer]`
        // resolves to the very row it is about to overwrite, and
        // `delegate_scope` holds ids, so after the write that is a profile
        // pointing at itself.
        // Echoing what the file wrote, which under a rename is not the name
        // the file gives: `delegates_to: [Designer]` beside `name: Product
        // Designer` points at the row this bundle overwrites, and a refusal
        // naming `Product Designer` would be about a line nobody wrote.
        let itself = if folded(wrote) == folded(&profile.name) {
            Some(format!(
                "`{wrote}` is this profile, so it cannot be one of the teammates it hands work \
                 to. Remove the entry."
            ))
        } else {
            match (here_now.as_slice(), matched) {
                ([row], Matched::Hit { row: target, .. }) if row.id == target.id => Some(format!(
                    "`{wrote}` is the profile this bundle overwrites, now called `{}`, so this \
                     would be a profile delegating to itself. Remove the entry.",
                    profile.name
                )),
                _ => None,
            }
        };
        if let Some(says) = itself {
            out.push(PlanProblem::at(
                p,
                line_of(&said.spelled, Spot::Entry(Field::DelegatesTo, n)),
                key,
                says,
            ));
            continue;
        }

        if in_drop {
            continue;
        }
        match here_now.as_slice() {
            [_] => {}
            [] => out.push(PlanProblem::at(
                p,
                line_of(&said.spelled, Spot::Entry(Field::DelegatesTo, n)),
                key,
                format!(
                    "no profile named `{wrote}` is available to you, and no bundle in this drop \
                     is called that either. Write a teammate you can see, or drop its folder \
                     alongside this one."
                ),
            )),
            many => out.push(PlanProblem::at(
                p,
                line_of(&said.spelled, Spot::Entry(Field::DelegatesTo, n)),
                key,
                format!(
                    "{} profiles you can see are called `{wrote}`: {}. A profile delegates to \
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
        let line = line_of(&said.spelled, Spot::Entry(Field::Skills, n));
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
                    "{} skills you can see are called `{}`: {}. Put the directory in front of \
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
            line_of(&said.spelled, Spot::Entry(Field::Skills, first)),
            Some(format!("{}[{first}]", Field::Skills.spelling())),
            format!(
                "two of the skills named share the name `{}`: {where_each}. A skill's folder on \
                 a worker is its name, so neither would be loaded. Drop one, or rename it in the \
                 library.",
                clashing[0].0.name
            ),
        ));
    }

    // The four agent settings.
    //
    // **Checked against the engine's own offered set, and only when that set is
    // knowable.** Parity with `POST /roles` would be no check at all, and that
    // is not sufficient here for two reasons: the error table says an invalid
    // enum value blocks and lists what is accepted, and a typo'd value does
    // not fail at launch either — `Preferred::keeping_only` drops a value the
    // agent no longer offers, so `effort: maximum` silently does nothing,
    // which is the failure this whole format exists to remove.
    //
    // The asymmetry is the one a reset already has: with no engine pinned
    // there is no valid set until a lead picks one, so the value is taken as
    // written and the plan says so rather than guessing.
    for setting in Setting::all() {
        let Some(wrote) = written(setting, &said.profile.settings) else {
            continue;
        };
        let line = line_of(&said.spelled, Spot::Setting(setting));
        let key = Some(Spot::Setting(setting).spelling());
        match offered(profile.engine, setting) {
            Offer::Values(values) if !values.iter().any(|v| v == wrote) => {
                out.push(PlanProblem::at(
                    p,
                    line,
                    key,
                    format!(
                        "`{wrote}` is not {} {:?} offers. Write one of {}.",
                        article(setting),
                        profile.engine.expect("an offered set needs an engine"),
                        values
                            .iter()
                            .map(|v| format!("`{v}`"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                ));
            }
            // **A control the engine does not have is not an invalid value**,
            // and it warns rather than blocking. Nothing is wrong with what
            // the file says; the line simply has no effect, so refusing it
            // would break the export round trip for a row Firetower itself
            // produced — `pref_sandbox` is one column for every engine, and
            // export writes what the row holds. The ruling is about checking a
            // value "against that engine's offered set", and here there is no
            // set to check against.
            Offer::Values(_)
            | Offer::WhenItStarts
            | Offer::WhenALeadPicks
            | Offer::NotThisEngine => {}
        }
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

/// Everything of this name the asker can see.
///
/// Case-insensitively, the way `Roles::by_name` resolves a profile a lead
/// names. A `Vec` rather than an `Option` because the count is the whole
/// difference between "there is no such thing" and "there are two, say which",
/// and a resolver that collapsed them would make one of those two sentences
/// impossible to write.
fn among<'a, T>(wrote: &str, here: &'a [T], name: impl Fn(&T) -> &String) -> Vec<&'a T> {
    let wanted = folded(wrote);
    here.iter()
        .filter(|it| folded(name(it)) == wanted)
        .collect()
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
                // The fleet and the retired together: a profile pinned to the
                // retired local host names a machine the asker can see, and
                // rendering it as one they cannot is the mistake
                // `Db::host_named` exists to avoid on the export side.
                &[here.machines.clone(), here.retired.clone()].concat(),
                "a machine you cannot see",
                open,
            ),
            match file.machine.as_deref() {
                None => open.to_string(),
                Some(wrote) => canonical(wrote, &here.machines, |m| &m.name),
            },
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
            match file.account.as_deref() {
                None => "the owner's default for the engine".to_string(),
                Some(wrote) => canonical(wrote, &here.accounts, |a| &a.name),
            },
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
                false => file
                    .delegates_to
                    .iter()
                    .map(|wrote| canonical(wrote, &here.profiles, |r| &r.name))
                    .collect::<Vec<_>>()
                    .join(", "),
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
                    .map(|wrote| match skill_here(wrote, here) {
                        Some(found) => found.qualified(),
                        None => wrote.spelling(),
                    })
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

/// What a name the file wrote resolves to, spelled the way the library spells
/// it.
///
/// **So that a diff compares things rather than spellings.** Resolution is
/// case-insensitive, so a file writing `machine: mac-studio` against a machine
/// called `Mac-Studio` names the same machine — and rendering the file's
/// spelling on one side and the library's on the other would report a change
/// where nothing changes, in a diff whose whole job is to be trusted. Anything
/// that does not resolve has already blocked the bundle, so the fallback is for
/// a reference this plan cannot see the far end of.
fn canonical<T>(wrote: &str, here: &[T], name: impl Fn(&T) -> &String) -> String {
    match among(wrote, here, &name).as_slice() {
        [one] => name(one).clone(),
        _ => wrote.to_string(),
    }
}

/// The skill a reference names, resolved the way `resolve` resolves it.
fn skill_here<'a>(wrote: &profile_md::SkillRef, here: &'a Here) -> Option<&'a SkillHere> {
    let slug = match wrote.directory.as_deref() {
        None => None,
        Some(qualifier) => Some(directory(qualifier, here)?.slug.clone()),
    };
    let mut found = here.skills.iter().filter(|s| {
        folded(&s.name) == folded(&wrote.name)
            && match &slug {
                None => true,
                Some(slug) => s.directory() == Some(slug),
            }
    });
    let first = found.next()?;
    found.next().is_none().then_some(first)
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

/// What cannot be checked about the settings, said rather than left silent.
///
/// The other half of the ruling in `resolve`: a value is **refused** when the
/// engine's set is knowable and **accepted** when it is not, and accepting it
/// quietly would leave somebody believing it was checked. So the two honest
/// unknowns come back as warnings — a plan stays appliable, and the review can
/// say which lines nobody has vouched for.
fn said_about_settings(bundle: &Bundle, said: &Reading) -> Vec<PlanProblem> {
    let mut out = Vec::new();
    for setting in Setting::all() {
        let Some(wrote) = written(setting, &said.profile.settings) else {
            continue;
        };
        let says = match offered(said.profile.engine, setting) {
            Offer::WhenALeadPicks => format!(
                "`{}: {wrote}` is taken as written. Which values are on offer depends on the \
                 engine, and this profile leaves that to whichever lead delegates to it.",
                setting.spelling()
            ),
            Offer::WhenItStarts => format!(
                "`{}: {wrote}` is taken as written. {:?} lists its own {}s when it starts, so \
                 nothing here can say whether that is one of them.",
                setting.spelling(),
                said.profile
                    .engine
                    .expect("only a named engine lists its own"),
                setting.spelling()
            ),
            Offer::NotThisEngine => format!(
                "`{}: {wrote}` would do nothing: {:?} has no {} setting. Remove the line.",
                setting.spelling(),
                said.profile.engine.expect("a named engine has a named gap"),
                setting.spelling()
            ),
            Offer::Values(_) => continue,
        };
        out.push(PlanProblem::at(
            &bundle.path,
            line_of(&said.spelled, Spot::Setting(setting)),
            Some(Spot::Setting(setting).spelling()),
            says,
        ));
    }
    out
}

/// What the file wrote for one setting, if it wrote anything.
fn written(setting: Setting, settings: &ft_core::controls::Preferred) -> Option<&str> {
    match setting {
        Setting::Model => settings.model.as_deref(),
        Setting::Effort => settings.effort.as_deref(),
        Setting::Mode => settings.mode.as_deref(),
        Setting::Sandbox => settings.sandbox.as_deref(),
    }
}

/// What can be said about one setting's value, for one engine.
enum Offer {
    /// These are the values that engine offers. Anything else is a mistake.
    Values(Vec<String>),
    /// The engine lists them itself, once it is running, so nothing here can
    /// check the value. Codex's models and efforts, and only those.
    WhenItStarts,
    /// No engine is pinned, so which set applies is the lead's to decide.
    WhenALeadPicks,
    /// That engine has no such control, so the line would do nothing.
    NotThisEngine,
}

/// Which of the four [`Offer`]s a setting is in.
///
/// Read off `controls::for_agent`, which is the one statement of what an engine
/// can be asked to change — so a control added there is checked here without
/// anybody remembering to come back. Its own doc carries the distinction this
/// depends on: `models` and `efforts` are **passed in** "because one agent
/// knows its own and the other does not", which is why an empty list for
/// Codex's model is "not yet" and an absent sandbox for Claude Code is "never".
fn offered(engine: Option<ft_core::Agent>, setting: Setting) -> Offer {
    let Some(engine) = engine else {
        return Offer::WhenALeadPicks;
    };
    let kind = kind_of(setting);
    let values: Vec<String> = ft_core::controls::for_agent(engine, Vec::new(), Vec::new())
        .into_iter()
        .filter(|c| c.kind == kind)
        .flat_map(|c| c.choices)
        .map(|choice| choice.value)
        .collect();
    if !values.is_empty() {
        return Offer::Values(values);
    }
    match (engine, kind) {
        (
            ft_core::Agent::Codex,
            ft_core::controls::ControlKind::Model | ft_core::controls::ControlKind::Effort,
        ) => Offer::WhenItStarts,
        _ => Offer::NotThisEngine,
    }
}

/// `a model`, `an effort` — so a refusal reads as a sentence.
fn article(setting: Setting) -> String {
    let word = setting.spelling();
    match word.starts_with(['a', 'e', 'i', 'o', 'u']) {
        true => format!("an {word}"),
        false => format!("a {word}"),
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
                "{} in this drop is also called `{name}`. They are told apart by their folders, \
                 so both can exist; this is only worth knowing.",
                others.join(" and ")
            ),
        ));
    }
}

/// Why this plan cannot be applied, in sentences.
///
/// **The whole of `appliable`.** Empty means it applies, and anything that
/// makes a plan unappliable has to put a sentence here or it is not a reason —
/// see the comment in [`plan`].
fn why_not(entries: &[PlanEntry], ignored: &[String]) -> Vec<String> {
    // Nothing to apply is a reason of its own, and the one a person meets
    // first: they dropped the wrong folder, or a `.zip` that unpacked into a
    // level they did not expect.
    if entries.is_empty() {
        return vec![match ignored.len() {
            0 => "There is nothing in what you dropped. A profile bundle is a folder with a \
                  `PROFILE.md` in it."
                .to_string(),
            1 => "Nothing in what you dropped is a profile bundle, and one file was ignored. A \
                  bundle is a folder with a `PROFILE.md` in it, so drop the folder that holds \
                  those folders."
                .to_string(),
            n => format!(
                "Nothing in what you dropped is a profile bundle, and {n} files were ignored. A \
                 bundle is a folder with a `PROFILE.md` in it, so drop the folder that holds \
                 those folders."
            ),
        }];
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A profile in the library, with every field at what a new one gets.
    ///
    /// Named rather than `Default::default()` because `Role` has no default and
    /// should not: a row with no path is not a thing that can exist, and a
    /// fixture that invents one would be testing against a shape the database
    /// cannot hold.
    fn row(id: &str, name: &str, key: Option<&str>) -> Role {
        Role {
            id: id.into(),
            path: format!("u/kevin/{}_01m3qbzd", name.to_lowercase().replace(' ', "_")),
            key: key.map(str::to_string),
            name: name.into(),
            does: "reads a branch and reports problems".into(),
            placement: "lead".into(),
            agent: None,
            machine: None,
            account: None,
            settings: Default::default(),
            instructions: String::new(),
            on_usage_limit: "wait".into(),
            on_child_limit: "ask".into(),
            can_delegate: false,
            delegate_scope: vec![],
            include_always_on: true,
            include_repo_defaults: true,
            skill_scope: vec![],
            may_write: true,
            may_share: true,
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    fn here(profiles: Vec<Role>) -> Here {
        Here {
            profiles,
            ..Default::default()
        }
    }

    fn machine(id: &str, name: &str) -> Named {
        Named {
            id: id.into(),
            name: name.into(),
        }
    }

    fn subscription(id: &str, name: &str, engine: &str) -> Subscription {
        Subscription {
            id: id.into(),
            name: name.into(),
            engine: engine.into(),
        }
    }

    fn folder(name: &str, may_write: bool) -> Dir {
        Dir {
            id: format!("dir_{name}"),
            name: name.into(),
            slug: name.to_lowercase(),
            may_write,
        }
    }

    fn skill(id: &str, name: &str, path: &str) -> SkillHere {
        SkillHere {
            id: id.into(),
            name: name.into(),
            path: path.into(),
        }
    }

    /// A bundle: the file, and the folder it is in.
    fn at(path: &str, frontmatter: &str, body: &str) -> DroppedFile {
        DroppedFile {
            path: path.into(),
            text: format!("---\n{frontmatter}---\n{body}"),
        }
    }

    /// The smallest file that is a profile: a name and a line about it.
    fn smallest(name: &str) -> String {
        format!("name: {name}\ndoes: does the thing\n")
    }

    fn dropped(files: Vec<DroppedFile>) -> ProfileDrop {
        ProfileDrop {
            files,
            answers: vec![],
        }
    }

    fn only(plan: &ImportPlan) -> &PlanEntry {
        assert_eq!(plan.entries.len(), 1, "{:#?}", plan.entries);
        &plan.entries[0]
    }

    fn blocked(entry: &PlanEntry) -> &[PlanProblem] {
        match &entry.outcome {
            PlanOutcome::Blocked(b) => &b.problems,
            other => panic!("expected a block, got {other:#?}"),
        }
    }

    fn said(entry: &PlanEntry) -> String {
        blocked(entry)
            .iter()
            .map(|p| p.says.clone())
            .collect::<Vec<_>>()
            .join(" / ")
    }

    fn field<'a>(diff: &'a [FieldDiff], name: &str) -> &'a FieldDiff {
        diff.iter()
            .find(|f| f.field == name)
            .unwrap_or_else(|| panic!("no `{name}` row in the diff"))
    }

    fn diff_of(entry: &PlanEntry) -> &[FieldDiff] {
        match &entry.outcome {
            PlanOutcome::Overwrite(o) => &o.diff,
            PlanOutcome::Rename(r) => &r.diff,
            other => panic!("expected a diff, got {other:#?}"),
        }
    }

    /// Criterion: the folder's name is the key, and nothing of that key being
    /// here makes it new.
    #[test]
    fn a_bundle_nothing_answers_to_is_new() {
        let plan = plan(
            &dropped(vec![at(
                "profiles/designer/PROFILE.md",
                &smallest("Designer"),
                "",
            )]),
            &here(vec![row("r1", "Engineer", None)]),
        )
        .unwrap();
        let entry = only(&plan);
        assert_eq!(entry.key, "designer");
        assert!(
            matches!(&entry.outcome, PlanOutcome::New(n) if n.filed == "your own space"),
            "{:#?}",
            entry.outcome
        );
        assert!(plan.appliable);
    }

    /// Criterion: same key, different `name`, reported as a rename — old and
    /// new — rather than as a create.
    #[test]
    fn the_same_key_under_a_new_name_is_a_rename() {
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                &smallest("Product Designer"),
                "",
            )]),
            &here(vec![row("r1", "Designer", Some("designer"))]),
        )
        .unwrap();
        let entry = only(&plan);
        let PlanOutcome::Rename(renamed) = &entry.outcome else {
            panic!("expected a rename, got {:#?}", entry.outcome)
        };
        assert_eq!(renamed.from, "Designer");
        assert_eq!(renamed.to, "Product Designer");
        assert!(!renamed.adopts_key);
        // The rename is also in the diff, because the write behind it is the
        // same whole-object update and the other fifteen fields have to be
        // readable.
        assert_eq!(field(&renamed.diff, "name").change, FieldChange::Changed);
        assert_eq!(renamed.diff.len(), 16);
    }

    /// Criteria: same key and name is an overwrite, and the diff carries all
    /// sixteen fields.
    #[test]
    fn the_same_key_and_name_is_an_overwrite_of_all_sixteen_fields() {
        let plan = plan(
            &dropped(vec![at("designer/PROFILE.md", &smallest("Designer"), "")]),
            &here(vec![row("r1", "Designer", Some("designer"))]),
        )
        .unwrap();
        let entry = only(&plan);
        assert!(
            matches!(&entry.outcome, PlanOutcome::Overwrite(o) if !o.adopts_key),
            "{:#?}",
            entry.outcome
        );
        let diff = diff_of(entry);
        assert_eq!(diff.len(), 16, "{:#?}", diff);
        let fields: Vec<&str> = diff.iter().map(|f| f.field.as_str()).collect();
        assert!(
            !fields.contains(&"key"),
            "the key is the identity: {fields:?}"
        );
        assert!(fields.contains(&"instructions"), "{fields:?}");
        assert!(fields.contains(&"settings"), "{fields:?}");
    }

    /// Criterion: a key absent from the file is a **reset** and marked as its
    /// own kind of change — and a key that spells its own default is an
    /// ordinary value, because somebody who writes the default has said
    /// something.
    #[test]
    fn a_deleted_line_is_a_reset_and_a_spelled_default_is_not() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.can_delegate = true;
        stored.include_always_on = false;

        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                // `can_delegate` is gone, which returns it to false. The
                // inheritance switch is written at the value it already
                // defaults to, which is not an event.
                "name: Designer\ndoes: does the thing\ninclude_always_on: true\n",
                "",
            )]),
            &here(vec![stored]),
        )
        .unwrap();
        let diff = diff_of(only(&plan));
        assert_eq!(field(diff, "can_delegate").change, FieldChange::Reset);
        assert_eq!(field(diff, "can_delegate").before, "true");
        assert_eq!(field(diff, "can_delegate").after, "false");
        assert_eq!(
            field(diff, "include_always_on").change,
            FieldChange::Changed,
            "a line somebody wrote is a change, whatever it says"
        );
        assert_eq!(field(diff, "name").change, FieldChange::Unchanged);
    }

    /// Criterion: a reset under `settings` names the **resulting value**, not
    /// the words "the engine's default".
    #[test]
    fn a_reset_setting_names_what_will_actually_run() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.agent = Some("ClaudeCode".into());
        stored.settings.model = Some("haiku".into());

        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nengine: ClaudeCode\n",
                "",
            )]),
            &here(vec![stored]),
        )
        .unwrap();
        let diff = diff_of(only(&plan));
        let settings = &field(diff, "settings").settings;
        let model = settings
            .iter()
            .find(|s| s.setting == "model")
            .expect("a model row");
        assert_eq!(model.change, FieldChange::Reset);
        assert!(model.before.contains("haiku"), "{}", model.before);
        // The value an unset model takes for Claude Code, named — and said as
        // a label rather than as a bare alias.
        let will = ft_core::controls::default_value(
            ft_core::Agent::ClaudeCode,
            ft_core::controls::ControlKind::Model,
        )
        .expect("Claude Code has a default model");
        assert!(model.after.contains(will), "{}", model.after);
        assert!(
            !model.after.contains("engine's default"),
            "a reset names the value, not the words: {}",
            model.after
        );
        // The four reset independently, so the row above is not the whole of
        // what `settings` says.
        assert_eq!(settings.len(), 4);
    }

    /// Criterion: the instructions diff as a changed-line count plus a unified
    /// diff.
    #[test]
    fn the_instructions_diff_as_a_count_and_a_unified_diff() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.instructions = "One.\nTwo.\nThree.\n".into();

        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                &smallest("Designer"),
                "One.\nTwo changed.\nThree.\n",
            )]),
            &here(vec![stored]),
        )
        .unwrap();
        let diff = diff_of(only(&plan));
        let body = field(diff, "instructions").body.as_ref().expect("a body");
        assert_eq!(body.added, 1);
        assert_eq!(body.removed, 1);
        assert_eq!(body.changed_lines, 2);
        assert!(body.unified.contains("-Two."), "{}", body.unified);
        assert!(body.unified.contains("+Two changed."), "{}", body.unified);
        assert_eq!(field(diff, "instructions").change, FieldChange::Changed);
    }

    /// Deleting the markdown under the frontmatter is a reset: an absent body
    /// is the documented default, which is the empty one.
    #[test]
    fn deleting_the_instructions_is_a_reset() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.instructions = "One.\n".into();
        let plan = plan(
            &dropped(vec![at("designer/PROFILE.md", &smallest("Designer"), "")]),
            &here(vec![stored]),
        )
        .unwrap();
        assert_eq!(
            field(diff_of(only(&plan)), "instructions").change,
            FieldChange::Reset
        );
    }

    /// The live case, from `fixtures/profiles/fstack-repaired/qa-engineer`: the
    /// folder is `qa-engineer/` and the library profile is called `QA`.
    ///
    /// **Never a create.** A second profile beside the first is what a naive
    /// importer does here and is the failure this plan exists to prevent. The
    /// exported file carries the live name, so the name is an exact match on a
    /// row with no key of its own — which is the one case the fallback is
    /// certain about, and it adopts the key rather than asking. See the pull
    /// request: the specification's two readings of this disagree, and this is
    /// the one that does not make every first import of a library a dozen
    /// questions whose answer is obviously yes.
    #[test]
    fn qa_engineer_against_a_library_profile_called_qa_is_never_a_create() {
        let text = std::fs::read_to_string(
            "../../fixtures/profiles/fstack-repaired/qa-engineer/PROFILE.md",
        )
        .expect("the repaired fixture");
        let plan = plan(
            &dropped(vec![DroppedFile {
                path: "profiles/qa-engineer/PROFILE.md".into(),
                text,
            }]),
            &here(vec![row("r1", "QA", None)]),
        )
        .unwrap();
        let entry = only(&plan);
        let PlanOutcome::Overwrite(over) = &entry.outcome else {
            panic!("expected an overwrite of QA, got {:#?}", entry.outcome)
        };
        assert_eq!(over.profile.name, "QA");
        assert!(
            over.adopts_key,
            "the row has no key, so this is where it gets one"
        );
        assert!(plan.appliable);
    }

    /// Criteria: a bundle matching neither key nor name, but resembling an
    /// existing profile, is a **candidate** — carrying the proposed row's name,
    /// its key and why it was proposed — and an unanswered candidate makes the
    /// plan unappliable.
    #[test]
    fn a_folder_that_resembles_a_profile_is_one_unanswered_candidate() {
        let plan = plan(
            &dropped(vec![at(
                "profiles/qa-engineer/PROFILE.md",
                &smallest("QA Engineer"),
                "",
            )]),
            &here(vec![row("r1", "QA", None), row("r2", "Engineer", None)]),
        )
        .unwrap();
        let entry = only(&plan);
        let PlanOutcome::Candidate(candidate) = &entry.outcome else {
            panic!("expected a candidate, got {:#?}", entry.outcome)
        };
        assert_eq!(candidate.proposals.len(), 1, "{:#?}", candidate.proposals);
        let proposed = &candidate.proposals[0];
        assert_eq!(proposed.profile.name, "QA");
        assert_eq!(proposed.profile.key, None);
        assert_eq!(proposed.why, ProposalWhy::LikeName);
        assert!(!proposed.says.is_empty());
        assert!(!plan.appliable);
        assert!(
            plan.why_not.iter().any(|w| w.contains("only you can say")),
            "{:#?}",
            plan.why_not
        );
    }

    /// A name differing only by case or surrounding whitespace is a candidate
    /// too, with its own reason — it is usually the same profile and is not
    /// always.
    #[test]
    fn a_name_differing_only_by_case_is_a_candidate() {
        let plan = plan(
            &dropped(vec![at("designer/PROFILE.md", &smallest("designer"), "")]),
            &here(vec![row("r1", "Designer", None)]),
        )
        .unwrap();
        let PlanOutcome::Candidate(candidate) = &only(&plan).outcome else {
            panic!("expected a candidate")
        };
        assert_eq!(candidate.proposals[0].why, ProposalWhy::NearName);
    }

    /// An answer decides, both ways, and a candidate that has been answered is
    /// drawn as the instruction being carried out rather than as a finding.
    #[test]
    fn answering_a_candidate_resolves_it_either_way() {
        let drop = |answer: Option<CandidateDecision>| ProfileDrop {
            files: vec![at("qa-engineer/PROFILE.md", &smallest("QA Engineer"), "")],
            answers: answer
                .map(|answer| {
                    vec![CandidateAnswer {
                        key: "qa-engineer".into(),
                        answer,
                    }]
                })
                .unwrap_or_default(),
        };
        let library = here(vec![row("r1", "QA", None)]);

        let same = plan(
            &drop(Some(CandidateDecision::SameProfile {
                profile: "r1".into(),
            })),
            &library,
        )
        .unwrap();
        let PlanOutcome::Rename(renamed) = &only(&same).outcome else {
            panic!("expected a rename, got {:#?}", only(&same).outcome)
        };
        assert!(renamed.answered && renamed.adopts_key);
        assert_eq!(renamed.from, "QA");
        assert!(same.appliable);

        let fresh = plan(&drop(Some(CandidateDecision::NewProfile)), &library).unwrap();
        assert!(
            matches!(&only(&fresh).outcome, PlanOutcome::New(n) if n.answered),
            "{:#?}",
            only(&fresh).outcome
        );
        assert!(fresh.appliable);
    }

    /// An answer is data from a client, so it is re-resolved rather than
    /// trusted: a profile the asker cannot see is not one they can be told
    /// about, and not one this plan will write.
    #[test]
    fn an_answer_naming_a_profile_the_asker_cannot_see_blocks() {
        let plan = plan(
            &ProfileDrop {
                files: vec![at("designer/PROFILE.md", &smallest("Designer"), "")],
                answers: vec![CandidateAnswer {
                    key: "designer".into(),
                    answer: CandidateDecision::SameProfile {
                        profile: "r_somebody_elses".into(),
                    },
                }],
            },
            &here(vec![row("r1", "Engineer", None)]),
        )
        .unwrap();
        assert!(
            said(only(&plan)).contains("not one available to you"),
            "{}",
            said(only(&plan))
        );
        assert!(!plan.appliable);
    }

    /// Criterion (corrected by the threat model): two bundles in one drop with
    /// the same key are blocked **explicitly**. A filesystem folder cannot hold
    /// two folders of one name; an archive and a direct API call both can.
    #[test]
    fn two_bundles_sharing_a_key_are_blocked() {
        let plan = plan(
            &dropped(vec![
                at("one/designer/PROFILE.md", &smallest("Designer"), ""),
                at("two/designer/PROFILE.md", &smallest("Also Designer"), ""),
            ]),
            &here(vec![]),
        )
        .unwrap();
        assert_eq!(plan.entries.len(), 2);
        for entry in &plan.entries {
            assert!(
                said(entry).contains("is also a bundle for `designer`"),
                "{}",
                said(entry)
            );
        }
        assert!(!plan.appliable);
    }

    /// Criterion (threat model): two bundles resolving to the same overwrite
    /// target are blocked — the last write would otherwise silently win.
    #[test]
    fn two_bundles_resolving_to_one_profile_are_blocked() {
        let plan = plan(
            &ProfileDrop {
                files: vec![
                    at("designer/PROFILE.md", &smallest("Designer"), ""),
                    at("design/PROFILE.md", &smallest("Design"), ""),
                ],
                // Two different keys, one answered onto the row the other
                // matches by name.
                answers: vec![CandidateAnswer {
                    key: "design".into(),
                    answer: CandidateDecision::SameProfile {
                        profile: "r1".into(),
                    },
                }],
            },
            &here(vec![row("r1", "Designer", None)]),
        )
        .unwrap();
        for entry in &plan.entries {
            assert!(
                said(entry).contains("both resolve to the profile `Designer`"),
                "{}",
                said(entry)
            );
        }
        assert!(!plan.appliable);
    }

    /// Criterion: two bundles sharing a `name` warn rather than block. With the
    /// key as the identity they are simply two profiles.
    #[test]
    fn two_bundles_sharing_a_name_warn_rather_than_block() {
        let plan = plan(
            &dropped(vec![
                at("designer/PROFILE.md", &smallest("Designer"), ""),
                at("designer-2/PROFILE.md", &smallest("Designer"), ""),
            ]),
            &here(vec![]),
        )
        .unwrap();
        for entry in &plan.entries {
            assert!(
                matches!(entry.outcome, PlanOutcome::New(_)),
                "{:#?}",
                entry.outcome
            );
            assert_eq!(entry.warnings.len(), 1, "{:#?}", entry.warnings);
            assert!(entry.warnings[0].says.contains("also called `Designer`"));
        }
        assert!(plan.appliable, "a warning never makes a plan unappliable");
    }

    // ── resolution, and what it is allowed to know ──────────────────────

    /// Criterion: an unresolved name blocks, and says what it says.
    ///
    /// *"available to you"*, never *"no such machine"* — the wording follows
    /// from resolving inside what the asker can see rather than filtering
    /// afterwards.
    #[test]
    fn an_unresolved_machine_blocks_and_never_says_it_does_not_exist() {
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nmachine: mac-studio\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let problems = blocked(only(&plan));
        assert_eq!(problems.len(), 1, "{problems:#?}");
        assert!(
            problems[0]
                .says
                .contains("no machine named `mac-studio` is available to you"),
            "{}",
            problems[0].says
        );
        // Every error carries `{path, line}`, pointing at the line that named
        // the thing rather than at the file.
        assert_eq!(problems[0].path, "designer/PROFILE.md");
        assert_eq!(problems[0].line, 4);
        assert_eq!(problems[0].key.as_deref(), Some("machine"));
    }

    /// A machine that resolves raises nothing — and two of one name is said as
    /// what it is, because "not available to you" about something there are two
    /// of is a sentence nobody can act on.
    #[test]
    fn a_machine_resolves_by_name_and_two_of_one_name_is_said_as_that() {
        let file = at(
            "designer/PROFILE.md",
            "name: Designer\ndoes: does the thing\nmachine: mac-studio\n",
            "",
        );
        let mut library = here(vec![]);
        library.machines = vec![machine("h1", "Mac-Studio")];
        let one = plan(&dropped(vec![file.clone()]), &library).unwrap();
        assert!(
            matches!(only(&one).outcome, PlanOutcome::New(_)),
            "a name resolves whatever its capitals: {:#?}",
            only(&one).outcome
        );

        library.machines.push(machine("h2", "mac-studio"));
        let two = plan(&dropped(vec![file]), &library).unwrap();
        assert!(
            said(only(&two)).contains("2 machines you can see are called `mac-studio`"),
            "{}",
            said(only(&two))
        );
    }

    /// The enumeration oracle, closed: a machine that exists and is somebody
    /// else's reads **exactly** as one that does not exist at all.
    #[test]
    fn a_machine_the_asker_cannot_see_reads_as_one_that_is_not_there() {
        let file = at(
            "designer/PROFILE.md",
            "name: Designer\ndoes: does the thing\nmachine: mac-studio\n",
            "",
        );
        let nowhere = plan(&dropped(vec![file.clone()]), &here(vec![])).unwrap();
        // The same installation, with the machine in it — and the asker holding
        // no grant on it, so it is not in what they can see.
        let theirs = plan(&dropped(vec![file]), &here(vec![])).unwrap();
        assert_eq!(said(only(&nowhere)), said(only(&theirs)));
    }

    /// A machine that was **removed from the fleet** is not a machine the asker
    /// cannot see, and the two sentences have to differ.
    ///
    /// `20261106120000_retire_local_host.sql` left every profile pinned to the
    /// retired local host pinned, so a profile really can name one and
    /// `#354`'s export really does write its name. The import still blocks —
    /// nothing runs there — and the stored pin still renders as the machine it
    /// is, which is the same mistake `Db::host_named` exists to avoid from the
    /// other side.
    #[test]
    fn a_retired_machine_is_told_apart_from_one_you_cannot_see() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.machine = Some("h_gone".into());
        let mut library = here(vec![stored]);
        library.retired = vec![machine("h_gone", "this-mac")];

        let pinned = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nmachine: this-mac\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let says = said(only(&pinned));
        assert!(says.contains("was removed from the fleet"), "{says}");
        assert!(
            !says.contains("available to you"),
            "a machine on their own Compute screen is not one they cannot see: {says}"
        );
        // It says what to do about it, which is what a blocking message is for.
        assert!(
            says.contains("Write a machine that is still in it"),
            "{says}"
        );

        // And the pair that has to stay one sentence stays one sentence: a
        // machine somebody else can see reads exactly as a name this
        // installation has never held. Three states, two sentences.
        let hidden = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nmachine: someone-elses\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let nowhere = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nmachine: never-existed\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert_eq!(
            said(only(&hidden)).replace("someone-elses", "·"),
            said(only(&nowhere)).replace("never-existed", "·"),
            "a hidden machine and one that never existed have to read alike"
        );

        // And the stored pin is named rather than hidden, which is only
        // visible once the file stops blocking.
        let unpinned = plan(
            &dropped(vec![at("designer/PROFILE.md", &smallest("Designer"), "")]),
            &library,
        )
        .unwrap();
        let diff = diff_of(only(&unpinned));
        assert_eq!(field(diff, "machine").before, "this-mac");
        assert_eq!(field(diff, "machine").change, FieldChange::Reset);
    }

    /// Criterion: a `directory` you may read but not write blocks **at plan
    /// time**, not during apply — an accepted plan has to be one that applies.
    /// Saying so about a directory they can already see is deliberate and safe.
    #[test]
    fn a_directory_you_may_read_but_not_write_blocks_at_plan_time() {
        let mut library = here(vec![]);
        library.directories = vec![folder("Fstack", false)];
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\ndirectory: Fstack\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&plan)).contains("you can look in `Fstack` but not file anything there"),
            "{}",
            said(only(&plan))
        );
    }

    /// And a directory nobody has shown them is the same answer as one that is
    /// not there.
    #[test]
    fn a_directory_that_does_not_resolve_blocks() {
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\ndirectory: Fstack\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        assert!(
            said(only(&plan)).contains("no directory named `Fstack` is available to you"),
            "{}",
            said(only(&plan))
        );
    }

    /// A directory they may write is where the new profile would be filed, and
    /// the slug in a path answers as well as the name on the screen.
    #[test]
    fn a_directory_resolves_by_its_name_or_its_slug() {
        let mut library = here(vec![]);
        library.directories = vec![folder("Fstack", true)];
        for wrote in ["Fstack", "fstack"] {
            let plan = plan(
                &dropped(vec![at(
                    "designer/PROFILE.md",
                    &format!("name: Designer\ndoes: does the thing\ndirectory: {wrote}\n"),
                    "",
                )]),
                &library,
            )
            .unwrap();
            assert!(
                matches!(&only(&plan).outcome, PlanOutcome::New(n) if n.filed == "Fstack"),
                "{wrote}: {:#?}",
                only(&plan).outcome
            );
        }
    }

    /// Criterion: a skill the importer cannot reach **blocks** rather than
    /// being silently stripped. A skill is executable, and a profile that
    /// quietly loads less than its file says is one nobody can review.
    #[test]
    fn a_skill_the_importer_cannot_reach_blocks() {
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nskills:\n  - dataviz\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let problems = blocked(only(&plan));
        assert!(
            problems[0]
                .says
                .contains("no skill named `dataviz` is available to you"),
            "{}",
            problems[0].says
        );
        // The entry, not the key: `Spot::Entry` is what makes this possible.
        assert_eq!(problems[0].key.as_deref(), Some("skills[0]"));
        assert_eq!(problems[0].line, 5);
    }

    /// Criterion: a colliding skill name blocks, naming both skills and where
    /// each lives. Two bare names that resolve to two skills of one name is the
    /// set the delivery side already refuses, because a skill's folder on a
    /// worker **is** its name.
    #[test]
    fn a_colliding_skill_name_blocks_naming_both_and_where_each_lives() {
        let mut library = here(vec![]);
        library.directories = vec![folder("Firetower", true), folder("House", true)];
        library.skills = vec![
            skill("sk1", "dataviz", "d/firetower/dataviz"),
            skill("sk2", "dataviz", "d/house/dataviz"),
        ];

        // Written bare, it is ambiguous: two skills the asker can see answer to
        // the name, and the qualifier exists for exactly this.
        let bare = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nskills:\n  - dataviz\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let says = said(only(&bare));
        assert!(
            says.contains("2 skills you can see are called `dataviz`"),
            "{says}"
        );
        assert!(
            says.contains("`firetower/dataviz`") && says.contains("`house/dataviz`"),
            "{says}"
        );

        // Written as both, each resolves — and the pair still cannot be
        // delivered, so it blocks, naming both and where each lives.
        let both = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nskills:\n  - firetower/dataviz\n  - house/dataviz\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let says = said(only(&both));
        assert!(says.contains("share the name `dataviz`"), "{says}");
        assert!(
            says.contains("`firetower/dataviz`") && says.contains("`house/dataviz`"),
            "{says}"
        );
        assert!(says.contains("folder on a worker is its name"), "{says}");
    }

    /// A qualifier the asker cannot see is the same answer every unresolved
    /// name gets, and a skill that resolves raises nothing at all.
    #[test]
    fn a_qualified_skill_resolves_and_an_unknown_qualifier_blocks() {
        let mut library = here(vec![]);
        library.directories = vec![folder("Firetower", true)];
        library.skills = vec![skill("sk1", "dataviz", "d/firetower/dataviz")];

        let good = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nskills:\n  - firetower/dataviz\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            matches!(only(&good).outcome, PlanOutcome::New(_)),
            "{:#?}",
            only(&good).outcome
        );

        let bad = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nskills:\n  - house/dataviz\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&bad)).contains("no directory named `house` is available to you"),
            "{}",
            said(only(&bad))
        );
    }

    /// Criterion: intra-bundle references resolve — a teammate present only
    /// elsewhere in the drop does not block, whether or not it exists here yet.
    #[test]
    fn a_teammate_present_only_elsewhere_in_the_drop_does_not_block() {
        let plan = plan(
            &dropped(vec![
                at(
                    "manager/PROFILE.md",
                    "name: Manager\ndoes: hands work out\ncan_delegate: true\ndelegates_to:\n  - Designer\n",
                    "",
                ),
                at("designer/PROFILE.md", &smallest("Designer"), ""),
            ]),
            &here(vec![]),
        )
        .unwrap();
        for entry in &plan.entries {
            assert!(
                matches!(entry.outcome, PlanOutcome::New(_)),
                "{}: {:#?}",
                entry.path,
                entry.outcome
            );
        }
        assert!(plan.appliable);
    }

    /// And one that is in neither blocks, saying both halves of where it looked.
    #[test]
    fn an_unresolved_teammate_blocks() {
        let plan = plan(
            &dropped(vec![at(
                "manager/PROFILE.md",
                "name: Manager\ndoes: hands work out\ndelegates_to:\n  - Designer\n  - QA\n",
                "",
            )]),
            &here(vec![row("r1", "Designer", None)]),
        )
        .unwrap();
        let problems = blocked(only(&plan));
        assert_eq!(problems.len(), 1, "{problems:#?}");
        assert!(
            problems[0]
                .says
                .contains("no profile named `QA` is available to you"),
            "{}",
            problems[0].says
        );
        assert_eq!(problems[0].key.as_deref(), Some("delegates_to[1]"));
        assert_eq!(problems[0].line, 6, "the second entry, not the key");
    }

    /// The thirteenth row of the error table: a profile naming **itself** in
    /// `delegates_to`, which is blocked and names the profile.
    ///
    /// Blocked while a cycle *between* profiles is permitted, which is
    /// deliberate rather than inconsistent — see the comment in `resolve`. Two
    /// spellings of the same mistake: the file's own `name`, and a file that
    /// renames a profile while still naming the row it is about to overwrite.
    #[test]
    fn a_profile_that_names_itself_is_blocked_and_told_which_profile() {
        let plain = plan(
            &dropped(vec![at(
                "manager/PROFILE.md",
                "name: Manager\ndoes: hands work out\ncan_delegate: true\ndelegates_to:\n  - Manager\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let problems = blocked(only(&plain));
        assert_eq!(problems.len(), 1, "{problems:#?}");
        assert!(
            problems[0].says.contains("`Manager` is this profile"),
            "{}",
            problems[0].says
        );
        assert_eq!(problems[0].key.as_deref(), Some("delegates_to[0]"));
        assert_eq!(problems[0].line, 6);

        // The same mistake under a rename: the entry resolves to the row this
        // bundle is about to overwrite, and `delegate_scope` holds ids.
        let renamed = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Product Designer\ndoes: designs\ndelegates_to:\n  - Designer\n",
                "",
            )]),
            &here(vec![row("r1", "Designer", Some("designer"))]),
        )
        .unwrap();
        // The value the **file wrote**, backticked, not the name the file
        // gives: a regression that stopped naming the offending entry would
        // pass an assertion on the sentence alone.
        let says = said(only(&renamed));
        assert!(
            says.contains("`Designer` is the profile this bundle overwrites"),
            "{says}"
        );
        assert!(says.contains("`Product Designer`"), "{says}");
    }

    /// And a cycle **between** profiles resolves, because it is a library
    /// somebody might mean. If these two rules ever have to agree, the
    /// direction is permitting self-delegation — never blocking cycles.
    #[test]
    fn a_cycle_between_two_profiles_is_permitted() {
        let plan = plan(
            &dropped(vec![
                at(
                    "manager/PROFILE.md",
                    "name: Manager\ndoes: hands work out\ncan_delegate: true\ndelegates_to:\n  - Designer\n",
                    "",
                ),
                at(
                    "designer/PROFILE.md",
                    "name: Designer\ndoes: designs\ncan_delegate: true\ndelegates_to:\n  - Manager\n",
                    "",
                ),
            ]),
            &here(vec![]),
        )
        .unwrap();
        for entry in &plan.entries {
            assert!(
                matches!(entry.outcome, PlanOutcome::New(_)),
                "{}: {:#?}",
                entry.path,
                entry.outcome
            );
        }
        assert!(plan.appliable);
    }

    /// A name two visible profiles answer to cannot be resolved for somebody,
    /// and the refusal names only what they can already see.
    #[test]
    fn an_ambiguous_teammate_blocks_naming_only_what_the_asker_can_see() {
        let plan = plan(
            &dropped(vec![at(
                "manager/PROFILE.md",
                "name: Manager\ndoes: hands work out\ndelegates_to:\n  - Designer\n",
                "",
            )]),
            &here(vec![
                row("r1", "Designer", None),
                row("r2", "Designer", Some("designer-2")),
            ]),
        )
        .unwrap();
        let says = said(only(&plan));
        assert!(
            says.contains("2 profiles you can see are called `Designer`"),
            "{says}"
        );
        assert!(says.contains("u/kevin/designer_01m3qbzd"), "{says}");
    }

    /// A subscription pins an engine on the write path, so a file that names
    /// one without an engine is blocked at plan time rather than at apply —
    /// and one for another engine is named rather than quietly accepted.
    #[test]
    fn a_subscription_needs_an_engine_and_has_to_be_for_it() {
        let mut library = here(vec![]);
        library.accounts = vec![subscription("aa1", "Personal", "Codex")];

        let no_engine = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\naccount: Personal\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&no_engine)).contains("has to pin one too"),
            "{}",
            said(only(&no_engine))
        );

        let wrong_engine = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nengine: ClaudeCode\naccount: Personal\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&wrong_engine)).contains("authenticates Codex"),
            "{}",
            said(only(&wrong_engine))
        );

        let unknown = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nengine: ClaudeCode\naccount: Startup\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&unknown)).contains("no subscription named `Startup` is available to you"),
            "{}",
            said(only(&unknown))
        );
    }

    /// A diff compares the things a file names, not the way it spells them.
    ///
    /// Resolution is case-insensitive, so `machine: mac-studio` against a
    /// machine called `Mac-Studio` is the same machine — and a diff that
    /// reported a change there would be one nobody could trust the next time.
    #[test]
    fn a_reference_diffs_as_what_it_resolves_to_rather_than_how_it_is_spelled() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.machine = Some("h1".into());
        stored.skill_scope = vec!["sk1".into()];
        let mut library = here(vec![stored]);
        library.machines = vec![machine("h1", "Mac-Studio")];
        library.directories = vec![folder("Firetower", true)];
        library.skills = vec![skill("sk1", "dataviz", "d/firetower/dataviz")];

        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                // The machine in other capitals, and the skill written bare
                // where the library has it in a directory.
                "name: Designer\ndoes: does the thing\nmachine: mac-studio\nskills:\n  - dataviz\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let diff = diff_of(only(&plan));
        assert_eq!(field(diff, "machine").change, FieldChange::Unchanged);
        assert_eq!(field(diff, "machine").after, "Mac-Studio");
        assert_eq!(field(diff, "skills").change, FieldChange::Unchanged);
        assert_eq!(field(diff, "skills").after, "firetower/dataviz");
    }

    /// A folder renamed is a **new profile** beside the original, said as one
    /// rather than offered as a match: the key is the identity, and a row that
    /// carries one has said what it is. Two profiles of one name is rarely what
    /// somebody meant, so it is a warning — not a question that would stop the
    /// drop.
    #[test]
    fn renaming_a_folder_is_a_new_profile_with_a_warning_rather_than_a_candidate() {
        let plan = plan(
            &dropped(vec![at("designer-2/PROFILE.md", &smallest("Designer"), "")]),
            &here(vec![row("r1", "Designer", Some("designer"))]),
        )
        .unwrap();
        let entry = only(&plan);
        assert!(
            matches!(entry.outcome, PlanOutcome::New(_)),
            "{:#?}",
            entry.outcome
        );
        assert_eq!(entry.warnings.len(), 1, "{:#?}", entry.warnings);
        assert!(
            entry.warnings[0].says.contains("already in your library"),
            "{}",
            entry.warnings[0].says
        );
        assert!(plan.appliable);
    }

    /// Criterion: an overwrite diff does not reveal old values from something
    /// the asker cannot read. A profile shared into a directory can pin a
    /// machine, a subscription and teammates in its author's own space.
    #[test]
    fn an_overwrite_diff_never_names_what_the_asker_cannot_see() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.machine = Some("h_theirs".into());
        stored.account = Some("aa_theirs".into());
        stored.delegate_scope = vec!["r_theirs".into()];
        stored.skill_scope = vec!["sk_theirs".into()];

        let plan = plan(
            &dropped(vec![at("designer/PROFILE.md", &smallest("Designer"), "")]),
            &here(vec![stored]),
        )
        .unwrap();
        let diff = diff_of(only(&plan));
        assert_eq!(field(diff, "machine").before, "a machine you cannot see");
        assert_eq!(
            field(diff, "account").before,
            "a subscription you cannot see"
        );
        assert_eq!(
            field(diff, "delegates_to").before,
            "a profile you cannot see"
        );
        assert_eq!(field(diff, "skills").before, "a skill you cannot see");
        for row in diff {
            assert!(
                !row.before.contains("theirs"),
                "`{}` leaked an id: {}",
                row.field,
                row.before
            );
        }
    }

    /// A row they can see and cannot write is said out loud — they already
    /// know it exists, so the only new fact is the grant they would need.
    #[test]
    fn a_profile_you_may_read_but_not_write_blocks() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.may_write = false;
        stored.path = "d/fstack/designer_01m3qbzd".into();
        let plan = plan(
            &dropped(vec![at("designer/PROFILE.md", &smallest("Designer"), "")]),
            &here(vec![stored]),
        )
        .unwrap();
        assert!(
            said(only(&plan)).contains("without being able to change it"),
            "{}",
            said(only(&plan))
        );
    }

    /// An import cannot move a profile — `directory` is honoured when one is
    /// created, and moving one is a sharing operation. A file that says
    /// otherwise is told so rather than having the line quietly ignored.
    #[test]
    fn a_file_that_would_move_an_existing_profile_blocks() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.path = "u/kevin/designer_01m3qbzd".into();
        let mut library = here(vec![stored]);
        library.directories = vec![folder("Fstack", true)];
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\ndirectory: Fstack\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&plan)).contains("An import cannot move a profile"),
            "{}",
            said(only(&plan))
        );
    }

    /// ...and one that names the directory the row is already in is content.
    #[test]
    fn a_file_naming_the_directory_a_profile_is_already_in_is_fine() {
        let mut stored = row("r1", "Designer", Some("designer"));
        stored.path = "d/fstack/designer_01m3qbzd".into();
        let mut library = here(vec![stored]);
        library.directories = vec![folder("Fstack", true)];
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\ndirectory: Fstack\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            matches!(only(&plan).outcome, PlanOutcome::Overwrite(_)),
            "{:#?}",
            only(&plan).outcome
        );
        assert_eq!(
            field(diff_of(only(&plan)), "directory").change,
            FieldChange::Unchanged
        );
    }

    // ── the drop itself ─────────────────────────────────────────────────

    /// A file that fails to parse reports its error and **no field values**. It
    /// has none to report, and expanding one into a diff would mean inventing
    /// them.
    #[test]
    fn a_file_that_does_not_parse_reports_its_error_and_no_values() {
        let plan = plan(
            &dropped(vec![DroppedFile {
                path: "designer/PROFILE.md".into(),
                text: "# Designer\n\nProse, and no frontmatter.\n".into(),
            }]),
            &here(vec![row("r1", "Designer", Some("designer"))]),
        )
        .unwrap();
        let entry = only(&plan);
        assert_eq!(entry.name, None, "there is no name to report");
        assert!(said(entry).contains("no frontmatter"), "{}", said(entry));
    }

    /// The five bundles `fstack` actually holds today. All five refuse, which
    /// is the right answer — they are prose that was never connected to a live
    /// profile — and the plan says so per file rather than failing the drop.
    #[test]
    fn the_five_fstack_bundles_are_each_blocked_with_their_own_sentence() {
        let drop = fixtures("fstack");
        assert_eq!(drop.files.len(), 5);
        let plan = plan(&drop, &here(vec![])).unwrap();
        assert_eq!(plan.entries.len(), 5);
        for entry in &plan.entries {
            assert!(
                matches!(entry.outcome, PlanOutcome::Blocked(_)),
                "{} should refuse: {:#?}",
                entry.path,
                entry.outcome
            );
            for problem in blocked(entry) {
                assert_eq!(problem.path, entry.path);
                assert!(problem.line >= 1);
            }
        }
        assert!(!plan.appliable);
        // The two that carry `description`, and the three with no frontmatter
        // at all, get different sentences — which is the distinction a person
        // dropping these first meets.
        let designer = plan
            .entries
            .iter()
            .find(|e| e.key == "designer")
            .expect("the designer bundle");
        assert!(said(designer).contains("`does`"), "{}", said(designer));
        let engineer = plan
            .entries
            .iter()
            .find(|e| e.key == "engineer")
            .expect("the engineer bundle");
        assert!(
            said(engineer).contains("no frontmatter"),
            "{}",
            said(engineer)
        );
    }

    /// The same five, repaired: against an empty library every one is new, and
    /// the plan applies.
    #[test]
    fn the_repaired_fstack_bundles_are_five_new_profiles() {
        let plan = plan(&fixtures("fstack-repaired"), &here(vec![])).unwrap();
        assert_eq!(plan.entries.len(), 5);
        for entry in &plan.entries {
            assert!(
                matches!(entry.outcome, PlanOutcome::New(_)),
                "{}: {:#?}",
                entry.path,
                entry.outcome
            );
        }
        assert!(plan.appliable);
    }

    /// Every bundle in one of the vendored sets, as a drop.
    fn fixtures(set: &str) -> ProfileDrop {
        let root = std::path::Path::new("../../fixtures/profiles").join(set);
        let mut files = Vec::new();
        for folder in std::fs::read_dir(&root).expect("the fixtures") {
            let folder = folder.unwrap().path();
            let file = folder.join("PROFILE.md");
            if !file.is_file() {
                continue;
            }
            files.push(DroppedFile {
                path: format!(
                    "profiles/{}/PROFILE.md",
                    folder.file_name().unwrap().to_string_lossy()
                ),
                text: std::fs::read_to_string(&file).unwrap(),
            });
        }
        dropped(files)
    }

    /// A bundle is a folder with a `PROFILE.md` in it. Everything else in the
    /// drop is named as ignored rather than dropped silently, and a file whose
    /// name only folds onto that spelling is a bundle that would otherwise
    /// vanish without a word.
    #[test]
    fn what_is_a_bundle_and_what_is_not() {
        let plan = plan(
            &dropped(vec![
                at("profiles/designer/PROFILE.md", &smallest("Designer"), ""),
                DroppedFile {
                    path: "profiles/README.md".into(),
                    text: "Our profiles.".into(),
                },
                DroppedFile {
                    path: "profiles/.DS_Store".into(),
                    text: String::new(),
                },
                at("profiles/qa/profile.md", &smallest("QA"), ""),
                at("PROFILE.md", &smallest("Loose"), ""),
            ]),
            &here(vec![]),
        )
        .unwrap();
        assert_eq!(
            plan.ignored,
            vec![
                "profiles/.DS_Store".to_string(),
                "profiles/README.md".into()
            ]
        );
        let lower = plan
            .entries
            .iter()
            .find(|e| e.path.ends_with("profile.md"))
            .expect("a bundle, not an ignored file");
        assert!(
            said(lower).contains("spelled `PROFILE.md`, in capitals"),
            "{}",
            said(lower)
        );
        let loose = plan
            .entries
            .iter()
            .find(|e| e.path == "PROFILE.md")
            .expect("the loose file");
        assert!(
            said(loose).contains("not inside a folder"),
            "{}",
            said(loose)
        );
    }

    /// The bounds are the endpoint's, and every refusal names the limit it is —
    /// a refusal that does not leaves somebody guessing which half of their
    /// drop to cut.
    #[test]
    fn the_bounds_refuse_the_whole_drop_and_name_the_limit() {
        let one = |path: &str, text: String| ProfileDrop {
            files: vec![DroppedFile {
                path: path.into(),
                text,
            }],
            answers: vec![],
        };

        let many = ProfileDrop {
            files: (0..MOST_FILES + 1)
                .map(|n| DroppedFile {
                    path: format!("p{n}/PROFILE.md"),
                    text: String::new(),
                })
                .collect(),
            answers: vec![],
        };
        let refused = plan(&many, &here(vec![])).expect_err("too many files");
        assert!(
            refused.0.contains(&format!("at most {MOST_FILES}")),
            "{}",
            refused.0
        );

        let big = plan(
            &one("designer/PROFILE.md", "x".repeat(BIGGEST_FILE + 1)),
            &here(vec![]),
        )
        .expect_err("too big a file");
        assert!(
            big.0
                .contains(&format!("at most {} KB", BIGGEST_FILE / 1024)),
            "{}",
            big.0
        );

        let deep = plan(
            &one(
                &format!("{}/designer/PROFILE.md", "a/".repeat(DEEPEST)),
                String::new(),
            ),
            &here(vec![]),
        )
        .expect_err("too deep");
        assert!(deep.0.contains(&format!("at most {DEEPEST}")), "{}", deep.0);

        let out = plan(&one("../../etc/PROFILE.md", String::new()), &here(vec![]))
            .expect_err("climbing out");
        assert!(
            out.0.contains("inside the folder that was dropped"),
            "{}",
            out.0
        );

        let twice = plan(
            &dropped(vec![
                at("designer/PROFILE.md", &smallest("Designer"), ""),
                at("designer/PROFILE.md", &smallest("Designer"), ""),
            ]),
            &here(vec![]),
        )
        .expect_err("the same path twice");
        assert!(twice.0.contains("is in this drop twice"), "{}", twice.0);

        let total = ProfileDrop {
            files: (0..40)
                .map(|n| DroppedFile {
                    path: format!("p{n}/PROFILE.md"),
                    text: "x".repeat(BIGGEST_FILE),
                })
                .collect(),
            answers: vec![],
        };
        let over = plan(&total, &here(vec![])).expect_err("too much at once");
        assert!(
            over.0
                .contains(&format!("{} MB", BIGGEST_DROP / 1024 / 1024)),
            "{}",
            over.0
        );
    }

    /// An empty drop is not appliable: there is nothing in it to apply.
    #[test]
    fn a_drop_with_no_bundles_in_it_applies_nothing() {
        let plan = plan(&dropped(vec![]), &here(vec![])).unwrap();
        assert!(plan.entries.is_empty());
        assert!(!plan.appliable);
    }

    /// **If a plan cannot be applied, it says why.** The invariant, over every
    /// shape of drop that produces one.
    ///
    /// `appliable` is derived from `why_not`, so this cannot be broken without
    /// changing how the plan is built — but the test is the thing that says so,
    /// and the case it was written for is the one that was broken: an empty
    /// drop came back unappliable and silent, which is a dead button with no
    /// sentence beside it.
    #[test]
    fn an_unappliable_plan_always_says_why() {
        let library = here(vec![row("r1", "QA", None)]);
        let drops = [
            // Nothing in it at all.
            dropped(vec![]),
            // Nothing in it that is a bundle.
            dropped(vec![DroppedFile {
                path: "profiles/README.md".into(),
                text: "Our profiles.".into(),
            }]),
            // A file that does not parse.
            dropped(vec![DroppedFile {
                path: "designer/PROFILE.md".into(),
                text: "# Designer\n".into(),
            }]),
            // An unanswered candidate.
            dropped(vec![at(
                "qa-engineer/PROFILE.md",
                &smallest("QA Engineer"),
                "",
            )]),
            // A resolution failure.
            dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nmachine: nowhere\n",
                "",
            )]),
            // And one that applies.
            dropped(vec![at("designer/PROFILE.md", &smallest("Designer"), "")]),
        ];
        for drop in drops {
            let plan = plan(&drop, &library).unwrap();
            assert_eq!(
                plan.appliable,
                plan.why_not.is_empty(),
                "appliable and whyNot disagree: {plan:#?}"
            );
            if !plan.appliable {
                assert!(
                    plan.why_not.iter().all(|w| w.len() > 20),
                    "a reason has to be a sentence: {:#?}",
                    plan.why_not
                );
            }
        }
    }

    /// An empty drop is told what a bundle is, because the likeliest cause is
    /// dropping the wrong folder.
    #[test]
    fn a_drop_with_no_bundles_in_it_says_what_a_bundle_is() {
        let nothing = plan(&dropped(vec![]), &here(vec![])).unwrap();
        assert!(!nothing.appliable);
        assert_eq!(nothing.why_not.len(), 1);
        assert!(
            nothing.why_not[0].contains("`PROFILE.md`"),
            "{}",
            nothing.why_not[0]
        );

        // And when files were ignored, how many — the difference between "you
        // dropped nothing" and "you dropped the wrong level".
        let wrong_level = plan(
            &dropped(vec![
                DroppedFile {
                    path: "README.md".into(),
                    text: "x".into(),
                },
                DroppedFile {
                    path: "justfile".into(),
                    text: "x".into(),
                },
            ]),
            &here(vec![]),
        )
        .unwrap();
        assert!(!wrong_level.appliable);
        assert!(
            wrong_level.why_not[0].contains("2 files were ignored"),
            "{}",
            wrong_level.why_not[0]
        );
    }

    /// **A name that resolves to nothing reads as nothing.** It used to read as
    /// *"`Startup` is a subscription for one engine"*, which is not unhelpful
    /// but false: somebody would go looking for `Startup`.
    #[test]
    fn a_subscription_that_does_not_exist_is_never_described_as_existing() {
        let mut library = here(vec![]);
        library.accounts = vec![subscription("aa1", "Personal", "ClaudeCode")];

        // No engine pinned, and the subscription does not exist. The engine
        // question is about a subscription, so it cannot come first.
        let unknown = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\naccount: Startup\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let says = said(only(&unknown));
        assert!(
            says.contains("no subscription named `Startup` is available to you"),
            "{says}"
        );
        assert!(
            !says.contains("is a subscription"),
            "a name that resolves to nothing must not be described as existing: {says}"
        );

        // One that does exist, with no engine to check it against, still gets
        // the engine sentence.
        let real = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\naccount: Personal\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        assert!(
            said(only(&real)).contains("has to pin one too"),
            "{}",
            said(only(&real))
        );
    }

    /// The directory block names what the file wrote and gives a way out that
    /// can be taken. It used to show `u/admin` — a path the server computes —
    /// and say "write the directory it is in" about a profile that is in none.
    #[test]
    fn the_directory_block_echoes_its_value_and_can_be_acted_on() {
        let mut mine = row("r1", "Designer", Some("designer"));
        mine.path = "u/kevin/designer_01m3qbzd".into();
        let mut library = here(vec![mine]);
        library.directories = vec![folder("Fstack", true)];
        let says = {
            let plan = plan(
                &dropped(vec![at(
                    "designer/PROFILE.md",
                    "name: Designer\ndoes: does the thing\ndirectory: Fstack\n",
                    "",
                )]),
                &library,
            )
            .unwrap();
            said(only(&plan))
        };
        assert!(says.contains("`directory: Fstack`"), "{says}");
        assert!(says.contains("An import cannot move a profile"), "{says}");
        assert!(says.contains("your own space"), "{says}");
        assert!(says.contains("remove the line"), "{says}");
        assert!(
            !says.contains("u/kevin"),
            "a path nobody types is not a sentence: {says}"
        );

        // A row that *is* in a directory can be told which one to write.
        let mut theirs = row("r2", "Engineer", Some("engineer"));
        theirs.path = "d/fstack/engineer_01m3qbzd".into();
        let mut library = here(vec![theirs]);
        library.directories = vec![folder("Fstack", true), folder("House", true)];
        let plan = plan(
            &dropped(vec![at(
                "engineer/PROFILE.md",
                "name: Engineer\ndoes: does the thing\ndirectory: House\n",
                "",
            )]),
            &library,
        )
        .unwrap();
        let says = said(only(&plan));
        assert!(says.contains("`directory: House`"), "{says}");
        assert!(says.contains("write `directory: Fstack`"), "{says}");
    }

    /// **An invalid value under `settings` blocks, listing what is accepted.**
    ///
    /// Parity with `POST /roles` would be no check at all, and that is not
    /// enough: the error table says an invalid enum value blocks, and a typo'd
    /// value does not fail at launch either, because `Preferred::keeping_only`
    /// drops one the agent no longer offers. `effort: maximum` silently does
    /// nothing, which is the failure the format exists to remove.
    #[test]
    fn an_invalid_setting_blocks_and_lists_what_the_engine_offers() {
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nengine: ClaudeCode\nsettings:\n  \
                 model: not-a-model\n  effort: maximum\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let problems = blocked(only(&plan));
        assert_eq!(problems.len(), 2, "{problems:#?}");

        let model = problems
            .iter()
            .find(|p| p.key.as_deref() == Some("settings.model"))
            .expect("a problem about the model");
        assert!(model.says.contains("`not-a-model`"), "{}", model.says);
        assert!(model.says.contains("ClaudeCode offers"), "{}", model.says);
        // The values a file writes, so the list can be copied into one.
        assert!(model.says.contains("`opus[1m]`"), "{}", model.says);

        let effort = problems
            .iter()
            .find(|p| p.key.as_deref() == Some("settings.effort"))
            .expect("a problem about the effort");
        assert!(effort.says.contains("`maximum`"), "{}", effort.says);
        assert!(effort.says.contains("an effort"), "{}", effort.says);
        // And it points at the line the value is on, not at `settings:`.
        assert_eq!(effort.line, 7, "{effort:#?}");
    }

    /// A setting the engine has no picker for is **said and not refused**.
    ///
    /// Nothing is wrong with the value; the line has no effect. Blocking it
    /// would break the export round trip for a row Firetower itself produced,
    /// because `pref_sandbox` is one column for every engine and export writes
    /// what the row holds — so this is the one setting condition that warns.
    #[test]
    fn a_setting_the_engine_does_not_have_is_said_rather_than_refused() {
        let plan = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nengine: ClaudeCode\nsettings:\n  \
                 sandbox: workspace\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let entry = only(&plan);
        assert!(
            matches!(entry.outcome, PlanOutcome::New(_)),
            "{:#?}",
            entry.outcome
        );
        let says = &entry.warnings[0].says;
        assert!(says.contains("ClaudeCode has no sandbox setting"), "{says}");
        assert!(says.contains("would do nothing"), "{says}");
        assert!(says.contains("Remove the line"), "{says}");
        assert!(plan.appliable);
    }

    /// **And only what is knowable.** With no engine pinned there is no valid
    /// set until a lead chooses, so the value is taken as written and the plan
    /// says so — the same asymmetry a reset under `settings` already has.
    #[test]
    fn a_setting_is_taken_as_written_when_no_engine_decides_the_set() {
        let open = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nsettings:\n  effort: maximum\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let entry = only(&open);
        assert!(
            matches!(entry.outcome, PlanOutcome::New(_)),
            "{:#?}",
            entry.outcome
        );
        assert_eq!(entry.warnings.len(), 1, "{:#?}", entry.warnings);
        let says = &entry.warnings[0].says;
        assert!(
            says.contains("`effort: maximum` is taken as written"),
            "{says}"
        );
        assert!(says.contains("depends on the engine"), "{says}");
        assert_eq!(entry.warnings[0].key.as_deref(), Some("settings.effort"));
        assert!(open.appliable, "an unknowable set is not a refusal");

        // Codex lists its own models when it starts, so that one is unknowable
        // even with the engine pinned.
        let codex = plan(
            &dropped(vec![at(
                "designer/PROFILE.md",
                "name: Designer\ndoes: does the thing\nengine: Codex\nsettings:\n  model: o3\n",
                "",
            )]),
            &here(vec![]),
        )
        .unwrap();
        let entry = only(&codex);
        assert!(
            matches!(entry.outcome, PlanOutcome::New(_)),
            "{:#?}",
            entry.outcome
        );
        assert!(
            entry.warnings[0]
                .says
                .contains("lists its own models when it starts"),
            "{}",
            entry.warnings[0].says
        );
        assert!(codex.appliable);
    }

    /// The limits travel with the plan, so a client can refuse before it asks
    /// rather than after.
    #[test]
    fn the_plan_says_what_the_endpoint_will_take() {
        let plan = plan(&dropped(vec![]), &here(vec![])).unwrap();
        assert_eq!(plan.limits.files, MOST_FILES);
        assert_eq!(plan.limits.file_bytes, BIGGEST_FILE);
        assert_eq!(plan.limits.total_bytes, BIGGEST_DROP);
        assert_eq!(plan.limits.depth, DEEPEST);
    }
}
