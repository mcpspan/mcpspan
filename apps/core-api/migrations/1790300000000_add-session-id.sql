-- Up Migration

-- The connection a call arrived on, as a random identifier made by the SDK.
--
-- Nullable: calls recorded through track() alone, and by SDKs from before
-- sessions, have none, and are simply left out of the session views.
--
-- Deliberately no index of its own. One on (server_id, session_id,
-- occurred_at) would add about fifty bytes to every row of the busiest table,
-- around four gigabytes at ninety days of ten calls a second, to serve a view
-- that already knows when a session started and ended and can ask the
-- existing (server_id, occurred_at) index for just that span.
ALTER TABLE tool_calls ADD COLUMN session_id uuid;

-- Down Migration

ALTER TABLE tool_calls DROP COLUMN session_id;
