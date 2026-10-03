import { DEFAULT_CORE_API_URL } from './api';

/**
 * Where a developer's MCP server should send its telemetry.
 *
 * This is the Core API's address as the outside world reaches it, which is not
 * how this app reaches it: the dashboard talks to the API over a container
 * network or a private hostname, while the SDK runs on somebody else's
 * machine and needs a published one. The two are separate settings on purpose.
 *
 * Deliberately not prefixed `NEXT_PUBLIC_`. Next inlines those at build time,
 * so that prefix would bake one installation's address into the image and
 * silently ignore whatever a self-hoster sets when starting it. Every read
 * here happens on the server, so a plain runtime variable is both correct and
 * what lets one image serve every installation.
 */
export function ingestUrl(): string {
  return process.env['MCPSPAN_INGEST_URL']?.trim() || DEFAULT_CORE_API_URL;
}
