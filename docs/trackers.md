# Task trackers

Tasks are read from a tracker as you look at them. Nothing is copied into
Firetower: the one durable fact is which task a workspace was cut from, kept on
the workspace as a key and a URL.

**Every git host is a tracker.** An issue is work to pick up and a request to
merge is work to review, so each one in **Configuration → Git hosts** appears
in the trackers list too — with the same credential, which is the git token
already there. Adding a GitLab adds a place to read work from with nothing more
to connect. See [Git hosts](git-hosts.md).

Linear and Trello are trackers only: no remote, no git username, no device flow.

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

## Connecting Trello

**Configuration → Trackers → Connect**, as for Linear.

Trello wants two things, an app key and a token made for that key. The app key
belongs to the install: set `FIRETOWER_TRELLO_KEY` on the server. Firetower does
not ship one yet, and without a key Trello is not listed at all, because it
would be a row that cannot be connected.

To get an app key for a self-hosted install:

1. Open <https://trello.com/power-ups/admin> and create a new Power-Up. Name it
   anything, pick your workspace, and say it does not use Power-Up
   capabilities, so no iframe connector URL is asked for. (Atlassian's guide
   calls this page the apps admin, `trello.com/apps/admin`.)
2. Open it and go to its API key section (the **Trello Auth** tab in Atlassian's
   guide), then choose **Generate a new API Key**.
3. Set `FIRETOWER_TRELLO_KEY` to that key and restart the server.

Trello then appears in **Configuration → Trackers**. Connecting is one paste:

1. Choose **Get a token from Trello**. The page asks for read access and a token
   that never expires, and carries no return address, so Trello shows the token
   on the page itself.
2. Approve it, copy the token Trello shows, and paste it into the Token field.
   Pasting the whole address, or a `token=` value, works too.

The token is checked against Trello (`/members/me`) before it is stored, and
the account it belongs to is shown back as "as <name>"; one that does not work
is refused rather than kept. A token Trello later revokes answers with the same
sentence wherever it is used.

A token only works with the app key that issued it. Changing
`FIRETOWER_TRELLO_KEY` later means connecting again with a new token.

The token is per person, encrypted in the vault under `tracker/trello`, and
every read is a line in the vault's access log. It is never sent to a worker.
Disconnecting forgets it; revoking it is done in Trello.

Trello's scope is a board: **All boards**, or one of the boards the token can
see.

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

Trello takes `board:`, `list:`, `label:`, `member:` and `is:open` or
`is:archived`. Values with spaces go in quotes, as in `list:"In progress"`, and
`label:` may be repeated. Anything else is matched against card text. Open and
Closed map to `is:open` and `is:archived`, since an archived card is Trello's
closed. **Assigned to me** sends `@me`, which is the owner of the token. With
nothing asked, the search sends `is:open`, because Trello refuses an empty
search. A listing is a call to Trello's search, except a board column with
nothing typed, which reads that list's own cards.

Trello search gives no total and no cursor, only a page number, so a next page
exists whenever a full page came back.

Linear pages by cursor and its connection carries no total, so the heading counts
what is on the page rather than everything, and Previous walks back through the
cursors already used. GitHub still pages by number.

### Board view

On the desktop, picking a board adds a **List / Board** toggle. The board shows
its columns in Trello's order. Each column asks for its Trello list by the
list's id, so it holds exactly the cards of that list. With nothing typed and
Assigned to me off, a column is the whole list in Trello's own order, open or
archived by the state chip, in one page with no Load more.

With something typed, or Assigned to me on, a column is a search for the list
instead and its cards come in search order. Trello's `list:` matches words, not
names, so the answer is checked against the list's id, the one place Firetower
filters what Trello returned. A `list:` typed in the box still replaces the
column's name in that search, so each column then shows only its own cards among
the matches. The Load more button follows whether a full page came back from
Trello.

## Starting work from a ticket

Linear does not know which repository a ticket belongs to, so the workspace form
asks. Everything else is the same as starting from an issue.

The branch carries the identifier — `agent/eng-123-…` — because Linear's GitHub
integration links a pull request to its issue by branch name, which holds before
any description has been written.

A Trello card works the same way. The branch carries the card's short link,
for example `agent/ab3de9fg-fix-export`, and the workspace form asks for a
repository because a card does not belong to one.

A card's attachments come along. Pictures ride in the first message, so the
agent looks at the screenshot on the card. Other files are placed in the
workspace. Links, such as a Google Doc or a Figma frame, are written under the
description as "Links on the card". Each file shows as a chip before you press
send, and you can remove any of them. The limits are the same as dropping a
file on the composer: images up to 5 MB, everything else up to 25 MB, ten files
at a time. A file that cannot be brought says so on its chip and never stops
the workspace from starting.

Trello asks for your token even to download an attachment, so the file comes
through Firetower, which only downloads an attachment that is listed on that
card.

## Linking a pull request back

The ship sheet writes `Closes ENG-123` or `Part of ENG-123` beside any
`Closes #32` for a GitHub issue. Each host ignores the other's line: `#32` is
not an identifier and `ENG-123` is not a number, so both can sit in one body.

`Refs` becomes `Part of`, which is a word Linear reads. A ticket is not
qualified by repository the way a GitHub issue is — the identifier means the
same thing wherever the pull request opens.

None of this does anything unless Linear's own GitHub integration is installed
for that repository at Linear's end. The sheet says so rather than assuming it.

For a Trello card the ship sheet writes
`Trello: https://trello.com/c/<shortLink>` in the pull request body. It is a
link to the card, not a keyword Trello acts on.

## Dialects

GitHub takes one search string and the query box is passed to it verbatim.
GitLab takes structured parameters and a plain search term, so the chips become
fields and the qualifiers people already type are read where they mean the same
thing — `is:open`, `assignee:ana`, `label:bug`, plus GitLab's own `state:` and
`labels:`. Gitea takes one free-text term and no qualifiers. In all three the
line under the controls shows what was actually sent.

Trello takes one search string with its own qualifiers, described under
Filtering. Its search index can lag behind a card you just edited.

## Rate limits

GitHub's conditional requests do not count against its limit, so looking twice
is free. Linear has no conditional request — it is one POST to a GraphQL
endpoint — but its budget is per person and generous: 2,500 requests and
3,000,000 complexity points an hour for an API key. Queries ask for one page of
the fields a row renders and nothing deeper, because nesting multiplies against
the page size.

Trello allows 100 requests per 10 seconds per token. A listing with no column
is one search, so a page costs one request, whether or not a board is picked. A
searched column (something typed, or Assigned to me) costs two: the list's name,
then the search. The board view asks once for the columns and then, per column,
for the list's name and its cards at the same time, so a board with six columns
costs thirteen requests when the question changes. Opening a card to start work
from it costs one more, for its attachments, and each attachment brought along
costs two: the card's attachment list, then the file. The
server logs the remaining count at debug level.
