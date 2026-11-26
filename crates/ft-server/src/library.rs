//! The library, as the things inside it.
//!
//! **It stopped listing bundles.** A bundle is a folder somebody imported, and
//! folders are not what anybody came for: they came to connect Notion, or to
//! add a skill. So this flattens every bundle a person can reach into the
//! components it carries — one row per skill, one row per server — and the
//! folder survives only as the line saying where a row came from.
//!
//! The change is not cosmetic. A server that publishes its own skills has no
//! folder to belong to, and a library built on folders has nowhere to put
//! those rows at all.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};
use utoipa::ToSchema;

/// One thing in the library.
#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// `<skill id>:<path>`. Opaque, and the handle every write takes.
    pub id: String,
    /// The bundle it lives in, which the detail screen and removal both need.
    pub skill_id: String,
    /// `skill` or `server`.
    pub kind: String,
    /// The machine's: a folder, a command, the thing an agent types.
    pub name: String,
    /// The person's. Already resolved — the bundle's own, or a title-cased
    /// `name`. A screen draws this and never has to pick.
    pub display_name: String,
    pub description: String,
    /// The bundle's name, when the bundle holds more than this one thing.
    /// `None` when the component *is* the bundle, because "from notion" under
    /// a row called notion is noise.
    pub from: Option<String>,
    /// Whether a plain agent of yours opens with it.
    pub on: bool,
    /// The bundle's own mark, shared by everything inside it.
    pub logo: Option<String>,
    /// Firetower's own, which nobody can remove because the next boot puts it back.
    pub builtin: bool,
    /// **Not a choice.** A Firetower feature depends on it, so it has no
    /// switch and no profile can leave it out. See `builtin::REQUIRED`.
    pub required: bool,
    /// What stops working without it, said where somebody is looking at it.
    pub why_required: Option<String>,
    /// The vendor's own instructions for creating an OAuth application, where
    /// they have written any. A console is a form; this is the page that says
    /// which boxes to tick.
    pub guide: Option<String>,

    // Servers only.
    pub url: Option<String>,
    pub auth: Option<String>,
    pub server: Option<String>,
    /// Whether **you** hold a credential for it. `None` for a skill.
    pub connected: Option<bool>,
    /// **This server registers no clients**, so Connect cannot work until
    /// somebody creates an application by hand and pastes its id — which
    /// Firetower has nowhere to put yet. GitHub, Slack and Google are all
    /// here. Drawing a button that fails on the press is worse than saying so.
    pub needs_client_id: bool,
    /// Where somebody goes to create that application, when we know. Each
    /// vendor's console is in a different place and none of them is
    /// guessable from the server's address.
    pub console: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySwitch {
    /// **In the body, not the path.** A component's handle is
    /// `<skill id>:skills/<name>/SKILL.md` — it carries slashes, and a path
    /// parameter holding one is a different route. The switch silently did
    /// nothing until this moved.
    pub id: String,
    pub on: bool,
}

/// The path that *is* a server, inside a bundle.
pub const SERVER_PATH: &str = ".mcp.json";

fn said(front: &serde_json::Value, key: &str) -> String {
    front
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

/// Everything this person can reach, as components.
pub async fn items(pool: &PgPool, person: &str, person_slug: &str) -> Result<Vec<Item>> {
    // Bundles first, with the facts that belong to the bundle rather than to
    // anything inside it.
    let bundles = sqlx::query(&format!(
        "SELECT k.id, k.name, k.display_name, k.description, k.kind, \
           k.current_version_id AS vid, \
                (k.path <@ 'd.firetower'::ltree) AS builtin, \
                EXISTS (SELECT 1 FROM skill_defaults d \
                         WHERE d.skill_id = k.id AND d.user_id = $1 AND d.repo_id IS NULL) AS on, \
                (SELECT b.bytes FROM skill_files f JOIN blobs b ON b.hash = f.hash \
                  WHERE f.version_id = k.current_version_id AND f.path LIKE 'assets/logo.%' \
                  LIMIT 1) AS logo, \
                (SELECT f.path FROM skill_files f \
                  WHERE f.version_id = k.current_version_id AND f.path LIKE 'assets/logo.%' \
                  LIMIT 1) AS logo_path, \
                c.server, c.url, c.auth \
           FROM skills k \
           LEFT JOIN connectors c ON c.skill_id = k.id \
          WHERE k.current_version_id IS NOT NULL AND ({visible}) \
          ORDER BY k.name",
        visible = crate::access::filed_where("k", 2, crate::access::Level::Viewer),
    ))
    .bind(person)
    .bind(person)
    .fetch_all(pool)
    .await
    .context("reading the library")?;

    let off: Vec<(String, String)> =
        sqlx::query("SELECT skill_id, path FROM component_off WHERE person_id = $1")
            .bind(person)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| (r.get("skill_id"), r.get("path")))
            .collect();
    let muted = |id: &str, path: &str| off.iter().any(|(s, p)| s == id && p == path);

    // The connectors this person already holds a credential for. One query
    // rather than one per row: a library of forty servers was forty round
    // trips to answer a question the vault can answer once.
    let held: Vec<String> = sqlx::query("SELECT name FROM secrets WHERE scope = $1 AND owner = $2")
        .bind(crate::vault::CONNECTOR)
        .bind(person)
        .fetch_all(pool)
        .await
        .map(|rows| rows.into_iter().map(|r| r.get("name")).collect())
        .unwrap_or_default();

    // Which bundle's id a credential for each connector is stored under. Two
    // bundles naming one address share it, so the second one must not read as
    // unconnected the moment the first is authorized.
    let shared: Vec<(String, String)> = sqlx::query(
        "SELECT c.skill_id, (SELECT min(o.skill_id) FROM connectors o WHERE o.url = c.url) AS key \
           FROM connectors c",
    )
    .fetch_all(pool)
    .await
    .map(|rows| {
        rows.into_iter()
            .map(|r| (r.get("skill_id"), r.get("key")))
            .collect()
    })
    .unwrap_or_default();
    // Servers that were asked and said they register no clients.
    let by_hand: Vec<String> = sqlx::query_scalar(
        "SELECT skill_id FROM connector_clients \
          WHERE client_id IS NULL AND register_url IS NULL",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let key_of = |id: &str| -> String {
        shared
            .iter()
            .find(|(s, _)| s == id)
            .map(|(_, k)| k.clone())
            .unwrap_or_else(|| id.to_string())
    };

    let _ = person_slug;
    let mut out = Vec::new();
    for b in bundles {
        let id: String = b.get("id");
        let bundle_name: String = b.get("name");
        // Resolved once, here, so no screen has to decide between a column
        // that may be null and a slug it would have to title-case itself.
        let bundle_title: String = b
            .try_get::<Option<String>, _>("display_name")
            .ok()
            .flatten()
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| crate::marketplace::title_of(&bundle_name));
        let bundle_on: bool = b.try_get("on").unwrap_or(false);
        let vid: Option<String> = b.get("vid");
        let logo = b
            .try_get::<Option<Vec<u8>>, _>("logo")
            .ok()
            .flatten()
            .map(|bytes| {
                let path: String = b.try_get("logo_path").unwrap_or_default();
                let kind = match path.rsplit('.').next().unwrap_or("png") {
                    "svg" => "image/svg+xml",
                    "ico" => "image/x-icon",
                    "jpg" | "jpeg" => "image/jpeg",
                    _ => "image/png",
                };
                format!("data:{kind};base64,{}", ft_proto::encode(&bytes))
            });
        let builtin: bool = b.try_get("builtin").unwrap_or(false);
        let required = builtin && crate::skills::builtin::required(&bundle_name);
        let why_required = required
            .then(|| crate::skills::builtin::why_required(&bundle_name))
            .flatten()
            .map(str::to_owned);

        // What this bundle carries, read out of its own files.
        let files: Vec<(String, Vec<u8>)> = match &vid {
            Some(v) => sqlx::query(
                "SELECT f.path, b.bytes FROM skill_files f JOIN blobs b ON b.hash = f.hash \
                  WHERE f.version_id = $1 ORDER BY f.path",
            )
            .bind(v)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| (r.get("path"), r.get("bytes")))
            .collect(),
            None => Vec::new(),
        };

        let mut carried: Vec<Item> = Vec::new();

        // The server, if it declares one.
        if let Some(server) = b.try_get::<Option<String>, _>("server").ok().flatten() {
            carried.push(Item {
                id: format!("{id}:{SERVER_PATH}"),
                skill_id: id.clone(),
                kind: "server".into(),
                name: bundle_name.clone(),
                display_name: bundle_title.clone(),
                description: b.get("description"),
                from: None,
                on: bundle_on && !muted(&id, SERVER_PATH),
                logo: logo.clone(),
                builtin,
                required,
                why_required: why_required.clone(),
                url: b.try_get("url").ok().flatten(),
                auth: b.try_get("auth").ok().flatten(),
                // A server that asks for nothing has nothing to connect;
                // everything else authorizes for itself, per person.
                connected: match b
                    .try_get::<Option<String>, _>("auth")
                    .ok()
                    .flatten()
                    .as_deref()
                {
                    Some("none") => None,
                    _ => {
                        let k = key_of(&id);
                        Some(held.iter().any(|n| n == &k))
                    }
                },
                server: Some(server),
                needs_client_id: by_hand.iter().any(|s| s == &id),
                console: b
                    .try_get::<Option<String>, _>("url")
                    .ok()
                    .flatten()
                    .as_deref()
                    .and_then(|u| reqwest::Url::parse(u).ok())
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .and_then(|h| crate::api::console_for(&h))
                    .map(str::to_owned),
                guide: b
                    .try_get::<Option<String>, _>("url")
                    .ok()
                    .flatten()
                    .as_deref()
                    .and_then(|u| reqwest::Url::parse(u).ok())
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .and_then(|h| crate::api::guide_for(&h))
                    .map(str::to_owned),
            });
        }

        // Every skill inside it.
        for (path, bytes) in &files {
            let is_skill =
                path == "SKILL.md" || (path.starts_with("skills/") && path.ends_with("/SKILL.md"));
            if !is_skill {
                continue;
            }
            let text = String::from_utf8_lossy(bytes);
            let (front, _, _) = crate::skills::read_frontmatter(&text);
            let name = {
                let said = said(&front, "name");
                if !said.is_empty() {
                    said
                } else if path == "SKILL.md" {
                    bundle_name.clone()
                } else {
                    path.trim_start_matches("skills/")
                        .trim_end_matches("/SKILL.md")
                        .to_string()
                }
            };
            carried.push(Item {
                id: format!("{id}:{path}"),
                skill_id: id.clone(),
                kind: "skill".into(),
                guide: None,
                display_name: crate::marketplace::title_of(&name),
                name,
                description: said(&front, "description"),
                from: None,
                on: required || (bundle_on && !muted(&id, path)),
                logo: logo.clone(),
                builtin,
                required,
                why_required: why_required.clone(),
                url: None,
                auth: None,
                server: None,
                connected: None,
                needs_client_id: false,
                console: None,
            });
        }

        // **"from github" only when the names differ.** A row called `github`
        // saying it came from `github` is noise, even though the bundle holds
        // a second thing — what the line is for is telling you where
        // `open-a-pr` came from.
        for mut item in carried {
            if item.name != bundle_name {
                item.from = Some(bundle_name.clone());
            }
            out.push(item);
        }
    }

    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Turn one component on or off for this person.
pub async fn switch(pool: &PgPool, person: &str, item: &str, on: bool) -> Result<()> {
    let (skill_id, path) = item.split_once(':').context("that is not a library item")?;

    // Refused rather than drawn and ignored. The screen does not offer a
    // switch for these; an API call that tries anyway gets the reason.
    if !on {
        let name: Option<String> = sqlx::query_scalar(
            "SELECT name FROM skills WHERE id = $1 AND path <@ 'd.firetower'::ltree",
        )
        .bind(skill_id)
        .fetch_optional(pool)
        .await?;
        if let Some(n) = name.filter(|n| crate::skills::builtin::required(n)) {
            let why = crate::skills::builtin::why_required(&n).unwrap_or_default();
            anyhow::bail!("`{n}` cannot be turned off. {why}");
        }
    }

    let mut tx = pool.begin().await?;
    if on {
        sqlx::query(
            "DELETE FROM component_off WHERE skill_id = $1 AND person_id = $2 AND path = $3",
        )
        .bind(skill_id)
        .bind(person)
        .bind(path)
        .execute(&mut *tx)
        .await?;
        // Switching a component on has to switch its bundle on, or nothing
        // reaches a session: the bundle is still what a pin is taken over.
        sqlx::query(
            "INSERT INTO skill_defaults (skill_id, user_id, repo_id) VALUES ($1,$2,NULL) \
             ON CONFLICT DO NOTHING",
        )
        .bind(skill_id)
        .bind(person)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO component_off (skill_id, person_id, path) VALUES ($1,$2,$3) \
             ON CONFLICT DO NOTHING",
        )
        .bind(skill_id)
        .bind(person)
        .bind(path)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The components of one bundle that this person has switched off.
pub async fn muted_paths(pool: &PgPool, person: &str, skill_id: &str) -> Result<Vec<String>> {
    Ok(
        sqlx::query("SELECT path FROM component_off WHERE person_id = $1 AND skill_id = $2")
            .bind(person)
            .bind(skill_id)
            .fetch_all(pool)
            .await?
            .into_iter()
            .map(|r| r.get("path"))
            .collect(),
    )
}
