# Which surface a feature belongs on

There are four: the **desktop app**, the **administration site**, the **mobile
app**, and the **CLI**. This is the rule for deciding where something new goes,
written down because it was re-derived three times and came out differently
each time.

## The rule

> **Bound to you → desktop. Bound to the organisation → the web.**

The desktop is this Firetower *seen from where one person sits*: their machines,
their credentials, their workspaces, the things they can reach. The
administration site is the installation *as an institution*: who exists, what
they may be, how they authenticate.

Two corollaries, both of which have been got wrong:

* **Inline creation is fine for things shaped like the work, never for things
  shaped like the organisation.** The sharing sheet makes a directory without
  leaving, because a directory exists to hold the thing being filed and is
  meaningless without it. It does not make a team or a person, because both
  outlive every resource they were ever granted on. Saving a file may create a
  folder; it may not create an employee.

* **The subject decides, not the audience.** A repository is organisation-scoped
  as a record — one row, one setup script, one mirror — but what opens it is the
  token of whoever is asking, so it is a thing you work *with* and it lives on
  the desktop. That an administrator can *see* every machine does not make
  machines administrative.

## Where things landed

| | Desktop | Web |
|---|---|---|
| Workspaces, sessions, tasks | **own** | — |
| Machines, agents, repositories, integrations, vault | **own** | — |
| Sharing one resource; exceptions on it | **own** | — |
| Directories, and grants on them | **own** | — |
| Teams — granting one access | **own** | — |
| Teams — who is in one | read | **own** |
| People — who exists | read | **own** |
| Invite, roles, disable, delete | — | **own** |
| SSO, password policy, trusted proxy, deployment settings | — | **own** |
| Download the app, first boot, sign in | — | **own** |
| A forgotten password | — | — (the CLI: `firetower passwd`) |

Mobile reads and starts work. It writes no access of any kind.

## Two things this rule is not

**It is not a security boundary.** A desktop that does not draw *make
administrator* does not stop anybody calling `PATCH /api/v1/users/{id}`. Every
one of these endpoints enforces its own rule server-side and must carry on doing
so, whatever the screens look like.

**It is not a reason to write anything twice.** The two clients pin the same
React, the same query client and the same icons, and ship thirteen identically
named UI components each; `filing.ts` exists in both and has already drifted.
Where a thing genuinely belongs on both surfaces, the answer is one component
imported twice — `desktop/src/shims/next-navigation.ts` exists so web-shaped
components run in the Tauri window — not two implementations kept in step by
discipline.

## The link out

The desktop links to the administration site at **the base address and nothing
after it**. Linking at a page would make the app depend on the web's route
structure, which is a contract nobody agreed to keep. `backend.url` is already a
resolved origin — `probe.ts` tries the schemes when connecting and stores only
the one that answered — and it is parsed again before the link is drawn, because
a URL from an older build should not produce a button that goes nowhere.

Shown to administrators only. Sending a member to a screen that will refuse them
is the same mistake as drawing a control the server will not honour.
