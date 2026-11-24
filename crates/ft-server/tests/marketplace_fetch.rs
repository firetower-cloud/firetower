//! Reading a real marketplace, over the real network.
//!
//! `#[ignore]` because it needs GitHub. Run with
//! `cargo test -p ft-server --test marketplace_fetch -- --ignored --nocapture`.

use ft_server::marketplace::{self, Source};

const OURS: &str = "https://github.com/firetower-cloud/firetower-plugins";

#[tokio::test]
#[ignore]
async fn our_own_repository_reads_as_a_catalogue() {
    let got = marketplace::fetch(OURS, "agent/plguins", None)
        .await
        .expect("fetching our marketplace");

    assert_eq!(got.manifest, "claude");
    assert_eq!(got.name, "firetower");
    assert_eq!(got.commit.len(), 40, "pinned to a whole commit");
    assert_eq!(got.entries.len(), 6);

    let names: Vec<&str> = got.entries.iter().map(|e| e.slug.as_str()).collect();
    assert!(names.contains(&"linear") && names.contains(&"figma"));

    // Every one of ours carries its own mark, and the shelf draws from this
    // rather than from anybody's origin.
    for e in &got.entries {
        let (bytes, kind) = e.logo.as_ref().unwrap_or_else(|| panic!("{} has no logo", e.slug));
        assert!(bytes.len() > 500, "{} has a stub for a logo", e.slug);
        assert!(kind.starts_with("image/"));
        assert!(e.has_connector, "{} declares no connector", e.slug);
        assert!(!e.description.is_empty(), "{} says nothing", e.slug);
    }

    // Counted from paths, not from anything the listing claims.
    let github = got.entries.iter().find(|e| e.slug == "github").unwrap();
    assert_eq!(github.n_skills, 1, "github ships open-a-pr");
    let linear = got.entries.iter().find(|e| e.slug == "linear").unwrap();
    assert_eq!(linear.n_skills, 0, "linear ships the connector bare");
}

#[tokio::test]
#[ignore]
async fn one_entry_comes_back_as_files_with_its_connector() {
    let got = marketplace::fetch(OURS, "agent/plguins", None).await.unwrap();
    let linear = got.entries.iter().find(|e| e.slug == "linear").unwrap();
    assert!(matches!(&linear.source, Source::Inside { path } if path == "./linear"));

    let files = marketplace::files_of(&linear.source, OURS, &got.commit, None)
        .await
        .expect("pulling the subtree");

    let paths: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    assert!(paths.contains(&".claude-plugin/plugin.json"));
    assert!(paths.contains(&".codex-plugin/plugin.json"));
    assert!(paths.contains(&"assets/logo.png"));

    let (server, url, auth, borrow) = marketplace::connector_of(&files).expect("a connector");
    assert_eq!(server, "linear");
    assert_eq!(url, "https://mcp.linear.app/mcp");
    assert_eq!(auth, "oauth");
    assert_eq!(borrow, None);
}

/// The one that needs no flow at all, and says so in its own file.
#[tokio::test]
#[ignore]
async fn github_declares_that_it_borrows_a_credential_we_hold() {
    let got = marketplace::fetch(OURS, "agent/plguins", None).await.unwrap();
    let e = got.entries.iter().find(|x| x.slug == "github").unwrap();
    let files = marketplace::files_of(&e.source, OURS, &got.commit, None).await.unwrap();
    let (server, _, auth, borrow) = marketplace::connector_of(&files).unwrap();
    assert_eq!((server.as_str(), auth.as_str(), borrow.as_deref()),
               ("github", "borrow-git", Some("github")));
}

/// The catalogue nobody else can read is the one that proves nothing.
#[tokio::test]
#[ignore]
async fn anthropics_marketplace_reads_too() {
    let got = marketplace::fetch(
        "https://github.com/anthropics/claude-plugins-official",
        "main",
        None,
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
    assert_eq!(marketplace::github_of("https://gitlab.com/acme/plugins"), None);
    assert_eq!(marketplace::github_of("not a url"), None);
}
