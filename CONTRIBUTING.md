# Contributing

Running Firetower needs Docker and one compose file — that is the
[README](README.md). Building it needs a toolchain, and that is this.

## Requirements

| | Why |
|---|---|
| **Rust** 1.90+ | Builds everything. `rustup` handles the rest — the toolchain is pinned. |
| **git** | Mirrors and worktrees. Already on most machines. |
| **tmux** | Holds the agent's terminal. This is the piece that keeps a session alive after you disconnect, so it isn't optional. |
| **Docker** | Postgres for the control plane. |
| **Node 22+ and pnpm** | Builds the web application. |
| **[just](https://github.com/casey/just)** | Task runner. Every command below assumes it. |
| **cargo-watch** | Rebuilds the control plane on save. Only needed for `just dev`. |

```sh
# macOS
brew install rust tmux node pnpm just
cargo install cargo-watch

# Debian / Ubuntu — pnpm and just aren't in apt
sudo apt install tmux
curl -fsSL https://sh.rustup.rs | sh
curl -fsSL https://get.pnpm.io/install.sh | sh -
cargo install just cargo-watch
```

Docker too, however you normally install it. `just doctor` will say if it isn't there.

## Getting started

```sh
git clone https://github.com/westlabs/firetower
cd firetower
just doctor     # checks you have the tools
just setup      # installs dependencies, once
just dev        # Postgres, control plane on :4400, interface on :3000
```

Open `http://localhost:3000`. `just dev` starts Postgres with the rest — you
don't start the database by hand.

The first start makes an administrator and prints its password once. Sign in
with it and Firetower asks you to replace it. Authentication is on in
development too — there is one way in rather than a second, untested one that
only exists in production, and in development it matters *more*: the API sets
`access-control-allow-origin: *` so the interface on :3000 can reach it, which
means any page you visit could otherwise read your vault from your own browser.

Locked out? `cargo run -p ft-cli -- passwd admin`.

Workers keep what happened on the host they run on (locally that's
`~/.firetower`). The control plane's cache is Postgres. Drop the database and
it rebuilds from the workers on reconnect; `just reset` wipes both.

## Day to day

The web application has its own dev server, so development runs two processes:

```sh
just dev        # control plane on :4400, web application on :3000
just test
just gen        # regenerate the API contract and the typed client
just build-worker   # a worker tarball for this machine's shape, for a real host
```

While developing, the interface and the control plane are two processes on two
ports, so the interface has to be told where the API is. That lives in
`web/.env.development`, which is committed. If every request 404s from Next
instead of reaching the control plane, that file is why — the interface is
asking itself.

Don't edit Rust while a local session is cloning: `cargo watch` restarts the
control plane, which kills the local worker as its child and abandons the
fetch. If you change the shape of a protocol frame, bump `PROTOCOL_VERSION` in
`ft-proto` and reinstall the worker on any machine you are testing against —
an old worker fails the handshake with the stream closing.

The web application is pinned to pnpm. Running `npm install` in `web/` would
produce a second lockfile, so `packageManager` refuses it.

`.env.example` is for contributors. Nobody running Firetower needs one.

## The tests and your database

Each test that touches Postgres works in a schema of its own, named
`test_<ulid>`, so the suite runs in parallel against one server without tests
seeing each other's rows. A run leaves one schema per test — around 130.

They are swept by the next run that starts, an hour or more later. That is
deliberately on the way *in* rather than on the way out: Rust has no teardown
hook, `Drop` cannot help because `Db` is cloned into half the crate and
dropping a schema is an async query, and anything that runs at the end is
skipped by exactly the test that panicked. Tidying up before starting survives
all of that.

If you want the space back now — or a tool pointed at that database is drowning
in them:

```sh
just db-clean     # drop them
just db-vacuum    # give the disk back
```

Left alone for three days of heavy use, this reached 1,117 schemas and 514 MB.

## The interface is a static export

`next build` writes `web/out`, and the control plane compiles it into the
binary — that is what makes a deployment one image and one origin. Two things
follow:

* `web/out` is committed empty. The crate names it at compile time, so a clone
  that has never run `pnpm build` still has to compile.
* A route with a runtime parameter cannot be pre-rendered per value. There is
  one shell, `sessions/_.html`, served for every session, and the page reads
  the id from the address bar rather than the router. See
  `crates/ft-server/src/web.rs`.

## Images, and the worker

```sh
just updater-image       # the updater beside the control plane
docker build -t firetower .   # the control plane, interface and all
just build-worker        # the worker binary, packed as a release would
```

The two images and the worker binaries are published together on release: the
control plane compares its version against each worker's on every handshake,
and its API version against the updater's on every call, so shipping one
without the others tells everyone their fleet has drifted.

The worker is not an image. It is one binary per platform, installed into
`~/.firetower/worker/bin` on a machine by `install/worker.sh` — the same
script whether a person runs it with `curl | sh` or the control plane runs it
over ssh. To try a checkout on a real machine without a release, `just
build-worker` packs a tarball into `target/artifacts`, and `just dev` starts
the control plane with `FIRETOWER_WORKER_ARTIFACTS` pointing there, so
"Install the worker" sends that build to a machine of the same shape.

## Docker inside a session

A session can run `docker compose up` when the machine has Docker. It is the
machine's daemon: a stack a session brings up is published on the machine's
`127.0.0.1`, which is where `tunnel.rs` connects, and therefore what makes a
preview reach a compose service.

Two things follow, and neither is hidden from the agent — both are written into
the `AGENTS.md` a session starts with:

* **The daemon is shared by every session on that machine.** Published ports
  are shared — two sessions both mapping `3000:3000` collide — and `docker ps`
  in one session lists another's containers.
* **Teardown is by label.** Each session gets its own Compose project name and
  everything carrying it is removed when the session ends. A bare `docker run`
  is only cleared up if it carries
  `--label com.firetower.session=$FIRETOWER_SESSION`.

The boundary is the machine. Anything a session runs has the account's access
to it, so give a worker a VM of its own when that is what you want.

To check any of this, run it from inside a session:

```sh
just session-check       # tools, daemon, a compose stack, a build, teardown
```

The one check it cannot do for you is the preview, because a session cannot
derive its own preview hostname — the control plane signs it. Copy the URL for
port 8080 from the session and pass it in:

```sh
PREVIEW_URL=https://<session>-8080-<sig>.<domain> just session-check
```

If loopback answers and the preview does not, the daemon is publishing into the
wrong network namespace, and the design is wrong rather than the deployment.
