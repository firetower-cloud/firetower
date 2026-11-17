# How a verification run isolates itself from the developer's own Firetower

Research for [#331](https://github.com/firetower-cloud/firetower/issues/331), under the map at
[#329](https://github.com/firetower-cloud/firetower/issues/329). Blocks
[#334](https://github.com/firetower-cloud/firetower/issues/334), the CLI command surface.

Established by reading the repository and observing this session's environment read-only. No
server was started, no port bound, no Docker command run. Every claim carries a `path:line`.
Where something could not be established by reading it says so under **Not established** — a
guess recorded as a fact is the worst outcome here.

**The answer in one paragraph.** Derive everything from `$FIRETOWER_SESSION`, which is already
exported into every session and is already the key Firetower itself isolates Docker by
(`crates/ft-worker/src/lib.rs:2547-2550`). Three of the four ports are configurable by env var
or flag and one — the compose file's own `4400:4400` / `3000:3000` — is hardcoded, so a
verification run must start its processes directly rather than through `docker compose --profile
full`. The Chrome profile needs no work to be safe today and needs a deliberate decision not to
make it unsafe: `chromium.launch()` already gets a throwaway profile per launch. The refusal rule
from `verify-atlas` transfers in shape but **its discriminator inverts** — in Firetower every
agent checkout is a git worktree, so `test -f .git` is the normal case, not the exceptional one.
Ownership should be asserted positively, by asking the control plane at the address who it is
(`GET /api/v1/bootstrap` → `serverId`), following the house rule already written down in
`desktop/src/servers.ts:15-44`.

**Measured live on this machine while writing this**, which is the whole ticket in one line:

```
$ lsof -nP -iTCP -sTCP:LISTEN
firetower 98102 … TCP 127.0.0.1:4400 (LISTEN)    → target/debug/firetower serve --dev
OrbStack   1877 … TCP *:5433 (LISTEN)
```

The developer's own control plane is on `:4400` right now — and it is the one hosting this
session. A run that defaulted to `:4400` would not be fighting over a port; it would be driving
the Firetower that owns it.

---

## 1. Every port the real stack publishes, and whether each is configurable

| What | Port | Configurable? | How |
|---|---|---|---|
| Control plane (`ft-server` via `ft-cli serve`) | 4400 | **Yes** | `--port`, or `FIRETOWER_PORT` — `crates/ft-cli/src/main.rs:37` |
| Control plane bind address | 127.0.0.1 | **Yes** | `--bind`, or `FIRETOWER_BIND` — `crates/ft-cli/src/main.rs:47` |
| Desktop Vite dev server | 5273 | **Yes, flag only** | `vite --port <n>`; `server.port` in `desktop/vite.config.ts:15` is hardcoded and there is **no env var** |
| Web app (`next dev`) | 3000 | **Yes** | `-p/--port` or `PORT` env |
| Postgres (dev `compose.yaml`) | 5433 → 5432 | **Yes** | `POSTGRES_PORT` — `compose.yaml:37`, documented `.env.example:24` |
| `compose.yaml` `firetower` service | 4400, 3000 | **No — hardcoded** | `compose.yaml:71-72`, literal `"4400:4400"` and `"3000:3000"` |
| Mock control plane (not used by us) | 4401 | **Yes, positional arg** | `desktop/scripts/mock-server.mjs:16`, `node mock-server.mjs [port]` |
| Deployment (`deploy/firetower.yml`) | 8080 → 4400 | Yes | `HTTP_PORT` / `HTTP_BIND` — `deploy/firetower.yml:74` |
| Deployment Caddy | 443, 80 | Partly | `HTTPS_PORT` / `HTTPS_BIND` — `deploy/firetower.yml:207-212`; 80 is fixed |
| Deployment Postgres | — | n/a | **publishes nothing** — `deploy/firetower.yml:273` |

### Control plane — `:4400`, configurable both ways

`crates/ft-cli/src/main.rs:37`:

```rust
#[arg(long, env = "FIRETOWER_PORT", default_value_t = 4400)]
port: u16,
```

`--bind` is the same shape, `FIRETOWER_BIND`, default `127.0.0.1`
(`crates/ft-cli/src/main.rs:47`). `healthcheck` reads the same variable
(`crates/ft-cli/src/main.rs:109`), so a doctor step can ask a non-default instance whether it is
ready without being told the port twice. The bare `firetower` with no subcommand also honours it:
it asks clap for what `serve` would have parsed rather than restating defaults, and the comment
says this was fixed precisely because the bare command *used* to ignore `FIRETOWER_PORT`
(`crates/ft-cli/src/main.rs:327-337`).

`DATABASE_URL` is a flag and an env var too, defaulting to
`postgres://firetower:firetower@localhost:5433/firetower` (`crates/ft-cli/src/main.rs:72`,
and again on `passwd` at `:93`). So a run gets its own database by pointing `DATABASE_URL` at its
own Postgres — this is the precedent `docs/acp.md:173-176` already names, "an isolated Firetower
home and database".

`FIRETOWER_HOME` is global on every subcommand (`crates/ft-cli/src/main.rs:29`) and is where the
root key lives; `.env.example:35-37` says it defaults to `~/.firetower`. **A run must set it.**
Two control planes sharing `~/.firetower` share the key that seals every credential, and
`.gitignore:26-29` shows the house habit for this already — `/.dev-home` and `/.ft-home` are
ignored "a control plane started by hand with FIRETOWER_HOME pointed somewhere local".

### Desktop Vite — `:5273`, hardcoded in config, overridable only on the command line

`desktop/vite.config.ts:15`:

```ts
server: { port: 5273, strictPort: true },
```

Verified against the installed Vite (7.3.6): the CLI has `--port <port>`
(`desktop/node_modules/vite/dist/node/cli.js:568`) and passes CLI options as the inline `server:`
config to `createServer`, which wins over the config file. Vite's CLI reads **no** `PORT`
environment variable — `grep -c "process.env.PORT"` over that `cli.js` is `0`. So the only way to
move this port is `pnpm dev -- --port <n>` (or `vite --port <n>`).

`strictPort: true` survives a CLI `--port`, and that is *desirable*: Vite exits rather than
silently sliding to the next free port, so a collision is a failure and never a run quietly
rendering on somebody else's port.

`desktop/src-tauri/tauri.conf.json:8` pins `"devUrl": "http://localhost:5273"`. That only
constrains `tauri dev`, which the Chrome route does not use — but it does mean moving the Vite
port breaks `just`-free `pnpm app` for whoever is running the native shell at the same time.

**There is already a second renderer port in the repository, and nothing starts it.**
`desktop/e2e/cursor-live.mjs:16` defaults to `http://127.0.0.1:5281`, and `docs/acp.md:173-174`
says to run it "against the Vite renderer, server and worker from one checkout" without saying
how the renderer gets onto 5281. Somebody ran `vite --port 5281` by hand. That is the existing
precedent for the derived-port approach and it is undocumented; #334 should make it a flag.

### Web app — `:3000`, configurable, and mostly out of scope

`web/package.json:7` is a bare `"dev": "next dev"`. Verified against the installed Next (16.3.0),
`web/node_modules/next/dist/bin/next:155`:

```js
new Option('-p, --port <port>', …).argParser(parseValidPositiveInteger).default(3000).env('PORT')
```

So both `-p` and `PORT` work. `justfile:93` starts it with
`NEXT_PUBLIC_FIRETOWER_API=http://localhost:4400`, which is how the interface is told where the
API is (`web/src/api/http.ts:15`); a run that moved the control-plane port and wanted the web app
too would have to move this with it. #329 puts `web/` out of scope as a driving target, so this
matters only as a port not to collide with.

In `--dev` the control plane serves no interface and advertises `http://localhost:3000` as the
public URL (`crates/ft-server/src/lib.rs:356-359`) unless `FIRETOWER_PUBLIC_URL` says otherwise
(`crates/ft-server/src/lib.rs:346`). So a run on a derived control-plane port should set
`FIRETOWER_PUBLIC_URL`, or the first-start log line and any deep link in a notification point at
a port nothing is on.

### Postgres — configurable, and the comment explains the default

`compose.yaml:34-37`:

```yaml
ports:
  # 5433 on purpose: 5432 is usually already taken by something local, and
  # a port conflict at start-up is a confusing way to learn that.
  - "${POSTGRES_PORT:-5433}:5432"
```

`POSTGRES_USER` / `PASSWORD` / `DB` are variables too (`compose.yaml:31-33`, documented
`.env.example:20-24`). The container side is always 5432; only the host side moves.

### The one that is hardcoded

`compose.yaml:70-72` publishes `"4400:4400"` and `"3000:3000"` with no variable in sight. That is
the `firetower` service, behind `profiles: ["full"]` (`compose.yaml:74`), reached by `just up`
(`justfile:68`). **Consequence for the skill: a verification run must not use `docker compose
--profile full`.** It can use the `postgres` service (whose port is configurable) and start
`ft-server` and Vite as plain processes, which is what `just dev` does anyway
(`justfile:92-93`) and what `docs/acp.md:173` describes for the existing live harness.

### A CORS constraint that decides the shape of the stack

`crates/ft-server/src/lib.rs:631-647`: the allowed origins are `AllowOrigin::any()` **only when
`dev`**; otherwise it is the three-item allowlist `tauri://localhost`, `http://tauri.localhost`,
`https://tauri.localhost` (`crates/ft-server/src/lib.rs:650-654`). The Chrome route's page origin
is `http://localhost:<vite-port>`, which is on that list under no spelling. So:

- the verification `ft-server` **must** run with `--dev` / `FIRETOWER_DEV=1`
  (`crates/ft-cli/src/main.rs:55-64`), or every API call from the driven page is refused by the
  engine;
- which means the Chrome route can never be pointed at a production-shaped server, and the
  skill's "what this cannot prove" section inherits one more line.

The app itself has no hardcoded dev port: `packaged()` tests the origin against the three tauri
origins only (`desktop/src/probe.ts:55-57`, and `desktop/src/probe.test.ts:73` asserts
`packaged("http://localhost:5273") === false`), and `candidates()` accepts
`localhost:<port>` / `127.0.0.1:<port>` and prefixes `http://`
(`desktop/src/probe.ts:81-88`). So a derived control-plane port is typeable into the first-run box
on the ordinary user path, and a derived Vite port changes no app behaviour.

---

## 2. How `COMPOSE_PROJECT_NAME` is already used to isolate

### It is already set in every session, and this one proves it

`crates/ft-worker/src/lib.rs:2541-2550`, in the code that builds a session's environment:

```rust
// Compose scopes a stack by project name, and every session on this
// worker shares one daemon — so without this, two sessions running the
// same `compose.yaml` are one stack: the second `up` adopts and
// restarts the first session's containers, in the first session's
// directories. Naming it per session also gives teardown the label it
// sweeps by. See `docker::project`.
env.push(("COMPOSE_PROJECT_NAME".to_string(), crate::docker::project(&id)));
```

`crates/ft-worker/src/docker.rs:89-100` is `project()`: `ft-` plus the session id, sanitised to
Compose's charset. Observed in this session:

```
$ echo $COMPOSE_PROJECT_NAME
ft-s_01m7megepcew9jp9m8gcm8pgy6
$ echo $FIRETOWER_SESSION
s_01m7megepcew9jp9m8gcm8pgy6
```

So a verification run inside a session gets Docker-project isolation **for free**, without asking.

### What `just session-check` sets its own for, in its own words

`justfile:216-227`:

```
# A project of this check's own, not the session's.
#
# The session sets COMPOSE_PROJECT_NAME for everything it runs, so without
# this the check would share a project with whatever the agent already has
# up — and `compose down --remove-orphans` would then tear down that work,
# because from this directory's compose file every one of its containers is
# an orphan. Isolating also makes the teardown assertion below mean
# something rather than counting somebody else's containers.
export COMPOSE_PROJECT_NAME="ft-session-check-$$"
```

Two distinct reasons, and a verification run wants both:

1. **`--remove-orphans` is lethal across compose files sharing a project name.** Any container in
   the project that is not a service in *this* compose file is an orphan to it, and will be
   offered for removal — or removed outright with the flag. The recipe's own teardown is
   `docker compose down -v --remove-orphans` (`justfile:227`, `justfile:275`). A verification run
   that brings up its own stack under the session's project name and then tears it down with
   `--remove-orphans` destroys whatever else the agent had running in that project.
2. **A teardown assertion is only meaningful inside a project you own.** `justfile:276` counts
   `label=com.docker.compose.project=$COMPOSE_PROJECT_NAME`; without its own project that count
   is somebody else's containers.

`compose.yaml:7-24` is the same argument at the level of the whole repository: `firetower-dev` is
deliberately *not* `firetower`, because sharing a project name with `deploy/firetower.yml` means
both resolve `postgres:` to the same `firetower_postgres` volume — "whichever came up first owns
the database", "`just reset` runs `docker compose down -v`, which would take the deployment's
database with it". `deploy/firetower.yml:47-54` states the other half: that name is fixed, because
changing it would orphan the volumes of every existing installation.

### So: yes, a verification run should set its own — with `-p`, not the env var

**Recommendation:** every `docker compose` the skill runs should carry an explicit
`-p ft-verify-<key>`, and the skill should never rely on inheriting the session's
`COMPOSE_PROJECT_NAME`. Two reasons:

- the run then owns a project no one else writes to, so `down -v --remove-orphans` is safe and a
  "nothing left" assertion means something — exactly `session-check`'s reasoning;
- `-p` is unambiguous. **Not established:** `compose.yaml:25` pins `name: firetower-dev` as a
  top-level attribute, and I could not establish *from this repository* whether
  `COMPOSE_PROJECT_NAME` overrides a file's `name:`. `session-check` does not settle it — the
  compose file it writes at `justfile:246` has no `name:` field at all. Docker documents a
  precedence order in which `-p` is highest, but that is documentation I did not verify here, and
  verifying it would mean running Docker, which this ticket forbids. Using `-p` makes the question
  moot, which is why it is the recommendation.

### A hazard this uncovers, and it is not about ports

`just reset` is `docker compose down -v` plus `rm -rf ~/.firetower/worker` (`justfile:289-291`).
In this session `FIRETOWER_WORKER_ROOT=/Users/kevinpiacentini/.firetower/worker`, and this
checkout is at
`/Users/kevinpiacentini/.firetower/worker/worktrees/agent-…-gcm8pgy6/firetower`. **`just reset`
run from inside a Firetower session deletes the worktree the session is running in, along with
every other live session's worktree on that machine.** `just db`, `just db-clean`,
`just db-vacuum` and `just reset` all call `docker compose` with no `-p`
(`justfile:52, 184-187, 285, 290`). The skill's Doctor section should refuse `just reset`
outright, and the Cleanup section must never call it.

---

## 3. Where a Chrome user-data-dir should live

### What the harness does today: nothing, and that is already safe

Every driving script in `desktop/scripts/` calls `chromium.launch({ channel: "chrome" })` with no
`userDataDir`, no `--user-data-dir` in `args`, and no `storageState`
(`desktop/scripts/shoot-app.mjs:19`; also `assert-design.mjs:95`, `assert-connected.mjs:92`,
`check-states.mjs:31`, and the twenty-odd others — the only `args` anyone passes are
`--enable-precise-memory-info`, `--js-flags=--expose-gc` and the smooth-scrolling pair at
`weigh.mjs:28-31`, `churn.mjs:28`, `pinned.mjs:203-206`). `grep -rn
"userDataDir\|launchPersistentContext\|storageState"` over `desktop/`, `web/`, `mobile/` and
`docs/` returns nothing.

Verified in the installed `playwright-core` 1.63.0 — `desktop/node_modules/playwright-core` in a
sibling worktree that has had `pnpm install` run, `lib/coreBundle.js`, statement 62108-62119:

```js
if (userDataDir) {
  assert(path.isAbsolute(userDataDir), "userDataDir must be an absolute path")
  if (!await existsAsync(userDataDir)) await fs.promises.mkdir(userDataDir, { recursive: true, mode: 448 })
} else {
  userDataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `playwright_${this._name}dev_profile-`))
  tempDirectories.push(userDataDir)
}
```

So `chromium.launch()` mints `$TMPDIR/playwright_chromiumdev_profile-XXXXXX` per launch and
removes it on close. `channel: "chrome"` selects the *installed Chrome binary*; it does not
select the user's Chrome *profile*. Two concurrent runs today cannot share auth or storage, and
neither can touch the developer's own Chrome profile.

**That is the finding: the current pattern is safe, and the danger is introducing a persistent
profile.** The only reason to want one is to keep a signed-in state between runs — and that is
precisely the thing that would make two runs share a credential.

### Why a shared profile would be worse here than it looks

The desktop app keeps the bearer token in the OS keychain only in the native shell. In a browser
tab there is no keychain bridge, and `desktop/src/servers.ts:79-82` says what happens instead:

```
/* Tokens live in the OS keychain when there is one (the native shell), and
   are held here in memory once read at start-up … In a browser tab they
   stay in the registry entry itself. */
```

The registry is `localStorage["firetower.servers"]` (`desktop/src/servers.ts:77`), and the token
is a field on it (`desktop/src/servers.ts:61`). The web app does the same under
`localStorage["firetower.token"]` (`web/src/api/http.ts:43-56`, with the reason: cookies would be
cross-site on `:3000`→`:4400`). `localStorage` is keyed by origin and lives in the browser
profile — so **a persistent user-data-dir shared by two runs on the same Vite port is two runs
sharing one bearer token to one control plane.** `desktop/src/servers.ts:112-121` is blunt that a
credential in `localStorage` "is a credential anything running as this user can read".

### What `states.mjs` does about the registry, and why it is the right pattern to copy

`desktop/scripts/states.mjs:34-69`, `fresh()`:

- `browser.newPage({ viewport: { width: 1280, height: 824 }, deviceScaleFactor: 2 })`
  (`states.mjs:35`) — a *page*, which in Playwright is a fresh incognito-like context per page, so
  state does not leak between states either;
- `page.addInitScript(…)` at `states.mjs:56-68` seeds, before any module runs:
  `firetower.servers` = the registry JSON (or removes the key, for the first-run states),
  `firetower.current` = `"o_1"`, `firetower.theme`, removes `firetower.panel`, then applies any
  per-state `seed` keys;
- the registry itself is `states.mjs:22-25`, two entries, `url` = `HERE`
  (`http://localhost:4401`, `states.mjs:20`) and a dead `http://localhost:4499`, each with
  `token: "tok"`.

So today auth is *fabricated per page*, not persisted — a fake token accepted by a mock. Against a
real `ft-server` that token has to be real. Two ways, and the first is better:

1. **Drive the real sign-in.** `desktop/e2e/cursor-live.mjs:28-33` already does it: `goto(renderer)`,
   fill the `ft-e1.tail9c2b.ts.net` placeholder with the server address, Connect, then `Username`
   / `Password` / Sign in. #329 records that this *is* the production first-run path, so it is
   evidence rather than a test hook. Nothing persists between runs and nothing needs to.
2. Seed `firetower.servers` with a token obtained out-of-band from
   `POST /api/v1/auth/login` (#329) via `addInitScript`, reusing the `states.mjs:56-68` shape.
   Faster, and it skips the sign-in journey — so it must not be used for any proof *about*
   sign-in.

**Recommendation.** Keep `chromium.launch()` with no `userDataDir` as the default: the profile is
then ephemeral by construction and there is no shared-auth question to get wrong. If a persistent
profile is ever needed, put it **outside the checkout**, under the run's own scratch root keyed by
the isolation key — `${TMPDIR}/firetower-verify/<key>/chrome` — for four reasons, each citable:

- the checkout is deleted at session end (`crates/ft-worker/src/lib.rs:941`, below), so a profile
  there is not persistent anyway;
- `.ignore:1-19` exists because churn inside the checkout restarts `cargo watch` about twice a
  second; a live Chrome profile is exactly that kind of churn;
- the repo's own habit for scratch is already `os.tmpdir()` —
  `desktop/scripts/generate-brand-assets.mjs:28` uses `fs.mkdtemp(path.join(os.tmpdir(), …))`, and
  `desktop/e2e/cursor-live.mjs:18` defaults its output to `/tmp/firetower-cursor-playwright`,
  which `docs/acp.md:183` describes as "written outside the checkout";
- a profile keyed by the isolation key cannot be shared by two runs even by accident.

**Not established:** this session's checkout path is 131 characters before Chrome adds anything,
and a macOS `sun_path` is 104 bytes. Whether a user-data-dir that deep trips Chromium's
`ProcessSingleton` socket I could not determine by reading, and it is one more reason to prefer
`$TMPDIR` (49 characters here). It must be tested, not assumed, if a persistent profile is ever
adopted.

---

## 4. What a run can cheaply detect to decide whether it OWNS an instance

### The `verify-atlas` shape transfers; its discriminator inverts

`verify-atlas` uses `test -f .git` to tell a worktree (`.git` is a file) from a main checkout
(`.git` is a directory), and refuses any connect or launch without an explicit `--checkout` when
run from a worktree.

In Firetower **every agent checkout is a worktree**, so that test is true in the ordinary case.
Observed here:

```
$ cat .git
gitdir: /Users/kevinpiacentini/.firetower/worker/repos/firetower-cloud-firetower.git/worktrees/firetower27
$ git rev-parse --git-common-dir
/Users/kevinpiacentini/.firetower/worker/repos/firetower-cloud-firetower.git
```

And the repository says so itself, in a file that exists only because of it — `.ignore:1-19`:

```
# For file watchers, not for git — read by the `ignore` crate, which is what
# `cargo watch` in `just dev` uses to decide what a change is.
#
# It normally gets this from `.gitignore`, and here it cannot: this checkout is
# a git *worktree*, so `.git` is a file pointing elsewhere rather than a
# directory, and the crate finds no repository to read ignores from.
```

So `test -f .git` cannot be the refusal trigger: it would refuse every run the QA agent ever makes
and allow the one case — a developer's own clone, where the developer's own stack is most likely
to be up — that most needs refusing. It is still worth computing, as one input: it tells a run
*which kind of checkout it is in*, and a run in a main checkout should be louder, not quieter.

### The derivation key should be `$FIRETOWER_SESSION`, with the worktree path as the fallback

`crates/ft-core/src/lib.rs:42-47`:

```rust
/// Which session a process is running inside.
///
/// Set on the agent and inherited by everything it starts, so a setup script or
/// a tool can tell. Named here rather than in the worker because both ends read it.
pub const SESSION_ENV: &str = "FIRETOWER_SESSION";
```

Observed: `FIRETOWER_SESSION=s_01m7megepcew9jp9m8gcm8pgy6`, set and inherited. It is also
discoverable without the environment, one level above the repository: `.firetower/` holds
`agent-s_01m7megepcew9jp9m8gcm8pgy6.ndjson`, `mcp-s_01m7megepcew9jp9m8gcm8pgy6.json` and
`skills-s_01m7megepcew9jp9m8gcm8pgy6/`, and `../AGENTS.md:27-28` names both the compose project
`ft-s_01m7megepcew9jp9m8gcm8pgy6` and the session id itself.

Why the session id and not the worktree path:

- it is **already** Firetower's own isolation key — the compose project is `ft-<session>`
  (`crates/ft-worker/src/docker.rs:89-100`) and the sweep label is `<session>`
  (`crates/ft-worker/src/docker.rs:42, 204-207`). Deriving from anything else means a run whose
  ports and whose Docker resources are keyed differently, for no gain;
- it is already sanitised and short: `s_` plus a lowercase ULID
  (`crates/ft-worker/src/docker.rs:86-88`), so a port derived from it is stable and a directory
  named after it is short;
- inside a session it is **one-to-one with the checkout** anyway, because the worker makes one
  workspace per session — so "derived from the checkout" and "derived from the session" coincide,
  and the session id is the better spelling of the same key.

**Outside a session** — a developer running the skill by hand — `FIRETOWER_SESSION` is unset, and
then the key should come from the checkout: a short hash of
`git rev-parse --show-toplevel` (plus `--git-common-dir`, so two worktrees of one mirror differ).
That is the `verify-atlas` derivation, kept for exactly the case it was written for.

Derive from the key: the control-plane port, the Vite port, the Postgres host port, the compose
project (`ft-verify-<key>`), `FIRETOWER_HOME`, the scratch root and — if ever needed — the Chrome
user-data-dir. One key, every resource.

### The cheap checks, in order, none of which needs Docker

1. **Which checkout and which session.** `test -f .git`, `git rev-parse --show-toplevel
   --git-common-dir`, `$FIRETOWER_SESSION`. Three syscalls' worth. Record all of it with the run.
2. **Is anything on my derived ports?** A listener probe (`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`,
   or simply attempting the bind and treating `EADDRINUSE` as the answer — which is what
   `strictPort: true` at `desktop/vite.config.ts:15` already makes Vite do).
3. **If something is listening, is it mine?** A run-lock at the derived scratch path —
   `<scratch>/<key>/run.json` holding the pid, the ports, the session id, the checkout and the
   start time. A listener with a matching live lock is **OWNED**. A listener with no lock, or a
   lock naming a different key or a dead pid, is **NOT OWNED** → refuse.
4. **Ask the thing itself who it is, before driving it.** `GET /api/v1/bootstrap` is
   unauthenticated (`api/openapi.json:1002-1007`) and returns `serverId` — documented in the
   contract as "Which Firetower this is, independent of the address it answers on", and used by
   the app for exactly this purpose: `desktop/src/servers.ts:51-58` files the token under the
   serverId and not the URL, because "a different server on a familiar address is not [the same
   server] — which is the case worth catching". A run records the `serverId` of the control plane
   it started; any subsequent connect asserts the address still answers with that id. This is the
   strongest available ownership test, it is one GET, and it catches the precise disaster in
   #331 — pointing at `:4400` and finding the developer's real Firetower.
5. **Refuse, don't adapt.** No `connect` to an address this run did not derive and verify, unless
   an explicit `--checkout <path>` / `--server <addr>` says the operator meant it. No launch onto
   a port something else holds — and specifically **never fall back to the next free port**, which
   silently relocates the run away from the port its own evidence claims.

### The rule to copy, already written down in this repository

`desktop/src/servers.ts:15-44` is the same problem, solved:

> **One rule governs everything below, and four separate bugs came from not having written it
> down.** A credential may be restored from the OS keychain only where this file can *positively
> establish* that restoring it is permitted. Not knowing that it is forbidden is not permission.
> … So permission is a **positive assertion stored in the row it is about**.

Ownership should work identically: *not knowing that an instance is somebody else's is not
ownership*. A probe that errors, a lock file that will not parse, a `serverId` that cannot be
read — each must read as "not mine", never as "probably fine". That table at
`desktop/src/servers.ts:33-39` (the table) is the shape the skill's Doctor section should state in writing.

### Two existing precedents, one good and one to avoid

- **Good.** `desktop/e2e/cursor-live.mjs:164` guards a destructive action with a positive
  assertion before taking it: `assert.match(session, /^s_[a-z0-9]+$/, "only this disposable test
  session may be stopped")`.
- **To avoid.** `web/playwright.config.ts:13` is `reuseExistingServer: !process.env.CI` — locally,
  `pnpm test:browser` adopts whatever is already answering on `:3000` instead of starting its own.
  That is the #331 failure mode already in the repository, one line long, and it is why "adopt if
  present" must never be the default for `control-firetower`.

---

## 5. What the session environment already guarantees

### The label, exactly

`crates/ft-worker/src/docker.rs:37-42`:

```rust
/// The label every resource belonging to a session carries.
///
/// Compose sets its own project label and this is swept alongside it, so an
/// agent running a bare `docker run` has a way to have its containers cleared
/// up too. Named in the workspace guide for exactly that reason.
pub const SESSION_LABEL: &str = "com.firetower.session";
```

The form, from `CONTRIBUTING.md:275-278` and verbatim in the session's own `../AGENTS.md:28`:

```
--label com.firetower.session=$FIRETOWER_SESSION
```

which in this session is `--label com.firetower.session=s_01m7megepcew9jp9m8gcm8pgy6`. The value
is the **bare session id**, not the `ft-`-prefixed compose project — `crates/ft-worker/src/docker.rs:206`
filters `label=com.firetower.session=<session.as_str()>` while `:205` separately filters
`label=com.docker.compose.project=ft-<session>`. They are two different filters, deliberately:
"`--filter` is AND, so asking for both labels at once finds only resources carrying both, which is
nothing" (`crates/ft-worker/src/docker.rs:200-203`). Containers, networks and volumes are all
swept, containers first (`crates/ft-worker/src/docker.rs:185-186, 209`).

**And there is a live bug to not copy.** `desktop/linux/run.sh:42` writes
`--label "com.firetower.session=${FT_SESSION:-local}"` — but `FT_SESSION` is set nowhere in the
repository (`grep -rn FT_SESSION` finds only that line) and the real variable is
`FIRETOWER_SESSION`. So that container is labelled `com.firetower.session=local`, which
`sweep`'s filter never matches, and it is never cleaned up. Any `docker run` the skill issues must
read `$FIRETOWER_SESSION`.

### What is reaped at session end, and what is not

`crates/ft-worker/src/lib.rs:841-945`, the teardown path, in order:

1. tmux killed (`:841-843`);
2. `crate::docker::sweep(&session_id)` (`:856`) — **before** the worktree goes, because "a compose
   service almost always bind-mounts the checkout" (`:847-851`);
3. cgroup removed (`:901`), each worktree removed (`:915`, `:933`);
4. `tokio::fs::remove_dir_all(workspace)` (`:941`) — "the directory that held them, which git
   knows nothing about".

Step 4 is the one that matters for evidence. The *workspace* is the directory holding the
checkouts — here
`/Users/kevinpiacentini/.firetower/worker/worktrees/agent-…-gcm8pgy6/`, the directory holding
`firetower/`, `AGENTS.md` and `.firetower/`. At session end **all of it is deleted**: the
checkout, the session's `.firetower/`, and anything a run wrote under either. The repository's own
`.firetower/reconcile/` (`desktop/scripts/shoot-app.mjs:15`, `states.mjs:18`, gitignored at
`.gitignore:23-25`) is inside the checkout and therefore inside that deletion.

Nothing in teardown touches `$TMPDIR` or `/tmp`. They survive a session end on this host.

### Consequences for the Cleanup section, given the #337 evidence contract

#337 settles that proof lives in a **PR comment**, posted with `gh --attach` per the
`pr-screenshots` library skill, and that durability comes from posting rather than from preserving
a directory — so the ordering **capture → post → verify the comment → only then clean up** is a
hard requirement. (`pr-screenshots` is not in this checkout; it is a skills-library skill,
referenced at `docs/skills.md:176` and `crates/ft-server/src/skills.rs:1512`. I could not read its
contents from here. The house convention it encodes is visible in-repo at
`docs/mobile-redesign-coverage.md:355-356`: "Posted to the PR with `gh --attach` so they render
inline, per the `pr-screenshots` skill", and §7's "Computed properties, not eyeballs" at
`:360` is the same point #337 makes about an accessibility snapshot beside the screenshot.)

What follows, precisely:

**What a run must not tear down before its evidence is posted.** Nothing that a proof still needs
read back. Concretely: the control plane and its database, because a proof is "the action and the
resulting state" and the second view a side effect is read back from is served by the stack
itself; the Chrome browser, while an accessibility snapshot of the current state is still to be
taken; and the scratch directory holding the captures. A cleanup that runs `docker compose down
-v` on its own project before a successful `gh --attach` has destroyed the second view and the
screenshots in one step. The ordering is: capture everything → post → read the comment back and
confirm the attachments render → *then* stop the stack, close the browser, and remove scratch.

**Never kill by process name.** This follows from the ports, not from taste. `pkill -f
firetower`, `pkill -f vite` or `pkill -f next` from inside a session kills the developer's
`target/debug/firetower serve --dev` on `:4400` — the control plane that is hosting the session,
measured above — and every other session's processes on that machine, because the daemon and the
host are shared (`crates/ft-worker/src/docker.rs:13-26`, `CONTRIBUTING.md:272-274`). Cleanup must
act on what the run recorded: its own pids from its run-lock, its own
`-p ft-verify-<key>` compose project, its own `--label com.firetower.session=$FIRETOWER_SESSION`.
`justfile:74-87` is the in-repo precedent for killing only your own children: "Only our own
children are killed — `kill 0` would take the calling shell with it".

**Never delete the evidence.** Before a post, nothing under the scratch root may be removed. After
a verified post, scratch is scratch and may be. A run with nowhere to post — no pull request yet —
holds the evidence and says where, per #337.

### `/tmp` for scratch: better than the checkout, still not enough

`desktop/e2e/cursor-live.mjs:18` defaults to `/tmp/firetower-cursor-playwright`, and
`docs/acp.md:183` endorses "outside the checkout". Against the teardown path above, that is right
and insufficient:

- **Right**, because `/tmp` is outside the workspace that `crates/ft-worker/src/lib.rs:941`
  deletes. Evidence in the checkout — including anywhere under the repo's `.firetower/` — does not
  survive a session ending between capture and post. Evidence in `$TMPDIR` does.
- **Insufficient**, because surviving on disk is not the same as being posted. If the session ends
  between capture and post, the files are still in `/tmp` and there is no agent left to post them:
  the worktree is gone, the stack has been swept, and the next session gets a fresh workspace that
  knows nothing about that path. The evidence has survived into a room nobody will enter.
- **And the stack is gone first.** `sweep` runs at `:856`, before the worktree removal at `:915`.
  So a run interrupted after capture has lost the control plane it would have re-read a side
  effect from, even if the PNGs are intact.

So, three things follow for the skill:

1. **Scratch goes at `${TMPDIR:-/tmp}/firetower-verify/<key>/`**, outside the checkout, keyed so
   two runs cannot collide, with the run-lock from §4 beside it. `/tmp` on a shared machine is
   shared, which is exactly why the key — not a fixed name like
   `/tmp/firetower-cursor-playwright` — belongs in the path.
2. **Post early and post often.** The window between capture and post is the whole exposure, and
   it is the skill's job to make it short. Per-proof posting, or a comment edited as the run
   proceeds, beats one post at the end of a long run.
3. **There is no pre-teardown hook to lean on.** The hook events the CLI knows are
   `Notification`, `Stop`, `StopFailure` (`crates/ft-cli/src/main.rs:139-143`) — agent-turn
   events, written into the agent's own hook configuration
   (`crates/ft-worker/src/hooks.rs:166`). I found nothing a run can register to be told "this
   session is ending, post now". **Not established** whether one exists elsewhere; I looked in
   `ft-cli`'s hook subcommand, `ft-worker/src/hooks.rs` and the teardown path at
   `crates/ft-worker/src/lib.rs:841-945`, and found no such thing. A run that is killed between
   capture and post cannot recover itself, and that is a reason to treat unposted evidence as the
   failure state rather than a tidy-up task.

### The rest of the guarantee, as stated

`../AGENTS.md:24-28`, this session's own workspace guide:

- "Published ports are shared. If a port is taken, another session has it; pick another rather
  than assuming something is broken."
- "`docker ps` lists their containers too. Yours are the ones in the
  `ft-s_01m7megepcew9jp9m8gcm8pgy6` project."
- "Anything you start with `docker compose` is removed when this session ends. For a bare `docker
  run`, add `--label com.firetower.session=s_01m7megepcew9jp9m8gcm8pgy6` and it will be cleared up
  too — without it, it is left behind."

Same three facts in `CONTRIBUTING.md:262-281` and in `crates/ft-worker/src/docker.rs:13-26`. Note
the first one is advice a verification run should **not** take literally: "pick another" is right
for a scratch nginx and wrong for a run whose evidence names a port. A derived port that is taken
means somebody else is there — which is a refusal, not a retry.

---

## Summary of recommendations for #334

- One flag, `--key` (default `$FIRETOWER_SESSION`, else a hash of the worktree), from which the
  control-plane port, Vite port, Postgres host port, compose project `ft-verify-<key>`,
  `FIRETOWER_HOME` and the scratch root are all derived.
- `--checkout <path>` / `--server <addr>` as the explicit opt-in that `connect` requires when the
  address was not derived and verified. No adoption by default; no fallback to the next free port.
- `doctor` reports: checkout kind, session id, derived ports, what is listening on each, the
  run-lock, and the `serverId` the address answers with. Every unknown reads as "not mine".
- `cleanup` acts only on recorded pids, `-p ft-verify-<key>` and
  `--label com.firetower.session=$FIRETOWER_SESSION`; never by process name; never before a
  verified post; never `just reset`.
