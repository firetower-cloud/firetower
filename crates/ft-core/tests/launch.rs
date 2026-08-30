//! How an agent is started, and the difference between starting and returning.
//!
//! A session outlives the process running it: the workspace is on a volume and
//! the agent is a child process with a socket in `/tmp`. Recreating the
//! container to upgrade Firetower ends every agent on the machine at once, so
//! coming back is ordinary rather than exceptional — and the two cases are one
//! flag apart in a command line nobody looks at.

use ft_core::{agent_session_uuid, Agent, Asking, Start};

fn argv(start: Start) -> Vec<String> {
    Agent::ClaudeCode
        .launch_headless("s_01example", &Asking::CannotAsk, start)
        .expect("Claude Code is driven headless")
}

fn after(argv: &[String], flag: &str) -> Option<String> {
    let at = argv.iter().position(|a| a == flag)?;
    argv.get(at + 1).cloned()
}

/// The identifier is the same either way. That is the whole mechanism: it is
/// derived from the session id rather than learned from the agent, so the
/// conversation can be named again after everything that knew it is gone.
#[test]
fn both_ways_of_starting_name_the_same_conversation() {
    let fresh = argv(Start::Fresh);
    let resumed = argv(Start::Resume);
    let expected = agent_session_uuid("s_01example");

    assert_eq!(
        after(&fresh, "--session-id").as_deref(),
        Some(expected.as_str())
    );
    assert_eq!(
        after(&resumed, "--resume").as_deref(),
        Some(expected.as_str())
    );
}

/// `--session-id` means *begin one called this*, which is right exactly once.
#[test]
fn a_first_launch_names_a_new_conversation() {
    let argv = argv(Start::Fresh);
    assert!(argv.iter().any(|a| a == "--session-id"));
    assert!(
        !argv.iter().any(|a| a == "--resume"),
        "a session that has never run has nothing to resume"
    );
}

/// And every launch after it has to say the other thing, or be refused.
#[test]
fn coming_back_resumes_rather_than_starting_again() {
    let argv = argv(Start::Resume);
    assert!(argv.iter().any(|a| a == "--resume"));
    assert!(
        !argv.iter().any(|a| a == "--session-id"),
        "asking to create a session that already exists is how a relaunch fails"
    );
}

/// Everything else about the launch is the same. A resumed agent is the same
/// agent, on the same model, able to ask the same questions.
#[test]
fn nothing_else_about_the_launch_changes() {
    let strip = |mut argv: Vec<String>| {
        let uuid = agent_session_uuid("s_01example");
        argv.retain(|a| a != "--session-id" && a != "--resume" && *a != uuid);
        argv
    };
    assert_eq!(strip(argv(Start::Fresh)), strip(argv(Start::Resume)));
}

/// What was said before has to reach the agent, not sit in a file it may
/// decide not to read. It said it had no idea what the conversation was about
/// while the file was on disk beside it, named in `AGENTS.md`.
#[test]
fn a_restarted_agent_is_handed_the_conversation() {
    let argv = Agent::ClaudeCode
        .launch_headless(
            "s_01example",
            &Asking::CannotAsk,
            Start::Carrying("they asked for drawings".into()),
        )
        .expect("Claude Code is driven headless");

    assert_eq!(
        after(&argv, "--append-system-prompt").as_deref(),
        Some("they asked for drawings"),
        "it goes in the system prompt, where it cannot be missed"
    );
    assert!(
        argv.iter().any(|a| a == "--session-id"),
        "a carried conversation is still a new one"
    );
}

/// Codex is told what to do over its own protocol rather than argv, so there is
/// nothing here to vary — its resume is a different mechanism, in `thread/start`.
#[test]
fn codex_takes_no_flags_either_way() {
    let fresh = Agent::Codex.launch_headless("s_01example", &Asking::CannotAsk, Start::Fresh);
    let resumed = Agent::Codex.launch_headless("s_01example", &Asking::CannotAsk, Start::Resume);
    assert_eq!(fresh, resumed);
}
