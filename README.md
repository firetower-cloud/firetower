<div align="center">

[![Firetower — run any coding agent, on your own servers, from anywhere.](.github/assets/header.jpg)](https://usefiretower.com)

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-FF4F00.svg?style=flat-square)](https://github.com/firetower-cloud/firetower/blob/main/LICENSE) [![Latest release](https://img.shields.io/github/v/release/firetower-cloud/firetower?style=flat-square&color=FF4F00)](https://github.com/firetower-cloud/firetower/releases) [![Container image](https://img.shields.io/badge/ghcr.io-firetower-FF4F00?style=flat-square)](https://github.com/firetower-cloud/firetower/pkgs/container/firetower) [![Stars](https://img.shields.io/github/stars/firetower-cloud/firetower?style=flat-square&color=FF4F00)](https://github.com/firetower-cloud/firetower/stargazers)

**Firetower is a control plane for coding agents.**

It lets you orchestrate your favorite coding agents on your local computer or any remote server through an SSH tunnel.

Give it a server you can SSH into and a repository, describe some work, and it picks a host, cuts a branch, makes a worktree, starts tmux, launches the agent, and keeps it running.

And yes, it works with your own subscription (Claude Code, Codex, etc.).

[![Read the documentation](https://img.shields.io/badge/Read_the_documentation-FF4F00?style=for-the-badge&logo=readthedocs&logoColor=white&labelColor=FF4F00)](https://usefiretower.com/docs)

[Website](https://usefiretower.com) · [Getting started](https://usefiretower.com/docs/getting-started) · [How it works](https://usefiretower.com/docs/self-hosting) · [Issues](https://github.com/firetower-cloud/firetower/issues)

### 🌟 Star the repository to support us 🌟

</div>

## Current stage

> [!WARNING]
> The project is in active development and still in the early stages. Expect breaking changes and bugs.


## Demo

https://github.com/user-attachments/assets/694af074-f15f-42ef-a2ad-0a7b8a43dccf





## How it fits together

```
                                                             +-[x]- GCP VM . 34.79.12.180 --------------+
                                                             |  worker . tmux . git                     |
+-[x]- FIRETOWER --------------------------+       +-------->|  * Claude Code  westlabs/ledger   2h48m  |
|  inbox        * 2 waiting on you         |       |         |  o Codex        westlabs/api      3h34m  |
|                                          |       |         +------------------------------------------+
|  runs on your laptop, or on a            |--ssh--+
|  server you already own                  |       |         +-[x]- Hetzner VM . 5.161.44.9 ------------+
+------------------------------------------+       |         |  worker . tmux . git                     |
                                                   +-------->|  o Claude Code  westlabs/web      2h01m  |
                                                             +------------------------------------------+
```

The control plane can run on your local computer or a remote server. It allows you to orchestrate the agent, manage your repositories, your secrets, and user accounts.

The workers can run locally or on any remote server as well. Their only job is to pull a repository, start a task into a new worktree, and run the coding agent.

The control plane and the worker communicate entirely through SSH, and you can close and reopen the connection at any time.

<div align="center">

[![Read how it works](https://img.shields.io/badge/Read_how_it_works-525252?style=for-the-badge&logo=readthedocs&logoColor=white&labelColor=525252)](https://usefiretower.com/docs/self-hosting)

</div>

## Running it

To install the control plane:

```sh
npm i -g @firetower/cli
firetower install
```

To set up a worker on a server:

```sh
npm i -g @firetower/cli
firetower worker install
```

A session can run Docker: `docker compose up` inside a session works, and the preview for a published port reaches it. The worker runs a daemon of its own, which means **worker containers are privileged** — anything in a session can become root on the machine hosting that worker. Give a worker a machine of its own and treat everything else on it as reachable from any session. Set `FIRETOWER_WORKER_DOCKER=off` to turn it off: workers come up as before, without Docker in sessions.

Everything else — putting it on a domain, adding a server, connecting repositories, secrets, upgrades — is in the documentation.

<div align="center">

[![Full installation guide](https://img.shields.io/badge/Full_installation_guide-FF4F00?style=for-the-badge&logo=readthedocs&logoColor=white&labelColor=FF4F00)](https://usefiretower.com/docs/getting-started)

</div>

## Documentation

| | |
| --- | --- |
| [Getting started](https://usefiretower.com/docs/getting-started) | The short path from nothing to a running session |
| [How it works](https://usefiretower.com/docs/self-hosting) | Control plane, workers, and the protocol between them |
| [Install the app](https://usefiretower.com/docs/self-hosting/app/install) | The control plane, with Docker |
| [Add a machine](https://usefiretower.com/docs/self-hosting/machines/install) | Run sessions on a server over SSH |
| [Put it on a domain](https://usefiretower.com/docs/self-hosting/domain) | HTTPS, certificates, and what goes wrong |
| [Daily operations](https://usefiretower.com/docs/self-hosting/operations) | Draining, backups, and version drift |
| [Upgrading](https://usefiretower.com/docs/self-hosting/app/upgrade) | The app and [the worker](https://usefiretower.com/docs/self-hosting/machines/upgrade) — or [from the Updates screen](docs/updates.md) |
| [Connect repositories](https://usefiretower.com/docs/repositories) | Git URLs, paths, and authorizing GitHub |
| [Secrets](https://usefiretower.com/docs/secrets) | How credentials are sealed, and where the root key lives |


## Supported agents

| | |
| --- | --- |
| Claude Code | Supported |
| Codex | Supported |
| OpenCode | Planned |
| Grok| Planned |
| Cursor | Planned |

## Contributing

Due to the early stage of the project, we don't accept contributions at the moment. We may accept some small fixes or changes, but not big features. However, feel free to open an issue and share feedback; it will be helpful.

## Licence

AGPL-3.0-only. Copyright © Westlabs LLC.

If you run a modified Firetower as a network service, you have to publish your changes.

### Annotating application previews

Open a Preview tab and choose **Annotate**, or click **Open ↗** and use the
floating **Firetower · Annotate** toolbar in the application. Select an element,
use **Select parent** or the ancestor picker to select its containing card or
section, write a comment, and choose **Keep**. **Send to agent** submits the kept
notes together to the session's conversation. The conversation also shows kept
preview notes for review, editing, removal, and sending.

Kept notes live in the control-plane database and survive browser reloads and
closed tabs. Each includes a bounded, redacted HTML snapshot, selector, ancestor
path, page pathname, viewport, scroll position, bounds, and capture time. These
are rendered DOM locations, not source-file locations. Form values and editable
content are omitted; applications can mark sensitive regions with `data-private`
or `data-sensitive`. Query strings and fragments are omitted. Review captured
HTML under **Element details** before sending feedback.

The preview proxy injects a small element picker into HTML document responses.
The picker runs in the application's origin; authentication and sending run in a
separate Firetower-origin panel. A preview link alone does not grant permission
to write to a conversation. Directly opened previews use `FIRETOWER_PUBLIC_URL`
to find that panel (set it to the browser-facing Firetower URL in deployments).
Opening from Firetower supplies the current UI origin, including split-port
local development. Sign in to Firetower if the panel requests it.

If an application's Content Security Policy blocks the embedded panel, or the
browser partitions its storage, choose **Open feedback panel ↗** to use a
separate window. CSP script/style nonces authorize the picker without removing
the application's other restrictions. Policies that also prevent popups, service
worker responses that bypass the proxy, non-UTF-8 documents, and servers that
ignore the proxy's request for uncompressed HTML may require **Plain ↗**.
Cross-origin iframe contents, closed shadow roots, and individual canvas objects
are not selectable; annotate their containing element instead. The plain option
opens the application without HTML instrumentation.

Delivery is recorded before a message is handed to the worker. Retrying an
acknowledged batch does not send it twice. If delivery becomes unconfirmed,
check the conversation before recreating or removing the notes; Firetower never
automatically retries an uncertain agent turn.

Development checks: `cargo test -p ft-server --lib annotations` (with Postgres),
`pnpm --dir web exec tsc --noEmit`, and `pnpm --dir web test:browser`.
Install the browser once with `pnpm --dir web exec playwright install --with-deps
chromium`. The browser tests run the actual picker and Firetower panel with an
isolated API fixture; Rust tests exercise persistence and worker delivery.
