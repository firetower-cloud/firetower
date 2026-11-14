//! What a session may reach outside itself, written where its launch reads it.
//!
//! **Why this is on disk at all.** The frame that carries a session's
//! connectors arrives at the worker's connection, and the agent is launched by
//! a *different* process — `agent-run`, inside the tmux pane — which has
//! nothing of that frame. Skills take the same route for the same reason, and
//! this is the smaller version of it: one file per session, holding the set as
//! it was last sent.
//!
//! **One file, two consumers, and both read it at launch.** The MCP
//! configuration tells the agent the addresses; the permission rules in
//! `crate::settings` make its write tools ask. Writing them from one place at
//! one moment is what stops a session coming up able to reach a server nobody
//! would be asked about.
//!
//! Per session rather than per workspace: a workspace holds several sessions,
//! each with its own agent and its own selection, and a connector is signed in
//! to by one person.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use ft_core::SessionId;
use ft_proto::McpServer;

use crate::agentd;

/// Where this session's set waits for the launch that reads it.
///
/// Beside the agent's log and its MCP configuration, in the workspace's own
/// `.firetower` directory — which the workspace's teardown already removes, so
/// a resolved credential does not outlive the session it was resolved for.
pub fn path(workspace: &Path, id: &SessionId) -> PathBuf {
    agentd::dir_for(workspace).join(format!("connectors-{}.json", id.as_str()))
}

/// Make the set on disk be exactly `connectors`.
///
/// The whole selection, never a delta. An empty set removes the file rather
/// than leaving an empty one: absent and "none" are the same state, and one of
/// them cannot be half-written.
///
/// **Written 0600.** A header in here is a bearer token. The file lands inside
/// a workspace that a session's own agent can read — which is the decision
/// taken not to build a credential proxy in v1, and the deployment-level answer
/// to it is a worker per person. The mode is still worth setting: it keeps the
/// token away from every *other* account on the machine.
pub async fn apply(workspace: &Path, id: &SessionId, connectors: &[McpServer]) -> Result<()> {
    let at = path(workspace, id);
    if connectors.is_empty() {
        match tokio::fs::remove_file(&at).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e).with_context(|| format!("removing {}", at.display())),
        }
        return Ok(());
    }

    if let Some(parent) = at.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let text = serde_json::to_vec_pretty(connectors)?;

    // Created with the mode it needs rather than chmod'd afterwards: between
    // the write and the chmod there is a world-readable file with a token in
    // it, and that window is the whole of the problem.
    let temp = at.with_extension("json.firetower");
    write_private(&temp, &text)
        .await
        .with_context(|| format!("writing {}", temp.display()))?;
    tokio::fs::rename(&temp, &at)
        .await
        .with_context(|| format!("moving into {}", at.display()))?;
    Ok(())
}

#[cfg(unix)]
async fn write_private(at: &Path, bytes: &[u8]) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(at)
        .await?;
    file.write_all(bytes).await?;
    file.flush().await?;
    Ok(())
}

#[cfg(not(unix))]
async fn write_private(at: &Path, bytes: &[u8]) -> Result<()> {
    tokio::fs::write(at, bytes).await?;
    Ok(())
}

/// What this session was last told it may reach.
///
/// An unreadable or absent file is an empty set, not a failure. A session that
/// starts with no connectors has lost a feature; one that refuses to start has
/// lost the work — and the agent's own `init` frame is what the interface reads
/// to say which of them happened.
pub async fn of_session(workspace: &Path, id: &SessionId) -> Vec<McpServer> {
    let at = path(workspace, id);
    let Ok(text) = tokio::fs::read_to_string(&at).await else {
        return Vec::new();
    };
    match serde_json::from_str::<Vec<McpServer>>(&text) {
        Ok(set) => set,
        Err(e) => {
            tracing::warn!(session = %id.as_str(), "reading {}: {e:#}", at.display());
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str) -> McpServer {
        McpServer {
            name: name.into(),
            url: format!("https://{name}.example/mcp"),
            headers: vec![("Authorization".into(), "Bearer secret".into())],
            tools: vec!["do_thing".into()],
        }
    }

    fn session() -> SessionId {
        SessionId::from_stored("s_01example")
    }

    #[tokio::test]
    async fn the_set_survives_the_trip_to_the_process_that_launches_the_agent() {
        let ws = tempfile::tempdir().unwrap();
        apply(ws.path(), &session(), &[server("slack")])
            .await
            .unwrap();

        let back = of_session(ws.path(), &session()).await;
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].name, "slack");
        assert_eq!(back[0].headers[0].1.as_str(), "Bearer secret");
        assert_eq!(back[0].tools, ["do_thing"]);
    }

    /// A header in this file is a bearer token, and the machine may have other
    /// accounts on it.
    #[cfg(unix)]
    #[tokio::test]
    async fn it_is_not_readable_by_anybody_else_on_the_machine() {
        use std::os::unix::fs::PermissionsExt;
        let ws = tempfile::tempdir().unwrap();
        apply(ws.path(), &session(), &[server("slack")])
            .await
            .unwrap();
        let mode = std::fs::metadata(path(ws.path(), &session()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{mode:o}");
    }

    #[tokio::test]
    async fn turning_the_last_one_off_takes_the_file_with_it() {
        let ws = tempfile::tempdir().unwrap();
        apply(ws.path(), &session(), &[server("slack")])
            .await
            .unwrap();
        apply(ws.path(), &session(), &[]).await.unwrap();
        assert!(!path(ws.path(), &session()).exists());
        assert!(of_session(ws.path(), &session()).await.is_empty());
    }

    #[tokio::test]
    async fn nothing_written_is_no_connectors_rather_than_a_failure() {
        let ws = tempfile::tempdir().unwrap();
        assert!(of_session(ws.path(), &session()).await.is_empty());
    }

    /// Two sessions in one workspace are two people, and one of those headers
    /// is a credential. They do not share a file.
    #[tokio::test]
    async fn two_sessions_in_one_workspace_do_not_share_a_set() {
        let ws = tempfile::tempdir().unwrap();
        let ana = SessionId::from_stored("s_01ana");
        let bob = SessionId::from_stored("s_01bob");
        apply(ws.path(), &ana, &[server("slack")]).await.unwrap();
        apply(ws.path(), &bob, &[server("gdrive")]).await.unwrap();

        assert_eq!(of_session(ws.path(), &ana).await[0].name, "slack");
        assert_eq!(of_session(ws.path(), &bob).await[0].name, "gdrive");
    }
}
