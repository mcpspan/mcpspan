import Link from 'next/link';

import { cn } from '@/lib/cn';
import { withoutPaging } from '@/lib/query';
import { RANGES, type RangeKey } from '@/lib/range';

/**
 * Choosing how far back to look.
 *
 * Links rather than buttons, because the choice lives in the address. That
 * falls out of the data being read on the server: the browser has no
 * credential for the API, so changing the window has to reach the server, and
 * a link is what that is. It also means the state is shareable, survives a
 * refresh, and the back button undoes it - none of which a component holding
 * the choice in memory would manage.
 *
 * Not a client component either, for the same reason: there is nothing here
 * for the browser to run.
 */
export function RangePicker({
  current,
  params,
}: {
  current: RangeKey;
  /** Everything else in the address, so switching a window keeps the rest. */
  params?: Record<string, string | undefined>;
}) {
  return (
    <nav aria-label="Time range" className="flex gap-1 rounded-lg border border-border bg-raised p-1">
      {RANGES.map((range) => {
        const active = range.key === current;
        const query = new URLSearchParams();

        // A different window is a different list, so every list starts
        // again from its first page.
        for (const [key, value] of Object.entries(withoutPaging(params ?? {}))) {
          if (value !== undefined && key !== 'range') query.set(key, value);
        }
        query.set('range', range.key);

        return (
          <Link
            key={range.key}
            href={`?${query.toString()}`}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium',
              'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
              active ? 'bg-surface text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {range.key === '24h' ? '24 hours' : range.key === '7d' ? '7 days' : '30 days'}
          </Link>
        );
      })}
    </nav>
  );
}
