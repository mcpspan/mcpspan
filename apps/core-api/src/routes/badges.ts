import { Hono } from 'hono';

import { badgeFor, badgeJson, badgeSvg, isBadgeMetric } from '../badges.ts';

/**
 * Public badges: /badge/<id>/<metric>.svg, or .json in shields.io's endpoint
 * format. No credential, since a README shows them to anybody; an address
 * nobody has, or one switched off, says "no data" rather than failing, so a
 * README never shows a broken image.
 */
export function createBadgeRoutes() {
  const app = new Hono();

  app.get('/:badgeId/:file', async (c) => {
    const [, metric = '', format] = /^([a-z]+)\.(svg|json)$/.exec(c.req.param('file')) ?? [];

    if (format === undefined || !isBadgeMetric(metric)) {
      return c.json({ error: 'A badge is calls, success or latency, as .svg or .json' }, 404);
    }

    const badge = await badgeFor(c.req.param('badgeId'), metric);

    // Five minutes, as long as the figure itself is kept: GitHub's image
    // proxy and browsers keep it that long, and ask again after.
    c.header('cache-control', 'public, max-age=300');

    if (format === 'json') return c.json(badgeJson(badge));

    c.header('content-type', 'image/svg+xml; charset=utf-8');

    return c.body(badgeSvg(badge));
  });

  return app;
}
