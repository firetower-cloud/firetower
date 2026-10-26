-- A picture of a version, so looking at a library stops meaning running one.
--
-- The thumbnail in the library and in the transcript was the artifact itself
-- in an iframe, scaled down: every tile a full page load of its own origin,
-- its own scripts, and the injected picker's layout loop. Six tiles was six
-- programs running behind a grid nobody was interacting with. A poster is the
-- same picture with none of that still happening.
--
-- **On the version, not on the artifact, and that is what makes it correct.**
-- A version is immutable — `20261023120000_artifacts.sql` says so, and
-- `publish_artifact` mints a new row rather than editing this one — so a
-- poster can never be stale for the version it hangs off. A republish produces
-- a version with no poster, which is the signal to take a new one, and the old
-- image leaves with the old row on the cascade that is already there. There is
-- no invalidation to write and nothing to get wrong.
--
-- **Bytes, not base64.** `skills.bytes` and `artifact_files.body` are both
-- `bytea` already; base64 would be a third of the size again for nothing,
-- because what is served is `image/png` either way.
--
-- Nullable on purpose: it is absent until something has rendered the page, and
-- "not photographed yet" is an ordinary state the client draws a placeholder
-- for rather than an error.
alter table artifact_versions
    add column poster    bytea,
    add column poster_at timestamptz;

comment on column artifact_versions.poster is
  'PNG of this version''s entry page, rendered once by a client. Null until taken.';
