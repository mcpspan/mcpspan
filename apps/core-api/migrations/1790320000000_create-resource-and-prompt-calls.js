/**
 * Resource reads and prompt gets, next to tool calls.
 *
 * Each has a table of its own, shaped like tool_calls, with an hourly rollup
 * and retention of its own, rather than a kind column added to tool_calls.
 * That table's rollup is a continuous aggregate grouped by tool name; giving
 * it a new dimension means rebuilding it from raw rows, and raw rows are kept
 * for 90 days while the rollup keeps two years. An installation upgrading
 * would lose everything older than its raw retention. Separate tables leave
 * every tool query, and its history, exactly as they were.
 *
 * `name` holds what was read or got: a prompt's name, a resource's registered
 * URI or URI template, never an expanded URI, which could carry the values a
 * client asked about. `parameters` holds a template's variable names or a
 * prompt's argument names, as tool_calls does parameters: names and JSON
 * types, never values.
 *
 * JavaScript, and a statement per call, for the reason the tool rollup's
 * migration gives: a continuous aggregate cannot be created in a transaction.
 * The tables are empty, so creating the views with data costs nothing.
 */

const TABLES = ['resource_calls', 'prompt_calls'];

// Written out, as in the tool rollup: a migration keeps meaning what it meant
// on the day it ran. test/rollup-schema.test.ts checks these against the
// application's constant.
const HISTOGRAM = `
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
        count(*) FILTER (WHERE duration_ms <= 10000) AS d_le_10000`;

export const up = (pgm) => {
  pgm.noTransaction();

  for (const table of TABLES) {
    pgm.sql(`
      CREATE TABLE ${table} (
        id uuid NOT NULL,
        server_id uuid NOT NULL,
        occurred_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(),
        name text NOT NULL,
        duration_ms double precision NOT NULL,
        success boolean NOT NULL,
        error_source text,
        error_type text,
        error_message text,
        client_type text NOT NULL,
        client_name text,
        sdk_version text NOT NULL,
        parameters jsonb,
        session_id uuid,
        PRIMARY KEY (occurred_at, id)
      )
    `);
    pgm.sql(`SELECT create_hypertable('${table}', by_range('occurred_at', INTERVAL '7 days'))`);
    pgm.sql(`CREATE INDEX ${table}_server_time_idx ON ${table} (server_id, occurred_at DESC)`);
    pgm.sql(`CREATE INDEX ${table}_server_name_time_idx ON ${table} (server_id, name, occurred_at DESC)`);
    pgm.sql(`CREATE INDEX ${table}_server_failures_idx ON ${table} (server_id, occurred_at DESC) WHERE NOT success`);

    pgm.sql(`
      CREATE MATERIALIZED VIEW ${table}_hourly
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket(INTERVAL '1 hour', occurred_at) AS bucket,
        server_id,
        name,
        client_type,
        success,
        error_source,
        count(*) AS calls,
        sum(duration_ms) AS duration_sum,${HISTOGRAM}
      FROM ${table}
      GROUP BY bucket, server_id, name, client_type, success, error_source
    `);
    pgm.sql(`ALTER MATERIALIZED VIEW ${table}_hourly SET (timescaledb.materialized_only = false)`);
    pgm.sql(`
      SELECT add_continuous_aggregate_policy(
        '${table}_hourly',
        start_offset => INTERVAL '7 days',
        end_offset => INTERVAL '1 hour',
        schedule_interval => INTERVAL '30 minutes'
      )
    `);

    // The defaults; MCPSPAN_RETENTION_DAYS and MCPSPAN_ROLLUP_RETENTION_DAYS
    // apply to these as to tool_calls, reconciled when the API starts.
    pgm.sql(`SELECT add_retention_policy('${table}', INTERVAL '90 days')`);
    pgm.sql(`SELECT add_retention_policy('${table}_hourly', INTERVAL '730 days')`);
  }
};

export const down = (pgm) => {
  pgm.noTransaction();

  for (const table of [...TABLES].reverse()) {
    pgm.sql(`SELECT remove_retention_policy('${table}_hourly')`);
    pgm.sql(`SELECT remove_retention_policy('${table}')`);
    pgm.sql(`SELECT remove_continuous_aggregate_policy('${table}_hourly')`);
    pgm.sql(`DROP MATERIALIZED VIEW ${table}_hourly`);
    pgm.sql(`DROP TABLE ${table}`);
  }
};
