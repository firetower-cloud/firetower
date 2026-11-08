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
        "update" => update(state, request).await,
        "plan" => plan(state, request).await,
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
    // lead decides the shape of the work, and with no cap on how many
    // children it starts, depth is the one thing still holding the count
    // down — a tree nobody can see the bottom of is how a handful of
    // workspaces becomes a thousand.
    if lead.parent_id.is_some() {
        bail!("this session is itself a child, and children cannot spawn");
    }

    // Only a Manager delegates. A session started as an Operator profile — or
    // as no profile at all — does the work itself rather than handing it off,
    // which is the whole of what the distinction means. Load the whole profile,
    // not just the flag: its `delegate_scope` decides which subagents it may
    // even see.
    let manager = match &lead.profile_id {
        Some(pid) => {
            state
                .roles
                .one(lead.owner.as_str(), pid, crate::access::Level::Viewer)
                .await?
        }
        None => None,
    };
    if !manager.as_ref().map(|p| p.can_delegate).unwrap_or(false) {
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

    // The subagents this Manager may delegate to: what its owner can see,
    // narrowed to its `delegate_scope` when it has one. An empty scope is "any",
    // which is the default. Everything outside is invisible — a name off this
    // list is refused exactly as a name that was never defined, so an out-of-
    // scope profile reads as *does not exist* rather than *not allowed*.
    let team: Vec<crate::roles::Role> = {
        let visible = state
            .roles
            .visible(lead.owner.as_str(), crate::access::Level::Viewer)
            .await?;
        let scope = manager
            .as_ref()
            .map(|m| &m.delegate_scope)
            .filter(|s| !s.is_empty());
        match scope {
            Some(scope) => visible
                .into_iter()
                .filter(|r| scope.contains(&r.id))
                .collect(),
            None => visible,
        }
    };
    let role = match text(&request.input, "role") {
        Some(wanted) => match team
            .iter()
            .find(|r| r.name.eq_ignore_ascii_case(wanted.trim()))
        {
            Some(found) => Some(found.clone()),
            None => {
                let names: Vec<String> = team.iter().map(|r| r.name.clone()).collect();
                bail!(
                    "no subagent called \"{wanted}\". {}",
                    if names.is_empty() {
                        "No subagents are on this profile's team — widen its scope, or make one \
                         under Configuration → Profiles."
                            .to_string()
                    } else {
                        format!("Subagents you can use: {}.", names.join(", "))
                    }
                );
            }
        },
        None => None,
    };

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
    // The subscription the profile pins for its agent, if it named one;
    // otherwise absent, and the owner's default for the engine resolves at
    // launch, as it does for a person who names no account.
    let account = role.as_ref().and_then(|r| r.account.clone());

    // How the profile pins the agent — model, effort, mode, sandbox. Each unset
    // field resolves to the engine's default at launch, the same as for a
    // person who left the picker alone.
    let settings = role
        .as_ref()
        .map(|r| r.settings.clone())
        .unwrap_or_default();

    // The child's skills: what the profile resolves to for this lead's owner
    // and this lead's checkouts. A delegated child carries its persona in the
    // brief rather than a `profile_id`, so the session layer cannot look the
    // profile up — it is handed the already-resolved set either way, and
    // `start_another_agent` now honours it, which is what makes `here` and
    // `new` deliver the same thing.
    //
    // **Every profile resolves, not only one with a list.** This used to run
    // only when `skill_scope` was non-empty, and to intersect it with the
    // owner's defaults — so a tick could only ever subtract, and an empty
    // intersection handed over `Some(vec![])`, which is honoured as "nothing".
    // A scoped profile could end up strictly worse off than an unscoped one.
    // The switches are part of the answer now, so a profile with an empty list
    // still has one: both on resolves to exactly the owner's defaults, which is
    // what every existing profile gets.
    //
    // An ad-hoc child with no profile still passes nothing and takes the
    // owner's defaults, as before.
    let skills: Option<Vec<String>> = match role.as_ref() {
        Some(r) => {
            let repos: Vec<ft_core::RepoId> = lead
                .checkouts
                .iter()
                .filter_map(|c| c.repo_id.clone())
                .collect();
            Some(
                crate::roles::skills_at_spawn(&state.skills, r, lead.owner.as_str(), &repos)
                    .await?,
            )
        }
        None => None,
    };
    // What the child is called. A child in its own workspace is named
    // `"<lead> / <what>"`, so the two sort together and the interface drops the
    // prefix to show just `what`. A child that *shares* the lead's workspace
    // shares its name too — so there the name becomes the child's session
    // title instead (`start_another_agent` reads it off `name`), which is what
    // tells it apart from the lead; `what` alone, clean, since there is no lead
    // name to strip.
    let what = name.clone().unwrap_or_else(|| "child".into());
    let req: NewSession = if shares {
        serde_json::from_value(json!({
            "workspaceId": lead.workspace_id,
            "prompt": prompt,
            "agent": agent,
            "accountId": account,
            "settings": settings,
            "skills": skills,
            "name": what,
        }))?
    } else {
        // Its own branch, named after the lead's so the two sort together,
        // in the lead's first repository. A lead with nothing checked out
        // gets a child with nothing checked out, which is still a workspace.
        let repo = lead.checkouts.first().and_then(|c| c.repo_id.clone());
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
            "accountId": account,
            "settings": settings,
            "skills": skills,
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
    text.push_str(
        "\n\nWhile you work you may post a short progress note to it with `update` — at a real \
         milestone, not every step, and it does not pause you. Keep it to a line unless it has \
         asked for detail. Save the full account for when you finish.",
    );
    text.push_str(
        "\n\nKeep a short plan as you go — your own todo list if you have one, otherwise `plan`. \
         It is drawn live in the workspace, so whoever is watching can follow what you are on \
         without reading the whole transcript. A handful of steps, one in progress at a time.",
    );
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

/// The plan the agent is keeping, for the person watching the workspace.
///
/// The cross-engine half of the plan: Claude Code's todo list and Codex's own
/// plan already arrive on the turn stream and are what the rail draws, so an
/// agent on either of those need never call this. It is here so an engine with
/// no plan tool of its own can still leave a trail, and so that *every* agent
/// is told — in the tool's description — that its plan is on screen.
///
/// Restated whole each call, like a todo list: this replaces the stored plan.
async fn plan(state: &AppState, request: &AgentRequest) -> Result<String> {
    let steps = request
        .input
        .get("steps")
        .and_then(Value::as_array)
        .context("`steps` is the plan, start to finish")?;
    if steps.len() > 20 {
        bail!(
            "a plan is a handful of steps, not {} — keep it readable",
            steps.len()
        );
    }

    let mut plan = Vec::new();
    for step in steps {
        // A bare string is accepted as well as `{step, status}`: the shape an
        // agent reaches for first should not be a refusal.
        let (what, status) = match step {
            Value::String(what) => (what.clone(), "pending".to_string()),
            _ => (
                text(step, "step").context("each step needs a `step`")?,
                step.get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .to_string(),
            ),
        };
        plan.push(ft_core::turn::PlanStep {
            step: what,
            status: match status.to_ascii_lowercase().as_str() {
                "done" | "completed" | "complete" => ft_core::turn::PlanStepStatus::Completed,
                "doing" | "inprogress" | "in_progress" | "active" => {
                    ft_core::turn::PlanStepStatus::InProgress
                }
                _ => ft_core::turn::PlanStepStatus::Pending,
            },
        });
    }

    state
        .db
        .set_session_plan(&request.session_id, &plan)
        .await?;
    let done = plan
        .iter()
        .filter(|s| s.status == ft_core::turn::PlanStepStatus::Completed)
        .count();
    Ok(format!(
        "Plan saved — {done} of {} done. It is on screen in the workspace; restate it whenever a \
         step starts or finishes.",
        plan.len()
    ))
}

/// A child's progress note to its lead, mid-task.
///
/// The one child→lead message that does not end the child's turn: it drops a
/// note on the same rail a hand-back rides and returns at once, so the child
/// carries on. Only a child may call it, and only its own lead hears it — the
/// note is held and delivered between the lead's turns, several joined into
/// one, exactly as a hand-back is. No caps in this version: how often and how
/// long is the child's judgement, steered by the tool's description and the
/// brief, and bursts cost the lead one message because the rail coalesces.
async fn update(state: &AppState, request: &AgentRequest) -> Result<String> {
    let child = state
        .db
        .session(&request.session_id)
        .await?
        .context("the session that asked no longer exists")?;
    let Some(lead) = child.parent_id.clone() else {
        bail!("only a child reports to a lead, and this session has none — it is the lead");
    };
    let note = text(&request.input, "note").context("`note` is what to tell your lead")?;
    let phase = text(&request.input, "phase");
    let body = update_body(&child, &note, phase.as_deref());

    state
        .db
        .queue_delivery(&lead, Some(&child.id), &body)
        .await?;
    state.fleet.drain_deliveries(&lead).await;
    Ok(format!(
        "Told {}. Carry on — it reads this between its turns.",
        child.name
    ))
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
        // Required now, and left empty when absent so `check` says so plainly
        // rather than a silent default standing in for a decision not made.
        placement: text(input, "placement").unwrap_or_default(),
        agent: text(input, "agent"),
        machine: text(input, "machine"),
        account: None,
        instructions: text(input, "instructions").unwrap_or_default(),
        can_delegate: input
            .get("can_delegate")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        delegate_scope: vec![],
        // **Not settable from here, deliberately.** A tick on `skill_scope`
        // grants a skill rather than filtering one, so an agent that could set
        // it could widen its own children's reach — which is the thing scope
        // exists to prevent — and it names skills by id, which nothing shows
        // it. The two switches default on instead, so a profile an agent
        // writes loads the owner's usual set rather than nothing at all.
        skill_scope: vec![],
        include_always_on: true,
        include_repo_defaults: true,
        settings: Default::default(),
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
        bail!(
            "you cannot file a profile in the \"{}\" directory",
            target.slug
        );
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

/// Why a profile that wants its own workspace cannot be finished from here.
///
/// `placement: "new"` needs the host id of a machine, and nothing shows an
/// agent the host ids — so this is a wall, not a validation slip it can fix by
/// trying again. It used to end as `here`: the person asked for its own
/// workspace, got a shared one, and was told nothing. Refuse instead, in words
/// the agent can repeat to them.
fn machine_it_cannot_pick(new: &crate::roles::NewRole) -> Option<&'static str> {
    let bare = new
        .machine
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty();
    (new.placement == "new" && bare).then_some(
        "a profile whose child gets its own workspace has to name the machine it runs on, and \
         you cannot see the machines — so this one is not yours to finish. Tell them that, and \
         offer either a host id from Settings → Compute → Machines, or `here` for now with the \
         placement changed on Settings → Harness → Profiles. Do not file it as `here` and leave \
         them thinking they got what they asked for.",
    )
}

/// What this tool settled, as the agent reads it back.
///
/// Said whole on purpose. The subscription cannot be set from here and the
/// machine often cannot either, and those are the two things a person names
/// most — so the ack states what landed rather than letting "Created it" stand
/// in for "created it the way you asked".
fn profile_shape(new: &crate::roles::NewRole) -> String {
    format!(
        "{}, {}, {}",
        new.agent.as_deref().unwrap_or("its engine"),
        if new.placement == "new" {
            "its own workspace"
        } else {
            "sharing the lead's workspace"
        },
        if new.can_delegate {
            "a Manager that can delegate to other profiles"
        } else {
            "an Operator that does the work itself"
        },
    )
}

/// Save a new profile for the session's owner.
async fn create_profile(state: &AppState, request: &AgentRequest) -> Result<String> {
    let session = authoring_session(state, request).await?;
    let owner = session.owner.as_str();
    let new = new_role_from(&request.input)?;
    if let Some(why) = machine_it_cannot_pick(&new) {
        bail!("{why}");
    }
    crate::roles::check(&new).map_err(|e| anyhow::anyhow!("{e}"))?;
    let org = state.db.org().await?;
    let (slug, whose) = owner_of(state, &session).await?;
    let id = state.roles.create(&org, owner, &slug, &new).await?;
    let where_it_is = file_profile(state, id.as_str(), &request.input, owner, &whose).await?;
    Ok(format!(
        "Created the \"{}\" profile in {where_it_is} — {}. It runs on the owner's default \
         subscription for that engine: this tool cannot pin a particular one, so if they asked \
         for a subscription, tell them it is unset and set on Settings → Harness → Profiles. \
         It's on the Profiles screen now.",
        new.name.trim(),
        profile_shape(&new),
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
    let get_str =
        |key: &str, now: &str| text(&request.input, key).unwrap_or_else(|| now.to_string());
    let new = crate::roles::NewRole {
        name: get_str("new_name", &existing.name),
        does: get_str("does", &existing.does),
        placement: get_str("placement", &existing.placement),
        agent: text(&request.input, "agent").or(existing.agent.clone()),
        machine: text(&request.input, "machine").or(existing.machine.clone()),
        account: existing.account.clone(),
        instructions: get_str("instructions", &existing.instructions),
        can_delegate: request
            .input
            .get("can_delegate")
            .and_then(Value::as_bool)
            .unwrap_or(existing.can_delegate),
        delegate_scope: existing.delegate_scope.clone(),
        // Carried, not settable — see `new_role_from`. An agent changing a
        // profile must not be able to widen what its children load, nor to
        // quietly switch off a source somebody chose on the Profiles screen.
        skill_scope: existing.skill_scope.clone(),
        include_always_on: existing.include_always_on,
        include_repo_defaults: existing.include_repo_defaults,
        settings: existing.settings.clone(),
        directory: None,
    };
    if let Some(why) = machine_it_cannot_pick(&new) {
        bail!("{why}");
    }
    crate::roles::check(&new).map_err(|e| anyhow::anyhow!("{e}"))?;
    if !state
        .roles
        .update(owner, existing.id.as_str(), &new)
        .await?
    {
        bail!("you cannot change the \"{wanted}\" profile");
    }
    Ok(format!(
        "Updated the \"{}\" profile — {}. Its subscription is untouched: that one is set on \
         Settings → Harness → Profiles, not from here.",
        new.name.trim(),
        profile_shape(&new),
    ))
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
    let description = text(input, "description")
        .context("a skill needs a description — what it does and when to use it")?;
    let body = text(input, "body").unwrap_or_default();
    let mut files = vec![crate::skills::IncomingFile {
        path: "SKILL.md".to_string(),
        contents: ft_proto::encode(compose_skill_md(&name, &description, &body).as_bytes()),
        executable: false,
    }];
    files.extend(
        incoming_files(input)
            .into_iter()
            .filter(|f| f.path != "SKILL.md"),
    );
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
        bail!(
            "you cannot file a skill in the \"{}\" directory",
            target.slug
        );
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
        bail!(
            "\"{}\" is one Firetower ships; it cannot be changed",
            existing.name
        );
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
            let held = if s.held {
                " (held, pending your review)"
            } else {
                ""
            };
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

/// A child's mid-task check-in, marked for its lead.
///
/// Its own relay kind — `update`, not `handback` — so the desktop draws a
/// quiet check-in rather than a result, and the lead still reads which child
/// it is from. No cap on the note: how long it runs is the child's judgement,
/// and a full account belongs in the hand-back, not here.
pub fn update_body(child: &Session, note: &str, phase: Option<&str>) -> String {
    let mut body = format!(
        "{}\n\n{note}",
        relay_marker("update", &child.id, &child.name)
    );
    if let Some(phase) = phase.map(str::trim).filter(|p| !p.is_empty()) {
        body.push_str(&format!("\n\n(phase: {phase})"));
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
    fn an_update_is_marked_as_its_own_kind_and_carries_its_phase() {
        let body = update_body(
            &child("reviewer", None),
            "Repro'd the failing test.",
            Some("building"),
        );
        // Its own kind, so the interface draws a check-in and not a hand-back.
        assert!(body.starts_with("⟦ft:update:s_child:reviewer⟧"), "{body}");
        assert!(body.contains("Repro'd the failing test."));
        assert!(body.ends_with("(phase: building)"), "{body}");
        // A blank phase is dropped rather than drawn as an empty tag.
        let plain = update_body(&child("reviewer", None), "Still going.", Some("  "));
        assert!(!plain.contains("phase:"), "{plain}");
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
            account: None,
            instructions: "Report findings as path:line.".into(),
            can_delegate: false,
            delegate_scope: vec![],
            include_always_on: true,
            include_repo_defaults: true,
            skill_scope: vec![],
            settings: Default::default(),
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

    fn asked_for(placement: &str, machine: Option<&str>) -> crate::roles::NewRole {
        let mut input = json!({
            "name": "QA",
            "does": "runs the suite and reports what broke; after a hand-back",
            "agent": "ClaudeCode",
            "placement": placement,
        });
        if let Some(m) = machine {
            input["machine"] = json!(m);
        }
        new_role_from(&input).unwrap()
    }

    #[test]
    fn its_own_workspace_without_a_machine_is_refused_rather_than_quietly_shared() {
        // The bug this exists for: the person asks for its own workspace, the
        // agent cannot see the host ids, and the profile used to be filed as
        // `here` with nobody told. Now the agent is handed the sentence.
        let why = machine_it_cannot_pick(&asked_for("new", None)).expect("refused");
        assert!(why.contains("cannot see the machines"));
        assert!(why.contains("Machines"));
        assert!(why.contains("Profiles"));
    }

    #[test]
    fn a_machine_the_person_handed_over_is_taken() {
        assert!(machine_it_cannot_pick(&asked_for("new", Some("h_1"))).is_none());
        // Whitespace is not a machine.
        assert!(machine_it_cannot_pick(&asked_for("new", Some("   "))).is_some());
    }

    #[test]
    fn a_shared_workspace_never_needed_a_machine() {
        assert!(machine_it_cannot_pick(&asked_for("here", None)).is_none());
    }

    #[test]
    fn the_ack_says_what_landed_so_silence_cannot_read_as_applied() {
        let shape = profile_shape(&asked_for("here", None));
        assert_eq!(
            shape,
            "ClaudeCode, sharing the lead's workspace, an Operator that does the work itself"
        );
        assert!(profile_shape(&asked_for("new", Some("h_1"))).contains("its own workspace"));
    }
}
