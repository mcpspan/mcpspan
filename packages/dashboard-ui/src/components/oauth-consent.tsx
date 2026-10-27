'use client';

import { useState } from 'react';

import { Button } from './ui/button';

/**
 * The two answers to an app asking to read somebody's data: either way the
 * API says where their browser goes next, back to the app, with a code or
 * with "no".
 *
 * `params` is the app's request exactly as it arrived; the API checks it
 * again rather than trusting that this page did.
 */
export function OAuthConsent({ params, name }: { params: Record<string, string>; name: string }) {
  const [busy, setBusy] = useState<'allow' | 'deny'>();
  const [failure, setFailure] = useState<string>();

  async function answer(approve: boolean): Promise<void> {
    setBusy(approve ? 'allow' : 'deny');
    setFailure(undefined);

    try {
      const response = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params, approve }),
      });
      const body = (await response.json().catch(() => ({}))) as { redirect?: string; description?: string; error?: string };

      if (body.redirect !== undefined) {
        window.location.assign(body.redirect);

        return;
      }

      setFailure(body.description ?? body.error ?? 'That did not work. Start connecting again from the app.');
    } catch {
      setFailure('Could not reach mcpspan. Try again in a moment.');
    }

    setBusy(undefined);
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-3">
        <Button className="flex-1" disabled={busy !== undefined} onClick={() => void answer(true)}>
          {busy === 'allow' ? 'Allowing...' : `Allow ${name}`}
        </Button>
        <Button variant="secondary" className="flex-1" disabled={busy !== undefined} onClick={() => void answer(false)}>
          Cancel
        </Button>
      </div>
      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-status-critical">
          {failure}
        </p>
      )}
    </div>
  );
}
