//! The worker containers Firetower runs on this machine.
//!
//! Lifecycle rather than transport: `DockerTransport` knows how to talk to a
//! container, and this knows how one comes to exist. It sits beside the
//! transport rather than inside a request handler, because bringing up compute
//! is not something the HTTP layer should know how to do.
//!
//! Firetower owns the containers it creates. One it merely found running is
//! left alone rather than silently adopted.

use anyhow::{Context, Result};
use tokio::process::Command;

/// Bring up a worker container, or reuse the one that's already running.
pub(crate) async fn start(image: &str, name: &str) -> Result<()> {
    // Checked before running anything, because Docker's own answer is to try
    // pulling from a registry this image was never published to — and "pull
    // access denied" sends you looking for a login you don't need.
    let present = Command::new("docker")
        .args(["image", "inspect", image])
        .output()
        .await
        .context("is Docker running?")?;

    if !present.status.success() {
        anyhow::bail!(
            "the worker image {image} hasn't been built yet. Run `just worker-image` \
             — it takes a few minutes the first time and is cached after."
        );
    }

    let running = Command::new("docker")
        .args(["inspect", "-f", "{{.State.Running}}", name])
        .output()
        .await
        .context("is Docker running?")?;

    match String::from_utf8_lossy(&running.stdout).trim() {
        "true" => return Ok(()),
        "false" => {
            Command::new("docker")
                .args(["start", name])
                .output()
                .await?;
            return Ok(());
        }
        _ => {}
    }

    let created = Command::new("docker")
        .args(["run", "-d", "--name", name, image, "sleep", "infinity"])
        .output()
        .await
        .context("starting the worker container")?;

    if !created.status.success() {
        anyhow::bail!(
            "docker refused: {}",
            String::from_utf8_lossy(&created.stderr).trim()
        );
    }
    Ok(())
}

/// Stop and remove a worker container, and the anonymous volume holding its
/// worktrees. Absent is success — the wanted state is "not there".
pub(crate) async fn remove(name: &str) -> Result<()> {
    let removed = Command::new("docker")
        .args(["rm", "--force", "--volumes", name])
        .output()
        .await
        .context("is Docker running?")?;

    let stderr = String::from_utf8_lossy(&removed.stderr);
    if !removed.status.success() && !stderr.contains("No such container") {
        anyhow::bail!("docker refused: {}", stderr.trim());
    }
    Ok(())
}
