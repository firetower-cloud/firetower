-- A profile's name is one profile within the directory it is filed in.
--
-- **Why a name needs holding at all.** Agent teams names its members by
-- `directory/name` in a file checked into a repository, and that reference is
-- only stable if `platform/engineer` can mean one profile. `roles.name` is
-- prose with nothing on it today, so a second `Engineer` filed beside the
-- first silently breaks every team file that named the first — and the fault
-- is already live without any team file at all: `delegate.rs`'s
-- `profile_named` has to refuse "that is the name of more than one profile you
-- can reach, nothing was changed", because `update_profile` otherwise rewrote
-- whichever row Postgres returned first.
--
-- **Scoped to the directory, never to the installation.** Two reasons, and
-- neither is about tidiness:
--
-- 1. A person's own space is theirs alone. Global uniqueness would let a
--    stranger's private `Reviewer` decide what somebody else may call theirs,
--    and two people each having a `Reviewer` is the ordinary case rather than
--    a clash.
-- 2. "That name is taken" is an enumeration oracle: it tells the asker that
--    something exists in a place they cannot see. The import resolves names
--    only across what the asker can already reach for exactly this reason
--    (#354), and this must not undo it. Scoped here, everything a refusal can
--    name is already filed where the person asking is writing.
--
-- `subpath(path, 0, 2)` is the **permission root**, which is what "the
-- directory it is filed in" means: `u.kevin` for a personal profile,
-- `d.platform` for one filed in a directory.
--
-- `roles_author_key`, beside this one, scopes a key to `subpath(path, 0,
-- nlevel(path) - 1)` — the parent — and the two agree on every row that
-- exists: a profile's path is three labels, `create_in` builds it from one
-- leaf and `ResourcePath::moved_to` keeps everything after the root, so the
-- parent *is* the root. The root is spelled here because it is the one that
-- stays right if a profile ever gains a deeper name:
-- `d/platform/team/engineer` is filed in `platform`, full stop
-- (`docs/paths-and-ownership.md` §1), and a team file naming
-- `platform/engineer` has to mean that profile.
--
-- `lower(btrim(...))` is the comparison. Case-insensitive, because `Engineer`
-- and `engineer` are one name to whoever reads the list and to a file naming
-- one; `btrim` because every write path already trims and a row that predates
-- one should not be able to hide behind a space. Both functions are immutable,
-- which is what lets this be an index rather than a trigger.

-- ── the duplicates that already exist ──────────────────────────────────
--
-- There is no index to add without first deciding what happens to an
-- installation that has two `Engineer`s in one directory already, and the
-- answer is **suffixed here, not left to fail at the next write**. The
-- alternatives were both worse: moving one out of the directory is an
-- unconsented transfer of somebody's work, and deleting one destroys it. A
-- rename is visible on the Profiles screen, loses nothing, and leaves both
-- profiles usable.
--
-- **The oldest keeps the name it had.** Whatever already points at that name —
-- a lead spawning by name, somebody's muscle memory — most likely means the
-- one that has been there longest, so the numbering runs by `created_at` and
-- only ever renames the newcomers.
--
-- Two passes, and the second is why this cannot fail. The first takes the
-- readable number where it is free. The second takes whatever is left and puts
-- the row's own discriminator on the end — the same eight characters of the id
-- that `slug_of` appends, which nothing can collide with. `delete_user` sweeps
-- machines in the same two passes for the same reason: a migration that dies
-- on a name collision is an installation that cannot be upgraded.
--
-- `left(..., 63 - length(n.row::text))` keeps the result inside the 64
-- characters `roles::check` accepts. A name longer than that could not be
-- saved again, so a migration that produced one would leave a profile nobody
-- can edit without first renaming it.

-- Pass one: ` 2`, ` 3`, … where that name is free in the same directory.
update roles r
   set name = left(btrim(r.name), 63 - length(n.row::text)) || ' ' || n.row
  from (select id,
               row_number() over (partition by subpath(path, 0, 2),
                                               lower(btrim(name))
                                      order by created_at, id) as row
          from roles) n
 where n.id = r.id
   and n.row > 1
   and not exists (select 1
                     from roles o
                    where o.id <> r.id
                      and subpath(o.path, 0, 2) = subpath(r.path, 0, 2)
                      and lower(btrim(o.name))
                          = lower(left(btrim(r.name), 63 - length(n.row::text))
                                  || ' ' || n.row));

-- Pass two: whatever is still doubled — a directory that already held an
-- `Engineer 2` of its own — takes the id instead. The window is recomputed, so
-- this only sees rows pass one left alone, and the oldest is still spared.
update roles r
   set name = left(btrim(r.name), 55) || ' ' || right(r.id, 8)
  from (select id,
               row_number() over (partition by subpath(path, 0, 2),
                                               lower(btrim(name))
                                      order by created_at, id) as row
          from roles) n
 where n.id = r.id
   and n.row > 1;

-- `if not exists` so that the two passes above can be replayed against a
-- database this has already run on, which is what the test that proves the
-- renaming does covers.
create unique index if not exists roles_name_in_directory
    on roles (subpath(path, 0, 2), lower(btrim(name)));
