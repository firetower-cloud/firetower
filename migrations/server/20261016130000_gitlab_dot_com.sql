-- ── gitlab.com, shipped like github.com ─────────────────────────────────
--
-- Firetower registered an OAuth application on gitlab.com as well, so a fresh
-- install can authorize it in a browser with nothing to register — the same
-- deal github.com already had. A row that exists is also the only place the
-- product says GitLab is supported at all: the add screen lists what can be
-- added, and the hosts list lists what is there, and before this neither of
-- them mentioned GitLab until somebody went looking.
--
-- `builtin` is the thing that decides whether Firetower's own application
-- applies — see `Connection::shipped_client_id`. Anything an administrator
-- adds afterwards is theirs, and is asked for its own client id, because:
--
--   * an application they registered carries *their* name on the approval
--     screen, which is the thing an organization reviewing third-party
--     applications is actually looking at; and
--   * GitHub allows 50 authorizations an hour per application, shared by every
--     installation using it — so a deployment adding several of its own
--     accounts under ours would be queueing behind strangers.
--
-- Skipped where somebody already added one by hand, which this branch's own
-- testing did: the unique constraint is (kind, git_host, label), and a second
-- row for the same instance would be a second thing to pick between with no
-- difference anybody could see.
insert into git_connections
    (id, kind, label, base_url, api_base, git_host, auth, builtin, position)
select 'gitlab', 'gitlab', 'GitLab', 'https://gitlab.com', 'https://gitlab.com/api/v4',
       'gitlab.com', 'device', true, 1
where not exists (
    select 1 from git_connections where kind = 'gitlab' and git_host = 'gitlab.com'
);
