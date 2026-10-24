import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

import { type AccountStore, selfHostedAccounts, SESSION_COOKIE, userForSession } from './accounts.ts';
import { bearerToken } from './auth.ts';
import { userForReadToken } from './read-tokens.ts';

/**
 * What a signed-in developer is allowed to look at.
 *
 * A set of servers rather than a single one, because that is the shape every
 * version needs: today it is the servers a user owns, and a hosted version
 * will make it the servers an organisation owns. Endpoints written against
 * this did not change when accounts arrived, and will not change again.
 */
interface Session {
  userId: string;
  email: string;
  serverIds: string[];
}

export interface SessionVariables {
  session: Session;
}

/**
 * Lets a signed-in browser through, and nobody else.
 *
 * Distinct from the API key middleware on purpose. That one authenticates a
 * machine writing its own telemetry; this one authenticates a person reading
 * it. Giving them one mechanism would mean an API key leaked from a server's
 * environment also opened the dashboard.
 *
 * Where a branch allows it, a read token stands in for the browser: the same
 * person, the same servers, for reading only. Every endpoint behind it then
 * answers a token exactly as it answers the dashboard.
 *
 * This replaced a shared token read from the environment, which existed only
 * until accounts did. Nothing downstream noticed the change, which was the
 * point of giving it this shape in the first place.
 */
export function requireSession(
  /** Decides which servers the session reaches. */
  accounts: AccountStore = selfHostedAccounts,
  {
    readTokens = false,
  }: {
    /**
     * Whether a read token (Authorization: Bearer mcpspan_read_...) also
     * gets in, for reading only. Off unless a branch asks: tokens are for the
     * numbers a dashboard shows, not for an account's settings, its billing
     * or where its alerts are sent.
     */
    readTokens?: boolean;
  } = {},
): MiddlewareHandler<{ Variables: SessionVariables }> {
  return async (c, next) => {
    const bearer = readTokens ? bearerToken(c.req.header('authorization')) : undefined;

    if (bearer !== undefined) {
      const owner = await userForReadToken(bearer);

      if (owner === undefined) return c.json({ error: 'Invalid or revoked read token' }, 401);

      // Checked after the token, so a request with a token that does not
      // work is told that first, whatever it was trying to do.
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        return c.json({ error: 'A read token can only read. Make this change in the dashboard.' }, 403);
      }

      c.set('session', {
        userId: owner.id,
        email: owner.email,
        serverIds: await accounts.serverIdsFor(owner.id),
      });

      await next();

      return;
    }

    const token = getCookie(c, SESSION_COOKIE);
    const user = token === undefined ? undefined : await userForSession(token);

    if (user === undefined) {
      return c.json({ error: 'Not signed in' }, 401);
    }

    c.set('session', {
      userId: user.id,
      email: user.email,
      serverIds: await accounts.serverIdsFor(user.id),
    });

    await next();
  };
}

/**
 * Works out which server a request is about, and whether it may ask.
 *
 * A caller naming a server is fine as long as the answer is checked against
 * what their session covers. What would not be fine is taking the name on
 * trust, which is how one customer ends up reading another's numbers.
 *
 * With exactly one server in reach the parameter can be left out, since a
 * self-hosted install has nothing to choose between.
 */
export function resolveServerId(
  c: Context<{ Variables: SessionVariables }>,
): { serverId: string } | { error: string; status: 400 | 403 } {
  const { serverIds } = c.get('session');
  const requested = c.req.query('serverId');

  if (requested === undefined) {
    if (serverIds.length === 1) return { serverId: serverIds[0] as string };

    return serverIds.length === 0
      ? { error: 'No servers are reporting yet. Create an API key and connect the SDK.', status: 400 }
      : { error: 'Several servers are available, name one with ?serverId=', status: 400 };
  }

  if (!serverIds.includes(requested)) {
    // Same answer whether the server does not exist or belongs to someone
    // else. Telling them apart would let anyone map out which servers exist.
    return { error: 'No such server', status: 403 };
  }

  return { serverId: requested };
}
