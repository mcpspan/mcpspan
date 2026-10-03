-- Up Migration

-- One row per tool call, as reported by the SDK.
--
-- Columns mirror ToolCallEvent, with two exceptions. The server is taken from
-- the API key rather than from the request, so that a caller cannot file tool
-- calls against somebody else's server. And received_at is ours: occurred_at
-- comes from the reporting machine's clock, which can be wrong, and having
-- both is the only way to recognise events arriving from the future.
--
-- There are deliberately no CHECK constraints on client_type or error_source.
-- The SDK and this backend are versioned separately, and a self-hoster running
-- last year's API against this year's SDK should not have their events refused
-- by an opaque database error because a new client name appeared. Rejecting
-- malformed data is the ingest endpoint's job, where it can say what was wrong.
CREATE TABLE tool_calls (
  id uuid NOT NULL,
  server_id uuid NOT NULL,

  -- When the call started, on the reporting machine's clock.
  occurred_at timestamptz NOT NULL,

  -- When it reached us. Differs from occurred_at by the batching delay, plus
  -- however wrong the reporting machine's clock is.
  received_at timestamptz NOT NULL DEFAULT now(),

  tool_name text NOT NULL,

  -- Fractional: a fast tool finishing in 0.4 ms is worth telling apart from
  -- one taking 1 ms, and rounding would erase that whole range.
  duration_ms double precision NOT NULL,

  success boolean NOT NULL,

  -- 'result' when the tool reported its own failure, 'exception' when the
  -- handler threw. Null when the call succeeded.
  error_source text,
  error_type text,
  error_message text,

  client_type text NOT NULL,

  -- The name a client reported for itself, kept so that an unrecognised client
  -- is a lead rather than a dead end.
  client_name text,

  sdk_version text NOT NULL,

  -- Parameter names mapped to types, when the developer opted in. Never values.
  parameters jsonb,

  -- Delivery is retried, and a batch that arrives after its acknowledgement was
  -- lost arrives twice. This is what lets the second copy be dropped.
  --
  -- The time column has to be part of the key: TimescaleDB enforces uniqueness
  -- within a chunk rather than across the table, so a key on id alone would be
  -- refused. The SDK treats an event as immutable once created, which is what
  -- makes the pair stable across a retry.
  PRIMARY KEY (occurred_at, id)
);

-- Partition by time. Telemetry is written in time order and read in time
-- ranges, so chunking that way keeps queries to the chunks they actually need
-- and lets old data be dropped by detaching a chunk instead of deleting rows.
SELECT create_hypertable('tool_calls', by_range('occurred_at', INTERVAL '7 days'));

-- Every dashboard query starts from "this server, this period".
CREATE INDEX tool_calls_server_time_idx ON tool_calls (server_id, occurred_at DESC);

-- The tool ranking and per-tool metrics.
CREATE INDEX tool_calls_server_tool_time_idx
  ON tool_calls (server_id, tool_name, occurred_at DESC);

-- The errors view. Partial, because failures are the small minority of rows
-- and there is no reason to index the successes alongside them.
CREATE INDEX tool_calls_server_failures_idx
  ON tool_calls (server_id, occurred_at DESC)
  WHERE NOT success;

-- Down Migration

DROP TABLE tool_calls;
