//! Giving back what a finished workspace was holding.
//!
//! A workspace whose every session has ended is over: the worktree on the host
//! is gone or going, the agent is not coming back, and nothing in it will be
//! read again. What it leaves behind is not small — `agent_lines` keeps the
//! agent's raw log verbatim, which includes the base64 of every screenshot it
//! captured, and on one measured session that was 9.3 MB with a quarter of it
//! pictures. Kept forever, per workspace, that is a database that only grows.
//!
//! So a sweep, rather than a delete wired into the end of every path that can
//! finish a workspace. Finishing is not one event: the last agent reports it,
//! or a host says so on reconnect, or somebody removes a machine that is never
//! coming back. Asking "which workspaces are done?" answers all of those at
//! once, and answers it again for anything that finished while this process
//! was not running — which is also what clears the backlog that built up
//! before any of this existed.
//!
//! **There is no grace period.** A workspace that ends is reclaimed within the
//! minute, and its conversation goes with it. That is a deliberate decision
//! taken while the growth was the urgent problem; retention is a later feature
//! and belongs here, as one predicate in `workspaces_to_purge`.

use crate::AppState;
use std::time::Duration;

/// How often to look.
///
/// Not a deadline. Nothing is waiting on the space, and a workspace reclaimed
/// a minute after it ended is reclaimed just as thoroughly as one reclaimed
/// immediately — while a tighter loop would mean a query per second against a
/// table that changes a few times an hour.
const EVERY: Duration = Duration::from_secs(60);

/// The most to take in one pass.
///
/// A cap rather than a batch size: each purge is its own statement, and this
/// bounds how long the sweep holds the pool before letting everything else
/// have a turn. A backlog is worked off over several passes instead of one
/// long one, which for the first run after this ships may be thousands of
/// workspaces.
const AT_ONCE: i64 = 50;

/// For as long as the control plane runs.
pub async fn watch(state: AppState) {
    // Not immediately. Start-up has enough to do, and the first thing a fleet
    // does on connect is tell us what it has — a sweep racing that would be
    // reading statuses that are about to be corrected.
    tokio::time::sleep(Duration::from_secs(30)).await;
    loop {
        match sweep(&state).await {
            Ok(0) => {}
            Ok(freed) => tracing::info!("reclaimed {freed} workspace(s)"),
            Err(e) => tracing::warn!("reclaiming finished workspaces: {e:#}"),
        }
        tokio::time::sleep(EVERY).await;
    }
}

/// One pass. Returns how many workspaces were let go of.
pub async fn sweep(state: &AppState) -> anyhow::Result<usize> {
    let done = state.db.workspaces_to_purge(AT_ONCE).await?;
    if done.is_empty() {
        return Ok(0);
    }

    let mut freed = 0;
    for workspace in &done {
        // Weighed before it goes, because afterwards there is nothing left to
        // ask. Only worth a line in the log when it is a real amount — the
        // point is that somebody watching a disk fill can see where it went.
        let bytes = state.db.workspace_weight(workspace).await.unwrap_or(0);

        match state.db.purge_workspace(workspace).await {
            // Zero rows means somebody else got there first, which is fine and
            // is not worth counting.
            Ok(0) => {}
            Ok(_) => {
                freed += 1;
                if bytes > 1_000_000 {
                    tracing::info!(
                        workspace = %workspace,
                        "reclaimed {:.1} MB of transcript",
                        bytes as f64 / 1e6
                    );
                }
            }
            // One workspace refusing to go is not a reason to stop: the rest
            // of the pass is still worth doing, and this one is tried again
            // next time.
            Err(e) => tracing::warn!(workspace = %workspace, "purging: {e:#}"),
        }
    }

    Ok(freed)
}
