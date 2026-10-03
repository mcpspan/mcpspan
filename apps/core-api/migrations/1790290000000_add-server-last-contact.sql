-- Up Migration

-- When a server's SDK last reached us, and which version it was.
--
-- Separate from the newest event, because the two answer different questions.
-- The SDK announces itself when it starts, before any tool is called, so a
-- server with a contact and no events is wired correctly and simply unused,
-- while one with neither has never reached this installation at all. From the
-- events alone the two looked identical.
ALTER TABLE servers
  ADD COLUMN last_contact_at timestamptz,
  ADD COLUMN last_sdk_version text;

-- Down Migration

ALTER TABLE servers
  DROP COLUMN last_contact_at,
  DROP COLUMN last_sdk_version;
