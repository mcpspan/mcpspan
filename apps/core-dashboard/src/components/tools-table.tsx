import { ArrowDown } from 'lucide-react';
import Link from 'next/link';

import type { ToolStats } from '@/lib/api';
import { formatCount, formatDuration, formatRate } from '@/lib/format';
import { type Params, withoutPaging, withParams } from '@/lib/query';

/** Above this, a tool's error rate is called out rather than just reported. */
const ELEVATED_ERROR_RATE = 0.05;

const COLUMNS = [
  { sort: 'name', label: 'Tool', align: 'text-left' },
  { sort: 'calls', label: 'Calls', align: 'text-right' },
  { sort: 'errors', label: 'Errors', align: 'text-right' },
  { sort: 'duration', label: 'Median', align: 'text-right' },
] as const;

/**
 * Tools, ordered by whichever column was asked for.
 *
 * The column that earns its place is the error rate, and sorting by it is the
 * point: a server's overall figure averages the healthy tools in with the
 * broken one and reads as mildly concerning, while one click here puts the
 * broken one at the top.
 *
 * Headers are links, so the order lives in the address like everything else
 * and a sorted, filtered view can be sent to somebody else intact.
 */
export function ToolsTable({
  tools,
  params,
  sort,
}: {
  tools: ToolStats[];
  params: Params;
  sort: string;
}) {
  if (tools.length === 0) {
    return <p className="text-sm text-ink-muted">No tools were called in this window.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-ink-muted">
          {COLUMNS.map((column) => (
            <th key={column.sort} scope="col" className={`pb-2 font-medium ${column.align}`}>
              <Link
                href={withParams(withoutPaging(params), { sort: column.sort })}
                aria-sort={sort === column.sort ? 'descending' : 'none'}
                className="inline-flex items-center gap-1 outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              >
                {column.label}
                {sort === column.sort ? <ArrowDown aria-hidden className="size-3" /> : null}
              </Link>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => {
          const median = formatDuration(tool.durationMs.p50);
          const tail = formatDuration(tool.durationMs.p95);

          return (
            <tr key={tool.toolName} className="border-t border-border">
              <th scope="row" className="py-2 text-left font-normal">
                {/* The name opens the tool's own page, which is the move
                    somebody makes next after spotting a bad row. Narrowing
                    the overview to it is still the tool filter above. */}
                <Link
                  href={`/tool${withParams(
                    { serverId: params['serverId'], range: params['range'] },
                    { toolName: tool.toolName },
                  )}`}
                  className="font-mono text-xs outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ink"
                >
                  {tool.toolName}
                </Link>
              </th>
              <td className="py-2 text-right tabular-nums">{formatCount(tool.calls)}</td>
              <td
                className={`py-2 text-right tabular-nums ${
                  tool.errorRate > ELEVATED_ERROR_RATE ? 'text-status-critical' : 'text-ink-muted'
                }`}
              >
                {formatRate(tool.errorRate)}%
              </td>
              {/* The tail under the median rather than in a column of its own:
                  on the overview this table is as narrow as a phone. */}
              <td className="py-2 text-right tabular-nums text-ink-muted">
                <span className="block">
                  {median.value}
                  {median.unit}
                </span>
                {tool.durationMs.p95 === null ? null : (
                  <span className="block text-[11px] text-ink-muted/80">
                    p95 {tail.value}
                    {tail.unit}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
