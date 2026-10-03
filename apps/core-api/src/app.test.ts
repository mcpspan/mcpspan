import { describe, expect, it } from 'vitest';

import { createApp } from './app.ts';

describe('health', () => {
  it('answers while the process is serving', async () => {
    const response = await createApp().request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});

describe('unknown routes', () => {
  it('are not found rather than silently accepted', async () => {
    const response = await createApp().request('/no-such-route');

    expect(response.status).toBe(404);
  });

  it('answer in JSON, like everything else here', async () => {
    const response = await createApp().request('/no-such-route');

    await expect(response.json()).resolves.toEqual({ error: expect.stringContaining('/no-such-route') });
  });

  it('name the method too, since a wrong verb looks the same as a wrong path', async () => {
    const response = await createApp().request('/v1/events', { method: 'GET' });

    await expect(response.json()).resolves.toEqual({ error: expect.stringContaining('GET') });
  });
});

describe('an unexpected failure', () => {
  it('answers in JSON without describing our internals', async () => {
    const app = createApp();
    app.get('/boom', () => {
      throw new Error('a stack trace nobody outside should read');
    });

    const response = await app.request('/boom');

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    expect(body.error).not.toContain('stack trace nobody outside should read');
  });
});
