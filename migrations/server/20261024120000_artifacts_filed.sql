-- Artifacts become Placed.
--
-- Until now an artifact was keyed on `owner_id`, which answers "whose is it"
-- and nothing else: no filing, no directories, no way to let a colleague see
-- one. A path answers all three at once, because `access::filed_where` is
-- already the only definition of "may see this" and it reads a path.
--
-- `paths-and-ownership.md` §2 is the test for whether a thing should have one.
-- An artifact passes it: it is owned, it can be handed over by filing it
-- somewhere shared, and it outlives the work that made it. That is Placed.

alter table artifacts
    add column path        ltree,
    add column extra_perms jsonb not null default '{}',
    add column created_by  text references principals(id) on delete set null;

-- Born at the owner's own root, which is where every Placed thing starts.
-- `u.<slug>.<artifact slug>` — the same shape skills and workspaces use, and
-- the only one `ft_core::ResourcePath` will write.
update artifacts a
   set path = ('u.' || p.slug || '.' || a.slug)::ltree,
       created_by = a.owner_id
  from principals p
 where p.id = a.owner_id;

-- Any row whose owner has no principal left has nowhere to live. There should
-- be none — `owner_id` references `users` and a user is a principal — but a
-- `set not null` that fails on a customer's database at upgrade time is a
-- worse way to find out.
delete from artifacts where path is null;

alter table artifacts alter column path set not null;

create unique index artifacts_by_path on artifacts (path);
create index artifacts_path_tree on artifacts using gist (path);
create index artifacts_extra_perms on artifacts using gin (extra_perms);

-- The owner-scoped index is the wrong shape now. Two people can each have a
-- `pricing`, and once one of them files theirs into a directory the pair is
-- distinguished by path rather than by owner.
drop index if exists artifacts_slug;
