# 332 — Can a machine be added and a worker installed without mutating the developer's host?

Research for [#332](https://github.com/firetower-cloud/firetower/issues/332), under
[#329](https://github.com/firetower-cloud/firetower/issues/329). Shares the stack
brought up for [#330](https://github.com/firetower-cloud/firetower/issues/330).

## Answer: yes. A container works, and nothing about the host has to change.

Two Alpine containers were added as machines through the real API and both reached
`state: "Online"` with a working worker. The host's Remote Login was never
touched and nothing was written to `~/.ssh/authorized_keys`.

```
sshbox         state=Online  worker=0.55.0  docker=Absent  cpus=12
sshbox-bare    state=Online  worker=0.55.0  docker=Absent  cpus=12
```

**Rig.** macOS 25.6.0 on Apple silicon. `ft-server` (this checkout, 0.55.0) on
`127.0.0.1:4411`, Postgres on 5434, session
`s_01m7mefybzh40p1akvbfy4a5sg`. Everything below was run.

---

## 1. Try it — the literal commands, and the errors on the way

### The image

`.scratch/sshbox/Dockerfile`. **Alpine on purpose**: the published Linux workers
are static musl binaries (`.github/workflows/release.yml:102-106`:
`aarch64-unknown-linux-musl`, `x86_64-unknown-linux-musl`), so a worker that runs
on Alpine runs on any Linux. Proving it on musl is the stronger claim.

```dockerfile
FROM alpine:3.21
RUN apk add --no-cache openssh-server git tmux curl tar ca-certificates
RUN adduser -D -s /bin/sh editor \
 && mkdir -p /home/editor/.ssh && chmod 700 /home/editor/.ssh
COPY authorized_keys /home/editor/.ssh/authorized_keys
# `adduser -D` leaves the account password-LOCKED, and sshd refuses a locked
# account even for key auth. `*` is "no password", which is not the same thing.
RUN sed -i 's/^editor:!/editor:*/' /etc/shadow \
 && chmod 600 /home/editor/.ssh/authorized_keys \
 && chown -R editor:editor /home/editor/.ssh \
 && ssh-keygen -A \
 && sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
```

```sh
# The key the control plane will dial with. Needs a token that is past the
# forced password change — see #330 §1.
curl -s -H "authorization: Bearer $TOK" http://127.0.0.1:4411/api/v1/ssh-key \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["publicKey"])' \
  > .scratch/sshbox/authorized_keys

docker build -t ft-sshbox-$FIRETOWER_SESSION .scratch/sshbox
docker run -d --name ft-machine-$FIRETOWER_SESSION \
  --label com.firetower.session=$FIRETOWER_SESSION \
  -p 2222:22 ft-sshbox-$FIRETOWER_SESSION
```

| Step | Measured |
|---|---|
| `docker build` (Alpine, cold layers) | **9.57s** |
| `docker run` | **0.23s** |
| rebuild + run after an edit | **5.52s** |

### Adding it

```sh
BODY='{"name":"sshbox","compute":{"type":"Server","host":"127.0.0.1",
       "user":"editor","port":2222,"key":{"type":"Managed"}}}'

curl -s -X POST http://127.0.0.1:4411/api/v1/hosts/probe \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$BODY"

curl -s -X POST http://127.0.0.1:4411/api/v1/hosts \
  -H "authorization: Bearer $TOK" -H 'content-type: application/json' -d "$BODY"

curl -s -X POST "http://127.0.0.1:4411/api/v1/hosts/$HID/worker" \
  -H "authorization: Bearer $TOK"          # "Install the worker"
```

"Machines" in the UI are **`hosts`** in the API. `key: {"type":"Managed"}` is the
key Firetower made for itself and holds in the vault — the one a machine added
through the interface uses (`SshKey` doc comment, `api/openapi.json`).
`host` also accepts `editor@10.0.4.7:2222` as one string and is parsed apart
(`crates/ft-server/src/api/hosts.rs:125-180`, and its test at :664).

| Step | Measured |
|---|---|
| `POST /api/v1/hosts/probe` | **0.07s** – **0.10s** |
| `POST /api/v1/hosts` | **0.12s** |
| `POST /api/v1/hosts/{id}/worker`, downloading the release | **2.80s** |
| `POST /api/v1/hosts/{id}/worker`, from `FIRETOWER_WORKER_ARTIFACTS` | **0.36s** |
| `GET /api/v1/hosts/{id}/readiness` | **0.1s** |

### It did not work first time. Both failures, verbatim.

**(a) The account was password-locked.** `adduser -D` on Alpine leaves `!` in
`/etc/shadow`, and sshd refuses the account even for key authentication.

```json
{"reached":false,"diagnosis":{"cause":"AuthRefused",
 "summary":"127.0.0.1 refused the key.",
 "detail":"Warning: Permanently added '[127.0.0.1]:2222' (ED25519) to the list of known hosts.\neditor@127.0.0.1: Permission denied (publickey,keyboard-interactive)."}}
```

The control plane's diagnosis says only "refused the key", which sends you looking
at the key. `docker logs` on the container is what actually says it:

```
User editor not allowed because account is locked
Connection closed by invalid user editor 192.168.215.1 port 59876 [preauth]
```

Fix: `sed -i 's/^editor:!/editor:*/' /etc/shadow`. The key was correct all along —
verified identical on both sides.

**(b) The rebuilt container tripped `HostKeyChanged`.** `ssh-keygen -A` runs at
build time, so the host keys live in the image layer: stable across `docker run`,
regenerated by every `docker build`. The control plane records them under
`$FIRETOWER_HOME/ssh/known_hosts` with `StrictHostKeyChecking=accept-new`, which
accepts an unknown host and refuses a changed one.

```json
{"reached":false,"diagnosis":{"cause":"HostKeyChanged",
 "summary":"127.0.0.1 answered with a different host key than last time.",
 "detail":"@@@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@@@\n…\nHost key for [127.0.0.1]:2222 has changed and you have requested strict checking.\nHost key verification failed."}}
```

Fix: `rm -f "$FIRETOWER_HOME/ssh/known_hosts"`, or a fresh `FIRETOWER_HOME` per
run. **This belongs in the reset unit** — see #330 §3.

### Then it worked

```json
{"reached":true,"diagnosis":{"cause":"WorkerMissing",
 "summary":"Firetower isn't installed on that machine.",
 "remedy":"curl -fsSL https://usefiretower.com/worker.sh | sh",
 "detail":"firetower-worker: exec: line 0: firetower-worker: not found"}}
```

and after `POST /hosts/{id}/worker`:

```json
{"version":"firetower-worker 0.55.0"}
```

with the host settling to `state: "Online"`, `workerVersion: "0.55.0"`, `cpus: 12`
and a capacity block (`memoryMb: 18028`, `memoryUsedMb: 24`).

---

## 2. What the worker actually needs on the far side

**Established empirically, by building a second container that deliberately had
almost none of it** (`.scratch/sshbox-bare/Dockerfile`: `apk add openssh-server`
and nothing else).

The authoritative list is in the installer's own header,
`install/worker.sh:11-13`: "git, tmux, a POSIX shell, curl and tar — and an sshd,
because that is how Firetower reaches it. Agents are fetched by the worker itself,
as standalone binaries." Measured against that:

| Need | Required for | Evidence |
|---|---|---|
| **sshd, reachable, key authorised** | everything | `AuthRefused` / `HostKeyChanged` above |
| **An unlocked account** | ssh to work at all | failure (a) above. Not in any doc. |
| **A POSIX shell at `sh`** | install and every later command | every remote command is `sh -c '…'` (`transport.rs:185-189`) |
| **`tar`** | unpacking the worker | `worker.sh:120`, `:205` |
| **`curl`** | **only** when the worker is downloaded | `worker.sh:117-119` adds curl to `NEEDED_HERE` only `if [ -z "$FROM" ]`. Proven: the bare container has no curl and the download install failed, then the same install **succeeded in 0.36s** once a local artifact was present. |
| **`git`** | running a session, not installing | bare container: `available: false`, host still `Online` |
| **`tmux`** | running a session, not installing | ditto |
| **A writable `~/.firetower/worker`** | install and state | `readiness.rs:140-153` actually writes a temp file there — "including read-only mounts" |
| **libc flavour** | **nothing.** | The Linux worker is fully static: `file` says `ELF 64-bit LSB executable, ARM aarch64, statically linked, stripped`, and in-container `ldd` says `Not a valid dynamic program`. glibc vs musl is a non-issue on Linux. |
| **docker on the machine** | not required | `docker: {"status":"Absent"}` on both, both `Online` |

The install refusal on the bare container, verbatim (HTTP **409**):

```json
{"code":"HostUnreachable","message":"installing the worker: editor@127.0.0.1 could not run `sh \"$HOME/.firetower/worker/install.sh\" --skip-packages --version 0.55.0`: error: cannot install the worker without curl. Install it and run this again."}
```

And the worker's own readiness on the two machines, from
`GET /api/v1/hosts/{id}/readiness` — five checks, generated by
`crates/ft-worker/src/readiness.rs:110-163`:

| Check | equipped `sshbox` | bare `sshbox-bare` |
|---|---|---|
| Firetower worker | ✅ `0.55.0` | ✅ `0.55.0` |
| Git | ✅ `git version 2.47.3` | ❌ `Missing, failed, or did not answer within 3 seconds` → remedy `sudo apk add git` |
| tmux | ✅ `tmux 3.5a` | ❌ same → remedy `sudo apk add tmux` |
| Shell | ✅ `sh available` | ✅ `sh available` |
| Worker state directory | ✅ `/home/editor/.firetower/worker` | ✅ same |
| `user` | `editor` | `editor` |

> **The trap worth writing into the skill.** The bare machine with no git and no
> tmux is still reported `state: "Online"` with `diagnosis: null`. Online means
> "the worker answered", not "a session could run here". A verification run must
> read `/readiness` and assert every `required` check is `available`; trusting
> `Online` would let it start a session on a machine that cannot clone.

Note the remedies are rendered for the machine's own package manager — `apk` here,
because `package_remedy` looks at the PATH it probed with
(`readiness.rs:89-108`). Firetower never runs them: the control plane passes
`--skip-packages` and "does not run sudo on your machine"
(`crates/ft-server/src/install.rs:134-137`).

---

## 3. What "Install the worker" sends, and what `FIRETOWER_WORKER_ARTIFACTS` changes

`POST /api/v1/hosts/{id}/worker` → `api/hosts.rs:575-611` → `install::install`
(`crates/ft-server/src/install.rs:98-152`). Four ssh commands, in order:

1. **`uname -sm`** — the machine's shape, mapped to an asset name by
   `artifact_for` (`install.rs:63-79`): `darwin`/`linux` × `arm64`/`x86_64`, so
   `firetower-worker-linux-arm64.tar.gz` here. Any other shape is refused by name.
2. **`mkdir -p "$HOME/.firetower/worker" && cat > "$HOME/.firetower/worker/install.sh"`**
   with `install/worker.sh` on stdin. The script is **compiled into the binary**
   (`install.rs:32`, `include_str!`) and *sent*, never fetched — "so the version of
   the script that runs is this build's".
3. **`sh "$HOME/.firetower/worker/install.sh" --skip-packages --version 0.55.0`**,
   plus **` --from -`** with the tarball streamed on stdin when a local artifact
   exists. `--version` is `CARGO_PKG_VERSION` of the running control plane.
4. **The probe**, `transport::worker_probe()` (`transport.rs:185-200`):
   `sh -c 'PATH="$PATH:$HOME/.firetower/worker/bin" exec firetower-worker "$@"' firetower-worker --version`
   — asked "the way a connection will ask, so a probe and a session resolve to the
   same binary". A probe that does not answer is **not** treated as a failed
   install (`install.rs:94-110`).

Every one of those goes through `ssh` with these options
(`transport.rs:274-332`): `-o BatchMode=yes`, `-o ConnectTimeout=10`,
`-o StrictHostKeyChecking=accept-new`,
`-o UserKnownHostsFile=$FIRETOWER_HOME/ssh/known_hosts`, `-p <port>`,
`-i <key materialised from the vault>`, `-o IdentitiesOnly=yes`, then `--` and the
destination. `ask` times out at 20s. The `--` is deliberate: an address starting
with `-` would be read by ssh as an option, and `settled()` refuses one as well so
that "the two halves of this fix should not depend on each other to hold".

### What `FIRETOWER_WORKER_ARTIFACTS=target/artifacts` changes

`local_artifact` (`install.rs:85-89`) joins the directory with the asset name for
**that machine's shape** and uses it only `if path.is_file()`. Miss → the script
downloads from `https://github.com/firetower-cloud/firetower/releases/download/firetower-v<version>/<asset>`,
checksum-verified against the release's `SHA256SUMS` (`worker.sh:180-202`).

Both paths were exercised:

- **Miss → download.** `target/artifacts` held only
  `firetower-worker-darwin-arm64.tar.gz` (what `just build-worker` makes on
  macOS), the machine wanted `linux-arm64`, so the script downloaded. **2.80s**,
  installed `0.55.0`, and the server log has no local-build line. It worked
  because `version.txt` is `0.55.0` and release `firetower-v0.55.0` publishes
  `firetower-worker-linux-arm64.tar.gz` — a checkout **between** releases has no
  such asset and this path fails.
- **Hit → local build.** After putting a genuinely cross-built
  `firetower-worker-linux-arm64.tar.gz` there, **0.36s**, and the server said so:

  ```
  INFO ft_server::install: installing the worker from a local build
       asset="firetower-worker-linux-arm64.tar.gz"
       from=target/artifacts/firetower-worker-linux-arm64.tar.gz
  ```

> **The gap this exposes, and it is the real finding of §3.** On macOS,
> `just build-worker` can only ever produce `darwin-*`: justfile:138-139 derives
> os/arch from `uname`, and the recipe has no `--target`. So **a macOS developer
> cannot use `FIRETOWER_WORKER_ARTIFACTS` to put *this checkout's* worker on a
> Linux container machine** — the artifact name never matches and it silently
> downloads a release instead. Silently is the problem: a run would verify the
> *released* worker while believing it verified the branch. A verification skill
> must assert which path was taken (the log line above, or the absence of the
> asset) before claiming it tested a worker change.
>
> The way round it, measured: build the musl worker in a container.
> **269.93s** total, of which 2m17s was `cargo build` and the rest rustup fetching
> the pinned 1.90 toolchain.
>
> ```sh
> docker run --rm --label com.firetower.session=$FIRETOWER_SESSION \
>   -v "$PWD":/src:ro -v "$PWD/.scratch/xbuild":/out -e CARGO_TARGET_DIR=/ctarget \
>   rust:alpine sh -c 'apk add --no-cache musl-dev perl make >/dev/null \
>     && cp -r /src /build && cd /build \
>     && cargo build --release -p ft-cli --no-default-features --bin firetower-worker \
>     && cp /ctarget/release/firetower-worker /out/ && /out/firetower-worker --version'
> tar -czf target/artifacts/firetower-worker-linux-arm64.tar.gz -C .scratch/xbuild firetower-worker
> ```
>
> `rust:alpine` on arm64 is musl-native, so no cross-linker is needed. On the host
> there is none: `rustup target list --installed` is
> `aarch64-apple-darwin, x86_64-pc-windows-gnu, x86_64-pc-windows-msvc`, and
> neither `musl-gcc` nor `aarch64-linux-musl-gcc` is on PATH. Adding them would
> mutate the developer's toolchain — the thing this ticket exists to avoid.

---

## 4. What `just build-worker` costs

```
just build-worker (release profile cold, debug profile already warm): 64.06s
  cargo build --release -p ft-cli --no-default-features --bin firetower-worker
  Finished `release` profile [optimized] target(s) in 1m 00s
  target/artifacts/firetower-worker-darwin-arm64.tar.gz   (4,400,922 bytes)
```

**64.06s.** The release profile shares nothing with the debug profile, so the
earlier `cargo build -p ft-cli` (57.48s, #330 §1) did not warm it. On a machine
where `target/release` is already populated it will be far less; that was not
measured.

For comparison, the cross-build that produces the Linux asset a container machine
actually wants: **269.93s**.

---

## 5. Does the control plane care that the machine is a container?

**No. A reachable ssh endpoint with the right key is genuinely all it asks.**

Read: `Compute::Server` holds a host, a user, a port, a key and a recorded host
key, and nothing else (`api/openapi.json`, `ft_core::Compute`). `create_host`
(`api/hosts.rs:47-92`) refuses exactly one thing — `Compute::Local`, the retired
in-process worker: *"Firetower does not run agents on itself. Add the machine over
ssh instead."* There is no container check anywhere in the add, probe, install or
connect paths.

Run: both containers reached `Online` with a worker, a cpu count and a capacity
block. The two things the control plane *does* notice are facts the worker
reports, not judgements about what the machine is:

- `docker: {"status": "Absent"}` — and the `Host` doc comment is explicit that
  this is "reported by the worker at every handshake rather than inferred from the
  kind of host… a container, a server and a server-with-a-container each arrive at
  it differently." It did not block anything.
- `memoryMb: 0` and `diskTotalMb: 0` while `capacity.memoryMb` read 18028. The
  worker reports no disk inside this container. Not investigated; harmless for
  adding a machine, possibly relevant to anything that reads disk capacity.

### The host path, for completeness — and it is not needed

`CONTRIBUTING.md:80-87` and `install/worker.sh:250-257` describe it: turn Remote
Login on (System Settings → General → Sharing → Remote Login, or
`sudo systemsetup -setremotelogin on`), put the key from the Add dialog into
`~/.ssh/authorized_keys`, `just build-worker`, Install the worker.

- **It is reversible**: `sudo systemsetup -setremotelogin off`, and removing the
  one appended line. Both need `sudo`, and on recent macOS `systemsetup` also
  needs Full Disk Access for the calling binary — so an agent inside a session
  very likely **cannot** do it, and certainly cannot do it unprompted.
- **On this particular machine it would need less than the docs suggest.** The
  product's own sshd check passes — `launchctl print system/com.openssh.sshd`
  exits 0, the same test `worker.sh:242-243` uses — and
  `~/.ssh/authorized_keys` already exists with 5 entries. So only appending a key
  would be required here. **That is a property of this machine, not a plan**: a
  verification run cannot assume Remote Login is on, and appending to a
  developer's real `authorized_keys` is a mutation of their host whichever way it
  is reversed.
- **I did not do it**, deliberately. The container route makes it unnecessary.

**Recommendation.** The verification skill should stand up an sshd container as
the machine, every time, and should never offer the host path as a fallback it can
take by itself. If a human wants the host path they can follow CONTRIBUTING.md;
the skill's job is to not need it.

---

## Appendix: what was NOT established

- **Whether a session actually runs on a container machine.** Added, worker
  installed, readiness green — but no workspace was created and no repository
  cloned. That is #333/#336's ground, and it is the remaining Tier B risk. The
  equipped container has git and tmux, so there is no known obstacle; "no known
  obstacle" is not evidence.
- **`docker: Absent` on the machine** means a session there cannot run containers.
  Anything in the feature map that needs docker-in-docker needs a different
  container (`--privileged`, or a docker socket) and that was not tried.
- **x86_64.** Everything here is arm64. The published `linux-x86_64` worker exists
  and is also musl, so the same shape should hold, untested.
- **The 2.80s download install** depended on release `firetower-v0.55.0` matching
  `version.txt`. On a branch whose version has no release, that path fails and the
  cross-build becomes mandatory, not optional. Not measured, because this checkout
  happened to match.
- **Whether the host could be added as a machine.** Not attempted; it requires
  writing to the developer's `~/.ssh/authorized_keys`.

---

## For the skill's Cleanup section (noted for #337's ordering constraint)

Teardown here is label-driven and instant, and nothing about it fights the
capture → post → verify → clean order:

```sh
docker rm -f ft-machine-$FIRETOWER_SESSION ft-machine-bare-$FIRETOWER_SESSION
docker rmi ft-sshbox-$FIRETOWER_SESSION ft-sshbox-bare-$FIRETOWER_SESSION
docker compose down -v          # with COMPOSE_PROJECT_NAME set to the session's
kill "$(lsof -nP -iTCP:$FIRETOWER_PORT -sTCP:LISTEN -t)"
```

One ordering hazard, and it is not a container one. **Evidence that lives in
`$FIRETOWER_HOME` or in Postgres dies with the teardown**, and the two most
useful artefacts of a machine run are exactly there: the control plane's stderr
(the only place the first-run password and ssh key are ever printed — #330 §2) and
`$FIRETOWER_HOME/ssh/known_hosts`. Both must be read out and attached **before**
`docker compose down -v` and before the scratch home is removed. `docker logs` on
the machine container is the other one — it is what diagnosed the locked account
above, and it is gone the moment `docker rm` runs.
