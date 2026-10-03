import { describe, expect, it } from 'vitest';

import {
  describeErrorResult,
  describeException,
  isErrorResult,
  MAX_RESULT_MESSAGE_LENGTH,
  truncate,
} from './failure.js';

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('marks text it had to cut', () => {
    expect(truncate('abcdefghij', 5)).toBe('ab...');
  });

  it('never exceeds the limit', () => {
    expect(truncate('x'.repeat(1_000), 200)).toHaveLength(200);
  });
});

describe('isErrorResult', () => {
  it('recognises a result the tool marked as an error', () => {
    expect(isErrorResult({ isError: true })).toBe(true);
  });

  it.each([
    ['isError false', { isError: false }],
    ['no isError', { content: [] }],
    ['a plain value', 42],
    ['null', null],
    ['undefined', undefined],
  ])('does not mistake %s for an error', (_label, value) => {
    expect(isErrorResult(value)).toBe(false);
  });

  it('demands a real boolean, not something merely truthy', () => {
    expect(isErrorResult({ isError: 'yes' })).toBe(false);
  });
});

describe('describeErrorResult', () => {
  it('reads the text a tool reported', () => {
    expect(describeErrorResult({ content: [{ type: 'text', text: 'Rate limited' }] })).toBe(
      'Rate limited',
    );
  });

  it('joins several text blocks', () => {
    expect(
      describeErrorResult({
        content: [
          { type: 'text', text: 'Rate limited.' },
          { type: 'text', text: 'Try again in 30s.' },
        ],
      }),
    ).toBe('Rate limited. Try again in 30s.');
  });

  it('ignores blocks that are not text', () => {
    expect(
      describeErrorResult({
        content: [
          { type: 'image', data: 'base64-payload-we-must-never-copy' },
          { type: 'text', text: 'Rendering failed' },
        ],
      }),
    ).toBe('Rendering failed');
  });

  it('truncates a long message', () => {
    expect(
      describeErrorResult({ content: [{ type: 'text', text: 'x'.repeat(1_000) }] }),
    ).toHaveLength(MAX_RESULT_MESSAGE_LENGTH);
  });

  it.each([
    ['content is missing', {}],
    ['content is not a list', { content: 'oops' }],
    ['content is empty', { content: [] }],
    ['blocks carry no text', { content: [{ type: 'image', data: 'x' }] }],
    ['text is only whitespace', { content: [{ type: 'text', text: '   ' }] }],
    ['the result is not an object', 'oops'],
    ['the result is null', null],
  ])('returns nothing when %s', (_label, value) => {
    expect(describeErrorResult(value)).toBeUndefined();
  });
});

describe('describeException', () => {
  it('names the error and keeps its message', () => {
    expect(describeException(new TypeError('bad input'))).toEqual({
      errorType: 'TypeError',
      errorMessage: 'bad input',
    });
  });

  it('keeps a custom error name', () => {
    class RateLimitError extends Error {
      override name = 'RateLimitError';
    }

    expect(describeException(new RateLimitError('slow down')).errorType).toBe('RateLimitError');
  });

  it('reports no message when the error has none', () => {
    expect(describeException(new Error()).errorMessage).toBeUndefined();
  });

  it.each([
    ['a string', 'just a string', 'string', 'just a string'],
    ['a number', 42, 'number', '42'],
    ['undefined', undefined, 'undefined', 'undefined'],
    ['null', null, 'object', 'null'],
  ])('copes with a handler throwing %s', (_label, thrown, errorType, errorMessage) => {
    expect(describeException(thrown)).toEqual({ errorType, errorMessage });
  });
});
