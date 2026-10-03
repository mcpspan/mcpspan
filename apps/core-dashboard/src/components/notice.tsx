import Link from 'next/link';
import type { ReactNode } from 'react';

import { ingestUrl } from '@/lib/ingest-url';
import { snippets } from '@/lib/snippets';
import { ConnectSnippets } from './connect-snippets';
import { Card } from './ui/card';

/**
 * What the dashboard says when it has nothing to show.
 *
 * These states matter more than they look. A new installation's first screen
 * is an empty one, and a page of zeroes tells somebody their setup failed
 * when in fact they simply have not connected anything yet. Every one of
 * these says what happened and what to do about it.
 */
export function Notice({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card className="mx-auto max-w-xl text-center">
      <h2 className="text-base font-medium text-ink">{title}</h2>
      <div className="mt-2 text-sm text-ink-muted">{children}</div>
    </Card>
  );
}

/** Shown before any server has reported, which is every new install. */
export function NothingConnectedYet() {
  return (
    <Notice title="No server is reporting yet">
      <p>
        Create an API key in{' '}
        <Link href="/settings" className="text-ink underline underline-offset-2">
          Settings
        </Link>
        , then point the SDK at this installation:
      </p>
      <div className="mt-3 text-left">
        <ConnectSnippets languages={snippets(ingestUrl())} />
      </div>
      {/* Somebody who already did all that is the one reading this and
          wondering what went wrong, so the way to find out is right here. */}
      <p className="mt-3">
        Already connected?{' '}
        <Link href="/status" className="text-ink underline underline-offset-2">
          Status
        </Link>{' '}
        shows whether anything has arrived, and why not.
      </p>
    </Notice>
  );
}

/** Shown when the Core API cannot be reached or refuses us. */
export function CannotReachApi({ reason, status }: { reason: string; status?: number }) {
  return (
    <Notice title="Cannot read your data">
      <p>{reason}</p>
      <p className="mt-2">
        {/* 503 is the API up and its database not: the advice for the other
            case would send somebody checking the one part that works. */}
        {status === 503
          ? 'Check that the database is running, for example with docker compose ps. Events sent meanwhile are kept by the SDK and delivered once it is back.'
          : 'The dashboard talks to the Core API on the server. Check that it is running and that this app is configured to reach it.'}
      </p>
    </Notice>
  );
}
