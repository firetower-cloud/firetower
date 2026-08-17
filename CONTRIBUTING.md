# Contributing

Running Firetower needs Docker and one compose file — that is the
[README](README.md). Building it needs a toolchain, and that is this.

## Requirements

| | Why |
|---|---|
| **Rust** 1.90+ | Builds everything. `rustup` handles the rest — the toolchain is pinned. |
| **git** | Mirrors and worktrees. Already on most machines. |
| **tmux** | Holds the agent's terminal. This is the piece that keeps a session alive after you disconnect, so it isn't optional. |
| **Docker** | Postgres for the control plane, and a container host if you add one. |
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
just worker-image   # after a protocol change, or containers fail the handshake
```

While developing, the interface and the control plane are two processes on two
ports, so the interface has to be told where the API is. That lives in
`web/.env.development`, which is committed. If every request 404s from Next
instead of reaching the control plane, that file is why — the interface is
asking itself.

Don't edit Rust while a local session is cloning: `cargo watch` restarts the
control plane, which kills the local worker as its child and abandons the
fetch. If you change the shape of a protocol frame, bump `PROTOCOL_VERSION` in
`ft-proto` and rebuild the worker image — an old container fails the handshake
with the stream closing.

The web application is pinned to pnpm. Running `npm install` in `web/` would
produce a second lockfile, so `packageManager` refuses it.

`.env.example` is for contributors. Nobody running Firetower needs one.

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

## Images

```sh
just worker-image        # the worker, after a protocol change
docker build -t firetower .   # the control plane, interface and all
```

Both are published together on release: the control plane compares its version
against each worker's on every handshake, so shipping one without the other
tells everyone their fleet has drifted.
