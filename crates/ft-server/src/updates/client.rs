//! The control plane's side of the updater API.

use anyhow::{anyhow, Context, Result};
use ft_updater_api::{DeployFiles, Job, JobKind, NewJob, Refusal, Status, TOKEN_ENV, URL_ENV};
use std::time::Duration;

#[derive(Clone)]
pub struct Updater {
    base: String,
    token: String,
    http: reqwest::Client,
}

/// Why there is no updater to talk to, in words for the screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Absent {
    /// `FIRETOWER_UPDATER_URL` is not set: this install predates the updater.
    NotConfigured,
    /// The URL is there and the token is not.
    NoToken,
}

impl Absent {
    pub fn explain(&self) -> String {
        match self {
            Absent::NotConfigured => format!(
                "this install has no updater yet. Run `firetower upgrade` once on the machine \
                 to add it; after that the control plane can upgrade itself from here. \
                 ({URL_ENV} is not set.)"
            ),
            Absent::NoToken => format!(
                "{TOKEN_ENV} is not set in .env, so the control plane cannot talk to the updater. \
                 Add one line — `{TOKEN_ENV}=$(openssl rand -hex 32)` — and start both again."
            ),
        }
    }
}

impl Updater {
    pub fn from_env() -> Result<Self, Absent> {
        let base = std::env::var(URL_ENV)
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .ok_or(Absent::NotConfigured)?;
        let token = std::env::var(TOKEN_ENV)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or(Absent::NoToken)?;
        Ok(Self::new(base, token))
    }

    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            base: base.into(),
            token: token.into(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("a client"),
        }
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
    }

    async fn read<T: serde::de::DeserializeOwned>(
        response: reqwest::Response,
        what: &str,
    ) -> Result<T> {
        let status = response.status();
        if status.is_success() {
            return response
                .json()
                .await
                .with_context(|| format!("reading {what}"));
        }
        let said = response
            .json::<Refusal>()
            .await
            .map(|r| r.message)
            .unwrap_or_else(|_| status.to_string());
        Err(anyhow!("the updater refused {what}: {said}"))
    }

    pub async fn status(&self) -> Result<Status> {
        let response = self
            .request(reqwest::Method::GET, "/v1/status")
            .send()
            .await
            .context("reaching the updater")?;
        Self::read(response, "its status").await
    }

    pub async fn deploy_files(&self) -> Result<DeployFiles> {
        let response = self
            .request(reqwest::Method::GET, "/v1/deploy")
            .send()
            .await
            .context("reaching the updater")?;
        Self::read(response, "the deployment files").await
    }

    /// Start a job. A job already running comes back as the error's text.
    pub async fn start(&self, kind: JobKind) -> Result<Job> {
        let response = self
            .request(reqwest::Method::POST, "/v1/jobs")
            .json(&NewJob { kind })
            .send()
            .await
            .context("reaching the updater")?;
        if response.status() == reqwest::StatusCode::CONFLICT {
            let running: Job = response.json().await.context("reading the running job")?;
            return Err(anyhow!(
                "the updater is still busy with an earlier job ({})",
                running.kind.label()
            ));
        }
        Self::read(response, "a job").await
    }

    /// `Ok(None)` when the updater does not know the job — it was recreated
    /// since, and its memory went with it.
    pub async fn job(&self, id: &str) -> Result<Option<Job>> {
        let response = self
            .request(reqwest::Method::GET, &format!("/v1/jobs/{id}"))
            .send()
            .await
            .context("reaching the updater")?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Self::read(response, "the job").await.map(Some)
    }
}
