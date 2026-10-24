/**
 * Whether this dashboard is the public demo (MCPSPAN_DEMO=true, beside an API
 * run the same way). Read at request time, on the server, like every other
 * setting here, so one image serves both.
 */
export function isDemo(): boolean {
  return process.env['MCPSPAN_DEMO'] === 'true';
}

/**
 * What a visitor to the demo sends the API instead of a session. The demo's
 * API answers every reading request as its one account whatever cookie comes
 * with it (core-api demo.ts), so this only has to be there.
 */
export const DEMO_SESSION = 'mcpspan_session=demo';
