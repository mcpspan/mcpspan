import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type EventSeed, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool } from '../db.ts';
import type { ClientVersions } from '../client-versions.ts';

let account: TestAccount;

async function get<T>(path: string, status = 200): Promise<T> {
  const response = await createApp().request(`/v1/dashboard/${path}`, {
    headers: { cookie: account.cookie },
  });

  expect(response.status).toBe(status);

  return (await response.json()) as T;
}

const HOUR = 60 * 60 * 1000;

/** `count` calls spread over the hours from `fromHours` to `toHours` ago. */
function calls(count: number, fromHours: number, toHours: number, seed: EventSeed): EventSeed[] {
  return Array.from({ length: count }, (_, i) => ({
    ...seed,
    occurredAt: new Date(Date.now() - (fromHours - ((fromHours - toHours) * (i + 0.5)) / count) * HOUR),
  }));
}

/** The last seven days, as the dashboard asks for them. */
const week = `from=${new Date(Date.now() - 7 * 24 * HOUR).toISOString()}&to=${new Date(Date.now() + HOUR).toISOString()}`;

const cursor = { clientType: 'cursor', clientName: 'cursor-vscode' } as const;
const refused = { success: false, errorSource: 'arguments', errorType: 'ValidationError' } as const;
const outage = { success: false, errorSource: 'exception', errorType: 'HTTPError' } as const;

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount();

  await seedEvents(account.serverId, [
    // Cursor 1.0.0 has called for weeks; 1.1.0 arrived two days ago and gets seat_map's arguments refused.
    { ...cursor, clientVersion: '1.0.0', serverVersion: '2.0.0', occurredAt: new Date(Date.now() - 30 * 24 * HOUR) },
    ...calls(60, 72, 1, { ...cursor, clientVersion: '1.0.0', serverVersion: '2.0.0', toolName: 'search' }),
    ...calls(38, 72, 1, { ...cursor, clientVersion: '1.0.0', serverVersion: '2.0.0', toolName: 'seat_map' }),
    ...calls(2, 72, 1, { ...cursor, clientVersion: '1.0.0', serverVersion: '2.0.0', toolName: 'seat_map', ...refused }),
    ...calls(40, 48, 1, { ...cursor, clientVersion: '1.1.0', serverVersion: '2.0.0', toolName: 'search' }),
    ...calls(8, 48, 1, { ...cursor, clientVersion: '1.1.0', serverVersion: '2.0.0', toolName: 'seat_map' }),
    ...calls(12, 48, 1, { ...cursor, clientVersion: '1.1.0', serverVersion: '2.0.0', toolName: 'seat_map', ...refused }),
    // The server failing in the same days is the server's doing, not the client's.
    ...calls(30, 48, 1, { ...cursor, clientVersion: '1.1.0', serverVersion: '2.0.0', toolName: 'weather', ...outage }),
    // Two clients under one type, each with its own numbering.
    ...calls(30, 72, 1, { clientType: 'other', clientName: 'windsurf', clientVersion: '1.12.0' }),
    ...calls(10, 72, 1, { clientType: 'other', clientName: 'zed', clientVersion: '0.201.3' }),
    // A client that names no version.
    ...calls(5, 72, 1, { clientType: 'claude', clientName: 'claude-ai' }),
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/client-versions', () => {
  it("puts each client's versions newest first, says which are new, and names the tool that got worse", async () => {
    const { clients } = await get<{ clients: ClientVersions[] }>(`client-versions?${week}`);

    expect(clients[0]!.clientType).toBe('cursor');
    expect(clients[0]!.versions.map((v) => [v.version, v.isNew, v.previous, v.verdict])).toEqual([
      ['1.1.0', true, '1.0.0', 'worse'],
      ['1.0.0', false, null, 'first'],
    ]);
    expect(clients[0]!.versions[0]).toMatchObject({
      calls: 90,
      refused: 12,
      comparedOn: ['2.0.0'],
      changedTools: [
        { toolName: 'seat_map', change: 'worse', before: { calls: 40, refused: 2 }, after: { calls: 20, refused: 12 } },
      ],
    });
  });

  it('compares two versions only on the server versions both called', async () => {
    await seedEvents(account.serverId, [
      ...calls(50, 72, 40, { ...cursor, clientName: 'cline', clientVersion: '3.0.0', serverVersion: '1.0.0', toolName: 'search', ...refused }),
      ...calls(50, 30, 1, { ...cursor, clientName: 'cline', clientVersion: '3.1.0', serverVersion: '2.0.0', toolName: 'search' }),
    ]);
    const { clients } = await get<{ clients: ClientVersions[] }>(`client-versions?${week}&clientType=cursor`);
    const cline = clients[0]!.versions.find((v) => v.clientName === 'cline' && v.version === '3.1.0');

    expect(cline).toMatchObject({ previous: '3.0.0', verdict: 'too-early', comparedOn: [], changedTools: [] });
  });

  it('keeps the versions of different clients under one type apart', async () => {
    const { clients } = await get<{ clients: ClientVersions[] }>(`client-versions?${week}`);
    const other = clients.find((client) => client.clientType === 'other')!;

    expect(other.versions.map((v) => [v.clientName, v.version, v.previous])).toEqual(
      expect.arrayContaining([
        ['windsurf', '1.12.0', null],
        ['zed', '0.201.3', null],
      ]),
    );
  });

  it('counts calls without a version apart', async () => {
    const { clients } = await get<{ clients: ClientVersions[] }>(`client-versions?${week}`);

    expect(clients.find((client) => client.clientType === 'claude')).toMatchObject({ versions: [], unversionedCalls: 5 });
  });

  it('narrows to one client', async () => {
    const { clients } = await get<{ clients: ClientVersions[] }>(`client-versions?${week}&clientType=other`);

    expect(clients.map((client) => client.clientType)).toEqual(['other']);
  });

  it("lists one version's calls", async () => {
    const { calls: listed } = await get<{ calls: { clientVersion: string }[] }>(
      `calls?${week}&clientName=cursor-vscode&clientVersion=1.1.0&limit=100`,
    );

    expect(listed).toHaveLength(90);
    expect(new Set(listed.map((call) => call.clientVersion))).toEqual(new Set(['1.1.0']));
  });
});
