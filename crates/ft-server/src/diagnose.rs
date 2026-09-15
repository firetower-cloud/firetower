//! Reading a failed connection.
//!
//! A worker speaks frames on stdout and nothing else, so a failed connection
//! leaves one piece of evidence: whatever ssh or the remote shell wrote to
//! stderr before the stream closed. Each case below has a different fix, and a
//! closed stream on its own distinguishes none of them.

use crate::transport::WORKER_BINARY;
use ft_core::{Cause, Compute, Diagnosis};

/// What a failed connection means, given what the far end said.
///
/// `status` is the child's exit code where we have it — see [`is_not_found`].
/// The text decides where the two disagree: ssh passes a remote shell's wording
/// through more reliably than its exit code.
pub fn from_output(
    stderr: &[String],
    status: Option<std::process::ExitStatus>,
    compute: &Compute,
) -> Diagnosis {
    let detail = stderr.join("\n");
    let said = detail.to_lowercase();

    let found = if worker_not_found(&said) || (is_not_found(status) && said.is_empty()) {
        // ssh got in, so the address, the account and the key are all right.
        // One thing is left, and it is one command — which is worth carrying
        // on the diagnosis rather than only in the screen that happens to know
        // about it, since every place a diagnosis is shown is a place somebody
        // is looking for this.
        Diagnosis::new(
            Cause::WorkerMissing,
            "Firetower isn't installed on that machine.",
        )
        .with_remedy(crate::install::one_liner(None))
    } else if said.contains("permission denied (publickey")
        || said.contains("no supported authentication methods")
        || said.contains("too many authentication failures")
    {
        Diagnosis::new(
            Cause::AuthRefused,
            format!("{} refused the key.", machine(compute)),
        )
    } else if said.contains("host key verification failed")
        || said.contains("remote host identification has changed")
    {
        // No remedy offered. A host answering with a different key is either
        // rebuilt or the wrong machine, and only its owner knows which.
        Diagnosis::new(
            Cause::HostKeyChanged,
            format!(
                "{} answered with a different host key than last time.",
                machine(compute)
            ),
        )
    } else if said.contains("could not resolve hostname")
        || said.contains("name or service not known")
    {
        Diagnosis::new(
            Cause::Unreachable,
            format!("{} doesn't resolve to anything.", machine(compute)),
        )
    } else if said.contains("connection timed out") || said.contains("operation timed out") {
        Diagnosis::new(
            Cause::Unreachable,
            format!(
                "Nothing answered at {}. The address, or a firewall between here and there.",
                machine(compute)
            ),
        )
    } else if said.contains("connection refused") {
        Diagnosis::new(
            Cause::Unreachable,
            format!("{} refused the connection on that port.", machine(compute)),
        )
    } else if said.contains("network is unreachable") || said.contains("no route to host") {
        Diagnosis::new(
            Cause::Unreachable,
            format!("There's no route to {} from here.", machine(compute)),
        )
    } else {
        // No guess. The detail carries the answer, and a wrong summary in
        // front of it points at the wrong machine.
        Diagnosis::new(Cause::Unknown, "That host didn't answer as a worker.")
    };

    found.with_detail(detail)
}

/// Whether the shell on the far end said it could not find the worker.
///
/// Every shell has its own wording, and two of them put the name last: bash
/// and dash say `firetower-worker: command not found`, `sh -c … exec` says
/// `exec: firetower-worker: not found`, and zsh — the login shell of every
/// Mac — says `command not found: firetower-worker`, reversed. The first
/// version of this matched the first two and sent every macOS host to the
/// fallback, with no cause and no remedy.
fn worker_not_found(said: &str) -> bool {
    let binary = WORKER_BINARY;
    said.contains(&format!("{binary}: command not found"))
        || said.contains(&format!("{binary}: not found"))
        || said.contains(&format!("command not found: {binary}"))
        || said.contains(&format!("{binary}: no such file or directory"))
}

/// A worker that spoke, in a version we don't.
pub fn protocol_mismatch(theirs: u32, ours: u32, compute: &Compute) -> Diagnosis {
    let d = Diagnosis::new(
        Cause::ProtocolMismatch,
        format!("That worker speaks protocol {theirs}; this control plane speaks {ours}."),
    );
    match compute {
        Compute::Server { .. } => d.with_remedy(format!(
            "Install the worker again from the Compute screen, or on the machine:\n{}",
            crate::install::one_liner(None)
        )),
        Compute::Local => d,
    }
}

/// Whether the far end could not run what it was asked to run.
///
/// 127 is a shell saying it found nothing by that name. 126 is a shell saying
/// it found something it could not execute — a binary for the wrong
/// architecture, or a file with no execute bit — which for our purposes is
/// the same answer: there is no worker there that runs.
fn is_not_found(status: Option<std::process::ExitStatus>) -> bool {
    matches!(status.and_then(|s| s.code()), Some(126) | Some(127))
}

/// How to name the machine in a sentence, without repeating the whole
/// destination.
fn machine(compute: &Compute) -> String {
    match compute {
        Compute::Server { host, .. } => host.clone(),
        Compute::Local => "this machine".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Compute {
        Compute::Server {
            host: "fire-01".into(),
            user: Some("deploy".into()),
            port: None,
            key: ft_core::SshKey::Default,
            host_key: None,
        }
    }

    fn code(n: i32) -> Option<std::process::ExitStatus> {
        use std::os::unix::process::ExitStatusExt;
        Some(std::process::ExitStatus::from_raw(n << 8))
    }

    fn read(lines: &[&str], compute: &Compute) -> Diagnosis {
        let lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        from_output(&lines, None, compute)
    }

    /// A machine with nothing installed on it, in every shell's words.
    #[test]
    fn a_missing_worker_is_named_whatever_the_shell_calls_it() {
        for line in [
            "bash: firetower-worker: command not found",
            "firetower-worker: line 0: exec: firetower-worker: not found",
            "zsh:1: command not found: firetower-worker",
            "sh: 1: firetower-worker: not found",
        ] {
            let d = read(&[line], &server());
            assert_eq!(d.cause, Cause::WorkerMissing, "{line}");
            assert!(d.summary.contains("isn't installed"), "{}", d.summary);

            // And says what to run. ssh worked, so this is the only thing
            // between the machine and working.
            let remedy = d.remedy.as_deref().unwrap_or_default();
            assert!(remedy.contains("worker.sh"), "{remedy}");
        }
    }

    /// The case with no text at all: the exit status is the only evidence.
    #[test]
    fn a_silent_127_is_a_missing_worker() {
        let d = from_output(&[], code(127), &server());
        assert_eq!(d.cause, Cause::WorkerMissing);
        assert!(d.remedy.is_some(), "it should say how to fix it");
    }

    /// Some other program being missing is not the worker being missing.
    #[test]
    fn a_different_missing_command_is_not_blamed_on_the_worker() {
        let d = read(&["zsh:1: command not found: docker"], &server());
        assert_eq!(d.cause, Cause::Unknown);
        assert!(d.detail.unwrap().contains("docker"));
    }

    #[test]
    fn a_refused_key_points_at_the_key_and_not_at_the_worker() {
        let d = read(
            &["deploy@fire-01: Permission denied (publickey)."],
            &server(),
        );
        assert_eq!(d.cause, Cause::AuthRefused);
        assert!(d.summary.contains("fire-01"), "{}", d.summary);
    }

    #[test]
    fn a_changed_host_key_is_never_resolved_for_you() {
        let d = read(
            &[
                "@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@",
                "Host key verification failed.",
            ],
            &server(),
        );
        assert_eq!(d.cause, Cause::HostKeyChanged);
        assert!(
            d.remedy.is_none(),
            "we do not offer to delete a known_hosts line"
        );
    }

    #[test]
    fn a_firewall_and_a_wrong_address_are_different_sentences() {
        assert_eq!(
            read(
                &["ssh: connect to host fire-01 port 22: Connection timed out"],
                &server()
            )
            .cause,
            Cause::Unreachable
        );
        assert_eq!(
            read(&["ssh: Could not resolve hostname fire-01"], &server()).cause,
            Cause::Unreachable
        );
    }

    /// The fallback admits it doesn't know and hands over everything.
    #[test]
    fn an_unrecognised_failure_keeps_the_whole_text_rather_than_guessing() {
        let d = read(
            &["something nobody has seen before", "on two lines"],
            &server(),
        );
        assert_eq!(d.cause, Cause::Unknown);
        let detail = d.detail.expect("the raw text is the answer here");
        assert!(detail.contains("something nobody has seen before"));
        assert!(detail.contains("on two lines"));
    }

    /// A recognised cause is still a guess about another machine, so the
    /// evidence has to survive it being wrong.
    #[test]
    fn the_raw_text_is_kept_even_when_the_cause_is_known() {
        let d = read(&["bash: firetower-worker: command not found"], &server());
        assert_eq!(
            d.detail.as_deref(),
            Some("bash: firetower-worker: command not found")
        );
    }

    #[test]
    fn a_protocol_mismatch_on_a_server_says_how_to_move_it() {
        let d = protocol_mismatch(12, 14, &server());
        assert_eq!(d.cause, Cause::ProtocolMismatch);
        assert!(d.remedy.unwrap().contains("worker.sh"));
        assert!(protocol_mismatch(12, 14, &Compute::Local).remedy.is_none());
    }

    #[test]
    fn silence_is_still_answered() {
        // A child that dies without a word still needs an answer.
        let d = from_output(&[], None, &server());
        assert_eq!(d.cause, Cause::Unknown);
        assert!(d.detail.is_none());
    }
}
