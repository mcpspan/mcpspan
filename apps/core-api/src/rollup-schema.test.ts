import { afterAll, describe, expect, it } from 'vitest';

import { closePool, getPool } from './db.ts';
import { LATENCY_THRESHOLDS, thresholdColumn } from './rollup.ts';

afterAll(async () => {
  await closePool();
});

/**
 * The rollup view and the constant that reads it have to agree.
 *
 * They are written out separately on purpose: a migration has to keep meaning
 * what it meant on the day it ran, so it cannot import a constant a later
 * refactor might change. That leaves exactly one way for them to drift, and
 * nothing else would catch it. A threshold added to the code and not the view
 * fails the next query outright; a threshold in the view that the code stopped
 * reading is worse, because percentiles would simply start coming out wrong.
 */
describe.each(['tool_calls_hourly', 'resource_calls_hourly', 'prompt_calls_hourly'])('the hourly rollup %s', (view) => {
  it('has exactly the histogram columns the code reads', async () => {
    const result = await getPool().query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = $1
         AND column_name LIKE 'd\\_le\\_%'`,
      [view],
    );

    const inView = result.rows.map((row) => row.column_name).sort();
    const inCode = LATENCY_THRESHOLDS.map(thresholdColumn).sort();

    expect(inView).toEqual(inCode);
  });

  it('carries every dimension the dashboard filters by', async () => {
    // A dimension missing here is a filter that silently stops working once a
    // window reaches past the raw rows, which is the kind of fault nobody
    // reports because the page still renders.
    const result = await getPool().query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = $1`,
      [view],
    );

    const columns = new Set(result.rows.map((row) => row.column_name));

    for (const required of [
      'bucket',
      'server_id',
      view === 'tool_calls_hourly' ? 'tool_name' : 'name',
      'client_type',
      'success',
      'error_source',
      'calls',
      'duration_sum',
    ]) {
      expect(columns).toContain(required);
    }
  });

  it('answers with what arrived since the last refresh', async () => {
    // Real-time aggregation, which TimescaleDB leaves off by default. With it
    // off the view returns only materialized rows, so the current hour would
    // be missing from every chart and a developer who just called their tool
    // would see nothing.
    const result = await getPool().query<{ materialized_only: boolean }>(
      `SELECT materialized_only
       FROM timescaledb_information.continuous_aggregates
       WHERE view_name = $1`,
      [view],
    );

    expect(result.rows[0]?.materialized_only).toBe(false);
  });

  it('drops raw rows well after the refresh window has passed over them', async () => {
    // A refresh reaching into a period whose raw rows are gone recomputes
    // those buckets from nothing and erases rollup rows that were correct.
    const result = await getPool().query<{ proc_name: string; config: Record<string, string> }>(
      `SELECT proc_name, config
       FROM timescaledb_information.jobs
       WHERE proc_name IN ('policy_retention', 'policy_refresh_continuous_aggregate')`,
    );

    const refresh = result.rows.find(
      (row) => row.proc_name === 'policy_refresh_continuous_aggregate',
    );
    const retentions = result.rows.filter((row) => row.proc_name === 'policy_retention');

    expect(refresh).toBeDefined();
    expect(retentions.length).toBeGreaterThanOrEqual(2);

    const startOffsetDays = Number(String(refresh?.config['start_offset'] ?? '').split(' ')[0]);
    const shortestRetentionDays = Math.min(
      ...retentions.map((row) => Number(String(row.config['drop_after'] ?? '').split(' ')[0])),
    );

    expect(startOffsetDays).toBeGreaterThan(0);
    expect(shortestRetentionDays).toBeGreaterThan(startOffsetDays);
  });
});
