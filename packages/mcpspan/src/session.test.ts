import { describe, expect, it } from 'vitest';

import { sessionFor } from './session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('sessionFor', () => {
  it('gives one server connection one identifier', () => {
    const server = {};

    expect(sessionFor(server, {})).toBe(sessionFor(server, {}));
    expect(sessionFor(server, {})).toMatch(UUID);
  });

  it('gives two servers two identifiers', () => {
    expect(sessionFor({}, {})).not.toBe(sessionFor({}, {}));
  });

  it('follows the transport session, one identifier each', () => {
    const server = {};

    const first = sessionFor(server, { sessionId: 'transport-a' });

    expect(sessionFor(server, { sessionId: 'transport-a' })).toBe(first);
    expect(sessionFor(server, { sessionId: 'transport-b' })).not.toBe(first);
  });

  it("never passes on the transport's own identifier", () => {
    // That one travels in HTTP headers, so it would join our events to the
    // server's access logs.
    expect(sessionFor({}, { sessionId: 'transport-a' })).not.toContain('transport-a');
  });

  it('forgets the longest idle connection once it has many', () => {
    const server = {};
    const first = sessionFor(server, { sessionId: 'first' });

    for (let index = 0; index < 1_000; index += 1) {
      sessionFor(server, { sessionId: `other-${index}` });
    }

    expect(sessionFor(server, { sessionId: 'first' })).not.toBe(first);
  });

  it('keeps one in use rather than one merely old', () => {
    const server = {};
    const busy = sessionFor(server, { sessionId: 'busy' });

    for (let index = 0; index < 1_000; index += 1) {
      sessionFor(server, { sessionId: `other-${index}` });
      sessionFor(server, { sessionId: 'busy' });
    }

    expect(sessionFor(server, { sessionId: 'busy' })).toBe(busy);
  });
});

describe('sessionFor over HTTP', () => {
  it('gives a request with a transport session that session', () => {
    const server = {};
    const context = { sessionId: 'transport-a', requestInfo: { headers: {} } };

    expect(sessionFor(server, context)).toBe(sessionFor(server, context));
  });

  it('gives none to an HTTP request without one, in v1 of the SDK', () => {
    // A stateless server, or any server on the 2026-07-28 protocol, which has
    // no sessions. A session per request would be a session no agent had.
    expect(sessionFor({}, { requestInfo: { headers: {} } })).toBeUndefined();
  });

  it('gives none to an HTTP request without one, in v2 of the SDK', () => {
    expect(sessionFor({}, { http: { req: {} } })).toBeUndefined();
  });

  it('treats anything that is not HTTP as one connection for the life of the instance', () => {
    const server = {};

    expect(sessionFor(server, { mcpReq: {} })).toBe(sessionFor(server, {}));
  });
});
