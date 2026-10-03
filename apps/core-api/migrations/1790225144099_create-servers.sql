-- Up Migration

-- A server gets a row of its own.
--
-- Until now a server existed only as a `server_id` repeated across API key
-- rows, with its name carried on each of them. That worked while an account
-- had exactly one, and breaks as soon as it has two.
--
-- It also had a fault nobody had hit yet: the list of an account's servers was
-- built from keys that had not been revoked, so revoking a key without issuing
-- a replacement made the server disappear from the dashboard while its events
-- sat untouched in the table. Ownership belongs to the server, not to whatever
-- credential happens to be current.
CREATE TABLE servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Nullable, because a key minted from the command line before anyone
  -- registered has no account behind it. Such a server accepts events and is
  -- not listed anywhere until it is adopted.
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,

  name text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX servers_user_idx ON servers (user_id);

-- One row per server the existing keys describe, taking the name and owner
-- from the oldest key, which is the one that created it.
INSERT INTO servers (id, user_id, name, created_at)
SELECT DISTINCT ON (server_id) server_id, user_id, server_name, created_at
FROM api_keys
ORDER BY server_id, created_at;

-- Deleting a server takes its keys with it. Its events go separately: they
-- live in a hypertable that a foreign key cannot reach across.
ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_server_fk
  FOREIGN KEY (server_id) REFERENCES servers (id) ON DELETE CASCADE;

-- The name now has one home. Leaving a copy on every key would mean renaming a
-- server updated some rows and not others, and nothing would have complained.
ALTER TABLE api_keys DROP COLUMN server_name;

-- Down Migration

ALTER TABLE api_keys ADD COLUMN server_name text;

UPDATE api_keys
SET server_name = servers.name
FROM servers
WHERE servers.id = api_keys.server_id;

ALTER TABLE api_keys ALTER COLUMN server_name SET NOT NULL;

ALTER TABLE api_keys DROP CONSTRAINT api_keys_server_fk;

DROP TABLE servers;
