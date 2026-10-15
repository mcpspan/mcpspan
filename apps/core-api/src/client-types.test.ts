import { clientLabel, clientTypeOf } from '@mcpspan/client-types';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase, seedEvents } from '../test/fixtures.ts';
import { reclassifyClients } from './client-reclassify.ts';
import { closePool, getPool } from './db.ts';

// Names as clients give them, and the type each must come out as.
const CASES: readonly [string | null, string][] = [
  ['claude-code', 'claude-code'],
  ['Claude Code', 'claude-code'],
  ['  Claude Code  ', 'claude-code'],
  ['claude-ai', 'claude'],
  ['Claude Desktop', 'claude'],
  // Claude Desktop, chat included, with the server's name on the end.
  ['local-agent-mode-weather-test', 'claude'],
  ['local-agent-mode-claude-code-tools', 'claude'],
  ['cursor-vscode', 'cursor'],
  ['codex-mcp-client', 'codex'],
  ['openai-mcp', 'chatgpt'],
  ['Visual Studio Code', 'vscode'],
  ['Visual Studio Code - Insiders', 'vscode'],
  ['gemini-cli-mcp-client', 'gemini-cli'],
  ['inspector-cli', 'mcp-inspector'],
  ['windsurf', 'other'],
  // Matched literally: a LIKE wildcard in a name means nothing.
  ['100%_client', 'other'],
  ['   ', 'unknown'],
  [null, 'unknown'],
];

describe('clientTypeOf', () => {
  it.each(CASES)('%j is %s', (name, type) => {
    expect(clientTypeOf(name)).toBe(type);
  });

  it('names every type a rule can give', () => {
    for (const [, type] of CASES) expect(clientLabel(type)).not.toBe(type);
  });
});

describe('reclassifyClients', () => {
  let serverId: string;

  beforeEach(async () => {
    await resetDatabase();
    await getPool().query('DELETE FROM settings');
    serverId = (await createApiKey()).serverId;
  });

  afterAll(async () => {
    await closePool();
  });

  async function storedTypes(): Promise<Map<string | null, string>> {
    const result = await getPool().query<{ client_name: string | null; client_type: string }>(
      'SELECT client_name, client_type FROM tool_calls',
    );
    return new Map(result.rows.map((row) => [row.client_name, row.client_type]));
  }

  it('gives stored calls the type the rules give their name, in SQL as in JavaScript', async () => {
    // Stored by an older release, under a type the rules no longer give.
    await seedEvents(
      serverId,
      CASES.map(([clientName]) => ({ clientName: clientName ?? undefined, clientType: 'stale' })),
    );

    await reclassifyClients();

    const stored = await storedTypes();
    for (const [name, type] of CASES) expect([name, stored.get(name)]).toEqual([name, type]);
  });

  it('rebuilds the hourly rollup over the hours that changed', async () => {
    const occurredAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await seedEvents(serverId, [{ clientName: 'local-agent-mode-weather-test', clientType: 'other', occurredAt }]);

    await reclassifyClients();

    const rollup = await getPool().query<{ client_type: string }>(
      'SELECT client_type FROM tool_calls_hourly WHERE server_id = $1',
      [serverId],
    );
    expect(rollup.rows).toEqual([{ client_type: 'claude' }]);
  });

  it('runs once for each change of rules', async () => {
    await seedEvents(serverId, [{ clientName: 'Visual Studio Code', clientType: 'other' }]);

    expect(await reclassifyClients()).toBe(1);

    await getPool().query(`UPDATE tool_calls SET client_type = 'other'`);
    expect(await reclassifyClients()).toBe(0);
    expect((await storedTypes()).get('Visual Studio Code')).toBe('other');
  });
});
