# Security

Firetower holds the keys to machines you own — an SSH key for every host in the
fleet, the credentials your agents sign in with, and a secrets vault that
sessions read from. A hole in it is not a hole in a web application. It is shell
on your servers. So the way to report one is private, and this page says what
we do with it.

## Reporting a vulnerability

**[Open a private security advisory](https://github.com/firetower-cloud/firetower/security/advisories/new).**

Not a public issue, not a message in a channel, and not a pull request with the
fix in it — each of those publishes the vulnerability to everybody running
Firetower before there is a release for them to move to.

Tell us what you did, what you got back, and what it would let somebody else do.
A proof of concept is worth more than a description, and the version is worth
more than both: `firetower --version`, or Settings → About.

If that link does not open for you, send a direct message to a maintainer in the
[Discord](https://discord.gg/uVa8wsYym) and we will open the advisory from our
side. Do not describe it in a public channel.

| | |
|---|---|
| We acknowledge | within three working days |
| We say whether we agree it is a vulnerability | within seven days |
| We ship a fix, or tell you when it lands | within thirty days for anything we rate high or critical |

## Supported versions

| Version | Supported |
|---|---|
| The latest release | Yes |
| Anything before it | No — the upgrade is the fix |

Firetower is pre-1.0 and ships often. There are no maintained branches behind
the latest release, and a fix goes out as a new release rather than as a patch
to an old one. The control plane compares its version against each worker's on
every handshake, so a fleet that has not moved tells you so.

## What is in scope

* The control plane, the CLI and the updater.
* The worker, and the SSH transport the two of them speak over.
* The secrets vault, and anything that reads from it.
* The desktop, mobile and web clients.
* `install.sh`, `install/worker.sh`, and the images published on release.
* The workflows in `.github/` — a release that could be poisoned on its way out
  is a real finding, and we would rather hear about it than not.

## What is not

* **What a session can do on the machine it runs on.** A session runs an agent
  with the account's access to that host: its home directory, its Docker daemon,
  anything on its network. That is the design, and it is written down in
  CONTRIBUTING.md — the boundary is the machine, not the session. Give a worker a
  VM of its own when you want a smaller one. A report that a session can reach
  the machine it is on is not a vulnerability.
* **Vulnerabilities in the agents themselves** — Claude Code, Codex, OpenCode,
  Cursor Agent, Kimi, Hermes. Those belong to their authors. Tell us anyway if
  Firetower makes one worse than it is on its own, and we will help you find the
  right place for the rest.
* Anything that needs an attacker who already holds the control plane's
  administrator password, or a shell on the host it runs on.
* Missing headers, cookie flags or TLS settings with no path to impact attached.
* Denial of service by an authenticated operator against their own deployment.
* Scanner output with nothing demonstrated.
* Social engineering, phishing, and physical access.

Firetower is built to sit on a private network — over Tailscale, never exposed
to the public internet. If you have exposed it anyway, we will still read the
report and still fix anything plainly wrong, but it is not a configuration we
support or test.

## Disclosure

We will name you in the advisory and in the release notes, unless you would
rather we did not. We ask for ninety days before you publish, or until there is
a release people can move to, whichever comes first.

There is no bounty programme. We are a small team and the AGPL is the whole of
the business model, so what we have to offer is a fix shipped quickly and a
proper public thank you. We would rather say that plainly than imply otherwise.
