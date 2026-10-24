'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Copyable } from './copyable';
import { Button } from './ui/button';
import type { ServerRecord } from '../lib/api';

const METRICS = [
  { id: 'calls', label: 'Calls' },
  { id: 'success', label: 'Success rate' },
  { id: 'latency', label: 'Response time' },
] as const;

type Metric = (typeof METRICS)[number]['id'];

/**
 * Each server's public badge: off until its owner switches it on, then an
 * image for its README, with the line to paste.
 *
 * The page is rendered again after each change, as everywhere in Settings.
 */
export function ManageBadges({
  servers,
  url,
}: {
  servers: ServerRecord[];
  /** The API's public address, which serves the badges. */
  url: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();

  async function act(serverId: string, method: 'POST' | 'DELETE'): Promise<void> {
    setBusy(serverId);
    setFailure(undefined);

    try {
      const response = await fetch(`/api/servers/${serverId}/badge`, { method });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setFailure(body.error ?? 'That did not work.');
        return;
      }

      router.refresh();
    } catch {
      setFailure('Could not reach the server.');
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-4">
      <ul className="space-y-3">
        {servers.map((server) => (
          <BadgeRow
            key={server.id}
            server={server}
            url={url}
            busy={busy === server.id}
            onEnable={() => void act(server.id, 'POST')}
            onDisable={() => void act(server.id, 'DELETE')}
          />
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

function BadgeRow({
  server,
  url,
  busy,
  onEnable,
  onDisable,
}: {
  server: ServerRecord;
  url: string;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
}) {
  const [metrics, setMetrics] = useState<Metric[]>(['calls', 'success']);
  const [confirmingMove, setConfirmingMove] = useState(false);

  if (server.badgeId == null) {
    return (
      <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-ink">{server.name}</p>
        <Button variant="secondary" onClick={onEnable} disabled={busy}>
          {busy ? 'Working...' : 'Switch on'}
        </Button>
      </li>
    );
  }

  const base = `${url.replace(/\/+$/, '')}/badge/${server.badgeId}`;
  // In the order offered, whatever order they were ticked in.
  const chosen = METRICS.filter((option) => metrics.includes(option.id));
  const markdown = chosen
    .map((option) => `[![mcpspan ${option.label.toLowerCase()}](${base}/${option.id}.svg)](https://mcpspan.com)`)
    .join(' ');

  return (
    <li className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ink">{server.name}</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setConfirmingMove(true)} disabled={busy}>
            New address
          </Button>
          <Button variant="secondary" onClick={onDisable} disabled={busy}>
            Switch off
          </Button>
        </div>
      </div>

      {confirmingMove ? (
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-sm text-ink">
            The current address stops showing figures straight away. Any README using it shows
            &ldquo;no data&rdquo; until you paste the new one.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                setConfirmingMove(false);
                onEnable();
              }}
            >
              Move it
            </Button>
            <Button variant="secondary" onClick={() => setConfirmingMove(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
        <legend className="sr-only">What the badges for {server.name} show</legend>
        {METRICS.map((option) => (
          <label key={option.id} className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={metrics.includes(option.id)}
              onChange={(event) =>
                setMetrics((current) =>
                  event.target.checked ? [...current, option.id] : current.filter((m) => m !== option.id),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </fieldset>

      {chosen.length === 0 ? (
        <p className="text-sm text-ink-muted">Tick at least one to get a badge.</p>
      ) : (
        <>
          {/* The badges themselves, from the same addresses a README will use. */}
          <div className="flex flex-wrap gap-1.5">
            {chosen.map((option) => (
              <img
                key={option.id}
                src={`${base}/${option.id}.svg`}
                alt={`mcpspan ${option.label.toLowerCase()} for ${server.name}`}
                height={20}
              />
            ))}
          </div>

          <Copyable text={markdown} label="Markdown for the README" wrap />
        </>
      )}
    </li>
  );
}
