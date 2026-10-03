import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApiKey, resetDatabase } from '../test/fixtures.ts';
import { ContactLog } from './contacts.ts';
import { closePool, getPool } from './db.ts';

let clock = Date.parse('2026-09-25T10:00:00Z');

async function stored(serverId: string): Promise<{ at: Date | null; version: string | null }> {
  const result = await getPool().query<{ at: Date | null; version: string | null }>(
    'SELECT last_contact_at AS at, last_sdk_version AS version FROM servers WHERE id = $1',
    [serverId],
  );

  return result.rows[0] as { at: Date | null; version: string | null };
}

beforeEach(async () => {
  await resetDatabase();
  clock = Date.parse('2026-09-25T10:00:00Z');
});

afterAll(async () => {
  await closePool();
});

describe('ContactLog', () => {
  it('writes the first contact at once, with the SDK version from the User-Agent', async () => {
    const { serverId } = await createApiKey();
    const log = new ContactLog(() => clock);

    await log.touch(serverId, 'mcpspan/0.1.0');

    expect(await stored(serverId)).toEqual({ at: new Date(clock), version: '0.1.0' });
  });

  it('writes at most once a minute for the same version', async () => {
    const { serverId } = await createApiKey();
    const log = new ContactLog(() => clock);
    const first = clock;

    await log.touch(serverId, 'mcpspan/0.1.0');
    clock += 30_000;
    await log.touch(serverId, 'mcpspan/0.1.0');

    expect((await stored(serverId)).at).toEqual(new Date(first));

    clock += 31_000;
    await log.touch(serverId, 'mcpspan/0.1.0');

    expect((await stored(serverId)).at).toEqual(new Date(clock));
  });

  it('writes a new version at once, since a redeploy is when somebody checks', async () => {
    const { serverId } = await createApiKey();
    const log = new ContactLog(() => clock);

    await log.touch(serverId, 'mcpspan/0.1.0');
    clock += 5_000;
    await log.touch(serverId, 'mcpspan/0.2.0');

    expect((await stored(serverId)).version).toBe('0.2.0');
  });

  it('keeps the known version when something else sends with the key', async () => {
    const { serverId } = await createApiKey();
    const log = new ContactLog(() => clock);

    await log.touch(serverId, 'mcpspan/0.1.0');
    clock += 120_000;
    await log.touch(serverId, 'curl/8.5.0');

    expect(await stored(serverId)).toEqual({ at: new Date(clock), version: '0.1.0' });
  });

  it('reads the version when the language follows it, as the contract has it', async () => {
    const { serverId } = await createApiKey();
    const log = new ContactLog(() => clock);

    await log.touch(serverId, 'mcpspan/0.3.1 (python)');

    expect((await stored(serverId)).version).toBe('0.3.1');
  });

  it.each([
    ['no User-Agent', undefined],
    ['another client', 'curl/8.5.0'],
    ['a lookalike', 'mcpspan-fake/1.0'],
  ])('records the contact without a version for %s', async (_label, agent) => {
    const { serverId } = await createApiKey();
    const log = new ContactLog(() => clock);

    await log.touch(serverId, agent);

    expect(await stored(serverId)).toEqual({ at: new Date(clock), version: null });
  });
});
