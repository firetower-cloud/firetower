//! `PROFILE.md`: a profile read out of a folder, and written back into one.
//!
//! A profile bundle is a folder — `profiles/<key>/PROFILE.md` — and **the
//! folder's name is the profile's identity.** The frontmatter carries the
//! sixteen fields [`crate::roles::NewRole`] accepts, with every reference
//! written as a *name* rather than an id, and the markdown body is the
//! profile's instructions. [`parse`] reads such a file into a [`Profile`];
//! [`serialize`] writes a [`Profile`] back out as one.
//!
//! Nothing here resolves a name into an id, touches the database, or decides
//! what a drop would do. That is the plan (#355), and keeping it out means the
//! hard cases in this file are a unit test over a function rather than a
//! fixture over a schema.
//!
//! ## An absent key is the documented default, never "leave it as it is"
//!
//! `NewRole` reads an omitted `includeAlwaysOn`, `onUsageLimit` or
//! `onChildLimit` as *leave the stored value alone*, and its doc comments say
//! why: it is a whole-object write, so a client that has never heard of a
//! field must not be able to revoke a grant by omitting it.
//!
//! **A file must not inherit that.** If deleting a line left the old value in
//! place, the file would stop describing the profile: feed the same file to a
//! fresh installation and you get the column default, so one file would
//! produce two different profiles. So [`Profile`] has a value for every
//! field, [`parse`] substitutes the documented default for anything absent,
//! and the only thing that makes a reset safe rather than surprising is the
//! review that shows it before anything is written.
//!
//! The defaults are the column defaults, and they are read from the one place
//! the server already states them — [`INHERITS`], [`WAITS_FOR_A_PERSON`],
//! [`ASKS_THE_PERSON`] and the `PLACEMENT`/`ON_USAGE_LIMIT`/`ON_CHILD_LIMIT`
//! tables in the parent module — rather than written out again here.
//!
//! ## A real YAML reader, which is the decision this repository already took
//!
//! [`crate::skills::read_frontmatter`] is deliberately **not** a YAML parser:
//! a `SKILL.md` is read by several agents, Firetower's reader has to be the
//! same shape as the desktop client's, and those files ship in the binary. A
//! `PROFILE.md` is none of that. It is authored by a person, it carries nested
//! maps and lists, and only the server ever reads one — so extending that
//! reader would be growing a second opinion about where a line ends for no
//! gain.
//!
//! `docs/skills.md` §2 settled what the oracle for correctness is: **libyaml**,
//! which is what `serde_yaml` is. So the parser is libyaml, and the writer is
//! libyaml too — [`scalar`] asks the reader whether a plain spelling reads
//! back as the string it was given, rather than carrying a table of quoting
//! rules that could be wrong.
//!
//! ## Two properties, in both directions
//!
//! **Serialize, parse, and get the same description back.** One test catches a
//! field the writer forgot, a field the parser drops, and an enum spelled
//! differently on each side. Two of those three are impossible by
//! construction here — [`Field`] is one table that both halves read, and the
//! enums spell themselves — and the property is what says so rather than a
//! comment claiming it.
//!
//! **Parse, serialize, and the output is stable.** The other direction is the
//! one a person sees: export writes the file they commit. So parsing a
//! hand-written file and writing it back has to produce a file that parses to
//! the same thing and does not change again on the next pass. That makes
//! [`Profile`] a *canonical* form — every scalar trimmed, blank meaning
//! absent, one line ending — and [`parse`] always returns one.

use std::collections::BTreeSet;
use std::path::Path;

use serde_yaml::Value;

use super::INHERITS;

/// What a `PROFILE.md` says, with a value for every field.
///
/// **No field means "the file did not say".** Where a value is [`Option`] it
/// is because the field is nullable in the API too and null is a decision
/// there: `engine`, `machine` and `placement` have a "let the lead choose"
/// state, and `account` and `directory` have "whatever the owner's default
/// is". [`parse`] has already turned every absent key into the value the
/// column defaults to, so nothing downstream has to know which keys the file
/// actually spelled — which is the whole point of the format.
///
/// **Canonical.** Every string is trimmed and holds no line break, a blank is
/// `None` or `""` rather than `Some("  ")`, and the instructions carry no
/// surrounding blank lines. [`parse`] returns one of these whatever it was
/// given, so [`serialize`] can write a single-line scalar for every field and
/// the round trip is exact rather than nearly exact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// The folder's name, which is what identifies the profile. `key:` in the
    /// frontmatter is optional and must agree with it.
    pub key: String,
    /// The name a lead sees. Prose, freely editable: a changed `name` under an
    /// unchanged `key` is a rename rather than a new profile.
    pub name: String,
    /// The one line a lead reads to decide whether to hand it work.
    pub does: String,
    /// The markdown body, composed into the child's instructions.
    pub instructions: String,
    /// Which agent runs it. `None` leaves the choice to whichever lead
    /// delegates to it.
    pub engine: Option<ft_core::Agent>,
    /// Where a delegated child runs.
    pub placement: Placement,
    /// The machine its own workspace runs on, **by name**. `None` lets the
    /// lead choose.
    pub machine: Option<String>,
    /// The subscription its agent runs on, **by name**. `None` runs on the
    /// owner's default for the engine.
    pub account: Option<String>,
    /// The directory it is filed in, **by name**. `None` is the importer's own
    /// space.
    pub directory: Option<String>,
    /// Whether it is a Manager.
    pub can_delegate: bool,
    /// The profiles it may delegate to, **by name**. Empty means any the owner
    /// can see.
    pub delegates_to: Vec<String>,
    /// The skills it loads on top of the two inherited sources.
    pub skills: Vec<SkillRef>,
    /// Include the owner's always-on skills.
    pub include_always_on: bool,
    /// Include the owner's defaults for the repositories the child checks out.
    pub include_repo_defaults: bool,
    /// What a lead may do about a child of this profile that has run out.
    pub on_usage_limit: OnUsageLimit,
    /// Whether this Manager re-routes a spent child itself, or asks.
    pub on_child_limit: OnChildLimit,
    /// How it runs its agent. Each `None` takes the engine's default.
    pub settings: ft_core::controls::Preferred,
}

impl Profile {
    /// A profile that says nothing but its identity: every field at the value
    /// the column defaults to.
    ///
    /// This is the function the "absent means the documented default" decision
    /// lives in. [`parse`] starts here and overwrites what the file spelled,
    /// so a key nobody wrote and a key somebody deleted cannot end up meaning
    /// different things.
    ///
    /// **Not yet a profile any file describes**: `name` and `does` are
    /// required, and this leaves both empty. [`parse`] is what refuses a file
    /// that does, which is why the two are not arguments here — the defaults
    /// have to be in place before the frontmatter is read, and a constructor
    /// taking three strings would have to be called with two of them blank.
    pub fn bare(key: &str) -> Self {
        Self {
            key: key.to_string(),
            name: String::new(),
            does: String::new(),
            instructions: String::new(),
            engine: None,
            placement: Placement::Lead,
            machine: None,
            account: None,
            directory: None,
            can_delegate: false,
            delegates_to: Vec::new(),
            skills: Vec::new(),
            include_always_on: INHERITS,
            include_repo_defaults: INHERITS,
            on_usage_limit: OnUsageLimit::Wait,
            on_child_limit: OnChildLimit::Ask,
            settings: ft_core::controls::Preferred::default(),
        }
    }
}

/// A skill a profile loads, by name, optionally qualified by the directory it
/// is in.
///
/// Two reachable skills may share a name — `slug` is unique per installation
/// but `name` is not — so without the qualifier a profile that loads "the
/// `dataviz` in `firetower`" could not be written down at all. `firetower/dataviz`
/// is that profile; `dataviz` is the one everywhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillRef {
    /// The directory the skill is filed in, when the name needs it.
    pub directory: Option<String>,
    pub name: String,
}

impl SkillRef {
    /// How this reference is written in a file. The writer's only spelling, so
    /// a reference cannot be written in a form the reader does not take.
    pub fn spelling(&self) -> String {
        match &self.directory {
            Some(d) => format!("{d}/{}", self.name),
            None => self.name.clone(),
        }
    }
}

/// Where a delegated child runs. `roles::PLACEMENT`, as a type.
///
/// The three enums below are types rather than validated strings for one
/// reason: an enum spelled differently by the reader and the writer is one of
/// the three bugs the round-trip property exists to catch, and a single
/// [`Self::spelling`] read by both halves makes it unspellable instead. The
/// values still have to agree with the string tables the API validates
/// against, which is what `enums_agree_with_the_api` asserts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Let whichever lead delegates to it choose.
    Lead,
    /// The lead's own workspace.
    Here,
    /// One of its own.
    New,
}

/// What a lead may do about a child of this profile that has run out of
/// allowance. `roles::ON_USAGE_LIMIT`, as a type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnUsageLimit {
    /// Nobody moves it without a person.
    Wait,
    /// The lead may move it to another subscription for the same engine.
    Same,
    /// And to another engine.
    Engine,
}

/// Whether a Manager spends that latitude itself. `roles::ON_CHILD_LIMIT`, as
/// a type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnChildLimit {
    /// Stop and put the choice to the person.
    Ask,
    /// Pick a subscription and carry on.
    Reroute,
}

/// One enum, one table, walked from the first variant.
///
/// `then` is an exhaustive match, so a variant added to the enum does not
/// compile until it has a place in the order — and `all` is what both the
/// reader and the refusal's list of accepted values are built from, so neither
/// can be short of it.
macro_rules! spelled {
    ($t:ty, $first:ident, $( $variant:ident => $word:literal ),+ $(,)?) => {
        impl $t {
            /// How this value is written in a file.
            pub fn spelling(self) -> &'static str {
                match self { $( Self::$variant => $word ),+ }
            }

            /// Every value, in the order they are listed.
            pub fn all() -> Vec<Self> {
                let mut out = vec![Self::$first];
                while let Some(next) = out[out.len() - 1].then() {
                    out.push(next);
                }
                out
            }

            /// The value a file spelled, or nothing.
            fn from_spelling(word: &str) -> Option<Self> {
                Self::all().into_iter().find(|v| v.spelling() == word)
            }
        }
    };
}

spelled!(Placement, Lead, Lead => "lead", Here => "here", New => "new");
spelled!(OnUsageLimit, Wait, Wait => "wait", Same => "same", Engine => "engine");
spelled!(OnChildLimit, Ask, Ask => "ask", Reroute => "reroute");

impl Placement {
    fn then(self) -> Option<Self> {
        Some(match self {
            Self::Lead => Self::Here,
            Self::Here => Self::New,
            Self::New => return None,
        })
    }
}

impl OnUsageLimit {
    fn then(self) -> Option<Self> {
        Some(match self {
            Self::Wait => Self::Same,
            Self::Same => Self::Engine,
            Self::Engine => return None,
        })
    }
}

impl OnChildLimit {
    fn then(self) -> Option<Self> {
        Some(match self {
            Self::Ask => Self::Reroute,
            Self::Reroute => return None,
        })
    }
}

/// Why a file is not a profile, in a sentence somebody can act on.
///
/// **`path` and `line` are not optional.** An error that cannot say which of
/// twelve files it came from is not actionable, and the review (#355) draws
/// these beside the file they are in.
///
/// `key` is the field at fault where there is one, written the way the file
/// writes it — `placement`, `skills[2]`, `settings.model` — so the review can
/// point at a line rather than only quote a sentence. It is `None` for
/// something about the file as a whole, which is every error that happens
/// before there are fields to be at fault.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    /// The line in the file, counting from 1.
    pub line: usize,
    pub key: Option<String>,
    /// What is wrong and what to do about it. Held to `human-ui-copy`: the
    /// review renders this at a person, so it names the offending value and
    /// says what to write instead.
    pub says: String,
}

/// Every frontmatter key, in the order a file writes them.
///
/// **One table, read by both halves.** The parser looks a key up here, the
/// writer walks [`SHAPE`] which is built out of it, and the refusal for an
/// unknown key lists it. A field that only one half knows about is therefore
/// not something a test has to catch; it is something that cannot be written.
///
/// Sixteen variants for sixteen fields, which is a coincidence worth saying
/// out loud: the specification counts the body as one of the sixteen and has
/// no `key`, this counts `key` and not the body, and the two sets differ by
/// exactly those two members.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Field {
    Key,
    Name,
    Does,
    Directory,
    Engine,
    Placement,
    Machine,
    Account,
    CanDelegate,
    DelegatesTo,
    IncludeAlwaysOn,
    IncludeRepoDefaults,
    Skills,
    OnUsageLimit,
    OnChildLimit,
    Settings,
}

impl Field {
    /// The next field in the canonical order, or nothing after the last.
    ///
    /// Exhaustive, so a field added to the enum does not compile until it is
    /// in the order — and [`SHAPE`] then refuses to be built without it.
    fn then(self) -> Option<Self> {
        Some(match self {
            Self::Key => Self::Name,
            Self::Name => Self::Does,
            Self::Does => Self::Directory,
            Self::Directory => Self::Engine,
            Self::Engine => Self::Placement,
            Self::Placement => Self::Machine,
            Self::Machine => Self::Account,
            Self::Account => Self::CanDelegate,
            Self::CanDelegate => Self::DelegatesTo,
            Self::DelegatesTo => Self::IncludeAlwaysOn,
            Self::IncludeAlwaysOn => Self::IncludeRepoDefaults,
            Self::IncludeRepoDefaults => Self::Skills,
            Self::Skills => Self::OnUsageLimit,
            Self::OnUsageLimit => Self::OnChildLimit,
            Self::OnChildLimit => Self::Settings,
            Self::Settings => return None,
        })
    }

    /// Every field, in the canonical order.
    pub fn all() -> Vec<Self> {
        let mut out = vec![Self::Key];
        while let Some(next) = out[out.len() - 1].then() {
            out.push(next);
        }
        out
    }

    /// The key this field is spelled with.
    pub fn spelling(self) -> &'static str {
        match self {
            Self::Key => "key",
            Self::Name => "name",
            Self::Does => "does",
            Self::Directory => "directory",
            Self::Engine => "engine",
            Self::Placement => "placement",
            Self::Machine => "machine",
            Self::Account => "account",
            Self::CanDelegate => "can_delegate",
            Self::DelegatesTo => "delegates_to",
            Self::IncludeAlwaysOn => "include_always_on",
            Self::IncludeRepoDefaults => "include_repo_defaults",
            Self::Skills => "skills",
            Self::OnUsageLimit => "on_usage_limit",
            Self::OnChildLimit => "on_child_limit",
            Self::Settings => "settings",
        }
    }

    fn from_spelling(key: &str) -> Option<Self> {
        Self::all().into_iter().find(|f| f.spelling() == key)
    }
}

/// One setting under `settings`, the same way [`Field`] is one key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    Model,
    Effort,
    Mode,
    Sandbox,
}

impl Setting {
    fn then(self) -> Option<Self> {
        Some(match self {
            Self::Model => Self::Effort,
            Self::Effort => Self::Mode,
            Self::Mode => Self::Sandbox,
            Self::Sandbox => return None,
        })
    }

    pub fn all() -> Vec<Self> {
        let mut out = vec![Self::Model];
        while let Some(next) = out[out.len() - 1].then() {
            out.push(next);
        }
        out
    }

    pub fn spelling(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Effort => "effort",
            Self::Mode => "mode",
            Self::Sandbox => "sandbox",
        }
    }

    /// Where this setting is held on a [`ft_core::controls::Preferred`]. The
    /// one place the four are mapped, so the reader and the writer cannot
    /// disagree about which is which.
    fn of(self, p: &ft_core::controls::Preferred) -> &Option<String> {
        match self {
            Self::Model => &p.model,
            Self::Effort => &p.effort,
            Self::Mode => &p.mode,
            Self::Sandbox => &p.sandbox,
        }
    }

    fn of_mut(self, p: &mut ft_core::controls::Preferred) -> &mut Option<String> {
        match self {
            Self::Model => &mut p.model,
            Self::Effort => &mut p.effort,
            Self::Mode => &mut p.mode,
            Self::Sandbox => &mut p.sandbox,
        }
    }

    fn from_spelling(key: &str) -> Option<Self> {
        Self::all().into_iter().find(|s| s.spelling() == key)
    }

    fn accepted() -> String {
        let all: Vec<&str> = Self::all().iter().map(|s| s.spelling()).collect();
        all.join(", ")
    }
}

/// A line of the frontmatter the writer produces: a field, or the comment
/// above a group of them.
enum Written {
    Field(Field),
    /// A blank line and a comment, which is what makes an eighty-line file
    /// readable in a diff.
    Group(&'static str),
}

/// The frontmatter a profile is written as: the canonical order, and the four
/// comments that group it.
///
/// The order and the grouping are the specification's own example, with two
/// additions it does not show. `key` leads, because an exported file should
/// say what it is when it is read away from its folder. And `directory` — in
/// the field table but missing from the example — is its own group next to
/// `name`, because it is where the *profile* is filed rather than anything
/// about the children it starts.
const SHAPE: &[Written] = &[
    Written::Field(Field::Key),
    Written::Field(Field::Name),
    Written::Field(Field::Does),
    Written::Group("Where the profile itself is filed. `~` is your own space."),
    Written::Field(Field::Directory),
    Written::Group("Where and how its children run. `~` leaves the choice to the lead."),
    Written::Field(Field::Engine),
    Written::Field(Field::Placement),
    Written::Field(Field::Machine),
    Written::Field(Field::Account),
    Written::Group("Delegation."),
    Written::Field(Field::CanDelegate),
    Written::Field(Field::DelegatesTo),
    Written::Group("Skills: the two inherited sources, plus this profile's own list."),
    Written::Field(Field::IncludeAlwaysOn),
    Written::Field(Field::IncludeRepoDefaults),
    Written::Field(Field::Skills),
    Written::Group("What happens when a child runs out of allowance."),
    Written::Field(Field::OnUsageLimit),
    Written::Field(Field::OnChildLimit),
    Written::Group("How it runs its agent. `~` takes the engine's default."),
    Written::Field(Field::Settings),
];

/// The line that opens and closes a frontmatter, and the only spelling of it
/// either half takes.
const FENCE: &str = "---";

/// Characters libyaml ends a line on and this file's line counting does not.
///
/// `docs/skills.md` §2 measured the disagreement: libyaml breaks a line on all
/// five of YAML 1.1's characters, and a `\n` count agrees about two of them
/// once `\r` has been folded into one. Left alone, a `name:` holding a U+2028
/// would be one line to a [`Problem`]'s `line` and two fields to the reader,
/// so the line numbers this returns would point at the wrong thing in exactly
/// the file somebody needs them for. Refused instead, which costs nothing
/// real: no file anybody has written holds one.
///
/// **Computed from libyaml's own set** rather than listed, so a sixth break
/// added to [`crate::skills::YAML_1_1_BREAKS`] is covered here without anybody
/// remembering to come back.
static INVISIBLE_BREAKS: std::sync::LazyLock<Vec<char>> = std::sync::LazyLock::new(|| {
    crate::skills::YAML_1_1_BREAKS
        .into_iter()
        .filter(|c| !FOLDED.contains(c))
        .collect()
});

/// The two breaks [`parse`] folds into one before it counts a line.
const FOLDED: [char; 2] = ['\n', '\r'];

// ── reading ─────────────────────────────────────────────────────────────

/// Read a `PROFILE.md` into the profile it describes.
///
/// `at` is the file, for the errors to name. `key` is **the folder's name**,
/// which is the profile's identity: `key:` in the frontmatter is optional and
/// is checked against this rather than preferred over it.
///
/// Every problem in the file comes back, not the first — a file with three
/// typos in it should take one round trip to fix, not three. Sorted by line,
/// because that is the order somebody reads them in.
///
/// **A problem is never returned beside a profile.** Every condition here
/// blocks the import, so a `Profile` alongside one would be a description
/// nothing is allowed to use, and the one error the specification is explicit
/// about — malformed YAML, which "has no values to show" — would be the odd
/// case out rather than the rule.
pub fn parse(at: &Path, key: &str, text: &str) -> Result<Profile, Vec<Problem>> {
    let path = at.display().to_string();
    let at = path.as_str();
    let said = |line: usize, key: Option<&str>, says: String| problem(at, line, key, says);

    // One line ending, so the reader and the line numbers agree about what a
    // line is. A CRLF-authored file reads exactly as an LF one, and a lone CR
    // — which libyaml ends a line on and a `\n` count does not — stops being a
    // difference between them.
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    let Some((frontmatter, body)) = frame(&text) else {
        return Err(vec![said(
            1,
            None,
            format!(
                "This file has no frontmatter, so it describes no profile. Open it with a line \
                 of {FENCE}, write at least a `name` and a `does`, then close with another line \
                 of {FENCE}."
            ),
        )]);
    };

    // The frontmatter starts on the line after the opening fence.
    const FIRST: usize = 2;
    let lines: Vec<&str> = frontmatter.split('\n').collect();

    let mut problems: Vec<Problem> = Vec::new();
    for (n, line) in lines.iter().enumerate() {
        if let Some(c) = line.chars().find(|c| INVISIBLE_BREAKS.contains(c)) {
            problems.push(said(
                FIRST + n,
                None,
                format!(
                    "This line holds {}, which some readers treat as a line break and some as \
                     text. Delete it, or write it as an escape inside a quoted value.",
                    named(c)
                ),
            ));
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }

    let read: Value = match serde_yaml::from_str(frontmatter) {
        Ok(v) => v,
        Err(e) => {
            // The parser counts from the start of the frontmatter, and a
            // `Problem` counts from the start of the file.
            let broke_on = e.location().map(|l| l.line()).unwrap_or(1);
            return Err(vec![said(
                FIRST + broke_on.saturating_sub(1),
                None,
                format!(
                    "The frontmatter is not valid YAML. {}.",
                    without_location(&e)
                ),
            )]);
        }
    };

    let fields = match read {
        // `---` with nothing between the fences. A profile with no fields at
        // all is missing its `name` and its `does`, which is what the person
        // needs to be told, so this is read as an empty mapping rather than as
        // a complaint about the shape.
        Value::Null => serde_yaml::Mapping::new(),
        Value::Mapping(m) => m,
        other => {
            return Err(vec![said(
                FIRST,
                None,
                format!(
                    "The frontmatter holds {} where a profile's fields should be. Write one \
                     field per line, like `name: Designer`.",
                    shape_of(&other)
                ),
            )])
        }
    };

    let mut profile = Profile::bare(key);
    let mut seen: BTreeSet<Field> = BTreeSet::new();
    // A field whose value was refused keeps the default it was born with, so
    // `name` and `does` would read as missing as well as wrong. Two problems
    // for one mistake, and the second one is a lie: the field is there. So the
    // required-field check below asks about the fields nobody could read.
    let mut unread: BTreeSet<Field> = BTreeSet::new();

    for (spelling, value) in &fields {
        let Some(spelling) = spelling.as_str() else {
            problems.push(said(
                FIRST,
                None,
                "A field's name has to be text. Write it as `name: value`.".into(),
            ));
            continue;
        };
        let line = line_of(&lines, FIRST, spelling, 0);
        let Some(field) = Field::from_spelling(spelling) else {
            problems.push(said(line, Some(spelling), unknown(spelling)));
            continue;
        };
        seen.insert(field);
        if let Err(mut found) = read_field(field, value, &lines, FIRST, line, at, &mut profile) {
            unread.insert(field);
            problems.append(&mut found);
        }
    }

    // `key:` is optional, and when it is there it says the same thing the
    // folder does. A disagreement is a refusal rather than a precedence rule:
    // the folder is the identity, and a file that contradicts it is a file
    // whose author believes something that is not true.
    if seen.contains(&Field::Key) && !profile.key.is_empty() && profile.key != key {
        problems.push(said(
            line_of(&lines, FIRST, "key", 0),
            Some("key"),
            format!(
                "This file says `key: {}` and its folder is called `{key}`. The folder name is \
                 the profile's identity, so either write `key: {key}` or rename the folder.",
                profile.key
            ),
        ));
    }
    profile.key = key.to_string();

    // A field nobody wrote has no line of its own, so both of these point at
    // the first line of the frontmatter. That is where the field is missing
    // from, and it is what the review can scroll to.
    if profile.name.is_empty() && !unread.contains(&Field::Name) {
        problems.push(said(
            FIRST,
            Some("name"),
            "A profile needs a name. Add `name:` with the name a lead sees.".into(),
        ));
    }
    if profile.does.is_empty() && !unread.contains(&Field::Does) {
        problems.push(said(
            FIRST,
            Some("does"),
            "A profile needs the line a lead reads to choose it. Add `does:` with what it does \
             and when to reach for it."
                .into(),
        ));
    }

    profile.instructions = body.trim().to_string();

    if problems.is_empty() {
        Ok(profile)
    } else {
        problems.sort_by(|a, b| a.line.cmp(&b.line).then(a.key.cmp(&b.key)));
        Err(problems)
    }
}

/// What to say about a key this format does not have.
///
/// Naming the key is the acceptance criterion, and it is not enough on its
/// own: a typo'd `placment:` that imports cleanly and does nothing is the
/// failure this whole format exists to remove, so the refusal has to leave
/// somebody able to fix the line. Three answers, in order of how much they
/// help — the field they probably meant, the field that does what they are
/// reaching for, or the vocabulary.
fn unknown(spelling: &str) -> String {
    if let Some(meant) = nearest(spelling) {
        return format!("`{spelling}` is not a profile field. Did you mean `{meant}`?");
    }
    // `description` is a skill's word for this, and `SKILL.md` carries one, so
    // somebody writing their first `PROFILE.md` by hand reaches for it. There
    // is deliberately no alias: two spellings for one field would let two
    // different files describe the same profile, which is the reproducibility
    // the format is for.
    if spelling == "description" {
        return "`description` is not a profile field. The one line a lead reads is `does`.".into();
    }
    if spelling == "instructions" {
        return "`instructions` is not a frontmatter field. Write the instructions as the \
                markdown below the frontmatter."
            .into();
    }
    let known: Vec<String> = Field::all()
        .iter()
        .map(|f| format!("`{}`", f.spelling()))
        .collect();
    format!(
        "`{spelling}` is not a profile field. Remove the line, or write one of {}.",
        known.join(", ")
    )
}

/// The field a misspelling was reaching for, when there is an obvious one.
///
/// Two spellings answer here rather than in the list: a typo, which is one or
/// two characters out, and the API's own camelCase, which a person who has
/// read the endpoint before the format will write. `canDelegate` is four edits
/// from `can_delegate` and would never be caught by distance alone.
fn nearest(spelling: &str) -> Option<&'static str> {
    let flat = |s: &str| s.to_lowercase().replace(['_', '-', ' '], "");
    let want = flat(spelling);
    if let Some(f) = Field::all()
        .into_iter()
        .find(|f| flat(f.spelling()) == want)
    {
        return Some(f.spelling());
    }
    Field::all()
        .into_iter()
        .map(|f| (edits(&want, &flat(f.spelling())), f.spelling()))
        .filter(|(d, _)| *d > 0 && *d <= 2)
        .min_by_key(|(d, _)| *d)
        .map(|(_, f)| f)
}

/// Levenshtein distance, for "did you mean" and nothing else.
fn edits(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut next = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            next.push((row[j] + cost).min(row[j + 1] + 1).min(next[j] + 1));
        }
        row = next;
    }
    row[b.len()]
}

/// One problem, said about one file.
fn problem(at: &str, line: usize, key: Option<&str>, says: impl Into<String>) -> Problem {
    Problem {
        path: at.to_string(),
        line,
        key: key.map(str::to_string),
        says: says.into(),
    }
}

/// Read one field's value onto the profile, or say why it could not be.
///
/// An exhaustive match on [`Field`], so a field added to the enum does not
/// compile until this knows how to read it. That is what makes "a field the
/// parser drops" a compile error rather than a test failure.
fn read_field(
    field: Field,
    value: &Value,
    lines: &[&str],
    first: usize,
    line: usize,
    at: &str,
    into: &mut Profile,
) -> Result<(), Vec<Problem>> {
    let said = |line: usize, key: Option<&str>, says: String| problem(at, line, key, says);
    let key = field.spelling();
    let one = |says: String| vec![said(line, Some(key), says)];
    match field {
        Field::Key => into.key = text(value, key, line, at)?,
        Field::Name => into.name = text(value, key, line, at)?,
        Field::Does => into.does = text(value, key, line, at)?,
        Field::Directory => into.directory = maybe(value, key, line, at)?,
        Field::Machine => into.machine = maybe(value, key, line, at)?,
        Field::Account => into.account = maybe(value, key, line, at)?,
        Field::Engine => {
            into.engine = match maybe(value, key, line, at)? {
                None => None,
                Some(name) => match ft_core::Agent::from_name(&name) {
                    Some(agent) => Some(agent),
                    None => {
                        let offered: Vec<String> = ft_core::Agent::all()
                            .iter()
                            .map(|a| format!("`{a:?}`"))
                            .collect();
                        return Err(one(format!(
                            "`{name}` is not an engine Firetower runs. Write one of {}, or `~` \
                             to let the lead choose.",
                            offered.join(", ")
                        )));
                    }
                },
            }
        }
        Field::Placement => {
            into.placement = match maybe(value, key, line, at)? {
                None => Placement::Lead,
                Some(word) => Placement::from_spelling(&word).ok_or_else(|| {
                    one(format!(
                        "`{word}` is not a placement. Write `here` for the lead's workspace, \
                         `new` for one of its own, or `lead` to let the lead choose."
                    ))
                })?,
            }
        }
        Field::OnUsageLimit => {
            into.on_usage_limit = match maybe(value, key, line, at)? {
                None => OnUsageLimit::Wait,
                Some(word) => OnUsageLimit::from_spelling(&word).ok_or_else(|| {
                    one(format!(
                        "`{word}` is not something that can happen at a usage limit. Write \
                         `wait` to need a person, `same` to let the lead move the child to \
                         another subscription for the same engine, or `engine` to let it move \
                         to another engine."
                    ))
                })?,
            }
        }
        Field::OnChildLimit => {
            into.on_child_limit = match maybe(value, key, line, at)? {
                None => OnChildLimit::Ask,
                Some(word) => OnChildLimit::from_spelling(&word).ok_or_else(|| {
                    one(format!(
                        "`{word}` is not something a Manager does when a child runs out. Write \
                         `ask` to put the choice to the person, or `reroute` to pick a \
                         subscription and carry on."
                    ))
                })?,
            }
        }
        Field::CanDelegate => into.can_delegate = flag(value, key, line, at, false)?,
        Field::IncludeAlwaysOn => into.include_always_on = flag(value, key, line, at, INHERITS)?,
        Field::IncludeRepoDefaults => {
            into.include_repo_defaults = flag(value, key, line, at, INHERITS)?
        }
        Field::DelegatesTo => {
            into.delegates_to = list(value, key, lines, first, line, at)?
                .into_iter()
                .map(|(name, _)| name)
                .collect()
        }
        Field::Skills => {
            let mut out = Vec::new();
            let mut problems = Vec::new();
            for (n, (name, entry)) in list(value, key, lines, first, line, at)?
                .into_iter()
                .enumerate()
            {
                let parts: Vec<&str> = name.split('/').collect();
                let spelling = format!("{key}[{n}]");
                match parts.as_slice() {
                    [one] => out.push(SkillRef {
                        directory: None,
                        name: (*one).to_string(),
                    }),
                    [directory, one] if !directory.trim().is_empty() && !one.trim().is_empty() => {
                        out.push(SkillRef {
                            directory: Some(directory.trim().to_string()),
                            name: one.trim().to_string(),
                        })
                    }
                    _ => problems.push(said(
                        entry,
                        Some(&spelling),
                        format!(
                            "`{name}` is not a skill name. Write the skill's name on its own, \
                             or put the directory it is in in front of it, like \
                             `firetower/dataviz`."
                        ),
                    )),
                }
            }
            if !problems.is_empty() {
                return Err(problems);
            }
            into.skills = out;
        }
        Field::Settings => {
            let settings = match value {
                Value::Null => serde_yaml::Mapping::new(),
                Value::Mapping(m) => m.clone(),
                other => {
                    return Err(one(format!(
                        "`settings` holds {} where the four agent settings should be. Write them \
                         indented under `settings:`, like `model: opus`, or `~` to take the \
                         engine's defaults.",
                        shape_of(other)
                    )))
                }
            };
            let mut problems = Vec::new();
            for (spelling, value) in &settings {
                let Some(spelling) = spelling.as_str() else {
                    problems.push(said(
                        line,
                        Some(key),
                        "A setting's name has to be text. Write it as `model: opus`.".into(),
                    ));
                    continue;
                };
                let line_at = line_of(lines, first, spelling, line - first + 1);
                let named = format!("{key}.{spelling}");
                let Some(setting) = Setting::from_spelling(spelling) else {
                    problems.push(said(
                        line_at,
                        Some(&named),
                        format!(
                            "`{spelling}` is not one of an agent's settings. Write one of {}.",
                            Setting::accepted()
                        ),
                    ));
                    continue;
                };
                match maybe(value, &named, line_at, at) {
                    Ok(v) => *setting.of_mut(&mut into.settings) = v,
                    Err(mut found) => problems.append(&mut found),
                }
            }
            if !problems.is_empty() {
                return Err(problems);
            }
        }
    }
    Ok(())
}

/// A required line of text, with a blank reading as nothing written at all.
fn text(value: &Value, key: &str, line: usize, at: &str) -> Result<String, Vec<Problem>> {
    Ok(maybe(value, key, line, at)?.unwrap_or_default())
}

/// A line of text, or nothing.
///
/// Null, absent and blank are one answer: the documented default. A number or
/// a flag is refused rather than stringified — `name: 2026` is a name
/// somebody wrote without quotes, and reading it as `"2026"` would be this
/// reader deciding what they meant.
fn maybe(value: &Value, key: &str, line: usize, at: &str) -> Result<Option<String>, Vec<Problem>> {
    let said = |line: usize, key: Option<&str>, says: String| problem(at, line, key, says);
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s.contains('\n') => Err(vec![said(
            line,
            Some(key),
            format!("`{key}` has to be one line. Write it on a single line, or shorten it."),
        )]),
        Value::String(s) => Ok(Some(s.trim().to_string()).filter(|s| !s.is_empty())),
        other => Err(vec![said(
            line,
            Some(key),
            format!(
                "`{key}` has to be text, and this is {}. Put the value in quotes.",
                shape_of(other)
            ),
        )]),
    }
}

/// A switch, with absent meaning what the column defaults to.
fn flag(
    value: &Value,
    key: &str,
    line: usize,
    at: &str,
    absent: bool,
) -> Result<bool, Vec<Problem>> {
    let said = |line: usize, key: Option<&str>, says: String| problem(at, line, key, says);
    match value {
        Value::Null => Ok(absent),
        Value::Bool(b) => Ok(*b),
        other => Err(vec![said(
            line,
            Some(key),
            format!(
                "`{key}` has to be `true` or `false`, and this is {}.",
                shape_of(other)
            ),
        )]),
    }
}

/// A list of names, each with the line it is written on.
///
/// Absent, `~` and `[]` are the same answer, which is the empty list. The
/// line comes back per entry because the review has to name *which* entry of
/// a list is at fault, and an error pointing at the key would make somebody
/// read nine names to find the tenth.
fn list(
    value: &Value,
    key: &str,
    lines: &[&str],
    first: usize,
    line: usize,
    at: &str,
) -> Result<Vec<(String, usize)>, Vec<Problem>> {
    let said = |line: usize, key: Option<&str>, says: String| problem(at, line, key, says);
    let items = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Sequence(items) => items,
        other => {
            return Err(vec![said(
                line,
                Some(key),
                format!(
                    "`{key}` has to be a list, and this is {}. Write one name per line under \
                     `{key}:`, each starting with `- `.",
                    shape_of(other)
                ),
            )])
        }
    };
    let entries = entry_lines(lines, first, line, items.len());
    let mut out = Vec::new();
    let mut problems = Vec::new();
    for (n, item) in items.iter().enumerate() {
        let spelling = format!("{key}[{n}]");
        match item {
            Value::String(s) if !s.trim().is_empty() && !s.contains('\n') => {
                out.push((s.trim().to_string(), entries[n]))
            }
            Value::String(_) | Value::Null => problems.push(said(
                entries[n],
                Some(&spelling),
                format!("`{spelling}` is blank. Write a name, or remove the entry."),
            )),
            other => problems.push(said(
                entries[n],
                Some(&spelling),
                format!(
                    "`{spelling}` has to be a name, and this is {}. Put it in quotes.",
                    shape_of(other)
                ),
            )),
        }
    }
    if problems.is_empty() {
        Ok(out)
    } else {
        Err(problems)
    }
}

/// Where the frontmatter is, and what is below it.
///
/// Fails closed, and for the reason `skills::check_one_frontmatter` does: the
/// file opens with a line of exactly `---`, and the frontmatter ends at the
/// first line after it that is exactly `---`. A fence with a trailing space
/// is not one, which reads as a file with no frontmatter — and that is a
/// sentence somebody can act on, where "unexpected key at line 4" is not.
fn frame(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix(FENCE)?.strip_prefix('\n')?;
    let opened = text.len() - rest.len();
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches('\n') == FENCE {
            let frontmatter = &text[opened..opened + at];
            let body = &rest[at + line.len()..];
            return Some((frontmatter, body));
        }
        at += line.len();
    }
    None
}

/// Which line of the file spells this key.
///
/// libyaml hands back values without saying where it read them, so the line
/// is found by looking for where the file writes the key. The value is always
/// the reader's; only the line is this. Where the two could disagree — a key
/// in a flow mapping, written `{name: x}` — the answer is the line the
/// mapping starts on, which is where somebody would look anyway.
///
/// `under` is 0 for a key at the left margin, and otherwise the index just
/// past the line its parent was found on — so `settings.model` is not answered
/// by a `model:` at the left margin, and a key that cannot be found falls back
/// to its parent's own line rather than to the top of the file.
fn line_of(lines: &[&str], first: usize, key: &str, under: usize) -> usize {
    let spellings = [
        format!("{key}:"),
        format!("{key} :"),
        format!("\"{key}\":"),
        format!("'{key}':"),
    ];
    for (n, line) in lines.iter().enumerate().skip(under) {
        let indent = line.len() - line.trim_start().len();
        let nested = indent > 0;
        if (under > 0) != nested {
            continue;
        }
        let trimmed = line.trim_start();
        if spellings.iter().any(|s| trimmed.starts_with(s.as_str())) {
            return first + n;
        }
    }
    first + under.saturating_sub(1)
}

/// The line each entry of a list is written on.
///
/// Block style gives one line per entry. Flow style — `skills: [a, b]` — gives
/// the key's line for all of them, which is the only honest answer.
fn entry_lines(lines: &[&str], first: usize, line: usize, count: usize) -> Vec<usize> {
    let mut out = Vec::new();
    let start = line.saturating_sub(first);
    for (n, text) in lines.iter().enumerate().skip(start + 1) {
        let trimmed = text.trim_start();
        if trimmed.starts_with("- ") || trimmed == "-" {
            out.push(first + n);
        } else if !trimmed.is_empty() && !trimmed.starts_with('#') {
            break;
        }
        if out.len() == count {
            break;
        }
    }
    while out.len() < count {
        out.push(line);
    }
    out
}

/// What a value is, for a refusal to say so in words rather than in Rust.
fn shape_of(value: &Value) -> &'static str {
    match value {
        Value::Null => "nothing",
        Value::Bool(_) => "a true or false",
        Value::Number(_) => "a number",
        Value::String(_) => "text",
        Value::Sequence(_) => "a list",
        Value::Mapping(_) => "a block of fields",
        Value::Tagged(_) => "a tagged value",
    }
}

/// A character nobody can see, said in a way somebody can search for.
fn named(c: char) -> String {
    match c {
        '\u{0085}' => "a next-line character (U+0085)".into(),
        '\u{2028}' => "a line-separator character (U+2028)".into(),
        '\u{2029}' => "a paragraph-separator character (U+2029)".into(),
        other => format!("U+{:04X}", other as u32),
    }
}

/// The parser's sentence without its own line number.
///
/// `serde_yaml` ends every message with "at line N column M", counted from the
/// start of the frontmatter. [`Problem::line`] counts from the start of the
/// file, so leaving both in would put two different numbers for one mistake in
/// front of the same person.
fn without_location(e: &serde_yaml::Error) -> String {
    let said = e.to_string();
    match said.find(" at line ") {
        Some(at) => said[..at].to_string(),
        None => said,
    }
}

// ── writing ─────────────────────────────────────────────────────────────

/// Write a profile as a `PROFILE.md`.
///
/// **Every field, including the ones at their default**, with `~` for the ones
/// deliberately left open. Once an absent key means the documented default, a
/// file that omits a field is a file whose meaning changes when Firetower
/// changes a default — so a profile committed today would quietly become a
/// different profile after an upgrade, with nothing in any diff to show it.
/// Writing every value pins the profile to what it actually was, and makes the
/// round trip exact by construction rather than by coincidence.
pub fn serialize(profile: &Profile) -> String {
    let mut out = String::new();
    out.push_str(FENCE);
    out.push('\n');
    for written in SHAPE {
        match written {
            Written::Group(comment) => {
                out.push_str("\n# ");
                out.push_str(comment);
                out.push('\n');
            }
            Written::Field(field) => out.push_str(&write_field(*field, profile)),
        }
    }
    out.push_str(FENCE);
    out.push('\n');
    if !profile.instructions.is_empty() {
        out.push('\n');
        out.push_str(profile.instructions.trim());
        out.push('\n');
    }
    out
}

/// One field, as the lines it occupies.
///
/// Exhaustive on [`Field`], the same way the reader is, so the two halves of
/// the codec are one table walked twice rather than two lists that have to
/// agree.
fn write_field(field: Field, profile: &Profile) -> String {
    let key = field.spelling();
    let one = |value: String| format!("{key}: {value}\n");
    match field {
        Field::Key => one(scalar(&profile.key)),
        Field::Name => one(scalar(&profile.name)),
        Field::Does => one(scalar(&profile.does)),
        Field::Directory => one(open(profile.directory.as_deref())),
        Field::Engine => one(match profile.engine {
            Some(agent) => format!("{agent:?}"),
            None => OPEN.to_string(),
        }),
        Field::Placement => one(profile.placement.spelling().to_string()),
        Field::Machine => one(open(profile.machine.as_deref())),
        Field::Account => one(open(profile.account.as_deref())),
        Field::CanDelegate => one(profile.can_delegate.to_string()),
        Field::DelegatesTo => names(key, profile.delegates_to.iter().cloned()),
        Field::IncludeAlwaysOn => one(profile.include_always_on.to_string()),
        Field::IncludeRepoDefaults => one(profile.include_repo_defaults.to_string()),
        Field::Skills => names(key, profile.skills.iter().map(SkillRef::spelling)),
        Field::OnUsageLimit => one(profile.on_usage_limit.spelling().to_string()),
        Field::OnChildLimit => one(profile.on_child_limit.spelling().to_string()),
        Field::Settings => {
            let mut out = format!("{key}:\n");
            for setting in Setting::all() {
                out.push_str(&format!(
                    "  {}: {}\n",
                    setting.spelling(),
                    open(setting.of(&profile.settings).as_deref())
                ));
            }
            out
        }
    }
}

/// How a field deliberately left open is written.
const OPEN: &str = "~";

fn open(value: Option<&str>) -> String {
    match value {
        Some(v) => scalar(v),
        None => OPEN.to_string(),
    }
}

/// A list of names, block style, or `[]` for an empty one.
///
/// `[]` rather than `~`: an empty list is a value — no extra skills, or any
/// teammate the owner can see — and writing it as the open mark would say
/// somebody left the question open when they did not. Both read back as the
/// empty list, so nothing depends on the difference; what depends on it is
/// whether the file tells the truth about itself.
fn names(key: &str, values: impl Iterator<Item = String>) -> String {
    let values: Vec<String> = values.collect();
    if values.is_empty() {
        return format!("{key}: []\n");
    }
    let mut out = format!("{key}:\n");
    for value in values {
        out.push_str(&format!("  - {}\n", scalar(&value)));
    }
    out
}

/// One scalar, written so that libyaml reads back exactly the string it was
/// given.
///
/// **The reader decides which spelling is safe.** A plain scalar is tried
/// first, because a file people read in a pull request should not be a wall of
/// quotes, and it is kept only if libyaml hands the same string back — so
/// `name: Designer` stays plain while `does: 2026`, `name: null` and anything
/// holding a `: ` or a leading `#` are quoted, without this function carrying
/// a table of YAML's resolution rules that could be short of one.
///
/// Quoting is double rather than single, so the three characters libyaml ends
/// a line on and a `\n` count does not can be *spelled* rather than written.
/// A value holding one is refused on the way in, which makes this the writer's
/// half of the same rule: it cannot produce a file its own reader refuses.
fn scalar(value: &str) -> String {
    if reads_back(value, value) {
        return value.to_string();
    }
    let quoted = quoted(value);
    debug_assert!(
        reads_back(&quoted, value),
        "libyaml does not read {quoted} back as {value:?}"
    );
    quoted
}

/// Whether libyaml, given this spelling, hands back exactly this string.
fn reads_back(spelling: &str, value: &str) -> bool {
    if spelling.is_empty() || spelling.contains('\n') {
        return false;
    }
    let probe = format!("k: {spelling}\n");
    match serde_yaml::from_str::<Value>(&probe) {
        Ok(Value::Mapping(m)) => {
            let mut pairs = m.iter();
            match (pairs.next(), pairs.next()) {
                (Some((k, v)), None) => {
                    k.as_str() == Some("k") && v == &Value::String(value.to_string())
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// A double-quoted YAML scalar, escaped the way YAML spells escapes.
fn quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0085}' => out.push_str("\\N"),
            '\u{2028}' => out.push_str("\\L"),
            '\u{2029}' => out.push_str("\\P"),
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ── tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::{
        ASKS_THE_PERSON, ON_CHILD_LIMIT, ON_USAGE_LIMIT, PLACEMENT, WAITS_FOR_A_PERSON,
    };

    /// Where a fixture's errors say they came from. Any path does, as long as
    /// the problems carry it.
    fn at(key: &str) -> std::path::PathBuf {
        std::path::Path::new("profiles")
            .join(key)
            .join("PROFILE.md")
    }

    fn read(key: &str, text: &str) -> Result<Profile, Vec<Problem>> {
        parse(&at(key), key, text)
    }

    fn refused(key: &str, text: &str) -> Vec<Problem> {
        match read(key, text) {
            Ok(p) => panic!("{key} parsed when it should not have: {p:#?}"),
            Err(problems) => problems,
        }
    }

    fn accepted(key: &str, text: &str) -> Profile {
        match read(key, text) {
            Ok(p) => p,
            Err(problems) => panic!("{key} refused: {problems:#?}"),
        }
    }

    /// The problem about one key, which is how most of these assert.
    fn about<'a>(problems: &'a [Problem], key: &str) -> &'a Problem {
        problems
            .iter()
            .find(|p| p.key.as_deref() == Some(key))
            .unwrap_or_else(|| panic!("nothing said about {key}: {problems:#?}"))
    }

    // ── the format's own values ─────────────────────────────────────────

    /// **The three enums spell what the API validates against.**
    ///
    /// The types in this module exist so the reader and the writer cannot
    /// spell a value differently from each other. That leaves one way for them
    /// to be wrong — spelling it differently from the endpoint the import
    /// eventually calls — which is what this is. The string tables are
    /// `roles.rs`'s, and `check` refuses anything not in them, so a value this
    /// codec invented would parse here and be refused one call later.
    #[test]
    fn enums_agree_with_the_api() {
        let spellings = |v: Vec<&'static str>| v;
        assert_eq!(
            Placement::all()
                .iter()
                .map(|p| p.spelling())
                .collect::<Vec<_>>(),
            spellings(PLACEMENT.to_vec())
        );
        assert_eq!(
            OnUsageLimit::all()
                .iter()
                .map(|v| v.spelling())
                .collect::<Vec<_>>(),
            spellings(ON_USAGE_LIMIT.to_vec())
        );
        assert_eq!(
            OnChildLimit::all()
                .iter()
                .map(|v| v.spelling())
                .collect::<Vec<_>>(),
            spellings(ON_CHILD_LIMIT.to_vec())
        );
    }

    /// **An absent key is the column default, read from where the server
    /// already states it.**
    ///
    /// `Profile::bare` is where the "absent means the documented default"
    /// decision is implemented, and these are the four values that would
    /// silently diverge if somebody changed a column default and not this —
    /// which is the exact drift the decision exists to prevent.
    #[test]
    fn the_defaults_are_the_documented_ones() {
        let bare = Profile::bare("designer");
        assert_eq!(bare.placement, Placement::Lead, "the open placement");
        assert_eq!(bare.on_usage_limit.spelling(), WAITS_FOR_A_PERSON);
        assert_eq!(bare.on_child_limit.spelling(), ASKS_THE_PERSON);
        assert_eq!(bare.include_always_on, INHERITS);
        assert_eq!(bare.include_repo_defaults, INHERITS);
        assert!(!bare.can_delegate, "an Operator unless somebody says so");
        assert_eq!(bare.engine, None, "the lead's choice");
        assert!(bare.machine.is_none() && bare.account.is_none() && bare.directory.is_none());
        assert!(bare.delegates_to.is_empty() && bare.skills.is_empty());
        assert!(bare.settings.is_empty(), "the engine's defaults");
    }

    /// A file that says nothing but its two required fields is a profile at
    /// every default. This is the sentence the whole format rests on, so it is
    /// asserted as one equality rather than field by field.
    #[test]
    fn a_file_with_fourteen_fields_absent_is_a_complete_profile() {
        let read = accepted(
            "designer",
            "---\nname: Designer\ndoes: Designs things.\n---\n\nBe a designer.\n",
        );
        let mut want = Profile::bare("designer");
        want.name = "Designer".into();
        want.does = "Designs things.".into();
        want.instructions = "Be a designer.".into();
        assert_eq!(read, want);
    }

    // ── the round trip, in both directions ──────────────────────────────

    /// A profile with every field carrying something other than its default,
    /// which is what the corpus varies one field at a time from.
    fn dense() -> Profile {
        Profile {
            key: "engineering-manager".into(),
            name: "Engineering Manager".into(),
            does: "Orchestrates feature delivery from request to draft PRs.".into(),
            instructions: "# Engineering Manager\n\nYou own feature delivery.".into(),
            engine: Some(ft_core::Agent::ClaudeCode),
            placement: Placement::New,
            machine: Some("mac-studio".into()),
            account: Some("Anthropic Max".into()),
            directory: Some("Platform".into()),
            can_delegate: true,
            delegates_to: vec!["Designer".into(), "Engineer".into(), "QA".into()],
            skills: vec![
                SkillRef {
                    directory: None,
                    name: "wayfinder".into(),
                },
                SkillRef {
                    directory: Some("firetower".into()),
                    name: "dataviz".into(),
                },
            ],
            include_always_on: false,
            include_repo_defaults: false,
            on_usage_limit: OnUsageLimit::Engine,
            on_child_limit: OnChildLimit::Reroute,
            settings: ft_core::controls::Preferred {
                model: Some("opus".into()),
                effort: Some("high".into()),
                mode: Some("acceptEdits".into()),
                sandbox: Some("workspace-write".into()),
            },
        }
    }

    /// Values that are a string to a person and something else to YAML, plus
    /// the two shapes that have caught a quoting rule before: a value that is
    /// the open mark, and a value that is empty.
    ///
    /// Every one of these is legal in a `name`, a machine's name or a model's,
    /// and none of them can be written plainly. They are here so the writer's
    /// quoting is asserted against libyaml rather than against a list of
    /// characters somebody thought of.
    const AWKWARD: [&str; 19] = [
        "2026",
        "0x10",
        "1e3",
        ".inf",
        "null",
        "~",
        "true",
        "False",
        "yes",
        "#one",
        "a: b",
        "- a",
        "{a: b}",
        "[a]",
        "*anchor",
        "!tag",
        "'quoted'",
        "\"double quoted\"",
        "ends with a colon:",
    ];

    /// Every alternative value for one field.
    ///
    /// Exhaustive on [`Field`], so a field added to the enum does not compile
    /// until the corpus varies it — which is what stops the round trip from
    /// passing because nothing ever asked about the new field.
    fn alternatives(field: Field) -> Vec<Profile> {
        let mut out = Vec::new();
        let mut push = |f: &dyn Fn(&mut Profile)| {
            let mut p = dense();
            f(&mut p);
            out.push(p);
        };
        match field {
            // The key is the folder's name and `parse` is told it, so the
            // corpus varies it the way a folder does.
            Field::Key => {
                push(&|p| p.key = "designer".into());
                push(&|p| p.key = "qa-engineer".into());
            }
            Field::Name => {
                push(&|p| p.name = "QA".into());
                for awkward in AWKWARD {
                    push(&|p| p.name = awkward.into());
                }
            }
            Field::Does => {
                push(&|p| p.does = "Tests things.".into());
                push(&|p| p.does = "Says \"no\" when it must, and # when it must not.".into());
            }
            Field::Directory => {
                push(&|p| p.directory = None);
                for awkward in AWKWARD {
                    push(&|p| p.directory = Some(awkward.into()));
                }
            }
            Field::Engine => {
                push(&|p| p.engine = None);
                for agent in ft_core::Agent::every() {
                    push(&|p| p.engine = Some(agent));
                }
            }
            Field::Placement => {
                for placement in Placement::all() {
                    push(&|p| p.placement = placement);
                }
            }
            Field::Machine => {
                push(&|p| p.machine = None);
                for awkward in AWKWARD {
                    push(&|p| p.machine = Some(awkward.into()));
                }
            }
            Field::Account => {
                push(&|p| p.account = None);
                for awkward in AWKWARD {
                    push(&|p| p.account = Some(awkward.into()));
                }
            }
            Field::CanDelegate => {
                push(&|p| p.can_delegate = true);
                push(&|p| p.can_delegate = false);
            }
            Field::DelegatesTo => {
                push(&|p| p.delegates_to = Vec::new());
                push(&|p| p.delegates_to = vec!["Security Advisor".into()]);
                for awkward in AWKWARD {
                    push(&|p| p.delegates_to = vec![awkward.into(), "Engineer".into()]);
                }
            }
            Field::IncludeAlwaysOn => {
                push(&|p| p.include_always_on = true);
                push(&|p| p.include_always_on = false);
            }
            Field::IncludeRepoDefaults => {
                push(&|p| p.include_repo_defaults = true);
                push(&|p| p.include_repo_defaults = false);
            }
            Field::Skills => {
                push(&|p| p.skills = Vec::new());
                push(&|p| {
                    p.skills = vec![SkillRef {
                        directory: None,
                        name: "dataviz".into(),
                    }]
                });
                // The same name in two directories, which is the whole reason
                // a reference may be qualified.
                push(&|p| {
                    p.skills = vec![
                        SkillRef {
                            directory: Some("firetower".into()),
                            name: "dataviz".into(),
                        },
                        SkillRef {
                            directory: Some("fstack".into()),
                            name: "dataviz".into(),
                        },
                    ]
                });
            }
            Field::OnUsageLimit => {
                for on in OnUsageLimit::all() {
                    push(&|p| p.on_usage_limit = on);
                }
            }
            Field::OnChildLimit => {
                for on in OnChildLimit::all() {
                    push(&|p| p.on_child_limit = on);
                }
            }
            Field::Settings => {
                push(&|p| p.settings = ft_core::controls::Preferred::default());
                for setting in Setting::all() {
                    push(&|p| {
                        let mut only = ft_core::controls::Preferred::default();
                        *setting.of_mut(&mut only) = Some("something".into());
                        p.settings = only;
                    });
                    for awkward in AWKWARD {
                        push(&|p| *setting.of_mut(&mut p.settings) = Some(awkward.into()));
                    }
                }
            }
        }
        out
    }

    /// Bodies that have to survive being written and read again.
    fn bodies() -> Vec<String> {
        vec![
            String::new(),
            "One line.".into(),
            "# A heading\n\nA paragraph, with a `code span` in it.".into(),
            // A fence in the body is not the frontmatter's close: the parser
            // has already found that before it reads any of this.
            "Before.\n\n---\n\nAfter.".into(),
            // Frontmatter-shaped prose, for the same reason.
            "name: not a field\ndoes: also not one".into(),
            "A body ending in a fence.\n\n---".into(),
        ]
    }

    /// The least a file can say: the two required fields, and every other
    /// field at its documented default.
    fn plainest() -> Profile {
        let mut p = Profile::bare("designer");
        p.name = "Designer".into();
        p.does = "Designs things.".into();
        p.instructions = "Be a designer.".into();
        p
    }

    /// Every profile the properties below are asked about.
    ///
    /// Not [`Profile::bare`] itself: a profile with no `name` is one no file
    /// describes, so serializing it produces a file this module's own parser
    /// refuses. That is the required-field rule doing its job rather than a
    /// hole in the round trip, and [`plainest`] is the profile at the bottom
    /// of the lattice that a file can actually hold.
    fn corpus() -> Vec<Profile> {
        let mut out = vec![dense(), plainest()];
        for field in Field::all() {
            out.extend(alternatives(field));
        }
        for body in bodies() {
            let mut p = dense();
            p.instructions = body;
            out.push(p);
        }
        out
    }

    /// **The round-trip property: serialize anything, parse it, get it back.**
    ///
    /// One test for three bug classes — a field the writer forgot, a field the
    /// parser drops, and an enum spelled differently on each side. The first
    /// two are compile errors in this module and the third is unspellable, so
    /// what this really asserts is that those mechanisms are still the ones in
    /// force.
    #[test]
    fn serialize_then_parse_is_the_same_profile() {
        for want in corpus() {
            let written = serialize(&want);
            let read = parse(&at(&want.key), &want.key, &written).unwrap_or_else(|problems| {
                panic!("a file this module wrote will not parse: {problems:#?}\n{written}")
            });
            assert_eq!(read, want, "round trip changed the profile:\n{written}");
        }
    }

    /// **The other direction: what a person ends up with in their repository.**
    ///
    /// Export writes the file somebody commits, so parsing a hand-written file
    /// and writing it back has to settle. One pass canonicalises — fields in
    /// the canonical order, every default written out, `~` for the open ones —
    /// and the pass after that changes nothing. Without this, a committed
    /// profile could produce a diff every time it was exported.
    #[test]
    fn parse_then_serialize_is_stable() {
        let mut files: Vec<(String, String)> = corpus()
            .into_iter()
            .map(|p| (p.key.clone(), serialize(&p)))
            .collect();
        for (key, text) in REPAIRED {
            files.push(((*key).to_string(), (*text).to_string()));
        }
        for (key, text) in files {
            let once = serialize(&accepted(&key, &text));
            let twice = serialize(&accepted(&key, &once));
            assert_eq!(once, twice, "writing {key} again changed it");
        }
    }

    /// **The corpus varies every field, and the writer writes every field.**
    ///
    /// The round trip above can only catch a dropped field if something in the
    /// corpus changes it. So each field is asked for its own evidence: two
    /// profiles that differ in it, whose *files* differ too. A writer that
    /// forgot a field would produce one file for both and fail here, by the
    /// name of the field it forgot, rather than quietly leaving the property
    /// true and empty.
    #[test]
    fn every_field_is_written_and_read_back() {
        for field in Field::all() {
            let variants = alternatives(field);
            assert!(
                variants.len() >= 2,
                "{} has no alternatives in the corpus",
                field.spelling()
            );
            let files: BTreeSet<String> = variants.iter().map(serialize).collect();
            assert!(
                files.len() >= 2,
                "two profiles differing only in `{}` are written as the same file, so the \
                 writer is dropping it",
                field.spelling()
            );
            for want in variants {
                assert_eq!(
                    accepted(&want.key, &serialize(&want)),
                    want,
                    "`{}` does not survive the round trip",
                    field.spelling()
                );
            }
        }
    }

    /// Every field has a place in the file, and only one.
    ///
    /// [`Field::then`] makes a new variant a compile error until it is in the
    /// order; this is the half that makes it an error until it is also in
    /// [`SHAPE`], which is what the writer actually walks.
    #[test]
    fn the_shape_holds_every_field_once() {
        let written: Vec<Field> = SHAPE
            .iter()
            .filter_map(|w| match w {
                Written::Field(f) => Some(*f),
                Written::Group(_) => None,
            })
            .collect();
        assert_eq!(written.len(), Field::all().len());
        for field in Field::all() {
            assert_eq!(
                written.iter().filter(|w| **w == field).count(),
                1,
                "`{}` is not written exactly once",
                field.spelling()
            );
        }
    }

    /// What an exported file looks like, pinned so a change to it is a change
    /// somebody has to look at.
    ///
    /// This is the specification's canonical order and grouping, which is a
    /// requirement rather than a preference: the file is read in a pull
    /// request, and a diff of eighty lines in an order nobody chose is the
    /// cost of not having one.
    #[test]
    fn a_written_profile_reads_as_the_specification_says() {
        assert_eq!(
            serialize(&dense()),
            "\
---
key: engineering-manager
name: Engineering Manager
does: Orchestrates feature delivery from request to draft PRs.

# Where the profile itself is filed. `~` is your own space.
directory: Platform

# Where and how its children run. `~` leaves the choice to the lead.
engine: ClaudeCode
placement: new
machine: mac-studio
account: Anthropic Max

# Delegation.
can_delegate: true
delegates_to:
  - Designer
  - Engineer
  - QA

# Skills: the two inherited sources, plus this profile's own list.
include_always_on: false
include_repo_defaults: false
skills:
  - wayfinder
  - firetower/dataviz

# What happens when a child runs out of allowance.
on_usage_limit: engine
on_child_limit: reroute

# How it runs its agent. `~` takes the engine's default.
settings:
  model: opus
  effort: high
  mode: acceptEdits
  sandbox: workspace-write
---

# Engineering Manager

You own feature delivery.
"
        );
    }

    /// A profile at every default, written out. The open marks and the two
    /// empty lists are the whole of what this pins, and they are the two
    /// places `~` and `[]` have to stay told apart.
    #[test]
    fn an_open_profile_is_written_with_the_open_mark() {
        let mut bare = Profile::bare("designer");
        bare.name = "Designer".into();
        bare.does = "Designs things.".into();
        let written = serialize(&bare);
        assert!(written.contains("directory: ~"), "{written}");
        assert!(written.contains("machine: ~\naccount: ~"), "{written}");
        assert!(written.contains("delegates_to: []"), "{written}");
        assert!(written.contains("skills: []"), "{written}");
        assert!(written.contains("  model: ~\n  effort: ~"), "{written}");
        // Nothing after the closing fence, because there is no body to write.
        assert!(written.ends_with("  sandbox: ~\n---\n"), "{written}");
    }

    // ── the writer's quoting, against libyaml ───────────────────────────

    /// **The writer quotes what libyaml would read as something else.**
    ///
    /// [`scalar`] asks the reader rather than carrying a table, so these are
    /// not a list of rules to maintain — they are the cases that show the
    /// question is being asked at all. A value that is the open mark and a
    /// value that is empty are the two that matter most: one would silently
    /// become "open" and the other would vanish.
    #[test]
    fn a_scalar_is_written_so_libyaml_reads_it_back() {
        assert_eq!(scalar("Engineering Manager"), "Engineering Manager");
        assert_eq!(scalar("QA"), "QA");
        assert_eq!(scalar("2026"), "\"2026\"");
        assert_eq!(scalar("~"), "\"~\"");
        assert_eq!(scalar("null"), "\"null\"");
        assert_eq!(scalar("true"), "\"true\"");
        assert_eq!(scalar(""), "\"\"");
        assert_eq!(scalar("#one"), "\"#one\"");
        assert_eq!(scalar("a: b"), "\"a: b\"");
        // Plain, and this is the case a hand-written quoting table gets
        // wrong: a double quote only opens a scalar in first position, so
        // libyaml reads this one back exactly as written.
        assert_eq!(scalar("say \"no\""), "say \"no\"");
        // In first position it is an opening quote, so the value is escaped.
        assert_eq!(scalar("\"quoted\""), "\"\\\"quoted\\\"\"");
        // YAML 1.2 is what libyaml resolves with, so these stay plain. The
        // assertion is here because the reader is the thing that decides, and
        // a reader that changed its mind about them would change this line.
        assert_eq!(scalar("yes"), "yes");
        assert_eq!(scalar("12:30"), "12:30");
    }

    /// A machine actually called `~` is not a machine left open.
    #[test]
    fn a_value_that_is_the_open_mark_survives() {
        let mut want = Profile::bare("designer");
        want.name = "Designer".into();
        want.does = "Designs things.".into();
        want.machine = Some("~".into());
        let read = accepted("designer", &serialize(&want));
        assert_eq!(read.machine.as_deref(), Some("~"));
    }

    // ── the five real bundles ───────────────────────────────────────────

    /// `fstack/profiles/`, byte for byte, including the trailing newline each
    /// one is missing. See `fixtures/profiles/README.md`.
    const REAL: [(&str, &str); 5] = [
        (
            "designer",
            include_str!("../../../../fixtures/profiles/fstack/designer/PROFILE.md"),
        ),
        (
            "engineer",
            include_str!("../../../../fixtures/profiles/fstack/engineer/PROFILE.md"),
        ),
        (
            "engineering-manager",
            include_str!("../../../../fixtures/profiles/fstack/engineering-manager/PROFILE.md"),
        ),
        (
            "qa-engineer",
            include_str!("../../../../fixtures/profiles/fstack/qa-engineer/PROFILE.md"),
        ),
        (
            "security-advisor",
            include_str!("../../../../fixtures/profiles/fstack/security-advisor/PROFILE.md"),
        ),
    ];

    /// The same five with the smallest edit that makes each one a bundle:
    /// `description` becomes `does`, and the three that have no frontmatter
    /// gain one. Fourteen of the sixteen fields are still absent, which is
    /// what makes them the realistic input.
    const REPAIRED: [(&str, &str); 5] = [
        (
            "designer",
            include_str!("../../../../fixtures/profiles/fstack-repaired/designer/PROFILE.md"),
        ),
        (
            "engineer",
            include_str!("../../../../fixtures/profiles/fstack-repaired/engineer/PROFILE.md"),
        ),
        (
            "engineering-manager",
            include_str!(
                "../../../../fixtures/profiles/fstack-repaired/engineering-manager/PROFILE.md"
            ),
        ),
        (
            "qa-engineer",
            include_str!("../../../../fixtures/profiles/fstack-repaired/qa-engineer/PROFILE.md"),
        ),
        (
            "security-advisor",
            include_str!(
                "../../../../fixtures/profiles/fstack-repaired/security-advisor/PROFILE.md"
            ),
        ),
    ];

    /// **None of the five real bundles parses, and each one says why.**
    ///
    /// The format was specified after these files were written, so they are
    /// the first thing it meets. Two carry `description`, which is a skill's
    /// word; three are markdown with no frontmatter at all. Refusing is the
    /// right answer for all five — they are prose that was never connected to
    /// a live profile — so what is asserted is the sentence each one gets,
    /// because that sentence is the only thing between somebody and the
    /// conclusion that the feature is broken.
    #[test]
    fn the_five_real_bundles_refuse_and_say_what_to_do() {
        for (key, text) in REAL {
            let problems = refused(key, text);
            for problem in &problems {
                assert_eq!(problem.path, at(key).display().to_string());
                assert!(problem.line >= 1, "{problem:#?}");
            }
            if text.starts_with("---") {
                // `description` is named, and so is the field to write.
                let said = &about(&problems, "description").says;
                assert!(
                    said.contains("`description` is not a profile field"),
                    "{said}"
                );
                assert!(said.contains("`does`"), "{said}");
                assert!(
                    about(&problems, "does").says.contains("Add `does:`"),
                    "{problems:#?}"
                );
            } else {
                assert_eq!(problems.len(), 1, "{problems:#?}");
                let said = &problems[0].says;
                assert!(said.contains("no frontmatter"), "{said}");
                assert!(said.contains("`name`") && said.contains("`does`"), "{said}");
                assert_eq!(problems[0].line, 1);
            }
        }
    }

    /// **The five, repaired, parse to complete profiles full of defaults.**
    ///
    /// This is the realistic input the format has to handle: a hand-written
    /// file naming two fields out of sixteen. Every other field has to come
    /// out at its documented default rather than as a hole somebody downstream
    /// has to fill in.
    #[test]
    fn the_five_repaired_bundles_parse_to_complete_profiles() {
        for (key, text) in REPAIRED {
            let read = accepted(key, text);
            assert_eq!(read.key, key, "the folder is the identity");
            assert!(!read.name.is_empty() && !read.does.is_empty());
            assert!(
                read.instructions.starts_with('#'),
                "{key} lost its body: {:?}",
                read.instructions
            );
            // Everything the file does not mention is the column default.
            let mut want = Profile::bare(key);
            want.name = read.name.clone();
            want.does = read.does.clone();
            want.instructions = read.instructions.clone();
            assert_eq!(read, want, "{key} picked up something the file never said");
        }
    }

    /// The folder name and the `name` genuinely diverge in real data.
    ///
    /// `qa-engineer/` is a folder whose live profile is called **QA**. Whether
    /// that is the same profile is #355's question; what matters here is that
    /// the codec never quietly decides they must agree.
    #[test]
    fn a_folder_name_and_a_name_may_diverge() {
        let (key, text) = REPAIRED[3];
        assert_eq!(key, "qa-engineer");
        let read = accepted(key, text);
        assert_eq!(read.key, "qa-engineer");
        assert_eq!(read.name, "QA");
    }

    // ── the error table ─────────────────────────────────────────────────

    /// A file with one field added to the shape every other test uses.
    fn with(fields: &str) -> String {
        only(&format!("name: Designer\ndoes: Designs things.\n{fields}"))
    }

    /// A file whose whole frontmatter is this, for the fields `with` already
    /// writes. YAML refuses a duplicate key, so a test replacing `name` has to
    /// write the frontmatter rather than add to it.
    fn only(fields: &str) -> String {
        format!("---\n{fields}---\n\nBe a designer.\n")
    }

    /// `key:` is optional, says the same thing the folder does, and a
    /// disagreement is a refusal rather than a precedence rule.
    #[test]
    fn key_is_optional_and_has_to_agree_with_the_folder() {
        assert_eq!(accepted("designer", &with("")).key, "designer");
        assert_eq!(
            accepted("designer", &with("key: designer\n")).key,
            "designer"
        );

        let problems = refused("designer", &with("key: Designer\n"));
        let said = &about(&problems, "key").says;
        assert!(said.contains("`key: Designer`"), "{said}");
        assert!(said.contains("`designer`"), "{said}");
        // Both ways out, because either one may be the mistake.
        assert!(said.contains("rename the folder"), "{said}");
        assert_eq!(about(&problems, "key").line, 4);
    }

    /// **An unknown key is an error naming the key.** A typo'd `placment:`
    /// that imports cleanly and does nothing is the failure the format exists
    /// to remove, so this is the acceptance criterion the whole feature rests
    /// on.
    #[test]
    fn an_unknown_key_is_named() {
        let problems = refused("designer", &with("placment: here\n"));
        let said = &about(&problems, "placment").says;
        assert!(said.contains("`placment` is not a profile field"), "{said}");
        assert!(said.contains("Did you mean `placement`?"), "{said}");
        assert_eq!(about(&problems, "placment").line, 4);

        // The API's own casing, which a person who read the endpoint first
        // will write. Four edits away, so distance alone would not find it.
        let problems = refused("designer", &with("canDelegate: true\n"));
        assert!(
            about(&problems, "canDelegate")
                .says
                .contains("Did you mean `can_delegate`?"),
            "{problems:#?}"
        );

        // Nothing like any field: the vocabulary, so the line can be fixed.
        let problems = refused("designer", &with("colour: red\n"));
        let said = &about(&problems, "colour").says;
        assert!(said.contains("`colour` is not a profile field"), "{said}");
        for field in Field::all() {
            assert!(said.contains(field.spelling()), "{said} omits {field:?}");
        }
    }

    /// `instructions:` in the frontmatter is the other guessable mistake, and
    /// the body is where they go.
    #[test]
    fn instructions_in_the_frontmatter_says_where_they_go() {
        let problems = refused("designer", &with("instructions: Do things.\n"));
        let said = &about(&problems, "instructions").says;
        assert!(said.contains("markdown below the frontmatter"), "{said}");
    }

    /// **An invalid enum value lists what is accepted**, and the list is
    /// derived from the enum rather than written beside it, so a fourth
    /// placement would appear here without anybody editing the sentence.
    #[test]
    fn an_invalid_enum_lists_what_is_accepted() {
        let problems = refused("designer", &with("placement: everywhere\n"));
        let said = &about(&problems, "placement").says;
        assert!(said.contains("`everywhere` is not a placement"), "{said}");
        for placement in Placement::all() {
            assert!(said.contains(placement.spelling()), "{said}");
        }

        let problems = refused("designer", &with("on_usage_limit: whenever\n"));
        let said = &about(&problems, "on_usage_limit").says;
        for on in OnUsageLimit::all() {
            assert!(said.contains(on.spelling()), "{said}");
        }

        let problems = refused("designer", &with("on_child_limit: maybe\n"));
        let said = &about(&problems, "on_child_limit").says;
        for on in OnChildLimit::all() {
            assert!(said.contains(on.spelling()), "{said}");
        }

        let problems = refused("designer", &with("engine: Claude\n"));
        let said = &about(&problems, "engine").says;
        assert!(said.contains("`Claude` is not an engine"), "{said}");
        for agent in ft_core::Agent::all() {
            assert!(said.contains(&format!("{agent:?}")), "{said}");
        }
    }

    /// Every engine the API accepts, the codec accepts.
    ///
    /// `Agent::all()` is the four a person is offered and `Agent::from_name`
    /// is what `roles::check` validates against, which also takes `Shell` — a
    /// variant nothing offers and a stored row may still hold. The codec takes
    /// what the API takes rather than holding a second opinion, so exporting
    /// such a row produces a file that can be read back. The refusal lists the
    /// four, because listing `Shell` would offer something that cannot happen.
    #[test]
    fn the_engines_are_the_ones_the_api_accepts() {
        for agent in ft_core::Agent::every() {
            let text = with(&format!("engine: {agent:?}\n"));
            assert_eq!(accepted("designer", &text).engine, Some(agent));
        }
    }

    /// **A missing `name` or `does` is an error.**
    #[test]
    fn a_missing_name_or_does_is_an_error() {
        let problems = refused("designer", "---\ndoes: Designs things.\n---\n");
        assert!(about(&problems, "name").says.contains("Add `name:`"));

        let problems = refused("designer", "---\nname: Designer\n---\n");
        assert!(about(&problems, "does").says.contains("Add `does:`"));

        // Blank is absent, not present and empty.
        let problems = refused("designer", "---\nname: \"  \"\ndoes: \"\"\n---\n");
        assert_eq!(problems.len(), 2, "{problems:#?}");

        // A frontmatter with nothing in it is missing both, rather than being
        // a complaint about the shape of the file.
        let problems = refused("designer", "---\n---\n");
        assert_eq!(problems.len(), 2, "{problems:#?}");
    }

    /// **Malformed YAML is the parser's own line, and not a panic.**
    #[test]
    fn malformed_yaml_says_where() {
        let problems = refused("designer", "---\nname: Designer\ndoes: : nope\n---\n");
        assert_eq!(problems.len(), 1, "{problems:#?}");
        let problem = &problems[0];
        assert_eq!(problem.line, 3, "the line the parser stopped on");
        assert!(problem
            .says
            .starts_with("The frontmatter is not valid YAML."));
        // One number for one mistake: the parser counts from the frontmatter
        // and `line` counts from the file, so the parser's own is taken off.
        assert!(!problem.says.contains("at line"), "{}", problem.says);

        // An unterminated flow sequence, which stops at the end of the region.
        let problems = refused("designer", "---\nname: Designer\nskills: [a\n---\n");
        assert_eq!(problems.len(), 1, "{problems:#?}");
        assert!(problems[0].says.contains("not valid YAML"));
    }

    /// **A field written twice is refused, not resolved.**
    ///
    /// libyaml's own answer, and the right one: a file with two `name:` lines
    /// has two authors' intentions in it, and silently keeping the last would
    /// make the file say something neither of them wrote. Found by a test that
    /// meant to write something else, which is the only reason it is pinned.
    #[test]
    fn a_field_written_twice_is_refused() {
        let problems = refused("designer", &with("name: Someone Else\n"));
        assert_eq!(problems.len(), 1, "{problems:#?}");
        assert!(
            problems[0].says.contains("duplicate entry"),
            "{problems:#?}"
        );
        assert!(problems[0].says.contains("name"), "{problems:#?}");
    }

    /// A frontmatter that is not a block of fields.
    #[test]
    fn a_frontmatter_that_is_not_fields_says_so() {
        let problems = refused("designer", "---\n- Designer\n- Designs things.\n---\n");
        assert_eq!(problems.len(), 1, "{problems:#?}");
        assert!(problems[0].says.contains("a list where a profile's fields"));
        assert!(problems[0].says.contains("`name: Designer`"));
    }

    /// **A skill reference may be bare or qualified by its directory.**
    ///
    /// Two reachable skills may share a name, so without the qualifier such a
    /// skill would be unnameable from a file.
    #[test]
    fn a_skill_may_be_qualified_by_a_directory() {
        let read = accepted(
            "designer",
            &with("skills:\n  - dataviz\n  - firetower/dataviz\n"),
        );
        assert_eq!(
            read.skills,
            vec![
                SkillRef {
                    directory: None,
                    name: "dataviz".into()
                },
                SkillRef {
                    directory: Some("firetower".into()),
                    name: "dataviz".into()
                },
            ]
        );

        // Anything else is not a reference, and the error says which entry.
        let problems = refused(
            "designer",
            &with("skills:\n  - dataviz\n  - a/b/c\n  - /d\n"),
        );
        assert!(
            about(&problems, "skills[1]").says.contains("`a/b/c`"),
            "{problems:#?}"
        );
        assert!(
            about(&problems, "skills[2]")
                .says
                .contains("firetower/dataviz"),
            "{problems:#?}"
        );
        assert_eq!(about(&problems, "skills[1]").line, 6);
        assert_eq!(about(&problems, "skills[2]").line, 7);
    }

    /// Which entry of a list is at fault, which is what #355 renders.
    #[test]
    fn a_blank_entry_names_its_position() {
        let problems = refused(
            "designer",
            &with("delegates_to:\n  - Designer\n  -\n  - Engineer\n"),
        );
        let problem = about(&problems, "delegates_to[1]");
        assert!(problem.says.contains("is blank"), "{problem:#?}");
        assert_eq!(problem.line, 6);
    }

    /// A list written as something else, and a setting that is not one.
    #[test]
    fn the_wrong_shape_says_what_the_right_one_is() {
        let problems = refused("designer", &with("skills: dataviz\n"));
        let said = &about(&problems, "skills").says;
        assert!(said.contains("has to be a list"), "{said}");
        assert!(said.contains("- "), "{said}");

        let problems = refused("designer", &with("can_delegate: yes please\n"));
        assert!(about(&problems, "can_delegate")
            .says
            .contains("`true` or `false`"));

        let problems = refused("designer", &only("name: 2026\ndoes: Designs.\n"));
        assert!(about(&problems, "name")
            .says
            .contains("Put the value in quotes"));
        // And the field is not also reported as missing: it is there, and it
        // is wrong, which is one problem rather than two.
        assert_eq!(problems.len(), 1, "{problems:#?}");

        let problems = refused("designer", &with("settings:\n  temperature: 0.4\n"));
        let problem = about(&problems, "settings.temperature");
        assert!(problem.says.contains("not one of an agent's settings"));
        for setting in Setting::all() {
            assert!(problem.says.contains(setting.spelling()), "{problem:#?}");
        }
        assert_eq!(problem.line, 5);
    }

    /// `does` is one line, however it is written.
    #[test]
    fn does_is_one_line() {
        // A folded block scalar is one line once libyaml has folded it, so it
        // is a legal way to write a long one.
        let read = accepted(
            "designer",
            "---\nname: Designer\ndoes: >-\n  Designs things,\n  carefully.\n---\n",
        );
        assert_eq!(read.does, "Designs things, carefully.");

        // A literal one is not.
        let problems = refused(
            "designer",
            "---\nname: Designer\ndoes: |-\n  Designs things,\n  carefully.\n---\n",
        );
        assert!(about(&problems, "does").says.contains("has to be one line"));
    }

    /// **Every problem carries a path and a line somebody can act on.**
    ///
    /// Asserted over every refusal in this module's own table rather than one
    /// at a time: an error that cannot say which of twelve files it came from
    /// is not actionable, and the only way for that to stay true is for it to
    /// be asked of all of them.
    #[test]
    fn every_problem_carries_a_path_and_a_line() {
        let broken: Vec<String> = vec![
            with("placment: here\n"),
            with("key: Designer\n"),
            with("placement: everywhere\n"),
            with("engine: Claude\n"),
            with("skills:\n  - a/b/c\n"),
            with("delegates_to:\n  -\n"),
            with("settings:\n  temperature: 0.4\n"),
            with("settings: 4\n"),
            only("name: 2026\ndoes: Designs.\n"),
            with("can_delegate: 4\n"),
            "---\nname: Designer\ndoes: : nope\n---\n".into(),
            "---\n- a\n---\n".into(),
            "---\n---\n".into(),
            "Nothing but prose.\n".into(),
            "---\nname: Designer\ndoes: Designs things.\n".into(),
            format!("---\nname: Desi{}gner\ndoes: Designs.\n---\n", '\u{2028}'),
        ];
        // The real five as well, which are the only refusals in this module
        // that were not written to be one.
        let broken: Vec<String> = broken
            .into_iter()
            .chain(REAL.iter().map(|(_, text)| (*text).to_string()))
            .collect();
        for text in &broken {
            let problems = refused("designer", text);
            assert!(!problems.is_empty());
            let lines = text.lines().count().max(1);
            for problem in problems {
                assert_eq!(problem.path, at("designer").display().to_string());
                assert!(
                    problem.line >= 1 && problem.line <= lines,
                    "{problem:#?} is outside a file of {lines} lines"
                );
            }
        }
    }

    /// A frontmatter that is never closed is a file with no frontmatter, which
    /// is the sentence somebody can act on.
    #[test]
    fn an_unclosed_frontmatter_reads_as_none() {
        let problems = refused("designer", "---\nname: Designer\ndoes: Designs things.\n");
        assert_eq!(problems.len(), 1);
        assert!(problems[0].says.contains("no frontmatter"));

        // A fence with a trailing space is not a fence, for the reason
        // `skills::check_one_frontmatter` gives: the rule fails closed.
        let problems = refused("designer", "--- \nname: Designer\n---\n");
        assert!(problems[0].says.contains("no frontmatter"));
    }

    /// **A character some readers end a line on and some call text is
    /// refused**, because the line numbers above would otherwise point at the
    /// wrong line in exactly the file somebody needs them for.
    #[test]
    fn an_invisible_break_is_refused() {
        for c in INVISIBLE_BREAKS.iter() {
            let text = format!("---\nname: Desi{c}gner\ndoes: Designs.\n---\n");
            let problems = refused("designer", &text);
            assert_eq!(problems.len(), 1, "{problems:#?}");
            assert!(
                problems[0].says.contains(&format!("U+{:04X}", *c as u32)),
                "{problems:#?}"
            );
            assert_eq!(problems[0].line, 2);
        }
        assert_eq!(
            INVISIBLE_BREAKS.len(),
            3,
            "libyaml's break set changed; the refusal above is derived from it"
        );
    }

    /// A file written on Windows describes the same profile as one written
    /// anywhere else.
    #[test]
    fn crlf_reads_the_same_as_lf() {
        let lf = serialize(&dense());
        let crlf = lf.replace('\n', "\r\n");
        assert_eq!(
            accepted("engineering-manager", &crlf),
            accepted("engineering-manager", &lf)
        );
    }

    /// The body is the instructions, whatever is in it.
    #[test]
    fn the_body_is_the_instructions() {
        // The first fence after the opening one closes the frontmatter, so a
        // fence inside the body is part of the body.
        let read = accepted(
            "designer",
            "---\nname: Designer\ndoes: Designs.\n---\n\nBefore.\n\n---\n\nAfter.\n",
        );
        assert_eq!(read.instructions, "Before.\n\n---\n\nAfter.");

        // Surrounding blank lines are not content, so the canonical form drops
        // them and the file reads the same however many were there.
        let read = accepted("designer", "---\nname: D\ndoes: d\n---\n\n\n\nBody.\n\n\n");
        assert_eq!(read.instructions, "Body.");

        // No body at all is an empty instruction, not a refusal.
        assert_eq!(
            accepted("designer", "---\nname: D\ndoes: d\n---\n").instructions,
            ""
        );
    }
}
