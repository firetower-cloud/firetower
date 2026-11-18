# Reference copies — never merged

Two Firetower artifacts, copied here so an agent working in its own workspace can read them.
Artifacts live outside git by design, which means they are invisible to every session except the
one that made them — and the four UI tickets on the shipping-metrics chain all need the prototype.

- **`dora-prototype.html`** — the approved prototype from #406. The proposed page, the current
  telemetry page rebuilt beside it, and a specification view carrying component decomposition,
  interaction specs, responsive behaviour and states. Deep links: `#view=spec`, `#w=420`, `#dark`,
  `#stale`, `#fail`.
- **`dora-spec.html`** — the approved specification from #429, tagging every statement decided,
  proposed or unresolved.

**This branch is never merged.** Open the files from a checkout of it, or with
`gh api repos/firetower-cloud/firetower/contents/docs/reference/dora-prototype.html?ref=reference/dora-prototype`.

The canonical versions are the Firetower artifacts `dora-dashboard` and `dora-spec`. If those are
republished, these copies go stale — check the issues before trusting a detail that matters.
