//! Recreating a worker container on its machine, from what it already is.
//!
//! `firetower worker install` creates the container with `docker run`;
//! `deploy/firetower-worker.yml` creates it with Compose. Either way the
//! machine holds the whole description in `docker inspect`, and the upgrade
//! is read from there rather than assumed: a worker somebody gave a memory
//! ceiling, an extra mount or `FIRETOWER_WORKER_DOCKER=off` comes back with
//! all of it.
//!
//! What is run is what `firetower worker upgrade` runs — pull, remove, run
//! with the same volumes — or, for a Compose-managed container, `compose pull
//! && compose up -d` in its own directory. The image reference is the one the
//! container was made from: a worker on `:latest` moves to the newest release,
//! and one pinned to a version is reported rather than moved.

use anyhow::{Context, Result};
use serde_json::Value;
use std::collections::BTreeMap;

/// How a worker container will be recreated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// Compose owns it: run Compose where it was run.
    Compose {
        dir: String,
        files: Vec<String>,
        service: String,
    },
    /// `docker run` made it: make it again, from its own description.
    Run { image: String, args: Vec<String> },
    /// The compose file or the `docker run` named a version, not `latest`.
    Pinned { image: String },
}

/// Read `docker inspect <container>` and `docker image inspect <its image>`
/// into a plan.
pub fn plan_from_inspect(container: &Value, image: &Value) -> Result<Plan> {
    let container = first(container).context("`docker inspect` returned nothing")?;
    let image = first(image).context("`docker image inspect` returned nothing")?;

    let reference = container
        .pointer("/Config/Image")
        .and_then(Value::as_str)
        .context("the container has no image reference")?
        .to_string();

    if tag_is_pinned(&reference) {
        return Ok(Plan::Pinned { image: reference });
    }

    let labels = strings(container.pointer("/Config/Labels"));
    if let Some(dir) = labels.get("com.docker.compose.project.working_dir") {
        let files = labels
            .get("com.docker.compose.project.config_files")
            .map(|s| {
                s.split(',')
                    .map(|f| f.trim().to_string())
                    .filter(|f| !f.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let service = labels
            .get("com.docker.compose.service")
            .cloned()
            .context("a Compose-managed container without a service label")?;
        return Ok(Plan::Compose {
            dir: dir.clone(),
            files,
            service,
        });
    }

    let host = container.get("HostConfig").cloned().unwrap_or(Value::Null);
    let mut args: Vec<String> = Vec::new();

    if host.get("Privileged").and_then(Value::as_bool) == Some(true) {
        args.push("--privileged".into());
    }
    if host.get("Init").and_then(Value::as_bool) == Some(true) {
        args.push("--init".into());
    }
    if let Some(policy) = host
        .pointer("/RestartPolicy/Name")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty() && *p != "no")
    {
        args.push("--restart".into());
        args.push(policy.to_string());
    }
    if let Some(memory) = host
        .get("Memory")
        .and_then(Value::as_i64)
        .filter(|m| *m > 0)
    {
        args.push("--memory".into());
        args.push(memory.to_string());
        if let Some(swap) = host
            .get("MemorySwap")
            .and_then(Value::as_i64)
            .filter(|m| *m > 0)
        {
            args.push("--memory-swap".into());
            args.push(swap.to_string());
        }
    }
    if let Some(parent) = host
        .get("CgroupParent")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    {
        args.push("--cgroup-parent".into());
        args.push(parent.to_string());
    }
    if let Some(network) = host
        .get("NetworkMode")
        .and_then(Value::as_str)
        .filter(|n| !n.is_empty() && *n != "default" && *n != "bridge")
    {
        args.push("--network".into());
        args.push(network.to_string());
    }

    // Volumes and binds, as the container reports them mounted.
    if let Some(mounts) = container.get("Mounts").and_then(Value::as_array) {
        for mount in mounts {
            let kind = mount
                .get("Type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let dest = mount
                .get("Destination")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let source = match kind {
                "volume" => mount.get("Name").and_then(Value::as_str),
                "bind" => mount.get("Source").and_then(Value::as_str),
                _ => None,
            };
            let (Some(source), false) = (source, dest.is_empty()) else {
                continue;
            };
            let mut spec = format!("{source}:{dest}");
            if mount.get("RW").and_then(Value::as_bool) == Some(false) {
                spec.push_str(":ro");
            }
            args.push("-v".into());
            args.push(spec);
        }
    }

    // Only what was set on the container beyond what the image already
    // carries. Passing the image's own PATH back in would pin the old
    // image's defaults over the new one's.
    let image_env = list(image.pointer("/Config/Env"));
    for var in list(container.pointer("/Config/Env")) {
        if !image_env.contains(&var) {
            args.push("-e".into());
            args.push(var);
        }
    }

    let image_labels = strings(image.pointer("/Config/Labels"));
    for (key, value) in &labels {
        if image_labels.get(key) != Some(value) {
            args.push("--label".into());
            args.push(format!("{key}={value}"));
        }
    }

    // The command, only where it differs from the image's own.
    let image_cmd = list(image.pointer("/Config/Cmd"));
    let cmd = list(container.pointer("/Config/Cmd"));
    let trailing = if cmd != image_cmd { cmd } else { Vec::new() };

    let mut all = args;
    all.push(reference.clone());
    all.extend(trailing);
    Ok(Plan::Run {
        image: reference,
        args: all,
    })
}

/// The script that carries out a plan, ending with the line `verify` reads.
pub fn script(plan: &Plan, container: &str) -> Result<String> {
    let verify = format!(
        "docker inspect -f '{{{{index .Config.Labels \"org.opencontainers.image.version\"}}}}' {}",
        quote(container)
    );
    Ok(match plan {
        Plan::Pinned { image } => anyhow::bail!(
            "{image} is pinned to a version on that machine. Change it to :latest there — in \
             the compose file, or by recreating it with `firetower worker install` — and \
             Firetower can move it"
        ),
        Plan::Compose {
            dir,
            files,
            service,
        } => {
            let mut compose = String::from("docker compose");
            for file in files {
                compose.push_str(" -f ");
                compose.push_str(&quote(file));
            }
            format!(
                "set -e\ncd {dir}\n{compose} pull {service}\n{compose} up -d {service}\n{verify}\n",
                dir = quote(dir),
                service = quote(service),
            )
        }
        Plan::Run { image, args } => {
            let run: Vec<String> = args.iter().map(|a| quote(a)).collect();
            format!(
                "set -e\ndocker pull {image}\ndocker rm -f {name} >/dev/null\ndocker run -d --name {name} {run}\n{verify}\n",
                image = quote(image),
                name = quote(container),
                run = run.join(" "),
            )
        }
    })
}

/// The version the recreated container's image is stamped with, read from the
/// last line of the script's output.
pub fn version_from_output(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// A name a container may have. Docker's own rule, and the only value from a
/// form that reaches a remote shell.
pub fn valid_container_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Single-quote for `sh`. Nothing inside a single-quoted string is special
/// except the quote itself.
pub fn quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\\''"))
}

/// A full `x.y.z` tag is a pin; `latest`, `edge` and `x.y` float.
fn tag_is_pinned(reference: &str) -> bool {
    let after_slash = reference.rfind('/').map(|i| i + 1).unwrap_or(0);
    let Some(colon) = reference[after_slash..].rfind(':') else {
        return false;
    };
    let tag = &reference[after_slash + colon + 1..];
    let parts: Vec<&str> = tag.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn first(v: &Value) -> Option<&Value> {
    match v {
        Value::Array(a) => a.first(),
        Value::Object(_) => Some(v),
        _ => None,
    }
}

fn strings(v: Option<&Value>) -> BTreeMap<String, String> {
    v.and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `firetower worker install` leaves behind, trimmed to what is read.
    fn installed_by_cli() -> Value {
        serde_json::json!([{
            "Config": {
                "Image": "ghcr.io/firetower-cloud/firetower-worker:latest",
                "Env": ["PATH=/usr/bin", "HOME=/var/lib/firetower/home", "FIRETOWER_WORKER_DOCKER=off"],
                "Cmd": ["sleep", "infinity"],
                "Labels": {"org.opencontainers.image.version": "0.30.1", "com.example.owner": "kevin"}
            },
            "HostConfig": {
                "Privileged": true,
                "Init": true,
                "RestartPolicy": {"Name": "unless-stopped"},
                "Memory": 17179869184i64,
                "MemorySwap": 17179869184i64,
                "NetworkMode": "bridge"
            },
            "Mounts": [
                {"Type": "volume", "Name": "firetower", "Destination": "/var/lib/firetower", "RW": true},
                {"Type": "volume", "Name": "firetower-docker", "Destination": "/var/lib/docker", "RW": true},
                {"Type": "bind", "Source": "/home/deploy/.ssh/authorized_keys", "Destination": "/root/.ssh/authorized_keys", "RW": false}
            ]
        }])
    }

    fn image() -> Value {
        serde_json::json!([{
            "Config": {
                "Env": ["PATH=/usr/bin", "HOME=/var/lib/firetower/home"],
                "Cmd": ["sleep", "infinity"],
                "Labels": {"org.opencontainers.image.version": "0.30.1"}
            }
        }])
    }

    #[test]
    fn a_container_docker_run_made_is_made_again_from_its_own_description() {
        let plan = plan_from_inspect(&installed_by_cli(), &image()).unwrap();
        let Plan::Run { image, args } = plan else {
            panic!("expected a run plan: {plan:?}");
        };
        assert_eq!(image, "ghcr.io/firetower-cloud/firetower-worker:latest");

        let joined = args.join(" ");
        assert!(joined.contains("--privileged"), "{joined}");
        assert!(joined.contains("--init"), "{joined}");
        assert!(joined.contains("--restart unless-stopped"), "{joined}");
        assert!(
            joined.contains("--memory 17179869184 --memory-swap 17179869184"),
            "{joined}"
        );
        assert!(
            joined.contains("-v firetower:/var/lib/firetower"),
            "{joined}"
        );
        assert!(
            joined.contains("-v firetower-docker:/var/lib/docker"),
            "{joined}"
        );
        assert!(
            joined.contains("-v /home/deploy/.ssh/authorized_keys:/root/.ssh/authorized_keys:ro"),
            "{joined}"
        );
        // The operator's setting survives; the image's own environment is not
        // pinned over the new image's.
        assert!(
            joined.contains("-e FIRETOWER_WORKER_DOCKER=off"),
            "{joined}"
        );
        assert!(!joined.contains("-e PATH="), "{joined}");
        assert!(!joined.contains("-e HOME="), "{joined}");
        // Labels somebody added are kept; the image's own are not repeated.
        assert!(
            joined.contains("--label com.example.owner=kevin"),
            "{joined}"
        );
        assert!(!joined.contains("org.opencontainers"), "{joined}");
        // The image comes last, and no command after it because it is the
        // image's own.
        assert_eq!(
            args.last().unwrap(),
            "ghcr.io/firetower-cloud/firetower-worker:latest"
        );
        assert!(
            !joined.contains("--network"),
            "bridge is the default: {joined}"
        );
    }

    #[test]
    fn a_command_that_differs_from_the_image_s_is_kept() {
        let mut c = installed_by_cli();
        c[0]["Config"]["Cmd"] = serde_json::json!(["sleep", "1d"]);
        let Plan::Run { args, .. } = plan_from_inspect(&c, &image()).unwrap() else {
            panic!()
        };
        assert_eq!(&args[args.len() - 2..], &["sleep", "1d"]);
    }

    #[test]
    fn a_compose_managed_container_is_upgraded_by_compose_where_it_lives() {
        let mut c = installed_by_cli();
        c[0]["Config"]["Labels"] = serde_json::json!({
            "com.docker.compose.project.working_dir": "/opt/firetower",
            "com.docker.compose.project.config_files": "/opt/firetower/firetower-worker.yml",
            "com.docker.compose.service": "worker"
        });
        let plan = plan_from_inspect(&c, &image()).unwrap();
        assert_eq!(
            plan,
            Plan::Compose {
                dir: "/opt/firetower".into(),
                files: vec!["/opt/firetower/firetower-worker.yml".into()],
                service: "worker".into()
            }
        );
        let s = script(&plan, "firetower-worker").unwrap();
        assert!(s.contains("cd '/opt/firetower'"), "{s}");
        assert!(
            s.contains("docker compose -f '/opt/firetower/firetower-worker.yml' pull 'worker'"),
            "{s}"
        );
        assert!(s.contains("up -d 'worker'"), "{s}");
        assert!(s.trim_end().ends_with("'firetower-worker'"), "{s}");
    }

    #[test]
    fn a_pinned_image_is_reported_rather_than_moved() {
        let mut c = installed_by_cli();
        c[0]["Config"]["Image"] =
            serde_json::json!("ghcr.io/firetower-cloud/firetower-worker:0.29.0");
        let plan = plan_from_inspect(&c, &image()).unwrap();
        assert!(matches!(plan, Plan::Pinned { .. }));
        let said = script(&plan, "firetower-worker").unwrap_err().to_string();
        assert!(said.contains("pinned"), "{said}");

        // `x.y` floats, and a registry port is not a tag.
        assert!(!tag_is_pinned("ghcr.io/x/y:0.29"));
        assert!(!tag_is_pinned("localhost:5000/y"));
        assert!(tag_is_pinned("localhost:5000/y:1.2.3"));
    }

    #[test]
    fn the_run_script_is_what_worker_upgrade_runs() {
        let plan = plan_from_inspect(&installed_by_cli(), &image()).unwrap();
        let s = script(&plan, "firetower-worker").unwrap();
        let lines: Vec<&str> = s.lines().collect();
        assert_eq!(lines[0], "set -e");
        assert_eq!(
            lines[1],
            "docker pull 'ghcr.io/firetower-cloud/firetower-worker:latest'"
        );
        assert_eq!(lines[2], "docker rm -f 'firetower-worker' >/dev/null");
        assert!(
            lines[3].starts_with("docker run -d --name 'firetower-worker' '--privileged'"),
            "{}",
            lines[3]
        );
        assert!(lines[4].starts_with("docker inspect -f"), "{}", lines[4]);
    }

    #[test]
    fn everything_that_reaches_a_shell_is_quoted() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("it's"), "'it'\\''s'");
        assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn a_container_name_is_docker_s_own_rule() {
        assert!(valid_container_name("firetower-worker"));
        assert!(valid_container_name("w1.a_b"));
        assert!(!valid_container_name(""));
        assert!(!valid_container_name("-leading"));
        assert!(!valid_container_name("a b"));
        assert!(!valid_container_name("x;rm"));
    }

    #[test]
    fn the_version_is_the_last_thing_the_script_prints() {
        assert_eq!(
            version_from_output("latest: Pulling from x\nabc123\n0.31.0\n").as_deref(),
            Some("0.31.0")
        );
        assert!(version_from_output("").is_none());
    }
}
