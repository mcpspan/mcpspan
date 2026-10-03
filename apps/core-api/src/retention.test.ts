import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closePool, getPool } from './db.ts';
import {
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  reconcileRetention,
} from './retention.ts';

const VARIABLE = 'MCPSPAN_RETENTION_DAYS';

async function retentionDays(relation: string): Promise<number | undefined> {
  const result = await getPool().query<{ days: string }>(
    `SELECT extract(epoch FROM (config->>'drop_after')::interval) / 86400 AS days
     FROM timescaledb_information.jobs
     WHERE proc_name = 'policy_retention' AND hypertable_name = $1`,
    [relation],
  );

  const days = result.rows[0]?.days;

  return days === undefined ? undefined : Number(days);
}

beforeEach(() => {
  delete process.env[VARIABLE];
});

afterEach(async () => {
  delete process.env[VARIABLE];
  await reconcileRetention();
});

afterAll(async () => {
  await closePool();
});

describe('reconcileRetention', () => {
  it('leaves the migration default alone when nothing asks otherwise', async () => {
    await reconcileRetention();

    expect(await retentionDays('tool_calls')).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('applies a period the installation asked for', async () => {
    process.env[VARIABLE] = '30';

    await reconcileRetention();

    expect(await retentionDays('tool_calls')).toBe(30);
  });

  it.each([
    ['shorter than the refresh window', String(MIN_RETENTION_DAYS - 1)],
    ['not a number', 'a fortnight'],
    ['zero', '0'],
    ['negative', '-30'],
    ['fractional', '7.5'],
  ])('refuses a period that is %s, and says so', async (_label, value) => {
    // Refusing rather than clamping. A retention shorter than the refresh
    // window has the rollup recomputed from raw rows that are already gone,
    // which replaces correct figures with zeroes and reports nothing. Somebody
    // who typed two days meant something by it, and quietly giving them eight
    // would leave them trusting a bound that is not there.
    process.env[VARIABLE] = value;

    await reconcileRetention();

    expect(await retentionDays('tool_calls')).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('does nothing at all when the policy already says the right thing', async () => {
    process.env[VARIABLE] = '45';
    await reconcileRetention();

    const before = await getPool().query<{ job_id: string }>(
      `SELECT job_id FROM timescaledb_information.jobs
       WHERE proc_name = 'policy_retention' AND hypertable_name = 'tool_calls'`,
    );

    // Running again must not drop and recreate the job. It would work, and it
    // would also reset the job's schedule on every restart of the API.
    await reconcileRetention();

    const after = await getPool().query<{ job_id: string }>(
      `SELECT job_id FROM timescaledb_information.jobs
       WHERE proc_name = 'policy_retention' AND hypertable_name = 'tool_calls'`,
    );

    expect(after.rows[0]?.job_id).toBe(before.rows[0]?.job_id);
  });

  it('keeps the rollup for longer than the raw rows it summarises', async () => {
    await reconcileRetention();

    const raw = await retentionDays('tool_calls');
    const rolled = await retentionDays('tool_calls_hourly');

    expect(rolled).toBeDefined();
    expect(rolled ?? 0).toBeGreaterThan(raw ?? 0);
  });
});
