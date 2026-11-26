//! The catalogue query, asked of a real Postgres.
//!
//! **Because a missing comma shipped.** `count(*) OVER ()` went in without
//! one and every call to `entries` answered `syntax error at or near "count"`
//! — through a thousand green unit tests, because not one of them speaks to a
//! database. Nothing offline can catch that: SQL in a string is a string
//! until a server parses it.
//!
//! So this is the cheap version of the thing that was missing. It takes a
//! `DATABASE_URL`, asks for every shape of page the screen can ask for, and
//! only cares that the statement is legal and the paging arithmetic holds. It
//! asserts nothing about *which* entries come back, so it passes against an
//! empty database and against somebody's working one alike.
//!
//! ```text
//! DATABASE_URL=postgres://… cargo test -p ft-server --test catalogue_query -- --ignored
//! ```

use ft_server::marketplace::{self, Asked, PER_PAGE};
use sqlx::postgres::PgPoolOptions;

async fn pool() -> Option<sqlx::PgPool> {
    let at = std::env::var("DATABASE_URL").ok()?;
    PgPoolOptions::new()
        .max_connections(2)
        .connect(&at)
        .await
        .ok()
}

/// Any organisation will do; the query is the subject, not the rows.
async fn an_org(pool: &sqlx::PgPool) -> String {
    sqlx::query_scalar::<_, String>("SELECT id FROM organizations LIMIT 1")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "org_none".into())
}

#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn every_shape_the_screen_can_ask_for_is_legal_sql() {
    let Some(pool) = pool().await else {
        eprintln!("no DATABASE_URL; skipped");
        return;
    };
    let org = an_org(&pool).await;

    // Each knob alone, and then together, because a filter that is only ever
    // bound as NULL is a filter nobody has run.
    let shapes: Vec<Asked> = vec![
        Asked::default(),
        Asked { page: 2, ..Default::default() },
        Asked { q: Some("mail"), ..Default::default() },
        Asked { q: Some("  "), ..Default::default() },
        Asked { kind: Some("mcp"), ..Default::default() },
        Asked { kind: Some("skills"), ..Default::default() },
        Asked { kind: Some("nonsense"), ..Default::default() },
        Asked { installed: Some(true), ..Default::default() },
        Asked { installed: Some(false), ..Default::default() },
        Asked { q: Some("a"), kind: Some("mcp"), installed: Some(false), page: 2 },
    ];
    for ask in &shapes {
        let got = marketplace::entries(&pool, &org, ask)
            .await
            .unwrap_or_else(|e| panic!("{ask:?} is not legal SQL: {e:#}"));
        assert!(
            got.entries.len() as u32 <= PER_PAGE,
            "{ask:?} returned more than a page"
        );
        assert!(
            got.total >= got.entries.len() as i64,
            "{ask:?}: a page cannot hold more than the total it is part of"
        );
    }
}

/// Walking the pages reaches every row exactly once, and stops.
///
/// The arithmetic `more` is built on — offset plus this page against the
/// total — is the kind that is right until the catalogue is an exact multiple
/// of the page size, which is the case nobody tries by hand.
#[tokio::test]
#[ignore = "needs DATABASE_URL"]
async fn paging_all_the_way_down_sees_everything_once_and_halts() {
    let Some(pool) = pool().await else {
        eprintln!("no DATABASE_URL; skipped");
        return;
    };
    let org = an_org(&pool).await;

    let first = marketplace::entries(&pool, &org, &Asked::default())
        .await
        .expect("a first page");
    if first.total == 0 {
        eprintln!("no catalogue in this database; nothing to walk");
        return;
    }

    let mut seen: Vec<String> = Vec::new();
    let mut page = 1;
    loop {
        let got = marketplace::entries(&pool, &org, &Asked { page, ..Default::default() })
            .await
            .expect("a page");
        seen.extend(got.entries.iter().map(|e| format!("{}/{}", e.marketplace_id, e.slug)));
        if !got.more {
            break;
        }
        page += 1;
        assert!(page < 500, "more never became false, so this would not stop");
    }

    assert_eq!(
        seen.len() as i64,
        first.total,
        "walking the pages saw a different number of rows than the count promised"
    );
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), seen.len(), "a row appeared on two pages");

    // And every row carries something a person can read, whether or not its
    // catalogue supplied one.
    for e in &first.entries {
        assert!(
            !e.display_name.trim().is_empty(),
            "{} has nothing to draw",
            e.slug
        );
    }
}
