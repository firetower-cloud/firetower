# Labels

Twelve, in two groups, and the groups are told apart by colour before they are
read: the four **states** are loud, the eight **areas** are one quiet blue. The
question anybody triaging actually asks is "what has been accepted, and what is
waiting on the author" — that is a state. The area is how you find it again.

None of this exists on the repository yet. The block at the bottom creates it.
**Until it runs, the `labels:` key in the issue forms applies nothing for
`needs-scope` and `needs-info`** — GitHub drops a label that does not exist
rather than creating it, silently, which is exactly the failure this file is
here to prevent. `bug`, `enhancement` and `documentation` are GitHub defaults
and already there.

## State — loud, and at most one at a time

| Label | Colour | What it means |
|---|---|---|
| `accepted` | `0E8A16` | A maintainer agreed to this before the code existed. Build it. This is the load-bearing one — it is the only thing in the repository that says yes. |
| `needs-scope` | `FF4F00` | Proposed, not agreed. What the thing is has not been settled yet. Every proposal and integration form sets this on submit, so the honest default is the one you get. |
| `needs-evidence` | `B60205` | A change people can see, with nothing showing it. The same thing `contribution.yml` says on a pull request, said on an issue. |
| `needs-info` | `FBCA04` | Waiting on whoever opened it. The bug form sets this on submit, because a bug report is waiting on its reporter until somebody has reproduced it. |

## Area — quiet, and as many as apply

| Label | Colour | What it covers |
|---|---|---|
| `area/server` | `C5DEF5` | The control plane, the CLI, the updater, migrations. |
| `area/worker` | `C5DEF5` | The worker, the SSH transport, the protocol. |
| `area/desktop` | `C5DEF5` | The Tauri app on macOS and Windows. |
| `area/mobile` | `C5DEF5` | iOS and Android. |
| `area/web` | `C5DEF5` | The Next.js interface and its static export. |
| `area/docs` | `C5DEF5` | `docs/`, the README, this guide, usefiretower.com. |
| `area/agents` | `C5DEF5` | Claude Code, Codex, OpenCode, Cursor Agent, Kimi, Hermes, ACP. |
| `area/trackers` | `C5DEF5` | GitHub and Linear today; Trello, Jira and the rest when they arrive. |

## Creating them

Run this once, from a checkout, by somebody with write access. It is not run by
any workflow and nothing in this pull request creates a label — a label is a
change to the live repository and that is a decision, not a side effect.

```sh
gh label create accepted       --color 0E8A16 --description "Agreed before the code existed. Build it."         --repo firetower-cloud/firetower
gh label create needs-scope    --color FF4F00 --description "Proposed, not agreed. Not a brief to build against." --repo firetower-cloud/firetower
gh label create needs-evidence --color B60205 --description "Changes something you can see, and does not show it." --repo firetower-cloud/firetower
gh label create needs-info     --color FBCA04 --description "Waiting on whoever opened it."                      --repo firetower-cloud/firetower

gh label create area/server    --color C5DEF5 --description "Control plane, CLI, updater, migrations"            --repo firetower-cloud/firetower
gh label create area/worker    --color C5DEF5 --description "Worker, SSH transport, protocol"                    --repo firetower-cloud/firetower
gh label create area/desktop   --color C5DEF5 --description "Tauri app, macOS and Windows"                       --repo firetower-cloud/firetower
gh label create area/mobile    --color C5DEF5 --description "iOS and Android"                                    --repo firetower-cloud/firetower
gh label create area/web       --color C5DEF5 --description "Next.js interface and the static export"            --repo firetower-cloud/firetower
gh label create area/docs      --color C5DEF5 --description "docs/, README, CONTRIBUTING, the site"              --repo firetower-cloud/firetower
gh label create area/agents    --color C5DEF5 --description "Coding agents and ACP"                              --repo firetower-cloud/firetower
gh label create area/trackers  --color C5DEF5 --description "Task trackers"                                      --repo firetower-cloud/firetower
```

`gh label create` fails on a label that already exists. Add `--force` to update
one in place instead.
