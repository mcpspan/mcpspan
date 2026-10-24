import type { ClientsOverTime as Clients } from '../lib/api';
import { ago } from '../lib/diagnosis';
import { OTHER_CLIENTS } from '../lib/client-colors';
import { clientLabel, formatCount } from '../lib/format';
import { LocalTime } from './local-time';

const ROW = 'grid grid-cols-[1fr_5rem] items-center gap-4 py-3 text-sm sm:grid-cols-[1fr_6rem]';

const BADGE = 'rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink';

/**
 * Each client on its own row: when it first called, whether it has gone
 * quiet, how many calls it made and what share of all of them. The chart
 * above draws when; this says who, in the same colours.
 */
export function ClientsOverTime({
  data,
  totalCalls,
  colors = {},
}: {
  data: Clients;
  /** Every call in the window, so a share is of all of them and not of this page. */
  totalCalls: number;
  /** Each client's colour on the ring above, so its row is drawn in the same one. */
  colors?: Record<string, string>;
}) {
  if (data.clients.length === 0) {
    return <p className="text-sm text-ink-muted">No calls in this window.</p>;
  }

  const total = totalCalls;
  const windowStart = Date.parse(data.times[0] ?? '');
  const windowMs = data.times.length * data.bucketSeconds * 1000;
  // Quiet for more than a quarter of the window is worth saying; less than
  // that is a client that is simply not busy at every hour.
  const quietAfter = Date.now() - windowMs / 4;
  return (
    <ul className="divide-y divide-border">
      {data.clients.map((client) => {
        const isNew = Date.parse(client.firstSeenAt) >= windowStart;
        const lastSeen = Date.parse(client.lastSeenAt);

        return (
          <li key={client.clientType} className={ROW}>
            <div className="min-w-0">
              <p className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: colors[client.clientType] ?? OTHER_CLIENTS }}
                />
                <span className="truncate text-ink">{clientLabel(client.clientType)}</span>
                {isNew ? (
                  <span className={BADGE}>New</span>
                ) : null}
              </p>
              <p className="mt-0.5 pl-[18px] text-xs text-ink-muted">
                {/* Both can be true: a client that turned up and left again
                    inside one window is exactly the thing worth seeing. */}
                {isNew ? (
                  <>
                    First seen <LocalTime iso={client.firstSeenAt} />
                    {lastSeen < quietAfter ? ', ' : null}
                  </>
                ) : null}
                {lastSeen < quietAfter
                  ? `${isNew ? 'last' : 'Last'} call ${ago(Date.now() - lastSeen)} ago`
                  : isNew
                    ? null
                    : 'Active'}
              </p>
            </div>

            <p className="text-right tabular-nums">
              <span className="text-ink">{formatCount(client.calls)}</span>
              <span className="block text-xs text-ink-muted">
                {Math.round((client.calls / Math.max(total, 1)) * 100)}%
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
