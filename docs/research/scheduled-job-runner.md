# Where can a scheduled job run and still reach Cloud SQL?

Research for [firetower-cloud/firetower#401](https://github.com/firetower-cloud/firetower/issues/401),
on the wayfinder map [#399](https://github.com/firetower-cloud/firetower/issues/399)
(*How much, and how well, does firetower ship? — a DORA dashboard beside telemetry*).
Decided in [#404](https://github.com/firetower-cloud/firetower/issues/404), which is
blocked on this.

**The question.** A scheduled job needs to read the GitHub API for
`firetower-cloud/firetower` and write the result into the telemetry Postgres
database. The database is deliberately unreachable from outside Google Cloud.
Where can the job run, and what does each option cost to stand up?

---

## Headline

**The obvious answer is not dead.** A GitHub-hosted runner *can* reach this Cloud
SQL instance, by running the Cloud SQL Auth Proxy with the Workload Identity
Federation credentials the repo already mints for deploys. The map's working
assumption — *"**A GitHub Actions job cannot reach Cloud SQL**, so the obvious
'schedule it in CI' answer is probably not available"* — is **refuted**. The
`backend/README.md` sentence it rests on is accurate; the inference drawn from it
is not. Section 1 has Google's own words.

**Cost does not decide this.** Every serious candidate lands at **$0.00/month**
at both hourly and daily cadence, because all of them fit inside Google Cloud's
permanent free tiers. The one exception is the in-process-timer option, which
costs **~$45/month** and is rejected for that reason among others.

**So the decision is about credentials, not money.** The two live options are
mirror images:

| | database credential | GitHub credential |
|---|---|---|
| **GitHub Actions** | leaves GCP, lands in a runner's filesystem every run | free and automatic (`secrets.GITHUB_TOKEN`), but capped at **1,000 req/hour** |
| **Cloud Run Job** | never leaves `firetower-prod-506201` | a stored PAT somebody has to **rotate**, at 5,000 req/hour |

**Recommendation: Cloud Run Job + Cloud Scheduler.** $0.00/month at both
cadences, **daily** cadence. It keeps a write credential to the telemetry
database inside the project, which is the property the whole of
`backend/README.md`'s deployment section is built around. The price is ~13
Terraform resources in `firetower-terraform` plus **one step that only a project
owner can do**. Section 5 has the full reasoning and the rejections.

---

## 0. What I could and could not verify

Stated up front, because several claims below are grounded differently.

**Verified against the repositories.** `backend/` is checked out here.
`firetower-cloud/firetower-terraform` is **not** checked out in this workspace —
but it is readable with `gh`, and I cloned it read-only and read all of
`modules/backend/main.tf`, `envs/prod/*`, `bootstrap/bootstrap.sh` and
`.github/workflows/terraform.yml`. Every Terraform claim below quotes that
repository at `main` rather than guessing. This is a real improvement on the
ticket's expectation and worth knowing for the rest of the map: **the Terraform
is readable from here even though it is not checked out.**

**Verified against vendor documentation.** Every price and every platform
behaviour is quoted and linked.

**NOT verified — no access to the live project.** I have no authenticated
`gcloud` for `firetower-prod-506201`:

```
$ gcloud projects describe firetower-prod-506201
ERROR: (gcloud.projects.describe) [kevin.piacentini@deeptime.io] does not have
permission to access projects instance [firetower-prod-506201]
```

So the following are inferences from Terraform and not observations of the
running estate:

- that there are no existing Cloud Scheduler jobs on the billing account (the
  three-free-jobs tier is per *billing account*, and I can only see that this
  project declares none and does not even enable the API);
- that Artifact Registry is already past its 0.5 GiB free tier (two image
  streams × `keep_count = 20` makes it near-certain, but it is not measured);
- the current Cloud SQL bill.

**NOT verified — GitHub billing.** `gh api /orgs/firetower-cloud/settings/billing/actions`
returns `410 This endpoint has been moved`, and the replacement needs an
`admin:org` scope this token lacks. Actions-minute figures below are estimated
from workflow *wall-clock* durations, which is an approximation of billable
minutes, not a reading of them.

---

## 1. Can a GitHub-hosted runner reach this Cloud SQL instance?

**Yes.** This section is the one that changes the shape of #404, so it is the
longest.

### What the instance actually is

`modules/backend/main.tf` in `firetower-terraform`:

```hcl
ip_configuration {
  # A public IP with an empty allowlist. Nothing on the internet can open a
  # connection: Cloud Run reaches this through the platform's managed Cloud
  # SQL proxy, which authenticates with IAM rather than by being on a
  # permitted network.
  ...
  # No `authorized_networks` block at all, which is the point: an empty
  # allowlist is what makes the public IP unreachable. Adding one here
  # would be the thing that opens it.
  ipv4_enabled = true
  ssl_mode     = "ENCRYPTED_ONLY"
}
```

So: **public IP enabled, zero authorized networks.** `backend/README.md` describes
the same thing: *"The instance keeps a public IP with an empty allowlist, so a
connection has to come through the proxy and authenticate with IAM."*

Both sentences are correct. The missing step is what "come through the proxy"
permits — and the answer is that the proxy is a *client-side* program that will
run anywhere, not a Cloud Run feature.

### Google's documentation

> "provides secure access to your instances without a need for Authorized
> networks or for configuring SSL."
> — [About the Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy)

> "The Cloud SQL Auth Proxy establishes a secure tunnel to the proxy server
> process on the Cloud SQL instance using destination TCP port `3307`."
> — [ibid.](https://cloud.google.com/sql/docs/postgres/sql-proxy)

On connecting from outside Google Cloud specifically, the docs recommend exactly
this instance's configuration — public IP plus a connector:

> A public IP address is for clients that "need to connect from clients outside
> the Google Cloud VPC network over the public internet." For public IP, "use a
> Cloud SQL connector (either the Cloud SQL Auth Proxy or one of the Cloud SQL
> Language Connectors)." When using public IP *without* a connector, you "must
> configure authorized networks."
> — [Connect from external applications](https://cloud.google.com/sql/docs/postgres/connect-external-app)

That last clause is the crux. **Authorized networks are the alternative to the
proxy, not a prerequisite for it.** An empty allowlist closes the direct-TCP
path; it does nothing to the proxy path, which is authorised by IAM. The
`ipv4_enabled = true` in the Terraform is what makes the proxy path reachable
from a GitHub runner, and it is already true.

### The credential

The proxy needs a Google credential with `cloudsql.instances.connect` and
`cloudsql.instances.get` — which is `roles/cloudsql.client`
([required roles](https://github.com/GoogleCloudPlatform/cloud-sql-proxy#credentials)) —
and it reads them from Application Default Credentials:

> The proxy accepts Application Default Credentials (primary method),
> service account key files via `--credentials-file`, OAuth2 tokens via
> `--token`, and service account impersonation via `--impersonate-service-account`.
> — [cloud-sql-proxy README](https://github.com/GoogleCloudPlatform/cloud-sql-proxy)

`google-github-actions/auth@v2` — already used in `backend`'s `deploy.yml` and
in `firetower-terraform`'s `terraform.yml` — writes exactly that:

> The action exports a credentials file to `$GITHUB_WORKSPACE` ... and sets
> `GOOGLE_APPLICATION_CREDENTIALS` and `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`.
> — [google-github-actions/auth](https://github.com/google-github-actions/auth)

And the proxy maintainers have confirmed the combination works, in the issue
opened to ask for it:

> "because the proxy already supports application default credentials, it does
> work with WIF"
> — enocom, [cloud-sql-proxy#1096](https://github.com/GoogleCloudPlatform/cloud-sql-proxy/issues/1096),
> closed as completed 2022-02-10

### The connection string does not even have to change

This is the detail that makes the GitHub Actions path cheap to *implement*, and
it is worth recording whichever option #404 picks.

The proxy can present a unix socket at the same path Cloud Run mounts:

> "The Cloud SQL Auth Proxy can listen on a Unix socket" via
> `--unix-socket /cloudsql`, producing
> `/cloudsql/INSTANCE_CONNECTION_NAME/.s.PGSQL.5432`.
> — [Connect using the Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/connect-auth-proxy)

That is byte-identical to what the platform mounts in Cloud Run. So the unusual
connection string this estate already uses —

```
postgres:///telemetry?host=/cloudsql/p:r:i&user=…&password=…
```

— the one `modules/backend/main.tf` builds with `format()`, the one
`dashboard/lib/db.ts` documents at length, and the one guarded by
`cloud_sql_socket_url_parses` in Rust and `db.test.ts` in TypeScript — works
**verbatim** in a GitHub runner. No second URL shape, no second test.

### Conclusion, and what it does not mean

A `schedule:` workflow is **technically available**. Section 2 costs it. It is
not the recommendation, but it is rejected on a credential argument rather than
on impossibility — which matters, because it is the fallback if the Terraform
hand-off in Section 4 stalls.

Two caveats, neither fatal:

- The runner needs outbound TCP/3307. GitHub-hosted runners allow arbitrary
  outbound traffic, so this is a note rather than a blocker.
- `sqladmin.googleapis.com` must be enabled for the proxy to look the instance
  up. It already is, in the `google_project_service.required` `for_each` set.

---

## 2. The candidates, costed

### Shared baseline

Excluded from every comparison because it is **identical under every option**:
the Cloud SQL instance already exists and runs 24/7 (`db-f1-micro`,
`ENTERPRISE`, `ZONAL`, 10 GB `PD_SSD`, 7 retained backups). No option here adds
a second instance, and at map scale — *"215 merged PRs, 504 commits, 129
releases over 15 weeks… a full backfill is a few thousand rows"* — none of them
measurably moves its storage or CPU either. Order of $10/month, already being
paid, **unverified** against the live bill.

Cadences costed: **hourly** = 730 runs/month, **daily** = 30.4 runs/month.

### The price list

| What | Rate | Free tier |
|---|---|---|
| Cloud Run **instance-based** CPU (how jobs bill) | $0.000018 / vCPU-s | 240,000 vCPU-s / mo |
| Cloud Run **instance-based** memory | $0.000002 / GiB-s | 450,000 GiB-s / mo |
| Cloud Run **request-based** CPU (how services bill) | $0.000024 / vCPU-s | 180,000 vCPU-s / mo |
| Cloud Run **request-based** memory | $0.0000025 / GiB-s | 360,000 GiB-s / mo |
| Cloud Run requests | $0.40 / million | 2,000,000 / mo |
| Cloud Scheduler | $0.10 / job / 31 days | 3 jobs / **billing account** |
| Secret Manager active version | $0.06 / version / mo | 6 versions |
| Secret Manager access | $0.03 / 10,000 | 10,000 / mo |
| Artifact Registry storage | $0.10 / GiB / mo | 0.5 GiB |
| GCP egress to internet (NA, Premium, 0–1 TiB) | $0.12 / GiB | — |
| GitHub Actions, standard Linux | $0.006 / min | public repos free; Free plan $12/mo (~2,000 min) |

Sources: [Cloud Run pricing](https://cloud.google.com/run/pricing),
[Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing),
[Secret Manager pricing](https://cloud.google.com/secret-manager/pricing),
[Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing),
[VPC pricing](https://cloud.google.com/vpc/pricing),
[About billing for GitHub Actions](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions).

Two notes that do real work below. Cloud Run **jobs** bill on the
instance-based rate, *"for the entire lifetime of any instance started, with a
minimum of 1 minute"*, and the free tier does apply to them — 240,000 vCPU-s and
450,000 GiB-s per month. And the Cloud Scheduler free tier *"is measured at the
account level not the project level."*

---

### Option A — `schedule:` workflow in GitHub Actions

Viable, per Section 1. Where it would live matters, because
`firetower-cloud/backend` is **private** and `firetower-cloud/firetower` is
**public**, and the org is on the **free** plan (`"plan": {"name": "free"}`,
from `gh api orgs/firetower-cloud`).

The ingest is settled as *"a crate beside `ft-ingest`"*, so the code is in
`backend`. A workflow in `backend` therefore spends the org's included minutes.

**Actions minutes.** Per run: checkout, `auth`, fetch the proxy, pull the ingest
image from Artifact Registry, start the proxy, run the ingest. Call it 60–90
seconds, which GitHub rounds to **2 billable minutes per job**.

- Daily: 30.4 × 2 = **61 min/month.** Comfortably inside the allowance. **$0.00**
- Hourly: 730 × 2 = **1,460 min/month.** Existing CI is roughly 450 min/month
  (estimated: `backend` ran ~15 workflow runs in a five-day sample at ~5 min
  wall-clock each; billable minutes unread, see Section 0). Total ~1,910 against
  ~2,000 included. **$0.00, with about ninety minutes of headroom for everything
  else the org does.** A 30% error in that estimate is ~500 overage minutes =
  **$3.00/month**, and worse, it is the *deploy pipeline* that starts failing or
  billing when the ingest eats the budget.

**Egress — the cost nobody predicts.** Pulling the image from Artifact Registry
to a GitHub runner is internet egress *out of GCP*, and runners are fresh every
run so nothing caches. At ~50 MB compressed:

- Hourly: 730 × 0.05 GiB = 36.5 GiB × $0.12 = **$4.38/month**
- Daily: 1.5 GiB = **$0.18/month**

At hourly cadence that single line is larger than every other Google Cloud
charge in this document combined. It is avoidable — build the crate in the
runner instead (more minutes) or publish a stripped static binary — but it has
to be designed around rather than discovered.

**Totals: ~$0.18/month daily; ~$4.38–$7.38/month hourly.**

**Terraform needed** (all in `firetower-terraform`):

1. `google_service_account "dora_ingest"` — `backend-deployer-prod` cannot be
   reused. Its own description is *"It cannot create resources, read state,
   touch IAM, or reach the database"*, and `main.tf` grants it no
   `cloudsql.client` and no accessor on either database secret. That is a
   deliberate property and widening it would be the wrong change.
2. `google_project_iam_member` — `roles/cloudsql.client` on the new SA.
   Project-level, because as the existing comment says, *"Project-level because
   that is the only scope Cloud SQL offers for it."*
3. `google_service_account_iam_member` — `roles/iam.workloadIdentityUser` for
   `principalSet://…/attribute.repository/firetower-cloud/backend`. A
   line-for-line copy of the existing `deployer_wif`. **The pattern copies
   exactly**, and `bootstrap.sh`'s provider already maps
   `attribute.repository`, so no bootstrap change is needed for this.
4. `google_artifact_registry_repository_iam_member` — `roles/artifactregistry.reader`,
   if the workflow pulls the image.
5. A write credential: `google_sql_user` + `random_password` +
   `google_secret_manager_secret` + `_version` + `_iam_member`. The
   `format("postgres:///%s?host=/cloudsql/%s&user=%s&password=%s", …)` pattern
   copies verbatim — see Section 1 on `--unix-socket`.

**~5–8 resources. No new API, no new `terraform-ci` role, no `bootstrap.sh`
change.** This is materially *less* Terraform than Option B, and that should be
on the record.

**The GitHub credential is free and automatic** — `secrets.GITHUB_TOKEN`,
minted per run, scoped, expiring, nothing stored, nothing to rotate. This is
Option A's strongest argument. But it comes with a ceiling:

> "The rate limit for `GITHUB_TOKEN` is 1,000 requests per hour per repository."
> — [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

A personal access token gets 5,000/hour. For incremental runs 1,000 is ample;
for the 15-week backfill the map wants *"on the page from day one"*, a per-PR
detail fetch across 215 PRs plus paginated commits, releases and workflow runs
gets uncomfortably close. Workable with care, and a constraint the backfill
ticket inherits.

**What is wrong with it.** A write-capable connection string to the production
telemetry database is materialised in a GitHub-hosted runner's filesystem on
every single run. `backend/README.md` is pointed about the current arrangement —
*"No service-account key is held here"* — and `firetower-terraform`'s README
repeats it: *"No repo holds a service-account key."* The estate's whole
credential story is that short-lived federated tokens go *into* CI and secrets
stay *inside* the project. Option A keeps the first half and breaks the second.

There is a variant that fixes this: IAM database authentication
(`--auto-iam-authn`), where no password exists at all. It needs the
`cloudsql.iam_authentication` database flag on a production instance that
currently declares no `database_flags` block at all, an IAM-typed
`google_sql_user`, and `roles/cloudsql.instanceUser`. That is **more** Terraform
than Option B, not less, and it is a flag change on a live database. Worth
knowing it exists; not worth choosing Option A for.

**Reliability.** Two documented properties:

> "The `schedule` event can be delayed during periods of high loads of GitHub
> Actions workflow runs. High load times include the start of every hour. If the
> load is sufficiently high enough, **some queued jobs may be dropped**."

> "In a public repository, scheduled workflows are automatically disabled when no
> repository activity has occurred in 60 days."

> "Scheduled workflows will only run on the default branch."
> — [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

Dropped silently, with no retry and no alert. For a dashboard that reconciles
rather than appends this is survivable; it is still a worse clock than Cloud
Scheduler, which has `retry_config`. The 60-day rule binds neither repo in
practice (both are active) but is a trap for a project that goes quiet.

---

### Option B — Cloud Run Job + Cloud Scheduler  ← recommended

The shape that matches how `telemetry-prod` and `dashboard-prod` already run.

**Compute.** Match the existing services: 1 vCPU, 512 MiB. Per run the minimum
billing unit dominates — 60 vCPU-s and 30 GiB-s.

- Hourly: 43,800 vCPU-s and 21,900 GiB-s. Free tiers are 240,000 and 450,000.
  **$0.00**
- Daily: 1,824 vCPU-s and 912 GiB-s. **$0.00**
- Headroom is not marginal: at **five minutes per run, hourly**, it is 219,000
  vCPU-s — still inside the 240,000 free tier.

**Cloud Scheduler.** One job. Free tier is three per billing account;
`firetower-terraform` declares none and does not enable
`cloudscheduler.googleapis.com` at all, so this is almost certainly the
account's first. **$0.00** — and **$0.10/month** if some other project on the
billing account has already used the three. Unverified (Section 0).

**Secret Manager.** A third active version against a free tier of six: **$0.00**.
Accesses: 730/month hourly against 10,000 free: **$0.00**.

**Artifact Registry.** Two sub-options, and they differ:

- A **second image**. `Dockerfile` currently ends `cargo build --release --bin
  ft-ingest` and `ENTRYPOINT ["/usr/local/bin/ft-ingest"]`. A sibling Dockerfile
  would add an image stream; at `keep_count = 20` and a ~20 MB differing layer
  (the Debian base and `ca-certificates` layers dedupe against the existing
  image), that is ~0.4 GiB → **~$0.04/month**.
- The **same image, second binary**. `Cargo.toml` is already a multi-binary
  workspace by design: *"One workspace, several binaries, deliberately… An admin
  API added later becomes another crate beside it over the same
  `ft-telemetry-db`, not another route on this one."* Build both binaries into
  one runtime stage and have the Job override the container command.
  **$0.00**, one build, no second image stream.

  The cost of that: the image answering the public internet would carry a binary
  containing DB-write and GitHub-API code it never executes. `ft-ingest` already
  writes, so this is a purity question rather than a new capability — but it is
  a judgement call for the implementation ticket, not something to settle here.

**Egress.** None of consequence. The job reaches Cloud SQL over the mounted
socket (no internet hop at all) and its only outbound traffic is the GitHub API
calls themselves — well under 1 GiB/month even hourly.

**Totals: $0.00/month at both cadences** (≤ $0.15 if the Scheduler free tier is
already spent and a second image is used).

**Terraform needed** (all in `firetower-terraform`, `modules/backend/main.tf`
unless noted):

1. Add `"cloudscheduler.googleapis.com"` to the `google_project_service.required`
   `for_each` set. One line.
2. `random_password "dora_db"` + `google_sql_user "dora"` — or reuse the
   `telemetry` owner. A third role is the better shape and inherits a known
   chore; see Section 4.
3. `google_secret_manager_secret "dora_database_url"` + `_version`. Same
   `format()` string as the two that exist. **The `DATABASE_URL` pattern copies
   verbatim.**
4. `google_service_account "dora_runtime"` (`dora-ingest-prod`).
5. `google_project_iam_member` — `roles/cloudsql.client`.
6. `google_secret_manager_secret_iam_member` — `roles/secretmanager.secretAccessor`,
   **scoped to that one secret**, matching the existing comment: *"Scoped to this
   one secret rather than granted project-wide."*
7. `google_secret_manager_secret` + `_version` + `_iam_member` for the GitHub
   token.
8. `google_cloud_run_v2_job "dora_ingest"`. The provider supports the Cloud SQL
   mount at `template.template.volumes.cloud_sql_instance.instances`
   ([provider docs](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_job)),
   and `gcloud run jobs deploy --add-cloudsql-instances` confirms it is a
   first-class job feature, not services-only. Needs
   `lifecycle { ignore_changes = [template[0].template[0].containers[0].image,
   client, client_version] }` to preserve the split the whole estate depends on —
   *"Terraform ignores the image field, so the two never write the same thing and
   a deploy never fights a plan."*
9. `google_cloud_run_v2_job_iam_member` — `roles/run.invoker` for the scheduler
   identity. Per [Run jobs on a schedule](https://cloud.google.com/run/docs/execute/jobs-on-schedule),
   *"Cloud Run Invoker (`roles/run.invoker`)"* is the role that executes a job.
10. `google_cloud_scheduler_job "dora_ingest"` — `http_target` POSTing to
    `https://run.googleapis.com/v2/projects/firetower-prod-506201/locations/us-central1/jobs/JOB:run`.
    Must use `oauth_token`, **not** `oidc_token`: *"these APIs expect an OAuth
    token, and Cloud Scheduler accepts OAuth tokens only for target URLs hosted
    on `*.googleapis.com`"*
    ([Use authentication with HTTP targets](https://cloud.google.com/scheduler/docs/http-target-auth)).
    Plus `retry_config` — the thing GitHub Actions has no equivalent of.
11. `google_cloud_run_v2_job_iam_member` (`roles/run.developer`) +
    `google_service_account_iam_member` (`roles/iam.serviceAccountUser`) for
    `backend-deployer-prod`, so `backend`'s `deploy.yml` can push the image —
    mirroring `deployer_deploy_dashboard` and
    `deployer_acts_as_dashboard_runtime` exactly.
12. **`bootstrap/bootstrap.sh`**: add `roles/cloudscheduler.admin` to the role
    loop. See Section 4 — this is the step that needs a human.

**~13 resources + a bootstrap change.** More than Option A. Everything except
item 12 is a copy of a pattern already in the file.

**Other advantages worth recording.** Cloud Run jobs have a task timeout *"up to
168 hours"* ([Set task timeout](https://cloud.google.com/run/docs/configuring/task-timeout)),
against 60 minutes maximum for a Cloud Run service request and 6 hours for a
GitHub Actions job. The 15-week backfill fits in any of them, but only the job
makes it a non-question.

**Its cost.** A GitHub token has to be stored in Secret Manager and **rotated**.
A fine-grained PAT expires (one year maximum); a GitHub App avoids expiry at the
price of app registration, a private key in Secret Manager, and JWT exchange in
the crate. Either way this is the **only recurring human chore** any option here
creates, and it lands on a one-person project. It is the honest cost of the
recommendation.

---

### Option C1 — Cloud Scheduler → a route on `ft-ingest`

**Rejected without costing.** `backend/README.md`:

> "it can insert a digest and it can do nothing else. No read route, no parameter
> that reaches the database, and an oversized body refused before it is parsed.
> An admin API added later becomes a crate beside it over the same
> `ft-telemetry-db`, **never another route on this one**."

Restated in `Cargo.toml` and in `modules/backend/main.tf`'s header. The ticket
names this as forbidden and the codebase says it three times. Not a cost
question.

---

### Option C2 — Cloud Scheduler → a route on `dashboard-prod`

**Cost: $0.00/month at both cadences.** Scheduler free. Request-based compute at
730 requests × ~12 vCPU-s (cold start plus work) = 8,760 vCPU-s against 180,000
free; 4,380 GiB-s against 360,000 free; 730 requests against 2,000,000 free.
Terraform is small: one `google_cloud_scheduler_job` with an `oidc_token` whose
audience is the service URL (OIDC here, not OAuth — the target is `*.run.app`,
not `*.googleapis.com`), one `run.invoker` grant, the API enable, and the write
credential.

**Rejected on architecture, not on cost.** Four reasons, in descending order:

1. **It breaks the dashboard's central invariant.** `dashboard/lib/db.ts`:
   *"Read-only by credential, not by convention… This connects as `dashboard`, a
   Postgres role granted `select` and nothing else. A bug here cannot write,
   which is the point of it being a second user rather than the owner the ingest
   service uses."* Writing means either a second credential inside the dashboard
   container or granting `dashboard` INSERT. The first makes that paragraph false;
   the second makes it dangerous. The dashboard is reachable from the internet
   (`ingress = "INGRESS_TRAFFIC_ALL"`, gated at IAM) and reads *"every
   installation's counts."*
2. **It contradicts a settled decision.** The ingest is *"a crate beside
   `ft-ingest`"* — Rust, over `ft-telemetry-db`. A Next.js route is a different
   language, a different connection pool, and a second place where the schema is
   known.
3. **It couples ingest availability to the dashboard's deploy.** `deploy.yml`
   already separates the two services precisely so they do not move together:
   *"editing a page in the dashboard would roll a new ingest revision as well —
   harmless but dishonest."*
4. **The 60-minute request ceiling** is a real bound on backfill where the job
   has none.

---

### Option D — an in-process timer on a service that scales to zero

**Dead, and expensive to resurrect.** Both Cloud Run services declare
`min_instance_count = 0`. The platform does not keep a process alive to tick:

> "With *request-based billing*, CPU is only allocated during request processing."

> "An instance will never stay idle for more than 15 minutes after processing a
> request unless it is kept active using minimum instances."
> — [CPU allocation](https://cloud.google.com/run/docs/configuring/cpu-allocation)

A `setInterval` in the Next.js server is therefore not a clock. It is not
*unreliable*; it does not run. Answering the ticket's question directly: **no, a
service that scales to zero cannot be relied on to run anything on a clock.**

To make it one needs `min_instance_count = 1` and instance-based billing, for
2,628,000 seconds a month:

- CPU: (2,628,000 − 240,000 free) × $0.000018 = **$42.98**
- Memory: (1,314,000 − 450,000 free) × $0.000002 = **$1.73**
- **≈ $44.71/month**

That is the only non-zero figure in this document, for a worse clock — and it
would consume the project's entire Cloud Run free tier, so the ingest and both
existing services would start billing for the first time. **Rejected on cost and
on correctness.** For scale: this estate twice declined a global load balancer at
*"about $18/month before any rules"* (`backend/README.md` and
`modules/backend/main.tf`) on the grounds that it was not worth the money. This
is two and a half times that, to do something that can be had for nothing.

---

### Option E — anything else the project already uses

I enumerated the whole estate rather than guessing. Every `google_*` resource
type across `modules/` and `envs/`, and every API enabled anywhere including
`bootstrap.sh`:

```
run.googleapis.com   sqladmin.googleapis.com
secretmanager.googleapis.com   artifactregistry.googleapis.com
(+ bootstrap: cloudresourcemanager, serviceusage, iam, iamcredentials, sts,
   storage, firebase, firebasehosting)
```

```
$ grep -rni "scheduler|cloudfunction|pubsub|eventarc|cloudtask|workflows|compute" modules envs bootstrap
(no matches)
```

**There is no scheduler of any kind in this project today.** No Cloud Scheduler,
no Pub/Sub, no Eventarc, no Cloud Tasks, no Cloud Functions, no Compute Engine,
no Cloud Run Jobs. The estate is Cloud Run services, Cloud SQL, Secret Manager,
Artifact Registry, Firebase Hosting, a GCS state bucket, and IAM.

Which produces a clean framing for #404: **GitHub Actions is the only scheduling
mechanism this project already operates.** Every other option introduces a
Google Cloud product the estate has never used. That is a genuine point in
Option A's favour and should not be buried.

Two things it could ride on, neither of which is a clock:

**E1 — ride `deploy.yml` in `backend`.** Add an ingest step to the existing
merge-to-`main` workflow. Zero new scheduling infrastructure, ~3 extra minutes a
month, and the same GCP IAM Terraform as Option A. **Rejected:** `backend`
merges are uncorrelated with activity in `firetower`. They are *different
repositories*. The DORA page would go stale for weeks whenever the backend is
quiet, which is most of the time.

**E2 — `schedule:` in the public `firetower` repo.** Actions is *"free of
charge"* for *"standard GitHub-hosted runners in public repositories"*, so this
is the cheapest option on paper at any cadence, hourly included — no minute
budget, no egress if the crate is built in the runner. **Rejected:** it gives a
**public** repository's workflows a credential that writes to the production
telemetry database. The WIF binding is per-repository so forks cannot reach it,
but anyone who can push to the default branch of a public repo can. And the
ingest crate lives in the private `backend` repo, so the schedule and the code
it runs would sit in different repositories. Worth recording as the cheapest
rejected option.

**E3 — a hybrid worth knowing about.** A `schedule:` workflow in `backend` whose
only action is `gcloud run jobs execute`. This removes Cloud Scheduler entirely
— no new API, no new `terraform-ci` role, **and no owner-run bootstrap step**
(Section 4) — and puts the cron expression in a reviewable file next to the code
instead of a string in another repository. `backend-deployer-prod` already holds
`roles/run.developer` on both services, so extending it to the job is one line.
**Not recommended, but it is the escape hatch** if the Section 4 hand-off
stalls. Its flaw: the GitHub token problem comes back worse. Passing it in with
`--update-env-vars` writes it into the job's execution config, which is a
durable, readable place for a credential — worse than Secret Manager and worse
than `secrets.GITHUB_TOKEN`. It also reintroduces "jobs may be dropped" while
discarding `retry_config`.

---

## 3. Summary table

| | Monthly, daily | Monthly, hourly | New TF resources | New SA | Clock quality | DB credential leaves GCP |
|---|---|---|---|---|---|---|
| **A** GH Actions `schedule:` in `backend` | ~$0.18 | ~$4.38–7.38 | ~5–8 | 1 | drops silently, no retry | **yes, every run** |
| **B** Cloud Run Job + Scheduler ← | **$0.00** | **$0.00** | ~13 + bootstrap | 1 | retries, 168 h timeout | no |
| **C1** route on `ft-ingest` | — | — | — | — | — | — (forbidden) |
| **C2** route on `dashboard-prod` | $0.00 | $0.00 | ~4 | 0 | retries, 60 min ceiling | no, but write creds in a reader |
| **D** in-process timer, `min_instances=1` | **$44.71** | $44.71 | ~2 | 0 | **does not run** at `min=0` | no |
| **E1** ride `deploy.yml` | $0.00 | n/a | ~5–8 | 1 | not a clock | yes |
| **E2** `schedule:` in public `firetower` | $0.00 | $0.00 | ~5–8 | 1 | drops silently | **yes, from a public repo** |
| **E3** GH Actions → `jobs execute` | ~$0.00 | ~$0.00 | ~10 | 1 | drops silently | no (token exposed instead) |

Cadence: at these volumes **daily** and **hourly** cost the same ($0.00) under
the recommendation, and differ only under Option A, where hourly is the
difference between free and consuming the org's CI budget.

---

## 4. The cross-repo hand-off — stated plainly

**Infrastructure is not in `backend`.** `backend/README.md`: *"Infrastructure is
**not** in this repository. It lives in `firetower-cloud/firetower-terraform`."*
That repository is **not checked out in this workspace**. I read it with `gh`
(Section 0), so the claims above are grounded — but reading it is not the same as
being able to change it in the branch this map produces.

Per option, what is a change to a repository nobody here has open:

| Option | In `backend` (open here) | In `firetower-terraform` (**not open**) | Needs a project **owner**, not CI |
|---|---|---|---|
| **A** | the crate, `.github/workflows/dora-ingest.yml` | ~5–8 resources: SA, `cloudsql.client`, WIF binding, registry reader, SQL user + secret + accessor | no |
| **B** ← | the crate, a `Dockerfile` or a second binary, a `deploy.yml` job | ~13 resources: API enable, SQL user, 2 secrets + versions + accessors, runtime SA, `cloudsql.client`, the Job, `run.invoker`, the Scheduler job, 2 deployer grants | **yes — one step** |
| **C2** | a Next.js route | ~4 resources | no |
| **D** | a timer | `min_instance_count`, billing mode | no |
| **E3** | the crate, a workflow | ~10 resources (the Job, minus all Scheduler) | no |

**No option needs zero Terraform.** The closest is C2, and it is rejected on
other grounds. The reason even Option A cannot avoid it is that
`backend-deployer-prod` was built not to reach the database — *"It cannot create
resources, read state, touch IAM, or reach the database"* — so **any** option
needs at least a new service account and a `roles/cloudsql.client` grant in
`firetower-terraform`. That is the floor.

### The one step CI cannot do

`bootstrap/bootstrap.sh` grants `terraform-ci` exactly ten project roles:

```
firebase.admin  iam.serviceAccountAdmin  resourcemanager.projectIamAdmin
serviceusage.serviceUsageAdmin  storage.admin  run.admin  cloudsql.admin
secretmanager.admin  artifactregistry.admin  iam.serviceAccountUser
```

`roles/cloudscheduler.admin` is **not** among them. `run.admin` covers the Cloud
Run Job; nothing covers the Cloud Scheduler job. So the first
`terraform apply` that declares a `google_cloud_scheduler_job` **fails on
permissions**, in CI, in a repository nobody here has open.

Two ways out, and they are not equal:

- **Add the role to `bootstrap.sh` and re-run it as an owner.** The script is
  *"Safe to re-run. Every step checks for existence first."* This is the honest
  path, and it requires a human with owner on `firetower-prod-506201` plus both
  `gcloud auth login` and `gcloud auth application-default login`. **This is the
  single blocking item in the recommendation** and the reason #404 should not
  assume CI can land it alone.
- **A `google_project_iam_member` self-grant.** `terraform-ci` holds
  `resourcemanager.projectIamAdmin`, and `bootstrap.sh`'s own comment concedes
  it *"could grant itself this at any time."* Technically available; it puts an
  IAM-propagation race inside the same apply that needs the permission, and the
  bootstrap's stated reason for existing is that these two things —
  state and CI identity — are the ones Terraform should not own. Not recommended.

Option E3 exists specifically to avoid this step. If the owner-run bootstrap is
the thing that stalls, E3 is the fallback, and plain Option A is the fallback
after that.

### Also not Terraform's

Two chores sit outside both repositories:

**Postgres grants.** `main.tf` already documents the limitation — Terraform
*"reaches the Cloud SQL **admin** API, not the database, and the instance has no
authorized networks for it to connect through even if it did."* A new `dora`
role needs INSERT/UPDATE run by hand as the owner. The map already flags this:
*"The existing `alter default privileges` statement should cover new tables, but
'should' is doing work in that sentence."* Note that statement grants **select**
to `dashboard` only, so a *writer* role gets nothing from it and needs its own
grants plus its own `alter default privileges`. The schema ticket owns the exact
statements.

Worth saying: Section 1's finding makes this chore *easier* in future. The
reason Terraform cannot issue grants is that nothing can reach Postgres from
outside — but the Cloud SQL Auth Proxy can, from anywhere, with
`roles/cloudsql.client`. These grants could be run from a CI job rather than
from somebody's laptop. Out of scope here; flagging it because the README
presents the limitation as more absolute than it is.

**The GitHub token.** Created by a human, stored in Secret Manager, rotated
before it expires. Recurring, and it belongs to whoever operates this.

---

## 5. Recommendation

**Option B — a Cloud Run Job triggered by Cloud Scheduler, in
`firetower-prod-506201` / `us-central1`, at daily cadence. $0.00/month.**

Not because it is cheapest — A, C2, E1, E2 and E3 are all $0.00 or within
pennies, and **cost does not distinguish them.** The reasons that do:

1. **The database credential never leaves the project.** This is the
   tie-breaker. Every sentence in `backend/README.md`'s deployment section and
   `firetower-terraform`'s README points the same way: short-lived federated
   tokens go into CI, secrets stay in the project, *"No repo holds a
   service-account key."* Option A inverts that for the one credential that can
   write to every installation's data.
2. **It is the only option with a real clock.** `retry_config` against *"some
   queued jobs may be dropped"*; a 168-hour task timeout against 60 minutes on a
   service and nothing at all on a scale-to-zero timer.
3. **It is the smallest realisation of a settled decision.** The ingest is *"a
   crate beside `ft-ingest`"* over the same `ft-telemetry-db`. `Cargo.toml` was
   written for exactly this: *"One workspace, several binaries, deliberately."* A
   Job running a second binary from that workspace adds no new language, no new
   pool, no new place the schema is known.
4. **Every resource it needs is a copy of one already in the file** — runtime SA,
   project-level `cloudsql.client`, secret-scoped `secretAccessor`, the
   socket-URL secret built with the same `format()`, `image` in
   `ignore_changes`, deployer granted `run.developer` plus `actAs`. A reviewer
   of that PR is checking a familiar shape, not a new one.
5. **Daily, not hourly.** Both are free. The page shows weekly and rolling
   28-day trends over 15 weeks; hourly buys nothing a reader would notice, and
   daily keeps the Option A fallback inside the free Actions allowance. Start
   daily; a cadence change is one Terraform string.

**What it costs, stated honestly:** ~13 Terraform resources in a repository
nobody on this map has open; a one-line `bootstrap.sh` change that **a project
owner must apply by hand** before the first apply can succeed; manual Postgres
grants for a new writer role; and a GitHub token somebody has to rotate.

### Rejected, on the record

| Option | Rejected because |
|---|---|
| **GitHub Actions `schedule:`** (A) | **Works** — Section 1 refutes the assumption it cannot. Rejected because it materialises a write-capable database credential in a third-party runner on every run, inverting the estate's stated credential direction. Secondary: `GITHUB_TOKEN` caps at 1,000 req/hour, hourly cadence consumes the org's whole CI budget and ~$4.38/month of egress, and scheduled runs *"may be dropped"* with no retry. **Keep as the fallback** — it is the only scheduler this project already operates, and it needs less Terraform than the recommendation. |
| **Route on `ft-ingest`** (C1) | Forbidden by `backend/README.md`, `Cargo.toml` and `modules/backend/main.tf`: *"never another route on this one."* Not a cost question. |
| **Route on `dashboard-prod`** (C2) | $0.00, but it puts a write credential inside a service whose documented reason for existing is that *"A bug here cannot write"*, in a language and a process the settled design says the ingest is not. 60-minute request ceiling on backfill. |
| **In-process timer** (D) | At `min_instance_count = 0` it **does not run** — *"CPU is only allocated during request processing."* Making it run costs **~$44.71/month**, the only non-zero figure here, and consumes the project's entire Cloud Run free tier so three existing services start billing. |
| **Ride `deploy.yml`** (E1) | Not a clock. `backend` merges are uncorrelated with activity in `firetower` — different repositories — so the page would go stale for weeks at a time. |
| **`schedule:` in public `firetower`** (E2) | Cheapest on paper (public repos get free Actions minutes at any cadence). Rejected: it gives a **public** repository's workflows a production database write credential, and separates the schedule from the private repo holding the code it runs. |
| **GH Actions → `jobs execute`** (E3) | Not rejected so much as held in reserve. It is the only option that avoids the owner-run bootstrap step, but it passes the GitHub token through a job's execution config — a durable, readable home for a credential — and keeps "jobs may be dropped" while discarding `retry_config`. **Use it if Section 4's hand-off stalls.** |

### For #404

- Q1 is **refuted**, not confirmed. Do not reject GitHub Actions for
  impossibility; reject it, if you do, for credential direction.
- Cost is not a discriminator. Six of the eight options are $0.00 or within
  pennies. Decide on credentials, clock quality and where the code lives.
- Whatever is picked, **a `firetower-terraform` PR is unavoidable** — the floor
  is a new service account plus `roles/cloudsql.client`, because
  `backend-deployer-prod` was deliberately built unable to reach the database.
- If B is picked, schedule the **owner-run `bootstrap.sh`** as a prerequisite,
  not a discovery. It is the only step CI cannot perform.
- The socket connection string works unchanged in a GitHub runner
  (`--unix-socket /cloudsql`). The existing secret, the `format()` in Terraform,
  and both parse tests carry over to every option. Useful to the backfill and
  schema tickets too.
