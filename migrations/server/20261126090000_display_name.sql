-- A name for people, beside the name for machines.
--
-- `skills.name` is what an agent sees and what somebody types as a command, and
-- `marketplace_entries.slug` is a folder on disk — both are constrained to
-- lowercase and hyphens, so the library has been drawing `cal-com` and
-- `hugging-face` at people. Those cannot be derived from each other either:
-- title-casing the slug gives "Cal Com", and no rule turns `fal` into `fal`
-- while turning `workos` into `WorkOS`. So it is carried, not computed.
--
-- Nullable on purpose. A catalogue nobody here wrote does not have to supply
-- one, and an entry without one falls back to a title-cased slug — which is
-- right for most names and never worse than the slug itself.
alter table marketplace_entries add column display_name text;
alter table skills add column display_name text;
