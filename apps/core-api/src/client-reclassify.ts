import { createHash } from 'node:crypto';

import { CLIENT_TYPE_RULES } from '@mcpspan/client-types';

import { getPool } from './db.ts';
import { CALL_TABLES, type CallKind } from './rollup.ts';

/** Where the fingerprint of the rules stored calls were last classified with is kept. */
const SETTING = 'client_type_rules';

/** How often a refresh another one is running into is tried again, a second apart. */
const REFRESH_ATTEMPTS = 10;

/**
 * Rebuilds a rollup over the hours given. Outside any transaction, which TimescaleDB requires of a refresh, and
 * tried again while the scheduled refresh of the same rollup is running, which TimescaleDB refuses alongside.
 * A policy refresh would not do it later: it looks back only so far, and these hours can be older.
 */
async function refreshRollup(rollup: string, from: Date, to: Date): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await getPool().query(`CALL refresh_continuous_aggregate('${rollup}', $1::timestamptz, $2::timestamptz)`, [from, to]);
      return;
    } catch (error) {
      const concurrent = (error as { code?: unknown }).code === '55P03';
      if (!concurrent || attempt === REFRESH_ATTEMPTS) throw error;
      await new Promise((done) => setTimeout(done, 1_000));
    }
  }
}

/** Changes whenever a rule does, so a release with new rules is noticed once. */
export function rulesFingerprint(): string {
  return createHash('sha256').update(JSON.stringify(CLIENT_TYPE_RULES)).digest('hex');
}

/** A rule's text, matched literally rather than as a LIKE pattern. */
function literal(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/**
 * `clientTypeOf` from @mcpspan/client-types, as SQL over `client_name`, built
 * from the same rules so the two cannot disagree. Its values are appended to
 * `params`, and the expression refers to them by position.
 */
export function clientTypeSql(params: unknown[]): string {
  const name = `lower(btrim(client_name, E' \\t\\n\\r'))`;
  const bind = (value: string): string => {
    params.push(value);
    return `$${params.length}::text`;
  };

  const whens = CLIENT_TYPE_RULES.map((rule) => {
    const conditions = [
      ...(rule.startsWith ?? []).map((prefix) => `${name} LIKE ${bind(`${literal(prefix)}%`)}`),
      ...(rule.contains ?? []).map((part) => `${name} LIKE ${bind(`%${literal(part)}%`)}`),
    ];
    return `WHEN ${conditions.join(' OR ')} THEN ${bind(rule.type)}`;
  });

  return `CASE WHEN coalesce(${name}, '') = '' THEN 'unknown' ${whens.join(' ')} ELSE 'other' END`;
}

/**
 * Gives stored calls the type the current rules give their client's name, when
 * the rules changed since the last time this ran. The calls are updated where
 * they are still kept raw, and the hourly rollups rebuilt over the hours that
 * changed; rollup hours older than the raw retention keep the type they had,
 * since the name they were counted under is gone.
 *
 * Returns how many calls changed type.
 */
export async function reclassifyClients(): Promise<number> {
  const fingerprint = rulesFingerprint();
  const stored = await getPool().query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [SETTING]);
  if (stored.rows[0]?.value === fingerprint) return 0;

  let changed = 0;
  for (const kind of Object.keys(CALL_TABLES) as CallKind[]) {
    const { raw, rollup } = CALL_TABLES[kind];
    const params: unknown[] = [];
    const type = clientTypeSql(params);

    const result = await getPool().query<{ calls: string; first: Date | null; last: Date | null }>(
      `WITH updated AS (
         UPDATE ${raw} SET client_type = ${type}
          WHERE client_type IS DISTINCT FROM ${type}
         RETURNING occurred_at
       )
       SELECT count(*) AS calls,
              date_trunc('hour', min(occurred_at)) AS first,
              date_trunc('hour', max(occurred_at)) + interval '1 hour' AS last
         FROM updated`,
      params,
    );

    const row = result.rows[0];
    if (row?.first && row.last) {
      await refreshRollup(rollup, row.first, row.last);
    }
    changed += Number(row?.calls ?? 0);
  }

  // Listings (contract, 3.11) carry the client too, and have no rollup.
  const params: unknown[] = [];
  const type = clientTypeSql(params);
  const listings = await getPool().query(
    `UPDATE tool_listings SET client_type = ${type} WHERE client_type IS DISTINCT FROM ${type}`,
    params,
  );
  changed += listings.rowCount ?? 0;

  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTING, fingerprint],
  );

  return changed;
}
