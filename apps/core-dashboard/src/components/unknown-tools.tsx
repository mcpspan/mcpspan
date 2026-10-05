import Link from 'next/link';
import type { ReactNode } from 'react';

import type { UnknownPrimitive, UnknownTool } from '@/lib/api';
import { clientLabel, formatCount } from '@/lib/format';
import { type Params, withParams } from '@/lib/query';
import { LocalTime } from './local-time';
import { Card, CardHeader } from './ui/card';

/**
 * What agents asked for that the server does not have: tools, resources and
 * prompts, in one place.
 *
 * Kept apart from the rankings, since none of these exists, and shown only
 * when there are any: an empty card saying nobody asked for anything missing
 * is noise on a page people read at a glance.
 *
 * Usually something renamed or removed while a client still held the old
 * list; sometimes a model reaching for something it expected to find. Where
 * the server has a name close to it, that is shown too: a near miss is a name
 * or a description to fix rather than a feature to add. Who asked is shown
 * as well: a name only one client reaches for is that client's habit, one
 * every client wants is something the server lacks. A
 * resource is named by the scheme of the address asked for, which is all the
 * SDK records: the rest of it came from the client, and may be somebody's data.
 */
export function UnknownTools({
  tools,
  resources = [],
  prompts = [],
  params,
  pager,
}: {
  tools: UnknownTool[];
  resources?: UnknownPrimitive[];
  prompts?: UnknownPrimitive[];
  params: Params;
  /** Paging for the tools, drawn under them. */
  pager?: ReactNode;
}) {
  if (tools.length + resources.length + prompts.length === 0) return null;

  const others = [
    ...resources.map((item) => ({ ...item, kind: 'Resource', source: 'unknown_resource' })),
    ...prompts.map((item) => ({ ...item, kind: 'Prompt', source: 'unknown_prompt' })),
  ];

  return (
    <Card id="unknown-tools">
      <CardHeader title="Asked for, not on this server" hint="By agents expecting it to exist" />

      <ul className="divide-y divide-border text-sm">
        {tools.map((tool) => (
          <Row
            key={`tool:${tool.toolName}`}
            kind="Tool"
            name={tool.toolName}
            calls={tool.calls}
            lastCalledAt={tool.lastCalledAt}
            closest={tool.closest}
            clients={tool.clients}
            closestHref={
              tool.closest === null
                ? undefined
                : `/tool${withParams(params, { toolName: tool.closest, clientType: undefined, sort: undefined })}`
            }
            href={`/errors${withParams(params, {
              errorSource: 'unknown_tool',
              toolName: tool.toolName,
              clientType: undefined,
              sort: undefined,
            })}`}
          />
        ))}
        {others.map((item) => (
          <Row
            key={`${item.kind}:${item.name}`}
            kind={item.kind}
            name={item.name}
            calls={item.calls}
            lastCalledAt={item.lastCalledAt}
            closest={item.closest ?? null}
            clients={item.clients ?? []}
            href={`/errors${withParams(params, {
              errorSource: item.source,
              toolName: undefined,
              clientType: undefined,
              sort: undefined,
            })}`}
          />
        ))}
      </ul>

      {pager}
    </Card>
  );
}

function Row({
  kind,
  name,
  calls,
  lastCalledAt,
  closest,
  clients,
  closestHref,
  href,
}: {
  kind: string;
  name: string;
  calls: number;
  lastCalledAt: string;
  closest: string | null;
  clients: { clientType: string; calls: number }[];
  /** Where the suggested name leads, when it has a page of its own. */
  closestHref?: string;
  href: string;
}) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
      <span className="min-w-0 break-words">
        <span className="mr-2 text-xs text-ink-muted">{kind}</span>
        <Link href={href} className="font-mono text-xs text-ink underline-offset-2 hover:underline">
          {name}
        </Link>
        <AskedBy clients={clients} />
        {closest === null ? null : (
          <span className="mt-0.5 block text-xs text-ink-muted">
            Closest on this server:{' '}
            {closestHref === undefined ? (
              <span className="font-mono">{closest}</span>
            ) : (
              <Link href={closestHref} className="font-mono underline underline-offset-2">
                {closest}
              </Link>
            )}
          </span>
        )}
      </span>
      <span className="text-xs text-ink-muted">
        {formatCount(calls)} call{calls === 1 ? '' : 's'}, last <LocalTime iso={lastCalledAt} />
      </span>
    </li>
  );
}

/** Clients shown by name; the rest are counted. */
const SHOWN_CLIENTS = 3;

/** Who asked: "Only from Cursor", or the busiest few with their counts. */
function AskedBy({ clients }: { clients: { clientType: string; calls: number }[] }) {
  if (clients.length === 0) return null;

  const only = clients.length === 1 ? clients[0] : undefined;
  const shown = clients.slice(0, SHOWN_CLIENTS);
  const rest = clients.length - shown.length;

  return (
    <span className="mt-0.5 block text-xs text-ink-muted">
      {only === undefined
        ? `From ${shown.map((client) => `${clientLabel(client.clientType)} ${formatCount(client.calls)}`).join(', ')}${
            // "+2 more" rather than "2 others": one of the clients may itself be called Other.
            rest > 0 ? `, +${rest} more` : ''
          }`
        : `Only from ${clientLabel(only.clientType)}`}
    </span>
  );
}
