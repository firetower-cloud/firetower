

<div align="center">

[![Firetower — run any coding agent, on your own servers, from anywhere.](.github/assets/header.jpg)](https://usefiretower.com)

[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-FF4F00.svg?style=flat-square)](https://github.com/firetower-cloud/firetower/blob/main/LICENSE) [![Latest release](https://img.shields.io/github/v/release/firetower-cloud/firetower?style=flat-square&color=FF4F00)](https://github.com/firetower-cloud/firetower/releases) [![Container image](https://img.shields.io/badge/ghcr.io-firetower-FF4F00?style=flat-square)](https://github.com/firetower-cloud/firetower/pkgs/container/firetower) [![Stars](https://img.shields.io/github/stars/firetower-cloud/firetower?style=flat-square&color=FF4F00)](https://github.com/firetower-cloud/firetower/stargazers)

**Firetower is a control plane for coding agents.**

It lets you orchestrate your favorite coding agents on your local computer or any remote server through an SSH tunnel.

Give it a server you can SSH into and a repository, describe some work, and it picks a host, cuts a branch, makes a worktree, starts tmux, launches the agent, and keeps it running.

And yes, it works with your own subscription (Claude Code, Codex, etc.).

[![Read the documentation](https://img.shields.io/badge/Read_the_documentation-FF4F00?style=for-the-badge&logo=readthedocs&logoColor=white&labelColor=FF4F00)](https://usefiretower.com/docs) [![Join the community](https://img.shields.io/badge/Join_the_community-5865F2?style=for-the-badge&logo=discord&logoColor=white&labelColor=5865F2)](https://discord.gg/uVa8wsYym)

### 🌟 Star the repository to support us 🌟

</div>

## Current stage

> [!NOTE]
> People are using Firetower in production now, but you should expect bugs from time to time. Starring and sharing the repository is extremely helpful, and you can also [join the community](https://discord.gg/uVa8wsYym) to help us build faster.


## Demo

https://github.com/user-attachments/assets/6e9eb02f-4e31-4c6e-8580-6cd11cea526a


## Why is Firetower different?

Alternatives like Orca and Paseo are excellent desktop products that reach outward. Their agents run on your laptop, and remote execution is a mode bolted on afterward: a relay daemon over SSH, a headless Electron under Xvfb, a control plane that dies when you close the lid. 

Firetower starts from the other end. The control plane is a server by design, it never touches the public internet, and the laptop is only a client among others. Agents run on machines that don't sleep, in isolated worktrees with real resource limits, using each developer's own subscriptions and credentials.

## How it fits together

```
+-[x]- Desktop -----+  +-[x]- Mobile ------+
|  macOS / Windows  |  |  iOS / Android    |
+-------------------+  +-------------------+
          |                      |
          +----------+-----------+
                     |
                     |  https over Tailscale
                     v
                                                             +-[x]- GCP VM . 34.79.12.180 --------------+
                                                             |  worker . tmux . git                     |
+-[x]- FIRETOWER --------------------------+       +-------->|  * Claude Code  westlabs/ledger   2h48m  |
|  inbox        * 2 waiting on you         |       |         |  o Codex        westlabs/api      3h34m  |
|                                          |       |         +------------------------------------------+
|  runs on your laptop, or on a            |--ssh--+
|  server you already own                  |       |         +-[x]- Mac mini . 100.92.14.7 -------------+
+------------------------------------------+       |         |  worker . tmux . git                     |
                                                   +-------->|  o Claude Code  westlabs/web      2h01m  |
                                                             +------------------------------------------+
```

You drive it from the desktop app on macOS and Windows, or from your phone on iOS and Android. Both reach the control plane over HTTPS on your Tailscale network, so it never has to be exposed to the public internet.

The control plane can run on your local computer or a remote server. It allows you to orchestrate the agent, manage your repositories, your secrets, and user accounts.

The workers can run locally or on any remote server as well. Their only job is to pull a repository, start a task into a new worktree, and run the coding agent.

The control plane and the worker communicate entirely through SSH, and you can close and reopen the connection at any time.

<div align="center">

[![Read how it works](https://img.shields.io/badge/Read_how_it_works-525252?style=for-the-badge&logo=readthedocs&logoColor=white&labelColor=525252)](https://usefiretower.com/docs/self-hosting)

</div>

## Running it

To install the control plane, on a Linux server:

```sh
curl -fsSL https://usefiretower.com/install.sh | sh
```

Everything after that happens in the desktop app: adding workers, connecting repositories, secrets, and updating Firetower itself.

## Documentation

| | |
| --- | --- |
| [Getting started](https://usefiretower.com/docs) | The short path from nothing to a running session |

## Supported agents

| | |
| --- | --- |
| Claude Code | Supported |
| Codex | Supported |
| OpenCode | Looking for contributions |
| Grok| Looking for contributions |
| Cursor | Looking for contributions |
| Kimi | Looking for contributions |
| Hermes | Looking for contributions |

## Contributing

We accept contributions now. Before you start on anything beyond a small fix, please [join the Discord](https://discord.gg/uVa8wsYym) or open an issue so we can talk it through first.

The project is still moving quickly, and we don't want you to spend a weekend on something that is about to change underneath you, or that we won't merge. Adding a feature also isn't always the right answer — often the better fix is a smaller one, or none at all — and that is a much easier conversation to have before the code exists than after.

### Request for contribution

These are the areas where help is worth the most right now.

- **The website and the documentation.** Improving the site for SEO, adding translations, working on the brand identity (only if you're f*cking talented for this), and making sure the docs cover their blind spots.
- **Support for more AI providers.** Hermes, OpenCode, and more. Ideally one you use every day, so you can test it thoughtfully against a real workload instead of a hello world.
- **Support for other git providers.** GitLab, Gitea, and the rest — today a repository means GitHub.
- **Support for more task trackers.** GitHub and Linear are the two we read work from. More of them, or anything else that makes the development workflow around a session better.
- **Memory management.** Workers run on Macs and on Linux servers. Per-workspace memory management, reporting usage, and the like are going to matter as the project grows. Only take one of these on if you know what you're doing.

Each of these is bigger than a single pull request, so we want to organise them into working groups in the community — one per area, so that the people working on the same thing are talking to each other rather than building it twice. Tell us which one interests you when you join.

For everything else, come and talk to us in the [community](https://discord.gg/uVa8wsYym).

## Licence

AGPL-3.0-only. Copyright © Westlabs LLC.

We chose the AGPL mainly so that an outside company can't take the community's work, repackage it under its own brand and sell it — not without publishing its sources along with it. What goes into this has worth, and we want to protect it.

None of that is aimed at you. Use Firetower, run it on your own servers, fork it and change it — for yourself, your team or your company — however you want.
