import { randomUUID } from 'node:crypto';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';

let account: TestAccount;

async function get<T>(path: string, status = 200): Promise<T> {
  const response = await createApp().request(path, { headers: { cookie: account.cookie } });

  expect(response.status).toBe(status);

  return (await response.json()) as T;
}

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

/** Rows written in one statement share an instant, which is where paging breaks if it can. */
async function bulk(
  count: number,
  columns: { tool?: string; success?: boolean; session?: string },
): Promise<void> {
  await getPool().query(
    `INSERT INTO tool_calls (id, server_id, occurred_at, tool_name, duration_ms, success,
                             error_source, client_type, sdk_version, session_id)
     SELECT gen_random_uuid(), $1, now() - interval '10 minutes', $2, 1, $3,
            CASE WHEN $3 THEN NULL ELSE 'result' END, 'claude', '0.1.0', $4
     FROM generate_series(1, $5)`,
    [
      account.serverId,
      columns.tool ?? 'bulk',
      columns.success ?? true,
      columns.session ?? null,
      count,
    ],
  );
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();
});

afterAll(async () => {
  await closePool();
});

describe('the failures list', () => {
  it('walks every failure once, in order, page by page', async () => {
    await bulk(7, { success: false });

    const seen: string[] = [];
    let cursor: string | null = '';

    while (cursor !== null) {
      const page: { failures: { id: string }[]; nextCursor: string | null } = await get(
        `/v1/dashboard/errors?limit=3${cursor === '' ? '' : `&before=${cursor}`}`,
      );
      seen.push(...page.failures.map((failure) => failure.id));
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('refuses a page marker it did not give out', async () => {
    await get('/v1/dashboard/errors?before=not-a-cursor', 400);
  });
});

describe('the calls of one session', () => {
  it('pages past five hundred calls without losing or repeating one', async () => {
    const session = randomUUID();
    await bulk(620, { session });

    const first = await get<{ calls: { id: string }[]; nextCursor: string | null }>(
      `/v1/dashboard/sessions/${session}`,
    );
    const second = await get<{ calls: { id: string }[]; nextCursor: string | null }>(
      `/v1/dashboard/sessions/${session}?after=${first.nextCursor}`,
    );

    const ids = [...first.calls, ...second.calls].map((call) => call.id);

    expect(first.calls).toHaveLength(500);
    expect(second.calls).toHaveLength(120);
    expect(second.nextCursor).toBeNull();
    expect(new Set(ids).size).toBe(620);
  });
});

describe('ranked lists', () => {
  beforeEach(async () => {
    // Five tools with different call counts, a tool the server lacks under
    // five invented names, and five sessions with a step each.
    for (const [index, tool] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      const session = randomUUID();
      await seedEvents(
        account.serverId,
        Array.from({ length: 5 - index }, (_, call) => ({
          toolName: tool,
          sessionId: session,
          success: call > 0,
          errorSource: call > 0 ? undefined : 'result',
          errorMessage: call > 0 ? undefined : `message ${tool}`,
          occurredAt: ago(30 - index - call * 0.1),
        })),
      );
      await seedEvents(account.serverId, [
        {
          toolName: `ghost_${tool}`,
          success: false,
          errorSource: 'unknown_tool',
          occurredAt: ago(5),
        },
      ]);
    }
  });

  it('pages the tool table, and says how many there are', async () => {
    const page = await get<{ tools: { toolName: string }[]; total: number; hasMore: boolean }>(
      '/v1/dashboard/tools?limit=2&offset=2',
    );

    expect(page.tools.map((tool) => tool.toolName)).toEqual(['c', 'd']);
    expect(page).toMatchObject({ total: 5, hasMore: true });
  });

  it('pages the tools that do not exist', async () => {
    const last = await get<{ tools: unknown[]; hasMore: boolean }>(
      '/v1/dashboard/unknown-tools?limit=2&offset=4',
    );

    expect(last.tools).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it('pages sessions and transitions', async () => {
    const sessions = await get<{ sessions: unknown[]; hasMore: boolean }>(
      '/v1/dashboard/sessions?limit=2',
    );
    const transitions = await get<{ transitions: unknown[]; hasMore: boolean }>(
      '/v1/dashboard/transitions?limit=2&offset=1',
    );

    expect(sessions).toMatchObject({ hasMore: true });
    expect(sessions.sessions).toHaveLength(2);
    expect(transitions.transitions).toHaveLength(2);
  });

  it("pages a tool's messages", async () => {
    await seedEvents(
      account.serverId,
      Array.from({ length: 12 }, (_, i) => ({
        toolName: 'a',
        success: false,
        errorSource: 'result',
        errorMessage: `different ${i}`,
        occurredAt: ago(1),
      })),
    );

    const first = await get<{ messages: unknown[]; messagesHaveMore: boolean }>(
      '/v1/dashboard/tool-details?toolName=a',
    );
    const second = await get<{ messages: unknown[]; messagesHaveMore: boolean }>(
      '/v1/dashboard/tool-details?toolName=a&messagesOffset=10',
    );

    expect(first).toMatchObject({ messagesHaveMore: true });
    expect(first.messages).toHaveLength(10);
    expect(second.messages).toHaveLength(3);
    expect(second.messagesHaveMore).toBe(false);
  });

  it('refuses an offset that is not a whole number', async () => {
    await get('/v1/dashboard/tools?offset=-1', 400);
    await get('/v1/dashboard/tools?limit=0', 400);
  });
});
