'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import type { ServerRecord } from '@/lib/api';
import { PAGING_PARAMS } from '@/lib/query';

/**
 * Choosing which server the pages are about.
 *
 * Only drawn when there is more than one. A menu with a single entry is a
 * control that cannot do anything, and most installations have exactly one
 * server for a long time.
 *
 * The choice goes into the address rather than into storage, so the page is a
 * link somebody can send, the back button steps between servers the way it
 * steps between anything else, and a reload lands on the same server rather
 * than on whichever one happens to be first.
 */
export function ServerSwitcher({ servers }: { servers: ServerRecord[] }) {
  const router = useRouter();
  const params = useSearchParams();

  if (servers.length < 2) return null;

  const current = params.get('serverId') ?? servers[0]?.id ?? '';

  function change(serverId: string): void {
    const next = new URLSearchParams(params.toString());
    next.set('serverId', serverId);

    // Filters are left behind on purpose. A tool name picked on one server
    // usually matches nothing on another, and landing on an empty page reads
    // as the new server having no data at all.
    next.delete('toolName');
    next.delete('errorSource');

    // And every list starts from its first page: the old place was a place in
    // the other server's lists.
    for (const name of PAGING_PARAMS) next.delete(name);

    router.push(`?${next.toString()}`);
  }

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Server</span>
      <select
        value={current}
        onChange={(event) => change(event.target.value)}
        className="rounded-md border border-border bg-raised px-2 py-1 text-sm text-ink"
      >
        {servers.map((server) => (
          <option key={server.id} value={server.id}>
            {server.name}
          </option>
        ))}
      </select>
    </label>
  );
}
