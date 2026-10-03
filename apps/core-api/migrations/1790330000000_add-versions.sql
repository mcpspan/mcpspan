-- Up Migration

-- The version the server gives itself, and the version the client gives
-- itself, as each says in its handshake. Both optional: SDKs from before
-- they were recorded send neither, and a server or client that names no
-- version has none.
--
-- On the raw tables only. The hourly rollups are grouped by name and client,
-- and a version is a question about a window of raw calls - which version was
-- running, and how it compared - that the raw rows answer for as long as they
-- are kept.
ALTER TABLE tool_calls ADD COLUMN server_version text, ADD COLUMN client_version text;
ALTER TABLE resource_calls ADD COLUMN server_version text, ADD COLUMN client_version text;
ALTER TABLE prompt_calls ADD COLUMN server_version text, ADD COLUMN client_version text;

-- When each server version was first and last seen, kept up to date as calls
-- arrive. The dashboard marks where a version started on its charts; finding
-- that in the raw rows would mean reading every call since the one before,
-- on every page load. A row per version is a few dozen bytes, and outlives
-- raw retention, so a version first seen long ago is still known as old.
CREATE TABLE server_versions (
  server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  version text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (server_id, version)
);

-- Down Migration

DROP TABLE server_versions;

ALTER TABLE tool_calls DROP COLUMN server_version, DROP COLUMN client_version;
ALTER TABLE resource_calls DROP COLUMN server_version, DROP COLUMN client_version;
ALTER TABLE prompt_calls DROP COLUMN server_version, DROP COLUMN client_version;
