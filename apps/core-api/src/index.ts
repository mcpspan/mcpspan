import { createApp } from './app.ts';
import { demoOnly } from './demo.ts';
import { startApi } from './server.ts';

// The self-hosted API: every option at its default, except signing in to
// /mcp with OAuth, on when the API knows where its dashboard is (the page
// that asks people lives there). MCPSPAN_DEMO=true makes it a public,
// read-only demo (demo.ts); no ordinary installation sets it.
const dashboardUrl = process.env['MCPSPAN_DASHBOARD_URL']?.trim();

startApi(
  process.env['MCPSPAN_DEMO'] === 'true'
    ? demoOnly(createApp())
    : createApp(dashboardUrl ? { oauth: { dashboardUrl } } : {}),
);
