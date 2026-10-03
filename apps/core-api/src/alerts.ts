import { readFileSync } from 'node:fs';

import { getPool } from './db.ts';
import { UNKNOWN_TOOL } from './filters.ts';

export type AlertKind = 'error_rate' | 'silence';

/** How long an error-rate window may be. It is counted from raw rows every minute. */
export const MAX_ERROR_RATE_WINDOW_MINUTES = 24 * 60;

/** How long a silence window may be. That check reads a single row, so a week is cheap. */
export const MAX_SILENCE_WINDOW_MINUTES = 7 * 24 * 60;

/** Deliveries tried for one change of state before it is left undelivered. */
const MAX_DELIVERY_ATTEMPTS = 3;

/** How long one webhook request may take. */
const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Held while checking, so two API processes never both notice the same change
 * and send it twice. A self-hosted install runs one, but a second started
 * during an upgrade would otherwise do exactly that.
 */
const EVALUATION_LOCK = 0x6d6370_616c74; // "mcpalt" in ASCII, recognisable in pg_locks

const USER_AGENT = `mcpspan-alerts/${
  (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version
}`;

export interface WebhookPayload {
  /** Read by Slack's incoming webhooks. */
  text: string;
  /** Read by Discord's. */
  content: string;
  event: 'firing' | 'resolved' | 'test';
  server: { id: string; name: string } | null;
  rule: {
    kind: AlertKind;
    /** The one tool the rule watches, or null for the whole server. */
    toolName: string | null;
    threshold: number | null;
    windowMinutes: number;
  } | null;
  /** The error rate as a fraction, or the minutes since the last call. */
  value: number | null;
  occurredAt: string;
}

export type WebhookSender = (url: string, payload: WebhookPayload) => Promise<number>;

/**
 * Posts one notification.
 *
 * Carries the message twice, as `text` and as `content`, because those are
 * the fields Slack and Discord each display. Anything else reading the
 * webhook gets the structured fields beside them.
 *
 * Resolves with the status on any answer; a status outside 2xx is the
 * caller's to judge. Rejects only when no answer came.
 */
export const sendWebhook: WebhookSender = async (url, payload) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });

  // Nothing in the answer is used, but an unread body holds the connection.
  await response.body?.cancel();

  return response.status;
};

interface RuleRow {
  id: string;
  server_id: string;
  server_name: string;
  /** Each watched on its own; null for the whole server. */
  tool_names: string[] | null;
  kind: AlertKind;
  threshold: number | null;
  window_minutes: number;
  min_calls: number;
}

/** How the whole server is written where a tool name would go. */
export const WHOLE_SERVER = '';

/**
 * Checks every enabled rule, records any change of state, and delivers what
 * has not been delivered.
 *
 * Runs once a minute. Returns without doing anything if another process holds
 * the lock, since that one is doing the same work.
 */
export async function evaluateAlerts(
  now: Date = new Date(),
  send: WebhookSender = sendWebhook,
): Promise<void> {
  const client = await getPool().connect();

  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [EVALUATION_LOCK],
    );

    if (locked.rows[0]?.locked !== true) return;

    try {
      const [rules, states] = await Promise.all([
        getPool().query<RuleRow>(
          `SELECT r.id, r.server_id, s.name AS server_name, r.tool_names, r.kind, r.threshold,
                  r.window_minutes, r.min_calls
           FROM alert_rules r
           JOIN servers s ON s.id = r.server_id
           WHERE r.enabled`,
        ),
        getPool().query<{ rule_id: string; target: string }>(
          `SELECT st.rule_id, st.target
           FROM alert_states st
           JOIN alert_rules r ON r.id = st.rule_id
           WHERE r.enabled AND st.state = 'firing'`,
        ),
      ]);

      const firing = new Set(states.rows.map((row) => `${row.rule_id}:${row.target}`));

      for (const rule of rules.rows) {
        for (const target of rule.tool_names ?? [WHOLE_SERVER]) {
          await evaluateTarget(rule, target, firing.has(`${rule.id}:${target}`), now);
        }
      }

      await deliverPending(send);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [EVALUATION_LOCK]);
    }
  } finally {
    client.release();
  }
}

/**
 * Measures one rule and moves it between states when the answer changes.
 *
 * The update is conditional on the state it read, so a change is recorded
 * once even if something else touched the rule in between.
 */
async function evaluateTarget(
  rule: RuleRow,
  target: string,
  wasFiring: boolean,
  now: Date,
): Promise<void> {
  const measured = await measure(rule, target === WHOLE_SERVER ? null : target, now);

  if (measured === undefined || measured.breached === wasFiring) return;

  const next = measured.breached ? 'firing' : 'ok';
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');

    // Written only when it differs from what is stored, so a change is
    // recorded once even if something else moved it in between.
    const moved = await client.query(
      `INSERT INTO alert_states (rule_id, target, state, changed_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (rule_id, target) DO UPDATE
         SET state = EXCLUDED.state, changed_at = EXCLUDED.changed_at
         WHERE alert_states.state <> EXCLUDED.state`,
      [rule.id, target, next, now],
    );

    if ((moved.rowCount ?? 0) > 0) {
      await client.query(
        `INSERT INTO alert_events (rule_id, target, kind, value, occurred_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [rule.id, target, next === 'firing' ? 'firing' : 'resolved', measured.value, now],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Whether a rule's condition holds right now, and the figure that decided it.
 *
 * Undefined when there is nothing to judge by, which leaves the state as it
 * was: a server with no calls on record has not gone silent, it has not
 * started, and a firing silence whose last call has aged out of retention has
 * not ended.
 */
async function measure(
  rule: RuleRow,
  toolName: string | null,
  now: Date,
): Promise<{ breached: boolean; value: number } | undefined> {
  const since = new Date(now.getTime() - rule.window_minutes * 60 * 1000);

  // Written out per case rather than as "tool_name = $n OR $n IS NULL", so
  // each query can use the index made for it: (server_id, tool_name,
  // occurred_at) for one tool, (server_id, occurred_at) for the whole server.
  const toolParams = toolName === null ? [] : [toolName];
  const onTool = (position: number): string =>
    toolName === null ? '' : `AND tool_name = $${position}`;

  if (rule.kind === 'silence') {
    const last = await getPool().query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM tool_calls
       WHERE server_id = $1 AND error_source IS DISTINCT FROM $2 ${onTool(3)}
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [rule.server_id, UNKNOWN_TOOL, ...toolParams],
    );

    const at = last.rows[0]?.occurred_at;

    if (at === undefined) return undefined;

    const minutesQuiet = (now.getTime() - at.getTime()) / 60_000;

    return { breached: at < since, value: minutesQuiet };
  }

  const counts = await getPool().query<{ calls: string; failed: string }>(
    `SELECT count(*) AS calls, count(*) FILTER (WHERE NOT success) AS failed
     FROM tool_calls
     WHERE server_id = $1
       AND occurred_at >= $2
       AND occurred_at <= $3
       AND error_source IS DISTINCT FROM $4
       ${onTool(5)}`,
    [rule.server_id, since, now, UNKNOWN_TOOL, ...toolParams],
  );

  const calls = Number(counts.rows[0]?.calls ?? 0);
  const failed = Number(counts.rows[0]?.failed ?? 0);
  const rate = calls === 0 ? 0 : failed / calls;

  // Too few calls is not enough evidence either way. A firing alert is
  // resolved by it, though: an incident that stopped because the traffic
  // stopped is not one to keep shouting about, and silence has its own rule.
  return { breached: calls >= rule.min_calls && rate >= (rule.threshold ?? 1), value: rate };
}

interface PendingRow {
  id: string;
  kind: 'firing' | 'resolved';
  value: number | null;
  occurred_at: Date;
  attempts: number;
  rule_kind: AlertKind;
  tool_name: string | null;
  threshold: number | null;
  window_minutes: number;
  server_id: string;
  server_name: string;
  user_id: string;
  url: string;
}

/**
 * Sends every change of state not yet delivered, oldest first.
 *
 * Only to accounts with a webhook. A change recorded before one was set up is
 * not sent later: news of an incident that ended last week is not news. The
 * end of an alert is sent only where the rule asks for it.
 */
async function deliverPending(send: WebhookSender): Promise<void> {
  const pending = await getPool().query<PendingRow>(
    `SELECT e.id, e.kind, e.value, e.occurred_at, e.attempts,
            r.kind AS rule_kind, NULLIF(e.target, '') AS tool_name, r.threshold,
            r.window_minutes,
            s.id AS server_id, s.name AS server_name, s.user_id, w.url
     FROM alert_events e
     JOIN alert_rules r ON r.id = e.rule_id
     JOIN servers s ON s.id = r.server_id
     JOIN alert_webhooks w ON w.user_id = s.user_id
     WHERE e.delivered_at IS NULL
       AND e.attempts < $1
       AND e.occurred_at >= w.created_at
       AND (e.kind = 'firing' OR r.notify_resolved)
     ORDER BY e.occurred_at, e.id`,
    [MAX_DELIVERY_ATTEMPTS],
  );

  for (const event of pending.rows) {
    const payload: WebhookPayload = {
      ...message(event),
      event: event.kind,
      server: { id: event.server_id, name: event.server_name },
      rule: {
        kind: event.rule_kind,
        toolName: event.tool_name,
        threshold: event.threshold,
        windowMinutes: event.window_minutes,
      },
      value: event.value,
      occurredAt: event.occurred_at.toISOString(),
    };

    const outcome = await attempt(event.url, payload, send);

    await getPool().query(
      `UPDATE alert_events
       SET attempts = attempts + 1,
           delivered_at = CASE WHEN $2 THEN now() END,
           last_error = $3
       WHERE id = $1`,
      [event.id, outcome.ok, outcome.error],
    );

    await recordAttempt(event.user_id, outcome);
  }
}

export interface DeliveryOutcome {
  ok: boolean;
  status: number | null;
  error: string | null;
}

/** One delivery, with whatever went wrong put into words. */
export async function attempt(
  url: string,
  payload: WebhookPayload,
  send: WebhookSender,
): Promise<DeliveryOutcome> {
  try {
    const status = await send(url, payload);
    const ok = status >= 200 && status < 300;

    return { ok, status, error: ok ? null : `The webhook answered ${status}` };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: `Could not reach the webhook: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** Keeps the latest outcome on the webhook, for the settings page. */
export async function recordAttempt(userId: string, outcome: DeliveryOutcome): Promise<void> {
  await getPool().query(
    `UPDATE alert_webhooks
     SET last_attempt_at = now(), last_status = $2, last_error = $3
     WHERE user_id = $1`,
    [userId, outcome.status, outcome.error],
  );
}

/** The sentence a person reads in Slack or Discord. */
function message(event: PendingRow): { text: string; content: string } {
  const window = describeMinutes(event.window_minutes);
  const subject =
    event.tool_name === null ? event.server_name : `${event.server_name}, ${event.tool_name}`;
  let text: string;

  if (event.rule_kind === 'silence') {
    text =
      event.kind === 'firing'
        ? `${subject} has had no calls for ${window}.`
        : `${subject} is receiving calls again.`;
  } else {
    const rate = percent(event.value ?? 0);
    const threshold = percent(event.threshold ?? 0);

    text =
      event.kind === 'firing'
        ? `${subject}: ${rate} of calls failed over the last ${window}, ` +
          `at or above the ${threshold} threshold.`
        : `${subject}: the error rate is back under ${threshold}, ` +
          `at ${rate} over the last ${window}.`;
  }

  const line = `mcpspan: ${text}`;

  return { text: line, content: line };
}

function percent(fraction: number): string {
  const value = fraction * 100;

  return `${value >= 10 || value === 0 ? Math.round(value) : value.toFixed(1)}%`;
}

function describeMinutes(minutes: number): string {
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');

  return plural(minutes, 'minute');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
