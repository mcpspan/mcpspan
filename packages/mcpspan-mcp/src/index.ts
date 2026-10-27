#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createApi, DEFAULT_URL } from './api.ts';
import { buildServer } from './server.ts';

const token = process.env['MCPSPAN_READ_TOKEN'];
const url = process.env['MCPSPAN_URL']?.trim() || DEFAULT_URL;

// Said on stderr, which clients keep in their logs, and again by every tool,
// which is what the person actually sees.
if (token === undefined || token.trim().length === 0) {
  console.error('mcpspan-mcp: MCPSPAN_READ_TOKEN is not set; make one in mcpspan under Settings → Read tokens.');
}

const api = createApi({ token, url });

serveStdio(() => buildServer(api));
