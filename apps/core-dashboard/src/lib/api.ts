/**
 * Everything the dashboard reads from the Core API.
 *
 * **Server side only.** These calls carry the reader's own session, taken from
 * the cookie their browser sent to this app and passed on to the API. Nothing
 * here holds a credential of its own, which is the point: the dashboard can
 * only ever see what the person using it is entitled to see, and there is no
 * shared token to leak or to confuse with an API key.
 *
 * The session is an explicit argument rather than read from Next's request
 * context, so this file stays plain TypeScript and the contract test can run
 * it against a real API outside a request.
 *
 * The response types are written out here rather than imported from the API.
 * The two are deployed separately and can be different versions, so a shared
 * type would promise an agreement that does not exist. The contract test is
 * what keeps them honest: it runs these functions against a real API and fails
 * when the shapes drift.
 */

interface TimeWindow {
  from: string;
  to: string;
}

interface Durations {
  mean: number | null;
  p50: number | null;
  p95: number | null;
}

interface ClientShare {
  clientType: string;
  calls: number;
}

export interface Summary {
  range: TimeWindow;
  totalCalls: number;
  failedCalls: number;
  errorRate: number;
  durationMs: Durations;
  uniqueTools: number;
  clients: ClientShare[];
}

interface TimeseriesPoint {
  time: string;
  calls: number;
  errors: number;
}

export interface Timeseries {
  range: TimeWindow;
  bucketSeconds: number;
  points: TimeseriesPoint[];
}

export interface ToolStats {
  toolName: string;
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: Durations;
}

/** Where a page sits in a ranked list. */
interface PageInfo {
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface Tools extends PageInfo {
  range: TimeWindow;
  sort: string;
  tools: ToolStats[];
  total: number;
}

export interface ServerRecord {
  id: string;
  name: string;
  createdAt: string;
  /** False once its key has been revoked without a replacement. */
  hasActiveKey: boolean;
}

export interface ServerList {
  servers: ServerRecord[];
}

export interface FilterOptions {
  range: TimeWindow;
  tools: string[];
  clients: string[];
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
  /** As the server gives itself in its handshake, or as its SDK was told. */
  serverVersion: string | null;
  clientVersion: string | null;
}

export type FailedCall = CallRecord;

export interface VersionStats {
  version: string;
  /** When this version was first seen on this server, ever. */
  firstSeenAt: string;
  lastSeenAt: string;
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: { p50: number | null; p95: number | null };
}

export interface Versions {
  range: TimeWindow;
  /** Newest version first. */
  versions: VersionStats[];
  /** Calls from SDKs that report no version. */
  unversionedCalls: number;
}

/** One call with everything recorded about it. Parameter values are never stored. */
export interface CallDetail extends CallRecord {
  /** When the API stored it, by its own clock. */
  receivedAt: string;
  sdkVersion: string;
  /** Names and JSON types of what was sent, when the SDK was asked to record them. */
  parameters: Record<string, string> | null;
}

export interface CallList {
  range: TimeWindow;
  limit: number;
  calls: CallRecord[];
  /** Pass as `before` for the next, older page; null when this is the last. */
  nextCursor: string | null;
}

export interface UnknownTool {
  toolName: string;
  calls: number;
  lastCalledAt: string;
  /** The server's own tool this most likely meant, when one is close. */
  closest: string | null;
  /** Who asked, most first. */
  clients: { clientType: string; calls: number }[];
}

export interface UnknownTools extends PageInfo {
  range: TimeWindow;
  tools: UnknownTool[];
}

/** A resource or a prompt, ranked like a tool. */
export interface PrimitiveStats {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  durationMs: Durations;
}

export interface UnknownPrimitive {
  /** A prompt's name, or the scheme of the resource address asked for: the rest came from the client. */
  name: string;
  calls: number;
  lastCalledAt: string;
  /** For a prompt, the server's own one this most likely meant; never for a resource. */
  closest: string | null;
  /** Who asked, most first. */
  clients: { clientType: string; calls: number }[];
}

export interface ResourcesAndPrompts {
  range: TimeWindow;
  resources: PrimitiveStats[];
  prompts: PrimitiveStats[];
  unknownResources: UnknownPrimitive[];
  unknownPrompts: UnknownPrimitive[];
}

export interface AlertRule {
  id: string;
  serverId: string;
  serverName: string;
  /** The tools it watches, each on its own, or null for the whole server. */
  toolNames: string[] | null;
  kind: 'error_rate' | 'silence';
  /** A fraction, for error_rate. */
  threshold: number | null;
  windowMinutes: number;
  minCalls: number;
  enabled: boolean;
  /** Whether the end of an alert is sent as well as its start. */
  notifyResolved: boolean;
  /** True while anything it watches is past its condition. */
  firing: boolean;
  /** Which of its tools are; empty while firing for the whole server. */
  firingTools: string[];
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  serverName: string;
  toolName: string | null;
  ruleKind: 'error_rate' | 'silence';
  kind: 'firing' | 'resolved';
  value: number | null;
  occurredAt: string;
  deliveredAt: string | null;
  error: string | null;
  /** Not sent because the rule asks for starts only. */
  notWanted: boolean;
}

export interface Alerts {
  webhook: {
    url: string;
    lastAttemptAt: string | null;
    lastStatus: number | null;
    lastError: string | null;
  } | null;
  rules: AlertRule[];
  events: AlertEvent[];
  eventsOffset: number;
  eventsHaveMore: boolean;
}

interface ClientOverTime {
  clientType: string;
  calls: number;
  /** Start of the hour it was first seen on this server, ever. */
  firstSeenAt: string;
  /** Start of the hour it was last seen in. */
  lastSeenAt: string;
  /** Calls per bucket, aligned with `times`. */
  points: number[];
}

export interface ClientsOverTime extends PageInfo {
  range: TimeWindow;
  total: number;
  bucketSeconds: number;
  times: string[];
  clients: ClientOverTime[];
}

export interface LatencyBucket {
  /** Exclusive lower bound in milliseconds. */
  fromMs: number;
  /** Inclusive upper bound, or null for everything past the last one. */
  toMs: number | null;
  calls: number;
}

export interface LatencyDistribution {
  range: TimeWindow;
  totalCalls: number;
  buckets: LatencyBucket[];
}

export interface ToolDetails {
  range: TimeWindow;
  toolName: string;
  failures: { errorSource: string; calls: number }[];
  messages: { message: string; errorSource: string | null; calls: number; lastAt: string }[];
  /** Names and types only, and only when the server records them. */
  parameters: { name: string; types: string[]; calls: number }[];
  /** Calls read for parameters that had any. Zero means the server does not record them. */
  callsWithParameters: number;
  sampled: boolean;
  messagesOffset: number;
  messagesHaveMore: boolean;
  parametersOffset: number;
  parametersHaveMore: boolean;
}

export interface SessionSummary {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  calls: number;
  failures: number;
  tools: number;
  clientType: string;
  clientName: string | null;
}

export interface Sessions extends PageInfo {
  range: TimeWindow;
  sessions: SessionSummary[];
  /** True when the window held more calls than the API reads for this view. */
  sampled: boolean;
}

/** What an agent called: a tool, a resource it read, or a prompt it got. */
type CallKind = 'tool' | 'resource' | 'prompt';

export interface SessionCall {
  id: string;
  occurredAt: string;
  kind: CallKind;
  /** A tool's name, a resource's URI or URI template, or a prompt's name. */
  toolName: string;
  success: boolean;
  errorSource: string | null;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number;
  clientType: string;
  clientName: string | null;
}

export interface SessionCalls {
  range: TimeWindow;
  sessionId: string;
  calls: SessionCall[];
  /** Pass as `after` for the next page of this session; null when this is the last. */
  nextCursor: string | null;
}

export interface Transition {
  /** Null when the call opened its session. */
  from: string | null;
  fromKind: CallKind | null;
  to: string;
  toKind: CallKind;
  calls: number;
  afterFailure: number;
}

export interface Transitions extends PageInfo {
  range: TimeWindow;
  transitions: Transition[];
  sampled: boolean;
}

export interface Failures {
  range: TimeWindow;
  limit: number;
  failures: FailedCall[];
  /** Pass as `before` for the next, older page; null when this is the last. */
  nextCursor: string | null;
}

/** Why the ingest endpoint turned a request away. Open-ended: a newer API may add reasons. */
type RefusalReason =
  | 'missing_key'
  | 'unknown_key'
  | 'revoked_key'
  | 'too_large'
  | 'invalid_batch'
  | 'rate_limited'
  | 'storage_failed'
  | (string & {});

export interface RefusalCount {
  /** Null when the request never identified a server. */
  serverId: string | null;
  reason: RefusalReason;
  requests: number;
  lastAt: string;
}

export interface ServerHealth extends ServerRecord {
  lastEvent: { occurredAt: string; receivedAt: string; sdkVersion: string } | null;
  /** The SDK reaching the API at all. It announces itself on start, before any tool call. */
  lastContact: { at: string; sdkVersion: string | null } | null;
}

export interface Diagnostics {
  versions: { api: string; postgres: string; timescaledb: string | null };
  storage: {
    databaseBytes: number;
    oldestEventAt: string | null;
    retentionDays: number | null;
    rollupRetentionDays: number | null;
    /** Where calls are forwarded as well, over OTLP; null when they are not. */
    openTelemetry: string[] | null;
  };
  signingSecret: { changedAt: string; staleServerIds: string[] } | null;
  servers: ServerHealth[];
  refusals: RefusalCount[];
}

export interface Query {
  serverId?: string;
  from?: string;
  to?: string;
  limit?: number;

  /** Narrowing, spelled the same on every endpoint that accepts it. */
  toolName?: string;
  clientType?: string;
  errorSource?: string;
  sort?: string;
  /** The calls list only: how calls ended, what kind they were, which server version answered. */
  outcome?: string;
  kind?: string;
  serverVersion?: string;

  /** Paging: an offset into a ranking, or a cursor into a stream of rows. */
  offset?: number;
  before?: string;
  after?: string;
  messagesOffset?: number;
  parametersOffset?: number;
  eventsOffset?: number;
}

/** A request the API refused, carrying what it said and how it said it. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }

  /** True when signing in again could plausibly help. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

/** The reader's session, as it arrived in their cookie header. */
export type Session = string | undefined;

export function getSummary(session: Session, query: Query = {}): Promise<Summary> {
  return request<Summary>('dashboard/summary', session, query);
}

export function getTimeseries(session: Session, query: Query = {}): Promise<Timeseries> {
  return request<Timeseries>('dashboard/timeseries', session, query);
}

export function getTools(session: Session, query: Query = {}): Promise<Tools> {
  return request<Tools>('dashboard/tools', session, query);
}

export function getFailures(session: Session, query: Query = {}): Promise<Failures> {
  return request<Failures>('dashboard/errors', session, query);
}

/** Tool calls by the version of the server that answered them. */
export function getVersions(session: Session, query: Query = {}): Promise<Versions> {
  return request<Versions>('dashboard/versions', session, query);
}

/** Every call in the window, newest first; `outcome` and `kind` narrow it. */
export function getCalls(session: Session, query: Query = {}): Promise<CallList> {
  return request<CallList>('dashboard/calls', session, query);
}

/** One call by its id. */
export async function getCall(session: Session, id: string, query: Query = {}): Promise<CallDetail> {
  return (await request<{ call: CallDetail }>(`dashboard/calls/${encodeURIComponent(id)}`, session, query)).call;
}

/** Tool names agents asked for that the server does not have. */
export function getUnknownTools(session: Session, query: Query = {}): Promise<UnknownTools> {
  return request<UnknownTools>('dashboard/unknown-tools', session, query);
}

/** Resources read and prompts got, and the ones asked for that do not exist. */
export function getResourcesAndPrompts(session: Session, query: Query = {}): Promise<ResourcesAndPrompts> {
  return request<ResourcesAndPrompts>('dashboard/resources-and-prompts', session, query);
}

/** The account's alert rules, its webhook, and what happened lately. */
export function getAlerts(session: Session, query: Query = {}): Promise<Alerts> {
  return request<Alerts>('alerts', session, query);
}

/** Each client's calls across the window, and when it was first and last seen. */
export function getClients(session: Session, query: Query = {}): Promise<ClientsOverTime> {
  return request<ClientsOverTime>('dashboard/clients', session, query);
}

/** How call durations are spread. Narrows with the same filters as the summary. */
export function getLatency(session: Session, query: Query = {}): Promise<LatencyDistribution> {
  return request<LatencyDistribution>('dashboard/latency', session, query);
}

/** What the per-tool page adds to the summary and chart. Needs `toolName`. */
export function getToolDetails(session: Session, query: Query = {}): Promise<ToolDetails> {
  return request<ToolDetails>('dashboard/tool-details', session, query);
}

export function getSessions(session: Session, query: Query = {}): Promise<Sessions> {
  return request<Sessions>('dashboard/sessions', session, query);
}

/** One session's calls. Pass the session's own start and end as the window. */
export function getSessionCalls(
  session: Session,
  sessionId: string,
  query: Query = {},
): Promise<SessionCalls> {
  return request<SessionCalls>(
    `dashboard/sessions/${encodeURIComponent(sessionId)}`,
    session,
    query,
  );
}

export function getTransitions(session: Session, query: Query = {}): Promise<Transitions> {
  return request<Transitions>('dashboard/transitions', session, query);
}

export function getFilterOptions(session: Session, query: Query = {}): Promise<FilterOptions> {
  return request<FilterOptions>('dashboard/filters', session, query);
}

/**
 * The servers this account owns.
 *
 * Read on the server like everything else here. The switcher needs it to draw
 * a menu, and the settings page needs it to list what can be renamed, given a
 * new key, or removed.
 */
export function getServers(session: Session): Promise<ServerList> {
  return request<ServerList>('servers', session, {});
}

/** Everything the status page needs to say why a dashboard might be empty. */
export function getDiagnostics(session: Session): Promise<Diagnostics> {
  return request<Diagnostics>('diagnostics', session, {});
}

async function request<T>(path: string, session: Session, query: Query): Promise<T> {
  requireServer();

  // Refused here rather than sent without one. An unauthenticated request
  // would come back 401 and read as "your session expired" when in fact none
  // was ever passed along.
  if (session === undefined || session.trim().length === 0) {
    throw new ApiError(401, 'Not signed in');
  }

  const url = new URL(`/v1/${path}`, coreApiUrl());

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    // No cache setting. Next has not cached fetch by default since version 15,
    // and asking for no-store here would only restate the default while
    // implying the opposite about versions where it mattered.
    response = await fetch(url, { headers: { cookie: session } });
  } catch (cause) {
    throw new ApiError(0, `Could not reach the Core API at ${coreApiUrl()}. Is it running?`, {
      cause,
    });
  }

  // Several servers and none named: the API asks which one rather than
  // guess, which is right for a script. The dashboard's answer is the server
  // its switcher shows as chosen, the first of the list, so a page opened
  // without ?serverId= shows that server rather than an empty state.
  if (response.status === 400 && path.startsWith('dashboard/') && query['serverId'] === undefined) {
    const { servers } = await request<ServerList>('servers', session, {});
    const first = servers[0]?.id;
    if (servers.length > 1 && first !== undefined) {
      // Read to the end rather than cancelled: Next's fetch tees the body, and
      // cancelling one side waits on the other.
      await response.text();
      return request<T>(path, session, { ...query, serverId: first });
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, await explain(response));
  }

  return (await response.json()) as T;
}

/** Repeats back what the API said, since it words its own refusals usefully. */
async function explain(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };

    if (typeof body.error === 'string') return body.error;
  } catch {
    // Not JSON. Fall through to something generic rather than adding a second
    // failure on top of the first.
  }

  return `The Core API answered ${response.status}`;
}


/**
 * Where the Core API listens when nothing says otherwise.
 *
 * Kept here, the one file every other caller already depends on, rather than
 * in a module of its own: the contract test in the API package imports this
 * file directly, and it has to stay free of imports that resolve differently
 * there than they do in Next.
 *
 * Also the default for the address the SDK is told to use, since on a single
 * machine the two are the same.
 */
export const DEFAULT_CORE_API_URL = 'http://localhost:6271';

/**
 * How this app reaches the Core API. Server side only, like every caller.
 *
 * In Docker this is the API's name on the container network, which the SDK
 * could not use: ingest-url.ts holds the address for that.
 */
export function coreApiUrl(): string {
  return process.env['CORE_API_URL']?.trim() || DEFAULT_CORE_API_URL;
}

function requireServer(): void {
  // Written against globalThis rather than `window` so this file typechecks
  // under a Node configuration too: the contract test that proves these shapes
  // match the API runs there.
  if ('window' in globalThis) {
    throw new Error(
      'The API client runs on the server only: a browser cannot read the session cookie it needs to forward.',
    );
  }
}
