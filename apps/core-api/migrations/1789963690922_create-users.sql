-- Up Migration

-- The people who sign in to read the dashboard.
--
-- Distinct from api_keys on purpose: a key authenticates a machine writing its
-- own telemetry, a user authenticates a person reading it, and one table for
-- both would mean a key leaked from a server's environment also opened the
-- dashboard.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stored already lowercased, and unique on that. Addresses are compared
  -- case-insensitively by every mail system anybody uses, so treating
  -- Someone@example.com as a second account would only ever be a way to lock
  -- somebody out of their own.
  email text NOT NULL UNIQUE,

  -- Salt, parameters and digest together in one string. Keeping the
  -- parameters beside the hash is what allows them to be raised later without
  -- invalidating every password already stored.
  password_hash text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ties a key to whoever owns it. Nullable because keys created before accounts
-- existed have no owner to point at, and dropping their events to tidy up the
-- schema would be a poor trade.
ALTER TABLE api_keys ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE CASCADE;

CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- Down Migration

ALTER TABLE api_keys DROP COLUMN user_id;

DROP TABLE users;
