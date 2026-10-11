-- Reading the ledger back at size.
--
-- Its own migration rather than an edit to the one before it: that one had
-- already run, and sqlx checksums what it applied — changing the file after the
-- fact stops the control plane booting with "previously applied but has been
-- modified". A migration is a record of what happened, so it is append-only in
-- the sense that matters.
--
-- ── What these are for ──────────────────────────────────────────────────
--
-- The page groups by one of nine columns and then wants detail — turns,
-- conversations, workspaces, people — for the twenty-five rows it is going to
-- draw. Folding those counts into the grouping meant computing five
-- `COUNT(DISTINCT)` for *every* group: on 2.06 M rows that was 2.4 s against
-- 0.55 s for the sums alone, and the difference was 47,166 answers nobody was
-- ever going to see.
--
-- So the counts are asked per drawn row instead, which is twenty-five lookups
-- by grouping key. These are what make a lookup a lookup rather than a scan.
--
-- `occurred_at` trails rather than leads: `consumption_by_time` already covers
-- "what happened in this period", and these answer "where are this one key's
-- rows inside it".
--
-- `IF NOT EXISTS` because a database that was brought up to date by hand while
-- this was being written already has them.
create index if not exists consumption_by_person
    on consumption_events (org_id, ran_as, occurred_at desc);
create index if not exists consumption_by_model
    on consumption_events (org_id, model, occurred_at desc);
create index if not exists consumption_by_account
    on consumption_events (org_id, account_id, occurred_at desc)
    where account_id is not null;
create index if not exists consumption_by_space
    on consumption_events (org_id, workspace_id);
create index if not exists consumption_by_session
    on consumption_events (org_id, session_id);
create index if not exists consumption_by_repo
    on consumption_events (org_id, repo_remote, occurred_at desc)
    where repo_remote is not null;
