import { Hono } from 'hono';

import {
  type AlertKind,
  attempt,
  WHOLE_SERVER,
  MAX_ERROR_RATE_WINDOW_MINUTES,
  MAX_SILENCE_WINDOW_MINUTES,
  recordAttempt,
  sendWebhook,
  type WebhookSender,
} from '../alerts.ts';
import { getPool } from '../db.ts';
import { parsePage, takePage } from '../paging.ts';
import { ownsServer } from '../servers.ts';
import { requireSession, type SessionVariables } from '../session.ts';

/** Longest webhook address accepted. Slack's and Discord's are well under this. */
const MAX_URL_LENGTH = 2_000;

/** Changes of state on one page of the settings page's history. */
const RECENT_EVENTS = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RuleInput {
  kind: AlertKind;
  threshold: number | null;
  windowMinutes: number;
  minCalls: number;
  notifyResolved: boolean;
}

/**
 * Alert rules and where they are sent, for the signed-in account.
 *
 * Every rule belongs to a server, and every request that names one is checked
 * against the servers the session owns, the same way every other route is.
 */
export function createAlertRoutes(
  /** Injected so a test can receive the test notification itself. */
  send: WebhookSender = sendWebhook,
) {
  const app = new Hono<{ Variables: SessionVariables }>();

  app.use('*', requireSession());

  app.get('/', async (c) => {
    const { userId } = c.get('session');
    const page = parsePage(
      (name) => c.req.query(name),
      { limit: RECENT_EVENTS, max: 100 },
      'events',
    );

    if ('error' in page) return c.json({ error: page.error }, 400);

    const [webhook, rules, events] = await Promise.all([
      getPool().query<{
        url: string;
        last_attempt_at: Date | null;
        last_status: number | null;
        last_error: string | null;
      }>(
        `SELECT url, last_attempt_at, last_status, last_error
         FROM alert_webhooks WHERE user_id = $1`,
        [userId],
      ),
      getPool().query<{
        id: string;
        server_id: string;
        server_name: string;
        tool_names: string[] | null;
        kind: AlertKind;
        threshold: number | null;
        window_minutes: number;
        min_calls: number;
        enabled: boolean;
        notify_resolved: boolean;
        firing_targets: string[];
      }>(
        `SELECT r.id, r.server_id, s.name AS server_name, r.tool_names, r.kind, r.threshold,
                r.window_minutes, r.min_calls, r.enabled, r.notify_resolved,
                ARRAY(
                  SELECT st.target FROM alert_states st
                  WHERE st.rule_id = r.id AND st.state = 'firing'
                  ORDER BY st.target
                ) AS firing_targets
         FROM alert_rules r
         JOIN servers s ON s.id = r.server_id
         WHERE s.user_id = $1
         ORDER BY s.created_at, r.created_at`,
        [userId],
      ),
      getPool().query<{
        id: string;
        rule_id: string;
        server_name: string;
        tool_name: string | null;
        rule_kind: AlertKind;
        kind: 'firing' | 'resolved';
        value: number | null;
        occurred_at: Date;
        delivered_at: Date | null;
        last_error: string | null;
        not_wanted: boolean;
      }>(
        `SELECT e.id, e.rule_id, s.name AS server_name, NULLIF(e.target, '') AS tool_name,
                r.kind AS rule_kind, e.kind,
                e.value, e.occurred_at, e.delivered_at, e.last_error,
                e.kind = 'resolved' AND NOT r.notify_resolved AS not_wanted
         FROM alert_events e
         JOIN alert_rules r ON r.id = e.rule_id
         JOIN servers s ON s.id = r.server_id
         WHERE s.user_id = $1
         ORDER BY e.occurred_at DESC, e.id
         LIMIT $2 OFFSET $3`,
        [userId, page.limit + 1, page.offset],
      ),
    ]);

    const hook = webhook.rows[0];
    const recent = takePage(events.rows, page);

    return c.json({
      webhook:
        hook === undefined
          ? null
          : {
              url: hook.url,
              lastAttemptAt: hook.last_attempt_at?.toISOString() ?? null,
              lastStatus: hook.last_status,
              lastError: hook.last_error,
            },
      rules: rules.rows.map((row) => ({
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        toolNames: row.tool_names,
        kind: row.kind,
        threshold: row.threshold,
        windowMinutes: row.window_minutes,
        minCalls: row.min_calls,
        enabled: row.enabled,
        notifyResolved: row.notify_resolved,
        // Firing when anything it watches is. The tools that are, by name; an
        // empty list with firing set means the whole server.
        firing: row.firing_targets.length > 0,
        firingTools: row.firing_targets.filter((target) => target !== WHOLE_SERVER),
      })),
      eventsOffset: page.offset,
      eventsHaveMore: recent.hasMore,
      events: recent.items.map((row) => ({
        id: row.id,
        ruleId: row.rule_id,
        serverName: row.server_name,
        toolName: row.tool_name,
        ruleKind: row.rule_kind,
        kind: row.kind,
        value: row.value,
        occurredAt: row.occurred_at.toISOString(),
        deliveredAt: row.delivered_at?.toISOString() ?? null,
        error: row.last_error,
        // Not sent because the rule asks only for starts, which is a choice
        // rather than a failure and is shown as one.
        notWanted: row.not_wanted,
      })),
    });
  });

  app.put('/webhook', async (c) => {
    const { userId } = c.get('session');
    const url = parseWebhookUrl((await readBody(c.req.raw))?.['url']);

    if ('error' in url) return c.json({ error: url.error }, 400);

    // Replacing the address keeps the record's age, so changes of state from
    // before the replacement are still the ones it owes a delivery.
    await getPool().query(
      `INSERT INTO alert_webhooks (user_id, url) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET url = EXCLUDED.url, last_attempt_at = NULL, last_status = NULL, last_error = NULL`,
      [userId, url.url],
    );

    return c.json({ url: url.url });
  });

  app.delete('/webhook', async (c) => {
    await getPool().query('DELETE FROM alert_webhooks WHERE user_id = $1', [
      c.get('session').userId,
    ]);

    return c.body(null, 204);
  });

  /**
   * Sends a notification that says it is a test, and reports what happened.
   *
   * So a mistyped address is found while somebody is looking at it, rather
   * than during the incident it was meant to announce.
   */
  app.post('/webhook/test', async (c) => {
    const { userId } = c.get('session');
    const found = await getPool().query<{ url: string }>(
      'SELECT url FROM alert_webhooks WHERE user_id = $1',
      [userId],
    );
    const url = found.rows[0]?.url;

    if (url === undefined) return c.json({ error: 'Set a webhook address first' }, 404);

    const text = 'mcpspan: this is a test notification. Alerts will arrive here.';
    const outcome = await attempt(
      url,
      {
        text,
        content: text,
        event: 'test',
        server: null,
        rule: null,
        value: null,
        occurredAt: new Date().toISOString(),
      },
      send,
    );

    await recordAttempt(userId, outcome);

    return c.json(outcome);
  });

  app.post('/rules', async (c) => {
    const { userId } = c.get('session');
    const body = await readBody(c.req.raw);
    const serverId = body?.['serverId'];

    const owned =
      typeof serverId === 'string' && UUID.test(serverId) && (await ownsServer(userId, serverId));

    if (!owned) {
      return c.json({ error: 'No such server' }, 404);
    }

    const rule = parseRule(body ?? {});

    if ('error' in rule) return c.json({ error: rule.error }, 400);

    const toolNames = parseToolNames(body?.['toolNames']);

    if (toolNames !== null && !Array.isArray(toolNames)) {
      return c.json({ error: toolNames.error }, 400);
    }

    const created = await getPool().query<{ id: string }>(
      `INSERT INTO alert_rules
         (server_id, tool_names, kind, threshold, window_minutes, min_calls, notify_resolved)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        serverId,
        toolNames,
        rule.kind,
        rule.threshold,
        rule.windowMinutes,
        rule.minCalls,
        rule.notifyResolved,
      ],
    );

    return c.json({ id: created.rows[0]?.id }, 201);
  });

  app.patch('/rules/:ruleId', async (c) => {
    const { userId } = c.get('session');
    const ruleId = c.req.param('ruleId');
    const current = await ownedRule(userId, ruleId);

    if (current === undefined) return c.json({ error: 'No such rule' }, 404);

    const body = (await readBody(c.req.raw)) ?? {};
    const rule = parseRule({
      kind: current.kind,
      threshold: body['threshold'] ?? current.threshold,
      windowMinutes: body['windowMinutes'] ?? current.window_minutes,
      minCalls: body['minCalls'] ?? current.min_calls,
      notifyResolved: body['notifyResolved'] ?? current.notify_resolved,
    });

    if ('error' in rule) return c.json({ error: rule.error }, 400);

    const enabled = body['enabled'];

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return c.json({ error: "'enabled' must be true or false" }, 400);
    }

    const toolNames =
      body['toolNames'] === undefined ? current.tool_names : parseToolNames(body['toolNames']);

    if (toolNames !== null && !Array.isArray(toolNames)) {
      return c.json({ error: toolNames.error }, 400);
    }

    // A rule switched off, or with a changed condition, starts again from
    // "ok": its old states were verdicts on a condition that no longer
    // applies, and resolving one later would announce the end of something
    // nobody is watching. Changing only whether ends are sent changes no
    // condition, so it leaves the states alone.
    const conditionChanged =
      enabled !== undefined ||
      rule.threshold !== current.threshold ||
      rule.windowMinutes !== current.window_minutes ||
      rule.minCalls !== current.min_calls ||
      JSON.stringify(toolNames) !== JSON.stringify(current.tool_names);

    const client = await getPool().connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE alert_rules
         SET threshold = $2, window_minutes = $3, min_calls = $4,
             enabled = coalesce($5, enabled), notify_resolved = $6, tool_names = $7
         WHERE id = $1`,
        [
          ruleId,
          rule.threshold,
          rule.windowMinutes,
          rule.minCalls,
          enabled ?? null,
          rule.notifyResolved,
          toolNames,
        ],
      );

      if (conditionChanged) {
        await client.query('DELETE FROM alert_states WHERE rule_id = $1', [ruleId]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return c.json({ id: ruleId });
  });

  app.delete('/rules/:ruleId', async (c) => {
    const { userId } = c.get('session');
    const ruleId = c.req.param('ruleId');

    if ((await ownedRule(userId, ruleId)) === undefined) {
      return c.json({ error: 'No such rule' }, 404);
    }

    await getPool().query('DELETE FROM alert_rules WHERE id = $1', [ruleId]);

    return c.body(null, 204);
  });

  return app;
}

interface StoredRule {
  kind: AlertKind;
  threshold: number | null;
  window_minutes: number;
  min_calls: number;
  notify_resolved: boolean;
  tool_names: string[] | null;
}

async function ownedRule(userId: string, ruleId: string): Promise<StoredRule | undefined> {
  if (!UUID.test(ruleId)) return undefined;

  const result = await getPool().query<StoredRule>(
    `SELECT r.kind, r.threshold, r.window_minutes, r.min_calls, r.notify_resolved, r.tool_names
     FROM alert_rules r JOIN servers s ON s.id = r.server_id
     WHERE r.id = $1 AND s.user_id = $2`,
    [ruleId, userId],
  );

  return result.rows[0];
}

/**
 * Reads a webhook address, or says what is wrong with it.
 *
 * HTTP and HTTPS only. The address is fetched by this server, from inside
 * whatever network it runs in, so anything else is refused rather than
 * attempted.
 */
function parseWebhookUrl(value: unknown): { url: string } | { error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { error: 'Give the webhook address as "url"' };
  }

  const trimmed = value.trim();

  if (trimmed.length > MAX_URL_LENGTH) {
    return { error: `A webhook address can be at most ${MAX_URL_LENGTH} characters` };
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'That is not a web address' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'A webhook address has to start with https:// or http://' };
  }

  return { url: parsed.toString() };
}

/** Longest tool name accepted, matching what the events table stores. */
const MAX_TOOL_NAME = 200;

/** Most tools one rule may watch. Each is checked every minute, one query apiece. */
const MAX_RULE_TOOLS = 50;

/**
 * Reads which tools a rule watches: a list of names, or null for the whole
 * server. An empty list means the whole server too.
 *
 * Not checked against the tools the server has. A tool exists once calls to
 * it are recorded, and a rule set up before its first call, or kept across a
 * quiet spell, is a reasonable thing to want.
 */
function parseToolNames(value: unknown): string[] | null | { error: string } {
  if (value === undefined || value === null) return null;

  if (!Array.isArray(value)) return { error: "'toolNames' must be a list of tool names" };

  const names = [...new Set(value)];

  if (names.length === 0) return null;

  if (names.length > MAX_RULE_TOOLS) {
    return { error: `A rule can watch at most ${MAX_RULE_TOOLS} tools` };
  }

  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME) {
      return { error: `Each tool name must be text of 1 to ${MAX_TOOL_NAME} characters` };
    }
  }

  return (names as string[]).sort();
}

/** Reads a rule, or says which part of it is wrong. */
function parseRule(body: Record<string, unknown>): RuleInput | { error: string } {
  const kind = body['kind'];

  if (kind !== 'error_rate' && kind !== 'silence') {
    return { error: "'kind' must be error_rate or silence" };
  }

  const maxWindow =
    kind === 'error_rate' ? MAX_ERROR_RATE_WINDOW_MINUTES : MAX_SILENCE_WINDOW_MINUTES;
  const windowMinutes = body['windowMinutes'];

  if (
    typeof windowMinutes !== 'number' ||
    !Number.isInteger(windowMinutes) ||
    windowMinutes < 1 ||
    windowMinutes > maxWindow
  ) {
    return { error: `'windowMinutes' must be a whole number from 1 to ${maxWindow}` };
  }

  const notifyResolved = body['notifyResolved'] ?? true;

  if (typeof notifyResolved !== 'boolean') {
    return { error: "'notifyResolved' must be true or false" };
  }

  if (kind === 'silence') {
    return { kind, threshold: null, windowMinutes, minCalls: 1, notifyResolved };
  }

  const threshold = body['threshold'];

  if (typeof threshold !== 'number' || !(threshold > 0) || threshold > 1) {
    return { error: "'threshold' must be a fraction above 0 and at most 1, like 0.2 for 20%" };
  }

  const minCalls = body['minCalls'] ?? 10;

  const validMinCalls =
    typeof minCalls === 'number' &&
    Number.isInteger(minCalls) &&
    minCalls >= 1 &&
    minCalls <= 100_000;

  if (!validMinCalls) {
    return { error: "'minCalls' must be a whole number from 1 to 100000" };
  }

  return { kind, threshold, windowMinutes, minCalls, notifyResolved };
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();

    return typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
