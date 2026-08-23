-- What a structured agent printed, exactly as it printed it.
--
-- This is the durable record of a conversation, and it is deliberately raw.
-- What the interface draws is derived from these lines when somebody asks for
-- it, rather than stored alongside them, for one reason worth the recompute:
-- reading an agent's output means guessing at a format that is somebody else's
-- to change, and storing only the guess makes a wrong one permanent. Keep the
-- lines and a bad mapping is a deploy — the whole history re-derives.
--
-- The worker holds the same lines in a file in the workspace. Neither copy is
-- a cache of the other: the worker's is what survives a control plane being
-- away, this one is what survives the workspace being destroyed.
CREATE TABLE agent_lines (
    session_id  TEXT        NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- Position in the agent's own log, counted from one. This is the resume
    -- cursor, and it is the worker's numbering rather than ours so that both
    -- ends agree on what has already been seen.
    line_no     BIGINT      NOT NULL,
    line        TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A worker replays from a cursor after a reconnect, so the same line
    -- arriving twice is ordinary rather than exceptional.
    PRIMARY KEY (session_id, line_no)
);

-- Every read is "this session, in order, from here" — either the whole
-- conversation for somebody opening it, or the tail for somebody catching up.
CREATE INDEX agent_lines_session_line ON agent_lines (session_id, line_no);
