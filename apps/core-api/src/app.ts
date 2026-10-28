import type { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';

import { type AccountStore, selfHostedAccounts } from './accounts.ts';
import { admitEverything, type Admission, meterNothing, type UsageMeter } from './admission.ts';
import { type AlertMailer, sendWebhook, type WebhookSender } from './alerts.ts';
import { isDatabaseUnavailable } from './db.ts';
import { createAlertRoutes } from './routes/alerts.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createBadgeRoutes } from './routes/badges.ts';
import { createDashboardRoutes } from './routes/dashboard.ts';
import { createDiagnosticsRoutes } from './routes/diagnostics.ts';
import { createEventRoutes } from './routes/events.ts';
import { createMcpRoutes } from './routes/mcp.ts';
import { createOAuthAccountRoutes, createOAuthRoutes, type OAuthOptions } from './routes/oauth.ts';
import { createServerRoutes } from './routes/servers.ts';
import { createTokenRoutes } from './routes/tokens.ts';

/**
 * The points where another installation can differ from a self-hosted one.
 *
 * Left out, each is the self-hosted behaviour, which is what the running API
 * uses.
 */
export interface AppOptions {
  /** Who may sign up, and which servers a signed-in person reaches. */
  accounts?: AccountStore;
  /** Whether a batch from a known server is stored at all. */
  admission?: Admission;
  /** Told how many events each batch stored, for counting them. */
  usage?: UsageMeter;
  /** How a notification reaches a webhook. Give startApi the same one, for alerts checked in the background. */
  webhooks?: WebhookSender;
  /** Mails alerts, where the installation can; without it rules send to the webhook only. Give startApi the same one. */
  alertMail?: AlertMailer;
  /**
   * Signing in to /mcp with OAuth, from clients such as claude.ai. Without it
   * /mcp takes read tokens only.
   */
  oauth?: OAuthOptions;
  /**
   * Sees each of /mcp's servers before it answers, to instrument it. Self-hosted
   * leaves it out, and /mcp reports nowhere.
   */
  measureMcp?: (server: McpServer) => void;
}

/**
 * The HTTP application, with no server attached.
 *
 * Kept separate from the process that listens on a port so that tests can call
 * it directly through `app.request()`, without binding a socket or racing a
 * startup.
 */
export function createApp({
  accounts = selfHostedAccounts,
  admission = admitEverything,
  usage = meterNothing,
  webhooks = sendWebhook,
  alertMail,
  oauth,
  measureMcp,
}: AppOptions = {}): Hono {
  const app = new Hono();

  /**
   * Liveness check.
   *
   * Answers as long as the process is up and serving. It deliberately does not
   * touch the database: a self-hoster's process manager uses this to decide
   * whether to restart the container, and restarting the API will not fix a
   * database that is down.
   */
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Versioned from the start. The SDK posts to a fixed path, and every copy of
  // it already in somebody's server keeps posting there after we change our
  // minds about something.
  app.route('/v1', createEventRoutes(undefined, undefined, undefined, admission, usage));

  // Separate branch from the ingest endpoint, because the two are read by
  // different things through different credentials: one by a developer's
  // server writing telemetry, the other by a developer reading it.
  app.route('/v1/dashboard', createDashboardRoutes(accounts));

  // Signing in is not telemetry and not a dashboard query; it is what decides
  // whether either is allowed, so it sits on its own.
  app.route('/v1/auth', createAuthRoutes(undefined, accounts));

  // Behind the session: a key can write events, not replace itself.
  app.route('/v1/servers', createServerRoutes(accounts));

  // Rules that watch a server, and where to say when one trips.
  app.route('/v1/alerts', createAlertRoutes(webhooks, accounts, alertMail !== undefined));

  // Why a dashboard might be empty, for the person running the installation.
  app.route('/v1/diagnostics', createDiagnosticsRoutes(undefined, accounts));

  // Badges for a server's README, switched on by its owner. Public, and
  // outside /v1 like /health: an image address in somebody's README has to
  // keep working however the API's versions move.
  app.route('/badge', createBadgeRoutes());

  // Tokens that read the dashboard's numbers without a browser, such as for
  // an MCP server answering questions about them.
  app.route('/v1/tokens', createTokenRoutes(accounts));

  // The same questions as an MCP server at a URL, for clients that connect to
  // one instead of starting mcpspan-mcp. Outside /v1 like /badge: the address
  // goes into people's client settings and has to stay put.
  app.route('/mcp', createMcpRoutes(() => app, { oauth: oauth !== undefined, ...(measureMcp !== undefined && { measure: measureMcp }) }));

  // Signing in to /mcp from an MCP client: metadata, registration and tokens
  // on the public address, and what the dashboard's consent page asks.
  if (oauth !== undefined) {
    app.route('/', createOAuthRoutes(oauth));
    app.route('/v1/oauth', createOAuthAccountRoutes(accounts, oauth));
  }

  // Every answer this API gives is JSON, including the ones nobody planned.
  // A developer working out why their integration is quiet should not have to
  // parse one shape for successes and another for a wrong URL.
  app.notFound((c) => c.json({ error: `No route for ${c.req.method} ${c.req.path}` }, 404));

  app.onError((error, c) => {
    if (isDatabaseUnavailable(error)) {
      console.error(`mcpspan core-api: database unreachable on ${c.req.path}`);

      // Said plainly, because this is the one failure somebody can fix without
      // reading a line of our code, and the dashboard repeats it word for
      // word. A 503 also tells the SDK to keep its batch and try again.
      return c.json(
        { error: 'The Core API is running, but it cannot reach its database.' },
        503,
      );
    }

    console.error(`mcpspan core-api: unhandled error on ${c.req.path}`, error);

    // Deliberately says nothing about what broke. A stack trace on the wire
    // describes our internals to whoever asked, and whoever asked is not
    // always the person we built this for.
    return c.json({ error: 'Something went wrong on our side' }, 500);
  });

  return app;
}
