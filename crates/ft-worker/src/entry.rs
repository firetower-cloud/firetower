//! The ways a worker is called back into, by something that is not the control
//! plane.
//!
//! Both binaries have to answer these. `firetower-worker` is what a remote host
//! runs; `firetower` is what serves localhost, where the worker is the control
//! plane's own executable with a subcommand. An agent started by one and a
//! session opened through the other must behave identically, so the
//! implementation lives here and each binary only dispatches.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Supervise one session's agent until it exits.
pub async fn run_agent(session: &str, workspace: PathBuf, agent: &str) -> Result<()> {
    let kind =
        ft_core::Agent::from_name(agent).with_context(|| format!("no agent called {agent}"))?;

    // Written before the agent starts, because it is what tells the agent how
    // to ask us anything. Losing it does not make the session unsafe — it makes
    // it silent, which is worse — so a failure here is fatal rather than best
    // effort.
    let asking = arrange_asking(session, &workspace)
        .await
        .context("setting up how the agent asks for permission")?;

    let argv = kind
        .launch_headless(session, &asking)
        .with_context(|| format!("{} cannot be driven this way yet", kind.label()))?;

    crate::agentd::run(crate::agentd::Launch {
        session_id: session.to_string(),
        workspace,
        argv,
        // Inherited from tmux, which was handed the session's environment when
        // it started this. Nothing to add.
        env: vec![],
    })
    .await
    .context("supervising the agent")
}

/// Write the permission tool's configuration, and say how to reach it.
///
/// This binary is both the agent's supervisor and the server it will call to
/// ask a question — the agent starts the second one itself, from what is
/// written here.
async fn arrange_asking(session: &str, workspace: &std::path::Path) -> Result<ft_core::Asking> {
    let exe = std::env::current_exe().context("finding this binary's own path")?;
    let dir = crate::agentd::dir_for(workspace);
    tokio::fs::create_dir_all(&dir).await?;

    let config = dir.join("mcp.json");
    let contents =
        serde_json::to_vec_pretty(&crate::approver::mcp_config(&exe, session, workspace))?;
    tokio::fs::write(&config, contents).await?;

    Ok(ft_core::Asking::Ask {
        tool: crate::approver::tool_name(),
        config: config.display().to_string(),
    })
}

/// Print what a running agent is saying, one event per line.
pub async fn tail_agent(session: &str, from_line: u64, raw: bool) -> Result<()> {
    use tokio::io::AsyncBufReadExt;

    let mut client = crate::agentd::AgentClient::connect(session)
        .await
        .with_context(|| format!("no agent is listening for session {session}"))?;
    client
        .send(&crate::agentd::ToAgent::Watch { from_line })
        .await?;

    let mut normaliser = ft_core::normalise::ClaudeNormaliser::new();
    let mut frames = tokio::io::BufReader::new(client.into_stream()).lines();

    while let Some(frame) = frames.next_line().await? {
        let Ok(frame) = serde_json::from_str::<crate::agentd::FromAgent>(&frame) else {
            continue;
        };
        match frame {
            crate::agentd::FromAgent::Line { line_no, line } => {
                if raw {
                    println!("{line_no:>5}  {line}");
                    continue;
                }
                for event in normaliser.push(&line) {
                    println!("{line_no:>5}  {}", summarise(&event));
                }
            }
            crate::agentd::FromAgent::Exited { .. } => {
                println!("      the agent exited");
                break;
            }
            other => println!("      {other:?}"),
        }
    }
    Ok(())
}

/// One event, short enough to read a session by.
fn summarise(event: &ft_core::TurnEvent) -> String {
    use ft_core::turn::TurnEvent as E;
    match event {
        E::SessionConfigured { model, tools, .. } => {
            format!("session   {model}, {} tools", tools.len())
        }
        E::TurnStarted { turn } => format!("turn      {turn} started"),
        E::TurnCompleted { turn, status, .. } => format!("turn      {turn} {status:?}"),
        E::ItemStarted { kind, title, .. } => {
            format!("item      {kind:?} {}", title.as_deref().unwrap_or(""))
        }
        E::ItemUpdated { item, .. } => format!("item      {item} input"),
        E::ItemCompleted { item, status } => format!("item      {item} {status:?}"),
        E::ContentDelta { stream, delta, .. } => {
            format!("text      {stream:?} {:?}", trim(delta))
        }
        E::RequestOpened { kind, detail, .. } => format!("asks      {kind:?} {detail}"),
        E::RequestResolved { decision, .. } => format!("answered  {decision:?}"),
        E::UserInputRequested { questions, .. } => {
            format!("asks      {} question(s)", questions.len())
        }
        E::UserInputResolved { .. } => "answered  questions".into(),
        E::PlanUpdated { steps } => format!("plan      {} step(s)", steps.len()),
        E::TaskStarted { description, .. } => format!("subagent  {description}"),
        E::TaskProgress { detail, .. } => format!("subagent  {detail}"),
        E::TaskCompleted { status, .. } => format!("subagent  {status:?}"),
        E::Raw { payload, .. } => format!(
            "unnamed   {}",
            payload.get("type").and_then(|t| t.as_str()).unwrap_or("?")
        ),
    }
}

fn trim(text: &str) -> String {
    let flat = text.replace('\n', " ");
    if flat.chars().count() > 60 {
        format!("{}…", flat.chars().take(60).collect::<String>())
    } else {
        flat
    }
}
