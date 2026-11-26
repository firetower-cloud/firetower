//! Every entry in the marketplace, delivered to both engines and checked
//! against each engine's own answer.
//!
//! `tests/plugins.rs` asserts the four layouts with one synthetic plugin. This
//! asserts the catalogue people actually install: each `mcp/<slug>/` folder in
//! the marketplace repository, written out by the real code path and then read
//! back by the real CLIs. A catalogue entry can be wrong in ways a synthetic
//! one never is — a manifest naming a different slug than its folder, a server
//! key with a character TOML gives meaning to, a `.mcp.json` declaring two
//! servers when the row promises one.
//!
//! **Ignored by default, because it needs two binaries and a checkout.** The
//! marketplace is a separate repository and `claude` and `codex` are not build
//! dependencies, so this does not run in a plain `cargo test`. Run it with:
//!
//! ```text
//! cargo test -p ft-worker --test catalogue -- --ignored --nocapture
//! FT_MARKETPLACE=/path/to/firetower-marketplace cargo test … -- --ignored
//! ```
//!
//! **What it can and cannot prove without a credential.** Nothing here has a
//! token, so no server reaches `connected` — the three things that *are*
//! checkable are kept apart on purpose:
//!
//! - the folder is laid out so each engine finds it (asserted here);
//! - the credential we inject arrives in the shape the engine reads as
//!   authentication (asserted here — Codex says `auth_status`);
//! - the address answers and publishes discoverable OAuth (not asserted here;
//!   that is the live probe, and it is a property of the server, not of us).
//!
//! A server reported as `failed` by Claude Code with a deliberately invalid
//! token is the expected result and not a failure of delivery.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use ft_core::{Agent, SessionId};
use ft_proto::{encode, BundleKind, SkillBundle, SkillFile};
use serde_json::Value;

/// A token that is certainly not valid, so that a server which accepts it is
/// the interesting result rather than this test passing by luck.
const FAKE: &str = "Bearer firetower-catalogue-check-not-a-real-token";

fn marketplace() -> PathBuf {
    if let Ok(at) = std::env::var("FT_MARKETPLACE") {
        return PathBuf::from(at);
    }
    // crates/ft-worker -> the repository -> its sibling checkout.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../firetower-marketplace")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("../../../firetower-marketplace"))
}

/// One catalogue entry, read off the disk the way the control plane reads it.
struct Entry {
    slug: String,
    bundle: SkillBundle,
    /// The server name inside its `.mcp.json`, which is what both engines key
    /// on and is not required to equal the slug.
    server: String,
    url: String,
}

fn read_dir_into(at: &Path, under: &str, out: &mut Vec<SkillFile>) {
    let Ok(entries) = std::fs::read_dir(at) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = if under.is_empty() {
            name.clone()
        } else {
            format!("{under}/{name}")
        };
        if e.path().is_dir() {
            read_dir_into(&e.path(), &rel, out);
        } else if let Ok(body) = std::fs::read(e.path()) {
            out.push(SkillFile {
                path: rel,
                contents: encode(&body),
                executable: false,
            });
        }
    }
}

/// Read the catalogue, and check each entry against its own manifests on the
/// way past — the cheap assertions that need no engine at all.
fn entries() -> Vec<Entry> {
    let repo = marketplace();
    let mcp = repo.join("mcp");
    assert!(
        mcp.is_dir(),
        "no catalogue at {} — set FT_MARKETPLACE to the checkout",
        mcp.display()
    );

    let catalogue: Value = serde_json::from_slice(
        &std::fs::read(repo.join(".claude-plugin/marketplace.json"))
            .expect("the repository has a marketplace.json"),
    )
    .expect("and it is JSON");
    let listed: BTreeMap<String, Value> = catalogue["plugins"]
        .as_array()
        .expect("marketplace.json lists plugins")
        .iter()
        .map(|p| {
            (
                p["name"].as_str().unwrap_or_default().to_string(),
                p.clone(),
            )
        })
        .collect();

    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&mcp)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();

    let mut out = Vec::new();
    for dir in dirs {
        let slug = dir.file_name().unwrap().to_string_lossy().into_owned();

        // Both manifests, byte for byte. An engine that reads one and not the
        // other has to see the same plugin, and the only way to be sure of
        // that is to compare the bytes rather than the parse.
        let claude = std::fs::read(dir.join(".claude-plugin/plugin.json"))
            .unwrap_or_else(|_| panic!("{slug} has no .claude-plugin/plugin.json"));
        let codex = std::fs::read(dir.join(".codex-plugin/plugin.json"))
            .unwrap_or_else(|_| panic!("{slug} has no .codex-plugin/plugin.json"));
        assert_eq!(
            claude, codex,
            "{slug}: the two manifests differ, so the engines would not agree"
        );

        let m: Value = serde_json::from_slice(&claude).expect("the manifest is JSON");
        assert_eq!(
            m["name"].as_str(),
            Some(slug.as_str()),
            "{slug}: the manifest names something else, and the folder name is what installs"
        );
        let described = m["description"].as_str().unwrap_or_default();
        assert!(
            !described.trim().is_empty(),
            "{slug}: a row with no description is a row nobody can choose"
        );
        assert!(
            m["homepage"]
                .as_str()
                .unwrap_or_default()
                .starts_with("https://"),
            "{slug}: the detail screen links the homepage, so it has to be one"
        );

        // **A name for people, which the slug cannot be.** A folder is
        // lowercase and hyphens, so an entry without this is drawn as
        // `cal-com` or `hugging-face`. Title-casing the slug is the fallback
        // for catalogues nobody here wrote; ours says what it is called.
        let shown = m["displayName"].as_str().unwrap_or_default().trim();
        assert!(
            !shown.is_empty(),
            "{slug}: no displayName, so the library would draw the folder name"
        );
        // Not asserted to be the slug under another spelling: `monday` is
        // monday.com and `fal` is fal, so any rule tight enough to catch a
        // wrong name also rejects right ones. What is worth catching is the
        // copy-paste — a folder name left in the field meant to replace it.
        assert!(
            shown != slug || !slug.contains('-'),
            "{slug}: displayName is the folder name, which is the thing it is for"
        );

        // The catalogue and the folders cannot disagree: the row is what
        // somebody reads before installing, the folder is what they get.
        let row = listed
            .get(&slug)
            .unwrap_or_else(|| panic!("{slug} is on disk but not in marketplace.json"));
        assert_eq!(
            row["description"].as_str(),
            Some(described),
            "{slug}: the row promises a different description than the manifest"
        );
        assert_eq!(
            row["source"].as_str(),
            Some(format!("./mcp/{slug}").as_str()),
            "{slug}: the row points somewhere else"
        );

        // A logo, which the library row has a hole in without.
        let logo = std::fs::read_dir(dir.join("assets"))
            .ok()
            .and_then(|mut d| {
                d.find(|e| {
                    e.as_ref()
                        .map(|e| e.file_name().to_string_lossy().starts_with("logo."))
                        .unwrap_or(false)
                })
            })
            .and_then(Result::ok)
            .unwrap_or_else(|| panic!("{slug} has no assets/logo.*"));
        let bytes = std::fs::read(logo.path()).unwrap();
        assert!(
            bytes.len() > 250 && bytes.len() <= 96 * 1024,
            "{slug}: a logo of {} bytes is either a placeholder or too big for the reader",
            bytes.len()
        );

        // One server, named, with an https address. More than one in a row
        // that the library lists as one server is the row lying.
        let doc: Value = serde_json::from_slice(&std::fs::read(dir.join(".mcp.json")).unwrap())
            .unwrap_or_else(|_| panic!("{slug}: .mcp.json is not JSON"));
        let servers = doc["mcpServers"]
            .as_object()
            .unwrap_or_else(|| panic!("{slug}: .mcp.json declares no mcpServers"));
        assert_eq!(
            servers.len(),
            1,
            "{slug}: the library lists one server per entry, and this declares {}",
            servers.len()
        );
        let (server, spec) = servers.iter().next().unwrap();

        // **The entry carries its own links, so they have to be links.**
        // These replaced a hardcoded table of hostnames in the control plane;
        // the point of moving them is that a catalogue can say where its own
        // console is, and the cost is that a typo here is a dead button on
        // the one screen somebody reaches when they are already stuck.
        for key in ["console", "guide"] {
            if let Some(at) = spec.get(key) {
                let at = at.as_str().unwrap_or_default();
                assert!(
                    at.starts_with("https://"),
                    "{slug}: {key} is {at:?}, which is not a link"
                );
            }
        }
        // Scopes narrow; they are a list, never a bare string that would
        // silently become one enormous scope.
        if let Some(sc) = spec.get("scopes") {
            let sc = sc
                .as_array()
                .unwrap_or_else(|| panic!("{slug}: scopes must be a list, not {sc}"));
            assert!(
                !sc.is_empty(),
                "{slug}: an empty scope list asks for nothing"
            );
            for one in sc {
                assert!(
                    one.as_str().unwrap_or_default().starts_with("https://")
                        || !one.as_str().unwrap_or_default().is_empty(),
                    "{slug}: a blank scope"
                );
            }
        }
        let url = spec["url"].as_str().unwrap_or_default().to_string();
        assert!(
            url.starts_with("https://"),
            "{slug}: {url} is not an https address"
        );
        assert_eq!(
            spec["type"].as_str(),
            Some("http"),
            "{slug}: every entry here is a streamable HTTP server"
        );

        // What the control plane would send: the same folder, with the
        // credential already substituted into `.mcp.json`.
        let mut files = Vec::new();
        read_dir_into(&dir, "", &mut files);
        files.retain(|f| f.path != ".mcp.json");
        let with_token = serde_json::json!({
            "mcpServers": { server.clone(): {
                "type": "http", "url": url.clone(),
                "headers": { "Authorization": FAKE },
            }}
        });
        files.push(SkillFile {
            path: ".mcp.json".into(),
            contents: encode(
                serde_json::to_string_pretty(&with_token)
                    .unwrap()
                    .as_bytes(),
            ),
            executable: false,
        });

        out.push(Entry {
            slug: slug.clone(),
            bundle: SkillBundle {
                name: slug,
                files,
                kind: BundleKind::Plugin,
            },
            server: server.clone(),
            url,
        });
    }

    assert!(!out.is_empty(), "the catalogue is empty");
    // And nothing listed is missing from disk, which would be a row that
    // cannot be installed.
    for name in listed.keys() {
        assert!(
            out.iter().any(|e| &e.slug == name),
            "{name} is in marketplace.json with no folder behind it"
        );
    }
    out
}

fn have(binary: &str) -> bool {
    std::process::Command::new(binary)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Every entry's manifests, catalogue row, logo and server declaration.
///
/// Needs no engine, so it is the one that runs anywhere the checkout is.
#[tokio::test]
#[ignore = "needs the firetower-marketplace checkout"]
async fn every_entry_in_the_catalogue_is_shaped_like_an_entry() {
    let all = entries();
    println!("{} entries, all well formed", all.len());
}

/// Claude Code is handed the folder and has to report every server in it.
///
/// Asserted against its `init` frame rather than against our own write, which
/// is the whole point: the frame is Claude Code saying what it loaded. A
/// server appears as `plugin:<plugin>:<server>`, and its status without a
/// real token is `failed` or `pending` — neither is a delivery failure, and
/// *absence* is.
#[tokio::test]
#[ignore = "needs the claude CLI and the marketplace checkout"]
async fn claude_code_loads_every_entry_and_registers_its_server() {
    if !have("claude") {
        eprintln!("no claude on PATH; skipped");
        return;
    }
    let all = entries();
    let dir = tempfile::tempdir().unwrap();
    let id = SessionId::from_stored("s_catalogue");
    let bundles: Vec<SkillBundle> = all.iter().map(|e| e.bundle.clone()).collect();
    ft_worker::skills::apply(dir.path(), &id, Agent::ClaudeCode, &bundles, false)
        .await
        .expect("the catalogue is written");

    let root = ft_worker::plugins::root(dir.path(), &id);
    for e in &all {
        assert!(
            root.join(&e.slug)
                .join(".claude-plugin/plugin.json")
                .is_file(),
            "{}: without its manifest Claude Code ignores the folder silently",
            e.slug
        );
    }

    let init = claude_init(&root).await;
    let loaded: Vec<&str> = init["plugins"]
        .as_array()
        .map(|a| a.iter().filter_map(|p| p["name"].as_str()).collect())
        .unwrap_or_default();
    let servers: Vec<&str> = init["mcp_servers"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s["name"].as_str()).collect())
        .unwrap_or_default();

    let mut missing = Vec::new();
    for e in &all {
        if !loaded.contains(&e.slug.as_str()) {
            missing.push(format!("{} (not loaded as a plugin)", e.slug));
            continue;
        }
        let want = format!("plugin:{}:{}", e.slug, e.server);
        if !servers.contains(&want.as_str()) {
            missing.push(format!("{} (loaded, but {want} is not registered)", e.slug));
        }
    }
    assert!(
        missing.is_empty(),
        "{} of {} entries did not arrive:\n  {}",
        missing.len(),
        all.len(),
        missing.join("\n  ")
    );
    println!(
        "claude code: {} plugins loaded, {} servers registered",
        loaded.len(),
        servers.len()
    );
}

/// Read the `init` frame and stop, without letting it reach the model.
///
/// The frame is emitted before the first turn, so killing the process once it
/// has arrived costs nothing and spends nobody's tokens.
async fn claude_init(plugins: &Path) -> Value {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = tokio::process::Command::new("claude")
        .arg("--plugin-dir")
        .arg(plugins)
        .args([
            "-p",
            "exit",
            "--output-format",
            "stream-json",
            "--verbose",
            "--max-turns",
            "1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("claude starts");

    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let found = loop {
        match tokio::time::timeout(std::time::Duration::from_secs(240), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if v["type"] == "system" && v["subtype"] == "init" {
                        break Some(v);
                    }
                }
            }
            Ok(Ok(None)) | Ok(Err(_)) => break None,
            Err(_) => break None,
        }
    };
    let _ = child.kill().await;
    found.expect("claude emits an init frame describing what it loaded")
}

/// Codex takes the same catalogue through `config.toml`, and has to report
/// every server as a streamable HTTP one holding our credential.
///
/// `codex mcp list --json` is Codex's own parse of the file we wrote, which is
/// the only thing worth asserting: it refuses the *whole* file over one bad
/// table header, so a per-entry check is also a check that no entry poisons
/// the rest.
#[tokio::test]
#[ignore = "needs the codex CLI and the marketplace checkout"]
async fn codex_takes_every_entry_as_a_streamable_http_server_with_our_token() {
    if !have("codex") {
        eprintln!("no codex on PATH; skipped");
        return;
    }
    let all = entries();
    let dir = tempfile::tempdir().unwrap();
    let id = SessionId::from_stored("s_catalogue");
    let bundles: Vec<SkillBundle> = all.iter().map(|e| e.bundle.clone()).collect();

    // Something of its own in the file first: the block is appended to a real
    // configuration in life, and a malformed one takes that with it.
    let home = ft_worker::agentd::dir_for(dir.path()).join(format!("agent-home-{}", id.as_str()));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("config.toml"), "model = \"gpt-5-codex\"\n").unwrap();

    ft_worker::skills::apply(dir.path(), &id, Agent::Codex, &bundles, false)
        .await
        .expect("the catalogue is written");

    let out = tokio::process::Command::new("codex")
        .env("CODEX_HOME", &home)
        .args(["mcp", "list", "--json"])
        .output()
        .await
        .expect("codex runs");
    assert!(
        out.status.success(),
        "codex refused the configuration we wrote: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let listed: Vec<Value> = serde_json::from_slice(&out.stdout).expect("codex answers JSON");
    let by_name: BTreeMap<&str, &Value> = listed
        .iter()
        .map(|s| (s["name"].as_str().unwrap_or_default(), s))
        .collect();

    let mut wrong = Vec::new();
    for e in &all {
        let Some(got) = by_name.get(e.server.as_str()) else {
            wrong.push(format!("{}: codex does not list {}", e.slug, e.server));
            continue;
        };
        if got["transport"]["type"] != "streamable_http" {
            wrong.push(format!(
                "{}: codex reads it as {} rather than streamable_http",
                e.slug, got["transport"]["type"]
            ));
        }
        if got["transport"]["url"].as_str() != Some(e.url.as_str()) {
            wrong.push(format!("{}: codex has a different address", e.slug));
        }
        // The point of the whole exercise: the credential is recognised as
        // one, not merely present in the file.
        if got["auth_status"] != "bearer_token" {
            wrong.push(format!(
                "{}: codex reports auth_status {} — the token did not land",
                e.slug, got["auth_status"]
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} entries are wrong for codex:\n  {}",
        wrong.len(),
        all.len(),
        wrong.join("\n  ")
    );

    // And the model setting that was there before is still there, which is
    // what being refused the file would have cost.
    let config = std::fs::read_to_string(home.join("config.toml")).unwrap();
    assert!(config.contains("model = \"gpt-5-codex\""));
    println!(
        "codex: {} servers, all streamable http with a bearer token",
        all.len()
    );
}

/// The same catalogue in the shape ACP takes, for Kimi and Cursor.
///
/// Those two are not asked anything here because neither has a subcommand to
/// ask: `session/new` is the only way a server reaches them, and
/// `acp_mcp_servers` is what builds it. So this asserts the translation over
/// every entry rather than over one — a connector that came out of it
/// mis-shaped would be dropped by the agent with nothing logged, on two of
/// the four engines, which is exactly the failure this file exists for.
///
/// Needs no CLI; it is here rather than in `plugins.rs` because the input is
/// the catalogue.
#[tokio::test]
#[ignore = "needs the firetower-marketplace checkout"]
async fn the_two_acp_engines_get_every_entry_in_the_shape_their_protocol_takes() {
    let all = entries();
    let dir = tempfile::tempdir().unwrap();
    let id = SessionId::from_stored("s_catalogue");
    let bundles: Vec<SkillBundle> = all.iter().map(|e| e.bundle.clone()).collect();
    ft_worker::skills::apply(dir.path(), &id, Agent::KimiCode, &bundles, false)
        .await
        .expect("the catalogue is written");

    let servers = ft_worker::plugins::acp_mcp_servers(dir.path(), &id).await;
    assert_eq!(
        servers.len(),
        all.len(),
        "every entry has to come back, or a connector vanishes silently"
    );
    let by: BTreeMap<&str, &Value> = servers
        .iter()
        .map(|s| (s["name"].as_str().unwrap_or_default(), s))
        .collect();

    let mut wrong = Vec::new();
    for e in &all {
        let Some(got) = by.get(e.server.as_str()) else {
            wrong.push(format!("{}: {} is not in session/new", e.slug, e.server));
            continue;
        };
        if got["type"] != "http" || got["url"].as_str() != Some(e.url.as_str()) {
            wrong.push(format!("{}: wrong type or address", e.slug));
        }
        // ACP takes headers as a list of pairs rather than as an object, so a
        // pass-through here would be silently wrong rather than loudly.
        if got["headers"][0]["name"] != "Authorization" || got["headers"][0]["value"] != FAKE {
            wrong.push(format!("{}: the credential did not translate", e.slug));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} entries are wrong for ACP:\n  {}",
        wrong.len(),
        all.len(),
        wrong.join("\n  ")
    );

    // And an agent that did not claim `http` is told what it cannot have
    // rather than being sent it.
    let (sent, refused) = ft_worker::plugins::deliverable_mcp(servers, false);
    assert!(sent.is_empty(), "every entry here is an HTTP server");
    assert_eq!(
        refused.len(),
        all.len(),
        "and all of them come back to be named, not dropped"
    );
    println!(
        "acp: {} servers translated, and all {} refusable",
        all.len(),
        refused.len()
    );
}
