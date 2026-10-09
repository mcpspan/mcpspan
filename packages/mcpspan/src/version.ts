/**
 * Version this build of the SDK reports, in telemetry and in its User-Agent.
 *
 * Single source of truth: `package.json` follows this constant, not the other
 * way round, and a unit test fails if the two ever drift apart.
 */
export const SDK_VERSION = '0.5.0';
