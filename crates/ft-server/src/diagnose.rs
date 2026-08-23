//! Reading a failed connection.
//!
//! A worker speaks frames on stdout and nothing else, so a failed connection
//! leaves one piece of evidence: whatever ssh, docker or the remote shell wrote
//! to stderr before the stream closed. Each case below has a different fix, and
//! a closed stream on its own distinguishes none of them.

use ft_core::{Cause, Compute, Diagnosis};

/// What a failed connection means, given what the far end said.
///
/// `status` is the child's exit code where we have it — see [`is_not_found`].
/// The text decides where the two disagree: ssh passes a remote shell's wording
/// through more reliably than its exit code. Where there is no text at all, the
/// status is all there is, and `docker exec` is exactly that case.
pub fn from_output(
    stderr: &[String],
    status: Option<std::process::ExitStatus>,
    compute: &Compute,
) -> Diagnosis {
    let detail = stderr.join("\n");
    let said = detail.to_lowercase();
    let containerised = matches!(compute, Compute::Container { .. })
        || matches!(
            compute,
            Compute::Server {
                container: Some(_),
                ..
            }
        );

    let found = if said.contains("permission denied while trying to connect to the docker daemon")
        || (said.contains("docker daemon") && said.contains("permission denied"))
    {
        Diagnosis::new(
            Cause::DockerDenied,
            "Docker is there, and this account isn't allowed to talk to it.",
        )
        .with_remedy(format!(
            "sudo usermod -aG docker {}\n# then log out and back in",
            account(compute)
        ))
    } else if said.contains("cannot connect to the docker daemon") {
        Diagnosis::new(
            Cause::DockerMissing,
            "Docker isn't running on that machine.",
        )
        .with_remedy("sudo systemctl start docker")
    } else if said.contains("no such container") || said.contains("is not running") {
        Diagnosis::new(
            Cause::ContainerMissing,
            format!("There's no {} container running there.", container(compute)),
        )
        .with_remedy("docker compose up -d")
    } else if said.contains("docker: command not found") || said.contains("docker: not found") {
        Diagnosis::new(
            Cause::DockerMissing,
            "Docker isn't installed on that machine.",
        )
    } else if said.contains("firetower-worker: command not found")
        || said.contains("firetower-worker: not found")
        // Docker phrases it its own way, and this is the one an upgrade meets:
        // an image built before the worker had its own name has `firetower` and
        // not `firetower-worker`.
        || said.contains("executable file not found")
        || said.contains("firetower: command not found")
        || said.contains("firetower: not found")
        || (is_not_found(status) && !said.contains("docker"))
    {
        // One shell message, two fixes: a container running the wrong image,
        // or a machine with nothing installed. The text says which neither.
        if containerised {
            Diagnosis::new(
                Cause::WorkerMissing,
                "That container is running, and it isn't a Firetower worker.",
            )
            .with_remedy("docker compose pull && docker compose up -d")
        } else {
            // ssh got in, so the address, the account and the key are all
            // right. One thing is left, and it is one command — which is worth
            // carrying on the diagnosis rather than only in the screen that
            // happens to know about it, since every place a diagnosis is shown
            // is a place somebody is looking for this.
            Diagnosis::new(
                Cause::WorkerMissing,
                "Firetower isn't installed on that machine.",
            )
            .with_remedy("npm i -g @firetower/cli\nfiretower worker install")
        }
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

/// A worker that spoke, in a version we don't.
pub fn protocol_mismatch(theirs: u32, ours: u32, compute: &Compute) -> Diagnosis {
    let d = Diagnosis::new(
        Cause::ProtocolMismatch,
        format!("That worker speaks protocol {theirs}; this control plane speaks {ours}."),
    );
    match compute {
        Compute::Server {
            container: Some(_), ..
        }
        | Compute::Container { .. } => d.with_remedy("docker compose pull && docker compose up -d"),
        _ => d,
    }
}

/// Whether the far end could not run what it was asked to run.
///
/// 127 is a shell saying it found nothing by that name. 126 is `docker exec`
/// saying the same about a container — and it matters here because docker
/// writes that reason to **stdout**, which this transport reads as the frame
/// stream. So the text never reaches the stderr we diagnose from, and the exit
/// status is the only evidence left:
///
/// ```text
/// $ docker exec -i old-worker firetower-worker --stdio >out 2>err; echo $?
/// 126
/// $ cat err          # empty
/// $ cat out
/// OCI runtime exec failed: … "firetower-worker": executable file not found …
/// ```
fn is_not_found(status: Option<std::process::ExitStatus>) -> bool {
    matches!(status.and_then(|s| s.code()), Some(126) | Some(127))
}

/// How to name the machine in a sentence, without repeating the whole
/// destination.
fn machine(compute: &Compute) -> String {
    match compute {
        Compute::Server { host, .. } => host.clone(),
        Compute::Container { name, .. } => name.clone(),
        Compute::Local => "this machine".to_string(),
    }
}

fn container(compute: &Compute) -> String {
    match compute {
        Compute::Server {
            container: Some(name),
            ..
        }
        | Compute::Container { name, .. } => format!("`{name}`"),
        _ => "worker".to_string(),
    }
}

/// The account the command ran as, for a remedy someone can paste.
fn account(compute: &Compute) -> String {
    match compute {
        // Absent means ssh chose, and its choice is the local username,
        // which is not on the row.
        Compute::Server { user, .. } => user.clone().unwrap_or_else(|| "$USER".to_string()),
        _ => "$USER".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_with(container: Option<&str>) -> Compute {
        Compute::Server {
            host: "fire-01".into(),
            user: Some("deploy".into()),
            port: None,
            key: ft_core::SshKey::Default,
            host_key: None,
            container: container.map(Into::into),
        }
    }

    fn server() -> Compute {
        server_with(None)
    }

    fn in_container() -> Compute {
        server_with(Some("firetower-worker"))
    }

    fn read(lines: &[&str], compute: &Compute) -> Diagnosis {
        let lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        from_output(&lines, None, compute)
    }

    /// A machine with nothing installed on it.
    #[test]
    fn a_missing_worker_is_named_rather_than_reported_as_a_closed_stream() {
        let d = read(&["bash: firetower-worker: command not found"], &server());
        assert_eq!(d.cause, Cause::WorkerMissing);
        assert!(d.summary.contains("isn't installed"), "{}", d.summary);

        // And says what to run. ssh worked, so this is the only thing between
        // the machine and working — leaving it out sent people to the docs to
        // find one line.
        let remedy = d.remedy.as_deref().unwrap_or_default();
        assert!(remedy.contains("firetower worker install"), "{remedy}");
    }

    /// The case with no text at all. `docker exec` puts its reason on stdout,
    /// which the transport reads as frames, so stderr is empty and the exit
    /// status is the only thing left to go on.
    #[test]
    fn a_container_that_cannot_run_the_worker_is_diagnosed_from_its_exit_status() {
        use std::os::unix::process::ExitStatusExt;

        let d = from_output(
            &[],
            Some(std::process::ExitStatus::from_raw(126 << 8)),
            &in_container(),
        );

        assert_eq!(d.cause, Cause::WorkerMissing);
        assert!(d.remedy.is_some(), "it should say how to fix it");
    }

    /// Docker says it differently, and this is the message an upgrade meets:
    /// a worker image built before the binary had its own name.
    #[test]
    fn an_image_without_the_worker_binary_is_a_missing_worker() {
        let d = read(
            &[
                "OCI runtime exec failed: exec failed: unable to start container \
               process: exec: \"firetower-worker\": executable file not found in $PATH: unknown",
            ],
            &in_container(),
        );

        assert_eq!(d.cause, Cause::WorkerMissing);
        assert!(d.remedy.is_some(), "it should say how to fix it");
    }

    /// Same shell message, different fix; only the host tells them apart.
    #[test]
    fn a_missing_worker_inside_a_container_is_a_wrong_image() {
        let d = read(&["bash: firetower: command not found"], &in_container());
        assert_eq!(d.cause, Cause::WorkerMissing);
        assert!(
            d.summary.contains("isn't a Firetower worker"),
            "{}",
            d.summary
        );
        assert!(d.remedy.unwrap().contains("docker compose pull"));
    }

    #[test]
    fn a_stopped_container_says_so_and_says_how_to_start_it() {
        let d = read(
            &["Error response from daemon: No such container: firetower-worker"],
            &in_container(),
        );
        assert_eq!(d.cause, Cause::ContainerMissing);
        assert_eq!(d.remedy.as_deref(), Some("docker compose up -d"));
    }

    #[test]
    fn docker_refusing_this_account_is_not_docker_being_absent() {
        // Near-identical wording, unrelated fixes.
        let denied = read(
            &["permission denied while trying to connect to the Docker daemon socket"],
            &in_container(),
        );
        assert_eq!(denied.cause, Cause::DockerDenied);
        assert!(denied.remedy.unwrap().contains("usermod -aG docker deploy"));

        let stopped = read(
            &["Cannot connect to the Docker daemon at unix:///var/run/docker.sock."],
            &in_container(),
        );
        assert_eq!(stopped.cause, Cause::DockerMissing);
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
        let d = read(&["bash: firetower: command not found"], &server());
        assert_eq!(
            d.detail.as_deref(),
            Some("bash: firetower: command not found")
        );
    }

    #[test]
    fn silence_is_still_answered() {
        // A child that dies without a word still needs an answer.
        let d = from_output(&[], None, &server());
        assert_eq!(d.cause, Cause::Unknown);
        assert!(d.detail.is_none());
    }
}
