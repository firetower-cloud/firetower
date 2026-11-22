-- Plugins: one bundle that may hold several components, and a connector's
-- endpoint.
--
-- **These are the skills tables, extended, rather than a second set beside
-- them.** A plugin and a skill are both a named bundle of files with versions,
-- content-addressed blobs, per-session pins, an `ltree` path, `extra_perms`
-- and a risk scan — and every one of those already works here, including the
-- import validator and the libyaml oracle behind it. Forking the schema would
-- buy a word and cost that apparatus twice.
--
-- **Two tables this deliberately does not add.**
--
-- There is no `user_plugins`: "always on" is already `skill_defaults` with a
-- null `repo_id`, which the picker, `defaults_for` and the toggle on every
-- row all read today. A plugin is a row in `skills`, so it inherits that for
-- nothing. The slice that deletes per-repository defaults replaces both at
-- once, and until then a second list would be a second answer to one question.
--
-- And there is no `skill_components`: what is inside a bundle is derivable
-- from the paths in `skill_files` — `skills/<name>/SKILL.md` is a skill,
-- `commands/<name>.md` is a command, `.mcp.json` is a connector. Deriving it
-- cannot drift from the bytes, and a stored copy can.
--
-- **The tables keep the word `skills` while the product says "plugin".** That
-- is a deliberate debt, taken to ship: renaming is mechanical — sqlx's
-- compile-time checking finds every call site — and it belongs in its own
-- commit once nothing else is moving.

-- What a bundle is, which decides where on a worker it is written. 'skill' is
-- every row that exists today and keeps its behaviour byte for byte.
--
-- Measured, and the reason this is a column rather than a convention: a folder
-- without `.claude-plugin/plugin.json` loads nothing through Claude Code's
-- `--plugin-dir`, and a lone skill wrapped in a same-named plugin registers as
-- `name:name`. The two are different places, not one expressed as the other.
alter table skills
    add column kind text not null default 'skill'
        check (kind in ('skill', 'plugin'));

create index skills_by_kind on skills (org_id, kind);

-- A connector's endpoint, and how it wants to be authorized.
--
-- **The credential is never here, and never in the bundle either.** The
-- `.mcp.json` a worker writes is synthesised at the moment a session starts,
-- from this row plus that person's own token — so no stored byte ever holds a
-- secret and a bundle on disk cannot outlive the authorization it was written
-- with.
create table connectors (
    skill_id text primary key references skills(id) on delete cascade,
    -- The key this server has in `.mcp.json`, which is what the agent calls it.
    server   text not null,
    url      text not null,
    -- 'borrow-git' is the one that needs no new authorization code: this
    -- server's own authorization server is one Firetower already holds a token
    -- from, so the token at `git/<borrow>/<owner>` is the bearer. Measured:
    -- GitHub's MCP server names `github.com/login/oauth` as its authorization
    -- server, which is the application Firetower already registered.
    -- 'oauth' is the general case and arrives with the broker.
    auth     text not null check (auth in ('none', 'borrow-git', 'oauth')),
    -- Which kind of git host's token to borrow, when `auth = 'borrow-git'`.
    borrow   text,
    scopes   text
);
