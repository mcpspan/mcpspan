-- Up Migration

-- Removing a server used to delete its tool calls but leave its resource
-- calls, prompt calls and tool listings behind, out of reach of every page
-- but still on disk. Removing a server now takes all of them; this clears
-- what earlier removals left.
--
-- The hourly rollups are not rebuilt here, since a rebuild cannot run inside
-- the transaction a migration runs in. What they still hold for such a server
-- is counts by name, which no account can reach either.
DELETE FROM tool_calls WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM resource_calls WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM prompt_calls WHERE server_id NOT IN (SELECT id FROM servers);
DELETE FROM tool_listings WHERE server_id NOT IN (SELECT id FROM servers);

-- Down Migration

-- Nothing to put back: the rows belonged to servers that no longer exist.
