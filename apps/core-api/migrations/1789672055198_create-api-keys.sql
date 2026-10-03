-- Up Migration

-- Keys the SDK authenticates with.
--
-- A key is stored as a keyed hash, never in the clear. The hash is a plain
-- HMAC rather than bcrypt or argon2 on purpose: those are deliberately slow
-- and salted per row, which is right for passwords and wrong here. Every
-- ingest request carries a key, so verification has to be a single indexed
-- lookup rather than a scan that rehashes each row in turn. API keys are long
-- random strings, so the offline guessing these functions defend against does
-- not apply, and the server-side secret mixed into the hash means a stolen
-- copy of this table is not a usable set of keys.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- HMAC-SHA256 of the key. Unique, so lookup is one index probe.
  key_hash bytea NOT NULL UNIQUE,

  -- The server whose events this key may write. Ingest reads the server from
  -- here rather than from the request body, which is what stops a caller from
  -- filing tool calls against somebody else's server.
  server_id uuid NOT NULL DEFAULT gen_random_uuid(),

  server_name text NOT NULL,

  -- Who the key belongs to. Accounts arrive later and will add a reference to
  -- the users table; until then an address is the only owner there is.
  owner_email text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),

  -- Set instead of deleting the row, so a key that once wrote events can still
  -- be explained after it stops working.
  revoked_at timestamptz
);

-- Ingest filters on both columns together, and the vast majority of rows are
-- live, so the index carries only those.
CREATE INDEX api_keys_active_idx ON api_keys (key_hash) WHERE revoked_at IS NULL;

CREATE INDEX api_keys_server_idx ON api_keys (server_id);

-- Down Migration

DROP TABLE api_keys;
