-- Up Migration

-- Requests the ingest endpoint turned away, counted by server and by reason.
--
-- Kept in the database rather than only in memory because of who reads it and
-- when. The SDK stops sending for the life of its process once its key is
-- refused, so a refused key produces a handful of requests and then silence.
-- Somebody who restarts the stack while working out why their dashboard is
-- empty would wipe the only evidence, and nothing would ever repeat it.
--
-- One row per server and reason, not one per request: this is a counter, and
-- a flood of refused requests must not become a flood of rows. The server is
-- absent when the request never got as far as naming one - an unknown key, or
-- a body too large to read.
CREATE TABLE ingest_refusals (
  server_id uuid REFERENCES servers (id) ON DELETE CASCADE,

  reason text NOT NULL,

  requests bigint NOT NULL,

  last_at timestamptz NOT NULL,

  -- NULLS NOT DISTINCT, so requests with no server share one row per reason
  -- instead of each inserting its own.
  CONSTRAINT ingest_refusals_key UNIQUE NULLS NOT DISTINCT (server_id, reason)
);

-- Down Migration

DROP TABLE ingest_refusals;
