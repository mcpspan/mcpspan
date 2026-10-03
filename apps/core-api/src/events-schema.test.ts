import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { describeIssues, eventBatchSchema, toolCallEventSchema } from './events-schema.ts';

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    toolName: 'search_flights',
    durationMs: 42.5,
    success: true,
    clientType: 'claude',
    timestamp: '2026-09-17T10:00:00.000Z',
    sdkVersion: '0.1.0',
    ...overrides,
  };
}

describe('a well formed event', () => {
  it('is accepted', () => {
    expect(toolCallEventSchema.safeParse(validEvent()).success).toBe(true);
  });

  it('is accepted with every optional field filled in', () => {
    const result = toolCallEventSchema.safeParse(
      validEvent({
        success: false,
        errorSource: 'result',
        errorType: 'ValidationError',
        errorMessage: 'No flights found',
        clientName: 'Claude Desktop',
        parameters: { destination: 'string', passengers: 'number' },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('is accepted with a duration of zero', () => {
    expect(toolCallEventSchema.safeParse(validEvent({ durationMs: 0 })).success).toBe(true);
  });
});

describe('an event the shape of which is wrong', () => {
  it.each([
    ['the id is not a uuid', { id: 'not-a-uuid' }],
    ['the tool name is empty', { toolName: '' }],
    ['the tool name is missing', { toolName: undefined }],
    ['success is a string', { success: 'true' }],
    ['the duration is text', { durationMs: '42' }],
    ['the duration is negative', { durationMs: -1 }],
    ['the duration is infinite', { durationMs: Number.POSITIVE_INFINITY }],
    ['the timestamp is not a date', { timestamp: 'yesterday' }],
    ['the timestamp has no timezone', { timestamp: '2026-09-17T10:00:00' }],
    ['the client type is empty', { clientType: '' }],
    ['the sdk version is missing', { sdkVersion: undefined }],
  ])('is refused when %s', (_label, overrides) => {
    expect(toolCallEventSchema.safeParse(validEvent(overrides)).success).toBe(false);
  });

  it('is refused when a field is absurdly long', () => {
    expect(toolCallEventSchema.safeParse(validEvent({ toolName: 'x'.repeat(5_000) })).success).toBe(
      false,
    );
  });

  it('is refused when it carries more parameters than any tool has', () => {
    const parameters = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`field${i}`, 'string']),
    );

    expect(toolCallEventSchema.safeParse(validEvent({ parameters })).success).toBe(false);
  });
});

describe('vocabulary we do not control', () => {
  it.each([
    ['a client released after this API', { clientType: 'windsurf' }],
    ['an error source we have not defined', { errorSource: 'timeout' }],
  ])('accepts %s rather than refusing the batch', (_label, overrides) => {
    // A refusal is final: the SDK drops the batch rather than retrying it. We
    // are not spending somebody's data on a name we had not heard of.
    expect(toolCallEventSchema.safeParse(validEvent(overrides)).success).toBe(true);
  });

  it('accepts a timestamp from a badly set clock', () => {
    expect(toolCallEventSchema.safeParse(validEvent({ timestamp: '2099-01-01T00:00:00Z' })).success).toBe(
      true,
    );
  });
});

describe('a server named in the payload', () => {
  it('is ignored rather than trusted', () => {
    const result = toolCallEventSchema.safeParse(
      validEvent({ serverId: '00000000-0000-0000-0000-000000000000' }),
    );

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('serverId');
  });
});

describe('a batch', () => {
  it('is accepted when every event in it is valid', () => {
    expect(eventBatchSchema.safeParse({ events: [validEvent(), validEvent()] }).success).toBe(true);
  });

  it('is accepted when empty', () => {
    expect(eventBatchSchema.safeParse({ events: [] }).success).toBe(true);
  });

  it('is refused when one event in it is broken', () => {
    expect(
      eventBatchSchema.safeParse({ events: [validEvent(), validEvent({ durationMs: -5 })] }).success,
    ).toBe(false);
  });

  it.each([
    ['events is missing', {}],
    ['events is not a list', { events: 'nope' }],
    ['the body is not an object', 'nope'],
  ])('is refused when %s', (_label, body) => {
    expect(eventBatchSchema.safeParse(body).success).toBe(false);
  });
});

describe('describeIssues', () => {
  it('says which event and which field went wrong', () => {
    const result = eventBatchSchema.safeParse({
      events: [validEvent(), validEvent({ durationMs: -5 })],
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(describeIssues(result.error)).toEqual([
      { field: 'events.1.durationMs', message: expect.any(String) },
    ]);
  });

  it('names the body itself when the whole thing is wrong', () => {
    const result = eventBatchSchema.safeParse('nope');

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(describeIssues(result.error)[0]?.field).toBe('(body)');
  });
});
