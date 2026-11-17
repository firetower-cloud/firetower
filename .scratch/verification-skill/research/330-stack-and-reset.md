# 330 — What brings a real Firetower stack up from empty, and how does a run reset it?

Research for [#330](https://github.com/firetower-cloud/firetower/issues/330), under
[#329](https://github.com/firetower-cloud/firetower/issues/329).

Everything below was **run**, on this machine, against a real Postgres and a real
`ft-server`. Where something was established by reading rather than by running it
says so, in those words. Nothing here is inferred from a passing test.

**Rig.** macOS 25.6.0, Apple silicon (12 CPUs reported to the worker, 18 GB).
Session `s_01m7mefybzh40p1akvbfy4a5sg`, `COMPOSE_PROJECT_NAME=ft-s_01m7mefybzh40p1akvbfy4a5sg`.
Postgres published on **5434** and `ft-server` on **4411**, because 5433 and 4400
were both already held on this machine — see "Ports are not free" below.
`target/` started empty.

---

## 1. The exact literal sequence, with measured wall-clock

### The headline correction: it is six steps, not four

The ticket lists `just db` → `ft-server` → `/api/v1/bootstrap` → `passwd admin` →
`POST /api/v1/auth/login`. Two of those are wrong and two steps are missing:

- **`GET /api/v1/bootstrap` creates nothing.** It is an unauthenticated,
  read-only discovery endpoint — `crates/ft-server/src/api.rs:208-230`. It answers
  a version, an events path, the organisation id and the auth modes, and the
  handler's own comment says it "deliberately says almost nothing". There is no
  bootstrap *action* anywhere in the API; the administrator is created at
  start-up, before the server listens (`crates/ft-server/src/api/setup.rs:3-7`:
  "There is no step here that creates an account").
- **A successful login is not yet a usable session.** The first administrator is
  created with `must_change_password = TRUE`, and *every* authenticated route
  except login, `/bootstrap` and the password change answers **403
  `PasswordChangeRequired`** until it is cleared. Measured below.
- **The desktop app then shows the setup wizard** until `/api/v1/setup` reports
  `completed: true` — `desktop/src/ui/Gate.tsx:47`. So a UI-driven run needs the
  organisation named and setup completed as well.

### The sequence

```sh
# 0. Isolate. Mandatory on a shared daemon, and 5433/4400 may be taken anyway.
export COMPOSE_PROJECT_NAME="ft-$FIRETOWER_SESSION"
export POSTGRES_PORT=5434
export DATABASE_URL="postgres://firetower:firetower@localhost:5434/firetower"
export FIRETOWER_HOME="$PWD/.scratch/run/home1"     # NOT ~/.firetower — see §3
export FIRETOWER_PORT=4411

# 1. Build the binary.
cargo build -p ft-cli

# 2. Postgres.
just db

# 3. The control plane. --dev serves the API only; the web app is its own process.
FIRETOWER_WORKER_ARTIFACTS=target/artifacts \
  ./target/debug/firetower serve --dev --port 4411 2> server.err &
#   wait for: curl -sf http://127.0.0.1:4411/api/v1/bootstrap

# 4. Make the administrator credential deterministic AND clear the forced change.
printf 'reset-pw-1234\nreset-pw-1234\n' | ./target/debug/firetower passwd admin

# 5. Sign in.
TOK=$(curl -s -X POST http://127.0.0.1:4411/api/v1/auth/login \
        -H 'content-type: application/json' \
        -d '{"username":"admin","password":"reset-pw-1234"}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 6. Finish setting up, or the desktop app shows the wizard instead of the app.
curl -s -X POST http://127.0.0.1:4411/api/v1/setup/organization \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"name":"Verify QA"}'
curl -s -X POST http://127.0.0.1:4411/api/v1/setup/complete \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d '{}'
```

The token goes in `authorization: Bearer <token>`. There is no cookie — the login
response carries the token in its body.

### Measured cost of each step

| # | Step | Measured | Notes |
|---|---|---|---|
| 1 | `cargo build -p ft-cli` | **57.48s** | **Empty `target/`**, 338 crates compiled, producing 3.3 GB. `/usr/bin/time`: real 57.51, user 187.16, sys 18.42. Consistent with #329's 51s for `ft-server`. |
| 2 | `just db` | **3.65s** first time, **3.05s** on a new volume | `postgres:17-alpine` already in the local image cache. A cold *pull* is not included. |
| 3 | `ft-server` start, empty db → `/bootstrap` answers | **3.01s** | Includes all migrations, root-key creation, ssh-key generation and seeding 2 built-in skills. |
| 3b | `ft-server` start, **existing** db | **1.20s** – **1.30s** | Three separate starts. No migrations to run. |
| 4 | `./target/debug/firetower passwd admin` | **0.40s** | Bare binary. |
| 4' | `cargo run -q -p ft-cli -- passwd admin` | **7.99s** | Same work, warm `target/`. The 7.6s delta is cargo's freshness check. **Use the built binary.** |
| 5 | `POST /api/v1/auth/login` | **0.244s** – **0.72s** | argon2id verify dominates. |
| 5' | `POST /api/v1/auth/password` (alternative to step 4) | **0.607s** | Returns a fresh token in the body, so no second login is needed. |
| 6 | `POST /setup/organization` + `POST /setup/complete` | **0.034s** + **0.035s** | |

**Empty Postgres → usable signed-in administrator, start to finish: 2.93s**, once
the binary exists (measured as one script, §3). With a cold `target/`, add 57.5s
once.

### Where the printed password goes, and whether a script can capture it

**It goes to stderr, and a script can capture it.** `announce()` at
`crates/ft-server/src/lib.rs:455-515` uses `eprintln!`, not `tracing` — the log
lines go to stdout and this block goes to stderr. Captured verbatim from
`2> server.err` on a first start:

```
  Firetower
  http://localhost:4411
  api only — the web application is on its own port

  There was no administrator, so one was made:

    username  admin
    password  velvet-willow-saffron-153

  It is not written down anywhere you can read it back, and Firetower
  will ask you to replace it as soon as you sign in.

  To let Firetower onto a machine, give it this public key:

    ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGLvSxbAnGqC57pm96fOuy8wz1rtHDrbHaohm7egCcAF firetower
```

and this one-liner reads it:

```sh
PW=$(sed -n 's/^    password  //p' server.err)   # -> velvet-willow-saffron-153
```

The password is three words and a number from a 26-word list
(`invent_password`, `lib.rs:429-452`).

**But capturing it is not enough, and this is the important part.** Logging in
with that password yields a token whose every other request is refused:

```
$ curl -s -H "authorization: Bearer $TOK" http://127.0.0.1:4411/api/v1/hosts
{"code":"PasswordChangeRequired","message":"this password has to be replaced before anything else"}
# http 403 — same for GET /api/v1/ssh-key
```

So an unattended run has three routes, and two of them work:

1. **`passwd admin` (recommended).** `accounts::set_password`
   (`crates/ft-server/src/accounts.rs:743-775`) sets
   `must_change_password = FALSE` in the same statement, so one login afterwards
   gives a fully usable token. **It works unattended**: it reads the password from
   stdin with `read_line`, and the `stty -echo` it attempts is non-fatal. Measured
   above at 0.40s. It prints `stty: stdin isn't a terminal` to stderr and carries
   on — that line is noise, not a failure.
2. **`ADMIN_INITIAL_PASSWORD` + `POST /api/v1/auth/password`.** `.env.example:42-45`
   and `lib.rs:363-364` — setting `ADMIN_USERNAME` / `ADMIN_INITIAL_PASSWORD`
   makes the first password deterministic with no capture at all, and the password
   is then *not* printed (`lib.rs:425`: `password: supplied.is_none().then_some(...)`).
   It does **not** avoid the forced change — `ensure_admin` marks the account
   either way, deliberately: "a credential that came out of a file cannot quietly
   become the permanent one" (`lib.rs:382-384`). So this route still needs one
   `POST /api/v1/auth/password` (0.607s), which returns a usable token directly.
3. **Capture from stderr and use it as-is.** Works for *login only*. Everything
   past login 403s. Not a route.

Recommendation: **`ADMIN_INITIAL_PASSWORD` to make the credential known, then
`passwd admin` to clear the flag** — the password never has to be scraped, and
`passwd` is 0.40s. `passwd admin` alone is equally fine and is one fewer variable.

### `desktop/e2e/cursor-live.mjs` consumes a password; it does not produce one

Read on the lead's instruction. `desktop/e2e/cursor-live.mjs:17-20` reads
`FIRETOWER_E2E_PASSWORD` and throws without it. Nothing in the repository sets it
— `grep -rn FIRETOWER_E2E` finds only the script and `docs/acp.md:175-177`, which
says only that it "is that server's administrator password". So **the unattended
password problem is not solved anywhere in this repository**; it is pushed onto
whoever starts the server. It did not give me a faster bring-up, and there is no
launcher to reuse.

It does, however, **corroborate the `passwd admin` conclusion from the other
side**, and this is worth recording because it is a latent gap in that script:

- `cursor-live.mjs:31-36` fills Username and Password, clicks **Sign in**, and
  then immediately clicks `Configuration`.
- `desktop/src/ui/Connect.tsx:398-402`: when `mustChangePassword` is set, sign-in
  calls `onLocked(...)` and the app renders `ReplacePassword` instead of the shell
  (`desktop/src/ui/Gate.tsx:30-44`).
- `desktop/src/ui/Gate.tsx:47`: until `/api/v1/setup` reports `completed`, the app
  renders `<Setup/>`, the wizard.

So `cursor-live.mjs` can only pass against a database where **both** the forced
change has been cleared **and** setup has been completed. `docs/acp.md:188-189`
says both harnesses "expect to be the first thing that touches the database",
which is true of session state and cannot be true of these two flags. Anyone
pointing that script at a genuinely virgin database will hit `ReplacePassword` and
time out looking for `Configuration`. Steps 4 and 6 above are what close that gap.

---

## 2. What is idempotent, and what happens exactly once

Measured by stopping the server and starting it again against the same database
and the same `FIRETOWER_HOME`.

| Step | Idempotent? | Evidence |
|---|---|---|
| `just db` | **Yes.** `docker compose up -d postgres` is a no-op on a running container; the `pg_isready` loop just succeeds at once. | justfile:48-64 |
| migrations | **Yes.** `_sqlx_migrations` is consulted; a second start is 1.20s against 3.01s. | measured |
| **administrator creation** | **Exactly once, and self-guarding.** | below |
| root key | **Once, then reused.** First start logged "wrote a new root key to …/home1/root.key"; the second logged `root key source=…/home1/root.key`. | measured |
| ssh identity | **Once per *database*.** Held in the vault, i.e. the `secrets` table — `crates/ft-server/src/sshkey.rs:28-30`. Survives a restart; **does not survive a dropped database.** See §3. | measured |
| built-in skills | **Seeded on first start** ("seeded or updated 2 built-in skill(s)"). Not re-seeded when the `skills` rows exist. | measured |
| `passwd admin` | **Yes**, and it invalidates every existing token: `DELETE FROM user_sessions WHERE user_id = $1` (`accounts.rs:756`). An old bearer token answered **401** immediately after. | measured |
| `POST /setup/organization`, `/setup/complete` | **Yes**; `completed` only ever goes true. | api/setup.rs:52-58 |

### What a second start against the same database actually does

Captured verbatim. The entire first-run block is **absent**:

```
  Firetower
  http://localhost:4411
  api only — the web application is on its own port
```

- The admin is **not** recreated. `ensure_admin` returns `None` the moment
  `accounts.any_user()` is true, before it even reads `ADMIN_USERNAME` /
  `ADMIN_INITIAL_PASSWORD` — `crates/ft-server/src/lib.rs:384-390`. Its comment:
  "Once somebody has signed in and chosen a password, the variables are ignored —
  never re-applied, never compared."
- No password is reprinted. `announce` returns early when there is no
  `FirstAdmin` (`lib.rs:490-492`).
- **Nothing refuses.** There is no "bootstrap refuses" state. Start-up simply has
  nothing to do. The belt-and-braces guard is one layer down:
  `create_first_admin` re-checks `SELECT EXISTS (SELECT 1 FROM users)` *inside* its
  transaction and bails with "this Firetower already has a user"
  (`accounts.rs:156-166`), so two processes starting together cannot both insert.
- **The ssh public key is also not reprinted**, because it is inside the same
  early-returned block. A run that restarts the server and then wants the key must
  use `GET /api/v1/ssh-key` — which needs a token that is past the forced password
  change. Chicken-and-egg if you planned on scraping stderr.

---

## 3. The cheapest honest reset unit

Four options were considered. Three were measured; one does not exist.

### Measured: 2.93s for a full virgin reset

Script: `.scratch/run/reset-dropdb.sh`. Server stopped, database dropped and
recreated, server restarted, `passwd admin`, login, setup completed — i.e. all the
way back to step 6 of §1.

```
  1 stop ft-server: 0.07s
  2 DROP+CREATE DATABASE: 0.21s
  3 ft-server start (migrations + admin): 1.23s
  4 firetower passwd admin: 0.40s
  5 POST /auth/login: 0.72s
  6 setup/organization + setup/complete: 0.04s
  TOTAL drop-database reset to signed-in admin: 2.93s
```

```sh
docker compose exec -T postgres psql -U firetower -d postgres -q \
  -c "DROP DATABASE firetower WITH (FORCE);" \
  -c "CREATE DATABASE firetower OWNER firetower;"
```

`WITH (FORCE)` matters: it terminates the server's pooled connections, so the
server does not have to be stopped first in principle — though stopping it is
0.07s and avoids a window of 500s.

Afterwards `GET /api/v1/skills` returns both built-ins with their files
(`skill_files=2 blobs=2`), i.e. a genuinely healthy install.

### Measured: 6.48s for a volume-level reset

Script: `.scratch/run/reset-volume.sh`. This is the database half of `just reset`.

```
  1 stop ft-server: 0.09s
  2 docker compose down -v: 0.68s
  3 just db (new volume, initdb): 3.05s
  4 ft-server start (migrations + admin): 1.30s
  5 firetower passwd admin: 0.41s
  6 POST /auth/login: 0.58s
  7 setup/organization + setup/complete: 0.06s
  TOTAL down -v + just db reset to signed-in admin: 6.48s
```

3.5s more than dropping the database, for no additional guarantee. Worth it only
when you suspect the Postgres *server* rather than its contents.

### Measured: 0.13s for a truncate — and it quietly breaks the install

```
TRUNCATE hosts, repos, sessions, events, …, schedules RESTART IDENTITY CASCADE;
  run 1: 0.142s    run 2: 0.126s    run 3: 0.121s
```

The admin, the organisation and the bearer token all survive, and `GET /hosts`
still answers 200. **Do not do this.** `CASCADE` reaches five tables that were on
the keep-list, and psql says so:

```
NOTICE:  truncate cascades to table "skill_files"
NOTICE:  truncate cascades to table "skill_defaults"
NOTICE:  truncate cascades to table "skill_pins"
NOTICE:  truncate cascades to table "roles"
NOTICE:  truncate cascades to table "role_defaults"
```

The foreign keys that do it, from `pg_constraint`:

```
roles -> hosts            (roles_host_id_fkey)
roles -> agent_accounts   (roles_agent_account_id_fkey)
role_defaults -> roles    (role_defaults_role_id_fkey)
skill_files -> blobs      (skill_files_hash_fkey)
skill_defaults -> repos   (skill_defaults_repo_id_fkey)
skill_pins -> sessions    (skill_pins_session_id_fkey)
```

So truncating `hosts` destroys every role, and truncating `blobs` destroys the
built-in skills' file bodies. The damage is **observable and not repaired by a
restart**:

```
after truncate:   skills=2  skill_versions=2  skill_files=0  blobs=0
after restart:    skills=2  skill_versions=2  skill_files=0  blobs=0
GET /api/v1/skills -> []        # the Skills library reads as empty
```

The seeder does not re-run, because the `skills` rows still exist while their
files do not. A verification run that reset this way would then "verify" an empty
skills library and call it the product's behaviour. **2.8 seconds is not worth
that.**

A narrower truncate — only the tables one feature touches, with the FK graph
consulted — is defensible. A generic one is not.

### Does not exist: a fresh organisation per run

**Firetower is single-tenant per database.** The only `INSERT INTO organizations`
in the whole workspace is in `create_first_admin`
(`crates/ft-server/src/accounts.rs:169`), which bails if any user exists, and the
`installation` row binds exactly one `org_id` — `accounts::organization()` reads
`installation i JOIN organizations o ON o.id = i.org_id`
(`accounts.rs:117-134`). The API offers only `PATCH /api/v1/organization`, a
rename. There is no create. **A fresh organisation per run is not an available
reset unit**, and anything built on the assumption that it is will not work.

### Per-feature versus per-run

| Unit | Cost | Verdict |
|---|---|---|
| Per feature | **2.93s** | Not ruinous. 20 features = 59s of reset in a run. |
| Per run | **2.93s** | Identical. There is no cheaper per-feature unit worth having. |

**Recommendation: drop and recreate the database, per feature.** The question the
ticket asks — whether a per-feature reset is affordable — is answered yes with a
3-second margin, and it removes a whole class of cross-feature contamination.

### Two things the reset unit must include beyond the database

1. **`$FIRETOWER_HOME/ssh/known_hosts`.** The control plane records every machine's
   ssh host key there (`crates/ft-server/src/transport.rs:225-310`, with
   `StrictHostKeyChecking=accept-new`). `accept-new` accepts an *unknown* host and
   **refuses a changed one**. Rebuilding a container machine at the same
   address:port produced, verbatim:

   ```
   {"reached":false,"diagnosis":{"cause":"HostKeyChanged",
     "summary":"127.0.0.1 answered with a different host key than last time.",
     "detail":"@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@ …
       Host key for [127.0.0.1]:2222 has changed and you have requested strict checking.
       Host key verification failed."}}
   ```

   `rm -f "$FIRETOWER_HOME/ssh/known_hosts"` cleared it and the next probe reached
   the machine. A fresh `FIRETOWER_HOME` per run avoids it entirely.
2. **The control plane's ssh identity rotates with the database.** It lives in the
   vault, i.e. the `secrets` table, so dropping the database makes a new one.
   Measured across one reset: `SHA256:StB1gOWtQeI/9IVP04zSvM3hnKoqhpcsuRlKH0TTGtE`
   → `SHA256:Y7+b+YSjJ2nb1cHvfiL1JLri7JMJJZhObAZT/Hs7NIs`. **Any `authorized_keys`
   installed on a machine is stale after a reset**, so the machine has to be
   re-authorised — which, for a container machine, means rebuilding the image or
   writing the new key in. See #332.

### Is `just reset` safe for a verification run to call? **No. Emphatically not.**

```justfile
# justfile:287-291
reset:
    docker compose down -v
    rm -rf ~/.firetower/worker
```

The second line is not scoped to anything. On this machine:

```
$ echo $FIRETOWER_WORKER_ROOT
/Users/kevinpiacentini/.firetower/worker
$ du -sh ~/.firetower/worker
 54G	/Users/kevinpiacentini/.firetower/worker
$ ls ~/.firetower/worker
agent-login  agents  bin  firetower  install.sh  repos  worker.db  worker.db-shm  worker.db-wal  worktrees
```

and the working directory of this session is

```
/Users/kevinpiacentini/.firetower/worker/worktrees/agent-i-would-like-to-create-a-verification-skill-2-stack-machine-bfy4a5sg/firetower
```

— **inside the directory `just reset` deletes.** Running it from a Firetower
session would delete 54 GB, the local worker's entire state database, every other
session's worktree on this machine, and the session's own working directory while
it was running in it. **I did not run it.** This is established by reading the
recipe against `$FIRETOWER_WORKER_ROOT` and `pwd`, which is sufficient: the recipe
is two unconditional lines.

The recipe is correct for what it is for — a contributor on their own laptop
starting fresh, where `~/.firetower/worker` is their own dev worker and nothing
else. It is unusable from inside a session, and a verification skill must never
shell out to it. The database half, `docker compose down -v`, is safe *given*
`COMPOSE_PROJECT_NAME` is set to the session's project; without it the project
name falls back to `name: firetower-dev` from compose.yaml:25 and would take
whichever session owns that name with it.

### Ports are not free

`lsof` on this machine, before anything was started:

```
4400 TAKEN   (firetower, pid 98102 — the installed control plane)
5433 TAKEN   (ft-s_01m75pexhf8fw51c5r5fxjgeka-postgres-1 — another session)
3000 free
```

A verification run must take `POSTGRES_PORT` and `FIRETOWER_PORT` from the
environment and probe for a free one, not assume 5433/4400. **And the default
`DATABASE_URL` baked into `ft-cli` is `postgres://firetower:firetower@localhost:5433/firetower`**
(`crates/ft-cli/src/main.rs:70-75`) — so `firetower passwd admin` with no
`DATABASE_URL` set would have reached **another session's database** and reset
*their* administrator's password. Always set `DATABASE_URL` explicitly.

### `FIRETOWER_HOME` is not free either

It defaults to `~/.firetower`, which on a developer machine is the installed
Firetower's state directory — on this one it holds the real `root.key` and the
real ssh identity. A verification run must set `FIRETOWER_HOME` to scratch. Note
`ft-cli` also reads `./.env` then `~/.firetower/.env`
(`crates/ft-cli/src/main.rs:214-220`), so an installed Firetower's `.env` can leak
into a run started from a checkout.

---

## 4. Where `just dev` and `docker compose --profile full up` differ

| | `just dev` (justfile:76-102) | `up` (justfile:67-68 → compose.yaml:48-74) |
|---|---|---|
| What runs | Two host processes: `cargo watch -x 'run -p ft-cli -- serve --dev'` and `pnpm --dir web dev` | One container running `just dev` inside `Dockerfile.development` |
| Published ports | Whatever you set — `FIRETOWER_PORT`, and `POSTGRES_PORT` for the db | **Hardcoded `"4400:4400"` and `"3000:3000"`** (compose.yaml:70-72). No `${VAR}`, so they cannot be moved for a second session. Not what breaks it — see below. |
| `FIRETOWER_HOME` | `~/.firetower` unless you set it | `/workspace/.firetower` — i.e. inside the bind-mounted checkout (compose.yaml:57) |
| `FIRETOWER_WORKER_ARTIFACTS` | `target/artifacts` — set by the recipe | Also `target/artifacts`, because the container runs `just dev`. But `CARGO_TARGET_DIR=/target`, a named volume (Dockerfile.development:28), so the path resolves to `/workspace/target/artifacts` — the **host's** `target/artifacts`, which the in-container build never writes to. **A worker built inside the `full` profile does not land where the control plane looks for it.** Established by reading; not executed. |
| Platform | macOS — so a worker built by `just build-worker` is `darwin-arm64` | Linux (`rust:1-bookworm`), and the image comment says that gap "has already cost us three times" |
| `root key` | `$FIRETOWER_HOME/root.key` on the host | `/workspace/.firetower/root.key`, in the checkout, unless `FIRETOWER_ROOT_KEY` is set (compose.yaml:60-63) |
| ssh client config | the host's `~/.ssh` | `./.dev/ssh:/root/.ssh:ro` (compose.yaml:69). **`.dev/` does not exist in a checkout** and nothing creates it — it is gitignored at `.gitignore:30-31` as "The ssh key pair the dev worker container is reached with". The mount is therefore an empty read-only directory, which is harmless for `SshKey::Managed` (the key comes from the vault) and fatal for `SshKey::File`. |
| Reload | `cargo watch` rebuilds on save — and `CONTRIBUTING.md:120-124` warns it kills a cloning worker as its child | Same, inside the container |

### `docker compose --profile full up` does not work at all

This was **run**, and it fails for a reason I had not predicted. The image builds
and the container starts; then:

```
$ docker compose --profile full up --build
 Image ft-s_01m7mefybzh40p1akvbfy4a5sg-firetower Built
 Container ft-s_01m7mefybzh40p1akvbfy4a5sg-firetower-1 Started
Attaching to firetower-1
firetower-1  | /tmp/just-uUP2BY/db: line 52: docker: command not found
firetower-1  | error: recipe `db` failed with exit code 127
firetower-1 exited with code 127
```

`compose.yaml:73` runs `command: just dev`; `dev` depends on `db` (justfile:76);
`db` runs `docker compose up -d postgres` (justfile:52) — and
`Dockerfile.development` installs git, tmux, openssh-client, curl, pkg-config,
node and `just`, but **no docker CLI** (Dockerfile.development:11-21). The recipe
the container runs cannot run.

| Measured | |
|---|---|
| image build, cold | **~71s** of build steps (`#6` apt 3.1s, `#7` nodejs 8.5s, `#8` `cargo install just` 46.9s, `#10` export 10.4s) |
| `up` with the image cached → exit 127 | **0.89s** |

**I was wrong about why.** I expected a port clash: compose.yaml:70-72 publishes
`"4400:4400"` and `"3000:3000"` with no `${VAR}`, and 4400 is held on this machine
by the installed `firetower` (lsof in §3). No clash was reported — the container
started fine. The fixed ports remain a real limitation for two concurrent sessions
and the inability to move them is read straight from the file, but on this machine
it was not what stopped `up`. Recording the wrong prediction next to the actual
error on purpose: the next agent should not inherit the guess.

**Either way, the conclusion for a verification run is the same and now rests on a
run rather than a reading: do not use the `up` recipe.** Drive the `just dev`
shape — `just db`, the server binary, and the desktop Vite renderer when the UI is
needed — where every port comes from the environment.

## Appendix: what was NOT established

- **A cold `docker pull postgres:17-alpine`** is not in the 3.65s for `just db`;
  the image was already cached.
- **`just reset`** was not executed, for the reason in §3.
- **What `docker compose --profile full up` would do if the docker CLI were in the
  image.** It got no further than the `db` recipe, so nothing past that — whether
  the inner `just dev` builds, whether 4400 would then clash, whether the
  `FIRETOWER_WORKER_ARTIFACTS` path problem in the §4 table actually bites — is
  unestablished.
- **Reset cost against a large database.** Every number above is on a fresh
  install: 11 MB, 53 tables, essentially no rows. `DROP DATABASE` is
  size-sensitive; `TRUNCATE` much less so. A run that has created many sessions
  will be slower than 0.21s, and by how much is not established.
- **Whether `role_defaults` being empty on a fresh install affects anything.** It
  is 0 rows both before and after a clean reset, so it is the natural state, but
  nothing here exercised a permission path.
