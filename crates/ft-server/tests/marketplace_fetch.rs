//! Reading a real marketplace, over the real network.
//!
//! `#[ignore]` because it needs GitHub. Run with
//! `cargo test -p ft-server --test marketplace_fetch -- --ignored --nocapture`.
//!
//! **Set `MARKETPLACE_TOKEN` before you do.** Anonymous GitHub is sixty
//! requests an hour counted per address, which these tests exhaust in a
//! working afternoon — and the failure that follows says `403` in a place
//! that looks like "that branch does not exist".

use ft_server::marketplace::{self, Source};

const OURS: &str = "https://github.com/firetower-cloud/firetower-marketplace";

fn token() -> Option<String> {
    std::env::var("MARKETPLACE_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

#[tokio::test]
#[ignore]
async fn our_own_repository_reads_as_a_catalogue() {
    let got = marketplace::fetch(OURS, "main", token().as_deref())
        .await
        .expect("fetching our marketplace");

    assert_eq!(got.manifest, "claude");
    assert_eq!(got.name, "firetower");
    assert_eq!(got.commit.len(), 40, "pinned to a whole commit");
    assert_eq!(got.entries.len(), 6);

    let names: Vec<&str> = got.entries.iter().map(|e| e.slug.as_str()).collect();
    assert!(names.contains(&"linear") && names.contains(&"figma"));

    for e in &got.entries {
        // Every one of ours carries its own mark, and the shelf draws from
        // this rather than from anybody's origin.
        let (bytes, kind) = e
            .logo
            .as_ref()
            .unwrap_or_else(|| panic!("{} has no logo", e.slug));
        assert!(bytes.len() > 500, "{} has a stub for a logo", e.slug);
        assert!(kind.starts_with("image/"));
        assert!(e.has_connector, "{} declares no server", e.slug);
        assert!(!e.description.is_empty(), "{} says nothing", e.slug);
    }
}

/// **Six servers and no skills**, which is the honest state of this
/// repository and worth a test rather than a README line alone.
///
/// Three skills were written for it and all three deleted: each said what a
/// capable model already does unprompted, which is the one thing a skill must
/// not be. If this assertion starts failing, somebody has added one — and the
/// question to ask is whether it encodes something a vendor's tool names do
/// not already say.
#[tokio::test]
#[ignore]
async fn it_publishes_servers_and_not_instructions() {
    let got = marketplace::fetch(OURS, "main", token().as_deref())
        .await
        .unwrap();
    assert_eq!(got.entries.iter().filter(|e| e.has_connector).count(), 6);
    assert_eq!(got.entries.iter().map(|e| e.n_skills).sum::<i32>(), 0);
}

#[tokio::test]
#[ignore]
async fn one_entry_comes_back_as_files_with_its_connector() {
    let got = marketplace::fetch(OURS, "main", token().as_deref())
        .await
        .unwrap();
    let linear = got.entries.iter().find(|e| e.slug == "linear").unwrap();
    assert!(matches!(&linear.source, Source::Inside { path } if path == "./mcp/linear"));

    let files = marketplace::files_of(&linear.source, OURS, &got.commit, token().as_deref())
        .await
        .expect("pulling the subtree");

    let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    assert!(paths.contains(&".claude-plugin/plugin.json"));
    assert!(paths.contains(&".codex-plugin/plugin.json"));
    assert!(paths.contains(&"assets/logo.png"));

    let d = marketplace::connector_of(&files).expect("a connector");
    assert_eq!(d.server, "linear");
    assert_eq!(d.url, "https://mcp.linear.app/mcp");
    assert_eq!(d.auth, "oauth");
    // Linear hands out its own clients, so it has nothing to say about a
    // console — and nothing invents one for it.
    assert_eq!(d.console, None);
    assert_eq!(d.guide, None);
}

/// **A manifest does not get to choose how it is authorized.**
///
/// `mcp/github` used to carry a `firetower` key asking to reuse the token
/// Firetower holds for git. Somebody who connected GitHub so Firetower could
/// do *git* had not agreed to an agent calling GitHub's whole tool surface,
/// and a repository they did not write is the last place that decision
/// belongs. Everything authorizes for itself, whatever the file says.
#[tokio::test]
#[ignore]
async fn a_manifest_cannot_ask_to_borrow_a_credential() {
    let got = marketplace::fetch(OURS, "main", token().as_deref())
        .await
        .unwrap();
    let e = got.entries.iter().find(|x| x.slug == "github").unwrap();
    let files = marketplace::files_of(&e.source, OURS, &got.commit, token().as_deref())
        .await
        .unwrap();
    let d = marketplace::connector_of(&files).unwrap();
    assert_eq!((d.server.as_str(), d.auth.as_str()), ("github", "oauth"));
    // It *does* carry a console, because GitHub registers no clients — which
    // is a different thing from choosing which credential to reuse.
    assert_eq!(
        d.console.as_deref(),
        Some("https://github.com/settings/applications/new")
    );
}

/// The catalogue nobody else can read is the one that proves nothing.
#[tokio::test]
#[ignore]
async fn anthropics_marketplace_reads_too() {
    let got = marketplace::fetch(
        "https://github.com/anthropics/claude-plugins-official",
        "main",
        token().as_deref(),
    )
    .await
    .expect("fetching theirs");

    assert!(got.entries.len() > 200, "got {}", got.entries.len());
    // Most of theirs live in other repositories — a reader that only
    // understands a local path understands a sixth of this.
    let elsewhere = got
        .entries
        .iter()
        .filter(|e| matches!(e.source, Source::Repo { .. }))
        .count();
    assert!(elsewhere > 100, "only {elsewhere} point elsewhere");
}

#[test]
fn an_address_is_read_in_every_form_somebody_pastes_it() {
    let want = Some(("acme".to_string(), "plugins".to_string()));
    for form in [
        "https://github.com/acme/plugins",
        "https://github.com/acme/plugins/",
        "https://github.com/acme/plugins.git",
        "git@github.com:acme/plugins.git",
        "http://github.com/acme/plugins",
    ] {
        assert_eq!(marketplace::github_of(form), want, "{form}");
    }
    assert_eq!(
        marketplace::github_of("https://gitlab.com/acme/plugins"),
        None
    );
    assert_eq!(marketplace::github_of("not a url"), None);
}
