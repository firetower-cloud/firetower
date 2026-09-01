//! Asking the agent what it would call its own work.
//!
//! A pull request needs a title and a body, and the moment a session hands back
//! is the moment something on that machine knows most about what changed. So it
//! is asked, and the answer waits in the review sheet as a draft rather than as
//! an empty box.
//!
//! ## Why this is a separate run, not a turn in the session
//!
//! Both were possible. Asking inside the session gives the whole conversation
//! as context, and costs the session: a hidden turn is still a turn — it lands
//! in the log, spends tokens, and moves the context meter of the session
//! somebody is about to carry on working in. It also cannot answer at all for a
//! session that has ended, and a branch is still worth shipping after its
//! workspace is gone.
//!
//! This runs its own short-lived agent instead, on the same host, and is handed
//! the context that made a turn tempting: the diff, *and* what was actually
//! said. [`crate::history::recap`] already reduces an agent's log to the
//! conversation — which is where the reasoning lives, and where an issue number
//! somebody mentioned in passing appears. The diff says what changed; the talk
//! says why, and what else it was about.
//!
//! It runs where the code is. The control plane never sees the diff or the
//! conversation, needs no model credentials of its own, and gains no second
//! opinion about work it did not watch.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::Command;

/// What the agent proposes calling the work.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Proposal {
    /// One line, in the conventional-commit shape.
    pub title: String,
    /// What it did and why, for whoever reviews it.
    pub body: String,
    /// Issues it noticed being talked about: `#18`, `acme/web#41`.
    ///
    /// Kept apart from the body rather than written into it. A model that
    /// invents a number would otherwise be writing `Closes #23` into a pull
    /// request, and closing somebody else's issue on merge is not a mistake
    /// that shows up in review. These are offered on screen and become
    /// references only when a person clicks one.
    pub issues: Vec<String>,
}

/// Everything the describing run is told.
///
/// A struct rather than six arguments, because the last three are all context
/// the worker cannot look up for itself and are all optional in the same way.
pub struct About<'a> {
    pub agent: ft_core::Agent,
    pub workspace: &'a std::path::Path,
    pub session_id: &'a str,
    /// What the session was asked to do, when anybody said.
    pub asked_for: Option<&'a str>,
    /// The issue it was cut for, as much of it as the control plane could read.
    pub task: Option<&'a ft_proto::Tracked>,
    pub diff: &'a str,
    /// Where the worker keeps its state, for the PATH the agents live on.
    pub state: &'a std::path::Path,
}

/// How much of a diff is worth sending.
///
/// A large refactor produces more than a model should be asked to read for one
/// sentence, and the interesting part of any diff is near the top of each file.
/// Truncated with a note, so the answer says "and more" rather than confidently
/// describing a third of the change.
const ENOUGH: usize = 60_000;

/// How much of the conversation is worth sending.
///
/// Smaller than the diff on purpose. The diff is the subject; the talk is what
/// makes sense of it, and the end of it is worth far more than the beginning.
const ENOUGH_TALK: usize = 20_000;

/// How much of an issue's own description to carry.
///
/// Enough for what it is asking for, not the forty comments underneath — and
/// the body is not fetched anyway, only the opening description.
const ENOUGH_ISSUE: usize = 4_000;

/// Ask, and take the first sensible answer.
///
/// Never fatal. A session that finished is finished whether or not anybody
/// could think of a name for it, and the review sheet works perfectly well with
/// an empty box.
pub async fn propose(about: About<'_>) -> Result<Proposal> {
    let diff = about.diff.trim();
    anyhow::ensure!(
        !diff.is_empty(),
        "nothing changed, so there is nothing to describe"
    );

    let talk = crate::history::recap(
        about.workspace,
        about.session_id,
        about.agent,
        ENOUGH_TALK,
    )
    .await;

    let prompt = ask(&about, diff, talk.as_deref());

    let mut command = Command::new(about.agent.command());
    // The same PATH a session gets, so describing a change uses whichever copy
    // of the agent this machine actually runs.
    command.env("PATH", crate::runtime::path_with_agents(about.state).await);
    invocation(about.agent, &mut command, &prompt);

    let output = command
        .current_dir(about.workspace)
        // Closed, not inherited. The prompt is an argument, so there is nothing
        // to read — but an inherited pipe that never delivers is not the same
        // as no input, and the agent waits on it and then fails. Its own
        // warning names the fix: redirect stdin explicitly.
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("running {}", about.agent.command()))?;

    anyhow::ensure!(
        output.status.success(),
        "{} exited {}: {}",
        about.agent.command(),
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stderr).trim()
    );

    read(&String::from_utf8_lossy(&output.stdout)).context("the answer had no title in it")
}

/// How to run this agent once, without a session.
///
/// Every agent has a way of being asked one question and answering it, and no
/// two spell it the same. This used to send Claude Code's flags to whatever
/// binary the session happened to use — so on a Codex session the command was
/// `codex -p --model haiku`, which `codex` rejects. The failure is swallowed by
/// design, one layer up, which is why it looked like nothing: Codex sessions
/// have simply never had a title or a body proposed for them.
fn invocation(agent: ft_core::Agent, command: &mut Command, prompt: &str) {
    match agent {
        ft_core::Agent::ClaudeCode => {
            command.args([
                "-p",
                // Cheap and quick. This is one paragraph about a diff, not the
                // work itself, and the session it describes was done by the
                // real model.
                "--model",
                "haiku",
                // Nothing is asked of anybody. There is no session watching, so
                // a prompt here would wait forever — and this needs no tools:
                // the diff is in the question.
                "--permission-mode",
                "dontAsk",
            ]);
            command.arg(prompt);
        }
        ft_core::Agent::Codex => {
            command.args([
                "exec",
                // Nothing here writes. The question carries the diff, so the
                // run needs no more of the workspace than it is given — and a
                // describing run that edited a file would be a surprise nobody
                // asked for.
                "--sandbox",
                "read-only",
            ]);
            // No model pinned. Codex's cheap tier is renamed often enough that
            // naming one here is a way to break this later, and its default is
            // already the sensible one for a question this size.
            command.arg(prompt);
        }
        // Not offered, and has no answer to give. Reached only by a session
        // recorded before `Shell` stopped being startable.
        ft_core::Agent::Shell => {
            command.args(["-c", "exit 1"]);
        }
    }
}

/// What to ask for.
///
/// Conventional commits, because that is what the title becomes: this line ends
/// up as a commit message and as a pull request title, and half of what reads a
/// repository's history expects the prefix.
///
/// Labelled fields rather than "first line, blank line, rest". A labelled
/// answer can be found in output that begins with a banner, which is what a
/// one-shot run of most agents prints before it says anything — reading the
/// first line as the title made the title `OpenAI Codex v0.42`. The old shape
/// is still understood; see [`read`].
fn ask(about: &About<'_>, diff: &str, talk: Option<&str>) -> String {
    let (diff, more) = if diff.len() > ENOUGH {
        (&diff[..ENOUGH], "\n\n[diff truncated]")
    } else {
        (diff, "")
    };

    let mut prompt = String::from(
        "Describe this change as a pull request.\n\
         \n\
         Answer with these labels, each starting a line, and nothing else. No \
         preamble, no headings, no code fences.\n\
         \n\
         TITLE: a conventional commit — `type(scope): summary`, where type is \
         one of feat, fix, refactor, perf, docs, test, build, ci, chore. Lower \
         case after the colon, no full stop, under 70 characters. Leave the \
         scope out rather than inventing one.\n\
         BODY: one or two short paragraphs saying what changed and why, on the \
         lines after the label. Write for somebody reviewing it who did not \
         watch it happen. No bullet list unless the change really is a list of \
         unrelated things.\n\
         ISSUES: every issue number that was actually mentioned in what you \
         are shown — `#18`, or `owner/repo#41`, comma separated. Write `none` \
         if none were. Never guess a number, and do not put issue numbers in \
         the body; something else adds those.\n\
         \n",
    );

    if let Some(task) = about.task {
        prompt.push_str(&format!(
            "This work was started from issue {}.\n{}\n\n",
            task.key,
            issue(task)
        ));
    }

    if let Some(asked_for) = about.asked_for.map(str::trim).filter(|a| !a.is_empty()) {
        prompt.push_str(&format!(
            "This is what the session was asked to do:\n{asked_for}\n\n"
        ));
    }

    if let Some(talk) = talk.map(str::trim).filter(|t| !t.is_empty()) {
        prompt.push_str(&format!(
            "This is what was said while it happened. It is the only place the \
             reasoning is written down, and the only place an issue may have \
             been mentioned:\n{talk}\n\n"
        ));
    }

    prompt.push_str(&format!("This is what changed:\n```diff\n{diff}{more}\n```"));
    prompt
}

/// An issue, as much of it as is worth reading.
fn issue(task: &ft_proto::Tracked) -> String {
    let mut out = String::new();
    if let Some(title) = &task.title {
        out.push_str(title.trim());
        out.push('\n');
    }
    if let Some(body) = task.body.as_deref().map(str::trim).filter(|b| !b.is_empty()) {
        let cut: String = body.chars().take(ENOUGH_ISSUE).collect();
        out.push_str(&cut);
        if body.chars().count() > ENOUGH_ISSUE {
            out.push_str("\n[…]");
        }
        out.push('\n');
    }
    if out.is_empty() {
        // The tracker would not say. The number is still worth naming: it is
        // what the branch was cut for.
        out.push_str("(its description could not be read)\n");
    }
    out
}

/// Split an answer into its parts.
///
/// Defensive about the shape, because a model asked for three parts will
/// occasionally deliver one, wrap it in a fence, or apologise first. A wrong
/// title is edited in a text box; a crash is a feature that does not work.
fn read(answer: &str) -> Option<Proposal> {
    let cleaned: Vec<&str> = answer
        .lines()
        .map(str::trim_end)
        // A fence around the whole answer, which is asked against and still
        // happens.
        .filter(|line| !line.trim_start().starts_with("```"))
        .collect();

    labelled(&cleaned).or_else(|| loose(&cleaned))
}

/// The shape that is asked for: `TITLE:`, `BODY:`, `ISSUES:`.
fn labelled(lines: &[&str]) -> Option<Proposal> {
    let at = |label: &str| {
        lines
            .iter()
            .position(|l| l.trim_start().to_ascii_uppercase().starts_with(label))
    };
    let after = |line: &str, label: &str| line.trim_start()[label.len()..].trim().to_string();

    let title_at = at("TITLE:")?;
    let title = after(lines[title_at], "TITLE:");
    let title = tidy(&title);
    if title.is_empty() {
        return None;
    }

    let body_at = at("BODY:");
    let issues_at = at("ISSUES:");

    let body = match body_at {
        Some(from) => {
            let to = issues_at.filter(|i| *i > from).unwrap_or(lines.len());
            let first = after(lines[from], "BODY:");
            let rest = lines[from + 1..to].join("\n");
            format!("{first}\n{rest}")
        }
        // A title and nothing else is still an answer.
        None => String::new(),
    };

    let issues = issues_at
        .map(|i| numbers(&after(lines[i], "ISSUES:")))
        .unwrap_or_default();

    let (title, spilled) = shorten(&title);
    let body = match spilled {
        Some(spilled) => format!("{spilled}\n\n{body}"),
        None => body,
    };

    Some(Proposal {
        title,
        body: body.trim().to_string(),
        issues,
    })
}

/// The older shape, and what a model that ignored the labels tends to produce:
/// a title, a blank line, and the rest.
fn loose(lines: &[&str]) -> Option<Proposal> {
    let start = lines.iter().position(|line| !line.trim().is_empty())?;
    let title = tidy(lines[start]);
    if title.is_empty() {
        return None;
    }

    let rest = lines[start + 1..].join("\n");
    let (title, spilled) = shorten(&title);
    let body = match spilled {
        // The model wrote a paragraph where a title was asked for. What did not
        // fit is still worth reading, so it goes to the top of the body rather
        // than being thrown away — and the commit message stays a commit
        // message.
        Some(spilled) => format!("{spilled}\n\n{rest}"),
        None => rest,
    };

    Some(Proposal {
        title,
        body: body.trim().to_string(),
        issues: Vec::new(),
    })
}

/// Markdown creeps in even when it is asked not to.
fn tidy(title: &str) -> String {
    title
        .trim()
        .trim_start_matches('#')
        .trim()
        .trim_matches('`')
        .trim()
        .to_string()
}

/// The issue references in a line, and nothing that merely looks like one.
///
/// Strict on purpose. Everything this returns is offered on screen as something
/// to link, and the cost of a wrong number is closing an issue nobody was
/// working on — so `none`, prose, and a bare `32` all come back as nothing.
fn numbers(line: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    for piece in line.split([',', ';', ' ']).map(str::trim) {
        let Some(hash) = piece.find('#') else { continue };
        let (owner, number) = piece.split_at(hash);
        let number = number.trim_start_matches('#');
        let number: String = number.chars().take_while(char::is_ascii_digit).collect();
        if number.is_empty() {
            continue;
        }

        // `owner/repo#41`, or nothing at all in front of the hash.
        let owner = owner.trim();
        let reference = if owner.is_empty() {
            format!("#{number}")
        } else if owner.contains('/') && !owner.contains(char::is_whitespace) {
            format!("{owner}#{number}")
        } else {
            continue;
        };

        if !out.contains(&reference) {
            out.push(reference);
        }
    }

    out
}

/// A title short enough to be one.
///
/// Conventional commits want roughly seventy characters and git wants fifty for
/// the summary line. Asked for it and mostly given it — but a model that
/// misreads the question answers with a paragraph, and a three-hundred
/// character commit message is worse than a truncated one.
///
/// Cut on a word so the result reads as a phrase rather than as a string
/// operation.
fn shorten(title: &str) -> (String, Option<String>) {
    const ROOM: usize = 72;
    if title.chars().count() <= ROOM {
        return (title.to_string(), None);
    }

    // The last space at or before the limit, so the cut lands between words.
    let limit = title
        .char_indices()
        .nth(ROOM)
        .map(|(at, _)| at)
        .unwrap_or(title.len());
    let cut = title[..limit].rfind(char::is_whitespace).unwrap_or(limit);

    let (kept, spilled) = title.split_at(cut);
    (
        kept.trim_end().to_string(),
        Some(spilled.trim().to_string()).filter(|s| !s.is_empty()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn about<'a>(asked_for: Option<&'a str>, task: Option<&'a ft_proto::Tracked>) -> About<'a> {
        About {
            agent: ft_core::Agent::ClaudeCode,
            workspace: std::path::Path::new("/nowhere"),
            session_id: "s_test",
            asked_for,
            task,
            diff: "",
            state: std::path::Path::new("/nowhere"),
        }
    }

    #[test]
    fn the_labelled_answer_comes_apart() {
        let got = read(
            "TITLE: feat(api): add a rate limit\n\
             BODY: Holds requests per key.\n\
             ISSUES: #18, acme/web#41",
        )
        .unwrap();
        assert_eq!(got.title, "feat(api): add a rate limit");
        assert_eq!(got.body, "Holds requests per key.");
        assert_eq!(got.issues, vec!["#18", "acme/web#41"]);
    }

    #[test]
    fn a_body_that_runs_over_several_lines_is_all_of_it() {
        let got = read(
            "TITLE: fix: stop the retry loop\n\
             BODY:\n\
             It never terminated.\n\
             \n\
             The second paragraph.\n\
             ISSUES: none",
        )
        .unwrap();
        assert_eq!(got.body, "It never terminated.\n\nThe second paragraph.");
        assert!(got.issues.is_empty(), "{:?}", got.issues);
    }

    #[test]
    fn a_banner_in_front_of_the_answer_is_not_the_title() {
        // What a one-shot run of most agents prints before it says anything.
        // Reading the first line as the title is how the title became a
        // version string.
        let got = read(
            "OpenAI Codex v0.42\n\
             --------\n\
             workdir: /w\n\
             \n\
             TITLE: chore: bump deps\n\
             BODY: Routine.",
        )
        .unwrap();
        assert_eq!(got.title, "chore: bump deps");
        assert_eq!(got.body, "Routine.");
    }

    #[test]
    fn the_older_unlabelled_shape_still_reads() {
        // Worth keeping: a model that ignores the labels writes exactly this,
        // and it is what every answer looked like before there were labels.
        let got = read("feat(api): add a rate limit\n\nHolds requests per key.\n").unwrap();
        assert_eq!(got.title, "feat(api): add a rate limit");
        assert_eq!(got.body, "Holds requests per key.");
        assert!(got.issues.is_empty());
    }

    #[test]
    fn an_answer_that_starts_with_blank_lines_still_reads() {
        let got = read("\n\n\nfix: stop the retry loop\n\nIt never terminated.").unwrap();
        assert_eq!(got.title, "fix: stop the retry loop");
    }

    #[test]
    fn a_fence_around_the_whole_answer_is_ignored() {
        // Asked against, and it happens anyway.
        let got = read("```\nchore: bump deps\n\nRoutine.\n```").unwrap();
        assert_eq!(got.title, "chore: bump deps");
        assert_eq!(got.body, "Routine.");
    }

    #[test]
    fn a_title_dressed_up_as_a_heading_is_undressed() {
        let got = read("## refactor: split the parser\n\nIt was doing two jobs.").unwrap();
        assert_eq!(got.title, "refactor: split the parser");
    }

    #[test]
    fn a_title_with_no_body_is_still_an_answer() {
        // Worth taking. Half of something is better than an empty box, and the
        // box is editable.
        let got = read("docs: fix a typo").unwrap();
        assert_eq!(got.title, "docs: fix a typo");
        assert_eq!(got.body, "");
    }

    #[test]
    fn a_paragraph_where_a_title_was_asked_for_is_cut_to_a_title() {
        // It happens when the model misreads the question, and a
        // three-hundred-character commit message is worse than a short one.
        let rambling = "This change does a great many things across the whole \
             repository and I would like to tell you about all of them at once";
        let got = read(&format!("{rambling}\n\nAnd here is the body.")).unwrap();

        assert!(got.title.chars().count() <= 72, "{:?}", got.title);
        assert!(got.title.starts_with("This change does"));
        assert!(!got.title.ends_with(' '), "cut on a word, not mid-space");
        // Nothing is thrown away.
        assert!(
            got.body.contains("at once"),
            "the rest is kept: {:?}",
            got.body
        );
        assert!(got.body.contains("And here is the body."));
    }

    #[test]
    fn nothing_at_all_is_not_an_answer() {
        assert!(read("").is_none());
        assert!(read("\n\n  \n").is_none());
        assert!(read("```\n```").is_none());
    }

    #[test]
    fn only_a_real_reference_is_read_as_one() {
        assert_eq!(numbers("#18, acme/web#41"), vec!["#18", "acme/web#41"]);
        // What a model writes when there were none, and what it writes when it
        // is being chatty about it.
        assert!(numbers("none").is_empty());
        assert!(numbers("no issues were mentioned").is_empty());
        // A bare number is not a reference — too easy to be a version, a count
        // or a line number.
        assert!(numbers("32").is_empty());
        // Said twice is still one issue.
        assert_eq!(numbers("#18 #18"), vec!["#18"]);
    }

    #[test]
    fn the_prompt_asks_for_a_conventional_commit_and_carries_every_half() {
        let task = ft_proto::Tracked {
            key: "#32".into(),
            url: "https://github.com/acme/web/issues/32".into(),
            title: Some("the thing is slow".into()),
            body: Some("It takes four seconds.".into()),
        };
        let asked = ask(
            &about(Some("make the thing faster"), Some(&task)),
            "diff --git a/x b/x",
            Some("They said:\nalso #18 while you are in there"),
        );

        assert!(asked.contains("conventional commit"));
        assert!(asked.contains("make the thing faster"), "what was wanted");
        assert!(asked.contains("diff --git"), "and what happened");
        assert!(asked.contains("#32"), "the issue it came from");
        assert!(asked.contains("the thing is slow"), "and what that issue is");
        assert!(asked.contains("also #18"), "and what was said along the way");
    }

    #[test]
    fn a_session_with_no_issue_and_no_prompt_still_asks_something_sensible() {
        // Every session started from the composer rather than from a task, and
        // every one whose log could not be read.
        let asked = ask(&about(None, None), "diff --git a/x b/x", None);

        assert!(asked.contains("conventional commit"));
        assert!(asked.contains("diff --git"));
        assert!(!asked.contains("was started from issue"));
        assert!(!asked.contains("This is what was said"));
    }

    #[test]
    fn a_diff_too_big_to_read_is_cut_and_says_so() {
        // Better than asking a model to read a megabyte for one sentence, and
        // better than an answer that confidently describes a third of a change.
        let huge = "x".repeat(ENOUGH * 2);
        let asked = ask(&about(None, None), &huge, None);
        assert!(asked.contains("[diff truncated]"));
        assert!(
            asked.len() < ENOUGH + 4_000,
            "it should be cut, not merely marked"
        );
    }

    #[test]
    fn an_issue_nobody_could_read_is_still_named() {
        let task = ft_proto::Tracked {
            key: "#32".into(),
            url: "https://github.com/acme/web/issues/32".into(),
            title: None,
            body: None,
        };
        let asked = ask(&about(None, Some(&task)), "diff --git a/x b/x", None);
        assert!(asked.contains("#32"));
        assert!(asked.contains("could not be read"));
    }

    #[test]
    fn each_agent_is_run_the_way_it_expects() {
        // The bug this replaced: Claude Code's flags were sent to whatever
        // binary the session used, so `codex -p --model haiku` was run, and
        // rejected, and swallowed.
        let args = |agent| {
            let mut c = Command::new("x");
            invocation(agent, &mut c, "the prompt");
            c.as_std()
                .get_args()
                .map(|a| a.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };

        let claude = args(ft_core::Agent::ClaudeCode);
        assert!(claude.contains(&"-p".to_string()), "{claude:?}");
        assert!(claude.contains(&"haiku".to_string()), "{claude:?}");
        assert_eq!(claude.last().unwrap(), "the prompt");

        let codex = args(ft_core::Agent::Codex);
        assert_eq!(codex.first().unwrap(), "exec", "{codex:?}");
        assert!(!codex.contains(&"-p".to_string()), "{codex:?}");
        assert!(!codex.contains(&"haiku".to_string()), "{codex:?}");
        assert_eq!(codex.last().unwrap(), "the prompt");
    }
}
