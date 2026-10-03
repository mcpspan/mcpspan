import { getPool } from './db.ts';

/**
 * Shortest raw retention that is safe to set.
 *
 * The rollup refresh looks back seven days. A retention shorter than that
 * would have a refresh recompute buckets whose raw rows are already gone, find
 * nothing, and replace correct rollup rows with zeroes. The data would not
 * come back, and nothing would report an error.
 */
export const MIN_RETENTION_DAYS = 8;

/** What the migration sets, and what an installation that configures nothing keeps. */
export const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_ROLLUP_RETENTION_DAYS = 730;

interface PolicyTarget {
  /** The hypertable or rollup the policy drops from. */
  relation: string;
  variable: string;
  fallback: number;
  minimum: number;
}

const TARGETS: readonly PolicyTarget[] = ['tool_calls', 'resource_calls', 'prompt_calls'].flatMap(
  (table) => [
    {
      relation: table,
      variable: 'MCPSPAN_RETENTION_DAYS',
      fallback: DEFAULT_RETENTION_DAYS,
      minimum: MIN_RETENTION_DAYS,
    },
    {
      relation: `${table}_hourly`,
      variable: 'MCPSPAN_ROLLUP_RETENTION_DAYS',
      fallback: DEFAULT_ROLLUP_RETENTION_DAYS,
      minimum: MIN_RETENTION_DAYS,
    },
  ],
);

/**
 * Brings the database's retention policies in line with the environment.
 *
 * Retention is a setting, not a schema change: somebody who decides a year is
 * too long should not have to write SQL or invent a migration to say so. The
 * migration puts defaults in place; this reconciles them at startup with
 * whatever the installation actually asked for.
 *
 * Deliberately not fatal, and deliberately not chatty when nothing changes.
 * A misconfigured retention is worth a line on stderr; it is not worth
 * refusing to serve a dashboard over.
 */
export async function reconcileRetention(): Promise<void> {
  for (const target of TARGETS) {
    try {
      await reconcileOne(target);
    } catch (error) {
      console.error(
        `mcpspan core-api could not set retention for ${target.relation}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function reconcileOne(target: PolicyTarget): Promise<void> {
  const wanted = readDays(target);
  const current = await currentRetentionDays(target.relation);

  // Nothing to do, which is the usual case. Removing and re-adding a policy
  // that already says the right thing would churn a background job on every
  // restart for no reason.
  if (current === wanted) return;

  if (current !== undefined) {
    await getPool().query(`SELECT remove_retention_policy($1)`, [target.relation]);
  }

  await getPool().query(
    `SELECT add_retention_policy($1, drop_after => make_interval(days => $2))`,
    [target.relation, wanted],
  );

  console.log(`mcpspan core-api keeps ${target.relation} for ${wanted} days`);
}

/** How long the database currently keeps a relation, or undefined if it keeps it forever. */
export async function currentRetentionDays(relation: string): Promise<number | undefined> {
  const result = await getPool().query<{ days: string | null }>(
    `SELECT extract(epoch FROM (config->>'drop_after')::interval) / 86400 AS days
     FROM timescaledb_information.jobs
     WHERE proc_name = 'policy_retention'
       AND hypertable_name = $1`,
    [relation],
  );

  const days = result.rows[0]?.days;

  return days === null || days === undefined ? undefined : Number(days);
}

/**
 * Reads a retention period, refusing values that would lose data silently.
 *
 * A number below the floor is not clamped quietly. Somebody who asked for two
 * days meant something by it, and giving them eight without saying so would
 * leave them believing a bound that is not there.
 */
function readDays(target: PolicyTarget): number {
  const raw = process.env[target.variable]?.trim();

  if (raw === undefined || raw.length === 0) return target.fallback;

  const days = Number(raw);

  if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0) {
    console.error(
      `mcpspan core-api ignoring ${target.variable}=${raw}, which is not a whole number of days. Keeping ${target.fallback}.`,
    );
    return target.fallback;
  }

  if (days < target.minimum) {
    console.error(
      `mcpspan core-api ignoring ${target.variable}=${days}: anything under ${target.minimum} days would let the rollup be refreshed from raw rows that had already been dropped, replacing correct figures with zeroes. Keeping ${target.fallback}.`,
    );
    return target.fallback;
  }

  return days;
}
