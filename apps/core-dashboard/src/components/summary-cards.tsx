import type { Summary } from '@/lib/api';
import { compareCalls, compareDuration, compareErrorRate } from '@/lib/compare';
import { clientLabel, formatCount, formatDuration, formatRate } from '@/lib/format';
import { StatTile } from './stat-tile';

/** Above this, an error rate is called out rather than just reported. */
const ELEVATED_ERROR_RATE = 0.05;

/**
 * The four numbers the overview leads with.
 *
 * Calls, failures, speed, and who is calling - which together are the whole
 * of what this product promises to tell somebody. The fourth used to be a
 * count of tools; it was dropped because the table below already names them,
 * and a figure that holds still for weeks is not worth a card.
 */
export function SummaryCards({
  summary,
  previous,
  comparedTo,
}: {
  summary: Summary;
  /** The window of the same length before this one. Absent, nothing is compared. */
  previous?: Summary;
  /** How that window reads in a sentence, for example "the 24 hours before". */
  comparedTo?: string;
}) {
  const against =
    previous === undefined || comparedTo === undefined ? undefined : { previous, comparedTo };
  const p50 = formatDuration(summary.durationMs.p50);
  const p95 = formatDuration(summary.durationMs.p95);
  const [top, ...rest] = summary.clients;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Calls"
        definition="Tool calls in this window that reached a tool this server has, answered or failed. Calls to tools it lacks, resource reads and prompt gets are counted in their own cards."
        value={formatCount(summary.totalCalls)}
        note={summary.totalCalls === 0 ? 'Nothing yet in this window' : undefined}
        {...(against === undefined
          ? {}
          : {
              change: {
                change: compareCalls(summary.totalCalls, against.previous.totalCalls),
                comparedTo: against.comparedTo,
                showMissing: summary.totalCalls > 0,
              },
            })}
      />

      <StatTile
        label="Error rate"
        definition="Failed calls out of all calls: a result the tool marked as an error, an exception it threw, or arguments refused before it ran."
        value={formatRate(summary.errorRate)}
        unit="%"
        {...(summary.errorRate > ELEVATED_ERROR_RATE
          ? { tone: 'warning' as const, status: 'Elevated' }
          : {})}
        note={`${formatCount(summary.failedCalls)} failed ${
          summary.failedCalls === 1 ? 'call' : 'calls'
        }`}
        {...(against === undefined
          ? {}
          : {
              change: {
                change: compareErrorRate(
                  { rate: summary.errorRate, calls: summary.totalCalls },
                  { rate: against.previous.errorRate, calls: against.previous.totalCalls },
                ),
                comparedTo: against.comparedTo,
              },
            })}
      />

      <StatTile
        label="Response time"
        definition="How long your server took to answer, measured by the SDK inside it, so the network to the client is not included. The median is the typical call; 19 in 20 calls finish within the 95th percentile."
        value={p50.value}
        unit={p50.unit}
        // The median leads and the tail follows it. A single average would
        // hide the calls that are actually slow.
        note={
          summary.durationMs.p95 === null
            ? 'median'
            : `median, ${p95.value}${p95.unit} at the 95th`
        }
        {...(against === undefined
          ? {}
          : {
              change: {
                change: compareDuration(summary.durationMs.p50, against.previous.durationMs.p50),
                comparedTo: against.comparedTo,
              },
            })}
      />

      <StatTile
        label="Called from"
        definition="The client with the most calls, by the name it gives itself when it connects. A client can call itself anything, so the name is as reported."
        value={top === undefined ? '-' : clientLabel(top.clientType)}
        note={describeClients(top, rest, summary.totalCalls)}
      />
    </div>
  );
}

function describeClients(
  top: { clientType: string; calls: number } | undefined,
  rest: { clientType: string; calls: number }[],
  totalCalls: number,
): string | undefined {
  if (top === undefined) return undefined;

  const share = totalCalls === 0 ? 0 : Math.round((top.calls / totalCalls) * 100);

  if (rest.length === 0) return `${share}% of calls, the only client`;

  return `${share}% of calls, ${rest.length} other ${rest.length === 1 ? 'client' : 'clients'}`;
}
