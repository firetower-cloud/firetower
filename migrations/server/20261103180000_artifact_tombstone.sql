-- A deleted artifact leaves a tombstone, not an empty slot.
--
-- The agent's folder under `.firetower/artifacts/` outlives the delete, and
-- the auto-publisher — the desktop watcher and the hand-back capture both —
-- would recreate the artifact from it within seconds, so a deleted one came
-- straight back. A delete now marks the row `deleted_at` and frees its bytes
-- rather than removing the row, and `publish_artifact` refuses a slug that is
-- tombstoned. Deletion is final even while the folder is still on disk.
alter table artifacts add column deleted_at timestamptz;
