import { type Context, Hono } from 'hono';

import {
  DEFAULT_ERROR_LIMIT,
  getFilterOptions,
  getRecentFailures,
  getSummary,
  getTimeseries,
  getLatencyDistribution,
  getToolStats,
  getUnknownTools,
  MAX_UNKNOWN_TOOLS,
  isToolSort,
  MAX_ERROR_LIMIT,
  type ToolSort,
} from '../analytics.ts';
import { chooseBucketSeconds } from '../buckets.ts';
import { getCall, isCallKind, isOutcome, listCalls } from '../calls.ts';
import { getClientsOverTime } from '../clients.ts';
import { decodeCursor, parsePage } from '../paging.ts';
import { csvLine, exportCalls, exportFileName, serverName } from '../export.ts';
import { type Filters, parseFilters } from '../filters.ts';
import { requireSession, resolveServerId, type SessionVariables } from '../session.ts';
import { getSessionCalls, getSessions, getTransitions } from '../sessions.ts';
import { getToolDetails } from '../tool-details.ts';
import { getVersions } from '../versions.ts';
import { parseTimeRange, type TimeRange } from '../time-range.ts';

type DashboardContext = Context<{ Variables: SessionVariables }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the dashboard reads.
 *
 * Every route here answers for one server over one window, and works out both
 * the same way, so the frontend can treat them interchangeably.
 */
export function createDashboardRoutes() {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession());

  app.get('/summary', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    return c.json({
      range: describeRange(scope.range),
      ...(await getSummary(scope.serverId, scope.range, scope.filters)),
    });
  });

  app.get('/timeseries', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const bucketSeconds = chooseBucketSeconds(scope.range);

    return c.json({
      range: describeRange(scope.range),
      // Reported back because the caller did not choose it and the axis has to
      // be labelled with something.
      bucketSeconds,
      points: await getTimeseries(scope.serverId, scope.range, bucketSeconds, scope.filters),
    });
  });

  app.get('/clients', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const page = parsePage((name) => c.req.query(name), { limit: 12, max: 100 });

    if ('error' in page) return c.json({ error: page.error }, 400);

    const all = await getClientsOverTime(
      scope.serverId,
      scope.range,
      chooseBucketSeconds(scope.range),
      scope.filters,
    );

    return c.json({
      range: describeRange(scope.range),
      ...all,
      clients: all.clients.slice(page.offset, page.offset + page.limit),
      ...describePage(page, all.clients.length),
    });
  });

  app.get('/tools', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const requested = c.req.query('sort');

    if (requested !== undefined && !isToolSort(requested)) {
      return c.json({ error: `'sort' must be calls, errors, duration or name` }, 400);
    }

    const sort: ToolSort = requested === undefined ? 'calls' : requested;
    const page = parsePage((name) => c.req.query(name), { limit: 200, max: 200 });

    if ('error' in page) return c.json({ error: page.error }, 400);

    // Ranked in full and then cut, because the ranking is computed in memory
    // for every sort; the total comes for free that way.
    const all = await getToolStats(scope.serverId, scope.range, scope.filters, sort);

    return c.json({
      range: describeRange(scope.range),
      sort,
      tools: all.slice(page.offset, page.offset + page.limit),
      ...describePage(page, all.length),
    });
  });

  app.get('/filters', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    return c.json({
      range: describeRange(scope.range),
      ...(await getFilterOptions(scope.serverId, scope.range)),
    });
  });

  app.get('/unknown-tools', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const page = parsePage((name) => c.req.query(name), { limit: 50, max: 200 });

    if ('error' in page) return c.json({ error: page.error }, 400);

    return c.json({
      range: describeRange(scope.range),
      ...(await getUnknownTools(scope.serverId, scope.range, page)),
      offset: page.offset,
      limit: page.limit,
    });
  });

  /**
   * What agents read and asked for besides tools: resources by URI or URI
   * template, prompts by name, each ranked like the tools, and the ones asked
   * for that the server does not have. Filtered by client only, since a tool
   * filter names nothing here.
   */
  // Tool calls by the version of the server that answered them.
  app.get('/versions', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    return c.json({
      range: describeRange(scope.range),
      ...(await getVersions(scope.serverId, scope.range, scope.filters)),
    });
  });

  app.get('/resources-and-prompts', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const filters = scope.filters.clientType === undefined ? {} : { clientType: scope.filters.clientType };
    const unknownPage = { offset: 0, limit: MAX_UNKNOWN_TOOLS };
    const [resources, prompts, unknownResources, unknownPrompts] = await Promise.all([
      getToolStats(scope.serverId, scope.range, filters, 'calls', 'resource'),
      getToolStats(scope.serverId, scope.range, filters, 'calls', 'prompt'),
      getUnknownTools(scope.serverId, scope.range, unknownPage, 'resource'),
      getUnknownTools(scope.serverId, scope.range, unknownPage, 'prompt'),
    ]);
    const named = ({ toolName, ...rest }: { toolName: string }) => ({ name: toolName, ...rest });

    return c.json({
      range: describeRange(scope.range),
      resources: resources.map(named),
      prompts: prompts.map(named),
      unknownResources: unknownResources.tools.map(named),
      unknownPrompts: unknownPrompts.tools.map(named),
    });
  });

  app.get('/latency', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    return c.json({
      range: describeRange(scope.range),
      ...(await getLatencyDistribution(scope.serverId, scope.range, scope.filters)),
    });
  });

  app.get('/tool-details', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    // The tool comes through the same filter every other route reads, so a
    // link carrying it works here unchanged.
    const toolName = scope.filters.toolName;

    if (toolName === undefined) {
      return c.json({ error: "Name the tool with 'toolName'" }, 400);
    }

    const read = (name: string) => c.req.query(name);
    const messages = parsePage(read, { limit: 10, max: 100 }, 'messages');
    const parameters = parsePage(read, { limit: 50, max: 200 }, 'parameters');

    if ('error' in messages) return c.json({ error: messages.error }, 400);
    if ('error' in parameters) return c.json({ error: parameters.error }, 400);

    return c.json({
      range: describeRange(scope.range),
      toolName,
      ...(await getToolDetails(scope.serverId, toolName, scope.range, undefined, {
        messages,
        parameters,
      })),
      messagesOffset: messages.offset,
      parametersOffset: parameters.offset,
    });
  });

  app.get('/sessions', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const page = parsePage((name) => c.req.query(name), { limit: 50, max: 200 });

    if ('error' in page) return c.json({ error: page.error }, 400);

    return c.json({
      range: describeRange(scope.range),
      ...(await getSessions(scope.serverId, scope.range, undefined, page)),
      offset: page.offset,
      limit: page.limit,
    });
  });

  app.get('/sessions/:sessionId', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const sessionId = c.req.param('sessionId');

    // Checked before it reaches the database, which would refuse anything
    // that is not a UUID with an error rather than an empty answer.
    if (!UUID.test(sessionId)) {
      return c.json({ error: 'A session is identified by a UUID' }, 400);
    }

    const after = decodeCursor(c.req.query('after'));

    if (after !== undefined && 'error' in after) return c.json({ error: after.error }, 400);

    return c.json({
      range: describeRange(scope.range),
      sessionId,
      ...(await getSessionCalls(scope.serverId, sessionId, scope.range, after)),
    });
  });

  app.get('/transitions', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const page = parsePage((name) => c.req.query(name), { limit: 30, max: 200 });

    if ('error' in page) return c.json({ error: page.error }, 400);

    return c.json({
      range: describeRange(scope.range),
      ...(await getTransitions(scope.serverId, scope.range, undefined, page)),
      offset: page.offset,
      limit: page.limit,
    });
  });

  /**
   * Every call in the window, streamed, as CSV or as one JSON object a line.
   *
   * The same window and filters as the view it was asked from, so a download
   * from a filtered page holds what that page was about. `failedOnly` is the
   * errors page's own narrowing.
   */
  app.get('/export/calls', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const format = c.req.query('format') ?? 'csv';

    if (format !== 'csv' && format !== 'ndjson') {
      return c.json({ error: "'format' must be csv or ndjson" }, 400);
    }

    const failedOnly = c.req.query('failedOnly') === 'true';
    const name = exportFileName(
      await serverName(scope.serverId),
      scope.range,
      failedOnly ? 'failed-calls' : 'calls',
      format,
    );

    return new Response(
      exportCalls(scope.serverId, scope.range, scope.filters, format, { failedOnly }),
      {
        headers: {
          'content-type':
            format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
          'content-disposition': `attachment; filename="${name}"`,
          // A download can be long, and a proxy that buffers it whole to be
          // helpful would bring back the memory problem streaming avoids.
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        },
      },
    );
  });

  /** The tool table, as CSV, from the very query that draws it. */
  app.get('/export/tools', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const requested = c.req.query('sort');

    if (requested !== undefined && !isToolSort(requested)) {
      return c.json({ error: `'sort' must be calls, errors, duration or name` }, 400);
    }

    const sort: ToolSort = requested ?? 'calls';
    const tools = await getToolStats(scope.serverId, scope.range, scope.filters, sort);
    const rows = [
      csvLine(['tool_name', 'calls', 'errors', 'error_rate', 'mean_ms', 'p50_ms', 'p95_ms']),
      ...tools.map((tool) =>
        csvLine([
          tool.toolName,
          tool.calls,
          tool.errors,
          tool.errorRate,
          tool.durationMs.mean,
          tool.durationMs.p50,
          tool.durationMs.p95,
        ]),
      ),
    ];

    return new Response(rows.join(''), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${exportFileName(
          await serverName(scope.serverId),
          scope.range,
          'tools',
          'csv',
        )}"`,
      },
    });
  });

  app.get('/errors', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const limit = parseLimit(c.req.query('limit'));
    const before = decodeCursor(c.req.query('before'));

    if (before !== undefined && 'error' in before) return c.json({ error: before.error }, 400);

    if ('error' in limit) return c.json({ error: limit.error }, 400);

    return c.json({
      range: describeRange(scope.range),
      limit: limit.value,
      ...(await getRecentFailures(
        scope.serverId,
        scope.range,
        limit.value,
        scope.filters,
        before,
      )),
    });
  });

  // Every call in the window, newest first, of every kind unless narrowed.
  app.get('/calls', async (c) => {
    const scope = resolveScope(c);

    if ('error' in scope) return c.json({ error: scope.error }, scope.status);

    const limit = parseLimit(c.req.query('limit'));
    const before = decodeCursor(c.req.query('before'));
    const outcome = c.req.query('outcome') ?? 'all';
    const kind = c.req.query('kind');
    const serverVersion = c.req.query('serverVersion');

    if (before !== undefined && 'error' in before) return c.json({ error: before.error }, 400);
    if ('error' in limit) return c.json({ error: limit.error }, 400);
    if (!isOutcome(outcome)) return c.json({ error: `'outcome' must be all, failed or succeeded` }, 400);
    if (kind !== undefined && !isCallKind(kind)) {
      return c.json({ error: `'kind' must be tool, resource or prompt` }, 400);
    }

    return c.json({
      range: describeRange(scope.range),
      limit: limit.value,
      ...(await listCalls(scope.serverId, scope.range, limit.value, scope.filters, before, {
        outcome,
        ...(kind === undefined ? {} : { kind }),
        ...(serverVersion === undefined ? {} : { serverVersion }),
      })),
    });
  });

  // One call, with everything recorded about it. Only on a server the session
  // covers; the same 404 whether the call does not exist or is someone else's.
  app.get('/calls/:id', async (c) => {
    const server = resolveServerId(c);

    if ('error' in server) return c.json({ error: server.error }, server.status);

    const id = c.req.param('id');

    if (!UUID.test(id)) return c.json({ error: 'Not a call identifier' }, 400);

    const call = await getCall(server.serverId, id);

    return call === null ? c.json({ error: 'No such call' }, 404) : c.json({ call });
  });

  return app;
}

/**
 * Reads how many failures to return.
 *
 * A limit above the ceiling is refused rather than quietly reduced. Silently
 * returning two hundred rows to someone who asked for a thousand looks like a
 * server with two hundred failures, and they would have no way to tell.
 */
function parseLimit(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined) return { value: DEFAULT_ERROR_LIMIT };

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    return { error: `'limit' must be a whole number above zero, received ${raw}` };
  }

  if (value > MAX_ERROR_LIMIT) {
    return { error: `'limit' cannot be above ${MAX_ERROR_LIMIT}, received ${raw}` };
  }

  return { value };
}

/**
 * Works out which server and which window, or why neither can be had.
 *
 * Shared by every route so that a question asked of one endpoint is answered
 * the same way by all of them.
 */
function resolveScope(
  c: DashboardContext,
):
  | { serverId: string; range: TimeRange; filters: Filters }
  | { error: string; status: 400 | 403 } {
  const server = resolveServerId(c);

  if ('error' in server) return server;

  const range = parseTimeRange({ from: c.req.query('from'), to: c.req.query('to') });

  if ('error' in range) return { error: range.error, status: 400 };

  const filters = parseFilters({
    toolName: c.req.query('toolName'),
    clientType: c.req.query('clientType'),
    errorSource: c.req.query('errorSource'),
  });

  if ('error' in filters) return { error: filters.error, status: 400 };

  return { serverId: server.serverId, range, filters };
}

/** Echoes the window back, so a caller can see what its defaults resolved to. */
/** Where a page sits in a list whose length is known. */
function describePage(
  page: { offset: number; limit: number },
  total: number,
): { offset: number; limit: number; total: number; hasMore: boolean } {
  return { ...page, total, hasMore: page.offset + page.limit < total };
}

function describeRange(range: TimeRange): { from: string; to: string } {
  return { from: range.from.toISOString(), to: range.to.toISOString() };
}
