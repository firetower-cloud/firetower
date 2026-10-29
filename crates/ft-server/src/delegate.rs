//! What a session asks for on its own behalf: another agent, or news of one.
//!
//! A lead's `spawn` arrives down the road a permission question takes — the
//! session's socket, then the worker's `AgentAsks` frame — with its name
//! prefixed so the fleet hands it here rather than to a person. This is the
//! far end of that road. It has `AppState`, which the fleet's connection loop
//! deliberately does not, and so can do everything starting a session takes:
//! choose a host, cut a branch, resolve a credential. The answer goes back
//! down the same road, as the text of the tool's result.
//!
//! Nothing here is a new frame. An older control plane receiving one of these
//! shows it as a permission card and somebody answers it by hand, which is a
//! worse day than this but not a disconnected worker.

use anyhow::{bail, Context, Result};
use ft_core::{Agent, NewSession, Session, SessionId, SessionStatus};
use ft_proto::ToWorker;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::api::sessions::{create_session_as, Lineage};
use crate::AppState;

/// What a delegation call is named on the wire, before the tool's own name.
///
/// The worker's approver puts it there; this is the only other place that
/// spells it. It cannot collide with a permission question, because the agent
/// spells a tool's permission name `mcp__firetower__spawn`.
pub const PREFIX: &str = "firetower:";

/// The first line of a message relayed between a lead and a child.
///
/// A child's result and a lead's steer both have to arrive as a user turn —
/// that is the only thing an agent reads as input — so in the raw transcript
/// they look like the person typed them. This marks them as what they are, so
/// the interface can draw them as a card from the other agent rather than as a
/// bubble from you. `⟦ft:<kind>:<session>:<name>⟧` on its own line, stripped
/// before display. The desktop mirrors this in `desktop/src/api/relay.ts`;
/// keep the two in step.
fn relay_marker(kind: &str, id: &SessionId, name: &str) -> String {
    // The name is last and runs to the end bracket, so a name with spaces or a
    // slash — "Hello / saluteur" — needs no escaping; only `⟧` could break it,
    // and nothing names a session that.
    format!("⟦ft:{kind}:{}:{}⟧", id.as_str(), name)
}

/// How many children a lead may have in flight at once.
pub const LIVE_CHILDREN: usize = 4;
/// How many a lead may start over its life.
pub const CHILDREN_PER_SESSION: usize = 8;

/// One call from a session's agent, as the fleet hands it over.
#[derive(Debug, Clone)]
pub struct AgentRequest {
    pub host_id: ft_core::HostId,
    pub session_id: SessionId,
    /// The agent's own id for the call; the answer is matched on it.
    pub req: String,
    /// `spawn` or `children`, with the prefix already taken off.
    pub tool: String,
    pub input: Value,
}

/// Answer every call the fleet hands over, for as long as it does.
pub async fn serve(state: AppState, mut requests: mpsc::Receiver<AgentRequest>) {
    while let Some(request) = requests.recv().await {
        // Each on its own task: starting a workspace waits on a host, and a
        // second lead asking meanwhile should not queue behind the first.
        let state = state.clone();
        tokio::spawn(async move {
            let text = match handle(&state, &request).await {
                Ok(text) => text,
                // The reason reaches the agent, which reads it and usually
                // tries something else — the same contract a denial has.
                Err(e) => format!("Firetower could not do that: {e:#}"),
            };
            let answer = ToWorker::Answer {
                session_id: request.session_id.clone(),
                req: request.req.clone(),
                result: json!({ "text": text }),
            };
            if let Err(e) = state.fleet.send(&request.host_id, answer).await {
                tracing::warn!(session = %request.session_id, "answering a delegation call: {e:#}");
            }
        });
    }
}

async fn handle(state: &AppState, request: &AgentRequest) -> Result<String> {
    match request.tool.as_str() {
        "spawn" => spawn(state, request).await,
        "children" => children(state, request).await,
        other => bail!("`{other}` is not something a session can ask Firetower for"),
    }
}

/// A string argument, or nothing — blank counts as nothing.
fn text(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Start a child for the session that asked.
async fn spawn(state: &AppState, request: &AgentRequest) -> Result<String> {
    let lead = state
        .db
        .session(&request.session_id)
        .await?
        .context("the session that asked no longer exists")?;

    // Flat, deliberately: a child may not start children of its own. The
    // lead decides the shape of the work, and a tree nobody can see the
    // bottom of is how eight workspaces become a hundred.
    if lead.parent_id.is_some() {
        bail!("this session is itself a child, and children cannot spawn");
    }

    // The same call again — a worker that reconnects re-announces what its
    // agent is still blocked on — is the same child, not a second one.
    if let Some(existing) = state.db.child_by_req(&lead.id, &request.req).await? {
        let shares = existing.workspace_id == lead.workspace_id;
        return Ok(started(&existing, shares));
    }

    let goal = text(&request.input, "goal")
        .context("spawn needs a `goal`: what the child should accomplish")?;

    // A saved kind of agent, if one was named. Resolved against what the
    // lead's owner may see, so a lead can never reach a role filed where its
    // owner cannot — and an unknown name is refused with the ones that exist,
    // which is the whole of discovery in this first cut.
    let role = match text(&request.input, "role") {
        Some(wanted) => match state.roles.by_name(lead.owner.as_str(), &wanted).await? {
            Some(found) => Some(found),
            None => {
                let names: Vec<String> = state
                    .roles
                    .visible(lead.owner.as_str(), crate::access::Level::Viewer)
                    .await?
                    .into_iter()
                    .map(|r| r.name)
                    .collect();
                bail!(
                    "no subagent called \"{wanted}\". {}",
                    if names.is_empty() {
                        "No subagents are defined yet — make one under Configuration → Subagents."
                            .to_string()
                    } else {
                        format!("Subagents you can use: {}.", names.join(", "))
                    }
                );
            }
        },
        None => None,
    };

    let siblings = state.db.children_of(&lead.id).await?;
    let live: Vec<&Session> = siblings.iter().filter(|c| c.status.in_flight()).collect();
    if live.len() >= LIVE_CHILDREN {
        let names: Vec<String> = live
            .iter()
            .map(|c| format!("{} ({})", c.name, c.id))
            .collect();
        bail!(
            "{} of {LIVE_CHILDREN} child slots are in use by {}; wait for one to hand back, \
             or batch the work",
            live.len(),
            names.join(", ")
        );
    }
    if siblings.len() >= CHILDREN_PER_SESSION {
        bail!(
            "this session has started {CHILDREN_PER_SESSION} children, which is the most one may"
        );
    }

    // Explicit arguments win; a role fills in what they leave out; then the
    // plain defaults. So "use the reviewer role, but in a new workspace" does
    // what it says, and naming nothing but the role takes all of the role.
    let placement = text(&request.input, "placement")
        .or_else(|| role.as_ref().map(|r| r.placement.clone()))
        .unwrap_or_else(|| "here".into());
    let agent = text(&request.input, "agent")
        .and_then(|n| Agent::from_name(&n))
        .or_else(|| {
            role.as_ref()
                .and_then(|r| r.agent.as_deref())
                .and_then(Agent::from_name)
        })
        .unwrap_or(lead.agent);
    if !agent.speaks_a_protocol() {
        bail!("Firetower has no driver for {}", agent.label());
    }
    let name = text(&request.input, "name").or_else(|| role.as_ref().map(|r| r.name.clone()));
    let reason = text(&request.input, "reason").or_else(|| role.as_ref().map(|r| r.does.clone()));
    let prompt = brief(
        &lead,
        &goal,
        text(&request.input, "context").as_deref(),
        role.as_ref(),
    );

    // Built the way the API builds one, so every default and every check that
    // applies to a person starting a session applies here too.
    let shares = match placement.as_str() {
        "here" => true,
        "new" => false,
        other => bail!("placement must be \"here\" or \"new\", not \"{other}\""),
    };
    let req: NewSession = if shares {
        serde_json::from_value(json!({
            "workspaceId": lead.workspace_id,
            "prompt": prompt,
            "agent": agent,
        }))?
    } else {
        // Its own branch, named after the lead's so the two sort together,
        // in the lead's first repository. A lead with nothing checked out
        // gets a child with nothing checked out, which is still a workspace.
        let repo = lead.checkouts.first().and_then(|c| c.repo_id.clone());
        let what = name.clone().unwrap_or_else(|| "child".into());
        let branch = lead
            .branch
            .as_deref()
            .map(|b| format!("{b}-{}", ft_core::slugify(&what)));
        serde_json::from_value(json!({
            "repoId": repo,
            "prompt": prompt,
            "agent": agent,
            "branch": branch,
            "name": format!("{} / {what}", lead.name),
        }))?
    };

    // As the lead's owner: the child runs on their subscription and pushes
    // with their token, exactly as the lead does. There is no other identity
    // a session could borrow, and none is minted here.
    let owner = lead.owner.as_str().to_string();
    let child = create_session_as(
        state.clone(),
        owner.clone(),
        owner,
        req,
        Some(Lineage {
            parent: lead.id.clone(),
            reason,
            req: Some(request.req.clone()),
        }),
    )
    .await
    .map_err(|e| anyhow::anyhow!("{}", e.message))?;

    Ok(started(&child, shares))
}

/// What the child is first told.
///
/// The goal as the task, the context beneath it, the role it is acting as if
/// one was named, and then the two things a child has to know that nobody
/// would think to say: who it is working for, and that handing back is how it
/// reports.
fn brief(
    lead: &Session,
    goal: &str,
    context: Option<&str>,
    role: Option<&crate::roles::Role>,
) -> String {
    let mut text = format!("Task: {goal}");
    if let Some(context) = context {
        text.push_str("\n\nContext:\n");
        text.push_str(context);
    }

    if let Some(role) = role {
        text.push_str(&format!(
            "\n\nYou are acting as the \"{}\" subagent: {}",
            role.name, role.does
        ));
        // In this first cut the tool policy is said, not enforced. An agent
        // told to read-only and reaching for a write still has the tool; a
        // later cut narrows the tools it is launched with.
        if role.tools == "read-only" {
            text.push_str(
                "\n\nThis role is read-only: read, search and report. Do not edit or write \
                 files, do not run commands that change anything, and do not push.",
            );
        }
        if !role.instructions.trim().is_empty() {
            text.push_str("\n\n");
            text.push_str(role.instructions.trim());
        }
    }

    // How to finish, shaped by what the role hands back.
    let finish = match role.map(|r| r.hands_back.as_str()) {
        Some("pr") => {
            "When you are done, open a pull request and end with a short summary naming it."
        }
        Some("branch") => {
            "When you are done, commit and push your branch, and end with a short summary of \
             what is on it."
        }
        _ => {
            "End with a short summary of what you did, what you found, and anything it should \
             look at."
        }
    };
    text.push_str(&format!(
        "\n\nYou were started by another agent — the session \"{}\" — to do this part of its \
         work. It will read what you say when you finish. {finish} You cannot ask the person \
         questions: if something is unclear, say what you assumed and carry on.",
        lead.name
    ));
    text
}

/// The tool's result once a child exists.
fn started(child: &Session, shares_workspace: bool) -> String {
    let place = if shares_workspace {
        "in this workspace, sharing its directory and branch".to_string()
    } else {
        match &child.branch {
            Some(branch) => format!("in a workspace of its own, on branch `{branch}`"),
            None => "in a workspace of its own, with nothing checked out".to_string(),
        }
    };
    format!(
        "Started {} ({}) {place}. It will hand back here when it is done: carry on with what \
         does not depend on it, then end your turn.",
        child.name, child.id
    )
}

/// List, steer or stop the children of the session that asked.
async fn children(state: &AppState, request: &AgentRequest) -> Result<String> {
    let lead = state
        .db
        .session(&request.session_id)
        .await?
        .context("the session that asked no longer exists")?;
    let action = text(&request.input, "action").unwrap_or_else(|| "list".into());
    let mine = state.db.children_of(&lead.id).await?;

    match action.as_str() {
        "list" => {
            if mine.is_empty() {
                return Ok("No children yet. Use spawn to start one.".into());
            }
            Ok(mine.iter().map(describe).collect::<Vec<_>>().join("\n"))
        }
        "steer" | "stop" => {
            let id = text(&request.input, "id").context("`id` says which child")?;
            // Only its own. A session that could reach any session by id
            // would be a session that could reach somebody else's.
            let child = mine
                .iter()
                .find(|c| c.id.as_str() == id)
                .with_context(|| format!("{id} is not a child of this session"))?;
            if child.status == SessionStatus::Ended {
                bail!("{} has ended", child.name);
            }
            if action == "steer" {
                let message =
                    text(&request.input, "message").context("`message` is what to tell it")?;
                // Said as the lead, and marked so: a child reading its own
                // transcript — and whoever is watching it — sees a card from
                // the lead rather than a message that looks like the person's.
                let told = format!(
                    "{}\n\n{message}",
                    relay_marker("steer", &lead.id, &lead.name)
                );
                state
                    .fleet
                    .send_turn(&child.host_id, &child.id, &told, &[])
                    .await?;
                Ok(format!(
                    "Told {} ({}). Its reply arrives here when it hands back.",
                    child.name, child.id
                ))
            } else {
                state.fleet.interrupt(&child.host_id, &child.id).await?;
                Ok(format!(
                    "Stopped the turn {} ({}) was in. What it had done so far stays.",
                    child.name, child.id
                ))
            }
        }
        other => bail!("action must be list, steer or stop, not \"{other}\""),
    }
}

/// One child, as a line the lead can read.
fn describe(child: &Session) -> String {
    let mut line = format!("- {} ({}): {}", child.name, child.id, child.status.label());
    if let Some(branch) = &child.branch {
        line.push_str(&format!(" · branch `{branch}`"));
    }
    if let Some(pr) = &child.pull_request {
        line.push_str(&format!(" · pull request {pr}"));
    }
    if child.status == SessionStatus::NeedsYou {
        line.push_str(" · waiting on the person");
    }
    if let Some(note) = &child.note {
        line.push_str(&format!(" — {note}"));
    }
    line
}

/// What a lead is told when a child hands back.
///
/// The child's last turn in full, capped. Ten children handing back a page
/// each would be the lead's whole context, which is the failure Hermes calls
/// the compression death spiral; over the cap, the head and the tail are kept
/// and the middle says how much was cut. The child's own conversation has all
/// of it, and the lead can open that like anybody.
pub fn hand_back_body(child: &Session, said: Option<&str>, note: Option<&str>) -> String {
    const ROOM: usize = 6000;
    let text = said
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(note)
        .unwrap_or("(it said nothing)");
    let text = if text.chars().count() > ROOM {
        let total = text.chars().count();
        let head: String = text.chars().take(ROOM / 2).collect();
        let tail: String = text.chars().skip(total - ROOM / 2).collect();
        format!(
            "{head}\n\n[… {} characters cut; the child's own conversation has all of it …]\n\n{tail}",
            total - ROOM
        )
    } else {
        text.to_string()
    };

    let mut body = format!(
        "{}\n\n{text}",
        relay_marker("handback", &child.id, &child.name)
    );
    let mut facts = Vec::new();
    if let Some(branch) = &child.branch {
        facts.push(format!("branch `{branch}`"));
    }
    if let Some(pr) = &child.pull_request {
        facts.push(format!("pull request {pr}"));
    }
    if !facts.is_empty() {
        body.push_str(&format!("\n\n({})", facts.join(" · ")));
    }
    body
}

/// Several results held for one lead, as one message.
///
/// One turn rather than one per result: each would start a turn of its own,
/// and the second would land inside the first.
pub fn joined(waiting: Vec<(Option<SessionId>, String)>) -> String {
    waiting
        .into_iter()
        .map(|(_, body)| body)
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(name: &str, said_branch: Option<&str>) -> Session {
        serde_json::from_value(json!({
            "id": "s_child", "owner": "u_kevin", "path": "u/kevin/child", "number": 7,
            "name": name, "title": "Review", "prompt": "Task: review", "agent": "ClaudeCode",
            "size": "Medium", "status": "HandedBack", "hostId": "h_1", "workspaceId": "w_1",
            "branch": said_branch, "createdAt": "2026-10-28T12:00:00Z", "updatedAt": "2026-10-28T12:00:00Z",
        }))
        .unwrap()
    }

    #[test]
    fn a_hand_back_names_the_child_and_carries_its_branch() {
        let body = hand_back_body(
            &child("reviewer", Some("agent/x-reviewer")),
            Some("Two findings."),
            None,
        );
        // The marker the interface keys on to draw a sub-agent card rather
        // than a user bubble: kind, session, name, on the first line.
        assert!(body.starts_with("⟦ft:handback:s_child:reviewer⟧"), "{body}");
        assert!(body.contains("Two findings."));
        assert!(body.ends_with("(branch `agent/x-reviewer`)"), "{body}");
    }

    #[test]
    fn the_relay_marker_survives_a_name_with_spaces_and_a_slash() {
        // "Hello / saluteur" is a real child name: the marker runs the name to
        // the closing bracket, so nothing in it needs escaping.
        let marker = relay_marker(
            "handback",
            &SessionId::from_stored("s_abc"),
            "Hello / saluteur",
        );
        assert_eq!(marker, "⟦ft:handback:s_abc:Hello / saluteur⟧");
    }

    #[test]
    fn a_silent_child_falls_back_to_its_note_and_then_to_saying_so() {
        let noted = hand_back_body(&child("qa", None), Some("   "), Some("47 pass, 1 fail"));
        assert!(noted.contains("47 pass, 1 fail"));
        let mute = hand_back_body(&child("qa", None), None, None);
        assert!(mute.contains("(it said nothing)"));
    }

    #[test]
    fn a_long_hand_back_keeps_its_head_and_tail() {
        // The lead's context is finite and a child's transcript is not. The
        // beginning says what it set out to do, the end says what happened;
        // the middle is what the child's own conversation is for.
        let long: String = (0..2000).map(|i| format!("line {i}\n")).collect();
        let body = hand_back_body(&child("worker", None), Some(&long), None);
        assert!(body.contains("line 0\n"));
        assert!(body.contains("line 1999"));
        assert!(body.contains("characters cut"));
        assert!(body.chars().count() < long.chars().count());
    }

    #[test]
    fn the_brief_tells_the_child_who_it_works_for() {
        let lead = child("rate-limit", None);
        let text = brief(
            &lead,
            "Add a limiter",
            Some("Use the token bucket in api/."),
            None,
        );
        assert!(text.starts_with("Task: Add a limiter"));
        assert!(text.contains("Context:\nUse the token bucket"));
        assert!(text.contains("\"rate-limit\""));
        assert!(text.contains("cannot ask the person"));
        // No role: the plain closing instruction, not a PR or branch one.
        assert!(text.contains("End with a short summary"));
    }

    #[test]
    fn a_role_shapes_the_brief() {
        let lead = child("rate-limit", None);
        let role = crate::roles::Role {
            id: "role_x".into(),
            path: "u/kevin/reviewer".into(),
            name: "reviewer".into(),
            does: "reads a branch and reports problems".into(),
            use_when: String::new(),
            not_when: String::new(),
            hands_back: "summary".into(),
            placement: "here".into(),
            agent: None,
            tools: "read-only".into(),
            instructions: "Report findings as path:line.".into(),
            may_write: true,
            may_share: true,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let text = brief(&lead, "Review it", None, Some(&role));
        assert!(text.contains("acting as the \"reviewer\" subagent"));
        assert!(text.contains("read-only"));
        assert!(text.contains("Report findings as path:line."));

        // A pr role gets the pull-request closing instruction.
        let pr = crate::roles::Role {
            hands_back: "pr".into(),
            tools: "full".into(),
            instructions: String::new(),
            ..role
        };
        let text = brief(&lead, "Implement it", None, Some(&pr));
        assert!(text.contains("open a pull request"), "{text}");
    }

    #[test]
    fn several_results_travel_as_one_message() {
        let one = joined(vec![(None, "first".into()), (None, "second".into())]);
        assert_eq!(one, "first\n\n---\n\nsecond");
    }
}
