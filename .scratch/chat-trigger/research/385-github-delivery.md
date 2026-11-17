# How a GitHub mention reaches a private control plane, and who the reply comes from

Research for [#385](https://github.com/firetower-cloud/firetower/issues/385), under the map
[#362](https://github.com/firetower-cloud/firetower/issues/362). Every claim carries a primary
citation — docs.github.com, docs.gitlab.com, docs.gitea.com, forgejo.org, linear.app/developers.
Where a thing could not be established from a primary source it says **not established** rather
than guessing.

Researched 17 November 2026. The map's constraints are taken as settled and not relitigated: one
app per install, Firetower operates nothing, no relay, no credential held on anybody's behalf, and
a publicly reachable control plane out of scope **as a default** — with an opt-in inbound endpoint
for an install already running `deploy/.env.example` shape 2 explicitly in scope.

---

## 1. The answer

### 1.1 Per host

| Host | Inbound webhook reaches a private control plane? | Mention feed to poll | Body signed? | Bot identity to answer as | Can that identity *receive* a mention? | What Firetower should do |
|---|---|---|---|---|---|---|
| **GitHub.com** | **No** — Hookshot dials in from the internet [[9]] | **`GET /notifications`**, `reason: mention`, `If-Modified-Since`, `X-Poll-Interval: 60`, `304` free [[2]] | **Yes** — `X-Hub-Signature-256`, HMAC-SHA256 over the raw body [[8]] | GitHub App → `name[bot]` [[12]]; or a **machine user** [[14]] | **Machine user yes** (a real inbox). **App no** — notifications are *"personal access token (classic)"* only [[2]] | **Poll notifications as a machine user.** Webhook as an opt-in for shape 2 |
| **GitHub Enterprise Server** | **Yes, trivially** — the instance is already inside the network | Same API under `/api/v3` [[28]] | Same `X-Hub-Signature-256` [[8]] | Same two options | Same | **Webhook.** Rate limits are *"disabled by default"* on GHES anyway [[29]] |
| **GitLab.com** | **No** | **Todos API**, `action=mentioned` and `directly_addressed` [[31]] | **Depends on version.** Legacy `X-Gitlab-Token` is a plain secret that *"offers weaker guarantees"*; **GitLab 19.0+** adds `webhook-signature`, HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}` [[30]] | Project/group access-token bot, *"non-billable… do not count towards your license limit"* [[33]] | **Probably not.** *"The account is a project bot"* is listed as a condition under which GitLab **suppresses notification delivery** [[34]] | **Poll Todos as a human-shaped account.** The free bot cannot hear |
| **GitLab self-managed** | **Yes, trivially** | Same | Same | Same | Same | **Webhook**, and note self-managed ships rate limits **off** [[35]] |
| **Gitea** | **Yes, trivially, and once for the whole instance** — *"System webhooks… trigger for all eligible activity on the instance"* [[36]] | `GET /notifications`, GitHub-shaped [[38]] | **Yes** — `X-Gitea-Signature`, HMAC-SHA256 of the raw body, no prefix; it also sends `X-Hub-Signature-256` [[36]] | A first-class **`Bot` user type**, admin-creatable [[39]] | **Yes** — a `Bot` is an ordinary user record | **One admin system webhook.** The best case in this whole effort |
| **Forgejo** | **Yes, same** — *"per-organization and whole-system basis"* [[37]] | Same as Gitea | **Yes** — `X-Forgejo-Signature`, and Gitea-, Gogs- and GitHub-compatible copies of the same digest [[37]] | Same as Gitea | **Yes** | **Same.** One signature verifier serves both hosts |
| **Linear** | **No**, and there is no private-network escape — **SaaS only**, two fixed cloud regions [[45]] | GraphQL `notifications` query; no cross-workspace "comments since" query [[44]] | **Yes** — `Linear-Signature`, HMAC-SHA256 of the raw body, plus a `webhookTimestamp` replay check [[41]] | **`actor=app`** — *"all mutations such as creating issues, comments, and status changes will be performed by the app"* [[43]] | **Yes, best in class** — the `app:mentionable` scope: *"Allow the app to be mentioned in issues, documents, and other editor surfaces"* [[42]] | **Poll.** The purpose-built path (`AgentSessionEvent`) is a webhook Firetower cannot receive |

**The shape of the table is the finding.** Reachability and identity are *inversely* distributed.
Self-hosted hosts give delivery away for free and have nothing better than a user account to answer
as. Linear has the only first-class mentionable-agent identity in the set and is the one host where
no private-network shortcut exists at all. GitHub.com sits between them, and is the only host where
both halves need work.

### 1.2 Reply identity — the recommendation

**A dedicated machine user, holding a classic PAT, stored at `Key::shared(GIT, "<conn>")`.** It is
the only option that can both *hear* a mention and *answer* one with the same credential, and it is
the one that needs no new auth mode: `AuthMode::Token` already exists, and `vault.rs:67`'s
`Key::shared` is already documented as *"a secret belonging to the install rather than to anybody in
it"* — which is precisely what a bot token is.

| Option | Auth work | Can **answer** | Can **receive** | Cost |
|---|---|---|---|---|
| **Machine user + classic PAT** | **None new.** A pasted token is `AuthMode::Token` today. One `Key::shared` row | Yes, as `@firetower-bot` | **Yes** — `GET /notifications`, `reason: mention` [[2]][[22]] | **One paid licence** per install above Free, *counted once* however many private repositories it joins [[15]]. GitHub's ToS permits it: *"We do permit machine accounts"* [[14]] |
| **Per-install GitHub App** | **A new auth mode.** RS256 JWT signing from a PEM, installation-token minting and a 1-hour cache, a webhook secret, the manifest flow | Yes, as `firetower[bot]` — *"API requests made by an app installation are attributed to the app"* [[12]] | **No feed.** Notifications are classic-PAT-only [[2]], and an App bot is a `Bot`, not a `User`, so it is absent from `mentionableUsers: UserConnection!` [[13]]. Detection must be a **string match** on a body it gets some other way | **No seat**, narrower permissions, a rate limit that *scales* (+50/h per repo above 20, to 12,500) [[1]]. Pays for itself only once a webhook or an O(N) sweep exists |
| **Post as the person mentioned** | None | Yes — and wrongly | Yes, it is their own inbox | **Nothing, and it is the wrong answer.** A comment under somebody's name they did not write. Firetower already writes to a host as a person (`oauth::open_pull_request`) but a pull request is a thing they *asked for*; a reply they did not compose is impersonation |

**So:** ship the machine user; keep the GitHub App as the second mode that lands with the opt-in
webhook. The two are different vault keys and do not conflict — but note that the *reply identity
differs between them*, so if both ever exist the install must pick one and it must be the same one
on every repository, or the same bot appears under two names.

The honest cost line for the recommendation: **one licence, one pasted token, and a scope string
that has to grow.**

### 1.3 The latency floor

| | |
|---|---|
| **Polling `GET /notifications`** | **≈30 s mean, 60 s worst** from the moment GitHub writes the notification, plus an unmeasured delay inside GitHub between the comment and the notification (**not established** — no figure is published). Publish **"under two minutes."** |
| **Opt-in webhook** | **Seconds.** 10-second response budget on the receiver [[3]] |
| **Per-repository sweep** | Whatever interval the repository count allows — no `X-Poll-Interval` is published on those endpoints, so 10 s is permitted at a cost of 12N points/minute against a 900-point ceiling [[1]] |

The map already granted the headroom: *"A mention on an issue answered four minutes later is
ordinary."* Under two minutes is comfortably inside it, which is why polling is not a compromise
here the way it would be in a channel.

### 1.4 And there is no third mechanism

Checked and ruled out, so nobody re-derives them:

- **No GraphQL subscription.** *"The two types of allowed operations in GitHub's GraphQL API are
  queries and mutations"* [[17]]. No WebSocket, no server push.
- **`repository_dispatch` and `workflow_dispatch` point inward.** They are endpoints *you* POST to
  in order to start something on GitHub [[18]]. Categorically useless for delivery.
- **Audit log streaming** is Enterprise Cloud only and goes to S3, Splunk, Azure Blob, Event Hubs,
  GCS or Datadog [[20]]. Whether a comment **body** appears in an entry is **not established**, and
  a compliance stream is the wrong instrument regardless.
- **GitHub Actions with a self-hosted runner inside the network does work**, and is worth knowing
  about: *"Only an outbound connection from the runner to GitHub Enterprise Server is required.
  There is no need for an inbound connection"* [[19]]. A workflow on `issue_comment` runs on that
  runner and the runner calls the control plane. It costs a workflow file in every repository, puts
  the trigger in the customer's repository rather than in Firetower, and burns Actions minutes — so
  it is a fallback worth naming, not a design.
- **GitHub's own "agent apps" are not available to Firetower.** GitHub shipped a first-class
  mentionable-agent concept in June 2026 — *"@mention the agent in a pull request comment"* — but
  agent apps are *"GitHub Apps that expose agents on GitHub"* built by **partners**, enrolled via a
  **waitlist**, and *"powered by your Copilot subscription"* [[46]][[47]]. The agent runs on
  GitHub's side of the line. It is the opposite of a self-hosted control plane running its own
  agent, and it is not a door a per-install app can walk through.

---

## 2. Polling mechanics

### 2.1 The `304` claim is true, and `tasks.rs` overstates it by one word

`crates/ft-server/src/tasks.rs:12` says a `304` *"does not count against the rate limit at all"*.
GitHub's current wording is:

> "Making a conditional request does not count against your primary rate limit if a `304` response
> is returned and the request was made while correctly authorized with an Authorization header."
> [[1]]

Four corrections, in descending order of how much they matter.

1. **"primary".** The sentence is scoped. GitHub separately enforces secondary limits — *"No more
   than 900 points per minute are allowed for REST API endpoints"*, with *"Most REST API GET, HEAD,
   and OPTIONS requests"* at 1 point, *"No more than 100 concurrent requests"*, and *"No more than
   90 seconds of CPU time per 60 seconds of real time"* [[1]]. **Whether a `304` counts toward those
   points is not established** — no page says either way. So "free" is proven of the 5,000/hour
   budget and unproven of the 900/minute one, which is the budget a per-repository sweep actually
   approaches first.
2. **No conditional request is sent today.** Grepping `crates/` for `If-None-Match`,
   `If-Modified-Since` or a stored ETag finds `artifact.rs` *serving* them and nothing *sending*
   them. The module header is reasoning about a cost Firetower does not yet pay. Worth marking as
   not-yet-behaviour before it is cited as a measurement.
3. **"correctly authorized".** The discount is conditional on an `Authorization` header. Every
   Firetower request carries one, so this is a footnote here — but it is why the sentence should not
   be repeated unqualified.
4. **The claim is attached to the wrong budget at `tasks.rs:197`**, where *"conditional requests do
   not spend it at all"* is said of the **search** limit. GitHub documents ETags as a general REST
   mechanism [[1]] and says nothing about conditional requests on `/search/issues` [[4]]. For the
   one endpoint Firetower actually calls, the claim is **not established**.

GraphQL has no equivalent discount: its rate-limit page never mentions conditional requests, ETags
or `304` [[21]]. Linear, being GraphQL-only, therefore cannot have one — as `docs/trackers.md`
already says.

### 2.2 `GET /notifications` — the endpoint built for exactly this

- **Conditional by design.** *"Notifications are optimized for polling with the `Last-Modified`
  header. If there are no new notifications, you will see a `304 Not Modified` response, leaving
  your current rate limit untouched."* [[2]] Send the previous response's `Last-Modified` back as
  `If-Modified-Since`.
- **A mention is a first-class reason.** `mention` — *"You were specifically @mentioned in the
  content"* — is one of sixteen documented values beside `team_mention`, `comment`, `author`,
  `review_requested`, `assign`, `state_change` and `agent_session_finished` [[2]]. It is also an
  inbox filter: *"You were directly @mentioned"* [[22]].
- **`since` and `before`** are parameters, so a restart asks for the window it missed rather than
  replaying an inbox [[2]].
- **One request covers every repository.** The property that matters most, and the one the ticket
  asked about: cost and latency are **independent of the number of watched repositories**. Nothing
  to fan out, nothing to configure per repository, no new repository silently unwatched.

**`X-Poll-Interval` is a floor, stated as an instruction rather than as a rule.**

> "There is an `X-Poll-Interval` header that specifies how often (in seconds) you are allowed to
> poll. In times of high server load, the time may increase. Please obey the header." [[2]]

The documented example value is `60`. The general best-practices page is firmer about the shape of
the duty — *"If a response includes an `x-poll-interval` header, wait at least that many seconds
before you poll the same endpoint again"* [[1]] — so treat it as a **server-chosen floor that may
rise**, not a constant to compile in. **What happens if you ignore it is not established**: no page
names a penalty, status code or throttle tied to violating it. Honour it anyway. It is the only
load-shedding signal GitHub has on this endpoint, and an install that ignores it buys at most
thirty seconds.

**The cost.** 60 requests an hour per watching account, essentially all `304`, against a 5,000/hour
`core` budget shared with everything else that token does — listing repositories, reading issues,
opening pull requests. Idle, the sweep spends nothing at all. On a hit it costs the listing plus one
read of `subject.latest_comment_url`, so two or three requests per mention. At one point per GET,
one request a minute is 0.1% of the 900-point secondary allowance. **This is not a budget that needs
managing.**

Two caveats about the inbox itself, both of which have to be settled before this is built:

- **The scope string has to grow, and the two docs disagree about whether it does.** The
  notifications guide says *"All calls to these endpoints require the `notifications` or `repo`
  scopes"* [[2]]. The OAuth scopes reference describes `repo` as *"full access to public and private
  repositories including read and write access to code, commit statuses, repository invitations,
  collaborators, deployment statuses, and repository webhooks"* — no notifications — and gives
  notification reading to `notifications`: *"read access to a user's notifications, mark as read
  access to threads, watch and unwatch access to a repository, and read, write, and delete access to
  thread subscriptions"* [[23]]. **These two pages contradict each other.** `providers.rs:168` asks
  for `repo workflow`, so the safe reading is that `notifications` must be added — which, on the
  device flow, means **every existing GitHub authorization has to be redone**. That migration cost is
  a second reason the watching identity should be its own credential rather than a widened grant on
  everybody's.
- **Whether a mention on an *unwatched* repository notifies is not established.** The default
  notification setting is *"Participating and @mentions"*, and participating is defined as *"Anytime
  you comment in a conversation or when someone @mentions your username, you are participating in a
  conversation"* [[24]] — a category independent of watching. But no sentence states the conclusion
  outright. It is the behaviour everyone relies on; it must be verified against a live account before
  it is depended on, because if it is wrong the watching account has to *watch* every repository,
  and an O(1) design becomes an O(N) setup step.

### 2.3 Per-repository comment listings — the O(N) fallback

Two endpoints, because GitHub splits the comment surface in a way a mention-watcher cannot ignore:

| Endpoint | Covers | `since` | `per_page` |
|---|---|---|---|
| `GET /repos/{owner}/{repo}/issues/comments` | Conversation comments on issues **and on pull requests** | yes, ISO 8601 | 100, default 30 [[5]] |
| `GET /repos/{owner}/{repo}/pulls/comments` | *"review comments for all pull requests in a repository"* — the ones anchored to a diff line | yes, ISO 8601 | 100, default 30 [[6]] |

Review comments are a separate endpoint and the issue-comments page says so [[5]]. #386 asks whether
a review comment is in scope at all; this is what it costs if it is — a second request and a second
ETag per repository per sweep.

**How cost scales.** Each sweep is 2N requests and the state is 2N ETags or watermarks. Against the
5,000/hour primary limit the `304`s are free [[1]], so the binding constraint is secondary: 2N points
per sweep against 900 points per minute [[1]]. At a 60-second sweep that is comfortable into the
hundreds of repositories; at a 10-second sweep it is 12N points a minute, so 75 repositories is the
ceiling and 50 is close to it. **Latency and repository count trade directly against each other** —
which is the whole difference from §2.2, where they do not.

**What it buys.** No `X-Poll-Interval` is published on these endpoints, so a sweep may legitimately
run faster than 60 seconds. And it needs no notification inbox, which makes it the **only**
no-inbound route available to a GitHub App identity. If the reply must come from `firetower[bot]`
and the install will not open a port, this is the mechanism.

**What else it costs.** Every watched repository has to be enumerated, which Firetower already does;
a repository added later is silently unwatched until something notices; and the mention has to be
found by string-matching the comment body, because nothing in the payload marks it.

### 2.4 Search — ruled out on two unknowns rather than on cost

Search expresses the question in one request, and it is more capable than it is usually given credit
for: `in:comments` is real — *"restrict your search to the title, body, comments, or any
combination"*, and with `in` omitted *"title, body, and comments are all searched"* [[25]]. So
GitHub's issue search **does** index comment text. `mentions:`, `commenter:` and `involves:` exist
[[25]], and `updated:>…` bounds the window.

It is still the wrong choice, for reasons about verifiability rather than budget:

- Its budget is separate and small, but adequate: *"up to 30 requests per minute for all search
  endpoints except for the Search code endpoint"* authenticated, 10/min unauthenticated [[4]].
  Thirty a minute is plenty for one query. This is not the objection.
- **Whether a conditional request helps is not established.** No GitHub page documents ETag support
  on `/search/issues`. The one property that makes polling free cannot be confirmed for the one
  endpoint `tasks.rs` already uses.
- **Index latency is not established.** No figure, no SLA, no statement. A mention trigger whose
  latency floor is undocumented is not a mechanism; it is a hope.
- Two further edges: results are capped at *"up to 1,000 results for each search"*, and a timeout
  returns partial matches with `incomplete_results: true`, with the warning that *"Reaching a
  timeout does not necessarily mean that search results are incomplete"* [[4]]. Separately,
  `advanced_search` changed multi-qualifier semantics so that a space between `repo:`/`org:`/`user:`
  qualifiers means AND rather than OR [[26]] — which bears on `tasks.rs`'s existing query assembly
  independently of this ticket.

### 2.5 The rate-limit map, for whoever next writes about budgets

| Budget | Limit | Source |
|---|---|---|
| Unauthenticated | 60 req/h | [[1]] |
| User token / classic PAT | 5,000 req/h; 15,000 for a GitHub Enterprise Cloud org | [[1]] |
| GitHub App installation token | 5,000 req/h minimum; **+50/h per repository above 20** and **+50/h per user above 20**, capped at **12,500 req/h** | [[1]] |
| GitHub App JWT (app-level) | **Not established** — no distinct figure is published | — |
| `search` | 30 req/min authenticated; 10 req/min code search; 10 req/min unauthenticated | [[4]] |
| GraphQL | points-based, 5,000 points/h per user | [[21]] |
| Secondary | 900 points/min REST, 2,000 points/min GraphQL, 100 concurrent, 90 s CPU per 60 s, **80 content-generating req/min and 500/h**; GET = 1 point, POST/PATCH/PUT/DELETE = 5 | [[1]] |
| `GET /rate_limit` resources | `core`, `graphql`, `search`, `code_search`, `source_import`, `integration_manifest`, `actions_runner_registration`, `scim`, `dependency_snapshots`, `dependency_sbom`, `code_scanning_autofix`, `copilot_usage_records` — and the call itself is free | [[27]] |

The line that bounds **replying** rather than listening is the last entry of the secondary row:
**80 content-generating requests a minute and 500 an hour**, at 5 points per POST [[1]]. A Firetower
that answers mentions will never approach it. A Firetower that streams an agent's progress into a
comment thread could, and should be told so now rather than later.

---

## 3. The opt-in webhook

For an install already running shape 2 behind its own proxy. The map keeps this in scope as an
opt-in and never a default, and on the evidence it is the **best-authenticated inbound path in this
whole effort** — the thing #365 found missing on the paths that mattered for Discord and Teams.

### 3.1 What is signed, and how

> "GitHub uses an HMAC hex digest to compute the hash." … "The hash signature always starts with
> `sha256=`." … "The hash signature is generated using your webhook's secret token and the payload
> contents." [[8]]

Confirmed: `X-Hub-Signature-256` is **HMAC-SHA256 over the raw request body**, keyed on the webhook
secret, hex, `sha256=`-prefixed. The body is hashed before any JSON parsing — GitHub's own examples
hash `request.body.read` directly [[8]]. The symmetry rule from #365 applies unchanged: verification
capability is forging capability, so the secret lives in the vault under `Key::shared` and nowhere
else.

Constant-time comparison is not advice GitHub leaves implicit:

> "Never use a plain `==` operator. Instead consider using a method like `secure_compare` or
> `crypto.timingSafeEqual`, which performs a 'constant time' string comparison to help mitigate
> certain timing attacks against regular equality operators, or regular loops in JIT-optimized
> languages." [[8]]

`X-Hub-Signature` (SHA-1) is still sent and explicitly superseded: *"`X-Hub-Signature` is provided
for compatibility with existing integrations. We recommend that you use the more secure
`X-Hub-Signature-256` instead"* [[9]]. Only verify the SHA-256 one; do not fall back.

### 3.2 Delivery id, retries, and the thing most people get wrong

**The id to deduplicate on is `X-GitHub-Delivery`** — *"A globally unique identifier (GUID) to
identify the event"* [[9]] — and GitHub names it for this purpose itself:

> "To protect against replay attacks, you can use the `X-GitHub-Delivery` header to ensure that each
> delivery is unique per event." [[3]]

**And a redelivery reuses it.** *"If you request a redelivery, the `X-GitHub-Delivery` header will
be the same as in the original delivery"* [[3]]. So a dedupe key on that header alone is correct and
complete: a redelivery of something already processed is recognised as already processed, which is
exactly what `schedule_triggers`'s *"a delivery id to deduplicate on"* wants.

**GitHub does not retry.** This is the fact most likely to be assumed wrong:

> "GitHub does not automatically redeliver failed deliveries." [[10]]

> "if your server is down or takes longer than 10 seconds to respond, GitHub will record the
> delivery as a failure." [[10]]

> "Your server should respond with a 2XX response within 10 seconds of receiving a webhook delivery.
> If your server takes longer than that to respond, then GitHub terminates the connection and
> considers the delivery a failure." [[3]]

Durability is therefore the **receiver's** job, and GitHub documents the pattern it expects: *"Use
the GitHub REST API to fetch data about any webhook deliveries that were attempted since the last
time that your script ran"*, look for *"a `status` value that is not `OK`"*, and *"Use the GitHub
REST API to redeliver any deliveries that failed"* [[10]]. The endpoints are
`POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts` for a repository
webhook and `POST /app/hook/deliveries/{delivery_id}/attempts` for an App's [[11]].

**The delivery log is retained for 3 days** (7 on GHES) [[48]], which bounds the catch-up window: a
control plane down for a long weekend loses mentions, and should say so rather than pretend
otherwise. Whether GitHub auto-disables a webhook after repeated failures is **not established** —
the docs describe only manual deactivation, and say *"If a webhook delivery fails repeatedly, you
should investigate the cause"* [[10]].

Other delivery facts worth having in one place: `X-GitHub-Event` names the event, `X-GitHub-Hook-ID`
the webhook, `X-GitHub-Hook-Installation-Target-Type` and `-ID` the resource it was created on, and
the `User-Agent` *"will always have the prefix `GitHub-Hookshot/`"* [[9]]. Payloads are *"capped at
25 MB"* and a larger event is simply not delivered [[9]]. `GET /meta` returns a `hooks` array of
CIDRs for an allow-list, with GitHub's own warning that it is *"not intended to be an exhaustive
list"* and changes over time [[49]].

### 3.3 What a GitHub App installation adds over a repository webhook

| | Repository webhook | GitHub App |
|---|---|---|
| Configuration | One per repository, created with the `admin:repo_hook` grant | *"GitHub Apps have a single webhook that receives the events they are configured to receive for every repository they have access to"* [[7]] |
| Reply identity | Whoever's token posts | *"An installation token identifies the app as a GitHub App bot account, such as `@jenkins[bot]`"* [[7]] |
| Permissions | OAuth scopes — *"OAuth apps can't use granular permissions"* [[7]] | Per-resource. `issue_comment` needs only *"read-level access for the 'Issues' repository permission"* [[50]] |
| Rate limit | The user's flat 5,000/h | Scales with repositories and users, to 12,500/h [[1]] |
| Credential lifetime | A long-lived token | An installation token that *"will expire after 1 hour"*, minted from a JWT [[12]] |
| Delivery log | Per webhook, per repository | One log for the whole app, under the app's JWT [[11]] |

For a per-install product the first row is the one that decides it: one webhook configuration
instead of one per repository, and an install that adds a repository later gets coverage for free.

**The App can be created by the install itself, which matters for "one app per install."** The
manifest flow is a browser handshake, not a support ticket: redirect to
`https://github.com/settings/apps/new` with a `manifest` parameter, the person clicks *Create GitHub
App*, GitHub redirects back with a temporary `code`, and `POST /app-manifests/{code}/conversions`
*"will include the `id` (GitHub App ID), `pem` (private key), and `webhook_secret`"* in one response
— *"within one hour"* [[51]]. So a self-hosted Firetower can create its own App and seal the private
key and webhook secret straight into its own vault, with no human copying secrets between windows.
This is the GitHub analogue of Slack's app manifest that #363 called the obvious lever.

Two notes on that flow. `hook_attributes.url` is **required** in the manifest [[51]] — an App must
declare a webhook URL even when nothing will listen at it. And the redirect lands in the *person's*
browser, which under shape 1 is the end of their own ssh tunnel, so `http://127.0.0.1:8080/…` is
reachable by the only party that needs to reach it; GitHub's callback-URL guidance points at the
loopback literal `127.0.0.1` rather than the string `localhost` [[52]]. **Whether that specific
redirect is accepted is not established** and is a ten-minute test.

### 3.4 A webhook with nothing listening — poll the delivery log

This one is novel, follows from facts established above, and is **untested**.

An App's delivery log is readable, and `GET /app/hook/deliveries/{delivery_id}` returns not just the
status but the full `request` object, *"headers, payload"*, under the app's JWT [[11]]. Combine that
with §3.3's observation that `hook_attributes.url` must be declared but need not answer, and the
control plane can **poll GitHub for the payloads of webhook deliveries that never arrived**: one
`GET /app/hook/deliveries?cursor=…` per interval, O(1) in repositories, carrying exactly the
`issue_comment` body a real webhook would have carried — with no inbound endpoint, no open port, and
a GitHub App identity to reply with.

It is attractive precisely because it closes the gap §1.2 opens: it is the only shape where
`firetower[bot]` can both hear and answer without an inbound endpoint. It also inherits the
3-day retention [[48]] as its catch-up window, which is better than most queues.

What has to be tested before anybody believes it, and all four are **not established**:

1. Whether a delivery to an unreachable URL still records a `request.payload`, or whether GitHub
   stores the payload only on an attempt it managed to send.
2. Whether GitHub auto-disables an App webhook that fails every single time — §3.2 found no
   documented threshold, but "no documented threshold" is not "no threshold."
3. What rate limit app-level JWT requests consume (**not established**, §2.5).
4. Whether this is within the spirit of the API. It is not a documented use; it is a documented
   endpoint used for something GitHub did not have in mind.

Write it down, test it, and do not ship it on reasoning alone.

### 3.5 Which events carry a comment

`issue_comment` with `action: created` is the main one, and it covers both surfaces: *"This event
occurs when there is activity relating to a comment on an issue or pull request"* [[50]]. Actions
are `created`, `edited`, `deleted`, `pinned`, `unpinned`, and the subscription needs *"at least
read-level access for the 'Issues' repository permission"* [[50]]. Diff-line comments are
`pull_request_review_comment`; a submitted review is `pull_request_review`; there are also
`discussion_comment` and `commit_comment` [[9]]. **There is no `mentioned` action and no
mention-specific event** — which is the webhook-side half of §4.2.

---

## 4. Reply identity

### 4.1 What Firetower holds today

`providers.rs` is unambiguous, and the ticket quotes it correctly. `AuthMode` has exactly two
variants: `Device`, *"The device authorization grant. One application registered for the
installation, a short code approved in a browser, a token each"*, and `Token`, *"Everybody makes a
token on the host and pastes it."* The module header says where the result lives and why:

> "The token belongs to neither. It stays in the vault at `git/<id>/<owner>`, one per person per
> connection."

`vault.rs:704` keys it `Key::of(GIT, "github", "u_alice")`. So: **two auth modes, both producing a
person's token, with no bot identity anywhere.** Firetower also has no comment-posting path at all
today — `oauth::open_pull_request` and `amend_pull_request` are the only writes to a host's API, and
both run *"on the control plane with the token"* as the owner. So "who the reply comes from" is a
genuinely new question, not a variation on an existing one.

The vault already has the shape the answer needs, though. `vault.rs:67`'s `Key::shared(scope, name)`
is documented as *"a secret belonging to the install rather than to anybody in it"*, and the map
notes that is *"exactly the shape a bot token takes."* Nothing has to be invented to store one.

### 4.2 Why a GitHub App cannot hear its own name

Two documented facts, one inference, and an honest gap.

**Fact one.** `GET /notifications` and its siblings: *"These endpoints only support authentication
using a personal access token (classic)"* [[2]]. An installation access token cannot call them. The
notification inbox is a property of a user account, and a GitHub App does not have one.

**Fact two.** GitHub's own GraphQL schema separates the two kinds of actor. `Bot` is *"A special type
of user which takes actions on behalf of GitHub Apps"* and is a distinct object type from `User`,
both implementing the shared `Actor` interface — while `Repository.mentionableUsers` is typed
`UserConnection!` and described as *"A list of Users that can be mentioned in the context of the
repository"* [[13]]. GitHub's schema structurally excludes `Bot` actors from the mentionable set,
even though a `Bot` can author a comment.

**The gap, stated plainly.** No sentence on docs.github.com says "a GitHub App cannot be
@-mentioned," so the literal claim is **not established**. Everything available points the same way:
there is no `mentioned` webhook action anywhere in the event catalogue [[9]][[50]]; GitHub's own
tutorial for a comment-driven app teaches subscribing to the event and inspecting the body [[53]];
`@copilot` in a comment is documented purely as text you type, with no autocomplete and no dedicated
event [[54]]; and **Dependabot had to be special-cased into mention autocomplete as a product
change** — *"Dependabot is a friendly co-developer supporting millions of repositories, but
previously wasn't included in mention suggestions… Starting today, you can more easily mention
Dependabot, thanks to autocomplete"* [[55]]. First-party bots get into that surface by shipping a
feature; there is no registration a third-party App can perform.

**But this matters less than it looks**, and the distinction is the useful part of this section.
Detection does not need GitHub's mention machinery. A webhook (or a comment listing, or the delivery
log) hands over the comment body verbatim, and `@firetower` in that body is a string match Firetower
performs itself. GitHub's autocomplete is cosmetic; what it costs is discoverability — somebody
typing `@fire…` sees no suggestion and has to know the name — and the loss of the free notification
feed, which is the expensive half.

So the clean statement of the trade:

- **`GET /notifications` is the cheap, O(1), repository-count-independent detector**, and it is
  available **only** to a human-shaped account holding a classic PAT.
- **A GitHub App has the clean reply identity** and must detect by string-matching a body it obtains
  some other way: an inbound webhook (§3), an O(N) sweep (§2.3), or the delivery log (§3.4).

### 4.3 The machine user, costed

GitHub's Terms of Service permit it explicitly, and the wording is worth having to hand because it
is narrower than people assume:

> "You must be a human to create an Account. Accounts registered by 'bots' or other automated
> methods are not permitted." … "We do permit machine accounts: A machine account is an Account set
> up by an individual human who accepts the Terms on behalf of the Account, provides a valid email
> address, and is responsible for its actions. A machine account is used exclusively for performing
> automated tasks." … "You may maintain no more than one free machine account in addition to your
> free Personal Account." [[14]]

And the docs name the concept: *"User accounts are intended for humans, but you can create accounts
to automate activity on GitHub. This type of account is called a machine user"* [[56]].

**The cost is one licence.** GitHub bills for organization members and *"outside collaborators on
private repositories owned by your organization"*, counting each outside collaborator *"once, even if
the user account has access to multiple repositories"*; *"adding an outside collaborator to a
private repository will use one of your paid licenses"* [[15]]. So on anything above Free the bot is
one seat, once, however many repositories it joins. **No bot-specific carve-out is documented** —
the billing reference defines consumption by role with no mention of machine accounts [[15]], which
strongly implies the ordinary rule applies but is **not established** as a sentence about bots.

**The token.** A classic PAT, with `notifications` and `repo`. Classic PATs are *"long-lived"* and
can be set never to expire [[16]]; a fine-grained PAT is *"Configurable (up to 1 year, or no
expiration)"* but is subject to an org-level maximum-lifetime policy, and in any case cannot call
the notifications endpoints [[2]][[16]]. So: **classic, non-expiring, pasted once** — which is
`AuthMode::Token` exactly as it exists.

**What the install actually does:** make the account, accept the ToS as its owner, add it to the
repositories it should answer in, make a classic PAT with two scopes, paste it. Five steps and no
developer-settings archaeology — materially lighter than the Slack and Teams journeys #363 costed.

### 4.4 Posting as the mentioned person

Cheapest, available today, and wrong. It is worth saying precisely *why*, because Firetower already
writes to a host under somebody's name: `oauth::open_pull_request` opens a pull request with the
owner's token, and `docs/trackers.md` has the ship sheet writing `Closes ENG-123` into a body. The
difference is consent at the right granularity. A pull request is a thing the person asked for and
reviewed; a comment that answers a mention is **composed by an agent and signed with their name**,
in a thread their colleagues read, with no marker that they did not write it. It also destroys the
one audit property the map cares about — `schedules.owner_id` is *"who it runs as"* kept separate
from `created_by` *"because those come apart the moment an agent proposes one"*, and a reply under
the asker's name collapses that distinction in public.

If it is ever offered it must be opt-in per person and the comment must say in its own body that an
agent wrote it. It should not be the default, and it should not be the only option.

---

## 5. How far this generalises

The per-host table is §1.1. This is the detail and the per-host sharp edges.

### 5.1 The inversion, stated once

**A self-hosted host on the same private network as the control plane delivers an inbound webhook
trivially, which is the exact opposite of GitHub.com's situation.** Both ends are already inside;
nothing is exposed, no port is opened on the public internet, no relay exists, and `deploy/.env.example`'s
claim that *"every connection is outbound"* is untouched because the connection originates inside the
perimeter. For GHES, GitLab self-managed, Gitea and Forgejo the reachability problem that this whole
map exists to solve **simply does not arise**, and the answer is a webhook with a `Key::shared`
secret, seconds of latency, and no polling at all.

Two concrete gotchas that will bite anyway, and both are worth putting in the setup documentation:

- **Gitea and Forgejo refuse private targets by default.** `ALLOWED_HOST_LIST` defaults to
  `external`, so a webhook aimed at a loopback or private address is rejected until an administrator
  adds `loopback` or the specific CIDR [[40]]. The one configuration where inbound is free is also
  the one that fails closed out of the box.
- **Both default to a 5-second delivery timeout** (`DELIVER_TIMEOUT = 5` in `[webhook]`) [[40]],
  which is half of GitHub's 10 and tighter than any chat platform's acknowledgement budget except
  Slack's and Discord's 3 seconds. Acknowledge, then work.

### 5.2 Gitea and Forgejo — the best case in the effort

**One administrator configuration covers the whole instance.** Gitea distinguishes two things that
are easy to conflate, and only one of them is what you want: *"Gitea also supports admin-defined
`default webhooks`. These are not an extra delivery scope. Instead, they are copied into newly
created repositories and then behave like ordinary repository webhooks"* — a template, applied at
creation time, with no retroactive effect — whereas **system webhooks** *"trigger for all eligible
activity on the instance"* [[36]]. The system webhook is the one to use: set once, covers every
repository including ones created later. Forgejo documents the same split: *"Webhooks can also be
configured on a per-organization and whole-system basis (default webhooks on repository creation or
instance-wide webhooks)"* [[37]].

Signature: `X-Gitea-Signature` is a *"Hex-encoded HMAC-SHA256 of the raw request body, without a
prefix"*, beside `X-Gitea-Event`, `X-Gitea-Delivery` (*"Unique delivery UUID for this attempt"*) and
`X-Gitea-Hook-Installation-Target-Type` — **and Gitea also sends `X-Hub-Signature-256` with the same
digest** for GitHub-tool compatibility [[36]]. Forgejo sends `X-Forgejo-Signature` plus Gitea-, Gogs-
and GitHub-compatible copies simultaneously [[37]]. **So one verifier written for GitHub's
`X-Hub-Signature-256` serves all three hosts**, which is a real saving and the single most useful
implementation note in this section.

Delivery id is per **attempt**, not per event [[36]][[37]] — unlike GitHub, where a redelivery reuses
the original GUID [[3]]. Deduplication on a Gitea delivery id therefore catches a duplicate POST but
not a deliberate replay of the same event, which has to be handled on the payload's own comment id.
Neither host retries automatically; both offer manual redelivery from *Recent Deliveries* [[36]].

Identity: Gitea has a first-class **`Bot` user type**, creatable through `POST /admin/users` beside
`User` and `Organization` [[39]]. It is a normal user record, so it is mentionable like any user and
has a `GET /notifications` inbox of its own [[38]] — GitHub's design without GitHub's restriction.
There is no App-installation model; OAuth2 applications are ordinary OAuth clients [[39]].

Budget: **no rate limiting is built in** on either host — the documented answer is a reverse proxy
[[40]] — so polling is cheap and ETag support is **not established** and does not matter much. Note
`MAX_RESPONSE_ITEMS` defaults to 50, so a `limit=100` is silently clamped [[40]].

### 5.3 GitLab — the host where the free bot cannot hear

**Delivery.** Project, group and instance-level (system) hooks exist; comments arrive as
`X-Gitlab-Event: Note Hook` with `object_kind: note`, which fires *"when a new comment is made or
edited on commits, merge requests, issues, and code snippets"*, with `noteable_type` telling them
apart and `action` one of `create`/`update` [[32]].

**Signing changed, and the ticket's premise is out of date.** Two mechanisms now exist. The legacy
one is `X-Gitlab-Token`, *"Secret token for the webhook, sent as plain text"*, which GitLab's own
docs say *"offers weaker guarantees"* — a bearer secret, not a signature, so a relay in front of it
could forge freely. **GitLab 19.0 added a real body signature**: a `webhook-signature` header
carrying *"a space-separated list of HMAC-SHA256 signatures, each in the format
`v1,{base64_signature}`"* over `{webhook-id}.{webhook-timestamp}.{body}`, modelled on Standard
Webhooks, with companion `webhook-id` (*"Unique message ID consistent across webhook retries"*) and
`webhook-timestamp` headers [[30]]. So **which GitLab you are talking to decides whether the body is
authenticated**, and a verifier must handle both — GitLab's version is already a first-class concern
in `providers.rs` (*"GitLab only grew one in 17.9"*), so this is a familiar shape rather than a new
one.

**Deduplicate on `webhook-id`, not on `X-Gitlab-Event-UUID`.** The latter is *"Unique ID for
non-recursive webhooks"* and recursive webhooks *"share the same value"*; the former is explicitly
*"consistent across webhook retries"* and equal to `Idempotency-Key` [[30]].

**Retries and auto-disable.** GitLab does not retry with backoff; a failure is a failure and
redelivery is a manual *Resend Request*. But it does **disable**: *"GitLab automatically disables
project or group webhooks that fail four consecutive times"*, temporarily at four consecutive
failures and permanently at forty, re-enabled by sending a test request [[30]]. A control plane that
goes down for an hour can therefore come back to a **disabled** webhook — a failure mode GitHub does
not have, and one the health screen should notice. Timeout is 10 s on gitlab.com and
`gitlab_rails['webhook_timeout']` on self-managed [[30]].

**Polling.** `updated_after` exists on the issues endpoints [[31a]], but notes are scoped per issue
— `GET /projects/:id/issues/:issue_iid/notes` — and **there is no cross-project "all notes updated
since X" endpoint** (**not established**, and no such endpoint was found). The right instrument is
the **Todos API**: `GET /api/v4/todos` with `action` filters including `mentioned` and
`directly_addressed` [[31]], which is GitLab's functional equivalent of GitHub's notification feed
and is likewise O(1) in projects. Conditional requests do not help: GitLab's ETag caching is *"an
internal mechanism for the web UI's polling"* on allow-listed endpoints and is **not established**
as a public REST API feature [[31b]].

**Budget.** gitlab.com limits *"authenticated API traffic for a user"* to **2,000 requests each
minute** [[35a]] — two orders of magnitude more generous than GitHub per-minute, which makes the
absence of conditional requests tolerable. Self-managed ships limits **off**: GitLab 18.0 applies
them to gitlab.com only, the per-namespace webhook rate limit defaults to *"Disabled (unlimited)"*,
and *"System hooks managed by instance administrators are not rate limited"* [[35]].

**Identity, and the sharp edge.** A project or group access token mints a bot user named
`project_{project_id}_bot_{random}`, and it is free: *"They are non-billable users and do not count
towards your license limit"* — but it *"cannot be added to any other project"* [[33]]. That is
better than GitHub's seat cost and worse in the way that matters: GitLab's notification docs list
*"The account is a project bot"* among the conditions under which **notification delivery is
suppressed** [[34]]. So the free bot can post but **probably cannot hear** — whether a mention of it
creates a Todo is **not established**, and must be tested. If it does not, GitLab's watching identity
has to be an ordinary user account after all, which costs a seat and makes GitLab resemble GitHub
rather than Gitea. There is no App-installation model to fall back on: GitLab's OAuth provider has
exactly *"User owned applications, Group owned applications, Instance-wide applications"*, which
*"only differ by permission level"* [[33a]].

**One outbound possibility worth recording.** GitLab's GraphQL API **does** have subscriptions, over
ActionCable, and a `workItemDiscussionNoteAdded` subscription exists *"to provide real time updates
on a work item when a new comment or system note is added or edited"* [[31c]]. That is a *client-
initiated outbound WebSocket* — structurally the same posture as Slack's Socket Mode, and the only
real-time push path found on any host in this ticket that needs no inbound endpoint. It is scoped to
a work item rather than to a workspace, so it does not obviously answer "tell me about every
mention," and **it is not established as documented on the public GraphQL reference** — found in
GitLab's own source and merge request rather than in the API docs. Record it; do not plan on it.

### 5.4 Linear — the best identity and the worst delivery

Linear is the inverse of Gitea, and the most interesting host in the set.

**It has the first-class mentionable-agent identity nobody else has.** Two OAuth scopes:
`app:mentionable` — *"Allow the app to be mentioned in issues, documents, and other editor
surfaces"* — and `app:assignable` — *"Allow the app to be assigned as a delegate on issues"* [[42]].
And `actor=app` makes the app the author: *"To install your agent into a Linear workspace in the
OAuth authorization url add the `actor=app` parameter… actions performed with the received OAuth
token will come from the app itself"*, where *"all mutations such as creating issues, comments, and
status changes will be performed by the app"* [[43]]. This is exactly what GitHub's `Bot`/`User`
split denies and what a project-bot's suppressed notifications deny on GitLab: an identity that can
**both** be addressed and answer.

**And it is delivered by webhook only.** The purpose-built path is an **Agent Session**: enabling
agent session events on the OAuth app means a delegation or mention *"triggers a `created`
AgentSessionEvent webhook containing an agentSession object with the relevant issue, comment, and
context"*, with subsequent replies in-thread arriving as `prompted` [[42]]. Three webhook categories
exist for an OAuth app — agent session events, inbox notifications, and permission changes [[42]].
Security is good: `Linear-Signature` is a *"hex-encoded HMAC-SHA256 signature of the raw body
contents"*, `Linear-Delivery` is *"A UUID (v4) that uniquely identifies this payload"*, and the body
carries a `webhookTimestamp` that Linear asks you to check *"within a minute of the time your system
sees it to guard against replay attacks"* [[41]]. **Linear is also the only host in this ticket that
retries**: *"the push will be retried a maximum of 3 times. A backoff delay is used: the attempt
will be retried after 1 minute, 1 hour, and finally after 6 hours"* [[41]].

**But Linear is SaaS-only** — two fixed cloud regions, no on-premises product, tier or deployment
documented [[45]] — so there is no private-network shortcut and no version of this where the webhook
is free. An install that will not open a port therefore **cannot use the mechanism Linear built for
this**, and must poll: a `notifications` query on the authenticated user, or `updatedAt` filters on
issues with nested comment filters, against 2,500 requests and 3,000,000 complexity points an hour
for an API key, or 5,000 and 2,000,000 for an OAuth app, with 2× on Business and 5× on Enterprise
[[44a]]. There is **no cross-workspace "all comments since X" query** (**not established**; none
found), so the poll is issue-scoped, which is Linear's version of §2.3's O(N) problem. No conditional
requests — it is one POST, as `docs/trackers.md` already says. And **public GraphQL subscriptions are
not established**: no Linear developer page documents a subscription endpoint, protocol or URL, and
webhooks are presented throughout as the real-time mechanism [[42]][[41]].

So Linear's position is: **the opt-in webhook is not a nicety there, it is the only way to use the
feature Linear shipped for this purpose.** That is a genuine argument for offering the inbound
endpoint, and it belongs to #386.

### 5.5 GitHub Enterprise Server

Same product, same API under `/api/v3`, same notifications endpoint [[28]], same
`X-Hub-Signature-256`. Two differences that favour it: the instance is inside the network, so the
webhook is free and is the obvious answer; and *"Rate limits are disabled by default for GitHub
Enterprise Server"*, with an administrator enabling *"HTTP API Rate Limiting"* and either accepting
*"the prefilled default limits"* or setting custom ones [[29]] — the numeric defaults are **not
established**. The webhook delivery log is retained 7 days rather than 3 [[48]].

---

## 6. What this leaves for #386 and the trigger model

- **Detection is O(1) on four of the seven hosts and O(N) on three**, which is a cleaner seam than
  expected: GitHub, Gitea and Forgejo all have a GitHub-shaped `GET /notifications`, GitLab has the
  Todos API, and Linear has a `notifications` query. A provider seam whose git-host half is "give me
  mentions since this watermark" fits all five feeds and degrades to a per-repository sweep where it
  must.
- **One signature verifier covers GitHub, GHES, Gitea and Forgejo** — all four will send an
  `X-Hub-Signature-256`-shaped HMAC-SHA256 over the raw body [[8]][[36]][[37]]. GitLab needs a second
  (two variants, by version) and Linear a third.
- **The three things `migrations/server/20261111120000_schedules.sql:7` names are all available** on
  the webhook path: a hashed bearer credential (the webhook secret, `Key::shared`), a delivery id to
  deduplicate on (`X-GitHub-Delivery`, and it survives redelivery [[3]]), and a rate limit (needed
  independently, since GitHub does not retry and therefore cannot be slowed by a 429).
- **Nothing buffers for you on any git host.** GitHub does not retry [[10]], Gitea and Forgejo do
  not [[36]], GitLab does not and disables instead [[30]]. Only Linear retries [[41]]. That is the
  same conclusion #363 reached for chat, arrived at from the other direction, and it means the
  catch-up sweep is not optional on the webhook path either — it is the thing that makes a webhook
  survivable. GitHub's 3-day delivery log is the window [[48]].
- **"An agent may propose but may not activate" still holds.** A mention is one more thing that
  merely creates, and inherits `api/schedules.rs:create_schedule`'s rule unchanged.

---

## 7. Gaps — not established

In rough order of how much each would change a decision.

- **Whether a GitLab project-bot can receive a mention at all.** GitLab lists *"The account is a
  project bot"* as a notification-suppression condition [[34]] but does not say whether a Todo is
  created. If it is not, GitLab loses its free bot identity and needs a licensed account. One live
  test.
- **Whether a mention on an unwatched GitHub repository produces a notification.** Strongly implied
  by *"Participating and @mentions"* being the default and by participating being defined to include
  being @mentioned [[24]], but never stated. If it is false, §2.2's O(1) design acquires an O(N)
  setup step.
- **Whether `notifications` scope is actually required**, or whether `repo` suffices. The
  notifications guide and the OAuth scopes reference flatly disagree [[2]][[23]]. The answer decides
  whether every existing GitHub authorization must be redone.
- **All four preconditions of the delivery-log route (§3.4)**: whether a failed delivery retains its
  payload, whether an always-failing App webhook is auto-disabled, what app-level JWT requests cost,
  and whether the use is sanctioned.
- **Whether a `304` counts toward GitHub's secondary limits.** Not stated either way [[1]]. Decides
  the ceiling on §2.3's sweep rate.
- **Whether a GitHub App can be @-mentioned.** No docs.github.com sentence either way. Every
  structural signal says no (§4.2), and the practical consequence is small because detection is a
  string match — but the literal claim is unproven.
- **GitHub's comment-to-notification delay.** No published figure, so the latency floor in §1.3 has
  an unmeasured term in it. Measurable in an afternoon with one repository and a clock.
- **Whether a machine account consumes a paid seat.** The billing reference defines consumption by
  role with no bot carve-out [[15]], which implies yes but never says it about bots.
- **ETag support on `/search/issues`** (§2.4), on GitLab's public REST API [[31b]], and on
  Gitea/Forgejo's [[40]] — all three unestablished, which is why the recommendation rests on
  notification feeds rather than on conditional requests everywhere.
- **GitHub webhook auto-disable after repeated failures.** No documented threshold [[10]]; absence
  of documentation is not absence of behaviour.
- **GitLab's `workItemDiscussionNoteAdded` subscription** as a supported public API [[31c]] — found
  in GitLab's source and merge request, not in the GraphQL reference. The only no-inbound push path
  on any host here, and the least documented thing in this file.
- **Linear's `AppUserNotification` webhook type and its exact enum values** (`issueCommentMention`,
  `issueMention`). The type is referenced in Linear's own changelog but no fetched developer page
  defines it, and the enum values were not confirmed on a primary page. Introspect the live schema
  at `api.linear.app/graphql` rather than trusting a secondary source. Build against
  `AgentSessionEvent` regardless [[42]].
- **Linear public GraphQL subscriptions.** Claimed by one third-party source, documented nowhere on
  linear.app. Treat as absent [[42]][[41]].
- **Whether the App manifest flow accepts a loopback redirect** (§3.3). GitHub's callback guidance
  points at `127.0.0.1` over `localhost` [[52]] but says nothing about the manifest flow
  specifically.
- **GHES's prefilled default rate limits**, once an administrator enables limiting [[29]].
- **Whether a comment body appears in Enterprise Cloud audit log streaming** [[20]]. Academic — the
  channel is wrong for this regardless.
- **GitHub App private keys: the maximum number active at once.** Rotation is the documented pattern
  (generate new, delete old); no cap was found [[57]].

---

## Citations

1. Best practices for using the REST API (conditional requests, `x-poll-interval`, secondary limits, point values) — https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api and https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
2. REST API endpoints for notifications — https://docs.github.com/en/rest/activity/notifications
3. Best practices for using webhooks (10 s budget, `X-GitHub-Delivery` dedupe, redelivery reuses the id) — https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
4. REST API endpoints for search (30/min, 1,000 results, `incomplete_results`) — https://docs.github.com/en/rest/search/search
5. REST API endpoints for issue comments — https://docs.github.com/en/rest/issues/comments
6. REST API endpoints for pull request review comments — https://docs.github.com/en/rest/pulls/comments
7. Differences between GitHub Apps and OAuth apps — https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
8. Validating webhook deliveries — https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
9. Webhook events and payloads (headers, payload cap, event catalogue) — https://docs.github.com/en/webhooks/webhook-events-and-payloads
10. Handling failed webhook deliveries — https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
11. REST API endpoints for GitHub App webhooks (`GET /app/hook/deliveries`, redelivery) — https://docs.github.com/en/rest/apps/webhooks ; repository equivalent — https://docs.github.com/en/rest/repos/webhooks
12. Authenticating as a GitHub App installation — https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
13. GraphQL reference — `Bot`, `Actor`, `Repository.mentionableUsers` — https://docs.github.com/en/graphql/reference/objects and https://docs.github.com/en/graphql/reference/interfaces
14. GitHub Terms of Service, Account Requirements (machine accounts) — https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
15. People who consume a license in an organization — https://docs.github.com/en/billing/reference/github-license-users
16. GitHub credential types (PAT lifetimes) — https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types
17. Forming calls with GraphQL — *"The two types of allowed operations…"* — https://docs.github.com/en/graphql/guides/forming-calls-with-graphql and https://docs.github.com/en/graphql/overview/about-the-graphql-api
18. REST API endpoints for repositories (`/dispatches`) — https://docs.github.com/en/rest/repos/repos ; Trigger a workflow — https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
19. Communicating with self-hosted runners — *"There is no need for an inbound connection"* — https://docs.github.com/en/enterprise-server@3.13/actions/concepts/runners/communicating-with-self-hosted-runners
20. Streaming the audit log for your enterprise — https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/streaming-the-audit-log-for-your-enterprise
21. Rate limits and node limits for the GraphQL API — https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
22. Inbox filters (`reason:mention`) — https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters
23. Scopes for OAuth apps — https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
24. Configuring notifications — https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
25. Searching issues and pull requests (`in:comments`, `mentions:`, `commenter:`, `involves:`) — https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
26. Issues advanced search in the API — https://github.blog/changelog/2025-03-06-github-issues-projects-api-support-for-issues-advanced-search-and-more/
27. REST API endpoints for rate limits — https://docs.github.com/en/rest/rate-limit/rate-limit
28. GHES notifications API — https://docs.github.com/en/enterprise-server@3.22/rest/activity/notifications
29. GHES rate limits — https://docs.github.com/en/enterprise-server@3.22/rest/using-the-rest-api/rate-limits-for-the-rest-api and https://docs.github.com/en/enterprise-server@3.22/admin/configuring-settings/configuring-user-applications-for-your-enterprise/configuring-rate-limits
30. GitLab webhooks (headers, `webhook-signature`, `webhook-id`, auto-disable, timeout) — https://docs.gitlab.com/user/project/integrations/webhooks/
31. GitLab Todos API — https://docs.gitlab.com/api/todos/
31a. GitLab Issues API (`updated_after`) — https://docs.gitlab.com/api/issues/ ; Notes API — https://docs.gitlab.com/api/notes/
31b. GitLab polling with ETag caching (internal mechanism) — https://docs.gitlab.com/development/polling/
31c. GitLab real-time features / ActionCable subscriptions — https://docs.gitlab.com/development/real_time/ and https://gitlab.com/gitlab-org/gitlab/-/merge_requests/107649
32. GitLab webhook events — `Note Hook` — https://docs.gitlab.com/user/project/integrations/webhook_events/
33. GitLab project access tokens (bot user, non-billable) — https://docs.gitlab.com/user/project/settings/project_access_tokens/
33a. GitLab OAuth provider (three application types) — https://docs.gitlab.com/integration/oauth_provider/
34. GitLab notification emails (*"The account is a project bot"*) — https://docs.gitlab.com/user/profile/notifications/
35. GitLab instance limits (self-managed defaults, system hooks not rate limited) — https://docs.gitlab.com/administration/instance_limits/
35a. GitLab.com rate limits — https://docs.gitlab.com/user/gitlab_com/rate_limits/
36. Gitea webhooks (system and default webhooks, `X-Gitea-Signature`, `X-Hub-Signature-256`, redelivery) — https://docs.gitea.com/usage/webhooks
37. Forgejo webhooks (instance-wide, `X-Forgejo-Signature`, compatibility headers) — https://forgejo.org/docs/latest/user/webhooks/
38. Gitea API reference (notifications) — https://docs.gitea.com/api/1.24/
39. Gitea admin create user (`Bot` type) — https://docs.gitea.com/api/operations/admin-create-user/ ; OAuth2 provider — https://docs.gitea.com/development/oauth2-provider/
40. Gitea config cheat sheet (`DELIVER_TIMEOUT`, `MAX_RESPONSE_ITEMS`) — https://docs.gitea.com/administration/config-cheat-sheet/ ; Forgejo equivalent (`ALLOWED_HOST_LIST`) — https://forgejo.org/docs/latest/admin/config-cheat-sheet/
41. Linear webhooks (`Linear-Signature`, `Linear-Delivery`, `webhookTimestamp`, retries) — https://linear.app/developers/webhooks
42. Linear agents (`app:mentionable`, `app:assignable`, `AgentSessionEvent`) — https://linear.app/developers/agents and https://linear.app/developers/agent-best-practices
43. Linear OAuth actor authorization (`actor=app`) — https://linear.app/developers/oauth-actor-authorization
44. Linear pagination and filtering — https://linear.app/developers/pagination
44a. Linear rate limiting — https://linear.app/developers/rate-limiting
45. Linear EU data hosting (SaaS-only, two regions) — https://linear.app/changelog/2024-05-23-european-union-data-hosting ; security — https://linear.app/security
46. Extend GitHub with agent apps (2 June 2026) — https://github.blog/changelog/2026-06-02-extend-github-with-agent-apps/
47. Agent apps — https://docs.github.com/en/copilot/concepts/agents/agent-apps ; Third-party coding agents — https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents
48. Redelivering webhooks (3-day retention; 7 on GHES) — https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
49. About GitHub's IP addresses — https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-githubs-ip-addresses ; `GET /meta` — https://docs.github.com/en/rest/meta/meta
50. `issue_comment` event and its permission — https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment
51. Registering a GitHub App from a manifest — https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
52. About the user authorization callback URL — https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url
53. Building a GitHub App that responds to webhook events — https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events
54. Making changes to an existing PR with Copilot (`@copilot` in a comment) — https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr
55. `@dependabot` autocomplete for mention suggestions (15 Nov 2022) — https://github.blog/changelog/2022-11-15-dependabot-autocomplete-for-mention-suggestions/
56. Types of GitHub accounts (machine user) — https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts
57. Managing private keys for GitHub Apps — https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps

[1]: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
[2]: https://docs.github.com/en/rest/activity/notifications
[3]: https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
[4]: https://docs.github.com/en/rest/search/search
[5]: https://docs.github.com/en/rest/issues/comments
[6]: https://docs.github.com/en/rest/pulls/comments
[7]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
[8]: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
[9]: https://docs.github.com/en/webhooks/webhook-events-and-payloads
[10]: https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries
[11]: https://docs.github.com/en/rest/apps/webhooks
[12]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
[13]: https://docs.github.com/en/graphql/reference/objects
[14]: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
[15]: https://docs.github.com/en/billing/reference/github-license-users
[16]: https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/github-credential-types
[17]: https://docs.github.com/en/graphql/guides/forming-calls-with-graphql
[18]: https://docs.github.com/en/rest/repos/repos
[19]: https://docs.github.com/en/enterprise-server@3.13/actions/concepts/runners/communicating-with-self-hosted-runners
[20]: https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/streaming-the-audit-log-for-your-enterprise
[21]: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
[22]: https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters
[23]: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
[24]: https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications
[25]: https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
[26]: https://github.blog/changelog/2025-03-06-github-issues-projects-api-support-for-issues-advanced-search-and-more/
[27]: https://docs.github.com/en/rest/rate-limit/rate-limit
[28]: https://docs.github.com/en/enterprise-server@3.22/rest/activity/notifications
[29]: https://docs.github.com/en/enterprise-server@3.22/rest/using-the-rest-api/rate-limits-for-the-rest-api
[30]: https://docs.gitlab.com/user/project/integrations/webhooks/
[31]: https://docs.gitlab.com/api/todos/
[31a]: https://docs.gitlab.com/api/issues/
[31b]: https://docs.gitlab.com/development/polling/
[31c]: https://docs.gitlab.com/development/real_time/
[32]: https://docs.gitlab.com/user/project/integrations/webhook_events/
[33]: https://docs.gitlab.com/user/project/settings/project_access_tokens/
[33a]: https://docs.gitlab.com/integration/oauth_provider/
[34]: https://docs.gitlab.com/user/profile/notifications/
[35]: https://docs.gitlab.com/administration/instance_limits/
[35a]: https://docs.gitlab.com/user/gitlab_com/rate_limits/
[36]: https://docs.gitea.com/usage/webhooks
[37]: https://forgejo.org/docs/latest/user/webhooks/
[38]: https://docs.gitea.com/api/1.24/
[39]: https://docs.gitea.com/api/operations/admin-create-user/
[40]: https://docs.gitea.com/administration/config-cheat-sheet/
[41]: https://linear.app/developers/webhooks
[42]: https://linear.app/developers/agents
[43]: https://linear.app/developers/oauth-actor-authorization
[44]: https://linear.app/developers/pagination
[44a]: https://linear.app/developers/rate-limiting
[45]: https://linear.app/changelog/2024-05-23-european-union-data-hosting
[46]: https://github.blog/changelog/2026-06-02-extend-github-with-agent-apps/
[47]: https://docs.github.com/en/copilot/concepts/agents/agent-apps
[48]: https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks
[49]: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-githubs-ip-addresses
[50]: https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment
[51]: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
[52]: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url
[53]: https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-github-app-that-responds-to-webhook-events
[54]: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/make-changes-to-an-existing-pr
[55]: https://github.blog/changelog/2022-11-15-dependabot-autocomplete-for-mention-suggestions/
[56]: https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts
[57]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps
