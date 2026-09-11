# Task trackers

Tasks are read from a tracker as you look at them. Nothing is copied into
Firetower: the one durable fact is which task a workspace was cut from, kept on
the workspace as a key and a URL.

GitHub and Linear are both trackers. GitHub is also a git host, and its tracker
credential is the git token from **Configuration → Repositories** — there is
nothing separate to connect. Linear is a tracker only.

## Connecting Linear

**Configuration → Trackers → Connect**, or the prompt on the Tasks screen when
Linear is selected and not yet connected.

Linear has no device authorization flow, so there is no short code to approve
elsewhere. It connects with a personal API key from
[linear.app/settings/api](https://linear.app/settings/api). The key is checked
against Linear before it is stored, and the account it belongs to is shown back;
one that does not work is refused rather than kept.

The key is per person, encrypted in the vault under `tracker/linear`, and every
read is a line in the vault's access log. It is never sent to a worker — tasks
are read on the control plane. Disconnecting forgets it; revoking it is done in
Linear.

## Filtering

The chips and the query box are one request, in the tracker's own dialect. The
line under the controls shows what was actually sent. A qualifier you type
replaces the chip beside it, because sending both would mean one is silently
ignored.

Linear accepts `team:`, `state:`, `status:`, `label:`, `assignee:`, `project:`
and `priority:`. Anything else is matched against titles and descriptions.
`label:` may be repeated, and all of them must hold. `state:` takes `open`,
`closed`, one of Linear's state types (`triage`, `backlog`, `unstarted`,
`started`, `completed`, `canceled`) or the name of a column.

The Open/Closed toggle maps to state types: open is triage, backlog, unstarted
and started; closed is completed and canceled.

Linear pages by cursor and its connection carries no total, so the heading counts
what is on the page rather than everything, and Previous walks back through the
cursors already used. GitHub still pages by number.

## Starting work from a ticket

Linear does not know which repository a ticket belongs to, so the workspace form
asks. Everything else is the same as starting from an issue.

The branch carries the identifier — `agent/eng-123-…` — because Linear's GitHub
integration links a pull request to its issue by branch name, which holds before
any description has been written.

## Linking a pull request back

The ship sheet writes `Closes ENG-123` or `Part of ENG-123` beside any
`Closes #32` for a GitHub issue. Each host ignores the other's line: `#32` is
not an identifier and `ENG-123` is not a number, so both can sit in one body.

`Refs` becomes `Part of`, which is a word Linear reads. A ticket is not
qualified by repository the way a GitHub issue is — the identifier means the
same thing wherever the pull request opens.

None of this does anything unless Linear's own GitHub integration is installed
for that repository at Linear's end. The sheet says so rather than assuming it.

## Rate limits

GitHub's conditional requests do not count against its limit, so looking twice
is free. Linear has no conditional request — it is one POST to a GraphQL
endpoint — but its budget is per person and generous: 2,500 requests and
3,000,000 complexity points an hour for an API key. Queries ask for one page of
the fields a row renders and nothing deeper, because nesting multiplies against
the page size.
