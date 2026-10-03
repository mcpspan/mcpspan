/**
 * Measures whether the dashboard's queries still answer as the data grows.
 *
 * The question this step exists to settle is not "is the rollup faster", which
 * is obvious, but "does the answer time stop tracking the row count". So it
 * runs the same three questions at one volume and then at ten times that,
 * both through the rollup and the way they were asked before it, and prints
 * the four numbers side by side.
 *
 * Writes to a server id of its own and removes it afterwards, so it can be run
 * against a database somebody is using.
 *
 *   node --env-file-if-exists=../../.env scripts/benchmark-rollup.ts [rows]
 */
import { closePool, getPool } from '../src/db.ts';
import { getSummary, getTimeseries, getToolStats } from '../src/analytics.ts';
import { chooseBucketSeconds } from '../src/buckets.ts';

const BENCH_SERVER = '0bebca00-0000-4000-8000-00000000bec0';
const BASE_ROWS = Number(process.argv[2] ?? 300_000);
const WINDOW_DAYS = 30;

const range = {
  from: new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000),
  to: new Date(),
};

async function seed(rows: number): Promise<void> {
  // Spread over the window, across a realistic number of tools and clients, so
  // the grouping has something to do. Durations follow a long tail, because a
  // uniform one would make the percentile work easier than it really is.
  await getPool().query(
    `INSERT INTO tool_calls (
       id, server_id, occurred_at, tool_name, duration_ms, success,
       error_source, client_type, sdk_version
     )
     SELECT
       gen_random_uuid(),
       $1,
       $2::timestamptz + (random() * $3 * INTERVAL '1 day'),
       'tool_' || (n % 12),
       CASE WHEN random() < 0.9 THEN random() * 80 ELSE 200 + random() * 3000 END,
       random() > 0.05,
       CASE WHEN random() > 0.05 THEN NULL WHEN random() < 0.5 THEN 'result' ELSE 'exception' END,
       (ARRAY['claude', 'claude-code', 'cursor', 'other'])[1 + (n % 4)],
       '0.1.0'
     FROM generate_series(1, $4) AS n`,
    [BENCH_SERVER, range.from, WINDOW_DAYS, rows],
  );

  await getPool().query(`CALL refresh_continuous_aggregate('tool_calls_hourly', NULL, NULL)`);
}

async function time(label: string, run: () => Promise<unknown>): Promise<number> {
  // One run to warm the caches, then the one that counts. Without this the
  // first query measured would carry the cost of reading the index off disk
  // and the comparison would be with whichever ran first.
  await run();

  const started = performance.now();
  await run();
  const ms = performance.now() - started;

  console.log(`  ${label.padEnd(34)} ${ms.toFixed(0).padStart(7)} ms`);
  return ms;
}

/** How the summary was asked before the rollup, kept here to have something to compare against. */
async function summaryFromRawRows(): Promise<unknown> {
  const result = await getPool().query(
    `SELECT
       count(*) AS total_calls,
       count(*) FILTER (WHERE NOT success) AS failed_calls,
       avg(duration_ms) AS mean_duration,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
       count(DISTINCT tool_name) AS unique_tools
     FROM tool_calls
     WHERE server_id = $1 AND occurred_at >= $2 AND occurred_at < $3`,
    [BENCH_SERVER, range.from, range.to],
  );

  return result.rows[0];
}

async function measure(rows: number): Promise<{ rollup: number; raw: number }> {
  const count = await getPool().query<{ c: string }>(
    'SELECT count(*) AS c FROM tool_calls WHERE server_id = $1',
    [BENCH_SERVER],
  );

  const rolled = await getPool().query<{ c: string }>(
    'SELECT count(*) AS c FROM tool_calls_hourly WHERE server_id = $1',
    [BENCH_SERVER],
  );

  // The rollup's own size is what decides whether this keeps working. It is
  // bounded by the number of distinct hour, tool, client and outcome
  // combinations, not by how many calls fall into them, so past the point
  // where most combinations have something in them, more traffic is free.
  console.log(
    `\n${Number(count.rows[0]?.c ?? 0).toLocaleString('en-GB')} rows over ${WINDOW_DAYS} days` +
      `, rolled up into ${Number(rolled.rows[0]?.c ?? 0).toLocaleString('en-GB')}`,
  );

  const rollup = await time('summary, through the rollup', () => getSummary(BENCH_SERVER, range));
  const raw = await time('summary, from raw rows', summaryFromRawRows);
  await time('chart, through the rollup', () =>
    getTimeseries(BENCH_SERVER, range, chooseBucketSeconds(range)),
  );
  await time('tool ranking, through the rollup', () => getToolStats(BENCH_SERVER, range));

  return { rollup, raw };
}

async function main(): Promise<void> {
  await getPool().query('DELETE FROM tool_calls WHERE server_id = $1', [BENCH_SERVER]);

  console.log(`Seeding ${BASE_ROWS.toLocaleString('en-GB')} rows...`);
  await seed(BASE_ROWS);
  const small = await measure(BASE_ROWS);

  console.log(`\nSeeding ${(BASE_ROWS * 9).toLocaleString('en-GB')} more, for ten times the data...`);
  await seed(BASE_ROWS * 9);
  const large = await measure(BASE_ROWS * 10);

  console.log('\nTen times the rows cost:');
  console.log(`  through the rollup   ${(large.rollup / small.rollup).toFixed(1)}x the time`);
  console.log(`  from raw rows        ${(large.raw / small.raw).toFixed(1)}x the time`);

  await getPool().query('DELETE FROM tool_calls WHERE server_id = $1', [BENCH_SERVER]);
  await getPool().query(`CALL refresh_continuous_aggregate('tool_calls_hourly', NULL, NULL)`);
  await closePool();
}

await main();
