import { createApp } from './app.ts';
import { demoOnly } from './demo.ts';
import { startApi } from './server.ts';

// The self-hosted API: every option at its default. MCPSPAN_DEMO=true makes
// it a public, read-only demo (demo.ts); no ordinary installation sets it.
startApi(process.env['MCPSPAN_DEMO'] === 'true' ? demoOnly(createApp()) : createApp());
