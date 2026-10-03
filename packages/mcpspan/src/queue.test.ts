import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_QUEUE_SIZE, EventQueue } from './queue.js';
import type { ToolCallEvent } from './types.js';

function makeEvent(toolName: string): ToolCallEvent {
  return {
    id: `id-${toolName}`,
    toolName,
    durationMs: 12.5,
    success: true,
    clientType: 'unknown',
    timestamp: '2026-09-16T12:00:00.000Z',
    sdkVersion: '0.0.0',
  };
}

describe('EventQueue', () => {
  it('starts empty', () => {
    const queue = new EventQueue();

    expect(queue.size).toBe(0);
    expect(queue.droppedCount).toBe(0);
  });

  it('buffers added events and reads them back in order', () => {
    const queue = new EventQueue();
    const first = makeEvent('first');
    const second = makeEvent('second');

    queue.add(first);
    queue.add(second);

    expect(queue.size).toBe(2);
    expect(queue.drain()).toEqual([first, second]);
  });

  it('empties itself once drained', () => {
    const queue = new EventQueue();
    queue.add(makeEvent('only'));

    queue.drain();

    expect(queue.size).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('returns an empty array when drained while empty', () => {
    expect(new EventQueue().drain()).toEqual([]);
  });

  it('hands out a drained batch that later additions do not mutate', () => {
    const queue = new EventQueue();
    queue.add(makeEvent('first'));

    const batch = queue.drain();
    queue.add(makeEvent('second'));

    expect(batch).toHaveLength(1);
    expect(batch[0]?.toolName).toBe('first');
  });

  it('stops growing at maxSize, discarding the oldest event', () => {
    const queue = new EventQueue(2);

    queue.add(makeEvent('first'));
    queue.add(makeEvent('second'));
    queue.add(makeEvent('third'));

    expect(queue.size).toBe(2);
    expect(queue.drain().map((event) => event.toolName)).toEqual(['second', 'third']);
  });

  it('counts how many events it discarded', () => {
    const queue = new EventQueue(1);

    queue.add(makeEvent('first'));
    queue.add(makeEvent('second'));
    queue.add(makeEvent('third'));

    expect(queue.droppedCount).toBe(2);
  });

  it('keeps counting discards across drains', () => {
    const queue = new EventQueue(1);
    queue.add(makeEvent('first'));
    queue.add(makeEvent('second'));

    queue.drain();
    queue.add(makeEvent('third'));
    queue.add(makeEvent('fourth'));

    expect(queue.droppedCount).toBe(2);
  });

  it('defaults to a bounded capacity', () => {
    expect(new EventQueue().maxSize).toBe(DEFAULT_MAX_QUEUE_SIZE);
  });

  it('takes only up to the requested limit', () => {
    const queue = new EventQueue();
    queue.add(makeEvent('first'));
    queue.add(makeEvent('second'));
    queue.add(makeEvent('third'));

    expect(queue.drain(2).map((event) => event.toolName)).toEqual(['first', 'second']);
    expect(queue.size).toBe(1);
  });

  it('rejects a limit that would take nothing', () => {
    const queue = new EventQueue();
    queue.add(makeEvent('first'));

    expect(() => queue.drain(0)).toThrow(TypeError);
  });

  it('puts a restored batch ahead of newer events', () => {
    const queue = new EventQueue();
    queue.add(makeEvent('newer'));

    queue.restore([makeEvent('older')]);

    expect(queue.drain().map((event) => event.toolName)).toEqual(['older', 'newer']);
  });

  it('ignores an empty restore', () => {
    const queue = new EventQueue();

    queue.restore([]);

    expect(queue.size).toBe(0);
  });

  it('trims a restore that would overflow the queue', () => {
    const queue = new EventQueue(2);
    queue.add(makeEvent('newest'));

    queue.restore([makeEvent('oldest'), makeEvent('middle')]);

    expect(queue.size).toBe(2);
    expect(queue.droppedCount).toBe(1);
    expect(queue.drain().map((event) => event.toolName)).toEqual(['middle', 'newest']);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %p as a capacity',
    (maxSize) => {
      expect(() => new EventQueue(maxSize)).toThrow(TypeError);
    },
  );
});
