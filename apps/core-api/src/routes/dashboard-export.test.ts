import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createAccount, resetDatabase, seedEvents, type TestAccount } from '../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { closePool, getPool } from '../db.ts';
import { csvLine } from '../export.ts';

let account: TestAccount;

async function get(path: string): Promise<Response> {
  return createApp().request(`/v1/dashboard/${path}`, { headers: { cookie: account.cookie } });
}

async function json<T>(path: string): Promise<T> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

/** Splits CSV text into records, honouring quoted fields with line breaks. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 1;
    } else {
      field += char;
    }
  }

  return records;
}

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

beforeEach(async () => {
  await resetDatabase();
  account = await createAccount({ serverName: 'Flights & Co' });

  await seedEvents(account.serverId, [
    { toolName: 'search', occurredAt: ago(180), parameters: { destination: 'string' } },
    { toolName: 'search', occurredAt: ago(5) },
    {
      toolName: 'search',
      success: false,
      errorSource: 'result',
      errorMessage: 'No flights, try "WAW",\nor another day',
      occurredAt: ago(4),
    },
    { toolName: 'book', success: false, errorSource: 'exception', errorType: 'TypeError', occurredAt: ago(3) },
    { toolName: 'ghost', success: false, errorSource: 'unknown_tool', occurredAt: ago(2) },
  ]);
});

afterAll(async () => {
  await closePool();
});

describe('/v1/dashboard/export/calls', () => {
  it('downloads every call in the window as CSV, oldest first', async () => {
    const response = await get('export/calls');
    const records = parseCsv(await response.text());

    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="mcpspan-flights-co-calls-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(records[0]).toContain('session_id');
    expect(records.slice(1).map((record) => record[3])).toEqual([
      'search',
      'search',
      'search',
      'book',
      'ghost',
    ]);
  });

  it('keeps a message with quotes, commas and a line break in one field', async () => {
    const records = parseCsv(await (await get('export/calls')).text());
    const failed = records.find((record) => record[6] === 'result');

    expect(failed?.[8]).toBe('No flights, try "WAW",\nor another day');
  });

  it('holds what the errors page holds, for the same window and filters', async () => {
    const { failures } = await json<{ failures: { id: string }[] }>(
      'errors?toolName=search&limit=200',
    );
    const records = parseCsv(
      await (await get('export/calls?toolName=search&failedOnly=true')).text(),
    );

    expect(records.slice(1).map((record) => record[0]).sort()).toEqual(
      failures.map((failure) => failure.id).sort(),
    );
  });

  it('holds as many calls of a tool as the summary counts', async () => {
    const summary = await json<{ totalCalls: number }>('summary?toolName=search');
    const records = parseCsv(await (await get('export/calls?toolName=search')).text());

    expect(records.length - 1).toBe(summary.totalCalls);
  });

  it('gives one JSON object a line when asked', async () => {
    const response = await get('export/calls?format=ndjson&toolName=search');
    const lines = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));

    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(lines[0]).toMatchObject({ toolName: 'search', parameters: { destination: 'string' } });
    expect(lines).toHaveLength(3);
  });

  it('reads past its page size without losing or repeating a row', async () => {
    await getPool().query(
      `INSERT INTO tool_calls (id, server_id, occurred_at, tool_name, duration_ms, success,
                               client_type, sdk_version)
       SELECT gen_random_uuid(), $1, now() - interval '30 minutes', 'bulk', 1, true, 'claude', '0.1.0'
       FROM generate_series(1, 12000)`,
      [account.serverId],
    );

    const records = parseCsv(await (await get('export/calls?toolName=bulk')).text());
    const ids = new Set(records.slice(1).map((record) => record[0]));

    // All at one instant, so paging has to lean on the id to keep its place.
    expect(records.length - 1).toBe(12_000);
    expect(ids.size).toBe(12_000);
  });

  it('refuses a format it does not write', async () => {
    expect((await get('export/calls?format=xlsx')).status).toBe(400);
  });
});

describe('/v1/dashboard/export/tools', () => {
  it('is the tool table, row for row', async () => {
    const { tools } = await json<{ tools: { toolName: string; calls: number; errors: number }[] }>(
      'tools',
    );
    const records = parseCsv(await (await get('export/tools')).text());

    expect(records[0]).toEqual([
      'tool_name',
      'calls',
      'errors',
      'error_rate',
      'mean_ms',
      'p50_ms',
      'p95_ms',
    ]);
    expect(records.slice(1).map((record) => [record[0], Number(record[1]), Number(record[2])])).toEqual(
      tools.map((tool) => [tool.toolName, tool.calls, tool.errors]),
    );
  });
});

describe('csvLine', () => {
  it('defuses text a spreadsheet would run as a formula', () => {
    expect(csvLine(['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', 'plain'])).toBe(
      `"'=HYPERLINK(""http://x"")",'+1,'-2,'@SUM(A1),plain\r\n`,
    );
  });

  it('writes numbers and booleans as they are, and nothing for null', () => {
    expect(csvLine([-2, true, null, 0.5])).toBe('-2,true,,0.5\r\n');
  });
});
