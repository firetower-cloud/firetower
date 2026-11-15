//! Answering the question "may I run this?".
//!
//! An agent running headless has nobody at a keyboard, so it is given a tool to
//! ask instead. This is that tool: a small MCP server the agent starts for
//! itself, which does nothing but carry one question to somebody who can answer
//! it and carry the answer back.
//!
//! It is a separate process because the agent spawns it — we do not get to
//! choose. What it has that nothing else in that process tree does is the
//! session's socket, which is how a question reaches a browser and how an
//! answer comes back. The wait has no timeout on purpose: the person being
//! asked may be asleep, and an agent that gave up and denied would be worse
//! than one that waited.
//!
//! ## What the agent expects
//!
//! Verified against a real run rather than inferred. The call arrives as an
//! ordinary MCP `tools/call`:
//!
//! ```json
//! { "name": "approve",
//!   "arguments": { "tool_name": "Write",
//!                  "input": { "file_path": "…", "content": "…" },
//!                  "tool_use_id": "toolu_…" } }
//! ```
//!
//! and the reply is a tool result whose text is a JSON-encoded decision —
//! `{"behavior":"allow","updatedInput":{…}}` or
//! `{"behavior":"deny","message":"…"}`. A denial reaches the agent verbatim,
//! which is why it is worth asking somebody for a reason.
//!
//! ## One thing to know when it seems not to fire
//!
//! Permission *rules* are evaluated before this tool is consulted, so a call
//! already covered by an allow rule in the host's own configuration never
//! arrives here at all. That is correct — somebody allowed it — but it does
//! mean a card that never appears is not necessarily a card that is broken.

use std::collections::HashSet;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::agentd::{AgentClient, FromAgent, ToAgent};

/// What the agent calls this server. Must match the launch flags.
pub const SERVER: &str = "firetower";
pub const TOOL: &str = "approve";

/// Start another agent for part of the task, as a child of this session.
///
/// Served here rather than by a server of its own because this process is the
/// one thing in the agent's tree that already has the session's socket, and a
/// second process would need the same socket for the same reason.
pub const SPAWN: &str = "spawn";
/// List, steer or stop the children this session started.
pub const CHILDREN: &str = "children";
/// A child's short progress note to its lead, posted without ending its turn.
pub const UPDATE: &str = "update";
/// The plan the agent is keeping, drawn live in the workspace.
pub const PLAN: &str = "plan";
/// Save a reusable agent profile, so a person can ask for one in words rather
/// than filling the form in by hand.
pub const CREATE_PROFILE: &str = "create_profile";
/// Change a saved profile, by name.
pub const UPDATE_PROFILE: &str = "update_profile";
/// List the saved profiles, so the agent builds on them rather than beside.
pub const LIST_PROFILES: &str = "list_profiles";
/// The whole of one profile, enough to reproduce it.
pub const GET_PROFILE: &str = "get_profile";
/// What can run a child, and where: machines, engines and subscriptions, as
/// one answer rather than three lists to correlate.
pub const LIST_COMPUTE: &str = "list_compute";
/// Write a skill into the person's library, so they can ask for one in words
/// rather than hand-copying a folder into the editor.
pub const CREATE_SKILL: &str = "create_skill";
/// Change a saved skill, by name — a new version of its instructions.
pub const UPDATE_SKILL: &str = "update_skill";
/// List the saved skills, so the agent builds on them rather than beside.
pub const LIST_SKILLS: &str = "list_skills";
/// Propose work on a clock, for a person to approve. **It never runs until
/// they do** — the same rule `create_skill` applies to a bundle that ships a
/// script.
pub const PROPOSE_SCHEDULE: &str = "propose_schedule";
/// List the schedules the person has, so a proposal builds on them rather than
/// duplicating one.
pub const LIST_SCHEDULES: &str = "list_schedules";
/// Stop a schedule's future runs. An agent may pause one; it may not turn one
/// back on, which is the asymmetry — stopping is safe and starting is the act
/// that needs a person.
pub const PAUSE_SCHEDULE: &str = "pause_schedule";

/// What a delegation call is named on its way to the control plane.
///
/// It travels the path a permission question takes — the socket, then the
/// worker's `AgentAsks` frame — because that path already exists and already
/// carries an id, a name and some arguments to somebody who can answer. The
/// prefix is what tells the control plane this is a call to act on rather than
/// a question to put to a person, and it cannot collide with a real tool's
/// permission name, which the agent spells `mcp__firetower__spawn`.
pub const DELEGATION: &str = "firetower:";

/// The full name the agent uses, which is how MCP addresses any tool.
pub fn tool_name() -> String {
    format!("mcp__{SERVER}__{TOOL}")
}

/// What `spawn` and `children` do, as the agent reads it.
///
/// The one place the agent learns delegation exists, so it carries the rules
/// rather than pointing at them: when to use which placement, that a result
/// arrives between turns, and what a child may not do.
const SPAWN_DESCRIPTION: &str = "\
Start another agent to work on part of this task, as a child of this session. \
It gets its own conversation and knows nothing of yours: put everything it \
needs in `goal` and `context`. \
`placement: \"here\"` starts it in this workspace, sharing the directory and \
the branch — cheap, and right for a reviewer or a second pair of eyes on what \
you are doing. `placement: \"new\"` gives it a workspace and a branch of its \
own, cut from the repository's default branch, for independent work. \
Returns the child's id and name at once; the child takes its own time. \
Its result arrives in THIS conversation as a message when it hands back — \
between your turns, never inside one — so dispatch, do what does not depend \
on it, then end your turn with a one-line status. \
A child cannot spawn, cannot ask the person, and cannot message or schedule. \
A question it has comes to you as a message; a command it needs permission \
for goes to the person. There is no cap on how many you start or how many run \
at once — dispatch what the work actually needs, and no more, since each one \
costs tokens and a workspace.";

/// What `list_compute` answers, and — as much of the point — when not to ask.
///
/// A Manager handed a quota table and a fleet list will shop around: it will
/// spend a turn choosing between machines that are all fine, and another
/// explaining the choice. So the anti-trigger is first and said plainly, the
/// way a skill's description carries one.
const LIST_COMPUTE_DESCRIPTION: &str = "\
What can run a child, and where: every machine you can put one on, which \
engines are installed on each, and which subscriptions you could spend on \
each engine, with what is left of their allowance. \
**You usually do not need this.** A child runs on your own engine and on \
whichever machine Firetower picks unless you say otherwise, Firetower only \
picks a machine the engine is installed on, and the subscription resolves to \
the owner's default. Reach for this only when the person asked for a \
particular engine, machine or subscription, or when a spawn was refused and \
you need to know what to ask for instead — not before every spawn, and not to \
choose between machines that are all fine. \
Everything it returns is **the last thing each machine reported**, not a live \
check: an allowance on a subscription nothing has run on for a week is a week \
old, and the age is on every line so you can tell. Readiness is per machine — \
an engine installed on one and not another is a failed start on the second, \
not a slower one. \
Pass `role` (and `placement`, if you know it) and the answer is scoped to the \
one machine that child would actually run on.";

const CHILDREN_DESCRIPTION: &str = "\
The children this session started. `list` says what each is doing and \
whether it is waiting on someone. `steer` sends `message` into one child's \
conversation mid-run, without stopping it. `stop` ends the turn a child is \
in; what it has done so far stays. `switch` moves a child that has run out of \
allowance onto another subscription and carries it on from where it stopped. \
ONLY WHEN A LIMIT ACTUALLY STOPPED IT — `list` says so, and a child still \
working on a subscription that merely looks close to its limit must be left \
alone; moving it spends somebody else's allowance to solve a problem that has \
not happened. Read the limits in `list_compute` before you choose, and do not \
move it onto an account that is itself blocked or whose reading is old enough \
to be worth doubting — `list_compute` gives the age of every one. A child \
whose profile says to wait for a person is refused, and so is a subscription \
on another engine unless its profile allows that too.";

/// What `update` does, as a child reads it. Only a child may call it — the
/// control plane refuses it from a lead — so the text speaks to a child
/// directly, and carries the rhythm the way spawn's and children's do.
/// What `get_profile` is for, and — the harder half — what it is not for.
///
/// The anti-trigger carries the weight `list_compute`'s does. Reading one
/// profile costs a round trip and a page of text, and the question an agent
/// most often has is "what profiles exist", which the index answers for a
/// line each. Without this said, the cheap call is the one that stops being
/// made.
const GET_PROFILE_DESCRIPTION: &str = "\
Everything one saved profile is, by name — what it does, where and how its \
children run, what it loads, who it may hand work to, and its full \
instructions. Reach for it when somebody asks to COPY a profile, to make one \
\"like\" another, or to change one in a way that depends on what it already \
says: every value it reports can be passed straight back to `create_profile` \
or `update_profile`. NOT for finding out which profiles exist or what one is \
roughly for — that is `list_profiles`, which answers for every profile at \
once and costs a line each. Reading ten profiles one at a time to pick one is \
the mistake this warns against. Two things it reports that NO tool can write: \
the subscription and whether the profile is the person's default. Both are \
named in the answer; when you copy a profile, say which of them did not come \
with it rather than letting the person assume the copy is identical.";

const UPDATE_DESCRIPTION: &str = "\
Post a short progress note to the agent that started you — your lead — while \
you keep working. Use it at a real milestone: a plan settled, a surprise \
found, a phase finished. It does NOT pause you, and it is NOT a way to ask a \
blocking question — it is one-way, and the lead reads it between its own \
turns. Keep a casual check-in to a line or two; go longer only when the lead \
has asked you for detail. If you are truly blocked and cannot go on without an \
answer, hand back instead.";

/// What `plan` does, as the agent reads it.
///
/// This description is also where every agent — on any engine, in any session —
/// is told that its plan is on screen. An agent whose engine keeps its own todo
/// list never has to call this; being told the list is watched is the point.
const PLAN_DESCRIPTION: &str = "\
Keep a short plan of what you are doing, drawn live in the workspace so the \
person watching can follow without reading the whole transcript. \
IF YOUR ENGINE HAS ITS OWN TODO OR PLAN TOOL, USE THAT INSTEAD — it already \
feeds the same panel, and this exists for engines that have none. \
Restate the whole plan each call, like a todo list: 3-8 steps, one \
`doing` at a time, the rest `pending` or `done`. Update it when a step starts \
or finishes. It does not pause you and nobody is asked to approve it.";

/// The configuration file that tells an agent to start this.
pub fn mcp_config(exe: &std::path::Path, session_id: &str, workspace: &std::path::Path) -> Value {
    json!({
        "mcpServers": {
            SERVER: {
                "command": exe.display().to_string(),
                // The workspace is named rather than inherited. This process is
                // started by the agent, so its working directory is the agent's
                // business and not something to build a file path on.
                "args": [
                    "mcp-approve",
                    "--session", session_id,
                    "--workspace", workspace.display().to_string(),
                ],
            }
        }
    })
}

/// Serve the permission tool until the agent closes our input.
///
/// Speaks JSON-RPC over stdin and stdout, which is what MCP is. Nothing may be
/// written to stdout except a response: that stream is the protocol.
pub async fn serve(session_id: &str, workspace: &std::path::Path) -> Result<()> {
    // What somebody has stopped being asked about.
    //
    // Held here rather than only written to the workspace's settings, because
    // an agent reads those once when it starts: a rule written half way through
    // a session has no effect on it, so "always" would have meant "from the
    // next session onwards" — and the second identical call would have asked
    // again, which is precisely the thing the button says it is for.
    let settled: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));

    let stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();
    let mut lines = BufReader::new(stdin).lines();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(request) = serde_json::from_str::<Value>(line) else {
            continue;
        };

        let Some(response) = answer(&request, session_id, workspace, &settled).await else {
            // A notification. No reply, by definition.
            continue;
        };

        let mut bytes = serde_json::to_vec(&response)?;
        bytes.push(b'\n');
        stdout.write_all(&bytes).await?;
        stdout.flush().await?;
    }
    Ok(())
}

/// One request, answered. `None` for a notification, which takes no reply.
async fn answer(
    request: &Value,
    session_id: &str,
    workspace: &std::path::Path,
    settled: &Arc<Mutex<HashSet<String>>>,
) -> Option<Value> {
    let method = request.get("method")?.as_str()?;
    let id = request.get("id").cloned();

    match method {
        "initialize" => Some(reply(
            id?,
            json!({
                // Echoed rather than asserted: the agent picks the version and
                // we have nothing to say about it.
                "protocolVersion": request
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("2025-06-18"),
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
            }),
        )),

        "tools/list" => {
            // Built from the agents Firetower can drive, not spelled out here,
            // so the list the lead is offered never falls behind the ones that
            // exist — the whole of `Agent::all()`, labels and names together.
            let agent_names: Vec<String> = ft_core::Agent::all()
                .iter()
                .map(|a| format!("{a:?}"))
                .collect();
            let agent_labels = ft_core::Agent::all()
                .iter()
                .map(|a| a.label())
                .collect::<Vec<_>>()
                .join(", ");
            let agent_desc = format!(
                "Which agent runs it — one of {agent_labels}. NOT a saved subagent — use \
                 `role` for that. Omit for the same as you, which is almost always right. \
                 Ignored where the profile pins an engine; a name no engine has is refused \
                 rather than quietly replaced with yours."
            );
            Some(reply(
                id?,
                json!({
                    "tools": [{
                        "name": TOOL,
                        "description": "Decide whether a tool call may proceed.",
                        // Deliberately open. The shape is the agent's to choose and
                        // it has changed before; refusing an argument we did not
                        // expect would block the call rather than ask about it.
                        "inputSchema": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": true,
                        },
                    }, {
                        "name": SPAWN,
                        "description": SPAWN_DESCRIPTION,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "goal": {
                                    "type": "string",
                                    "description": "What the child should accomplish. Self-contained: it has not seen this conversation.",
                                },
                                "context": {
                                    "type": "string",
                                    "description": "Background it needs: file paths, constraints, what has been tried, what to hand back.",
                                },
                                "role": {
                                    "type": "string",
                                    "description": "A saved subagent to start, by name — e.g. \"reviewer\" or \"developer\" (what the person defines on the Agent profiles screen). It supplies the instructions, and it either commits to an engine, a machine and a placement or leaves any of them open. Where it commits to one, that is binding and your argument for that field is not used; where it leaves one open, `agent`, `machine` and `placement` are yours to answer. Naming a profile that does not exist is refused with the ones that do. Omit for an ad-hoc child.",
                                },
                                "placement": {
                                    "type": "string",
                                    "enum": ["here", "new"],
                                    "description": "\"here\" shares this workspace and branch; \"new\" gets its own. Default \"here\".",
                                },
                                "agent": {
                                    "type": "string",
                                    "enum": agent_names,
                                    "description": agent_desc,
                                },
                                "machine": {
                                    "type": "string",
                                    "description": "Which machine its own workspace runs on, by host id from `list_compute`. Only for `placement: \"new\"`, and only when the profile pins no machine. Omit unless they asked for a particular machine — Firetower picks one that can run the engine, which is almost always the right answer.",
                                },
                                "account": {
                                    "type": "string",
                                    "description": "Which subscription it spends, by account id from `list_compute`. Omit for the owner's default for whatever engine it runs, which is almost always the right answer. An account belongs to one engine; naming one for another is refused.",
                                },
                                "name": {
                                    "type": "string",
                                    "description": "A short name for the child, like \"reviewer\" or \"developer\".",
                                },
                                "reason": {
                                    "type": "string",
                                    "description": "One line on why this is being delegated. Shown on the child.",
                                },
                            },
                            "required": ["goal"],
                        },
                    }, {
                        "name": CHILDREN,
                        "description": CHILDREN_DESCRIPTION,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "action": { "type": "string", "enum": ["list", "steer", "stop", "switch"] },
                                "id": {
                                    "type": "string",
                                    "description": "The child's session id, from spawn or list. For steer, stop and switch.",
                                },
                                "message": {
                                    "type": "string",
                                    "description": "For steer: what to tell the child. Lands in its conversation as a message from you.",
                                },
                                "account": {
                                    "type": "string",
                                    "description": "For switch: which subscription to move the child onto, by account id from `list_compute`. It must be one the child's profile allows — same engine, unless that profile allows an engine change as well.",
                                },
                            },
                            "required": ["action"],
                        },
                    }, {
                        "name": UPDATE,
                        "description": UPDATE_DESCRIPTION,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "note": {
                                    "type": "string",
                                    "description": "What's happening, in your words. A line or two for a casual check-in; longer only if the lead has asked for detail.",
                                },
                                "phase": {
                                    "type": "string",
                                    "description": "Optional one-word stage, e.g. \"planning\", \"building\", \"reviewing\". Shown as a tag.",
                                },
                            },
                            "required": ["note"],
                        },
                    }, {
                        "name": PLAN,
                        "description": PLAN_DESCRIPTION,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "steps": {
                                    "type": "array",
                                    "description": "The whole plan, in order. Each item is {step, status} with status one of \"pending\", \"doing\", \"done\" — or a bare string, which is taken as pending.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "step": { "type": "string", "description": "What this step is, in a few words." },
                                            "status": { "type": "string", "enum": ["pending", "doing", "done"] },
                                        },
                                        "required": ["step"],
                                    },
                                },
                            },
                            "required": ["steps"],
                        },
                    }, {
                        "name": CREATE_PROFILE,
                        "description": "Save a reusable agent profile — a persona a workspace can be started as, or a lead can delegate to. Each of the three things a profile says about where it runs — the engine, the placement, and the machine for its own workspace — is either a commitment or left open for whichever lead delegates to it. Unless they have already said otherwise, AGREE ON THE SHAPE BEFORE YOU CALL THIS — don't silently assume. In one short, plain-language exchange, put the choices to them with a recommended default each, and let them correct you: (1) what it does and when to reach for it; (2) its goal and how it should work (the instructions); (3) Operator or Manager — may it hand work to other profiles, and if so which; (4) which engine it runs on, or open so each child runs on its lead's; (5) placement — the lead's own workspace (`here`), one of its own (`new`), or open so the lead decides; (6) kept yours, or filed in a directory a teammate can reach. LEAVING A FIELD OPEN IS THE DEFAULT, not a gap: omit `agent` and `placement` unless they asked for something particular, and a child then runs wherever and however its lead does. You CAN set its run settings, the skills it loads, a Manager's team, and what a lead may do if a child runs out — `get_profile` reports all of them for a profile you are copying. TWO THINGS YOU CANNOT SET: the subscription — a profile that pins an engine runs on the owner's default for it, and one that leaves the engine open has none to set — and whether it is the person's default for new workspaces, because setting one unsets another. If they asked for either, create the profile and then SAY YOU COULD NOT APPLY IT and that it is set on Settings → Harness → Profiles — never let silence read as \"applied\". Take anything they already specified and don't re-ask it. Then call this once. It appears on the Profiles screen immediately, theirs to edit or delete. Check `list_profiles` first so you refine an existing one rather than duplicate it.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "What it's called and started by, e.g. \"QA\" or \"Reviewer\"." },
                                "does": { "type": "string", "description": "One line: what it does AND when to reach for it — like a skill's description. A lead reads this to decide whether to hand it work, so include the trigger (\"after a developer hands back\") and any anti-trigger (\"not for a one-line fix\"). e.g. \"Reviews a finished branch and reports problems; use after a hand-back, not for trivial diffs.\"" },
                                "instructions": { "type": "string", "description": "The persona, as markdown — how it should work, step by step. Composed into the agent's prompt once it's chosen (the body, not the when-to-use line)." },
                                "agent": { "type": "string", "enum": ["ClaudeCode", "Codex", "KimiCode", "CursorAgent"], "description": "The engine it runs on. Omit to leave it open: every child then runs on whatever its lead is running, or on the engine the lead names." },
                                "placement": { "type": "string", "enum": ["lead", "here", "new"], "description": "Where a delegated child runs: `here` shares the lead's workspace and branch, `new` gets its own, `lead` (the default) leaves it to whichever lead delegates." },
                                "machine": { "type": "string", "description": "The host id of the machine its own workspace runs on, for a profile that wants a particular one. Omit to leave it open, and Firetower picks a machine that can run the engine — which is the right answer unless they named a machine. `list_compute` lists the host ids." },
                                "can_delegate": { "type": "boolean", "description": "true makes it a Manager that can hand work to other profiles; false (default) an Operator that does the work itself." },
                                "settings": { "type": "object", "description": "How it runs its engine, each optional: `model`, `effort`, `mode`, `sandbox`. Only for a profile that pins `agent` — these belong to one engine. A value the engine does not offer is refused, listing the ones it does.",
                                    "properties": {
                                        "model": { "type": "string" },
                                        "effort": { "type": "string" },
                                        "mode": { "type": "string" },
                                        "sandbox": { "type": "string" },
                                    },
                                },
                                "skill_scope": { "type": "array", "items": { "type": "string" }, "description": "Skills this profile loads on top of the two switches below, BY NAME as `list_skills` shows them. A name the person cannot reach is refused, naming it." },
                                "delegate_scope": { "type": "array", "items": { "type": "string" }, "description": "For a Manager: the profiles it may hand work to, BY NAME as `list_profiles` shows them. Empty means any profile its owner can reach. A name that does not resolve is refused, naming it." },
                                "include_always_on": { "type": "boolean", "description": "Load the owner's always-on skills. Default true." },
                                "include_repo_defaults": { "type": "boolean", "description": "Load the owner's defaults for the repositories the child checks out. Default true." },
                                "on_usage_limit": { "type": "string", "enum": ["wait", "same", "engine"], "description": "What a lead may do about a child of this profile that hits its usage limit: `wait` (default — nobody moves it without a person), `same` (the lead may move it to another subscription for the same engine), `engine` (and to another engine). The third is the person's acknowledgement, given in advance, that another engine brings its own default permissions — do not choose it for them." },
                                "on_child_limit": { "type": "string", "enum": ["ask", "reroute"], "description": "For a Manager: whether it re-routes a spent child itself (`reroute`) or stops and asks the person which subscription to spend (`ask`, the default)." },
                                "directory": { "type": "string", "description": "A directory to file it in, by name, so a teammate can reach it. Omit for the person's own space." },
                            },
                            "required": ["name", "does"],
                        },
                    }, {
                        "name": UPDATE_PROFILE,
                        "description": "Change a saved profile, by name — \"make the reviewer stricter\", \"run QA on Codex\", \"stop pinning QA to Codex and let the lead decide\". Only the fields you pass change; everything else stays. Rename with `new_name`. To clear a pin back to open, pass that field as `null` — `agent: null` lets each child run on its lead's engine, `machine: null` lets Firetower pick one, `placement: \"lead\"` lets the lead choose. Omitting a field keeps it, so null is the only way to say \"stop pinning this\". When what they want changed is ambiguous, confirm it before you apply — a profile is something they rely on, not a scratch edit. This CAN change the run settings, the skills it loads, a Manager's team, the two inheritance switches, what a lead may do if a child runs out, and which directory it is filed in — read `get_profile` first when the change depends on what it already says. TWO THINGS IT CANNOT CHANGE: the subscription, and whether the profile is the person's default for new workspaces. If they ask for either, say so and point them at Settings → Harness → Profiles instead of reporting a change you did not make.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "The profile to change, by its current name." },
                                "new_name": { "type": "string", "description": "A new name, to rename it." },
                                "does": { "type": "string" },
                                "instructions": { "type": "string" },
                                "agent": { "type": ["string", "null"], "enum": ["ClaudeCode", "Codex", "KimiCode", "CursorAgent", null], "description": "The engine it runs on. `null` clears the pin, so each child runs on its lead's engine." },
                                "placement": { "type": "string", "enum": ["lead", "here", "new"], "description": "`lead` leaves it to whichever lead delegates." },
                                "machine": { "type": ["string", "null"], "description": "The host id its own workspace runs on. `null` clears the pin, and Firetower picks a machine that can run the engine." },
                                "can_delegate": { "type": "boolean" },
                                "settings": { "type": "object", "description": "How it runs its engine, each optional: `model`, `effort`, `mode`, `sandbox`. Only for a profile that pins `agent` — these belong to one engine. A value the engine does not offer is refused, listing the ones it does.",
                                    "properties": {
                                        "model": { "type": "string" },
                                        "effort": { "type": "string" },
                                        "mode": { "type": "string" },
                                        "sandbox": { "type": "string" },
                                    },
                                },
                                "skill_scope": { "type": "array", "items": { "type": "string" }, "description": "Skills this profile loads on top of the two switches below, BY NAME as `list_skills` shows them. A name the person cannot reach is refused, naming it." },
                                "delegate_scope": { "type": "array", "items": { "type": "string" }, "description": "For a Manager: the profiles it may hand work to, BY NAME as `list_profiles` shows them. Empty means any profile its owner can reach. A name that does not resolve is refused, naming it." },
                                "include_always_on": { "type": "boolean", "description": "Load the owner's always-on skills. Default true." },
                                "include_repo_defaults": { "type": "boolean", "description": "Load the owner's defaults for the repositories the child checks out. Default true." },
                                "on_usage_limit": { "type": "string", "enum": ["wait", "same", "engine"], "description": "What a lead may do about a child of this profile that hits its usage limit: `wait` (default — nobody moves it without a person), `same` (the lead may move it to another subscription for the same engine), `engine` (and to another engine). The third is the person's acknowledgement, given in advance, that another engine brings its own default permissions — do not choose it for them." },
                                "on_child_limit": { "type": "string", "enum": ["ask", "reroute"], "description": "For a Manager: whether it re-routes a spent child itself (`reroute`) or stops and asks the person which subscription to spend (`ask`, the default)." },
                                "directory": { "type": ["string", "null"], "description": "Move it: a directory by name, so a teammate can reach it, or `null` to move it back into the person's own space. Omit to leave where it is filed alone." },
                            },
                            "required": ["name"],
                        },
                    }, {
                        "name": LIST_PROFILES,
                        "description": "List the saved profiles the person can see — name, whether it's a Manager, and what it does. Read this before creating one, to build on what exists rather than make a near-duplicate.",
                        "inputSchema": { "type": "object", "properties": {} },
                    }, {
                        "name": GET_PROFILE,
                        "description": GET_PROFILE_DESCRIPTION,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "The profile to read, by name, as `list_profiles` shows it." },
                            },
                            "required": ["name"],
                        },
                    }, {
                        "name": LIST_COMPUTE,
                        "description": LIST_COMPUTE_DESCRIPTION,
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "role": { "type": "string", "description": "The profile you are about to start, by name. Where it pins a placement or a machine, the answer is scoped to the one machine that child would run on instead of listing the fleet." },
                                "placement": { "type": "string", "enum": ["here", "new"], "description": "Where that child would run, if you already know and the profile leaves it open. `here` scopes the answer to this workspace's own machine." },
                            },
                        },
                    }, {
                        "name": CREATE_SKILL,
                        "description": "Write a skill into the person's library — a SKILL.md and, if it needs them, bundled files — so they don't have to hand-copy what you wrote into the editor. Use it when they ask you to make them a skill (\"turn this into a skill\", \"make me a changelog skill\"). It appears on their Skills screen at once. A skill that ships a script (anything under scripts/, or a file marked executable) is held for the person's review before it can run — say so when that happens. Check list_skills first so you refine an existing one rather than duplicate it.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "Lowercase handle: letters, digits, hyphens. e.g. \"changelog-helper\". Not \"claude\" or \"anthropic\"." },
                                "description": { "type": "string", "description": "What it does AND when to fire — this is the whole triggering mechanism, so be specific and a little pushy: \"...Use this whenever the user mentions a changelog or release notes, even if they don't say 'skill'.\"" },
                                "body": { "type": "string", "description": "The SKILL.md instructions, as markdown (no frontmatter — that's composed from name and description). Keep it to a page; put long reference material in a references/ file." },
                                "files": {
                                    "type": "array",
                                    "description": "Optional bundled files. Contents are plain text (not base64). A file under scripts/, or one with executable:true, makes the skill held for review.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "path": { "type": "string", "description": "Relative, e.g. \"references/format.md\" or \"scripts/build.sh\". Never absolute, never ..." },
                                            "contents": { "type": "string" },
                                            "executable": { "type": "boolean" },
                                        },
                                        "required": ["path", "contents"],
                                    },
                                },
                                "directory": { "type": "string", "description": "A directory to file it in, by name, so a teammate can reach it. Omit for the person's own space." },
                            },
                            "required": ["name", "description"],
                        },
                    }, {
                        "name": UPDATE_SKILL,
                        "description": "Change a saved skill, by name — \"make the changelog skill terser\", \"add an example\". Writes a new version; a running session keeps the one it started with. Only the fields you pass change; the bundled files carry forward unless you send a new set. A change that ships a script is held for review.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "The skill to change, by its current name." },
                                "new_name": { "type": "string", "description": "A new name, to rename it." },
                                "description": { "type": "string" },
                                "body": { "type": "string" },
                                "files": {
                                    "type": "array",
                                    "description": "Replaces the bundled files (besides SKILL.md). Omit to leave them as they are.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "path": { "type": "string" },
                                            "contents": { "type": "string" },
                                            "executable": { "type": "boolean" },
                                        },
                                        "required": ["path", "contents"],
                                    },
                                },
                            },
                            "required": ["name"],
                        },
                    }, {
                        "name": LIST_SKILLS,
                        "description": "List the skills the person can see — name, description, whether it ships a script, and whether it's held for their review. Read this before creating one, to build on what exists rather than make a near-duplicate.",
                        "inputSchema": { "type": "object", "properties": {} },
                    }, {
                        "name": PROPOSE_SCHEDULE,
                        "description": "Propose work that runs on a clock — a dependency audit every Monday, a flaky-test hunt overnight. IT IS OFF WHEN YOU CREATE IT AND NEVER RUNS UNTIL THE PERSON TURNS IT ON, so say that when you tell them: it appears on the Schedules screen for them to read and approve. Each run starts its OWN NEW WORKSPACE and follows `prompt` with nobody present, so write `prompt` for somebody who cannot ask you a follow-up question: say what to do and what to leave alone. AGREE THE SHAPE FIRST unless they already said — what it should do, how often, which repository, and that nobody will be there to answer it. Runs cannot be closer together than 15 minutes. Check `list_schedules` first so you refine one rather than duplicate it. YOU CANNOT turn one on, edit one, or delete one, and there is no way to end a workspace a run left behind — that is theirs to do.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "What it is called in the list. Short and plain — \"Dependency audit\", not \"Automated weekly dependency and advisory scan\"." },
                                "prompt": { "type": "string", "description": "What each run is asked to do. Nobody is there to clarify it, so describe the result expected and say what not to touch." },
                                "cadence": { "type": "string", "enum": ["daily", "weekdays", "weekly", "monthly"], "description": "How often. `weekdays` is Monday to Friday." },
                                "at": { "type": "string", "description": "The time of day, as HH:MM on a 24-hour clock, in `timezone`." },
                                "day": { "type": "string", "enum": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], "description": "For `weekly`: which day." },
                                "dayOfMonth": { "type": "integer", "description": "For `monthly`: which date, 1 to 31." },
                                "timezone": { "type": "string", "description": "An IANA name, like Europe/Paris. Ask rather than guess: \"09:00\" means nothing without saying whose nine." },
                                "repo": { "type": "string", "description": "The repository each run checks out, by slug as the person knows it. Omit for a bare agent with nothing checked out — and note that nothing is ever deleted automatically then, because git never saw the directory." },
                                "profile": { "type": "string", "description": "A saved profile to run as, by name as `list_profiles` shows it." },
                            },
                            "required": ["name", "prompt", "cadence", "at", "timezone"],
                        },
                    }, {
                        "name": LIST_SCHEDULES,
                        "description": "List the person's schedules — name, what it runs, how often, whether it is on, and how many of its runs are still holding a workspace. Read this before proposing one.",
                        "inputSchema": { "type": "object", "properties": {} },
                    }, {
                        "name": PAUSE_SCHEDULE,
                        "description": "Stop a schedule's future runs, by name. It does NOT touch a run that is already going, and you CANNOT turn it back on — only the person can, which is why pausing is yours to do and resuming is not. Say so when you report it.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "The schedule to stop, by name as `list_schedules` shows it." },
                            },
                            "required": ["name"],
                        },
                    }]
                }),
            ))
        }

        "tools/call" => {
            let id = id?;
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));
            let name = request
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or(TOOL);
            let text = match name {
                SPAWN | CHILDREN | UPDATE | PLAN | CREATE_PROFILE | UPDATE_PROFILE
                | LIST_PROFILES | GET_PROFILE | LIST_COMPUTE | CREATE_SKILL | UPDATE_SKILL
                | LIST_SKILLS | PROPOSE_SCHEDULE | LIST_SCHEDULES | PAUSE_SCHEDULE => {
                    delegate(session_id, name, &id, &arguments).await
                }
                // Every call used to be a permission question, and an agent
                // from before the other tools existed still only knows this
                // one — so anything unnamed is still that.
                _ => ask(session_id, workspace, settled, &arguments)
                    .await
                    .to_string(),
            };
            Some(reply(
                id,
                json!({
                    "content": [{
                        "type": "text",
                        // The decision travels as text because that is what a
                        // tool result carries. The agent parses it back.
                        "text": text,
                    }]
                }),
            ))
        }

        // Notifications, and anything a newer agent invented. An empty result
        // is a better answer than an error for something we simply do not act
        // on.
        _ => id.map(|id| reply(id, json!({}))),
    }
}

/// Put the question to whoever is watching this session, and wait.
async fn ask(
    session_id: &str,
    workspace: &std::path::Path,
    settled: &Arc<Mutex<HashSet<String>>>,
    arguments: &Value,
) -> Value {
    let tool_name = arguments
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("a tool")
        .to_string();
    let input = arguments.get("input").cloned().unwrap_or(json!({}));
    // The agent's own id for the call it is blocked on, which is what makes an
    // answer match a question even if several are open at once.
    let req = arguments
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("{tool_name}-{}", input.to_string().len()));

    // Already settled, so nobody is asked twice. This is what makes "always"
    // mean now rather than from the next session onwards.
    if settled.lock().await.contains(&tool_name) {
        return settle(json!({ "behavior": "allow" }), &input);
    }

    match wait_for_a_decision(session_id, &req, &tool_name, &input).await {
        Ok(decision) => {
            if decision.get("firetowerAlways").and_then(Value::as_bool) == Some(true) {
                settled.lock().await.insert(tool_name.clone());
                if let Err(e) = allow_from_now_on(workspace, &tool_name).await {
                    // This half only matters if the agent is restarted in the
                    // same workspace, and it has already been remembered above
                    // either way. Worth a line, not worth failing the call
                    // somebody just approved.
                    tracing::warn!("could not write the rule about {tool_name}: {e:#}");
                }
            }
            settle(decision, &input)
        }
        Err(e) => {
            // Nobody can be reached. Denying is the safe answer and the message
            // reaches the agent, so the transcript says why rather than showing
            // a tool that mysteriously did nothing.
            tracing::warn!("could not ask about {tool_name}: {e:#}");
            json!({
                "behavior": "deny",
                "message": format!("Firetower could not ask anyone about this: {e:#}"),
            })
        }
    }
}

/// Carry a delegation call to the control plane, and bring its answer back.
///
/// The same road a permission question takes, with the name prefixed so the
/// far end acts on it rather than asking somebody. The request id has to be
/// unique for as long as the lead session exists: a worker that reconnects
/// re-announces every call still waiting, and the control plane answers a
/// repeat with the child the first arrival made — so an id that repeated
/// across agent restarts would hand a new spawn an old child. JSON-RPC ids
/// start again at one each time the agent starts, which is why this process's
/// own start is part of the name.
async fn delegate(session_id: &str, name: &str, id: &Value, arguments: &Value) -> String {
    use std::sync::OnceLock;
    static STARTED: OnceLock<u128> = OnceLock::new();
    let started = STARTED.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    });
    let req = format!("{name}-{started}-{}", id.to_string().trim_matches('"'));

    match wait_for_a_decision(session_id, &req, &format!("{DELEGATION}{name}"), arguments).await {
        // The control plane answers in words, for the agent to read; anything
        // else it sends is handed over verbatim rather than guessed at.
        Ok(result) => match result.get("text").and_then(Value::as_str) {
            Some(text) => text.to_string(),
            None => result.to_string(),
        },
        Err(e) => format!("Firetower could not reach anyone to {name}: {e:#}"),
    }
}

/// Finish a decision into something the agent will accept.
///
/// An allow must carry the tool's arguments back, and they must be the real
/// ones: an allow without `updatedInput` is refused outright, and the session
/// reports a permission error rather than the thing anybody actually asked
/// about. Only this end reliably has them — the browser sees a copy, this sees
/// what the agent sent — so the echo is added here rather than travelling the
/// full round trip and back.
///
/// Nothing rewrites them. Firetower shows a command and asks about it; showing
/// one and running another would make every card a lie.
fn settle(mut decision: Value, input: &Value) -> Value {
    // Ours, not the agent's: it says what to do about the *next* call like this
    // one, and the agent has no field for that. Removed first, so no path out
    // of here can carry it.
    if let Some(object) = decision.as_object_mut() {
        object.remove("firetowerAlways");
    }
    if decision.get("behavior").and_then(Value::as_str) != Some("allow") {
        return decision;
    }
    let Some(object) = decision.as_object_mut() else {
        return decision;
    };

    match object.get_mut("updatedInput") {
        // Nothing to say about the arguments, so they are the ones that came.
        None | Some(Value::Null) => {
            object.insert("updatedInput".into(), input.clone());
        }
        // Something to say, but only about part of it. An answer to a question
        // carries the answers and not the questions, and the agent matches on
        // both — so whatever was not spoken for is filled in from what it sent.
        Some(Value::Object(given)) => {
            if let Some(original) = input.as_object() {
                for (key, value) in original {
                    given.entry(key.clone()).or_insert_with(|| value.clone());
                }
            }
        }
        _ => {}
    }
    decision
}

async fn wait_for_a_decision(
    session_id: &str,
    req: &str,
    tool_name: &str,
    input: &Value,
) -> Result<Value> {
    let mut client = AgentClient::connect(session_id)
        .await
        .context("connecting to the session")?;

    client
        .send(&ToAgent::Ask {
            req: req.to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
        })
        .await
        .context("asking")?;

    let mut frames = BufReader::new(client.into_stream()).lines();
    while let Some(frame) = frames.next_line().await? {
        let Ok(frame) = serde_json::from_str::<FromAgent>(&frame) else {
            continue;
        };
        // The echo of our own question comes back first; the answer follows.
        if let FromAgent::Decided { result } = frame {
            return Ok(result);
        }
    }
    anyhow::bail!("the session closed before this was answered")
}

/// Write the rule down, for an agent that starts again in this workspace.
///
/// The second half of remembering, and the weaker one. An agent reads its
/// settings when it starts, so this does nothing for the session in progress —
/// that is what the in-memory set above is for. It matters when the supervisor
/// restarts the agent and the workspace is still there.
///
/// Composed here rather than echoed back because the agent never offered the
/// choice: the callback its own SDK gives a host arrives with ready-made rules
/// to hand back, and the tool call this arrives through does not carry them.
///
/// Scoped to the tool rather than to these exact arguments, which is the
/// coarser of the two readings of "always". A narrower rule would need the
/// argument syntax for every tool, and getting that subtly wrong means a button
/// that silently does nothing.
///
/// Scoped to the workspace, so it lasts as long as the session does and goes
/// when the workspace does. Nothing here touches anybody's own configuration.
async fn allow_from_now_on(workspace: &std::path::Path, tool_name: &str) -> Result<()> {
    let dir = workspace.join(".claude");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join("settings.local.json");

    let mut settings: serde_json::Map<String, Value> = match tokio::fs::read_to_string(&path).await
    {
        Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => map,
            // Somebody's real settings in a shape we do not understand.
            // Leaving them is the only safe move.
            _ => anyhow::bail!("{} is not an object", path.display()),
        },
        _ => serde_json::Map::new(),
    };

    let permissions = settings
        .entry("permissions")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Some(permissions) = permissions.as_object_mut() else {
        anyhow::bail!("`permissions` is not an object");
    };
    let allow = permissions
        .entry("allow")
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(allow) = allow.as_array_mut() else {
        anyhow::bail!("`permissions.allow` is not a list");
    };

    let rule = Value::String(tool_name.to_string());
    if allow.contains(&rule) {
        return Ok(());
    }
    allow.push(rule);

    tokio::fs::write(&path, serde_json::to_vec_pretty(&Value::Object(settings))?).await?;
    Ok(())
}

fn reply(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nowhere() -> &'static std::path::Path {
        std::path::Path::new("/tmp/firetower-approver-test")
    }

    fn none() -> Arc<Mutex<HashSet<String>>> {
        Arc::new(Mutex::new(HashSet::new()))
    }

    #[tokio::test]
    async fn it_introduces_itself_with_the_version_the_agent_asked_for() {
        let request = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" },
        });
        let response = answer(&request, "s_test", nowhere(), &none())
            .await
            .unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(response["result"]["serverInfo"]["name"], SERVER);
    }

    #[tokio::test]
    async fn it_offers_the_permission_tool_first_and_the_agent_is_told_its_full_name() {
        let request = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });
        let response = answer(&request, "s_test", nowhere(), &none())
            .await
            .unwrap();
        let tools = response["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        // The permission tool first: it is the one the launch flags name, and
        // the one an older agent only knows.
        assert_eq!(
            names,
            [
                TOOL,
                SPAWN,
                CHILDREN,
                UPDATE,
                PLAN,
                CREATE_PROFILE,
                UPDATE_PROFILE,
                LIST_PROFILES,
                GET_PROFILE,
                LIST_COMPUTE,
                CREATE_SKILL,
                UPDATE_SKILL,
                LIST_SKILLS,
                PROPOSE_SCHEDULE,
                LIST_SCHEDULES,
                PAUSE_SCHEDULE
            ]
        );
        assert_eq!(tool_name(), "mcp__firetower__approve");
        // A child's goal is the one thing a spawn cannot do without.
        assert_eq!(tools[1]["inputSchema"]["required"], json!(["goal"]));
    }

    #[tokio::test]
    async fn a_spawn_nobody_can_carry_is_refused_in_words() {
        // The same safe end as a permission nobody can answer: the agent reads
        // why, rather than seeing a tool that silently did nothing.
        let request = json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": { "name": SPAWN, "arguments": { "goal": "review the diff" } },
        });
        let response = answer(&request, "s_no-such-session-at-all", nowhere(), &none())
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Firetower"), "{text}");
        assert!(text.contains("spawn"), "{text}");
    }

    #[tokio::test]
    async fn a_call_without_a_name_is_still_a_permission_question() {
        // An agent from before `spawn` existed calls the only tool it knows,
        // and what it gets back has to parse as a decision.
        let request = json!({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": { "arguments": { "tool_name": "Write", "input": {}, "tool_use_id": "toolu_y" } },
        });
        let response = answer(&request, "s_no-such-session-at-all", nowhere(), &none())
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "deny");
    }

    #[tokio::test]
    async fn a_notification_gets_no_reply() {
        let request = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(answer(&request, "s_test", nowhere(), &none())
            .await
            .is_none());
    }

    #[tokio::test]
    async fn a_call_nobody_can_answer_is_denied_with_a_reason() {
        // Denying is the safe end of a failure, and the message is what stops
        // this reading as a tool that silently did nothing.
        let request = json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": { "name": TOOL, "arguments": {
                "tool_name": "Write", "input": {}, "tool_use_id": "toolu_x" } },
        });
        let response = answer(&request, "s_no-such-session-at-all", nowhere(), &none())
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "deny");
        assert!(decision["message"].as_str().unwrap().contains("Firetower"));
    }

    #[test]
    fn an_allow_carries_the_arguments_the_agent_actually_sent() {
        // Without this the agent refuses the allow and reports a permission
        // error, which reads as Firetower being broken rather than as a
        // decision having been made.
        let input = json!({ "file_path": "/tmp/x", "content": "banana" });
        let settled = settle(json!({ "behavior": "allow", "updatedInput": null }), &input);
        assert_eq!(settled["updatedInput"], input);
    }

    #[test]
    fn an_answer_keeps_the_questions_it_answers() {
        // The agent matches an answer to its question by the question's own
        // text. Allowing without them hands it a result that says nothing.
        let input = json!({ "questions": [{ "question": "Which?", "options": [] }] });
        let settled = settle(
            json!({ "behavior": "allow", "updatedInput": { "answers": { "Which?": "A" } } }),
            &input,
        );
        assert_eq!(settled["updatedInput"]["answers"]["Which?"], "A");
        assert_eq!(settled["updatedInput"]["questions"], input["questions"]);
    }

    #[test]
    fn what_the_decision_says_beats_what_the_agent_sent() {
        let settled = settle(
            json!({ "behavior": "allow", "updatedInput": { "answers": "mine" } }),
            &json!({ "answers": "theirs", "questions": [] }),
        );
        assert_eq!(settled["updatedInput"]["answers"], "mine");
    }

    #[test]
    fn our_own_marker_never_reaches_the_agent() {
        for behavior in ["allow", "deny"] {
            let settled = settle(
                json!({ "behavior": behavior, "message": "x", "firetowerAlways": true }),
                &json!({}),
            );
            assert!(
                settled.get("firetowerAlways").is_none(),
                "{behavior}: the agent has no field for this"
            );
        }
    }

    #[tokio::test]
    async fn a_tool_already_settled_is_never_asked_about_again() {
        // The whole point of the button: the next identical call goes straight
        // through, in this session, without anybody being interrupted twice.
        let settled = none();
        settled.lock().await.insert("Write".into());

        let request = json!({
            "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": TOOL, "arguments": {
                "tool_name": "Write",
                "input": { "file_path": "/w/two.txt" },
                "tool_use_id": "toolu_second" } },
        });
        // No session is listening, so anything that actually asked would be
        // denied — which is what makes this assertion mean something.
        let response = answer(&request, "s_nobody-home", nowhere(), &settled)
            .await
            .unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let decision: Value = serde_json::from_str(text).unwrap();
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["file_path"], "/w/two.txt");
    }

    #[tokio::test]
    async fn always_writes_a_rule_the_agent_reads_before_asking_again() {
        let workspace = tempfile::tempdir().unwrap();
        allow_from_now_on(workspace.path(), "Write").await.unwrap();
        allow_from_now_on(workspace.path(), "Write").await.unwrap();

        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(workspace.path().join(".claude/settings.local.json")).unwrap(),
        )
        .unwrap();
        let allow = written["permissions"]["allow"].as_array().unwrap();
        assert_eq!(allow, &[json!("Write")], "asked twice, written once");
    }

    #[tokio::test]
    async fn remembering_a_decision_leaves_other_settings_alone() {
        let workspace = tempfile::tempdir().unwrap();
        let dir = workspace.path().join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.local.json"),
            r#"{"env":{"KEEP":"me"},"permissions":{"deny":["Bash(rm *)"]}}"#,
        )
        .unwrap();

        allow_from_now_on(workspace.path(), "Read").await.unwrap();

        let written: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("settings.local.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(written["env"]["KEEP"], "me");
        assert_eq!(written["permissions"]["deny"][0], "Bash(rm *)");
        assert_eq!(written["permissions"]["allow"][0], "Read");
    }

    #[test]
    fn a_denial_is_left_exactly_as_it_was_decided() {
        let denied = settle(
            json!({ "behavior": "deny", "message": "not on production" }),
            &json!({ "command": "rm -rf /" }),
        );
        assert_eq!(denied["behavior"], "deny");
        assert_eq!(denied["message"], "not on production");
        assert!(denied.get("updatedInput").is_none());
    }

    #[test]
    fn the_configuration_names_this_binary_and_this_session() {
        let config = mcp_config(
            std::path::Path::new("/usr/bin/firetower"),
            "s_01abc",
            std::path::Path::new("/w"),
        );
        let server = &config["mcpServers"][SERVER];
        assert_eq!(server["command"], "/usr/bin/firetower");
        assert_eq!(server["args"][0], "mcp-approve");
        assert_eq!(server["args"][2], "s_01abc");
    }
}
