//! What this machine has, and what of it Firetower is using.
//!
//! Reported to the control plane so a person choosing where to put work can see
//! whether there is room for it, and so a workspace that was stopped for going
//! over its memory can say so instead of looking like a crash.
//!
//! ## Whose disk is whose
//!
//! Two numbers, deliberately. `disk_used_mb` is the machine's, and it is here
//! as context — a host at 98% is worth knowing about wherever the bytes came
//! from. `disk_firetower_mb` is ours: images our sessions pulled, the cache
//! their builds left, the containers they started. Only the second is ever
//! offered for clearing, because the rest of that disk belongs to whoever owns
//! the machine and tidying it is not Firetower's to offer.
//!
//! ## Why the reclaimable figure is not Docker's
//!
//! `docker system df` calls an image reclaimable when no container is running
//! from it, which on a daemon shared by every session on a worker describes
//! every image the next session was about to use. Reclaiming on that number
//! would empty the image cache the worker's volume exists to keep — the one
//! whose absence makes every upgrade cost a fresh pull of postgres and node.
//!
//! So the safe figure here is the build cache, which is rebuildable by
//! definition and costs time rather than anything else. What Docker calls
//! reclaimable is carried separately, for an interface to offer as the
//! deliberate choice it is.

use ft_core::Capacity;
use tokio::process::Command;

/// How long the daemon gets to answer before this gives up on it.
///
/// Short, and shorter than [`crate::docker::PATIENCE`]: this runs on a timer
/// and a wedged daemon must not hold the loop that reports everything else.
/// Missing numbers draw as no capacity block; a stalled worker draws as an
/// offline host.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(5);

/// Everything about this machine worth reporting.
pub async fn read() -> Capacity {
    let (memory_mb, memory_used_mb) = memory();
    let (disk_total_mb, disk_used_mb) = disk().await;
    let (disk_firetower_mb, disk_reclaimable_mb, disk_cached_images_mb) = docker_disk().await;

    Capacity {
        memory_mb,
        memory_used_mb,
        disk_total_mb,
        disk_used_mb,
        disk_firetower_mb,
        disk_reclaimable_mb,
        disk_cached_images_mb,
    }
}

/// What this worker may use, and what it is using.
///
/// The cgroup first. A worker in a container with `--memory` set has a ceiling
/// that is lower than the machine's, and the ceiling is what its sessions
/// actually get — reporting the machine's 32 GB to somebody whose worker will
/// be killed at 4 would be worse than reporting nothing.
///
/// `/proc/meminfo` is the fallback and is not namespaced, so in a container
/// with no ceiling it correctly reports the machine the container is on.
fn memory() -> (u64, u64) {
    let limit = std::fs::read_to_string("/sys/fs/cgroup/memory.max")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|bytes| bytes / 1024 / 1024);

    let used = std::fs::read_to_string("/sys/fs/cgroup/memory.current")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .map(|bytes| bytes / 1024 / 1024);

    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let field = |key: &str| -> Option<u64> {
        meminfo
            .lines()
            .find_map(|l| l.strip_prefix(key))?
            .split_whitespace()
            .next()?
            .parse::<u64>()
            .ok()
            .map(|kb| kb / 1024)
    };

    let total = limit.or_else(|| field("MemTotal:")).unwrap_or(0);
    // Total less available, rather than `MemFree`: the kernel counts page cache
    // as used, and a machine that has read a large repository once would report
    // itself nearly full for no reason anybody would recognise.
    let used = used
        .or_else(|| Some(total.saturating_sub(field("MemAvailable:")?)))
        .unwrap_or(0);

    (total, used.min(total))
}

/// The disk the daemon keeps its images on, which on a worker is also the disk
/// the worker itself is on.
async fn disk() -> (u64, u64) {
    // `-P` for the one-line-per-filesystem format, `-m` for megabytes. Parsed
    // rather than asked of `statvfs` because a worker shells out for everything
    // else it wants to know, and this adds no dependency to do it.
    let Some(out) = run(Command::new("df").args(["-Pm", "/var/lib/docker"])).await else {
        return (0, 0);
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let Some(line) = text.lines().nth(1) else {
        return (0, 0);
    };
    let mut fields = line.split_whitespace().skip(1);
    let total = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
    let used = fields.next().and_then(|f| f.parse().ok()).unwrap_or(0);
    (total, used)
}

/// What Firetower is using of that disk: (ours, safe to clear, cached images).
async fn docker_disk() -> (u64, u64, u64) {
    let Some(out) = run(Command::new("docker").args(["system", "df", "--format", "json"])).await
    else {
        return (0, 0, 0);
    };

    let (mut ours, mut safe, mut images) = (0, 0, 0);
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let size = row.get("Size").and_then(|v| v.as_str()).unwrap_or("0B");
        let reclaimable = row
            .get("Reclaimable")
            .and_then(|v| v.as_str())
            .unwrap_or("0B");
        let size = megabytes(size);
        ours += size;

        match row.get("Type").and_then(|v| v.as_str()) {
            // Rebuildable by definition: clearing it costs one slower build and
            // nothing else, which is what makes it the figure worth offering.
            Some("Build Cache") => safe += size,
            // Docker's own reclaimable, kept apart. See this module's header.
            Some("Images") => images += megabytes(reclaimable),
            _ => {}
        }
    }
    (ours, safe, images)
}

/// One of Docker's human sizes — `436MB`, `1.2GB`, `24.58kB` — as megabytes.
///
/// Rounded down, and zero for anything unrecognised. A size this cannot read is
/// a meter drawn slightly short, which is the right way to be wrong about how
/// much space somebody has.
fn megabytes(size: &str) -> u64 {
    let size = size.trim();
    // Docker writes `436MB (99%)` in the reclaimable column.
    let size = size.split_whitespace().next().unwrap_or(size);

    let digits = size
        .trim_end_matches(|c: char| c.is_ascii_alphabetic())
        .trim();
    let unit = &size[digits.len()..];
    let Ok(number) = digits.parse::<f64>() else {
        return 0;
    };

    // Docker's units are powers of 1000, not 1024 — `docker system df` prints
    // what `units.HumanSize` produced, and that divides by 1000.
    let scale = match unit.to_ascii_lowercase().as_str() {
        "b" => 1.0 / 1_000_000.0,
        "kb" => 1.0 / 1000.0,
        "mb" => 1.0,
        "gb" => 1000.0,
        "tb" => 1_000_000.0,
        _ => return 0,
    };
    (number * scale) as u64
}

/// Run a command, or give up on it. See [`PATIENCE`].
async fn run(command: &mut Command) -> Option<std::process::Output> {
    command.stdin(std::process::Stdio::null());
    match tokio::time::timeout(PATIENCE, command.output()).await {
        Ok(Ok(out)) if out.status.success() => Some(out),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dockers_sizes_are_read_in_its_own_units() {
        assert_eq!(megabytes("436MB"), 436);
        assert_eq!(megabytes("1.2GB"), 1200);
        assert_eq!(megabytes("2TB"), 2_000_000);
        assert_eq!(megabytes("0B"), 0);
        // Under a megabyte rounds down to none, which is what a meter should
        // show for it.
        assert_eq!(megabytes("24.58kB"), 0);
    }

    /// The reclaimable column carries a percentage after the size.
    #[test]
    fn a_size_with_a_percentage_after_it_is_still_a_size() {
        assert_eq!(megabytes("436MB (99%)"), 436);
    }

    /// A size this cannot read must be zero rather than a panic or a guess: it
    /// is drawn as free space somebody is about to rely on.
    #[test]
    fn anything_unrecognised_is_no_space_rather_than_a_guess() {
        assert_eq!(megabytes(""), 0);
        assert_eq!(megabytes("lots"), 0);
        assert_eq!(megabytes("12PB"), 0);
        assert_eq!(megabytes("MB"), 0);
    }

    /// Whatever this machine is, it has some memory and is using some of it,
    /// and it can never be using more than it has — which is what the meters
    /// drawn from this assume.
    #[test]
    fn a_machine_reports_memory_it_could_actually_have() {
        let (total, used) = memory();
        assert!(total > 0, "no total memory");
        assert!(used <= total, "using {used} of {total}");
    }
}
