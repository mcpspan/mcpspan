import { Hono } from 'hono';

import { type AccountStore, selfHostedAccounts } from '../accounts.ts';
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
  accounts: AccountStore = selfHostedAccounts,
) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession(accounts, { readTokens: true }));

  app.get('/', async (c) => {
    const { userId, serverIds } = c.get('session');

    return c.json(
      await getDiagnostics(serverIds, refusals, await accounts.seesInstallation(userId)),
    );
  });

  return app;
}
