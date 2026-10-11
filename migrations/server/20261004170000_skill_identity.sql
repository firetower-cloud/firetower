-- Telling one skill from another, and one version of it from the next.
--
-- Dropping the same folder twice made two library rows that meant the same
-- thing. The bytes cost nothing — they are content-addressed, so the second
-- import stored none of them — but two rows called `frontend-design` is a
-- library nobody can read and a name the picker cannot resolve.
--
-- Two things fix it, and only one of them is a rule about people.

-- ── a fingerprint for a bundle ────────────────────────────────────────
--
-- Over the *manifest* — every path, the hash of its contents, and whether it
-- runs — rather than over the bytes, which are already hashed one file at a
-- time. So this is derivable from rows that exist, and the backfill below
-- reads no file contents at all.
--
-- The format is pinned on both sides and has to stay that way: `path:hash:1|0`
-- per file, joined with commas, sorted by path in C collation so that
-- Postgres and Rust agree about order. `sha256` is built in; `md5` would have
-- done but the blobs are sha256 and one hash in a schema is easier to reason
-- about than two.
alter table skill_versions add column digest text;

update skill_versions v
   set digest = m.digest
  from (
        select f.version_id,
               encode(sha256(convert_to(
                 string_agg(f.path || ':' || f.hash || ':' ||
                            case when f.executable then '1' else '0' end,
                            ',' order by f.path collate "C"),
                 'UTF8')), 'hex') as digest
          from skill_files f
         group by f.version_id
       ) m
 where m.version_id = v.id;

create index skill_versions_by_digest on skill_versions (digest);

-- ── one name per owner ────────────────────────────────────────────────
--
-- A name is what the agent answers to and what somebody types, so two skills
-- sharing one inside a single person's space cannot both be used and cannot be
-- told apart. Across *different* owners it has to stay legal: two people may
-- both have a `code-review`, and neither can see the other's.
--
-- The first two labels of the path are the owner — `u.kevin`, `d.backend` —
-- which is the same subpath the access check uses, and the only part of a
-- path that decides anything.
--
-- Existing collisions are renamed rather than deleted. The rows are a
-- person's own work and a migration is not the place to decide which copy
-- they meant to keep; the oldest keeps the name, the rest are suffixed so they
-- can be told apart and removed by hand.
with ranked as (
    select id,
           name,
           row_number() over (partition by org_id, subpath(path, 0, 2), name
                                  order by created_at, id) as n
      from skills
)
update skills k
   set name = ranked.name || '-' || ranked.n
  from ranked
 where ranked.id = k.id
   and ranked.n > 1;

create unique index skills_one_name_per_owner
    on skills (org_id, subpath(path, 0, 2), name);
