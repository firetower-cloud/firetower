-- The key the author of a profile gave it: the name of the folder its
-- `PROFILE.md` sits in.
--
-- This is the one schema change `profiles-as-code` costs, and the earlier claim
-- that it cost none is withdrawn rather than quietly dropped. The format needs
-- an identity that **the author** controls and that survives a rename, because
-- that is what makes one committed file describe one profile on every
-- installation. `name` cannot be it — it is prose, freely edited, and a rename
-- would read as a new profile — and `slug` cannot be it either:
--
--     slug = <name>-ified + '_' + the last eight characters of the row's id
--
-- The discriminator is what lets two people each have a `Designer` without
-- colliding on the path's own uniqueness (`roles_by_path`), which makes a slug
-- deterministic *for this installation* and useless as anybody's identity: the
-- same file imported twice, or imported here and on a colleague's machine,
-- produces two different slugs. So the key gets a column of its own.
--
-- **Null on every existing row, and that is the whole of the compatibility
-- story.** No backfill: there is nothing to put in it. A row that predates the
-- format has no author's key, because nobody wrote a file for it — and the null
-- is not a gap to be filled in by guessing, it is what makes the first import's
-- fallback necessary. The plan (#355) matches a dropped bundle against a
-- keyless row **by name**, proposes the match, and lets the person confirm it;
-- the apply (#356) is what writes the key onto the row they confirmed. Guessing
-- here instead would be this migration deciding that `qa-engineer/` is the
-- library's `QA`, which is exactly the judgement the review exists to put in
-- front of somebody.
--
-- Nullable rather than `not null default ''`: "no key yet" and "the empty key"
-- are different facts, the first is every row today, and a unique index over
-- the second would make two keyless profiles in one directory impossible.
alter table roles add column author_key text;

-- Unique **within the parent path**, which is the scope a person reads a
-- library in.
--
-- Not per installation: two people each dropping a `designer/` bundle is the
-- ordinary case, and their profiles land at `u.kevin.*` and `u.ana.*`, so the
-- parent is what distinguishes them. Not per organisation either, for the same
-- reason. `subpath(path, 0, nlevel(path) - 1)` is everything but the leaf —
-- `u.kevin` for a personal profile, `d.fstack` for one filed in a directory —
-- and both ltree functions are immutable, which is what lets this be an index
-- rather than a trigger.
--
-- Partial, because `null` is the common value and Postgres treats nulls as
-- distinct in a unique index anyway: every keyless row would be accepted with
-- or without the `where`, and leaving them out keeps the index to the rows that
-- actually carry a key.
--
-- **One consequence, named here because it is easy to find out the hard way:**
-- a profile carrying a key cannot be *moved* into a directory that already
-- holds one of the same key — this index refuses it, and
-- `access::transfer` has no sentence for that yet. It cannot bite until
-- something writes a key, which is #356; whoever lands that owes the sharing
-- path a readable refusal.
create unique index roles_author_key
    on roles (subpath(path, 0, nlevel(path) - 1), author_key)
 where author_key is not null;

comment on column roles.author_key is
  'The folder name of the PROFILE.md this profile was imported from: the key its author gave it. Null for every profile made in the interface. Unique within the parent path, never globally — see roles_author_key.';
