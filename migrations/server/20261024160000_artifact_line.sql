-- Where in the conversation an artifact appeared.
--
-- The card was placed by searching the transcript for a tool call naming the
-- artifact's folder, which cannot work: an agent refers to a file however it
-- likes. One real session did
--
--   cd …/.firetower/artifacts && cp firetower-architecture/index.html \
--        firetower-architecture-copy/index.html
--
-- so the full path appears nowhere in the log at all, the card found no
-- anchor, and it sat at the bottom of the conversation forever.
--
-- A line number is not a guess. `agent_lines` is the agent's own log, and the
-- last line at the moment of publishing is exactly the point the conversation
-- had reached. Stamped once, on the first publish, so the card stops where it
-- started rather than following later edits down the page.
alter table artifacts add column first_seen_line bigint;

comment on column artifacts.first_seen_line is
  'Last agent_lines.line_no in the producing session when this was first published. Null for artifacts that predate the column, which fall back to the end of the transcript.';
