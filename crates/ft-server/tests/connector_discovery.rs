//! Discovery and registration, against the real servers.
//!
//! **Ignored by default**, because they reach the network: a test that fails
//! when somebody's wifi does is a test people learn to re-run rather than
//! read. Run them deliberately:
//!
//! ```sh
//! cargo test -p ft-server --test connector_discovery -- --ignored --nocapture
//! ```
//!
//! What they are for is the thing a unit test cannot say: that the shapes this
//! module expects are the shapes three different vendors actually publish. The
//! highest-value seam in the whole broker is a metadata document changing
//! upstream, and this is where that is noticed.

use ft_server::connectors;

/// The three that advertise dynamic registration. Measured 22 November 2026.
const SERVERS: &[(&str, &str)] = &[
    ("Linear", "https://mcp.linear.app/mcp"),
    ("Notion", "https://mcp.notion.com/mcp"),
    ("Sentry", "https://mcp.sentry.dev/mcp"),
];

#[tokio::test]
#[ignore = "reaches the network"]
async fn the_published_metadata_is_the_shape_this_expects() {
    for (name, url) in SERVERS {
        let d = connectors::discover(url)
            .await
            .unwrap_or_else(|e| panic!("{name}: {e:#}"));
        println!("{name}\n  resource  {}\n  authorize {}\n  token     {}\n  register  {}\n  scopes    {}",
            d.resource, d.authorize_url, d.token_url,
            d.register_url.as_deref().unwrap_or("(none)"),
            d.scopes.as_deref().unwrap_or("(none published)"));

        assert!(d.authorize_url.starts_with("https://"), "{name}");
        assert!(d.token_url.starts_with("https://"), "{name}");
        assert!(
            d.register_url.is_some(),
            "{name} advertised dynamic registration when this was written; if it \
             has stopped, the manual client-id path is what it now needs"
        );
        assert!(
            !d.resource.is_empty(),
            "{name}: with no resource there is nothing to bind a token to"
        );
    }
}

/// GitHub is the exception the design is built around: no dynamic
/// registration, and an authorization server Firetower already has an
/// application for — so its connector borrows the git token instead of coming
/// through this module at all.
#[tokio::test]
#[ignore = "reaches the network"]
async fn github_is_still_the_one_that_registers_no_clients() {
    let d = connectors::discover("https://api.githubcopilot.com/mcp/")
        .await
        .expect("github publishes metadata");
    println!(
        "GitHub\n  authorize {}\n  register  {:?}\n  scopes    {:?}",
        d.authorize_url, d.register_url, d.scopes
    );
    assert!(
        d.authorize_url.contains("github.com/login/oauth"),
        "its authorization server is the application Firetower already registered"
    );
    assert_eq!(
        d.register_url, None,
        "if GitHub has gained dynamic registration, borrow-git stops being the \
         only way its connector can work and this design has an easier option"
    );
    let scopes = d.scopes.unwrap_or_default();
    for want in ["repo", "read:org", "read:user"] {
        assert!(
            scopes.contains(want),
            "providers.rs asks for `{want}` because this is where it came from; \
             published scopes are now: {scopes}"
        );
    }
}

/// **Registration is unauthenticated**, which is what makes "paste a URL and
/// press connect" possible with no administrator and no application. This
/// really registers a client; it is the one test here with a side effect, and
/// the side effect is a disposable public client on somebody else's server.
#[tokio::test]
#[ignore = "reaches the network and registers a real client"]
async fn firetower_can_register_itself_with_no_administrator() {
    let d = connectors::discover("https://mcp.linear.app/mcp")
        .await
        .expect("linear publishes metadata");
    let at = d
        .register_url
        .clone()
        .expect("linear registers clients dynamically");

    let registered = connectors::register(&at, "http://localhost:14400/api/v1/connectors/callback")
        .await
        .unwrap_or_else(|e| panic!("registering with Linear: {e:#}"));

    println!("registered with Linear as {}", registered.client_id);
    assert!(!registered.client_id.is_empty());

    // And the authorize URL built from it is one a browser could be sent to.
    let pkce = connectors::Pkce::new();
    let url = connectors::authorize_url(
        &d,
        &registered.client_id,
        "http://localhost:14400/api/v1/connectors/callback",
        "a-state",
        &pkce,
    );
    println!("authorize  {url}");
    assert!(url.contains("code_challenge_method=S256"));
    assert!(
        url.contains("resource="),
        "the token must be audience-bound"
    );
}
