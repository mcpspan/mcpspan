import Link from 'next/link';

import type { Versions } from '@/lib/api';
import { formatCount, formatDuration, formatRate } from '@/lib/format';
import { type Params, withParams } from '@/lib/query';
import { LocalTime } from './local-time';

/** Above this, a version's error rate is called out, as a tool's is. */
const ELEVATED_ERROR_RATE = 0.05;

/**
 * Tool calls by the version of the server that answered them, newest first.
 *
 * The question it answers is "did the last release make things worse": the
 * error rate and the times of each version side by side, with when each was
 * first seen. A version opens its calls, which is where to look next.
 */
export function VersionsTable({ data, carried }: { data: Versions; carried: Params }) {
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-ink-muted">
              <th scope="col" className="pb-2 text-left font-medium">
                Version
              </th>
              <th scope="col" className="pb-2 pl-4 text-left font-medium">
                First seen
              </th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">
                Calls
              </th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">
                Errors
              </th>
              <th scope="col" className="pb-2 pl-4 text-right font-medium">
                Median
              </th>
            </tr>
          </thead>
          <tbody>
            {data.versions.map((version) => {
              const median = formatDuration(version.durationMs.p50);
              const tail = formatDuration(version.durationMs.p95);

              return (
                <tr key={version.version} className="border-t border-border">
                  <th scope="row" className="py-2 text-left font-normal">
                    <Link
                      href={`/calls${withParams(carried, { serverVersion: version.version })}`}
                      className="font-mono text-xs underline-offset-2 hover:underline [overflow-wrap:anywhere]"
                    >
                      {version.version}
                    </Link>
                  </th>
                  <td className="py-2 pl-4 text-xs text-ink-muted">
                    <LocalTime iso={version.firstSeenAt} />
                  </td>
                  <td className="py-2 pl-4 text-right tabular-nums">{formatCount(version.calls)}</td>
                  <td
                    className={`py-2 pl-4 text-right tabular-nums ${
                      version.errorRate > ELEVATED_ERROR_RATE ? 'text-status-critical' : 'text-ink-muted'
                    }`}
                  >
                    {formatRate(version.errorRate)}%
                  </td>
                  {/* The tail under the median, as the tools table has it, so the
                      table fits a phone. */}
                  <td className="py-2 pl-4 text-right tabular-nums text-ink-muted">
                    <span className="block">
                      {median.value}
                      {median.unit}
                    </span>
                    {version.durationMs.p95 === null ? null : (
                      <span className="block text-[11px] whitespace-nowrap text-ink-muted/80">
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
      </div>
      {data.unversionedCalls === 0 ? null : (
        <p className="mt-3 text-xs text-ink-muted">
          And {formatCount(data.unversionedCalls)} call{data.unversionedCalls === 1 ? '' : 's'} from an SDK that
          reports no version.
        </p>
      )}
    </>
  );
}
