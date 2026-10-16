import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';

import { type AccountStore, selfHostedAccounts, SESSION_COOKIE, userForSession } from './accounts.ts';

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
 * This replaced a shared token read from the environment, which existed only
 * until accounts did. Nothing downstream noticed the change, which was the
 * point of giving it this shape in the first place.
 */
export function requireSession(
  /** Decides which servers the session reaches. */
  accounts: AccountStore = selfHostedAccounts,
): MiddlewareHandler<{ Variables: SessionVariables }> {
  return async (c, next) => {
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
