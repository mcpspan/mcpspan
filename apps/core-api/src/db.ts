import { Pool } from 'pg';

/**
 * How long a request waits for a free connection before giving up.
 *
 * Without a limit, a database that has stopped answering turns every incoming
 * request into a hung one, and the API stops responding rather than failing.
 */
const CONNECTION_TIMEOUT_MS = 5_000;

/** How long an unused connection is kept before being handed back. */
const IDLE_TIMEOUT_MS = 30_000;

let pool: Pool | undefined;

/**
 * The connection pool, created on first use.
 *
 * Connections are pooled because ingest is many small writes: opening a fresh
 * connection per request would cost more than the write it carries.
 */
export function getPool(): Pool {
  if (pool === undefined) {
    pool = new Pool({
      connectionString: requireDatabaseUrl(),
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
    });

    // A pooled connection sitting idle can still be cut off, by the database
    // restarting or being stopped, and the pool reports that as an 'error'
    // event. With nobody listening, Node treats it as uncaught and ends the
    // process: a database going away would take the API down with it, and the
    // dashboard would say the API is unreachable when the API was the part
    // that was fine. The pool discards the dead connection by itself, so all
    // that is left to do is say so.
    pool.on('error', (error) => {
      console.error(`mcpspan core-api lost an idle database connection: ${error.message}`);
    });
  }

  return pool;
}

/**
 * Error codes that mean the database could not be reached, as opposed to a
 * query it reached and refused.
 *
 * Network codes from Node for a host that is down, unknown or not answering,
 * and PostgreSQL's own codes for a server that is shutting down, starting up
 * or out of connections, plus its whole class of connection exceptions.
 */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

/**
 * Whether an error means the database is not there, rather than that a query
 * was wrong.
 *
 * The difference decides what somebody is told. "Something went wrong" sends
 * them reading logs; "the database is not reachable" sends them to the one
 * container that needs starting.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const code = 'code' in error ? error.code : undefined;

  if (typeof code === 'string' && (UNREACHABLE_CODES.has(code) || code.startsWith('08'))) {
    return true;
  }

  // A connection refused to every address a host resolves to arrives as an
  // AggregateError, whose own code is sometimes missing.
  if (error instanceof AggregateError) return error.errors.some(isDatabaseUnavailable);

  // node-postgres words these rather than coding them.
  const message = error instanceof Error ? error.message : '';

  return (
    message.includes('timeout exceeded when trying to connect') ||
    message.startsWith('Connection terminated')
  );
}

/**
 * Checks that the database is reachable and answering.
 *
 * Used at startup to turn "nothing works and nobody knows why" into one clear
 * line in the log.
 */
export async function ping(): Promise<void> {
  await getPool().query('SELECT 1');
}

/** Closes every pooled connection. Used by tests and on shutdown. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;

  await current?.end();
}

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL']?.trim();

  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and point it at your PostgreSQL instance.',
    );
  }

  return url;
}
