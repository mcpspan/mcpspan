import { getPool } from './db.ts';
import { filterClause, type Filters } from './filters.ts';
import { rateChange, type ReleaseSide, type Verdict } from './release.ts';
import type { TimeRange } from './time-range.ts';

/** Versions named per client, newest first; the rest are counted together. A client's last few are the ones asked about. */
const MAX_VERSIONS_PER_CLIENT = 5;

/** Clients returned at most; the SDKs fold names into a short list, so this is a ceiling, not a limit anybody meets. */
const MAX_CLIENTS = 100;

/**
 * Calls a tool needs from each of two versions, on the server versions both
 * called, before their refusals are compared. Fewer than a release's tools
 * need: a client's version is compared on part of its calls only, and a jump
 * like five percent to sixty is plain at a dozen.
 */
const MIN_TOOL_CALLS = 10;

/** Tools named per version that changed; the rest are in its calls. */
const MAX_CHANGED_TOOLS = 5;

/** A tool's arguments refused more or less often on a version than on the one before it. */
export interface ChangedTool {
  toolName: string;
  change: 'worse' | 'better';
  before: { calls: number; refused: number };
  after: { calls: number; refused: number };
}

export interface ClientVersion extends ReleaseSide {
  /** The name the client gives itself in its handshake, which its versions belong to. */
  clientName: string;
  version: string;
  /** Calls refused for their arguments. */
  refused: number;
  /** When this version first called this server, ever: before the window, for one already in use. */
  firstSeenAt: string;
  /** Its last call in the window. */
  lastSeenAt: string;
  /** First seen within the window. */
  isNew: boolean;
  /** The version of the same client before it that called in the window too, which it is compared with. */
  previous: string | null;
  /**
   * Against that one, by the tools whose arguments it gets refused more or
   * less often: 'first' when there is none to compare with, 'too-early' when
   * no tool has calls enough from both on the same server version.
   */
  verdict: Verdict;
  /** The tools that decided it, worse first. */
  changedTools: ChangedTool[];
  /** The server versions both were compared on. */
  comparedOn: string[];
}

export interface ClientVersions {
  clientType: string;
  /** Every version named, newest first, across the names the type holds. */
  versions: ClientVersion[];
  /** Calls from versions past the ones named. */
  olderCalls: number;
  /** Calls whose client gave no name or no version. */
  unversionedCalls: number;
}

/**
 * Tool calls in a window by the version of the client that made them, under
 * each client type.
 *
 * A client updates itself, and the server's author finds out from a change in
 * how agents call: this puts the versions side by side, and says whether the
 * newest of each client gets its arguments refused more often than the one
 * before it, tool by tool, on the server versions both called.
 *
 * From the raw rows, which the hourly rollup does not group by version; first
 * seen from client_versions, which outlives them.
 */
export async function getClientVersions(
  serverId: string,
  range: TimeRange,
  filters: Filters,
): Promise<ClientVersions[]> {
  const params: unknown[] = [serverId, range.from, range.to];
  const where = filterClause(filters, params);

  const result = await getPool().query<{
    client_type: string;
    client_name: string | null;
    version: string | null;
    calls: string;
    errors: string;
    refused: string;
    p50: number | null;
    p95: number | null;
    last_seen_at: Date;
    first_seen_at: Date | null;
  }>(
    `WITH windowed AS (
       SELECT coalesce(client_type, 'unknown') AS client_type,
              nullif(client_name, '') AS client_name,
              nullif(client_version, '') AS version,
              count(*) AS calls,
              count(*) FILTER (WHERE NOT success) AS errors,
              count(*) FILTER (WHERE error_source = 'arguments') AS refused,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
              max(occurred_at) AS last_seen_at
       FROM tool_calls
       WHERE server_id = $1
         AND occurred_at >= $2
         AND occurred_at < $3
         ${where}
       GROUP BY 1, 2, 3
     )
     SELECT windowed.*, known.first_seen_at
     FROM windowed
     LEFT JOIN client_versions AS known
       ON known.server_id = $1 AND known.client_name = windowed.client_name AND known.version = windowed.version
     ORDER BY windowed.client_type, known.first_seen_at DESC NULLS LAST, windowed.last_seen_at DESC`,
    params,
  );

  const windowStart = range.from.getTime();
  const byType = new Map<string, { versions: ClientVersion[]; unversionedCalls: number }>();

  for (const row of result.rows) {
    const entry = byType.get(row.client_type) ?? {
      versions: [],
      unversionedCalls: 0,
    };
    byType.set(row.client_type, entry);

    const calls = Number(row.calls);
    if (row.client_name === null || row.version === null) {
      entry.unversionedCalls += calls;
      continue;
    }

    const errors = Number(row.errors);
    const firstSeenAt = row.first_seen_at ?? row.last_seen_at;
    entry.versions.push({
      clientName: row.client_name,
      version: row.version,
      calls,
      errors,
      errorRate: calls === 0 ? 0 : errors / calls,
      refused: Number(row.refused),
      durationMs: { p50: row.p50, p95: row.p95 },
      firstSeenAt: firstSeenAt.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      isNew: firstSeenAt.getTime() >= windowStart,
      previous: null,
      verdict: 'first',
      changedTools: [],
      comparedOn: [],
    });
  }

  const usage = await toolUsage(serverId, range, filters);

  const clients: ClientVersions[] = [];
  for (const [clientType, entry] of byType) {
    // Each version against the one of the same client first seen before it, among those that called in the window.
    const byName = new Map<string, ClientVersion[]>();
    for (const version of entry.versions) {
      byName.set(version.clientName, [...(byName.get(version.clientName) ?? []), version]);
    }
    for (const versions of byName.values()) {
      versions.forEach((version, index) => {
        const previous = versions[index + 1];
        if (previous === undefined) return;
        version.previous = previous.version;
        Object.assign(version, compareVersions(usage, version.clientName, previous.version, version.version));
      });
    }

    const named = entry.versions.slice(0, MAX_VERSIONS_PER_CLIENT);
    clients.push({
      clientType,
      versions: named,
      olderCalls: entry.versions.slice(MAX_VERSIONS_PER_CLIENT).reduce((sum, version) => sum + version.calls, 0),
      unversionedCalls: entry.unversionedCalls,
    });
  }

  const total = (client: ClientVersions): number =>
    client.versions.reduce((sum, version) => sum + version.calls, client.olderCalls + client.unversionedCalls);

  return clients.sort((a, b) => total(b) - total(a)).slice(0, MAX_CLIENTS);
}

type Usage = Map<string, { calls: number; refused: number }>;

/** Calls and refusals by client, version, server version and tool: what versions are compared on. */
async function toolUsage(serverId: string, range: TimeRange, filters: Filters): Promise<Usage> {
  const params: unknown[] = [serverId, range.from, range.to];
  const where = filterClause(filters, params);
  const result = await getPool().query<{
    client_name: string;
    client_version: string;
    server_version: string;
    tool_name: string;
    calls: string;
    refused: string;
  }>(
    `SELECT client_name, client_version, server_version, tool_name,
            count(*) AS calls,
            count(*) FILTER (WHERE error_source = 'arguments') AS refused
     FROM tool_calls
     WHERE server_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
       AND coalesce(client_name, '') <> ''
       AND coalesce(client_version, '') <> ''
       AND coalesce(server_version, '') <> ''
       ${where}
     GROUP BY 1, 2, 3, 4`,
    params,
  );

  const usage: Usage = new Map();
  for (const row of result.rows) {
    usage.set(key(row.client_name, row.client_version, row.server_version, row.tool_name), {
      calls: Number(row.calls),
      refused: Number(row.refused),
    });
  }
  return usage;
}

function key(...parts: string[]): string {
  return JSON.stringify(parts);
}

/**
 * A client's version against the one before it, by how often each tool's
 * arguments are refused: what a client changes is what its agent sends, and a
 * change in it shows on a tool or two, which the share of all calls would
 * hide.
 *
 * Only on the server versions both called, and summed over them: a client
 * update and a server release in the same days would otherwise each take the
 * blame for the other. Failures the server makes (exceptions, error results)
 * and time are left out for the same reason.
 */
function compareVersions(
  usage: Usage,
  clientName: string,
  before: string,
  after: string,
): Pick<ClientVersion, 'verdict' | 'changedTools' | 'comparedOn'> {
  const sides = new Map<string, Set<string>>();
  for (const raw of usage.keys()) {
    const [name, version, server] = JSON.parse(raw) as [string, string, string, string];
    if (name !== clientName || (version !== before && version !== after)) continue;
    const seen = sides.get(server) ?? new Set<string>();
    seen.add(version);
    sides.set(server, seen);
  }
  const comparedOn = [...sides].filter(([, versions]) => versions.size === 2).map(([server]) => server);

  const tools = new Map<string, ChangedTool['before'][]>();
  for (const [raw, counts] of usage) {
    const [name, version, server, tool] = JSON.parse(raw) as [string, string, string, string];
    if (name !== clientName || !comparedOn.includes(server)) continue;
    if (version !== before && version !== after) continue;
    const pair = tools.get(tool) ?? [
      { calls: 0, refused: 0 },
      { calls: 0, refused: 0 },
    ];
    const side = pair[version === before ? 0 : 1]!;
    side.calls += counts.calls;
    side.refused += counts.refused;
    tools.set(tool, pair);
  }

  let compared = 0;
  const changedTools: ChangedTool[] = [];
  for (const [toolName, [was, now]] of tools) {
    if (was!.calls < MIN_TOOL_CALLS || now!.calls < MIN_TOOL_CALLS) continue;
    compared += 1;
    const change = rateChange(was!.refused, was!.calls, now!.refused, now!.calls);
    if (change !== 0) changedTools.push({ toolName, change: change > 0 ? 'worse' : 'better', before: was!, after: now! });
  }

  const rise = (tool: ChangedTool) => tool.after.refused / tool.after.calls - tool.before.refused / tool.before.calls;
  changedTools.sort((a, b) => rise(b) - rise(a));

  const verdict: Verdict =
    compared === 0
      ? 'too-early'
      : changedTools.some((tool) => tool.change === 'worse')
        ? 'worse'
        : changedTools.length > 0
          ? 'better'
          : 'same';

  return { verdict, changedTools: changedTools.slice(0, MAX_CHANGED_TOOLS), comparedOn };
}
