# Profile bundles, as test input

Two sets of the same five profiles, read by the `PROFILE.md` codec's tests in
`crates/ft-server/src/roles/profile_md.rs`.

## `fstack/` — the five real bundles, byte for byte

Copied from [`firetower-cloud/fstack`](https://github.com/firetower-cloud/fstack)
`profiles/` at `bb9a0de`, including the missing trailing newline on each.

**None of the five parses, and that is what they are here to pin.** The format
was specified after these files were written, so they are the first thing it
meets:

| bundle | what it carries | why it refuses |
| --- | --- | --- |
| `designer` | `name`, `description` | `description` is not a profile field. The one line a lead reads is `does` |
| `engineering-manager` | `name`, `description` | the same |
| `engineer` | no frontmatter at all | a bundle needs frontmatter, so there is no `name` and no `does` |
| `qa-engineer` | no frontmatter at all | the same |
| `security-advisor` | no frontmatter at all | the same |

A refusal is the right answer for all five — they are prose that was never
connected to a live profile — so the tests assert the sentence each one gets
rather than trying to make them import. Three of the five have no frontmatter,
which makes "this file is markdown, not a profile bundle" the first thing a
person will hit, and its wording the only thing between them and the
conclusion that the feature is broken.

`#354` is what gives fstack real bundles: it exports the live profiles, whose
`does` is in the database, and fstack commits the result
([`fstack#2`](https://github.com/firetower-cloud/fstack/issues/2)).

## `fstack-repaired/` — the smallest edit that makes each one a bundle

Not from fstack, and not what `#354` will produce. `description:` becomes
`does:` in the two that have frontmatter, and the three that have none gain a
`name` and a `does` taken from what their own body already says. Everything
else is untouched, which is the point: these are **hand-written files with
fourteen of the sixteen fields absent**, so parsing one is the test that an
absent key yields the documented default rather than nothing.

`qa-engineer` is `name: QA`, which is what the live profile is called. A folder
name and a `name` genuinely diverge in real data, and that divergence is
`#355`'s problem rather than the codec's — the fixture carries it so the codec
is never accidentally written to assume they agree.
