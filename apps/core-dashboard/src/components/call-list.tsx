import { ChevronRight } from 'lucide-react';
import Link from 'next/link';

import type { CallRecord } from '@/lib/api';
import { clientLabel, errorSourceInfo, formatDuration, kindLabel } from '@/lib/format';
import { type Params, withParams } from '@/lib/query';
import { LocalTime } from './local-time';
import { OutcomeBadge } from './outcome-badge';

/**
 * Calls, newest first, each opening its own page.
 *
 * A list rather than a dense table, because for a failure the message is the
 * thing somebody came to read and a table column would clip it. Everything
 * else about a call fits on one line beneath.
 */
export function CallList({
  calls,
  empty,
  carried,
}: {
  calls: CallRecord[];
  /** Said when there is nothing to list. */
  empty: string;
  /** Kept on the way to a call and back: the server and the window. */
  carried: Params;
}) {
  if (calls.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;

  return (
    <ul className="-mx-2 divide-y divide-border">
      {calls.map((call) => {
        const duration = formatDuration(call.durationMs);
        const explanation =
          call.errorSource === null ? undefined : errorSourceInfo(call.errorSource, call.kind).explanation;

        return (
          <li key={call.id}>
            <Link
              href={`/calls/${call.id}${withParams(carried, {})}`}
              className="group flex items-start gap-3 rounded-lg px-2 py-3 outline-offset-2 hover:bg-surface focus-visible:outline-2 focus-visible:outline-ink"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="[overflow-wrap:anywhere]">
                    {kindLabel(call.kind) === null ? null : (
                      <span className="mr-1.5 text-xs text-ink-muted">{kindLabel(call.kind)}</span>
                    )}
                    <span className="font-mono text-xs text-ink">{call.toolName}</span>
                  </span>
                  <OutcomeBadge success={call.success} source={call.errorSource} kind={call.kind} />
                  {call.errorType === null ? null : <span className="text-xs text-ink-muted">{call.errorType}</span>}
                </div>

                {call.errorMessage !== null ? (
                  <p className="mt-1 text-sm break-words text-ink">{call.errorMessage}</p>
                ) : call.success || explanation === undefined ? null : (
                  <p className="mt-1 text-sm text-ink-muted">{explanation}</p>
                )}

                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-muted">
                  <LocalTime iso={call.occurredAt} />
                  <span>
                    {clientLabel(call.clientType)}
                    {call.clientName === null ? '' : ` (${call.clientName})`}
                  </span>
                  <span className="tabular-nums">
                    {duration.value}
                    {duration.unit}
                  </span>
                </p>
              </div>
              <ChevronRight
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-ink-muted opacity-40 group-hover:opacity-100"
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
