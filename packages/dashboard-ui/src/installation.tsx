import Link from 'next/link';
import type { ReactNode } from 'react';

import { coreApiUrl } from './lib/api';

/**
 * What the dashboard says where the answer depends on who runs it.
 *
 * Reached through the `#installation` import (package.json), so an app that
 * mounts these pages for people who do not run the machine can point that
 * import at a module of its own, with the same shape. This one is for a
 * self-hoster, who reads the dashboard and runs the containers.
 */
export interface InstallationText {
  /** Under "Password" in Settings: what to do about a password nobody remembers. */
  forgottenPassword: ReactNode;
  /** Beside "Cannot read your data". 503 is the API up and its database not. */
  outage(status: number | undefined): string;
  /** Above the snippets while no server has reported: where the key comes from, ending in a colon. */
  connectFirst: ReactNode;
  /** For a server whose key was issued under an API_KEY_SECRET since replaced. */
  staleKey: string;
  /** On Status, when no request has been refused. */
  nothingRefused: string;
  /** What the refusals that come from this installation's own rules mean. */
  refusals: {
    rate_limited: string;
    deferred: string;
    not_admitted: string;
  };
}

export const installation: InstallationText = {
  forgottenPassword: (
    <>
      Forgot your password? On the machine running mcpspan,{' '}
      <code className="font-mono text-xs [overflow-wrap:anywhere]">
        docker compose exec api node scripts/reset-password.ts
      </code>{' '}
      prints a new one.
    </>
  ),
  // The advice for the other case would send somebody checking the one part that works.
  outage: (status) =>
    status === 503
      ? 'Check that the database is running, for example with docker compose ps. Events sent meanwhile are kept by the SDK and delivered once it is back.'
      : `The dashboard looks for the Core API at ${coreApiUrl()}. Check that it is running and that this app is configured to reach it.`,
  connectFirst: (
    <>
      Create an API key in{' '}
      <Link href="/settings" className="text-ink underline underline-offset-2">
        Settings
      </Link>
      , then point the SDK at this installation:
    </>
  ),
  staleKey:
    'API_KEY_SECRET changed after this key was created, so the key can no longer be verified. Restore the previous .env, or generate a new key in Settings.',
  nothingRefused: 'The API has not refused anything.',
  refusals: {
    rate_limited:
      'Sent faster than MCPSPAN_INGEST_EVENTS_PER_SECOND allows. The SDK keeps these and sends them again.',
    deferred:
      'Turned away for now by a rule of this installation. The SDK keeps these and sends them again.',
    not_admitted:
      'Turned away for good by a rule of this installation. The SDK drops these batches and keeps collecting.',
  },
};
