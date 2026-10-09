import { getPool } from './db.ts';
import { filterClause, type Filters } from './filters.ts';
import { CALL_TABLES, type CallKind } from './rollup.ts';
import type { TimeRange } from './time-range.ts';

/**
 * Rows read per round trip while exporting.
 *
 * An export is streamed rather than built up in memory: ninety days of a busy
 * server is tens of millions of rows, and holding them to write one response
 * would take the API down with the request. Pages are read by keyset, each
 * starting after the last row of the one before, so the tenth page costs the
 * same as the first.
 */
const PAGE_SIZE = 5_000;

export type ExportFormat = 'csv' | 'ndjson';

/** The columns of an exported call, in order. Values of parameters are never stored. */
const CALL_COLUMNS = [
  'id',
  'occurred_at',
  'received_at',
  'tool_name',
  'duration_ms',
  'success',
  'error_source',
  'error_type',
  'error_message',
  'client_type',
  'client_name',
  'sdk_version',
  'session_id',
  'parameters',
  // Last, so a script that reads the columns by position reads the ones it knew as before.
  'kind',
  'server_version',
  'client_version',
  'response_bytes',
  'repeated',
  'invalid_arguments',
] as const;

interface CallRow {
  id: string;
  kind: CallKind;
  /** The exact instant as PostgreSQL holds it, to resume paging from. */
  resume_at: string;
  occurred_at: Date;
  received_at: Date;
  tool_name: string;
  duration_ms: number;
  success: boolean;
  error_source: string | null;
  error_type: string | null;
  error_message: string | null;
  client_type: string;
  client_name: string | null;
  sdk_version: string;
  session_id: string | null;
  parameters: Record<string, string> | null;
  server_version: string | null;
  client_version: string | null;
  response_bytes: number | null;
  repeated: boolean | null;
  invalid_arguments: string[] | null;
}

/**
 * Every recorded call in a window, oldest first, as text ready to send.
 *
 * Tool calls, resource reads and prompt gets together, `kind` saying which,
 * with the name of what was called in `tool_name` as the event carries it. A
 * tool filter narrows the export to that tool, which leaves the others out.
 *
 * Includes calls to names the server does not have, which the dashboard keeps
 * apart: this is the raw record, and `error_source` says which ones they are.
 * Filters narrow it the same way they narrow every view, so an export taken
 * from a filtered page holds what that page was about.
 */
export function exportCalls(
  serverId: string,
  range: TimeRange,
  filters: Filters,
  format: ExportFormat,
  options: { failedOnly?: boolean } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Kept as PostgreSQL's own text for the instant. A Date holds milliseconds
  // and the column holds microseconds, so resuming from a Date lands before
  // the last row read and reads the page again - forever, for rows that share
  // a millisecond. Found by exporting twelve thousand rows written in one
  // statement, which ran the process out of memory.
  let after: { at: string; id: string } | undefined;
  let started = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          if (format === 'csv') controller.enqueue(encoder.encode(csvLine([...CALL_COLUMNS])));
        }

        const params: unknown[] = [serverId, range.from, range.to];

        let resume = '';

        if (after !== undefined) {
          params.push(after.at, after.id);
          const at = params.length - 1;
          resume = `AND (occurred_at, id) > ($${at}::timestamptz, $${at + 1})`;
        }

        params.push(PAGE_SIZE);
        const limitAt = params.length;

        const kinds = (Object.keys(CALL_TABLES) as CallKind[]).filter(
          (kind) => filters.toolName === undefined || kind === 'tool',
        );
        const parts = kinds.map((kind) => {
          const table = CALL_TABLES[kind];
          const where = filterClause(filters, params, {
            includeErrorSource: true,
            includeUnknownTools: true,
            nameColumn: table.name,
          });
          const columns = CALL_COLUMNS.map((column) =>
            column === 'kind' ? `'${kind}' AS kind` : column === 'tool_name' ? `${table.name} AS tool_name` : column,
          );

          return `(SELECT ${columns.join(', ')}, occurred_at::text AS resume_at
           FROM ${table.raw}
           WHERE server_id = $1
             AND occurred_at >= $2
             AND occurred_at < $3
             ${options.failedOnly === true ? 'AND NOT success' : ''}
             ${where}
             ${resume}
           ORDER BY occurred_at, id
           LIMIT $${limitAt})`;
        });

        const page = await getPool().query<CallRow>(
          `SELECT * FROM (${parts.join(' UNION ALL ')}) AS calls
           ORDER BY occurred_at, id
           LIMIT $${limitAt}`,
          params,
        );

        const text = page.rows
          .map((row) => (format === 'csv' ? csvLine(callValues(row)) : ndjsonLine(row)))
          .join('');

        if (text.length > 0) controller.enqueue(encoder.encode(text));

        const last = page.rows.at(-1);

        if (last === undefined || page.rows.length < PAGE_SIZE) {
          controller.close();
          return;
        }

        after = { at: last.resume_at, id: last.id };
      } catch (error) {
        // Headers are gone by now, so the only honest signal left is a broken
        // stream: a file that ends early and says nothing would be read as
        // complete.
        controller.error(error);
      }
    },
  });
}

function callValues(row: CallRow): (string | number | boolean | null)[] {
  return [
    row.id,
    row.occurred_at.toISOString(),
    row.received_at.toISOString(),
    row.tool_name,
    row.duration_ms,
    row.success,
    row.error_source,
    row.error_type,
    row.error_message,
    row.client_type,
    row.client_name,
    row.sdk_version,
    row.session_id,
    row.parameters === null ? null : JSON.stringify(row.parameters),
    row.kind,
    row.server_version,
    row.client_version,
    row.response_bytes,
    row.repeated === true,
    row.invalid_arguments === null ? null : JSON.stringify(row.invalid_arguments),
  ];
}

function ndjsonLine(row: CallRow): string {
  return `${JSON.stringify({
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    toolName: row.tool_name,
    durationMs: row.duration_ms,
    success: row.success,
    errorSource: row.error_source,
    errorType: row.error_type,
    errorMessage: row.error_message,
    clientType: row.client_type,
    clientName: row.client_name,
    sdkVersion: row.sdk_version,
    sessionId: row.session_id,
    parameters: row.parameters,
    serverVersion: row.server_version,
    clientVersion: row.client_version,
    responseBytes: row.response_bytes,
    repeated: row.repeated === true,
    invalidArguments: row.invalid_arguments,
  })}\n`;
}

/**
 * One CSV record, RFC 4180, ending in CRLF.
 *
 * Text that a spreadsheet would read as a formula is prefixed with an
 * apostrophe. Tool names and error messages arrive from outside, and a cell
 * starting with "=" is executed when the file is opened, which is a known way
 * to run somebody's formula on somebody else's machine.
 */
export function csvLine(values: readonly (string | number | boolean | null)[]): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

function csvField(value: string | number | boolean | null): string {
  if (value === null) return '';
  if (typeof value !== 'string') return String(value);

  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;

  const needsQuotes = /[",\r\n]/.test(safe) || safe !== safe.trim();

  return needsQuotes ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** A file name that says what is in it: server, window, and kind. */
export function exportFileName(
  serverName: string,
  range: TimeRange,
  kind: string,
  extension: string,
): string {
  const slug =
    serverName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'server';
  const day = (date: Date) => date.toISOString().slice(0, 10);

  return `mcpspan-${slug}-${kind}-${day(range.from)}-to-${day(range.to)}.${extension}`;
}

/** A server's name, for naming its file. */
export async function serverName(serverId: string): Promise<string> {
  const result = await getPool().query<{ name: string }>(
    'SELECT name FROM servers WHERE id = $1',
    [serverId],
  );

  return result.rows[0]?.name ?? 'server';
}
