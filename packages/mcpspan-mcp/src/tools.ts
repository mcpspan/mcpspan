import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { type Api, ApiError, type Query } from './api.ts';

interface ServerRecord {
  id: string;
  name: string;
  createdAt: string;
  hasActiveKey: boolean;
}

interface Window {
  from: string;
  to: string;
}

/** Every tool here only reads, and reads only what its owner's dashboard shows. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const server = z
  .string()
  .optional()
  .describe('The MCP server to ask about, by name or id. Leave out when the account has only one.');
const days = z
  .number()
  .int()
  .min(1)
  .max(365)
  .optional()
  .describe('How many days back to look, ending now. 7 when left out. Ignored when from is given.');
const from = z.string().optional().describe('Start of the window, as an ISO 8601 date or time. Overrides days.');
const to = z.string().optional().describe('End of the window, as an ISO 8601 date or time. Now when left out.');
const client = z
  .string()
  .optional()
  .describe('Only calls from this client type, as list_clients names them, such as claude-code or cursor.');

const scope = { server, days, from, to };

/** The tools an agent gets, each answering from one or a few of the dashboard's endpoints. */
export function registerTools(mcp: McpServer, api: Api): void {
  mcp.registerTool(
    'list_servers',
    {
      title: 'List servers',
      description: 'The MCP servers this mcpspan account reports on, with their names and ids.',
      annotations: READ_ONLY,
    },
    () =>
      answer(async () => {
        const { servers } = await api.get<{ servers: ServerRecord[] }>('/v1/servers');

        return {
          servers: servers.map((s) => ({
            id: s.id,
            name: s.name,
            createdAt: s.createdAt,
            ...(s.hasActiveKey ? {} : { note: 'No API key: it cannot report until one is generated.' }),
          })),
        };
      }),
  );

  mcp.registerTool(
    'get_overview',
    {
      title: 'Overview',
      description:
        'Calls, failures, error rate, response times (median and 95th percentile) and the share of each client, for one server over a window.',
      inputSchema: z.object({ ...scope, client }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);

        return at.describe(await api.get('/v1/dashboard/summary', at.query({ clientType: args.client })));
      }),
  );

  mcp.registerTool(
    'list_tools',
    {
      title: 'List tools',
      description:
        "A server's tools ranked by calls, errors, response time or name, each with its calls, errors, error rate and response times.",
      inputSchema: z.object({
        ...scope,
        client,
        sort: z.enum(['calls', 'errors', 'duration', 'name']).optional().describe('How to rank them. calls when left out.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many to return. 20 when left out.'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const result = await api.get<{ sort: string; tools: unknown[]; total: number; hasMore: boolean }>(
          '/v1/dashboard/tools',
          at.query({ clientType: args.client, sort: args.sort, limit: args.limit ?? 20 }),
        );

        return at.describe({ sort: result.sort, total: result.total, tools: result.tools });
      }),
  );

  mcp.registerTool(
    'get_tool',
    {
      title: 'Tool details',
      description:
        'Everything recorded about one tool: why its calls failed and the commonest error messages, which arguments the server refused, its parameters, how large its answers are, when its definition changed, how often agents repeated a call, and which call came right before the ones that repeated or failed.',
      inputSchema: z.object({ ...scope, tool: z.string().describe("The tool's name, as list_tools gives it.") }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const details = await api.get<Record<string, unknown>>(
          '/v1/dashboard/tool-details',
          at.query({ toolName: args.tool, messagesLimit: 10, parametersLimit: 30, beforeLimit: 10 }),
        );

        return at.describe(
          pick(details, [
            'toolName',
            'failures',
            'messages',
            'refusedArguments',
            'parameters',
            'responseSizes',
            'definitionChanges',
            'repeats',
            'before',
          ]),
        );
      }),
  );

  mcp.registerTool(
    'list_errors',
    {
      title: 'List failed calls',
      description:
        'The most recent failed calls, newest first: which tool, which client, when, what kind of failure (a handler that threw, a tool that answered with an error, refused arguments, an unknown tool) and the error message when the server records them.',
      inputSchema: z.object({
        ...scope,
        client,
        tool: z.string().optional().describe('Only failures of this tool.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many to return. 20 when left out.'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const result = await api.get<{ failures: Record<string, unknown>[]; nextCursor: string | null }>(
          '/v1/dashboard/errors',
          at.query({ clientType: args.client, toolName: args.tool, limit: args.limit ?? 20 }),
        );

        return at.describe({
          failures: result.failures.map((call) =>
            pick(call, [
              'occurredAt',
              'kind',
              'toolName',
              'clientType',
              'clientName',
              'errorSource',
              'errorType',
              'errorMessage',
              'durationMs',
              'serverVersion',
              'sessionId',
              'repeated',
            ]),
          ),
          more: result.nextCursor !== null,
        });
      }),
  );

  mcp.registerTool(
    'list_unknown_tools',
    {
      title: 'List unknown tools',
      description:
        'Tools that agents asked for but the server does not have: how often, which clients, the closest tool the server does have, and what the agent did next.',
      inputSchema: z.object({ ...scope }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const result = await api.get<{ tools: unknown[]; hasMore: boolean }>(
          '/v1/dashboard/unknown-tools',
          at.query({ limit: 20 }),
        );

        return at.describe({ tools: result.tools, more: result.hasMore });
      }),
  );

  mcp.registerTool(
    'list_clients',
    {
      title: 'List clients',
      description:
        'The clients that called the server (Claude, Claude Code, Cursor, VS Code, ChatGPT and others), each with its calls, error rate and response times.',
      inputSchema: z.object({ ...scope }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const summary = await api.get<{ clients: { clientType: string; calls: number }[] }>(
          '/v1/dashboard/summary',
          at.query(),
        );
        const clients = await Promise.all(
          summary.clients.slice(0, 15).map(async ({ clientType }) => {
            const one = await api.get<Record<string, unknown>>(
              '/v1/dashboard/summary',
              at.query({ clientType }),
            );

            return { clientType, ...pick(one, ['totalCalls', 'failedCalls', 'errorRate', 'durationMs']) };
          }),
        );

        return at.describe({ clients });
      }),
  );

  mcp.registerTool(
    'compare_versions',
    {
      title: 'Compare versions',
      description:
        "The server's versions in the window, newest first, each with when it was first seen, its calls, error rate and response times: how a release compares with the one before.",
      inputSchema: z.object({ ...scope, client }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const result = await api.get<Record<string, unknown>>(
          '/v1/dashboard/versions',
          at.query({ clientType: args.client }),
        );

        return at.describe(pick(result, ['versions', 'unversionedCalls']));
      }),
  );

  mcp.registerTool(
    'get_tool_listing',
    {
      title: 'What agents are shown',
      description:
        'Every tool as agents were shown it when they listed the tools: in how many sessions, how many of those called it, and how large its definition is. Finds tools agents see but never use, and definitions that cost context.',
      inputSchema: z.object({ ...scope, client }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const result = await api.get<Record<string, unknown>>(
          '/v1/dashboard/listing',
          at.query({ clientType: args.client, listingLimit: 100 }),
        );

        return at.describe(omit(result, ['range', 'offset', 'limit']));
      }),
  );

  mcp.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description:
        'Recent sessions (one connection each), newest first, with their calls, failures, tools used and calls an agent repeated with the same arguments.',
      inputSchema: z.object({
        ...scope,
        client,
        tool: z.string().optional().describe('Only sessions that called this tool.'),
        with: z.enum(['failures', 'repeats']).optional().describe('Only sessions with failures, or with repeated calls.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many to return. 20 when left out.'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, args);
        const result = await api.get<{ sessions: unknown[]; hasMore: boolean; sampled: boolean }>(
          '/v1/dashboard/sessions',
          at.query({ clientType: args.client, toolName: args.tool, with: args.with, limit: args.limit ?? 20 }),
        );

        return at.describe({ sessions: result.sessions, more: result.hasMore, sampled: result.sampled });
      }),
  );

  mcp.registerTool(
    'get_session',
    {
      title: 'Session',
      description: "One session's calls in the order the agent made them, with each call's outcome and error.",
      inputSchema: z.object({
        ...scope,
        session: z.string().describe('The session id, as list_sessions or list_errors gives it.'),
      }),
      annotations: READ_ONLY,
    },
    (args) =>
      answer(async () => {
        const at = await locate(api, { ...args, days: args.days ?? 30 });
        const result = await api.get<{ calls: Record<string, unknown>[]; nextCursor: string | null }>(
          `/v1/dashboard/sessions/${encodeURIComponent(args.session)}`,
          at.query(),
        );

        return at.describe({
          sessionId: args.session,
          calls: result.calls.map((call) => omit(call, ['id'])),
          more: result.nextCursor !== null,
        });
      }),
  );
}

/**
 * Which server and which window a question is about, worked out once.
 *
 * The server is looked up by name as well as id, since that is how a person
 * names it; with only one, it can be left out, as in the dashboard.
 */
async function locate(
  api: Api,
  args: { server?: string | undefined; days?: number | undefined; from?: string | undefined; to?: string | undefined },
): Promise<{ query(extra?: Query): Query; describe(result: object): Record<string, unknown> }> {
  const { servers } = await api.get<{ servers: ServerRecord[] }>('/v1/servers');
  const chosen = pickServer(servers, args.server);
  const window = windowOf(args);

  return {
    query: (extra = {}) => ({ serverId: chosen.id, from: window.from, to: window.to, ...extra }),
    // The API's own echo of the window goes: the window is said once, first.
    describe: (result) => ({ server: chosen.name, window, ...omit(result as Record<string, unknown>, ['range']) }),
  };
}

export function pickServer(servers: ServerRecord[], wanted: string | undefined): ServerRecord {
  if (servers.length === 0) {
    throw new ApiError('This account has no servers yet. Add one in mcpspan and connect its SDK.');
  }

  const names = servers.map((s) => s.name).join(', ');

  if (wanted === undefined || wanted.trim().length === 0) {
    if (servers.length === 1) return servers[0] as ServerRecord;

    throw new ApiError(`This account has several servers; name one with server: ${names}.`);
  }

  const asked = wanted.trim().toLowerCase();
  const found =
    servers.find((s) => s.id === wanted.trim()) ??
    servers.find((s) => s.name.toLowerCase() === asked) ??
    onlyOne(servers.filter((s) => s.name.toLowerCase().includes(asked)));

  if (found === undefined) throw new ApiError(`No server called "${wanted}". The servers are: ${names}.`);

  return found;
}

export function windowOf(args: { days?: number | undefined; from?: string | undefined; to?: string | undefined }): Window {
  const end = args.to === undefined ? new Date() : new Date(args.to);

  if (Number.isNaN(end.getTime())) throw new ApiError(`to is not a date: ${args.to}`);

  const start =
    args.from === undefined ? new Date(end.getTime() - (args.days ?? 7) * 24 * 60 * 60 * 1000) : new Date(args.from);

  if (Number.isNaN(start.getTime())) throw new ApiError(`from is not a date: ${args.from}`);
  if (start >= end) throw new ApiError('from must be earlier than to.');

  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * Fractions cut to what a person would read: a rate to four places, a time
 * or a size to one. Fifteen digits of an error rate cost the agent context
 * and tell it nothing more.
 */
function rounded(_key: string, value: unknown): unknown {
  if (typeof value !== 'number' || Number.isInteger(value)) return value;

  return Number(value.toFixed(Math.abs(value) < 1 ? 4 : 1));
}

function onlyOne<T>(candidates: T[]): T | undefined {
  return candidates.length === 1 ? candidates[0] : undefined;
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

function omit(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));
}

/**
 * A tool's result as text the agent reads: compact JSON, or what went wrong
 * marked as an error, so it can tell the person rather than guess.
 */
async function answer(work: () => Promise<object>): Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await work(), rounded) }] };
  } catch (error) {
    if (error instanceof ApiError) return { content: [{ type: 'text', text: error.message }], isError: true };

    throw error;
  }
}
