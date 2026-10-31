-- An artifact filed somewhere shared outlives the person who made it.
--
-- `owner_id` was `on delete cascade`, from before artifacts had a path: the
-- owner was the only answer to "whose is it", so a person going took theirs
-- with them. Since `20261024120000_artifacts_filed.sql` the path answers that,
-- and filing one into `d/<team>` changes the path and not `owner_id`. The
-- cascade kept firing anyway, so deleting somebody destroyed every artifact
-- they ever published — including the ones they had handed to a team, which
-- `docs/artifacts.md` ("Every way an artifact can die") says survive.
--
-- Null rather than cascade, as `created_by` already is. What is still at
-- `u/<them>/…` is deleted explicitly by `delete_user_in`, alongside their
-- machines and secrets, which is the rule for everything personal.
--
-- The only reader of `owner_id` is the republish lookup, which matches on the
-- publisher's own id and so never meets a null.

alter table artifacts alter column owner_id drop not null;

alter table artifacts drop constraint artifacts_owner_id_fkey;
alter table artifacts
    add constraint artifacts_owner_id_fkey
    foreign key (owner_id) references users(id) on delete set null;
