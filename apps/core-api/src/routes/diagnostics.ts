import { Hono } from 'hono';

import { getDiagnostics } from '../diagnostics.ts';
import { refusalLog, type RefusalLog } from '../refusals.ts';
import { requireSession, type SessionVariables } from '../session.ts';

/**
 * The installation's own state, for the person who runs it.
 *
 * Behind the session like the rest of the dashboard. It names servers, counts
 * refused keys and describes the database, none of which belongs on a port
 * the SDK reaches from the open internet.
 */
export function createDiagnosticsRoutes(
  /** Injected so a test can read counts it made itself. */
  refusals: RefusalLog = refusalLog,
) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession());

  app.get('/', async (c) => {
    const { userId, serverIds } = c.get('session');

    return c.json(await getDiagnostics(userId, serverIds, refusals));
  });

  return app;
}
