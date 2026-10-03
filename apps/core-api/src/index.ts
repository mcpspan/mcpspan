import { serve } from '@hono/node-server';

import { sweepExpiredSessions } from './accounts.ts';
import { createApp } from './app.ts';
import { evaluateAlerts } from './alerts.ts';
import { ping } from './db.ts';
import { startOpenTelemetry } from './otel.ts';
import { ingestRateLimiter } from './rate-limit.ts';
import { refusalLog } from './refusals.ts';
import { reconcileRetention } from './retention.ts';
import { checkSigningSecret } from './secret-check.ts';
import { loadSigningSecret } from './signing-secret.ts';

const port = Number(process.env['PORT'] ?? 6271);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`PORT must be a number between 1 and 65535, received ${String(process.env['PORT'])}`);
  process.exit(1);
}

// Settled here rather than when the first event arrives. Without it no key can
// be verified, so the API would accept connections and refuse every single
// request - which looks like a broken key rather than a missing setting.
const signing = loadSigningSecret();
if ('problem' in signing) {
  console.error(`mcpspan core-api: ${signing.problem}`);
  process.exit(1);
}
if (signing.generated) {
  console.log(
    `mcpspan core-api generated its API key signing secret and stored it in ${String(process.env['MCPSPAN_SECRET_FILE'])}. Keep that volume with the database.`,
  );
}

/**
 * Reports on the database once, at startup.
 *
 * Deliberately not fatal. Under Docker Compose the API regularly starts before
 * PostgreSQL finishes accepting connections, and exiting here would turn an
 * ordinary few seconds of waiting into a restart loop. The pool reconnects on
 * its own, so this exists to put the reason in the log rather than to decide
 * whether to run.
 */
async function reportDatabase(): Promise<void> {
  try {
    await ping();
    console.log('mcpspan core-api connected to the database');

    // Only once the database is actually reachable. Retention is a setting
    // rather than a schema change, so it is reconciled here instead of in a
    // migration, where changing it would mean inventing one each time.
    await reconcileRetention();

    // Before anything is served, because the answer changes how every refusal
    // from here on should be read.
    await checkSigningSecret(process.env['API_KEY_SECRET'] ?? '');
  } catch (error) {
    console.error(
      `mcpspan core-api cannot reach the database yet: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Forgets the rate limit buckets of servers that stopped reporting.
 *
 * Hourly, and unreferenced so it never keeps the process alive on its own. A
 * bucket is a few numbers, but a long-lived API that issued a key for every
 * short-lived container would accumulate them without this.
 */
setInterval(() => ingestRateLimiter.evictIdle(), 60 * 60 * 1000).unref();

/**
 * Deletes sign-in sessions that have expired.
 *
 * Hourly, like the eviction above. They are refused on the way in already, so
 * this is housekeeping: without it the table only ever grows. A failure waits
 * for the next hour; nothing depends on it happening sooner.
 */
setInterval(() => {
  sweepExpiredSessions().catch(() => undefined);
}, 60 * 60 * 1000).unref();

/**
 * Writes down refused ingest requests.
 *
 * Every ten seconds, so a restart loses at most that much, and nothing about
 * refusing a request ever waits for the database. A failed flush keeps its
 * counts for the next one, and says why only once per outage rather than
 * every ten seconds for as long as it lasts.
 */
let refusalFlushFailing = false;

setInterval(() => {
  refusalLog.flush().then(
    () => {
      refusalFlushFailing = false;
    },
    (error: unknown) => {
      if (!refusalFlushFailing) {
        console.error(
          `mcpspan core-api could not record refused requests, will retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      refusalFlushFailing = true;
    },
  );
}, 10_000).unref();

/**
 * Checks alert rules and delivers what changed.
 *
 * Once a minute, which is as fine as a rule's window gets. A failed run, most
 * likely the database being away, is logged once per outage and tried again
 * next minute; nothing is lost, because a change of state is only recorded
 * when it is seen.
 */
let alertsFailing = false;

setInterval(() => {
  evaluateAlerts().then(
    () => {
      alertsFailing = false;
    },
    (error: unknown) => {
      if (!alertsFailing) {
        console.error(
          `mcpspan core-api could not check alerts, will retry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      alertsFailing = true;
    },
  );
}, 60_000).unref();

/**
 * Forwards calls to OpenTelemetry when OTEL_EXPORTER_OTLP_ENDPOINT says where.
 *
 * With it on, a stop sends what is still queued before the process ends,
 * waiting at most as long as one request may take. Without it, a stop is as
 * immediate as it always was.
 */
const otel = startOpenTelemetry();

if (otel) {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void otel.stop().finally(() => process.exit(0));
    });
  }
}

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`mcpspan core-api listening on http://localhost:${info.port}`);
  void reportDatabase();
});
