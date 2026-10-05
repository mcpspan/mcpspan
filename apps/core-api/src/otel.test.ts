import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase, type TestApiKey } from '../test/fixtures.ts';
import { createApp } from './app.ts';
import { closePool } from './db.ts';
import type { ToolCallEventInput } from './events-schema.ts';
import {
  DURATION_BOUNDARIES,
  OtelExporter,
  otelConfigFromEnv,
  parseHeaders,
  startOpenTelemetry,
  stopOpenTelemetry,
  type OtelConfig,
} from './otel.ts';

function call(overrides: Partial<ToolCallEventInput> = {}): ToolCallEventInput {
  return {
    id: randomUUID(),
    toolName: 'search_flights',
    durationMs: 42.5,
    success: true,
    clientType: 'claude',
    timestamp: '2026-09-17T10:00:00.000Z',
    sdkVersion: '0.1.0',
    ...overrides,
  } as ToolCallEventInput;
}

interface Received {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** An exporter whose requests are kept rather than sent. */
function capturing(options: { fail?: boolean; config?: Partial<OtelConfig> } = {}) {
  const received: Received[] = [];
  const logs: string[] = [];
  let failing = options.fail ?? false;
  const exporter = new OtelExporter(
    {
      tracesUrl: 'http://collector/v1/traces',
      metricsUrl: 'http://collector/v1/metrics',
      headers: {},
      metricIntervalMs: 60_000,
      ...options.config,
    },
    {
      fetch: async (url, init) => {
        if (failing) throw new Error('connect ECONNREFUSED');
        received.push({
          url: String(url),
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(null, { status: 200 });
      },
      serverNames: async (ids) => new Map(ids.map((id) => [id, `server ${id}`])),
      log: (message) => logs.push(message),
      now: () => Date.parse('2026-09-17T10:05:00.000Z'),
    },
  );

  return {
    exporter,
    received,
    logs,
    setFailing: (value: boolean) => {
      failing = value;
    },
  };
}

type Span = { name: string; kind: number; traceId: string; startTimeUnixNano: string; endTimeUnixNano: string; status: { code: number; message?: string }; attributes: { key: string; value: Record<string, unknown> }[] };

function spansOf(received: Received[]): Span[] {
  return received
    .filter((request) => request.url.endsWith('/v1/traces'))
    .flatMap((request) => (request.body['resourceSpans'] as { scopeSpans: { spans: Span[] }[] }[]))
    .flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
}

function attributesOf(span: { attributes: { key: string; value: Record<string, unknown> }[] }): Record<string, unknown> {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [
      key,
      'stringValue' in value
        ? value['stringValue']
        : 'intValue' in value
          ? value['intValue']
          : 'boolValue' in value
            ? value['boolValue']
          : (value['arrayValue'] as { values: { stringValue: string }[] }).values.map((item) => item.stringValue),
    ]),
  );
}

describe('the configuration, from the standard OpenTelemetry variables', () => {
  it('is off unless an endpoint is set', () => {
    expect(otelConfigFromEnv({}).config).toBeNull();
    expect(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' }).config).toBeNull();
  });

  it('adds the signal paths to a base endpoint, and lets a signal have its own', () => {
    expect(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318/' }).config).toMatchObject({
      tracesUrl: 'http://collector:4318/v1/traces',
      metricsUrl: 'http://collector:4318/v1/metrics',
      metricIntervalMs: 60_000,
    });
    expect(
      otelConfigFromEnv({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.example.com/otlp',
        OTEL_METRIC_EXPORT_INTERVAL: '10000',
      }).config,
    ).toMatchObject({ tracesUrl: 'https://traces.example.com/otlp', metricsUrl: '', metricIntervalMs: 10_000 });
  });

  it('reads headers as the specification writes them', () => {
    expect(parseHeaders('x-api-key=abc%3D%3D, dataset = mcp ,broken')).toEqual({ 'x-api-key': 'abc==', dataset: 'mcp' });
  });

  it('refuses gRPC, and says why, rather than sending JSON where it cannot be read', () => {
    const result = otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' });

    expect(result.config).toBeNull();
    expect('problem' in result && result.problem).toMatch(/HTTP/);
  });
});

describe('a call as a span, named as the conventions for MCP servers name it', () => {
  it('describes a tool call, a read and a get by what they are', async () => {
    const { exporter, received } = capturing();
    const session = randomUUID();
    const tool = call({
      sessionId: session,
      clientName: 'Claude Desktop',
      parameters: { destination: 'string' },
      responseBytes: 48_213,
      definitionHash: '9e5ebf01427bfdf5',
      repeated: true,
    });
    exporter.record('server-a', [
      tool,
      call({ kind: 'resource', toolName: 'trips://{id}' }),
      call({ kind: 'prompt', toolName: 'plan_trip' }),
    ]);
    await exporter.flushSpans();

    const [toolSpan, readSpan, getSpan] = spansOf(received);
    expect(toolSpan).toMatchObject({ name: 'tools/call search_flights', kind: 2, traceId: tool.id.replaceAll('-', ''), status: { code: 0 } });
    expect(attributesOf(toolSpan as Span)).toEqual({
      'mcp.method.name': 'tools/call',
      'gen_ai.tool.name': 'search_flights',
      'gen_ai.operation.name': 'execute_tool',
      'mcp.session.id': session,
      'mcpspan.client.type': 'claude',
      'mcpspan.client.name': 'Claude Desktop',
      'mcpspan.sdk.version': '0.1.0',
      'mcpspan.response.size': '48213',
      'mcpspan.tool.definition': '9e5ebf01427bfdf5',
      'mcpspan.call.repeated': true,
      'mcpspan.parameter.names': ['destination'],
    });
    expect(toolSpan?.startTimeUnixNano).toBe(`${Date.parse('2026-09-17T10:00:00.000Z')}000000`);
    expect(BigInt(toolSpan?.endTimeUnixNano ?? 0) - BigInt(toolSpan?.startTimeUnixNano ?? 0)).toBe(42_500_000n);

    expect(readSpan?.name).toBe('resources/read');
    expect(attributesOf(readSpan as Span)).toMatchObject({ 'mcp.method.name': 'resources/read', 'mcp.resource.uri': 'trips://{id}' });
    expect(getSpan?.name).toBe('prompts/get plan_trip');
    expect(attributesOf(getSpan as Span)).toMatchObject({ 'mcp.method.name': 'prompts/get', 'gen_ai.prompt.name': 'plan_trip' });
  });

  it('gives each way of failing its error.type', async () => {
    const { exporter, received } = capturing();
    exporter.record('server-a', [
      call({ success: false, errorSource: 'result', errorMessage: 'No flights found' }),
      call({ success: false, errorSource: 'exception', errorType: 'BookingError', errorMessage: 'Seat map unavailable' }),
      call({ success: false, errorSource: 'arguments' }),
      call({ kind: 'resource', toolName: 'db://', success: false, errorSource: 'unknown_resource' }),
    ]);
    await exporter.flushSpans();

    const spans = spansOf(received);
    expect(spans.map((span) => attributesOf(span)['error.type'])).toEqual(['tool_error', 'BookingError', 'arguments', 'unknown_resource']);
    expect(spans.map((span) => span.status)).toEqual([
      { code: 2, message: 'No flights found' },
      { code: 2, message: 'Seat map unavailable' },
      { code: 2 },
      { code: 2 },
    ]);
  });

  it('names each server as a service of its own', async () => {
    const { exporter, received } = capturing();
    exporter.record('server-a', [call()]);
    exporter.record('server-b', [call()]);
    await exporter.flushSpans();

    const resources = (received[0]?.body['resourceSpans'] as { resource: { attributes: unknown[] } }[]).map(
      (entry) => attributesOf(entry.resource as never),
    );
    expect(resources).toEqual([
      { 'service.name': 'server server-a', 'mcpspan.server.id': 'server-a' },
      { 'service.name': 'server server-b', 'mcpspan.server.id': 'server-b' },
    ]);
  });
});

describe('the duration histogram', () => {
  it('counts each call into its bucket, in seconds, and keeps counting across exports', async () => {
    const { exporter, received } = capturing();
    exporter.record('server-a', [call({ durationMs: 5 }), call({ durationMs: 150 }), call({ durationMs: 400_000 })]);
    await exporter.flushMetrics();
    exporter.record('server-a', [call({ durationMs: 5 })]);
    await exporter.flushMetrics();

    type Point = { count: string; sum: number; bucketCounts: string[]; explicitBounds: number[]; attributes: unknown[] };
    const metric = (index: number) =>
      (received[index]?.body['resourceMetrics'] as { scopeMetrics: { metrics: { name: string; unit: string; histogram: { aggregationTemporality: number; dataPoints: Point[] } }[] }[] }[])[0]
        ?.scopeMetrics[0]?.metrics[0];

    expect(metric(0)).toMatchObject({ name: 'mcp.server.operation.duration', unit: 's', histogram: { aggregationTemporality: 2 } });
    const [first] = metric(0)?.histogram.dataPoints ?? [];
    expect(first?.explicitBounds).toEqual(DURATION_BOUNDARIES);
    expect(first?.count).toBe('3');
    // 5 ms in the first bucket, 150 ms under 0.2 s, 400 s past the last bound.
    expect(first?.bucketCounts.map(Number)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

    const [second] = metric(1)?.histogram.dataPoints ?? [];
    expect(second?.count).toBe('4');
    expect(second?.bucketCounts[0]).toBe('2');
  });

  it('keeps the session out of its attributes, where it would make a series per session', async () => {
    const { exporter, received } = capturing();
    exporter.record('server-a', [call({ sessionId: randomUUID() }), call({ sessionId: randomUUID() })]);
    await exporter.flushMetrics();

    const points = (received[0]?.body['resourceMetrics'] as { scopeMetrics: { metrics: { histogram: { dataPoints: { attributes: unknown[] }[] } }[] }[] }[])[0]
      ?.scopeMetrics[0]?.metrics[0]?.histogram.dataPoints;
    expect(points).toHaveLength(1);
    expect(JSON.stringify(points)).not.toContain('mcp.session.id');
  });
});

describe('an endpoint that is away', () => {
  it('costs the forwarding, says so once, and says when it is back', async () => {
    const { exporter, received, logs, setFailing } = capturing({ fail: true });
    exporter.record('server-a', [call()]);
    await exporter.flushSpans();
    exporter.record('server-a', [call()]);
    await exporter.flushSpans();

    expect(logs.filter((line) => line.includes('could not forward'))).toHaveLength(1);

    setFailing(false);
    exporter.record('server-a', [call()]);
    await exporter.flushSpans();

    expect(spansOf(received)).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/works again/);
  });

  it('sends the headers it was given', async () => {
    const { exporter, received } = capturing({ config: { headers: { 'x-api-key': 'secret' } } });
    exporter.record('server-a', [call()]);
    await exporter.flushSpans();

    expect(received[0]?.headers).toMatchObject({ 'content-type': 'application/json', 'x-api-key': 'secret' });
  });
});

describe('forwarding what the API stores', () => {
  let collector: Server;
  let requests: { url: string; body: Record<string, unknown> }[];
  let apiKey: TestApiKey;

  beforeEach(async () => {
    await resetDatabase();
    apiKey = await createApiKey({ serverName: 'Flights' });
    requests = [];
    collector = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', () => {
        requests.push({ url: request.url ?? '', body: JSON.parse(body) as Record<string, unknown> });
        response.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await stopOpenTelemetry();
    await new Promise((resolve) => collector.close(resolve));
  });

  afterAll(async () => {
    await closePool();
  });

  async function post(events: unknown[]): Promise<Response> {
    return createApp().request('/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey.key}` },
      body: JSON.stringify({ events }),
    });
  }

  it('sends each stored call once, named after its server, even when a batch arrives twice', async () => {
    const exporter = startOpenTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${(collector.address() as AddressInfo).port}`,
    });
    const batch = [call(), call({ kind: 'prompt', toolName: 'plan_trip' })];

    expect((await post(batch)).status).toBe(202);
    expect((await post(batch)).status).toBe(202);
    await exporter?.flushSpans();

    const traces = requests.filter((request) => request.url === '/v1/traces');
    const spans = spansOf(traces.map((request) => ({ ...request, headers: {} })));
    expect(spans.map((span) => span.name).sort()).toEqual(['prompts/get plan_trip', 'tools/call search_flights']);
    const resource = (traces[0]?.body['resourceSpans'] as { resource: never }[])[0]?.resource;
    expect(attributesOf(resource as never)['service.name']).toBe('Flights');
  });

  it('stores a batch all the same when the endpoint does not answer', async () => {
    const exporter = startOpenTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' });

    const response = await post([call()]);
    await exporter?.flushSpans();

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: 1, stored: 1 });
  });
});
