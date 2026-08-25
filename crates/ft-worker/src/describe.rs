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
//! somebody is about to carry on working in.
//!
//! This runs its own short-lived agent instead, on the same host, with the
//! prompt and the diff. That is nearly all the context that mattered, and it
//! cannot pollute the thing it is describing. A session that has been running
//! for an hour should not be a hundred tokens closer to full because something
//! wanted a sentence for a form.
//!
//! It runs where the code is. The control plane never sees the diff, needs no
//! model credentials of its own, and gains no second opinion about work it did
//! not watch.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::Command;

/// What the agent proposes calling the work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    /// One line, in the conventional-commit shape.
    pub title: String,
    /// What it did and why, for whoever reviews it.
    pub body: String,
}

/// How much of a diff is worth sending.
///
/// A large refactor produces more than a model should be asked to read for one
/// sentence, and the interesting part of any diff is near the top of each file.
/// Truncated with a note, so the answer says "and more" rather than confidently
/// describing a third of the change.
const ENOUGH: usize = 60_000;

/// Ask, and take the first sensible answer.
///
/// Never fatal. A session that finished is finished whether or not anybody
/// could think of a name for it, and the review sheet works perfectly well with
/// an empty box.
pub async fn propose(
    agent: ft_core::Agent,
    workspace: &std::path::Path,
    asked_for: &str,
    diff: &str,
    state: &std::path::Path,
) -> Result<Proposal> {
    let diff = diff.trim();
    anyhow::ensure!(
        !diff.is_empty(),
        "nothing changed, so there is nothing to describe"
    );

    let output = Command::new(agent.command())
        // The same PATH a session gets, so describing a change uses whichever
        // copy of the agent this machine actually runs.
        .env("PATH", crate::runtime::path_with_agents(state).await)
        .args([
            "-p",
            // Cheap and quick. This is one paragraph about a diff, not the work
            // itself, and the session it describes was done by the real model.
            "--model",
            "haiku",
            // Nothing is asked of anybody. There is no session watching, so a
            // prompt here would wait forever — and this needs no tools: the
            // diff is in the question.
            "--permission-mode",
            "dontAsk",
        ])
        .arg(ask(asked_for, diff))
        .current_dir(workspace)
        // Closed, not inherited. The prompt is an argument, so there is nothing
        // to read — but an inherited pipe that never delivers is not the same
        // as no input, and the agent waits on it and then fails. Its own
        // warning names the fix: redirect stdin explicitly.
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("running {}", agent.command()))?;

    anyhow::ensure!(
        output.status.success(),
        "{} exited {}: {}",
        agent.command(),
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stderr).trim()
    );

    read(&String::from_utf8_lossy(&output.stdout)).context("the answer had no title in it")
}

/// What to ask for.
///
/// Conventional commits, because that is what the title becomes: this line ends
/// up as a commit message and as a pull request title, and half of what reads a
/// repository's history expects the prefix.
fn ask(asked_for: &str, diff: &str) -> String {
    let (diff, more) = if diff.len() > ENOUGH {
        (&diff[..ENOUGH], "\n\n[diff truncated]")
    } else {
        (diff, "")
    };

    format!(
        "Describe this change as a pull request.\n\
         \n\
         Answer with the title on the first line and nothing else on it, then a \
         blank line, then the body. No preamble, no headings, no code fences.\n\
         \n\
         The title is a conventional commit: `type(scope): summary`, where type \
         is one of feat, fix, refactor, perf, docs, test, build, ci, chore. \
         Lower case after the colon, no full stop, under 70 characters. Leave the \
         scope out rather than inventing one.\n\
         \n\
         The body is one or two short paragraphs saying what changed and why. \
         Write for somebody reviewing it who did not watch it happen. No bullet \
         list unless the change really is a list of unrelated things.\n\
         \n\
         This is what the session was asked to do:\n\
         {asked_for}\n\
         \n\
         This is what changed:\n\
         ```diff\n{diff}{more}\n```"
    )
}

/// Split an answer into a title and a body.
///
/// Defensive about the shape, because a model asked for two parts will
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

    let start = cleaned.iter().position(|line| !line.trim().is_empty())?;
    let title = cleaned[start].trim();
    // Markdown creeps in even when it is asked not to.
    let title = title
        .trim_start_matches('#')
        .trim()
        .trim_matches('`')
        .trim();
    if title.is_empty() {
        return None;
    }

    let rest = cleaned[start + 1..].join("\n");
    let (title, spilled) = shorten(title);
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
    })
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

    #[test]
    fn the_first_line_is_the_title_and_the_rest_is_the_body() {
        let got = read("feat(api): add a rate limit\n\nHolds requests per key.\n").unwrap();
        assert_eq!(got.title, "feat(api): add a rate limit");
        assert_eq!(got.body, "Holds requests per key.");
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
    fn the_prompt_asks_for_a_conventional_commit_and_carries_both_halves() {
        let asked = ask("make the thing faster", "diff --git a/x b/x");
        assert!(asked.contains("conventional commit"));
        assert!(asked.contains("make the thing faster"), "what was wanted");
        assert!(asked.contains("diff --git"), "and what happened");
    }

    #[test]
    fn a_diff_too_big_to_read_is_cut_and_says_so() {
        // Better than asking a model to read a megabyte for one sentence, and
        // better than an answer that confidently describes a third of a change.
        let huge = "x".repeat(ENOUGH * 2);
        let asked = ask("anything", &huge);
        assert!(asked.contains("[diff truncated]"));
        assert!(
            asked.len() < ENOUGH + 4_000,
            "it should be cut, not merely marked"
        );
    }
}
