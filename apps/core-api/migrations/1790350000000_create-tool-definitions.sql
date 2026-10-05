-- Up Migration

-- When each definition of a tool (its name, title, description and input
-- schema, fingerprinted by the SDK: contract, 3.8) was first and last seen,
-- kept up to date as calls arrive. The dashboard marks on a tool's chart where
-- a new definition started: rewording a description can change how agents use
-- a tool more than a change to its code. A row per definition is a few dozen
-- bytes, and outlives raw retention, so an old definition coming back is
-- still known as old.
CREATE TABLE tool_definitions (
  server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  hash text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  PRIMARY KEY (server_id, tool_name, hash)
);

-- Down Migration

DROP TABLE tool_definitions;
