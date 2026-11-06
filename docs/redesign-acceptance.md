# The desktop redesign — acceptance criteria

What "done" means for the build described in `design-handoff.md` and drawn in
`prototypes/redesign/`. Each criterion is numbered and independently testable,
because QA tests against this list and a criterion nobody can fail is not one.

The artifact is the target for anything visual. Where the build cannot match it,
that is a finding to report, not a licence to reinterpret.

**Scope.** The whole desktop client, phases 0 through 5. Nothing is shown for
review until all of it stands up; the phases are a build order, not releases.

---

## Phase 0 — both themes

**Light and dark are both shipped, and both are first-class.** Light is the
design and dark follows from it; neither is a follow-up to the other. This phase
builds the token system the rest of the work stands on, so it has no new screens
of its own — but it is not "dark, plus light later".

1. With `data-theme` absent or `dark`, every screen is pixel-identical to the
   pre-change build. This is a regression guard, not the goal: dark must not
   drift while light is being added.
2. `[data-theme="light"]` renders **every** screen correctly — not merely without
   errors. Every surface, border, text tier, signal, file kind, chart series and
   syntax colour resolves to its derived light value, with no fallback and no
   token inherited from the dark branch by accident.
3. A theme control exists and is reachable from the profile menu, offering
   **System, Light and Dark**. It defaults to System, follows
   `prefers-color-scheme` when set there, and the choice survives a restart.
4. `--color-amber-soft` and `--color-ember-ink` exist in both branches, with the
   values and derivations recorded in `design-handoff.md` §4.
5. `just check-style` scans `desktop/src` as well as `web/` and `mobile/`, and
   passes.
6. `just gen` is clean. `web/` and `mobile/` render unchanged — the token sheet is
   shared, so adding the light branch must not move either client until it opts
   in.

## Phase 1 — the shell

7. The rail is 62px, with six destinations and two settings doors below a rule.
8. `⌘1`–`⌘6` reach the six destinations. `⌘,` reaches Settings.
9. A destination's panel previews on hover **and on keyboard focus**; clicking
   pins it. Nothing in the rail is reachable only by pointer.
10. `⌘\` collapses and restores the panel.
11. The current Firetower's organisation and username are readable as text, in a
    fixed position, on every screen, with no hover and no click.
12. The switcher under the avatar lists every connected Firetower with its
    reachability. Unreachable is dimmed and dashed, never red, and its rows do
    not disappear.
13. Two organisations whose names share a first letter render distinguishable
    marks. `fleet.ts:49`'s `org.slice(0,1)` is replaced.
14. `Fleet.tsx` and the `/fleet` route are gone, and no navigation reaches a dead
    route.
15. The dock badge and the island still count waiting agents across **every**
    connected Firetower, unchanged.
16. `ServerStrip.tsx` is gone and the `"all"` scope is removed, including the
    `firetower.scope` localStorage key.

## Phase 2 — the Dashboard

17. The headline states how many agents are waiting, as a sentence.
18. Each waiting item shows the agent's actual question at reading size.
19. No more than three ember instances are on screen at once in the busiest
    state; exactly one in the calm state.
20. The composer's shelf carries the repository and the machine; its footer
    carries the profile and the agent.
21. A workspace's composer has **no** shelf — those choices are settled there.
22. `/new` is merged into the Dashboard. Navigating to `/new` does not 404.
23. When another Firetower has waiting work, one line names it and offers to
    switch.
24. Three states render: waiting, calm, and nothing started yet.

## Phase 3 — the workspace

25. The conversation is the first tab, is pinned, and cannot be closed.
26. A single click previews a file in italic and the next preview replaces it; a
    double click keeps it.
27. The active tab is marked along its top edge.
28. Code scrolls horizontally and never wraps.
29. The gutter marks lines this session wrote, and the header's touched count is
    clamped to the file.
30. Selecting code opens a note anchored to the selection, flipping above when
    there is no room below. A kept note becomes a gutter marker.
31. The right rail opens on this workspace's overview and team, not the inbox.
32. `⌘J` opens the terminal. `⌘K` clears inside the terminal and opens the
    palette everywhere else.

## Phase 4 — configuration, in its new homes

33. Customize holds Skills, Agent profiles and Agents, each reachable by clicking
    the thing itself rather than only a menu.
34. Sources holds Repositories, Git hosts, Machines and Trackers.
35. Settings holds People, Teams, Directories, Vault and This Firetower.
36. People and Teams draw no invite, role, disable or delete control — and no
    disabled control either. Each says where that work is done.
37. Connecting a git host supports GitHub, GitLab and Gitea, each with its own
    token page and scopes. No provider picker; the address decides.
38. Adding a machine shows the key, probes, and creates only once something
    answered. A failure shows the server's own diagnosis.
39. Opening a profile you may read but not edit draws no disabled controls.

## Phase 5 — the remainder

40. `⌘K` opens the palette. `Palette.tsx` is referenced and rendered — today it is
    imported by nothing.
41. `⌘N` starts a new workspace. `Rail.tsx:87` and `:446` advertise it today and
    nothing binds it.
42. Artifacts render as poster images in every list and grid. No live frame is
    mounted outside the artifact viewer. The "no poster yet" state is drawn.
43. A skill opens with its Details, Bundle, Versions and Defaults tabs, and both
    create flows land in the held-for-review state rather than a second concept.
44. Updates reads by default; controls appear only for whoever may act, and a
    machine someone does not administer is listed and dimmed with the reason.
45. First run covers address, looking, no answer, not a Firetower, sign in,
    replace password, name it and set up.
46. `Account.tsx:65`'s must-replace-password banner uses amber, not ember.

## Cross-cutting — true of every screen

47. No ALL-CAPS eyebrow appears anywhere.
48. No list row carries a branch in monospace at rest.
49. Every pane renders its empty, loading, error, refused and server-dark states.
50. No contrast failure in either theme, measured, including the file kinds, the
    chart series and the seven syntax colours.
51. `prefers-reduced-motion` collapses durations and holds the ember at full
    scale; `prefers-reduced-transparency` makes the floating panel opaque.
52. `git diff --stat <base> -- api/ crates/ migrations/` is empty. `just gen-check`
    is green against the **deployed** server's `openapi.json`. No query hook is
    used that is not in the current generated client.
53. The app still runs against a control plane at `MIN_SERVER` (`0.34.1`).
