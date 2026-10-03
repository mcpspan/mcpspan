'use client';

import { AlertTriangle } from 'lucide-react';

import { Copyable } from './copyable';

/**
 * The one moment a key is readable.
 *
 * Emphatic on purpose. Somebody who closes this page without copying has no
 * way back: the database holds a hash, so the only remedy is generating
 * another key and redeploying, and it is cheaper to say so loudly here than
 * to let them find out.
 */
export function NewKey({ value }: { value: string }) {
  return (
    <div className="rounded-lg border border-status-warning-ink/30 bg-surface p-4">
      <p className="flex items-center gap-1.5 text-sm font-medium text-status-warning-ink">
        <AlertTriangle aria-hidden className="size-4" />
        Copy this now
      </p>

      <p className="mt-1 mb-3 text-sm text-ink-muted">
        It will not be shown again. Put it in your server&apos;s environment as
        <code className="mx-1 font-mono text-xs text-ink">MCPSPAN_API_KEY</code>.
      </p>

      <Copyable text={value} label="API key" />
    </div>
  );
}
