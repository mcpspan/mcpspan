-- Up Migration

-- What the server listed in answer to tools/list, once per session for the
-- same answer (SDK contract, 3.11): which tools each session was shown, and
-- how large their definitions are. Names, fingerprints and sizes only; the
-- definitions themselves never leave the server's process.
--
-- One row per listing, the tools as three arrays in the order listed, rather
-- than a row per tool: a session is shown every tool at once, and is counted
-- once per tool by unnesting.
CREATE TABLE tool_listings (
  id uuid NOT NULL,
  server_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  session_id uuid,
  client_type text NOT NULL,
  client_name text,
  server_version text,
  sdk_version text NOT NULL,
  tool_names text[] NOT NULL,
  definition_hashes text[] NOT NULL,
  definition_bytes integer[] NOT NULL,
  -- As on the call tables: a redelivered batch is recognised by the pair.
  PRIMARY KEY (occurred_at, id)
);

SELECT create_hypertable('tool_listings', by_range('occurred_at', INTERVAL '7 days'));

CREATE INDEX tool_listings_server_time_idx ON tool_listings (server_id, occurred_at DESC);

-- Kept as long as raw calls are; the API brings this in line with
-- MCPSPAN_RETENTION_DAYS when it starts.
SELECT add_retention_policy('tool_listings', INTERVAL '90 days');

-- Down Migration

DROP TABLE tool_listings;
