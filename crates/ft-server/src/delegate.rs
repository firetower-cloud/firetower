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
        "create_profile" => create_profile(state, request).await,
        "update_profile" => update_profile(state, request).await,
        "list_profiles" => list_profiles(state, request).await,
        "create_skill" => create_skill(state, request).await,
        "update_skill" => update_skill(state, request).await,
        "list_skills" => list_skills(state, request).await,
        other => bail!("`{other}` is not something a session can ask Firetower for"),
    }
}

/// The session behind a configuration call, refusing one that may not make it.
///
/// Configuring Firetower is the lead's job: a child is doing a piece of work,
/// not setting the place up, and the same flat rule that stops it spawning
/// stops it here. Everything it does runs as this session's owner.
async fn authoring_session(state: &AppState, request: &AgentRequest) -> Result<Session> {
    let session = state
        .db
        .session(&request.session_id)
        .await?
        .context("the session that asked no longer exists")?;
    if session.parent_id.is_some() {
        bail!("this session is itself a child; configuring Firetower is the lead's to do");
    }
    Ok(session)
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

    // Only a Manager delegates. A session started as an Operator profile — or
    // as no profile at all — does the work itself rather than handing it off,
    // which is the whole of what the distinction means.
    let is_manager = match &lead.profile_id {
        Some(pid) => state
            .roles
            .one(lead.owner.as_str(), pid, crate::access::Level::Viewer)
            .await?
            .map(|p| p.can_delegate)
            .unwrap_or(false),
        None => false,
    };
    if !is_manager {
        bail!(
            "this session is not a Manager, so it does the work itself. Start the workspace as a \
             Manager profile to hand work off."
        );
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

    // A role that pins a field enforces it — the lead's own argument does not
    // override it, which is the point of pinning. A role that leaves a field
    // open ("lead" for placement, no agent) hands the choice back: the lead's
    // argument, then the plain default.
    let placement = match role.as_ref().map(|r| r.placement.as_str()) {
        Some("here") => "here".to_string(),
        Some("new") => "new".to_string(),
        _ => text(&request.input, "placement").unwrap_or_else(|| "here".into()),
    };
    let agent = match role
        .as_ref()
        .and_then(|r| r.agent.as_deref())
        .and_then(Agent::from_name)
    {
        Some(pinned) => pinned,
        None => text(&request.input, "agent")
            .and_then(|n| Agent::from_name(&n))
            .unwrap_or(lead.agent),
    };
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
        // The machine the profile pins for its own workspace, if it named one;
        // otherwise absent, and the scheduler picks as it does for a person.
        let host = role.as_ref().and_then(|r| r.machine.clone());
        serde_json::from_value(json!({
            "repoId": repo,
            "prompt": prompt,
            "agent": agent,
            "branch": branch,
            "hostId": host,
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
        if !role.instructions.trim().is_empty() {
            text.push_str("\n\n");
            text.push_str(role.instructions.trim());
        }
    }

    text.push_str(&format!(
        "\n\nYou were started by another agent — the session \"{}\" — to do this part of its \
         work. It will read what you say when you finish. End with a short summary of what you \
         did, what you found, and anything it should look at. You cannot ask the person \
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

/// Build the fields of a profile from a tool call's arguments.
fn new_role_from(input: &Value) -> Result<crate::roles::NewRole> {
    let name = text(input, "name").context("a profile needs a name")?;
    let does = text(input, "does")
        .context("a profile needs a line saying what it does and when to reach for it")?;
    Ok(crate::roles::NewRole {
        name,
        does,
        placement: text(input, "placement").unwrap_or_else(|| "lead".into()),
        agent: text(input, "agent"),
        machine: text(input, "machine"),
        instructions: text(input, "instructions").unwrap_or_default(),
        can_delegate: input
            .get("can_delegate")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        // Resolved and filed separately below: the agent names a directory, not
        // an id, so the service's `directory` field is left out here.
        directory: None,
    })
}

/// File a just-made profile in a named directory, when the agent named one.
///
/// Returns where it ended up, in words for the agent to repeat. The agent says
/// a directory's name; it is resolved, checked that this person may write
/// there, and moved with the same transfer the sharing sheet uses.
async fn file_profile(
    state: &AppState,
    role_id: &str,
    input: &Value,
    owner: &str,
    whose: &str,
) -> Result<String> {
    let Some(name) = text(input, "directory") else {
        return Ok("your own space".into());
    };
    let org = state.db.org().await?;
    let target = state
        .access
        .directory_by_slug(&org, &name)
        .await?
        .with_context(|| format!("there is no directory called \"{name}\" you can file it in"))?;
    let may = matches!(
        state.access.level_on(owner, target.id.as_str()).await?,
        Some(level) if level >= crate::access::Level::Writer
    );
    if !may {
        bail!("you cannot file a profile in the \"{}\" directory", target.slug);
    }
    let from = state
        .access
        .path_of(crate::access::FiledKind::Role, role_id)
        .await?
        .context("the profile that was just made could not be found to file it")?;
    state
        .access
        .transfer(
            &state.vault,
            crate::access::FiledKind::Role,
            role_id,
            &from.moved_to(ft_core::path::DIRECTORY, &target.slug),
            whose,
        )
        .await?;
    Ok(format!("the \"{}\" directory", target.slug))
}

/// The slug and username of a session's owner, for filing and the vault log.
async fn owner_of(state: &AppState, session: &Session) -> Result<(String, String)> {
    let owner = session.owner.as_str();
    let slug = state.access.personal_root(owner).await?;
    let whose = session.owner_name.clone().unwrap_or_else(|| slug.clone());
    Ok((slug, whose))
}

/// Save a new profile for the session's owner.
async fn create_profile(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let owner = session.owner.as_str();
    let new = new_role_from(&request.input)?;
    crate::roles::check(&new).map_err(|e| anyhow::anyhow!("{e}"))?;
    let org = state.db.org().await?;
    let (slug, whose) = owner_of(state, &session).await?;
    let id = state.roles.create(&org, owner, &slug, &new).await?;
    let where_it_is = file_profile(state, id.as_str(), &request.input, owner, &whose).await?;
    Ok(format!(
        "Created the \"{}\" profile in {where_it_is}. It's on the Profiles screen now — start a \
         workspace as it, or {}.",
        new.name.trim(),
        if new.can_delegate {
            "have a lead delegate to it"
        } else {
            "a Manager can delegate to it"
        }
    ))
}

/// Change a profile the session's owner may write, by name.
async fn update_profile(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let owner = session.owner.as_str();
    let wanted = text(&request.input, "name").context("name the profile to change")?;
    let existing = state
        .roles
        .by_name(owner, &wanted)
        .await?
        .with_context(|| format!("you have no profile called \"{wanted}\""))?;
    // Only what was named changes; everything else stays as it is.
    let get_str = |key: &str, now: &str| text(&request.input, key).unwrap_or_else(|| now.to_string());
    let new = crate::roles::NewRole {
        name: get_str("new_name", &existing.name),
        does: get_str("does", &existing.does),
        placement: get_str("placement", &existing.placement),
        agent: text(&request.input, "agent").or(existing.agent.clone()),
        machine: text(&request.input, "machine").or(existing.machine.clone()),
        instructions: get_str("instructions", &existing.instructions),
        can_delegate: request
            .input
            .get("can_delegate")
            .and_then(Value::as_bool)
            .unwrap_or(existing.can_delegate),
        directory: None,
    };
    crate::roles::check(&new).map_err(|e| anyhow::anyhow!("{e}"))?;
    if !state.roles.update(owner, existing.id.as_str(), &new).await? {
        bail!("you cannot change the \"{wanted}\" profile");
    }
    Ok(format!("Updated the \"{}\" profile.", new.name.trim()))
}

/// The profiles the session's owner can see, so the agent builds on them.
async fn list_profiles(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let roles = state
        .roles
        .visible(session.owner.as_str(), crate::access::Level::Viewer)
        .await?;
    if roles.is_empty() {
        return Ok("There are no profiles yet.".into());
    }
    let lines: Vec<String> = roles
        .iter()
        .map(|r| {
            format!(
                "- {}{}: {}",
                r.name,
                if r.can_delegate { " (Manager)" } else { "" },
                r.does
            )
        })
        .collect();
    Ok(format!("The profiles you can see:\n{}", lines.join("\n")))
}

// ── skills ──────────────────────────────────────────────────────────────
//
// The same road as the profile tools, with `state.skills` in place of
// `state.roles`. The one difference a skill carries that a profile does not is
// an executable: a `scripts/` file lands `0o755` on a session's disk and runs.
// So a skill the agent writes that ships one is created **held** — in the
// library, badged, but materialised nowhere — until the owner approves it. The
// control plane decides that here, from the bundle, not from anything the agent
// asserts.

/// Whether a bundle ships anything that runs, which is what holds it for review.
fn ships_an_executable(files: &[crate::skills::IncomingFile]) -> bool {
    files
        .iter()
        .any(|f| f.executable || f.path.starts_with("scripts/"))
}

/// Compose a SKILL.md from the pieces an agent sends as plain text.
///
/// The frontmatter is written here rather than trusted from the agent, so the
/// name and description the library reads are the ones the checks saw. A body
/// that arrived with its own frontmatter has it stripped first, so the file
/// never ends up with two.
fn compose_skill_md(name: &str, description: &str, body: &str) -> String {
    let (_, clean, _) = crate::skills::read_frontmatter(body);
    let description = description.replace(['\r', '\n'], " ");
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        name.trim(),
        description.trim(),
        clean.trim()
    )
}

/// The bundled files an agent sent, as `scripts/`, `references/`, `assets/`.
/// Contents arrive as plain text — natural for an agent to write — and are
/// encoded here into the form the library stores.
fn incoming_files(input: &Value) -> Vec<crate::skills::IncomingFile> {
    input
        .get("files")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let path = f.get("path").and_then(Value::as_str)?.to_string();
                    let contents = f.get("contents").and_then(Value::as_str).unwrap_or("");
                    Some(crate::skills::IncomingFile {
                        path,
                        contents: ft_proto::encode(contents.as_bytes()),
                        executable: f
                            .get("executable")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Build the whole bundle from a `create_skill` call.
fn new_skill_from(input: &Value) -> Result<crate::skills::NewSkill> {
    let name = text(input, "name").context("a skill needs a name")?;
    let description =
        text(input, "description").context("a skill needs a description — what it does and when to use it")?;
    let body = text(input, "body").unwrap_or_default();
    let mut files = vec![crate::skills::IncomingFile {
        path: "SKILL.md".to_string(),
        contents: ft_proto::encode(compose_skill_md(&name, &description, &body).as_bytes()),
        executable: false,
    }];
    files.extend(incoming_files(input).into_iter().filter(|f| f.path != "SKILL.md"));
    Ok(crate::skills::NewSkill {
        frontmatter: serde_json::json!({ "name": name, "description": description }),
        body,
        name,
        description,
        files,
        notes: None,
    })
}

/// File a just-made skill in a named directory, when the agent named one. The
/// same transfer the sharing sheet uses — see [`file_profile`].
async fn file_skill(
    state: &AppState,
    skill_id: &str,
    input: &Value,
    owner: &str,
    whose: &str,
) -> Result<String> {
    let Some(name) = text(input, "directory") else {
        return Ok("your own space".into());
    };
    let org = state.db.org().await?;
    let target = state
        .access
        .directory_by_slug(&org, &name)
        .await?
        .with_context(|| format!("there is no directory called \"{name}\" you can file it in"))?;
    let may = matches!(
        state.access.level_on(owner, target.id.as_str()).await?,
        Some(level) if level >= crate::access::Level::Writer
    );
    if !may {
        bail!("you cannot file a skill in the \"{}\" directory", target.slug);
    }
    let from = state
        .access
        .path_of(crate::access::FiledKind::Skill, skill_id)
        .await?
        .context("the skill that was just made could not be found to file it")?;
    state
        .access
        .transfer(
            &state.vault,
            crate::access::FiledKind::Skill,
            skill_id,
            &from.moved_to(ft_core::path::DIRECTORY, &target.slug),
            whose,
        )
        .await?;
    Ok(format!("the \"{}\" directory", target.slug))
}

/// Save a new skill for the session's owner.
async fn create_skill(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let owner = session.owner.as_str();
    let new = new_skill_from(&request.input)?;
    crate::skills::check(&new).map_err(|e| anyhow::anyhow!("{e}"))?;

    if let Some(existing) = state.skills.by_name(owner, &new.name).await? {
        bail!(
            "you already have a skill called \"{}\" — change it with update_skill, \
             or give this one a name of its own",
            existing.name
        );
    }

    let hold = ships_an_executable(&new.files);
    let org = state.db.org().await?;
    let (slug, whose) = owner_of(state, &session).await?;
    let id = state.skills.create(&org, owner, &slug, &new, hold).await?;
    let where_it_is = file_skill(state, id.as_str(), &request.input, owner, &whose).await?;

    if hold {
        Ok(format!(
            "Wrote the \"{}\" skill into {where_it_is} — but it ships a script, so it's held \
             for your review. Open it on the Skills screen, read what it runs, and approve it; \
             it runs nowhere until you do.",
            new.name.trim()
        ))
    } else {
        Ok(format!(
            "Created the \"{}\" skill in {where_it_is}. It's on the Skills screen now, ready to \
             turn on for a workspace.",
            new.name.trim()
        ))
    }
}

/// Change a skill the session's owner may write, by name. A change to the
/// instructions is a new version; the folder's other files carry forward
/// unless the call sends a new set.
async fn update_skill(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let owner = session.owner.as_str();
    let wanted = text(&request.input, "name").context("name the skill to change")?;
    let existing = state
        .skills
        .by_name(owner, &wanted)
        .await?
        .with_context(|| format!("you have no skill called \"{wanted}\""))?;
    if existing.builtin {
        bail!("\"{}\" is one Firetower ships; it cannot be changed", existing.name);
    }
    if existing.version == 0 {
        bail!(
            "\"{}\" is still waiting for your review — approve or discard it first",
            existing.name
        );
    }

    let detail = state
        .skills
        .detail(owner, existing.id.as_str())
        .await?
        .context("the skill to change could not be read")?;
    let old_description = detail
        .frontmatter
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or(&existing.description)
        .to_string();

    let name = text(&request.input, "new_name").unwrap_or_else(|| existing.name.clone());
    let description = text(&request.input, "description").unwrap_or(old_description);
    let body = text(&request.input, "body").unwrap_or(detail.body);

    // The other files: a fresh set if the call sent one, otherwise the ones
    // the current version already holds, carried forward unchanged.
    let carried = if request.input.get("files").is_some() {
        incoming_files(&request.input)
    } else {
        state
            .skills
            .files_with_contents(existing.version_id.as_str())
            .await?
    };
    let mut files = vec![crate::skills::IncomingFile {
        path: "SKILL.md".to_string(),
        contents: ft_proto::encode(compose_skill_md(&name, &description, &body).as_bytes()),
        executable: false,
    }];
    files.extend(carried.into_iter().filter(|f| f.path != "SKILL.md"));

    let new = crate::skills::NewSkill {
        frontmatter: serde_json::json!({ "name": name, "description": description }),
        body,
        name: name.clone(),
        description,
        files,
        notes: None,
    };
    crate::skills::check(&new).map_err(|e| anyhow::anyhow!("{e}"))?;

    let hold = ships_an_executable(&new.files);
    state
        .skills
        .add_version(existing.id.as_str(), owner, &new, hold)
        .await?;
    if hold {
        Ok(format!(
            "Wrote a new version of \"{}\" — it ships a script, so it's held for your review on \
             the Skills screen. What's running now is unchanged until you approve it.",
            name.trim()
        ))
    } else {
        Ok(format!("Updated the \"{}\" skill.", name.trim()))
    }
}

/// The skills the session's owner can see, so the agent builds on them.
async fn list_skills(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let skills = state
        .skills
        .visible(session.owner.as_str(), crate::access::Level::Viewer)
        .await?;
    if skills.is_empty() {
        return Ok("There are no skills yet.".into());
    }
    let lines: Vec<String> = skills
        .iter()
        .map(|s| {
            let scripts = if s.risk.iter().any(|r| r == "scripts") {
                " (ships a script)"
            } else {
                ""
            };
            let held = if s.held { " (held, pending your review)" } else { "" };
            format!("- {}{}{}: {}", s.name, scripts, held, s.description)
        })
        .collect();
    Ok(format!("The skills you can see:\n{}", lines.join("\n")))
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
            placement: "here".into(),
            agent: None,
            machine: None,
            instructions: "Report findings as path:line.".into(),
            can_delegate: false,
            may_write: true,
            may_share: true,
            is_default: false,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        };
        let text = brief(&lead, "Review it", None, Some(&role));
        assert!(text.contains("acting as the \"reviewer\" subagent"));
        assert!(text.contains("reads a branch and reports problems"));
        assert!(text.contains("Report findings as path:line."));
        // The closing instruction is the plain summary one — a role no longer
        // swaps it for a PR or branch variant.
        assert!(text.contains("End with a short summary"));
    }

    #[test]
    fn several_results_travel_as_one_message() {
        let one = joined(vec![(None, "first".into()), (None, "second".into())]);
        assert_eq!(one, "first\n\n---\n\nsecond");
    }
}
