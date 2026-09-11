//! Where this updater is, and the files it may touch.
//!
//! An updater finds its own container through the socket and reads the labels
//! Compose put on it: which project it belongs to, where that project's files
//! live on the machine, and which compose files define it. Nothing is
//! configured twice — the compose file that created the updater is the
//! compose file it runs.

use crate::docker::{Container, Docker};
use anyhow::{Context, Result};
use ft_updater_api::{DeployFile, DeployFiles};
use std::path::{Path, PathBuf};

/// Where the compose file mounts the deployment directory inside this container.
pub const DEPLOY_MOUNT: &str = "/deploy";

/// The files an upgrade is allowed to rewrite, and no others.
///
/// `.env` is deliberately not here: it holds every value somebody chose, and
/// the one file the updater must never write is the one with the password in.
pub const WRITABLE: [&str; 3] = ["firetower.yml", "Caddyfile", "Caddyfile.dockerfile"];

/// What the updater learned about its own deployment.
#[derive(Debug, Clone)]
pub struct Site {
    pub project: String,
    /// The compose service this updater is.
    pub service: String,
    /// The project's directory on the machine. What the helper mounts.
    pub deploy_dir: String,
    /// The compose files, as absolute paths on the machine.
    pub config_files: Vec<String>,
    /// The same directory, where this process can read it.
    pub mount: PathBuf,
}

impl Site {
    /// Read the labels off our own container.
    pub async fn discover(docker: &Docker) -> Result<Self> {
        let me = docker
            .inspect_container(&own_container_id()?)
            .await
            .context("finding the updater's own container — is the Docker socket mounted?")?;
        Self::from_container(&me, PathBuf::from(DEPLOY_MOUNT))
    }

    pub fn from_container(me: &Container, mount: PathBuf) -> Result<Self> {
        let label = |key: &str| {
            me.label(key).map(str::to_string).with_context(|| {
                format!(
                    "the updater's container has no `{key}` label; it has to be started by \
                     Compose, from the deployment's own firetower.yml"
                )
            })
        };
        let config_files = label("com.docker.compose.project.config_files")?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        anyhow::ensure!(
            !config_files.is_empty(),
            "Compose recorded no config files on the updater's container"
        );
        Ok(Self {
            project: label("com.docker.compose.project")?,
            service: label("com.docker.compose.service")?,
            deploy_dir: label("com.docker.compose.project.working_dir")?,
            config_files,
            mount,
        })
    }

    /// `docker compose -p <project> -f <file>…`, as the helper runs it.
    pub fn compose_args(&self) -> Vec<String> {
        let mut args = vec![
            "docker".to_string(),
            "compose".into(),
            "-p".into(),
            self.project.clone(),
        ];
        for file in &self.config_files {
            args.push("-f".into());
            args.push(file.clone());
        }
        args
    }

    /// The files an upgrade looks at, as they are now.
    pub fn deploy_files(&self) -> Result<DeployFiles> {
        let mut files = Vec::new();
        for name in WRITABLE {
            let path = self.mount.join(name);
            let content = match std::fs::read_to_string(&path) {
                Ok(text) => Some(text),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
            };
            files.push(DeployFile {
                name: name.to_string(),
                content,
            });
        }
        Ok(DeployFiles {
            files,
            env_keys: env_keys(&self.mount.join(".env")),
        })
    }

    /// Replace a file, keeping what was there as `<name>.backup`.
    ///
    /// Returns the previous contents, so a rollback can put them back without
    /// trusting the backup file to still be what was written.
    pub fn write_file(&self, name: &str, content: &str) -> Result<Option<String>> {
        anyhow::ensure!(
            WRITABLE.contains(&name),
            "{name} is not a file an upgrade may rewrite"
        );
        let path = self.mount.join(name);
        let previous = match std::fs::read_to_string(&path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        if let Some(old) = &previous {
            std::fs::write(path.with_extension(backup_extension(&path)), old)
                .with_context(|| format!("keeping a copy of {name}"))?;
        }
        write_atomically(&path, content)?;
        Ok(previous)
    }

    /// Put a file back as it was, or remove it if it was not there.
    pub fn restore_file(&self, name: &str, previous: Option<&str>) -> Result<()> {
        let path = self.mount.join(name);
        match previous {
            Some(text) => write_atomically(&path, text),
            None => match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e).with_context(|| format!("removing {}", path.display())),
            },
        }
    }

    /// Where dumps go. Made on first use.
    pub fn backups_dir(&self) -> Result<PathBuf> {
        let dir = self.mount.join("backups");
        std::fs::create_dir_all(&dir).with_context(|| format!("making {}", dir.display()))?;
        Ok(dir)
    }
}

/// `firetower.yml` → `firetower.yml.backup`, whatever the extension was.
fn backup_extension(path: &Path) -> String {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{ext}.backup"),
        None => "backup".to_string(),
    }
}

fn write_atomically(path: &Path, content: &str) -> Result<()> {
    let temporary = path.with_extension("writing");
    std::fs::write(&temporary, content)
        .with_context(|| format!("writing {}", temporary.display()))?;
    std::fs::rename(&temporary, path).with_context(|| format!("renaming into {}", path.display()))
}

/// The names set in a `.env`, and never their values.
pub fn env_keys(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    keys_in(&text)
}

pub fn keys_in(text: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        if let Some((key, _)) = line.split_once('=') {
            let key = key.trim();
            if !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                && !keys.contains(&key.to_string())
            {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

/// Docker sets a container's hostname to its id unless told otherwise.
fn own_container_id() -> Result<String> {
    if let Ok(name) = std::env::var("HOSTNAME") {
        if !name.trim().is_empty() {
            return Ok(name.trim().to_string());
        }
    }
    let read = std::fs::read_to_string("/etc/hostname").context("reading /etc/hostname")?;
    Ok(read.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(labels: &[(&str, &str)]) -> Container {
        Container {
            id: "self".into(),
            name: "firetower-updater-1".into(),
            image_ref: "ghcr.io/firetower-cloud/firetower-updater:latest".into(),
            image_id: "sha256:1".into(),
            labels: labels
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            running: true,
        }
    }

    #[test]
    fn the_site_comes_from_compose_s_own_labels() {
        let site = Site::from_container(
            &me(&[
                ("com.docker.compose.project", "firetower"),
                ("com.docker.compose.service", "updater"),
                ("com.docker.compose.project.working_dir", "/opt/firetower"),
                (
                    "com.docker.compose.project.config_files",
                    "/opt/firetower/firetower.yml",
                ),
            ]),
            PathBuf::from("/deploy"),
        )
        .unwrap();
        assert_eq!(site.project, "firetower");
        assert_eq!(site.deploy_dir, "/opt/firetower");
        assert_eq!(
            site.compose_args(),
            vec![
                "docker",
                "compose",
                "-p",
                "firetower",
                "-f",
                "/opt/firetower/firetower.yml"
            ]
        );
    }

    #[test]
    fn a_container_docker_run_started_is_refused() {
        let said = Site::from_container(&me(&[]), PathBuf::from("/deploy"))
            .unwrap_err()
            .to_string();
        assert!(said.contains("Compose"), "{said}");
    }

    #[test]
    fn env_names_are_read_and_values_are_not() {
        let keys = keys_in(
            "# comment\nPOSTGRES_PASSWORD=hunter2\n\nexport DOMAIN=x.y\nBAD LINE\nDOMAIN=again\n",
        );
        assert_eq!(keys, vec!["POSTGRES_PASSWORD", "DOMAIN"]);
    }

    #[test]
    fn writing_keeps_a_backup_and_only_touches_allowed_files() {
        let dir = tempfile::tempdir().unwrap();
        let site = Site {
            project: "p".into(),
            service: "updater".into(),
            deploy_dir: dir.path().display().to_string(),
            config_files: vec![],
            mount: dir.path().to_path_buf(),
        };
        std::fs::write(dir.path().join("firetower.yml"), "old").unwrap();

        let previous = site.write_file("firetower.yml", "new").unwrap();
        assert_eq!(previous.as_deref(), Some("old"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("firetower.yml")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("firetower.yml.backup")).unwrap(),
            "old"
        );

        site.restore_file("firetower.yml", previous.as_deref())
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("firetower.yml")).unwrap(),
            "old"
        );

        assert!(site.write_file(".env", "x").is_err(), "never the env file");
        assert!(site.write_file("../etc/passwd", "x").is_err());

        // A file that was not there is removed again on restore.
        assert!(site.write_file("Caddyfile", "c").unwrap().is_none());
        site.restore_file("Caddyfile", None).unwrap();
        assert!(!dir.path().join("Caddyfile").exists());
    }
}
