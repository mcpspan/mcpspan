import { Hono } from 'hono';

import { createSession, SESSION_COOKIE } from './accounts.ts';
import { getPool } from './db.ts';

/**
 * A public demo: everybody who opens it is the installation's one account,
 * and nobody can change anything.
 *
 * Switched on with MCPSPAN_DEMO=true, for an installation that shows sample
 * data to anybody (demo.mcpspan.com). Off, nothing here runs. In front of the
 * app rather than inside it, so no route has to know: every reading request
 * reaches it carrying the demo account's session, whatever it came with, and
 * every other request is refused before it gets there. Events still go in,
 * which is how the sample data keeps arriving.
 */

/** Reads one address may make in a minute: plenty for a person clicking around or an agent asking. */
export const DEMO_READS_PER_MINUTE = 120;

const MINUTE_MS = 60 * 1000;

/** Renewed this long before it runs out, so no request lands on an expired one. */
const RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;

export function demoOnly(app: Hono, now: () => number = Date.now): Hono {
  const gate = new Hono();
  const reads = new Map<string, { start: number; count: number }>();
  let session: { cookie: string; expiresAt: number } | undefined;

  /** The demo account's session, made on first need and renewed before it ends. */
  async function demoCookie(): Promise<string | undefined> {
    if (session !== undefined && session.expiresAt - RENEW_BEFORE_MS > now()) return session.cookie;

    const owner = await getPool().query<{ id: string }>('SELECT id FROM users ORDER BY created_at LIMIT 1');
    const userId = owner.rows[0]?.id;

    if (userId === undefined) return undefined;

    const issued = await createSession(userId);
    session = { cookie: `${SESSION_COOKIE}=${issued.token}`, expiresAt: issued.expiresAt.getTime() };

    return session.cookie;
  }

  /** Whole seconds until this address may read again, counting this read; 0 when it may now. */
  function take(address: string): number {
    const at = now();

    if (reads.size > 10_000) {
      for (const [key, window] of reads) if (at - window.start >= MINUTE_MS) reads.delete(key);
    }

    const current = reads.get(address);

    if (current === undefined || at - current.start >= MINUTE_MS) {
      reads.set(address, { start: at, count: 1 });
      return 0;
    }

    if (current.count >= DEMO_READS_PER_MINUTE) return Math.max(1, Math.ceil((current.start + MINUTE_MS - at) / 1000));

    current.count += 1;
    return 0;
  }

  // The sample data, sent with the demo server's own key like any SDK's.
  gate.post('/v1/events', (c) => app.fetch(c.req.raw));

  gate.on(['GET', 'HEAD'], '*', async (c) => {
    // Counted per visitor for what arrives from outside, through Cloudflare,
    // which names the visitor here and replaces whatever a client sent. The
    // demo's own dashboard asks from inside, with no such header, and is not
    // counted: every visitor's pages would otherwise share one allowance.
    const visitor = c.req.header('cf-connecting-ip');
    const wait = visitor === undefined ? 0 : take(visitor);

    if (wait > 0) {
      c.header('retry-after', String(wait));
      return c.json({ error: `This demo is answering too many requests from you. Try again in ${wait} seconds.` }, 429);
    }

    const cookie = await demoCookie();

    if (cookie === undefined) return c.json({ error: 'The demo has no account yet.' }, 503);

    // Whatever credential came with the request goes, so a read token, an old
    // cookie or none at all reads as the demo account.
    const headers = new Headers(c.req.raw.headers);
    headers.delete('authorization');
    headers.set('cookie', cookie);

    return app.fetch(new Request(c.req.raw, { headers }));
  });

  gate.all('*', (c) => c.json({ error: 'This is a live demo with sample data: nothing in it can be changed.' }, 403));

  return gate;
}
