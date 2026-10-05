import { getPool } from './db.ts';
import type { ToolCallEventInput } from './events-schema.ts';
import { CALL_TABLES, type CallKind } from './rollup.ts';

/**
 * Writes a batch, skipping anything already stored.
 *
 * Each kind of call goes to its own table, in one statement per kind built
 * from column arrays rather than from a row of placeholders per event. Placeholders would mean fifteen
 * parameters per event, which at the batch limit is fifteen thousand of them
 * in a single statement and a query text to match; arrays keep it at fifteen
 * parameters whatever the batch size, and PostgreSQL expands them server side.
 *
 * `ON CONFLICT DO NOTHING` is what makes redelivery harmless. The SDK resends
 * a batch whose acknowledgement went missing, and without this a flaky network
 * would inflate the very numbers this product exists to report.
 *
 * The server comes from the caller, never from an event. That is the whole
 * reason the column is not in the request schema.
 *
 * An event of a kind this API does not know is not stored anywhere.
 *
 * @returns the events that were new; the rest were copies of events already
 *   held, or of a kind not stored.
 */
export async function insertEvents(
  serverId: string,
  events: readonly ToolCallEventInput[],
): Promise<ToolCallEventInput[]> {
  const stored: ToolCallEventInput[] = [];

  for (const kind of Object.keys(CALL_TABLES) as CallKind[]) {
    const ofKind = events.filter((event) => (event.kind ?? 'tool') === kind);
    if (ofKind.length === 0) continue;

    const ids = await insertInto(serverId, kind, ofKind);
    // PostgreSQL gives a UUID back in lower case, whatever case it arrived in,
    // and a copy repeated within the batch comes back once.
    for (const event of ofKind) {
      if (ids.delete(event.id.toLowerCase())) stored.push(event);
    }
  }

  await noteVersions(serverId, events);
  await noteDefinitions(serverId, events);

  return stored;
}

/**
 * Keeps when each definition of each tool was first and last seen (contract,
 * 3.8), from the whole batch for the same reason as versions. Only tool calls
 * carry one; a fingerprint on anything else is ignored rather than refused.
 */
async function noteDefinitions(serverId: string, events: readonly ToolCallEventInput[]): Promise<void> {
  const seen = new Map<string, { tool: string; hash: string; first: string; last: string }>();

  for (const event of events) {
    if (event.definitionHash === undefined || event.definitionHash === '') continue;
    if ((event.kind ?? 'tool') !== 'tool' || event.errorSource === 'unknown_tool') continue;
    const at = new Date(event.timestamp).toISOString();
    const key = JSON.stringify([event.toolName, event.definitionHash]);
    const known = seen.get(key);
    seen.set(key, {
      tool: event.toolName,
      hash: event.definitionHash,
      first: known === undefined || at < known.first ? at : known.first,
      last: known === undefined || at > known.last ? at : known.last,
    });
  }

  if (seen.size === 0) return;

  const rows = [...seen.values()];
  await getPool().query(
    `INSERT INTO tool_definitions (server_id, tool_name, hash, first_seen_at, last_seen_at)
     SELECT $1::uuid, tool_name, hash, first_seen_at, last_seen_at
     FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[])
       AS seen (tool_name, hash, first_seen_at, last_seen_at)
     ON CONFLICT (server_id, tool_name, hash) DO UPDATE SET
       first_seen_at = LEAST(tool_definitions.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(tool_definitions.last_seen_at, EXCLUDED.last_seen_at)`,
    [
      serverId,
      rows.map((row) => row.tool),
      rows.map((row) => row.hash),
      rows.map((row) => row.first),
      rows.map((row) => row.last),
    ],
  );
}

/**
 * Keeps when each server version was first and last seen.
 *
 * From the whole batch, not only what was new: a batch resent after a failure
 * here has nothing new, and its versions still have to be noted. Widening a
 * range to the same bounds changes nothing, so doing it twice is harmless.
 */
async function noteVersions(serverId: string, events: readonly ToolCallEventInput[]): Promise<void> {
  const seen = new Map<string, { first: string; last: string }>();

  for (const event of events) {
    if (event.serverVersion === undefined || event.serverVersion === '') continue;
    const at = new Date(event.timestamp).toISOString();
    const known = seen.get(event.serverVersion);
    seen.set(event.serverVersion, {
      first: known === undefined || at < known.first ? at : known.first,
      last: known === undefined || at > known.last ? at : known.last,
    });
  }

  if (seen.size === 0) return;

  await getPool().query(
    `INSERT INTO server_versions (server_id, version, first_seen_at, last_seen_at)
     SELECT $1::uuid, version, first_seen_at, last_seen_at
     FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[]) AS seen (version, first_seen_at, last_seen_at)
     ON CONFLICT (server_id, version) DO UPDATE SET
       first_seen_at = LEAST(server_versions.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(server_versions.last_seen_at, EXCLUDED.last_seen_at)`,
    [
      serverId,
      [...seen.keys()],
      [...seen.values()].map((range) => range.first),
      [...seen.values()].map((range) => range.last),
    ],
  );
}

async function insertInto(
  serverId: string,
  kind: CallKind,
  events: readonly ToolCallEventInput[],
): Promise<Set<string>> {
  const { raw, name } = CALL_TABLES[kind];

  const result = await getPool().query<{ id: string }>(
    `INSERT INTO ${raw} (
       id, server_id, occurred_at, ${name}, duration_ms, success,
       error_source, error_type, error_message,
       client_type, client_name, sdk_version, parameters, session_id,
       client_version, server_version, response_bytes, repeated
     )
     SELECT
       id, $1::uuid, occurred_at, name, duration_ms, success,
       error_source, error_type, error_message,
       client_type, client_name, sdk_version, parameters, session_id,
       client_version, server_version, response_bytes, repeated
     FROM unnest(
       $2::uuid[], $3::timestamptz[], $4::text[], $5::double precision[], $6::boolean[],
       $7::text[], $8::text[], $9::text[],
       $10::text[], $11::text[], $12::text[], $13::jsonb[], $14::uuid[],
       $15::text[], $16::text[], $17::integer[], $18::boolean[]
     ) AS incoming (
       id, occurred_at, name, duration_ms, success,
       error_source, error_type, error_message,
       client_type, client_name, sdk_version, parameters, session_id,
       client_version, server_version, response_bytes, repeated
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      serverId,
      events.map((event) => event.id),
      events.map((event) => event.timestamp),
      events.map((event) => event.toolName),
      events.map((event) => event.durationMs),
      events.map((event) => event.success),
      events.map((event) => event.errorSource ?? null),
      events.map((event) => event.errorType ?? null),
      events.map((event) => event.errorMessage ?? null),
      events.map((event) => event.clientType),
      events.map((event) => event.clientName ?? null),
      events.map((event) => event.sdkVersion),
      events.map((event) => (event.parameters ? JSON.stringify(event.parameters) : null)),
      events.map((event) => event.sessionId ?? null),
      events.map((event) => event.clientVersion ?? null),
      events.map((event) => event.serverVersion ?? null),
      events.map((event) => event.responseBytes ?? null),
      // True or nothing: a false sent by some SDK means what nothing means.
      events.map((event) => (event.repeated === true ? true : null)),
    ],
  );

  return new Set(result.rows.map((row) => row.id));
}
