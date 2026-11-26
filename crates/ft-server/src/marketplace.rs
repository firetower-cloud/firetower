//! Reading a repository of plugins.
//!
//! **The catalogue is synced; an install never is.** Fetching rewrites a list
//! of what is on offer — names, descriptions, logos, addresses. It does not
//! touch a single byte anybody installed. That is the whole of the safety
//! argument: an upstream that is compromised, renamed or deleted can at worst
//! change what a shelf *offers*, and somebody still has to choose it.
//!
//! An install is a copy taken once, pinned to the commit the catalogue was
//! read at. Two people installing the same row on the same day get the same
//! bytes, and a later upstream change is a thing you can see and refuse.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use utoipa::ToSchema;

/// A zip big enough for any real marketplace and small enough to refuse a
/// repository that is not one.
const BIGGEST_ZIP: u64 = 32 * 1024 * 1024;
/// Per file inside it. A plugin is text, a manifest and a logo.
const BIGGEST_FILE: u64 = 4 * 1024 * 1024;
const MOST_FILES: usize = 20_000;
const BIGGEST_LOGO: usize = 96 * 1024;

/// Where an entry's files are.
///
/// **Most entries are not in the repository that lists them.** Anthropic's
/// own marketplace is 317 plugins and only 55 of them live in it — the rest
/// name another repository, with or without a subdirectory. A reader that
/// only understands a local path understands a sixth of the catalogue.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    /// Never constructed from a listing; only what `Entry`'s derive needs,
    /// since a row on the wire carries its address in its own column.
    #[default]
    Unknown,
    /// A directory of the marketplace's own repository.
    Inside { path: String },
    /// Another repository, at a commit when it names one.
    Repo {
        url: String,
        sha: Option<String>,
        path: Option<String>,
    },
}

/// One row of a catalogue.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub slug: String,
    pub name: String,
    /// What a person should read. `name` and `slug` are both constrained to
    /// lowercase and hyphens — they are a folder and a command — so this is
    /// the only place "Cal.com" or "WorkOS" can be spelled.
    pub display_name: Option<String>,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub category: Option<String>,
    pub homepage: Option<String>,
    #[serde(skip)]
    pub source: Source,
    #[serde(skip)]
    pub logo: Option<(Vec<u8>, String)>,
    pub n_skills: i32,
    pub n_commands: i32,
    pub has_connector: bool,
}

/// A catalogue, as it was at one commit.
pub struct Fetched {
    pub name: String,
    pub manifest: &'static str,
    pub commit: String,
    pub entries: Vec<Entry>,
}

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("firetower")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .context("building an http client")
}

/// `owner` and `repo`, out of any of the forms somebody pastes.
pub fn github_of(url: &str) -> Option<(String, String)> {
    let rest = url
        .trim()
        .trim_end_matches('/')
        .strip_prefix("https://")
        .or_else(|| url.trim().trim_end_matches('/').strip_prefix("http://"))
        .or_else(|| url.trim().trim_end_matches('/').strip_prefix("git@"))?;
    let rest = rest.replacen("github.com:", "github.com/", 1);
    let rest = rest.strip_prefix("github.com/")?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    (!owner.is_empty() && !repo.is_empty()).then_some((owner, repo))
}

/// The commit a ref points at.
///
/// **Resolved before downloading, not after.** A branch name downloads
/// whatever is on it at that second, and two people refreshing a minute apart
/// would pin to bytes they cannot name. Asking first costs one request and
/// makes every install reproducible.
async fn resolve_commit(
    http: &reqwest::Client,
    owner: &str,
    repo: &str,
    git_ref: &str,
    token: Option<&str>,
) -> Result<String> {
    let at = format!("https://api.github.com/repos/{owner}/{repo}/commits/{git_ref}");
    let mut req = http.get(&at).header("accept", "application/vnd.github.sha");
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let r = req.send().await.with_context(|| format!("asking {at}"))?;
    if r.status() == reqwest::StatusCode::FORBIDDEN
        || r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        // **A 403 here is almost never permission.** It is GitHub's anonymous
        // limit — sixty an hour, counted per address and so shared by everyone
        // behind one office connection. Saying "no ref `main`" sent somebody
        // to check a branch that was fine.
        bail!(
            "GitHub is rate-limiting this address. Connect a git account, or set \
             MARKETPLACE_TOKEN on the control plane, or try again in a few minutes"
        );
    }
    if !r.status().is_success() {
        bail!(
            "{owner}/{repo} has no ref `{git_ref}` that Firetower can read ({})",
            r.status()
        );
    }
    let sha = r.text().await?.trim().to_string();
    if sha.len() < 7 {
        bail!("{at} answered something that is not a commit");
    }
    Ok(sha)
}

/// Every file of a repository at one commit, keyed by its path inside it.
async fn download(
    http: &reqwest::Client,
    owner: &str,
    repo: &str,
    sha: &str,
    token: Option<&str>,
) -> Result<BTreeMap<String, Vec<u8>>> {
    let at = format!("https://codeload.github.com/{owner}/{repo}/zip/{sha}");
    let mut req = http.get(&at);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let r = req.send().await.with_context(|| format!("fetching {at}"))?;
    if !r.status().is_success() {
        bail!("{at} answered {}", r.status());
    }
    if let Some(len) = r.content_length() {
        if len > BIGGEST_ZIP {
            bail!(
                "that repository is {} MB, which is not a marketplace",
                len / 1_048_576
            );
        }
    }
    let bytes = r.bytes().await?;
    if bytes.len() as u64 > BIGGEST_ZIP {
        bail!("that repository is larger than Firetower will read");
    }

    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .context("that download is not a zip archive")?;
    if zip.len() > MOST_FILES {
        bail!(
            "that repository holds {} files, which is not a marketplace",
            zip.len()
        );
    }

    let mut out = BTreeMap::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i)?;
        if !f.is_file() || f.size() > BIGGEST_FILE {
            continue;
        }
        // GitHub wraps everything in one directory named for the commit.
        let Ok(whole) = f.name().map(|n| n.to_string()) else {
            continue;
        };
        let Some(path) = whole.split_once('/').map(|(_, rest)| rest.to_string()) else {
            continue;
        };
        if path.is_empty() || path.contains("..") {
            continue;
        }
        let mut body = Vec::with_capacity(f.size() as usize);
        std::io::Read::read_to_end(&mut f, &mut body)?;
        out.insert(path, body);
    }
    Ok(out)
}

/// Read a marketplace repository.
pub async fn fetch(url: &str, git_ref: &str, token: Option<&str>) -> Result<Fetched> {
    let (owner, repo) =
        github_of(url).context("that is not a GitHub repository address Firetower can read")?;
    let http = client()?;
    let commit = resolve_commit(&http, &owner, &repo, git_ref, token).await?;
    let files = download(&http, &owner, &repo, &commit, token).await?;

    // Both manifests, because the body is the same either way and refusing a
    // repository over where its index file sits helps nobody.
    let (manifest, raw) = [
        ("claude", ".claude-plugin/marketplace.json"),
        ("firetower", ".agents/plugins/marketplace.json"),
    ]
    .into_iter()
    .find_map(|(kind, at)| files.get(at).map(|b| (kind, b)))
    .context(
        "no marketplace file — a marketplace holds .claude-plugin/marketplace.json \
         or .agents/plugins/marketplace.json at its root",
    )?;

    let doc: Value = serde_json::from_slice(raw).context("that marketplace file is not JSON")?;
    let listed = doc
        .get("plugins")
        .and_then(Value::as_array)
        .context("that marketplace file lists no `plugins`")?;

    let name = doc
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&repo)
        .to_string();

    let mut entries = Vec::new();
    for one in listed {
        if let Some(e) = entry_of(one, &files) {
            entries.push(e);
        }
    }
    if entries.is_empty() {
        bail!("that marketplace lists nothing Firetower can read");
    }

    Ok(Fetched {
        name,
        manifest,
        commit,
        entries,
    })
}

/// One listing, plus whatever the repository itself can tell us about it.
fn entry_of(one: &Value, files: &BTreeMap<String, Vec<u8>>) -> Option<Entry> {
    let slug = one.get("name").and_then(Value::as_str)?.to_string();
    let source = source_of(one.get("source")?)?;

    let mut entry = Entry {
        name: slug.clone(),
        display_name: one
            .get("displayName")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        description: one
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        version: one
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        author: one
            .get("author")
            .map(|a| match a {
                Value::String(s) => s.clone(),
                other => other
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
            .filter(|s| !s.is_empty()),
        category: one
            .get("category")
            .and_then(Value::as_str)
            .map(str::to_owned),
        homepage: one
            .get("homepage")
            .and_then(Value::as_str)
            .map(str::to_owned),
        slug,
        source,
        logo: None,
        n_skills: 0,
        n_commands: 0,
        has_connector: false,
    };

    // **Only a local entry can be described from here.** One that names
    // another repository would cost a download each to count, and a shelf
    // that takes 300 downloads to draw is a shelf nobody waits for. Those
    // rows show what the listing says and fill the rest in at install.
    if let Source::Inside { path } = &entry.source {
        let under = format!("{}/", path.trim_start_matches("./").trim_end_matches('/'));
        describe(&mut entry, files, &under);
    }
    Some(entry)
}

/// Counts, a connector and a logo, read out of the plugin's own folder.
fn describe(entry: &mut Entry, files: &BTreeMap<String, Vec<u8>>, under: &str) {
    for (path, body) in files.range(under.to_string()..) {
        let Some(rest) = path.strip_prefix(under) else {
            break;
        };
        if rest.starts_with("skills/") && rest.ends_with("/SKILL.md") {
            entry.n_skills += 1;
        } else if rest.starts_with("commands/") && rest.ends_with(".md") {
            entry.n_commands += 1;
        } else if rest == ".mcp.json" {
            entry.has_connector = true;
        } else if rest.starts_with("assets/logo.") && body.len() <= BIGGEST_LOGO {
            let kind = match rest.rsplit('.').next().unwrap_or("png") {
                "svg" => "image/svg+xml",
                "ico" => "image/x-icon",
                "jpg" | "jpeg" => "image/jpeg",
                _ => "image/png",
            };
            entry.logo = Some((body.clone(), kind.to_string()));
        } else if rest == ".claude-plugin/plugin.json" || rest == ".codex-plugin/plugin.json" {
            if let Ok(m) = serde_json::from_slice::<Value>(body) {
                if entry.description.is_empty() {
                    if let Some(d) = m.get("description").and_then(Value::as_str) {
                        entry.description = d.to_string();
                    }
                }
                // The manifest wins over the catalogue row: it travels with
                // the folder, so a fork that renames itself stays renamed.
                if let Some(d) = m
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    entry.display_name = Some(d.to_string());
                }
                if entry.version.is_none() {
                    entry.version = m.get("version").and_then(Value::as_str).map(str::to_owned);
                }
            }
        }
    }
}

/// The four shapes a `source` takes in the wild.
fn source_of(v: &Value) -> Option<Source> {
    match v {
        Value::String(path) => Some(Source::Inside { path: path.clone() }),
        Value::Object(o) => {
            let kind = o.get("source").and_then(Value::as_str).unwrap_or("url");
            match kind {
                "url" | "git" | "git-subdir" | "github" => Some(Source::Repo {
                    url: o.get("url").and_then(Value::as_str)?.to_string(),
                    sha: o.get("sha").and_then(Value::as_str).map(str::to_owned),
                    path: o
                        .get("path")
                        .or_else(|| o.get("subdir"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                }),
                // `command` runs something to produce the plugin, which is a
                // thing Firetower will not do on a fetch.
                _ => None,
            }
        }
        _ => None,
    }
}

/// The files of one entry, ready to become a bundle.
pub async fn files_of(
    source: &Source,
    marketplace_url: &str,
    commit: &str,
    token: Option<&str>,
) -> Result<Vec<(String, Vec<u8>)>> {
    let http = client()?;
    let (files, under) = match source {
        Source::Unknown => bail!("that entry names no address"),
        Source::Inside { path } => {
            let (owner, repo) = github_of(marketplace_url).context("bad marketplace address")?;
            let files = download(&http, &owner, &repo, commit, token).await?;
            let under = format!("{}/", path.trim_start_matches("./").trim_end_matches('/'));
            (files, under)
        }
        Source::Repo { url, sha, path } => {
            let (owner, repo) =
                github_of(url).context("that plugin names an address Firetower cannot read")?;
            let at = match sha {
                Some(s) => s.clone(),
                None => resolve_commit(&http, &owner, &repo, "HEAD", token).await?,
            };
            let files = download(&http, &owner, &repo, &at, token).await?;
            let under = path
                .as_deref()
                .map(|p| format!("{}/", p.trim_start_matches("./").trim_end_matches('/')))
                .unwrap_or_default();
            (files, under)
        }
    };

    let mut out = Vec::new();
    for (path, body) in files {
        let Some(rest) = path.strip_prefix(&under) else {
            continue;
        };
        if rest.is_empty() || rest.starts_with(".git/") {
            continue;
        }
        out.push((rest.to_string(), body));
    }
    if out.is_empty() {
        bail!("there is nothing at that address");
    }
    Ok(out)
}

/// The connector a bundle declares, out of its own `.mcp.json`.
///
/// **This is the step that makes an installed plugin work.** Without it a
/// marketplace install lands the skills and silently drops the tools, which
/// looks exactly like a plugin that does nothing.
pub fn connector_of(
    files: &[(String, Vec<u8>)],
) -> Option<(String, String, String, Option<String>)> {
    let raw = files.iter().find(|(p, _)| p == ".mcp.json")?;
    let doc: Value = serde_json::from_slice(&raw.1).ok()?;
    let servers = doc.get("mcpServers")?.as_object()?;
    let (name, server) = servers.iter().next()?;
    let url = server.get("url").and_then(Value::as_str)?.to_string();

    // **A bundle does not get to choose how it is authorized.** There used to
    // be a `firetower` key here saying "reuse the git credential", and a
    // manifest from a repository nobody at this company wrote is the last
    // place that decision belongs. Everything authorizes for itself.
    let auth = "oauth".to_string();
    let borrow: Option<String> = None;
    Some((name.clone(), url, auth, borrow))
}

// ── Storage ─────────────────────────────────────────────────────────────────

use chrono::{DateTime, Utc};
use ft_core::MarketId;
use sqlx::{PgPool, Row};

/// The repository Firetower publishes, added to every organisation.
///
/// **Added by default, and still removable.** A source nobody can take off is
/// a source nobody consented to, and the moment ours is privileged is the
/// moment it stops exercising the same path as everybody else's.
pub const OURS: &str = "https://github.com/firetower-cloud/firetower-marketplace";
pub const OURS_REF: &str = "main";

/// A source, as a screen lists it.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub id: String,
    pub url: String,
    pub name: String,
    pub git_ref: String,
    /// The commit its catalogue was read at. `None` has never been fetched.
    pub commit: Option<String>,
    pub fetched_at: Option<DateTime<Utc>>,
    /// Why the last fetch failed, kept so a stale shelf can say so.
    pub error: Option<String>,
    pub builtin: bool,
    pub entries: i64,
}

/// One row of a shelf.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub marketplace_id: String,
    pub marketplace_name: String,
    pub slug: String,
    pub name: String,
    /// Already resolved: the entry's own, or a title-cased slug. The caller
    /// never has to know which, and never has to draw `hugging-face`.
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub author: Option<String>,
    pub category: Option<String>,
    pub homepage: Option<String>,
    /// Inline, from bytes stored with the catalogue. A shelf draws without
    /// reaching anybody's origin.
    pub logo: Option<String>,
    pub n_skills: i32,
    pub n_commands: i32,
    pub has_connector: bool,
    /// **Whether those counts mean anything.** An entry whose files live in
    /// another repository is not opened at catalogue time — 316 downloads to
    /// draw a shelf is not a shelf. So its counts are all zero, which is not
    /// the same claim as "this plugin is empty", and a row must not make the
    /// second one.
    pub counted: bool,
    /// Whether this organisation already took a copy.
    pub installed: bool,
}

/// Which rows a caller is asking for.
///
/// **Narrowing happens here and not in the client.** It used to happen in the
/// browser over the whole catalogue, which worked only because the whole
/// catalogue was sent; a page plus a filter applied afterwards is a search of
/// page one, which looks like a working search that quietly cannot see most
/// of the shelf.
#[derive(Debug, Clone, Default)]
pub struct Asked<'a> {
    /// The query box, matched against a name or a description.
    pub q: Option<&'a str>,
    /// `mcp` for an entry carrying a server, `skills` for one carrying skills
    /// or commands. Anything else is everything.
    pub kind: Option<&'a str>,
    /// Only what this organisation has, or only what it has not.
    ///
    /// **A page of a filtered list cannot be filtered again afterwards.** The
    /// shelf of what you already have used to be the installed rows picked
    /// out of the whole catalogue in the browser; with a page that reads as
    /// "the installed things that happen to sort into the first thirty".
    pub installed: Option<bool>,
    /// One-based. Zero is read as the first page.
    pub page: u32,
}

/// One page of the catalogue, and enough to know there is another.
#[derive(Debug)]
pub struct Shelf {
    pub entries: Vec<Listed>,
    /// How many match, across every page.
    pub total: i64,
    /// Whether asking for the next one is worth it.
    pub more: bool,
}

/// How many rows a page holds.
pub const PER_PAGE: u32 = 30;

/// A readable name for something that did not supply one.
///
/// Right for most of them — `neon` is Neon, `hugging-face` is Hugging Face —
/// and wrong in exactly the cases a rule cannot win: `cal-com` is Cal.com and
/// `workos` is WorkOS. Those carry their own, which is why the column exists;
/// this is so a catalogue nobody here wrote still reads like words.
pub fn title_of(slug: &str) -> String {
    slug.split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Add a source, or return the one already there.
pub async fn add(
    pool: &PgPool,
    org: &str,
    person: Option<&str>,
    url: &str,
    git_ref: &str,
    builtin: bool,
) -> Result<String> {
    let url = url.trim().trim_end_matches('/').to_string();
    github_of(&url).context("that is not a GitHub repository address")?;
    let id = MarketId::new();
    let name = github_of(&url)
        .map(|(_, r)| r)
        .unwrap_or_else(|| url.clone());

    let got: String = sqlx::query_scalar(
        "INSERT INTO marketplaces (id, org_id, url, name, git_ref, builtin, added_by) \
         VALUES ($1,$2,$3,$4,$5,$6,$7) \
         ON CONFLICT (org_id, url) DO UPDATE SET git_ref = excluded.git_ref \
         RETURNING id",
    )
    .bind(id.as_str())
    .bind(org)
    .bind(&url)
    .bind(&name)
    .bind(git_ref)
    .bind(builtin)
    .bind(person)
    .fetch_one(pool)
    .await
    .context("adding a marketplace")?;
    Ok(got)
}

/// Ours, in every organisation that does not have it yet.
pub async fn ensure_default(pool: &PgPool) -> Result<usize> {
    let orgs: Vec<String> = sqlx::query_scalar("SELECT id FROM organizations")
        .fetch_all(pool)
        .await
        .context("listing organisations")?;
    let mut made = 0;
    for org in orgs {
        let already: Option<String> =
            sqlx::query_scalar("SELECT id FROM marketplaces WHERE org_id = $1 AND url = $2")
                .bind(&org)
                .bind(OURS)
                .fetch_optional(pool)
                .await?;
        if already.is_none() {
            add(pool, &org, None, OURS, OURS_REF, true).await?;
            made += 1;
        }
    }
    Ok(made)
}

/// Replace a catalogue with what was just read.
///
/// **One transaction, and installs are not in it.** The entries table is
/// rewritten wholesale — an upstream that dropped a plugin drops a row here
/// and nothing else. Whatever anybody installed keeps its own copy.
pub async fn save(pool: &PgPool, id: &str, got: &Fetched) -> Result<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM marketplace_entries WHERE marketplace_id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for e in &got.entries {
        let (logo, logo_type) = match &e.logo {
            Some((b, k)) => (Some(b.clone()), Some(k.clone())),
            None => (None, None),
        };
        sqlx::query(
            "INSERT INTO marketplace_entries \
               (marketplace_id, slug, name, display_name, description, version, author, \
                category, homepage, source, logo, logo_type, n_skills, n_commands, \
                has_connector) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        )
        .bind(id)
        .bind(&e.slug)
        .bind(&e.name)
        .bind(&e.display_name)
        .bind(&e.description)
        .bind(&e.version)
        .bind(&e.author)
        .bind(&e.category)
        .bind(&e.homepage)
        .bind(serde_json::to_value(&e.source)?)
        .bind(logo)
        .bind(logo_type)
        .bind(e.n_skills)
        .bind(e.n_commands)
        .bind(e.has_connector)
        .execute(&mut *tx)
        .await?;
    }
    // **What was installed before the catalogue carried a name gets one.**
    // A copy taken last week has `display_name` null and falls back to a
    // title-cased slug, so GitHub reads as "Github" for ever unless somebody
    // reinstalls it. A refresh already knows the right answer; only nulls are
    // touched, so a name somebody edited is never overwritten.
    sqlx::query(
        "UPDATE skills k SET display_name = e.display_name \
           FROM marketplace_entries e, skill_versions v \
          WHERE v.skill_id = k.id AND v.from_marketplace = e.marketplace_id \
            AND v.from_slug = e.slug AND e.marketplace_id = $1 \
            AND e.display_name IS NOT NULL AND k.display_name IS NULL",
    )
    .bind(id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE marketplaces SET name = $2, manifest = $3, commit = $4, \
           fetched_at = now(), error = NULL WHERE id = $1",
    )
    .bind(id)
    .bind(&got.name)
    .bind(got.manifest)
    .bind(&got.commit)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Record why a fetch failed, without losing the catalogue it replaced.
pub async fn failed(pool: &PgPool, id: &str, why: &str) -> Result<()> {
    sqlx::query("UPDATE marketplaces SET error = $2, fetched_at = now() WHERE id = $1")
        .bind(id)
        .bind(why)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list(pool: &PgPool, org: &str) -> Result<Vec<Market>> {
    let rows = sqlx::query(
        "SELECT m.id, m.url, m.name, m.git_ref, m.commit, m.fetched_at, m.error, m.builtin, \
           (SELECT count(*) FROM marketplace_entries e WHERE e.marketplace_id = m.id) AS entries \
         FROM marketplaces m WHERE m.org_id = $1 ORDER BY m.builtin DESC, m.created_at",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .context("listing marketplaces")?;
    Ok(rows
        .into_iter()
        .map(|r| Market {
            id: r.get("id"),
            url: r.get("url"),
            name: r.get("name"),
            git_ref: r.get("git_ref"),
            commit: r.get("commit"),
            fetched_at: r.get("fetched_at"),
            error: r.get("error"),
            builtin: r.get("builtin"),
            entries: r.get("entries"),
        })
        .collect())
}

pub async fn one(
    pool: &PgPool,
    org: &str,
    id: &str,
) -> Result<Option<(String, String, Option<String>)>> {
    let row =
        sqlx::query("SELECT url, git_ref, commit FROM marketplaces WHERE id = $1 AND org_id = $2")
            .bind(id)
            .bind(org)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|r| (r.get("url"), r.get("git_ref"), r.get("commit"))))
}

pub async fn remove(pool: &PgPool, org: &str, id: &str) -> Result<bool> {
    let done = sqlx::query("DELETE FROM marketplaces WHERE id = $1 AND org_id = $2")
        .bind(id)
        .bind(org)
        .execute(pool)
        .await?;
    Ok(done.rows_affected() > 0)
}

/// One page of the entries this organisation can see, built-in source first.
///
/// The count travels with the rows, from the same statement, so the two cannot
/// disagree about a catalogue that changed between two queries.
pub async fn entries(pool: &PgPool, org: &str, ask: &Asked<'_>) -> Result<Shelf> {
    let term = ask
        .q
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| format!("%{}%", t.to_lowercase()));
    let kind = match ask.kind {
        Some("mcp") => Some("mcp"),
        Some("skills") => Some("skills"),
        _ => None,
    };
    let page = ask.page.max(1);
    let offset = i64::from(page - 1) * i64::from(PER_PAGE);
    let installed = ask.installed;
    let rows = sqlx::query(
        "SELECT e.marketplace_id, m.name AS marketplace_name, e.slug, e.name, \
           e.display_name, e.description, \
           e.version, e.author, e.category, e.homepage, e.logo, e.logo_type, \
           e.n_skills, e.n_commands, e.has_connector, \
           e.source->>'kind' = 'inside' AS counted, \
           EXISTS (SELECT 1 FROM skill_versions v JOIN skills k ON k.id = v.skill_id \
                   WHERE v.from_marketplace = e.marketplace_id AND v.from_slug = e.slug \
                     AND k.org_id = $1) AS installed, \
           count(*) OVER () AS matching \
         FROM marketplace_entries e JOIN marketplaces m ON m.id = e.marketplace_id \
         WHERE m.org_id = $1 \
           AND ($2::text IS NULL OR lower(e.name) LIKE $2 OR lower(e.description) LIKE $2) \
           AND ($3::text IS NULL \
                OR ($3 = 'mcp' AND e.has_connector) \
                OR ($3 = 'skills' AND (e.n_skills > 0 OR e.n_commands > 0))) \
           AND ($4::bool IS NULL OR $4 = EXISTS ( \
                SELECT 1 FROM skill_versions v JOIN skills k ON k.id = v.skill_id \
                 WHERE v.from_marketplace = e.marketplace_id AND v.from_slug = e.slug \
                   AND k.org_id = $1)) \
         ORDER BY m.builtin DESC, e.name \
         LIMIT $5 OFFSET $6",
    )
    .bind(org)
    .bind(term.as_deref())
    .bind(kind)
    .bind(installed)
    .bind(i64::from(PER_PAGE))
    .bind(offset)
    .fetch_all(pool)
    .await
    .context("listing marketplace entries")?;

    // `count(*) OVER ()` is the number of rows the filter matched before the
    // window was taken, so it comes back on every row — and on none at all
    // when the page is past the end, which is the only case worth spelling.
    let total: i64 = rows
        .first()
        .map(|r| r.get::<i64, _>("matching"))
        .unwrap_or(0);

    let entries = rows
        .into_iter()
        .map(|r| {
            let bytes: Option<Vec<u8>> = r.get("logo");
            let kind: Option<String> = r.get("logo_type");
            Listed {
                marketplace_id: r.get("marketplace_id"),
                marketplace_name: r.get("marketplace_name"),
                slug: r.get("slug"),
                display_name: r
                    .get::<Option<String>, _>("display_name")
                    .filter(|d| !d.trim().is_empty())
                    .unwrap_or_else(|| title_of(r.get::<&str, _>("name"))),
                name: r.get("name"),
                description: r.get("description"),
                version: r.get("version"),
                author: r.get("author"),
                category: r.get("category"),
                homepage: r.get("homepage"),
                logo: bytes.map(|b| {
                    format!(
                        "data:{};base64,{}",
                        kind.unwrap_or_else(|| "image/png".into()),
                        ft_proto::encode(&b)
                    )
                }),
                n_skills: r.get("n_skills"),
                n_commands: r.get("n_commands"),
                has_connector: r.get("has_connector"),
                counted: r.get("counted"),
                installed: r.get("installed"),
            }
        })
        .collect::<Vec<_>>();

    Ok(Shelf {
        more: offset + (entries.len() as i64) < total,
        total,
        entries,
    })
}

/// One entry's address, for an install.
pub async fn address_of(
    pool: &PgPool,
    org: &str,
    market: &str,
    slug: &str,
) -> Result<Option<(Source, String, String, String, String, String)>> {
    let row = sqlx::query(
        "SELECT e.source, e.name, e.display_name, e.description, m.url, m.commit, m.git_ref \
         FROM marketplace_entries e JOIN marketplaces m ON m.id = e.marketplace_id \
         WHERE e.marketplace_id = $1 AND e.slug = $2 AND m.org_id = $3",
    )
    .bind(market)
    .bind(slug)
    .bind(org)
    .fetch_optional(pool)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let source: Source = serde_json::from_value(r.get("source"))?;
    let commit: Option<String> = r.get("commit");
    let git_ref: String = r.get("git_ref");
    Ok(Some((
        source,
        r.get("url"),
        commit.unwrap_or(git_ref),
        r.get("name"),
        r.get::<Option<String>, _>("display_name")
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| title_of(r.get::<&str, _>("name"))),
        r.get("description"),
    )))
}

/// Remember where an installed version came from, so a row can say there is
/// a newer one and an update can be refused.
pub async fn pin(
    pool: &PgPool,
    version_id: &str,
    market: &str,
    slug: &str,
    commit: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE skill_versions SET from_marketplace = $2, from_slug = $3, from_commit = $4 \
         WHERE id = $1",
    )
    .bind(version_id)
    .bind(market)
    .bind(slug)
    .bind(commit)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fallback is for catalogues that supply nothing, so it has to be
    /// right for the ordinary name and merely *not worse than the slug* for
    /// the rest.
    #[test]
    fn a_slug_becomes_words_when_nobody_supplied_a_name() {
        assert_eq!(title_of("neon"), "Neon");
        assert_eq!(title_of("hugging-face"), "Hugging Face");
        assert_eq!(title_of("customer-io"), "Customer Io");
        assert_eq!(title_of("open_a_pr"), "Open A Pr");
        // Still wrong, and still better than `cal-com` on a row — which is
        // the whole reason an entry may carry its own.
        assert_eq!(title_of("cal-com"), "Cal Com");
        // Degenerate input must not panic or produce a leading space.
        assert_eq!(title_of(""), "");
        assert_eq!(title_of("--a--"), "A");
    }
}
