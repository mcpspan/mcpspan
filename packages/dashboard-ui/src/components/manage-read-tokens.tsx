'use client';

import { AlertTriangle, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Copyable } from './copyable';
import { LocalTime } from './local-time';
import { Button } from './ui/button';
import type { ReadTokenRecord } from '../lib/api';

const INPUT =
  'h-10 min-w-0 flex-1 basis-48 rounded-lg border border-border bg-raised px-3 text-sm text-ink placeholder:text-ink-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink';

/**
 * The read tokens this account holds: made here, shown once, revoked here.
 *
 * Through this app's proxy, like every other change in Settings, so the
 * reader's session travels with it. The list is rendered again after each
 * change rather than patched in place.
 */
export function ManageReadTokens({
  tokens,
  url,
}: {
  tokens: ReadTokenRecord[];
  /** MCPSPAN_URL for the MCP server, or undefined where its default is right. */
  url: string | undefined;
}) {
  const router = useRouter();
  const [made, setMade] = useState<{ name: string; token: string }>();
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState<string>();

  async function act(id: string, request: () => Promise<Response>): Promise<Record<string, unknown> | undefined> {
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
      {made === undefined ? null : (
        <div className="space-y-2">
          <NewReadToken name={made.name} token={made.token} url={url} />
          <Button variant="secondary" onClick={() => setMade(undefined)}>
            Done
          </Button>
        </div>
      )}

      {tokens.length === 0 ? null : (
        <ul className="divide-y divide-border">
          {tokens.map((token) => (
            <li key={token.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-ink">{token.name}</p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Made <LocalTime iso={token.createdAt} />
                    {' · '}
                    {token.lastUsedAt === null ? (
                      'never used'
                    ) : (
                      <>
                        last used <LocalTime iso={token.lastUsedAt} />
                      </>
                    )}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => setConfirming(token.id)}
                  disabled={busy === token.id}
                  title={`Revoke ${token.name}`}
                >
                  <Trash2 aria-hidden className="size-4" />
                  <span className="sr-only">Revoke {token.name}</span>
                </Button>
              </div>

              {confirming === token.id ? (
                <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                  <p className="text-sm text-ink">
                    The token stops working straight away. An agent still using it gets no answers until
                    you give it a new one.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      disabled={busy === token.id}
                      onClick={() => {
                        setConfirming(undefined);
                        void act(token.id, () => fetch(`/api/tokens/${token.id}`, { method: 'DELETE' }));
                      }}
                    >
                      Revoke it
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
      )}

      <form
        className={`flex flex-wrap items-center gap-2 ${tokens.length === 0 ? '' : 'border-t border-border pt-4'}`}
        onSubmit={(event) => {
          event.preventDefault();

          const wanted = name.trim();

          if (wanted.length === 0) return;

          void act('new', () =>
            fetch('/api/tokens', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: wanted }),
            }),
          ).then((body) => {
            if (typeof body?.['token'] === 'string') {
              setMade({ name: wanted, token: body['token'] });
              setName('');
            }
          });
        }}
      >
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          maxLength={100}
          aria-label="Name of the token to make"
          className={INPUT}
        />
        <Button type="submit" disabled={busy === 'new' || name.trim().length === 0}>
          {busy === 'new' ? 'Making...' : 'Make a token'}
        </Button>
      </form>

      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-status-critical">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * The one moment a token is readable, with it already in place in what an
 * agent's settings need, so nobody has to splice it in by hand.
 */
function NewReadToken({ name, token, url }: { name: string; token: string; url: string | undefined }) {
  const env: Record<string, string> = { MCPSPAN_READ_TOKEN: token, ...(url === undefined ? {} : { MCPSPAN_URL: url }) };
  const claudeCode = [
    'claude mcp add mcpspan',
    ...Object.entries(env).map(([key, value]) => `-e ${key}=${value}`),
    '-- npx -y mcpspan-mcp',
  ].join(' \\\n  ');
  const json = JSON.stringify(
    { mcpServers: { mcpspan: { command: 'npx', args: ['-y', 'mcpspan-mcp'], env } } },
    null,
    2,
  );

  return (
    <div className="rounded-lg border border-status-warning-ink/30 bg-surface p-4">
      <p className="flex items-center gap-1.5 text-sm font-medium text-status-warning-ink">
        <AlertTriangle aria-hidden className="size-4" />
        Copy this now
      </p>
      <p className="mt-1 mb-3 text-sm text-ink-muted">
        <strong className="text-ink">{name}</strong> will not be shown again.
      </p>

      <Copyable text={token} label="read token" wrap />

      <p className="mt-4 mb-2 text-sm text-ink">Claude Code, in a terminal:</p>
      <Copyable text={claudeCode} label="Claude Code command" />

      <p className="mt-4 mb-2 text-sm text-ink">Cursor, Claude Desktop, Windsurf and others, in their MCP settings:</p>
      <Copyable text={json} label="MCP settings" />
    </div>
  );
}
