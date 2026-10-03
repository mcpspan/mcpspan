'use client';

import { AlertTriangle, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { NewKey } from '@/components/new-key';
import { Button } from '@/components/ui/button';
import type { ServerRecord } from '@/lib/api';

/** A name field beside its buttons: the same height, and never narrower than a name needs. */
const INPUT =
  'h-10 min-w-0 flex-1 basis-48 rounded-lg border border-border bg-raised px-3 text-sm text-ink placeholder:text-ink-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink';

/**
 * The servers this account reports from, and what can be done to them.
 *
 * Every action here goes through the proxy in this app rather than to the Core
 * API directly, so the reader's own session travels with it and the API never
 * has to be reachable from a browser.
 *
 * After anything that changes the list, the page is refreshed rather than the
 * list being patched in place. The server rendered it; letting it render again
 * is both shorter and incapable of disagreeing with what is actually stored.
 */
export function ManageServers({ servers }: { servers: ServerRecord[] }) {
  const router = useRouter();
  const [newKey, setNewKey] = useState<{ serverName: string; key: string }>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function act(
    id: string,
    request: () => Promise<Response>,
  ): Promise<Record<string, unknown> | undefined> {
    setBusy(id);
    setFailure(undefined);

    try {
      const response = await request();
      const body =
        response.status === 204
          ? {}
          : ((await response.json().catch(() => ({}))) as Record<string, unknown>);

      if (!response.ok) {
        setFailure(typeof body['error'] === 'string' ? body['error'] : 'That did not work.');
        return undefined;
      }

      router.refresh();
      return body;
    } catch {
      setFailure('Could not reach the server.');
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="space-y-4">
      {newKey === undefined ? null : (
        <div className="space-y-2">
          <p className="text-sm text-ink">
            New key for <strong>{newKey.serverName}</strong>.
          </p>
          <NewKey value={newKey.key} />
          <Button variant="secondary" onClick={() => setNewKey(undefined)}>
            Done
          </Button>
        </div>
      )}

      <ul className="divide-y divide-border">
        {servers.map((server) => (
          <ServerRow
            key={server.id}
            server={server}
            busy={busy === server.id}
            onlyOne={servers.length === 1}
            onRename={async (name) => {
              await act(server.id, () =>
                fetch(`/api/servers/${server.id}`, {
                  method: 'PATCH',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name }),
                }),
              );
            }}
            onRegenerate={async () => {
              const body = await act(server.id, () =>
                fetch(`/api/servers/${server.id}/key`, { method: 'POST' }),
              );

              if (typeof body?.['apiKey'] === 'string') {
                setNewKey({ serverName: server.name, key: body['apiKey'] });
              }
            }}
            onRemove={async () => {
              await act(server.id, () =>
                fetch(`/api/servers/${server.id}`, { method: 'DELETE' }),
              );
            }}
          />
        ))}
      </ul>

      <AddServer
        onAdd={async (name) => {
          const body = await act('new', () =>
            fetch('/api/servers', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }),
          );

          const server = body?.['server'] as { name?: string } | undefined;

          if (typeof body?.['apiKey'] === 'string') {
            setNewKey({ serverName: server?.name ?? name, key: body['apiKey'] });
          }
        }}
        busy={busy === 'new'}
      />

      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-status-critical">
          {failure}
        </p>
      )}
    </div>
  );
}

function ServerRow({
  server,
  busy,
  onlyOne,
  onRename,
  onRegenerate,
  onRemove,
}: {
  server: ServerRecord;
  busy: boolean;
  onlyOne: boolean;
  onRename: (name: string) => Promise<void>;
  onRegenerate: () => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(server.name);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [confirmingKey, setConfirmingKey] = useState(false);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {renaming ? (
          // Wraps on a phone: the name takes the line, the buttons go under it.
          <form
            className="flex w-full flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setRenaming(false);
              void onRename(name);
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-label={`New name for ${server.name}`}
              className={INPUT}
            />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || name.trim().length === 0}>
                Save
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setName(server.name);
                  setRenaming(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <p className="text-sm font-medium text-ink">{server.name}</p>
            {server.hasActiveKey ? null : (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-status-warning-ink">
                <AlertTriangle aria-hidden className="size-3.5" />
                No key. It cannot report anything until you generate one.
              </p>
            )}
          </div>
        )}

        {renaming ? null : (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setRenaming(true)}
              disabled={busy}
              title={`Rename ${server.name}`}
            >
              <Pencil aria-hidden className="size-4" />
              <span className="sr-only">Rename {server.name}</span>
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmingKey(true)}
              disabled={busy}
              title={`Generate a new key for ${server.name}`}
            >
              <KeyRound aria-hidden className="size-4" />
              <span className="sr-only">New key for {server.name}</span>
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmingRemoval(true)}
              disabled={busy || onlyOne}
              title={
                onlyOne
                  ? 'Add another server before removing this one'
                  : `Remove ${server.name} and everything it recorded`
              }
            >
              <Trash2 aria-hidden className="size-4" />
              <span className="sr-only">Remove {server.name}</span>
            </Button>
          </div>
        )}
      </div>

      {confirmingKey ? (
        <Confirm
          // Said before clicking rather than after. The old key stops working
          // the moment this happens, so a server still running with it goes
          // quiet until somebody redeploys.
          message="The current key stops working straight away. Any server still using it reports nothing until you deploy the new one."
          action="Replace the key"
          busy={busy}
          onConfirm={() => {
            setConfirmingKey(false);
            void onRegenerate();
          }}
          onCancel={() => setConfirmingKey(false)}
        />
      ) : null}

      {confirmingRemoval ? (
        <Confirm
          message={`Everything ${server.name} recorded is deleted along with it. This cannot be undone.`}
          action="Remove it"
          busy={busy}
          onConfirm={() => {
            setConfirmingRemoval(false);
            void onRemove();
          }}
          onCancel={() => setConfirmingRemoval(false)}
        />
      ) : null}
    </li>
  );
}

function Confirm({
  message,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  message: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface p-3">
      <p className="text-sm text-ink">{message}</p>
      <div className="mt-2 flex gap-2">
        <Button onClick={onConfirm} disabled={busy}>
          {busy ? 'Working...' : action}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddServer({ onAdd, busy }: { onAdd: (name: string) => Promise<void>; busy: boolean }) {
  const [name, setName] = useState('');

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();

        if (name.trim().length === 0) return;

        void onAdd(name.trim()).then(() => setName(''));
      }}
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Another server"
        maxLength={80}
        aria-label="Name of the server to add"
        className={INPUT}
      />
      <Button type="submit" disabled={busy || name.trim().length === 0}>
        {busy ? 'Adding...' : 'Add a server'}
      </Button>
    </form>
  );
}
