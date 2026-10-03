import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { type AuthVariables, requireApiKey } from '../auth.ts';
import { contactLog, type ContactLog } from '../contacts.ts';
import { describeIssues, eventBatchSchema } from '../events-schema.ts';
import { insertEvents } from '../events-store.ts';
import { forwardToOpenTelemetry } from '../otel.ts';
import { MAX_BATCH_BYTES, MAX_EVENTS_PER_BATCH } from '../limits.ts';
import { ingestRateLimiter, type IngestRateLimiter } from '../rate-limit.ts';
import { refusalLog, type RefusalLog } from '../refusals.ts';

/**
 * Where the SDK delivers batches.
 *
 * The guards run in the order they can afford to. Size is refused while the
 * body is still arriving, before anything is parsed or a key is looked up;
 * authentication comes next, so an unknown sender never reaches the parser;
 * and shape is checked on a body already known to be small enough and to
 * belong to somebody.
 *
 * The rate limit comes last, once the events have been counted, and that
 * ordering is deliberate. Checking it earlier would save a parse of at most
 * the body limit, and would have to answer "wait a second" without knowing how
 * large the batch was - so a sender told to wait a second would come back and
 * be refused again. One check, after counting, tells the truth the first time.
 */
export function createEventRoutes(
  /**
   * Injected so a test can set a limit it can actually reach. The running API
   * passes nothing and gets the one built from the environment.
   */
  rateLimiter: IngestRateLimiter = ingestRateLimiter,
  /** Injected for the same reason: a test reads what it counted. */
  refusals: RefusalLog = refusalLog,
  /** Likewise: a test waits for the contact it caused to be written. */
  contacts: ContactLog = contactLog,
) {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post(
    '/events',
    bodyLimit({
      maxSize: MAX_BATCH_BYTES,
      onError: (c) => {
        // Refused before the key is read, so no server can be named.
        refusals.record('too_large');

        return c.json(
          { error: `Batch is too large. The limit is ${MAX_BATCH_BYTES} bytes.` },
          413,
        );
      },
    }),
    requireApiKey(refusals),
    async (c) => {
      const { serverId } = c.get('server');

      // Before the batch is looked at: a valid key reaching us is the contact,
      // whatever the batch turns out to hold. Not awaited.
      void contacts.touch(serverId, c.req.header('user-agent'));

      const body: unknown = await c.req.json().catch(() => undefined);

      if (body === undefined) {
        refusals.record('invalid_batch', serverId);

        return c.json({ error: 'Body must be JSON' }, 400);
      }

      const parsed = eventBatchSchema.safeParse(body);

      if (!parsed.success) {
        refusals.record('invalid_batch', serverId);

        return c.json({ error: 'Invalid batch', issues: describeIssues(parsed.error) }, 400);
      }

      const { events } = parsed.data;

      if (events.length > MAX_EVENTS_PER_BATCH) {
        refusals.record('too_large', serverId);

        return c.json(
          {
            error: `Batch holds too many events. The limit is ${MAX_EVENTS_PER_BATCH}, this one had ${events.length}.`,
          },
          413,
        );
      }

      // Charged by the event rather than by the request. A batch of a thousand
      // costs a thousand, which is the only way a limit means anything when
      // one request can carry that many.
      const verdict = rateLimiter.charge(serverId, events.length);

      if (!verdict.allowed) {
        refusals.record('rate_limited', serverId);

        return tooFast(c, verdict.retryAfterSeconds);
      }

      try {
        const stored = await insertEvents(serverId, events);

        // Only what was new, so a redelivered batch is not forwarded twice.
        forwardToOpenTelemetry(serverId, stored);

        // Both numbers, because they differ when a batch was redelivered, and
        // "I sent a hundred and see ninety-eight" is otherwise a mystery.
        return c.json({ accepted: events.length, stored: stored.length }, 202);
      } catch (error) {
        console.error(
          `mcpspan core-api failed to store a batch: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        refusals.record('storage_failed', serverId);

        // Unavailable rather than a flat failure: the SDK retries this status
        // and keeps the batch, which is exactly right when the database is
        // merely having a moment.
        return c.json({ error: 'Could not store events, try again shortly' }, 503);
      }
    },
  );

  return app;
}

/**
 * Turns a sender away without losing anything it was carrying.
 *
 * 429 is a status the SDK already treats as worth retrying, so the batch stays
 * in its queue and arrives later rather than being dropped. Retry-After says
 * how much later, which saves it from backing off further than it needs to.
 */
function tooFast(c: Context<{ Variables: AuthVariables }>, retryAfterSeconds: number): Response {
  c.header('Retry-After', String(retryAfterSeconds));

  return c.json(
    {
      error: `Too many events. Try again in ${retryAfterSeconds} second${
        retryAfterSeconds === 1 ? '' : 's'
      }.`,
    },
    429,
  );
}
