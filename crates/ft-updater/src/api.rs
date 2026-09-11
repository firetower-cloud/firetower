//! The updater's API: three reads and one write, all behind one token.
//!
//! Reachable on the compose network and nowhere else — the port is never
//! published — and every request has to carry the token both containers were
//! given from `.env`. Compared in constant time, because the thing behind this
//! API is the machine's Docker socket.

use crate::jobs::Jobs;
use axum::{
    extract::{Path, Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use ft_updater_api::{DeployFiles, Job, NewJob, Refusal, Status, API_VERSION, TOKEN_ENV};
use utoipa::OpenApi;
use utoipa_axum::{router::OpenApiRouter, routes};

#[derive(Clone)]
pub struct App {
    pub jobs: Jobs,
    pub docker: crate::docker::Docker,
    /// The token to require. `None` means the install never set one, and every
    /// request is refused with a message that says which line to add.
    pub token: Option<std::sync::Arc<str>>,
}

impl App {
    pub fn token_from_env() -> Option<std::sync::Arc<str>> {
        std::env::var(TOKEN_ENV)
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .map(Into::into)
    }
}

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    (
        status,
        Json(Refusal {
            message: message.into(),
        }),
    )
        .into_response()
}

/// The gate. One path is open: the health check, which says nothing.
pub async fn require_token(State(app): State<App>, request: Request, next: Next) -> Response {
    if request.uri().path() == "/healthz" {
        return next.run(request).await;
    }
    let Some(expected) = app.token.as_deref() else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("the updater has no token: set {TOKEN_ENV} in .env for both services and start again"),
        );
    };
    let offered = request
        .headers()
        .get(ft_updater_api::TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or_default();
    if !same(offered.as_bytes(), expected.as_bytes()) {
        return refuse(StatusCode::UNAUTHORIZED, "wrong or missing updater token");
    }
    next.run(request).await
}

/// Equal, without the comparison time saying where they differ.
pub fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[utoipa::path(
    get, path = "/v1/status", tag = "updater",
    responses((status = 200, body = Status)),
)]
async fn status(State(app): State<App>) -> Result<Json<Status>, Response> {
    let docker_version = app.docker.version().await.map_err(|e| {
        refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            format!("Docker is not answering: {e:#}"),
        )
    })?;
    // The helper that recreated this updater outlives the process that
    // started it and may still have been running when this one swept at
    // boot. Status is asked rarely enough for this to cost nothing.
    app.jobs.sweep_helpers().await;
    let site = app.jobs.site();
    Ok(Json(Status {
        version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: API_VERSION,
        project: site.project.clone(),
        deploy_dir: site.deploy_dir.clone(),
        config_files: site.config_files.clone(),
        docker_version,
        busy: app.jobs.busy(),
    }))
}

#[utoipa::path(
    get, path = "/v1/deploy", tag = "updater",
    responses((status = 200, body = DeployFiles)),
)]
async fn deploy(State(app): State<App>) -> Result<Json<DeployFiles>, Response> {
    app.jobs
        .site()
        .deploy_files()
        .map(Json)
        .map_err(|e| refuse(StatusCode::INTERNAL_SERVER_ERROR, format!("{e:#}")))
}

#[utoipa::path(
    post, path = "/v1/jobs", tag = "updater",
    request_body = NewJob,
    responses((status = 202, body = Job), (status = 409, body = Job, description = "Another job is running")),
)]
async fn create_job(State(app): State<App>, Json(req): Json<NewJob>) -> Response {
    match app.jobs.start(req.kind) {
        Ok(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
        Err(running) => (StatusCode::CONFLICT, Json(*running)).into_response(),
    }
}

#[utoipa::path(
    get, path = "/v1/jobs/{id}", tag = "updater",
    params(("id" = String, Path, description = "Job id")),
    responses((status = 200, body = Job), (status = 404, body = Refusal)),
)]
async fn get_job(State(app): State<App>, Path(id): Path<String>) -> Response {
    match app.jobs.get(&id) {
        Some(job) => Json(job).into_response(),
        None => refuse(
            StatusCode::NOT_FOUND,
            "no such job — the updater may have been recreated since it was started",
        ),
    }
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Firetower updater", version = env!("CARGO_PKG_VERSION")),
    components(schemas(ft_updater_api::JobKind, ft_updater_api::JobState, ft_updater_api::JobStep))
)]
pub struct ApiDoc;

pub fn router() -> OpenApiRouter<App> {
    OpenApiRouter::with_openapi(ApiDoc::openapi())
        .routes(routes!(status))
        .routes(routes!(deploy))
        .routes(routes!(create_job))
        .routes(routes!(get_job))
}

/// The contract, for `just gen`.
pub fn openapi() -> utoipa::openapi::OpenApi {
    let (_, api) = router().split_for_parts();
    let mut doc = ApiDoc::openapi();
    doc.paths = api.paths;
    if let Some(components) = api.components {
        match doc.components.as_mut() {
            Some(existing) => existing.schemas.extend(components.schemas),
            None => doc.components = Some(components),
        }
    }
    doc
}

pub fn app(app: App) -> axum::Router {
    let (router, _) = router().with_state(app.clone()).split_for_parts();
    axum::Router::new()
        .route("/healthz", axum::routing::get(|| async { "ok" }))
        .merge(router)
        .layer(axum::middleware::from_fn_with_state(app, require_token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_compare_whole() {
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
        assert!(!same(b"", b"a"));
    }

    #[test]
    fn the_contract_lists_every_route() {
        let doc = serde_json::to_string(&openapi()).unwrap();
        for path in ["/v1/status", "/v1/deploy", "/v1/jobs", "/v1/jobs/{id}"] {
            assert!(doc.contains(path), "{path} is missing");
        }
    }
}
