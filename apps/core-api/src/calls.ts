import { getPool } from './db.ts';
import { filterClause, type Filters } from './filters.ts';
import { type Cursor, encodeCursor } from './paging.ts';
import { CALL_TABLES, type CallKind } from './rollup.ts';
import type { TimeRange } from './time-range.ts';

/** Which calls a list holds, by how they ended. */
export type Outcome = 'all' | 'failed' | 'succeeded';

export const OUTCOMES: readonly Outcome[] = ['all', 'failed', 'succeeded'];

export function isOutcome(value: string): value is Outcome {
  return (OUTCOMES as readonly string[]).includes(value);
}

export function isCallKind(value: string): value is CallKind {
  return value in CALL_TABLES;
}

/** One call, as a list shows it. */
export interface CallRecord {
  id: string;
  occurredAt: string;
  /** A tool call, a resource read or a prompt get. */
  kind: CallKind;
  /** The tool's name, the resource's URI or template, or the prompt's name. */
  toolName: string;
  durationMs: number;
  success: boolean;
  errorSource: string | null;
  errorType: string | null;
  errorMessage: string | null;
  clientType: string;
  clientName: string | null;
  sessionId: string | null;
  /** As the server gives itself in its handshake, or as the SDK was told. */
  serverVersion: string | null;
  clientVersion: string | null;
  /** Its arguments were the previous call's to the same tool in the session: an agent looping (contract, 3.9). */
  repeated: boolean;
}

/** One call with everything recorded about it. Parameter values are never stored, so never here. */
export interface CallDetail extends CallRecord {
  /** When the API stored it, by its own clock, for the delay from the reporting machine. */
  receivedAt: string;
  sdkVersion: string;
  /** Size of the answer in bytes, when the SDK measured one (from 0.2.0, and only for calls that answered). */
  responseBytes: number | null;
  /** Names and JSON types of what was sent, when the SDK was asked to record them. */
  parameters: Record<string, string> | null;
  /** For refused arguments: which ones did not match the tool's schema, by declared name (contract, 3.10). */
  invalidArguments: string[] | null;
}

const LIST_COLUMNS = `id, occurred_at, duration_ms, success, error_source, error_type, error_message,
  client_type, client_name, session_id, server_version, client_version, repeated`;

interface CallRow {
  id: string;
  kind: CallKind;
  occurred_at: Date;
  tool_name: string;
  duration_ms: string;
  success: boolean;
  error_source: string | null;
  error_type: string | null;
  error_message: string | null;
  client_type: string;
  client_name: string | null;
  session_id: string | null;
  server_version: string | null;
  client_version: string | null;
  repeated: boolean | null;
}

/**
 * The newest calls in a window, of every kind unless narrowed, newest first.
 *
 * A tool filter narrows the list to that tool, which leaves resources and
 * prompts out. Ordering falls back to the identifier when two calls share an
 * instant: batched telemetry makes that common rather than rare, and without a
 * tie break the same query could answer in a different order each time.
 */
export async function listCalls(
  serverId: string,
  range: TimeRange,
  limit: number,
  filters: Filters,
  before: Cursor | undefined,
  options: { outcome: Outcome; kind?: CallKind; serverVersion?: string },
): Promise<{ calls: CallRecord[]; nextCursor: string | null }> {
  const params: unknown[] = [serverId, range.from, range.to];

  let resume = '';

  if (before !== undefined) {
    params.push(before.at, before.id);
    const at = params.length - 1;
    resume = `AND (occurred_at, id) < ($${at}::timestamptz, $${at + 1})`;
  }

  // One more than asked for, to know whether there is a next page without
  // counting every call in the window.
  params.push(limit + 1);
  const limitAt = params.length;

  const outcome =
    options.outcome === 'failed' ? 'AND NOT success' : options.outcome === 'succeeded' ? 'AND success' : '';

  let version = '';
  if (options.serverVersion !== undefined) {
    params.push(options.serverVersion);
    version = `AND server_version = $${params.length}`;
  }

  const kinds = (Object.keys(CALL_TABLES) as CallKind[]).filter(
    (kind) =>
      (options.kind === undefined || kind === options.kind) &&
      (filters.toolName === undefined || kind === 'tool'),
  );
  if (kinds.length === 0) return { calls: [], nextCursor: null };

  const parts = kinds.map((kind) => {
    const table = CALL_TABLES[kind];
    // Calls to names the server does not have are calls like any other here:
    // this is the list somebody reads to see what happened, call by call.
    const where = filterClause(filters, params, {
      includeErrorSource: true,
      includeUnknownTools: true,
      nameColumn: table.name,
    });

    return `(SELECT ${LIST_COLUMNS}, '${kind}' AS kind, ${table.name} AS tool_name,
            occurred_at::text AS cursor_at
     FROM ${table.raw}
     WHERE server_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       ${outcome}
       ${version}
       ${where}
       ${resume}
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${limitAt})`;
  });

  const result = await getPool().query<CallRow & { cursor_at: string }>(
    `SELECT * FROM (${parts.join('\n     UNION ALL\n     ')}) AS calls
     ORDER BY occurred_at DESC, id DESC
     LIMIT $${limitAt}`,
    params,
  );

  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);

  return {
    calls: rows.map(toRecord),
    nextCursor:
      result.rows.length > limit && last !== undefined ? encodeCursor({ at: last.cursor_at, id: last.id }) : null,
  };
}

/** One call by its id, on this server only; null when there is none. */
export async function getCall(serverId: string, id: string): Promise<CallDetail | null> {
  const parts = (Object.keys(CALL_TABLES) as CallKind[]).map((kind) => {
    const table = CALL_TABLES[kind];

    return `SELECT ${LIST_COLUMNS}, '${kind}' AS kind, ${table.name} AS tool_name,
            received_at, sdk_version, parameters, response_bytes, invalid_arguments
     FROM ${table.raw}
     WHERE server_id = $1 AND id = $2`;
  });

  const result = await getPool().query<
    CallRow & {
      received_at: Date;
      sdk_version: string;
      parameters: Record<string, string> | null;
      response_bytes: number | null;
      invalid_arguments: string[] | null;
    }
  >(`${parts.join(' UNION ALL ')} LIMIT 1`, [serverId, id]);

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    ...toRecord(row),
    receivedAt: row.received_at.toISOString(),
    sdkVersion: row.sdk_version,
    responseBytes: row.response_bytes,
    parameters: row.parameters,
    invalidArguments: row.invalid_arguments,
  };
}

function toRecord(row: CallRow): CallRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    kind: row.kind,
    toolName: row.tool_name,
    durationMs: Number(row.duration_ms),
    success: row.success,
    errorSource: row.error_source,
    errorType: row.error_type,
    errorMessage: row.error_message,
    clientType: row.client_type,
    clientName: row.client_name,
    sessionId: row.session_id,
    serverVersion: row.server_version,
    clientVersion: row.client_version,
    repeated: row.repeated === true,
  };
}
