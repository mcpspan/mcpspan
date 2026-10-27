'use client';

import { Unplug } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { LocalTime } from './local-time';
import { Button } from './ui/button';
import type { ConnectedApp } from '../lib/api';

/**
 * The apps this account let read its data by signing in from them, each with
 * a way to end that. Disconnecting ends every token the app holds at once.
 */
export function ConnectedApps({ apps }: { apps: ConnectedApp[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [failure, setFailure] = useState<string>();

  async function disconnect(id: string): Promise<void> {
    setBusy(id);
    setFailure(undefined);

    try {
      const response = await fetch(`/api/oauth/apps/${id}`, { method: 'DELETE' });

      if (!response.ok && response.status !== 404) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };

        setFailure(body.error ?? 'That did not work.');

        return;
      }

      router.refresh();
    } catch {
      setFailure('Could not reach the server.');
    } finally {
      setBusy(undefined);
      setConfirming(undefined);
    }
  }

  if (apps.length === 0) {
    return <p className="text-sm text-ink-muted">No apps connected.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border">
        {apps.map((app) => (
          <li key={app.id} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink [overflow-wrap:anywhere]">
                  {app.name}
                  {app.redirectHost === null ? null : (
                    <span className="font-normal text-ink-muted"> · {app.redirectHost}</span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Connected <LocalTime iso={app.createdAt} />
                  {app.lastUsedAt === null ? null : (
                    <>
                      {' · '}last used <LocalTime iso={app.lastUsedAt} />
                    </>
                  )}
                </p>
              </div>
              <Button
                variant="secondary"
                onClick={() => setConfirming(app.id)}
                disabled={busy === app.id}
                title={`Disconnect ${app.name}`}
              >
                <Unplug aria-hidden className="size-4" />
                <span className="sr-only">Disconnect {app.name}</span>
              </Button>
            </div>

            {confirming === app.id ? (
              <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                <p className="text-sm text-ink">
                  {app.name} stops reading your data straight away. To use it again, connect mcpspan in it again.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button disabled={busy === app.id} onClick={() => void disconnect(app.id)}>
                    Disconnect
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(undefined)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-status-critical">
          {failure}
        </p>
      )}
    </div>
  );
}
