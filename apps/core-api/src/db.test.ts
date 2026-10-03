import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.ts';
import { closePool, getPool, isDatabaseUnavailable } from './db.ts';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env['DATABASE_URL'];
});

afterEach(async () => {
  if (saved === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = saved;

  await closePool();
});

describe('getPool without a configured database', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('refuses when DATABASE_URL is %s', (_label, value) => {
    if (value === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = value;

    expect(() => getPool()).toThrow(/DATABASE_URL is not set/);
  });

  it('says how to fix it, since this is the first wall a self-hoster hits', () => {
    delete process.env['DATABASE_URL'];

    expect(() => getPool()).toThrow(/\.env\.example/);
  });
});

describe('getPool when configured', () => {
  it('hands back the same pool rather than opening another', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@localhost:5432/db';

    expect(getPool()).toBe(getPool());
  });
});

describe('isDatabaseUnavailable', () => {
  it.each([
    ['a refused connection', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['a host that does not resolve', Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' })],
    ['a database shutting down', Object.assign(new Error('terminating'), { code: '57P01' })],
    ['a connection exception', Object.assign(new Error('lost'), { code: '08006' })],
    ['a pool that timed out', new Error('timeout exceeded when trying to connect')],
    ['a connection cut mid-query', new Error('Connection terminated unexpectedly')],
    [
      'every address refusing at once',
      new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]),
    ],
  ])('recognises %s', (_label, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it.each([
    ['a syntax error', Object.assign(new Error('syntax'), { code: '42601' })],
    ['a constraint violation', Object.assign(new Error('duplicate'), { code: '23505' })],
    ['an ordinary bug', new TypeError('undefined is not a function')],
    ['something that is not an error', 'nope'],
  ])('does not mistake %s for an outage', (_label, error) => {
    // Called an outage, a bug would send somebody off restarting a database
    // that was fine.
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
});

describe('the API with no database to talk to', () => {
  it('says the database is the problem, not that something went wrong', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Port 1: nothing listens there, so the connection is refused at once.
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:1/db';

    const response = await createApp().request('/v1/diagnostics', {
      headers: { cookie: 'mcpspan_session=anything' },
    });

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /cannot reach its database/,
    );

    complained.mockRestore();
  });

  it('survives an idle connection being cut, rather than exiting', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:1/db';
    const complained = vi.spyOn(console, 'error').mockImplementation(() => {});

    // What the pool does when the database goes away under an idle
    // connection. Without a listener this line would throw.
    expect(() => getPool().emit('error', new Error('Connection terminated'))).not.toThrow();

    complained.mockRestore();
  });
});
