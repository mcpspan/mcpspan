/**
 * An hourly rollup of tool calls, and a bound on how long anything is kept.
 *
 * Without both, the events table grows without limit and every dashboard query
 * reads raw rows. A server doing ten calls a second produces around 315
 * million rows a year, at which point the overview stops being a page and
 * becomes a wait, and the self-hoster has nobody to report that to.
 *
 * Two things about the shape of this file, because neither is a preference.
 *
 * It is JavaScript rather than SQL, which is the exception in this directory.
 * `CREATE MATERIALIZED VIEW ... WITH DATA` cannot run inside a transaction,
 * and a .sql migration here always runs in one. Only a JavaScript migration
 * can call `noTransaction()`.
 *
 * And each statement is its own `pgm.sql()` call rather than one block. A
 * block is sent as a single query, and PostgreSQL wraps a multi statement
 * query in an implicit transaction, which puts the create right back where it
 * could not run.
 *
 * `WITH NO DATA` would have avoided both and is the wrong trade. The refresh
 * policy only materializes what falls inside its start offset, so on an
 * installation that already has history everything older would stay
 * unmaterialized, and real-time reads only cover what arrives after the
 * materialization watermark, not what came before it. Creating with data
 * backfills the lot once, here, where it is visible.
 *
 * The cost of running without a transaction is that a failure part way through
 * leaves the earlier statements applied. The down migration undoes them in
 * reverse.
 */

export const up = (pgm) => {
  pgm.noTransaction();

  // Percentiles are the hard part. They cannot be averaged across buckets, and
  // the functions that solve it properly (percentile_agg, tdigest) live in the
  // TimescaleDB Toolkit, which is not in the image this project pins and which
  // a self-hoster should not have to go and install. So durations are kept as
  // a histogram: a count per latency threshold, which sums across buckets like
  // any other counter, and from which a percentile is read by interpolating
  // inside the bucket it falls in. This is what Prometheus does, for the same
  // reason.
  pgm.sql(`
    CREATE MATERIALIZED VIEW tool_calls_hourly
    WITH (timescaledb.continuous) AS
    SELECT
      time_bucket(INTERVAL '1 hour', occurred_at) AS bucket,

      -- Every dimension the dashboard filters or groups by. One left out here
      -- is a filter that silently stops working on older data, which is worse
      -- than a filter that was never offered.
      server_id,
      tool_name,
      client_type,
      success,
      error_source,

      count(*) AS calls,

      -- The mean is derived from this rather than stored, because a mean of
      -- means is only right when the buckets are equal in size, and these are
      -- not.
      sum(duration_ms) AS duration_sum,

      -- Cumulative counts: each column holds every call at or under its
      -- threshold, so a percentile is found by walking the thresholds until
      -- the running count passes the rank being looked for. Calls above the
      -- last threshold are the difference between it and \`calls\`.
      --
      -- Roughly half again between steps, all the way up, so the relative
      -- error stays constant instead of collapsing at the fast end and
      -- blowing out at the slow end.
      --
      -- These thresholds are written out rather than generated from the
      -- application's constant on purpose. A migration has to keep meaning
      -- what it meant on the day it ran; importing a value that a later
      -- refactor can change would quietly rewrite history. A test asserts
      -- that the view and the constant still agree.
      count(*) FILTER (WHERE duration_ms <= 1) AS d_le_1,
      count(*) FILTER (WHERE duration_ms <= 2) AS d_le_2,
      count(*) FILTER (WHERE duration_ms <= 3) AS d_le_3,
      count(*) FILTER (WHERE duration_ms <= 5) AS d_le_5,
      count(*) FILTER (WHERE duration_ms <= 8) AS d_le_8,
      count(*) FILTER (WHERE duration_ms <= 12) AS d_le_12,
      count(*) FILTER (WHERE duration_ms <= 20) AS d_le_20,
      count(*) FILTER (WHERE duration_ms <= 30) AS d_le_30,
      count(*) FILTER (WHERE duration_ms <= 45) AS d_le_45,
      count(*) FILTER (WHERE duration_ms <= 65) AS d_le_65,
      count(*) FILTER (WHERE duration_ms <= 100) AS d_le_100,
      count(*) FILTER (WHERE duration_ms <= 150) AS d_le_150,
      count(*) FILTER (WHERE duration_ms <= 250) AS d_le_250,
      count(*) FILTER (WHERE duration_ms <= 400) AS d_le_400,
      count(*) FILTER (WHERE duration_ms <= 600) AS d_le_600,
      count(*) FILTER (WHERE duration_ms <= 1000) AS d_le_1000,
      count(*) FILTER (WHERE duration_ms <= 1500) AS d_le_1500,
      count(*) FILTER (WHERE duration_ms <= 2500) AS d_le_2500,
      count(*) FILTER (WHERE duration_ms <= 4000) AS d_le_4000,
      count(*) FILTER (WHERE duration_ms <= 6000) AS d_le_6000,
      count(*) FILTER (WHERE duration_ms <= 10000) AS d_le_10000
    FROM tool_calls
    GROUP BY bucket, server_id, tool_name, client_type, success, error_source
  `);

  // Off by default in TimescaleDB, and wrong for us that way: with it on, the
  // view returns only what has been materialized, so the current hour would be
  // missing from every chart. Measured on this version before relying on it.
  // With this set, a read unions the materialized rows with the raw rows that
  // arrived since, and a call made a second ago is visible immediately.
  pgm.sql(`
    ALTER MATERIALIZED VIEW tool_calls_hourly
    SET (timescaledb.materialized_only = false)
  `);

  // Refresh what has settled, and leave the current hour to real-time reads.
  //
  // start_offset must stay well inside the raw retention below. A refresh
  // window reaching into a period whose raw rows have been dropped would
  // recompute those buckets from nothing and erase rollup rows that were
  // correct.
  pgm.sql(`
    SELECT add_continuous_aggregate_policy(
      'tool_calls_hourly',
      start_offset => INTERVAL '7 days',
      end_offset => INTERVAL '1 hour',
      schedule_interval => INTERVAL '30 minutes'
    )
  `);

  // Raw events are kept long enough to answer the questions that need them:
  // the error list with its messages, and any window narrower than an hour.
  // Past that the rollup answers, so the rows are cost without benefit.
  //
  // Both periods are adjustable at runtime, from MCPSPAN_RETENTION_DAYS and
  // MCPSPAN_ROLLUP_RETENTION_DAYS, reconciled when the API starts. These are
  // the defaults for an installation that never sets either.
  pgm.sql(`SELECT add_retention_policy('tool_calls', INTERVAL '90 days')`);

  // The rollup is smaller by roughly three orders of magnitude, so it can be
  // kept for years. It still needs a bound: without one this migration would
  // trade a table that grows forever for a view that does.
  pgm.sql(`SELECT add_retention_policy('tool_calls_hourly', INTERVAL '730 days')`);
};

export const down = (pgm) => {
  pgm.noTransaction();

  pgm.sql(`SELECT remove_retention_policy('tool_calls_hourly')`);
  pgm.sql(`SELECT remove_retention_policy('tool_calls')`);
  pgm.sql(`SELECT remove_continuous_aggregate_policy('tool_calls_hourly')`);
  pgm.sql(`DROP MATERIALIZED VIEW tool_calls_hourly`);
};
