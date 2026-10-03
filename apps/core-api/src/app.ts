import { Hono } from 'hono';

import { isDatabaseUnavailable } from './db.ts';
import { createAlertRoutes } from './routes/alerts.ts';
import { createAuthRoutes } from './routes/auth.ts';
import { createDashboardRoutes } from './routes/dashboard.ts';
import { createDiagnosticsRoutes } from './routes/diagnostics.ts';
import { createEventRoutes } from './routes/events.ts';
import { createServerRoutes } from './routes/servers.ts';

/**
 * The HTTP application, with no server attached.
 *
 * Kept separate from the process that listens on a port so that tests can call
 * it directly through `app.request()`, without binding a socket or racing a
 * startup.
 */
export function createApp(): Hono {
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
  app.route('/v1', createEventRoutes());

  // Separate branch from the ingest endpoint, because the two are read by
  // different things through different credentials: one by a developer's
  // server writing telemetry, the other by a developer reading it.
  app.route('/v1/dashboard', createDashboardRoutes());

  // Signing in is not telemetry and not a dashboard query; it is what decides
  // whether either is allowed, so it sits on its own.
  app.route('/v1/auth', createAuthRoutes());

  // Behind the session: a key can write events, not replace itself.
  app.route('/v1/servers', createServerRoutes());

  // Rules that watch a server, and where to say when one trips.
  app.route('/v1/alerts', createAlertRoutes());

  // Why a dashboard might be empty, for the person running the installation.
  app.route('/v1/diagnostics', createDiagnosticsRoutes());

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
