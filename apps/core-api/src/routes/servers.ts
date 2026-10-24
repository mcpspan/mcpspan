import { Hono } from 'hono';

import { type AccountStore, selfHostedAccounts } from '../accounts.ts';
import { issueApiKey } from '../api-key.ts';
import { disableBadge, enableBadge } from '../badges.ts';
import { getPool } from '../db.ts';
import { requireSession, type SessionVariables } from '../session.ts';
import {
  createServer,
  deleteServer,
  deleteServerData,
  listServers,
  parseDataRange,
  parseServerName,
  renameServer,
} from '../servers.ts';

/**
 * Managing the servers an account reports from, and the keys they write with.
 *
 * Mounted under servers rather than keys because that is the thing being
 * managed. A key is a credential a server holds, and it is replaceable; the
 * server is what owns the data and what somebody picks between.
 */
export function createServerRoutes(accounts: AccountStore = selfHostedAccounts) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession(accounts, { readTokens: true }));

  /**
   * What exists. Never what a key says: only its hash is stored. Also why
   * another server may not be added, or null when it may, so the page says so
   * before somebody names one rather than after.
   */
  app.get('/', async (c) => {
    const { serverIds, userId } = c.get('session');
    const [servers, addRefusal] = await Promise.all([
      listServers(serverIds),
      accounts.serverRefusal?.(userId),
    ]);

    return c.json({ servers, addRefusal: addRefusal ?? null });
  });

  /** A new server, with the key it needs to say anything. */
  app.post('/', async (c) => {
    const { userId, email } = c.get('session');
    const body = await readBody(c.req.raw);
    const name = parseServerName(body?.['name']);

    if ('error' in name) return c.json({ error: name.error }, 400);

    const refusal = await accounts.serverRefusal?.(userId);

    if (refusal !== undefined) return c.json({ error: refusal }, 403);

    const client = await getPool().connect();

    try {
      // One transaction. A server with no key cannot report anything and
      // offers no way to fix that from the interface, so half of this
      // succeeding is worse than none of it.
      await client.query('BEGIN');

      const server = await createServer(userId, name.name, client);
      const issued = await issueApiKey({
        serverId: server.id,
        ownerEmail: email,
        userId,
        client,
      });

      await client.query('COMMIT');

      // The only time the key is readable.
      return c.json({ server, apiKey: issued.key }, 201);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * Replaces a server's key with a new one.
   *
   * The old one stops working immediately rather than lingering through a
   * grace period. A key is replaced because it may have leaked, and a window
   * in which the suspect credential still works is the opposite of the point.
   */
  app.post('/:serverId/key', async (c) => {
    const { userId, email, serverIds } = c.get('session');
    const serverId = c.req.param('serverId');

    if (!serverIds.includes(serverId)) {
      return c.json({ error: 'No such server' }, 404);
    }

    const client = await getPool().connect();

    try {
      // Both in one transaction. A failure between them would leave either two
      // working keys or none, and the second takes a server's telemetry down
      // until somebody notices.
      await client.query('BEGIN');
      await client.query(
        'UPDATE api_keys SET revoked_at = now() WHERE server_id = $1 AND revoked_at IS NULL',
        [serverId],
      );

      const issued = await issueApiKey({ serverId, ownerEmail: email, userId, client });

      await client.query('COMMIT');

      return c.json({ apiKey: issued.key, serverId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * Deletes what a server recorded between two moments, keeping the server.
   * With dryRun, only says how many calls that would be, for the question
   * asked before anything goes.
   */
  app.post('/:serverId/data/delete', async (c) => {
    const { serverIds } = c.get('session');
    const body = await readBody(c.req.raw);
    const range = parseDataRange(body?.['from'], body?.['to']);

    if ('error' in range) return c.json({ error: range.error }, 400);

    const dryRun = body?.['dryRun'] === true;
    const calls = await deleteServerData(serverIds, c.req.param('serverId'), range, { dryRun });

    if (calls === undefined) return c.json({ error: 'No such server' }, 404);

    return c.json({ calls, deleted: !dryRun });
  });

  /** Switches the server's public badge on, or moves it to a new address. */
  app.post('/:serverId/badge', async (c) => {
    const badgeId = await enableBadge(c.get('session').serverIds, c.req.param('serverId'));

    if (badgeId === undefined) return c.json({ error: 'No such server' }, 404);

    return c.json({ badgeId });
  });

  app.delete('/:serverId/badge', async (c) => {
    const disabled = await disableBadge(c.get('session').serverIds, c.req.param('serverId'));

    return disabled ? c.body(null, 204) : c.json({ error: 'No such server' }, 404);
  });

  app.patch('/:serverId', async (c) => {
    const { serverIds } = c.get('session');
    const body = await readBody(c.req.raw);
    const name = parseServerName(body?.['name']);

    if ('error' in name) return c.json({ error: name.error }, 400);

    const renamed = await renameServer(serverIds, c.req.param('serverId'), name.name);

    if (!renamed) return c.json({ error: 'No such server' }, 404);

    return c.json({ server: { id: c.req.param('serverId'), name: name.name } });
  });

  /**
   * Removes a server, its keys and everything it recorded.
   *
   * Refuses to remove the last one. An account with no servers has no key, no
   * way to make one from the interface, and no way back except the command
   * line - which is a corner nobody should be able to reach by clicking.
   */
  app.delete('/:serverId', async (c) => {
    const { serverIds } = c.get('session');

    if (serverIds.length <= 1) {
      return c.json(
        { error: 'This is the only server. Create another one before removing this.' },
        409,
      );
    }

    const removed = await deleteServer(serverIds, c.req.param('serverId'));

    if (!removed) return c.json({ error: 'No such server' }, 404);

    return c.body(null, 204);
  });

  return app;
}

/** Reads a JSON body, treating anything unreadable as an absent one. */
async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();

    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
