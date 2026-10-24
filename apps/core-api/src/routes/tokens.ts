import { Hono } from 'hono';

import { type AccountStore, selfHostedAccounts } from '../accounts.ts';
import { issueReadToken, listReadTokens, parseTokenName, revokeReadToken } from '../read-tokens.ts';
import { requireSession, type SessionVariables } from '../session.ts';

/**
 * Making and revoking the read tokens an account holds.
 *
 * Browser only: a token cannot make another token, or keep itself alive once
 * its owner has revoked it.
 */
export function createTokenRoutes(accounts: AccountStore = selfHostedAccounts) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession(accounts));

  app.get('/', async (c) => c.json({ tokens: await listReadTokens(c.get('session').userId) }));

  /** A new token, in the clear. The only time it is readable. */
  app.post('/', async (c) => {
    const name = parseTokenName((await readBody(c.req.raw))?.['name']);

    if ('error' in name) return c.json({ error: name.error }, 400);

    const issued = await issueReadToken(c.get('session').userId, name.name);

    if ('error' in issued) return c.json({ error: issued.error }, 409);

    return c.json({ token: issued.token, ...issued.record }, 201);
  });

  app.delete('/:tokenId', async (c) => {
    const revoked = await revokeReadToken(c.get('session').userId, c.req.param('tokenId'));

    return revoked ? c.body(null, 204) : c.json({ error: 'No such token' }, 404);
  });

  return app;
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();

    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
