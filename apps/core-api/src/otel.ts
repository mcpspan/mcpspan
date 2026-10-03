import { randomBytes } from 'node:crypto';

import { getPool } from './db.ts';
import { API_VERSION } from './diagnostics.ts';
import type { ToolCallEventInput } from './events-schema.ts';

/**
 * Forwarding calls to OpenTelemetry, for teams whose dashboards already live
 * in Grafana, Datadog, Honeycomb or the like.
 *
 * Every call stored is also sent, as it arrives, to an OTLP endpoint of the
 * operator's choosing: one span per call and a duration histogram, named as
 * OpenTelemetry's conventions for MCP servers name them
 * (github.com/open-telemetry/semantic-conventions-genai, docs/gen-ai/mcp.md).
 * Those conventions are still marked Development, so the names may move.
 *
 * Here rather than in each SDK: one implementation instead of eight, and the
 * API already holds every call. The cost is that a span is not part of the
 * trace of the server that made the call; it stands on its own, with the
 * session as the thread between calls.
 *
 * Written against OTLP over HTTP with JSON, which is stable, rather than with
 * the OpenTelemetry SDK, whose exporters are still versioned as experimental:
 * sending finished calls needs a small fraction of what that SDK does.
 *
 * Nothing here ever holds up ingest. A call that cannot be forwarded is
 * dropped from the forwarding, never from storage; the histogram is
 * cumulative, so the next export after an outage carries the counts anyway.
 */

/** Where to send, and how, from the standard OpenTelemetry variables. */
export interface OtelConfig {
  tracesUrl: string;
  metricsUrl: string;
  headers: Record<string, string>;
  metricIntervalMs: number;
}

/** OpenTelemetry's suggested boundaries for mcp.server.operation.duration, in seconds. */
export const DURATION_BOUNDARIES = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

const MAX_QUEUED_SPANS = 10_000;
const SPANS_PER_REQUEST = 512;
const SPAN_FLUSH_MS = 5_000;
/** Distinct attribute sets the histogram keeps; a server's tools, methods and error types, times its servers. */
const MAX_SERIES = 10_000;
const NAME_CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

const METHODS: Record<string, string> = {
  tool: 'tools/call',
  resource: 'resources/read',
  prompt: 'prompts/get',
};

/**
 * Reads the configuration, or says why there is none.
 *
 * Off unless an endpoint is set. Only OTLP over HTTP is spoken: an
 * OpenTelemetry Collector takes JSON there whatever protocol it was told to
 * prefer, but gRPC is another port and another wire format altogether.
 */
export function otelConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { config: OtelConfig } | { config: null; problem?: string } {
  if (env['OTEL_SDK_DISABLED']?.trim().toLowerCase() === 'true') return { config: null };

  const base = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim().replace(/\/+$/, '');
  const traces = env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']?.trim() || (base ? `${base}/v1/traces` : '');
  const metrics = env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']?.trim() || (base ? `${base}/v1/metrics` : '');
  if (!traces && !metrics) return { config: null };

  const protocol = env['OTEL_EXPORTER_OTLP_PROTOCOL']?.trim().toLowerCase();
  if (protocol === 'grpc') {
    return {
      config: null,
      problem:
        'OTEL_EXPORTER_OTLP_PROTOCOL is grpc, and the Core API speaks OTLP over HTTP only. Point OTEL_EXPORTER_OTLP_ENDPOINT at the HTTP port (4318 on a Collector) and drop the protocol setting.',
    };
  }

  for (const url of [traces, metrics]) {
    if (url && !/^https?:\/\//.test(url)) {
      return { config: null, problem: `${url} is not an http(s) address, so nothing is forwarded to OpenTelemetry` };
    }
  }

  const interval = Number(env['OTEL_METRIC_EXPORT_INTERVAL'] ?? 60_000);

  return {
    config: {
      tracesUrl: traces,
      metricsUrl: metrics,
      headers: parseHeaders(env['OTEL_EXPORTER_OTLP_HEADERS'] ?? ''),
      metricIntervalMs: Number.isFinite(interval) && interval >= 1_000 ? interval : 60_000,
    },
  };
}

/** `key=value,key=value`, values percent-encoded, as the OpenTelemetry specification has it. */
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    try {
      headers[key] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      headers[key] = pair.slice(at + 1).trim();
    }
  }

  return headers;
}

type AnyValue = { stringValue: string } | { arrayValue: { values: { stringValue: string }[] } };
type KeyValue = { key: string; value: AnyValue };

function attribute(key: string, value: string | string[] | undefined): KeyValue[] {
  if (value === undefined || value === '') return [];
  if (Array.isArray(value)) {
    return [{ key, value: { arrayValue: { values: value.map((item) => ({ stringValue: item })) } } }];
  }

  return [{ key, value: { stringValue: value } }];
}

/**
 * The attributes a call is described by, in OpenTelemetry's names, apart
 * from the session, which is too many values for a histogram to be split by.
 *
 * The name of a resource is what the SDK recorded: the URI the server
 * registered, its template, or an unknown address's scheme alone. Never the
 * address a client asked for, so `mcp.resource.uri`, which the conventions
 * leave off by default because it can hold a user's data, is safe to send.
 */
function describeCall(event: ToolCallEventInput): { method: string; attributes: KeyValue[] } {
  const kind = event.kind ?? 'tool';
  const method = METHODS[kind] ?? kind;

  return {
    method,
    attributes: [
      ...attribute('mcp.method.name', method),
      ...(kind === 'tool'
        ? [...attribute('gen_ai.tool.name', event.toolName), ...attribute('gen_ai.operation.name', 'execute_tool')]
        : []),
      ...(kind === 'prompt' ? attribute('gen_ai.prompt.name', event.toolName) : []),
      ...(kind === 'resource' ? attribute('mcp.resource.uri', event.toolName) : []),
      ...(event.success ? [] : attribute('error.type', errorType(event))),
      ...attribute('mcpspan.client.type', event.clientType),
    ],
  };
}

/**
 * `error.type` as the conventions ask: `tool_error` for a result marked
 * isError, the exception's class for a thrown one, and otherwise the refusal
 * that ended the call, which is low in cardinality as the attribute must be.
 */
function errorType(event: ToolCallEventInput): string {
  if (event.errorSource === 'result') return 'tool_error';
  if (event.errorSource === 'exception') return event.errorType || '_OTHER';

  return event.errorSource || '_OTHER';
}

interface QueuedSpan {
  serverId: string;
  span: Record<string, unknown>;
}

interface Series {
  serverId: string;
  attributes: KeyValue[];
  bucketCounts: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms * 1000)) * 1000n).toString();
}

export interface OtelDependencies {
  fetch: typeof fetch;
  /** Server names by id, for service.name. */
  serverNames: (ids: string[]) => Promise<Map<string, string>>;
  log: (message: string) => void;
  now: () => number;
}

const defaultDependencies: OtelDependencies = {
  fetch: (...args) => fetch(...args),
  serverNames: async (ids) => {
    const result = await getPool().query<{ id: string; name: string }>(
      'SELECT id, name FROM servers WHERE id = ANY($1::uuid[])',
      [ids],
    );

    return new Map(result.rows.map((row) => [row.id, row.name]));
  },
  log: (message) => console.error(message),
  now: () => Date.now(),
};

export class OtelExporter {
  readonly config: OtelConfig;
  private readonly deps: OtelDependencies;
  private readonly startedAt: number;
  private queue: QueuedSpan[] = [];
  private readonly series = new Map<string, Series>();
  private readonly names = new Map<string, { name: string; at: number }>();
  private dropped = 0;
  private seriesRefused = false;
  private failing = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];

  constructor(config: OtelConfig, deps: Partial<OtelDependencies> = {}) {
    this.config = config;
    this.deps = { ...defaultDependencies, ...deps };
    this.startedAt = this.deps.now();
  }

  /** Takes calls just stored. Synchronous and cheap: sending happens on the timers. */
  record(serverId: string, events: readonly ToolCallEventInput[]): void {
    for (const event of events) {
      try {
        this.recordOne(serverId, event);
      } catch {
        // A call that cannot be described is not forwarded; it is stored all the same.
      }
    }
  }

  private recordOne(serverId: string, event: ToolCallEventInput): void {
    const { method, attributes } = describeCall(event);
    const kind = event.kind ?? 'tool';
    const start = Date.parse(event.timestamp);

    if (this.config.tracesUrl) {
      if (this.queue.length >= MAX_QUEUED_SPANS) {
        this.dropped += 1;
      } else {
        // The event's own id as the trace id: the same call forwarded twice is the same trace.
        const traceId = event.id.replaceAll('-', '').toLowerCase();
        this.queue.push({
          serverId,
          span: {
            traceId,
            spanId: randomBytes(8).toString('hex'),
            // The conventions name a span by its tool or prompt; a resource has only the method.
            name: kind === 'resource' ? method : `${method} ${event.toolName}`,
            kind: 2,
            startTimeUnixNano: nanos(start),
            endTimeUnixNano: nanos(start + event.durationMs),
            attributes: [
              ...attributes,
              ...attribute('mcp.session.id', event.sessionId),
              ...attribute('mcpspan.error.source', event.errorSource),
              ...attribute('mcpspan.client.name', event.clientName),
              ...attribute('mcpspan.sdk.version', event.sdkVersion),
              ...attribute('mcpspan.server.version', event.serverVersion),
              ...attribute('mcpspan.client.version', event.clientVersion),
              ...attribute('mcpspan.parameter.names', event.parameters ? Object.keys(event.parameters) : undefined),
            ],
            status: event.success ? { code: 0 } : { code: 2, ...(event.errorMessage ? { message: event.errorMessage } : {}) },
          },
        });
      }
    }

    if (this.config.metricsUrl) {
      const key = `${serverId}\u0000${JSON.stringify(attributes)}`;
      let series = this.series.get(key);
      if (!series) {
        if (this.series.size >= MAX_SERIES) {
          if (!this.seriesRefused) {
            this.deps.log(
              `mcpspan core-api: more than ${MAX_SERIES} distinct call descriptions for OpenTelemetry metrics; new ones are left out of the histogram, spans are not affected`,
            );
          }
          this.seriesRefused = true;

          return;
        }
        series = {
          serverId,
          attributes,
          bucketCounts: new Array<number>(DURATION_BOUNDARIES.length + 1).fill(0),
          count: 0,
          sum: 0,
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
        };
        this.series.set(key, series);
      }

      const seconds = event.durationMs / 1000;
      let bucket = DURATION_BOUNDARIES.findIndex((bound) => seconds <= bound);
      if (bucket === -1) bucket = DURATION_BOUNDARIES.length;
      series.bucketCounts[bucket] = (series.bucketCounts[bucket] ?? 0) + 1;
      series.count += 1;
      series.sum += seconds;
      series.min = Math.min(series.min, seconds);
      series.max = Math.max(series.max, seconds);
    }
  }

  start(): void {
    this.timers.push(setInterval(() => void this.flushSpans(), SPAN_FLUSH_MS));
    this.timers.push(setInterval(() => void this.flushMetrics(), this.config.metricIntervalMs));
    for (const timer of this.timers) timer.unref();
  }

  /** Sends what is left, for a shutdown; waits at most as long as one request may take. */
  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.all([this.flushSpans(), this.flushMetrics()]);
  }

  async flushSpans(): Promise<void> {
    if (this.dropped > 0) {
      this.deps.log(
        `mcpspan core-api: ${this.dropped} calls were not forwarded to OpenTelemetry, because the queue for ${this.config.tracesUrl} was full`,
      );
      this.dropped = 0;
    }

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, SPANS_PER_REQUEST);
      const byServer = new Map<string, Record<string, unknown>[]>();
      for (const { serverId, span } of batch) {
        byServer.set(serverId, [...(byServer.get(serverId) ?? []), span]);
      }
      const resources = await this.resources([...byServer.keys()]);

      const sent = await this.send(this.config.tracesUrl, {
        resourceSpans: [...byServer].map(([serverId, spans]) => ({
          resource: resources.get(serverId),
          scopeSpans: [{ scope: { name: 'mcpspan', version: API_VERSION }, spans }],
        })),
      });
      // Spans that could not be sent are let go: holding them would only
      // delay the ones behind them, and every call is kept in storage anyway.
      if (!sent) return;
    }
  }

  async flushMetrics(): Promise<void> {
    if (!this.config.metricsUrl || this.series.size === 0) return;

    const now = this.deps.now();
    const byServer = new Map<string, Series[]>();
    for (const series of this.series.values()) {
      byServer.set(series.serverId, [...(byServer.get(series.serverId) ?? []), series]);
    }
    const resources = await this.resources([...byServer.keys()]);

    await this.send(this.config.metricsUrl, {
      resourceMetrics: [...byServer].map(([serverId, all]) => ({
        resource: resources.get(serverId),
        scopeMetrics: [
          {
            scope: { name: 'mcpspan', version: API_VERSION },
            metrics: [
              {
                name: 'mcp.server.operation.duration',
                description: 'MCP request duration as observed on the receiver, as the SDK measured it',
                unit: 's',
                histogram: {
                  // Cumulative: an export lost to an outage is made up by the next one.
                  aggregationTemporality: 2,
                  dataPoints: all.map((series) => ({
                    attributes: series.attributes,
                    startTimeUnixNano: nanos(this.startedAt),
                    timeUnixNano: nanos(now),
                    count: String(series.count),
                    sum: series.sum,
                    min: series.min,
                    max: series.max,
                    bucketCounts: series.bucketCounts.map(String),
                    explicitBounds: DURATION_BOUNDARIES,
                  })),
                },
              },
            ],
          },
        ],
      })),
    });
  }

  /** service.name is the server's name, so each MCP server is a service of its own. */
  private async resources(serverIds: string[]): Promise<Map<string, { attributes: KeyValue[] }>> {
    const now = this.deps.now();
    const stale = serverIds.filter((id) => {
      const known = this.names.get(id);
      return !known || now - known.at > NAME_CACHE_MS;
    });
    if (stale.length > 0) {
      try {
        const found = await this.deps.serverNames(stale);
        for (const id of stale) this.names.set(id, { name: found.get(id) ?? id, at: now });
      } catch {
        // The id stands in until the database answers.
      }
    }

    return new Map(
      serverIds.map((id) => [
        id,
        {
          attributes: [
            ...attribute('service.name', this.names.get(id)?.name ?? id),
            ...attribute('mcpspan.server.id', id),
          ],
        },
      ]),
    );
  }

  /** One POST. Says so once when an endpoint starts failing, and once when it recovers. */
  private async send(url: string, body: unknown): Promise<boolean> {
    try {
      const response = await this.deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.config.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await response.body?.cancel();

      if (this.failing.delete(url)) {
        this.deps.log(`mcpspan core-api: forwarding to OpenTelemetry at ${url} works again`);
      }

      return true;
    } catch (error) {
      if (!this.failing.has(url)) {
        this.failing.add(url);
        this.deps.log(
          `mcpspan core-api: could not forward to OpenTelemetry at ${url}, will keep trying: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return false;
    }
  }
}

let exporter: OtelExporter | null = null;

/** Starts forwarding if the environment asks for it. Returns the exporter, for a shutdown to flush. */
export function startOpenTelemetry(
  env: Record<string, string | undefined> = process.env,
  deps: Partial<OtelDependencies> = {},
): OtelExporter | null {
  const { config, ...rest } = otelConfigFromEnv(env);
  if ('problem' in rest && rest.problem) console.error(`mcpspan core-api: ${rest.problem}`);
  if (!config) return null;

  exporter = new OtelExporter(config, deps);
  exporter.start();
  console.log(
    `mcpspan core-api forwards calls to OpenTelemetry: ${[config.tracesUrl, config.metricsUrl].filter(Boolean).join(', ')}`,
  );

  return exporter;
}

/** For tests: stops forwarding altogether. */
export async function stopOpenTelemetry(): Promise<void> {
  await exporter?.stop();
  exporter = null;
}

/** Where calls are forwarded, for the Status page; null when forwarding is off. */
export function openTelemetryTargets(): string[] | null {
  if (exporter === null) return null;

  return [exporter.config.tracesUrl, exporter.config.metricsUrl].filter((url) => url !== '');
}

/** Hands calls just stored to OpenTelemetry, if it is on. Never throws. */
export function forwardToOpenTelemetry(serverId: string, events: readonly ToolCallEventInput[]): void {
  exporter?.record(serverId, events);
}
