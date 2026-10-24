import type { ClientsOverTime as Clients } from '../lib/api';
import { ago } from '../lib/diagnosis';
import { OTHER_CLIENTS } from '../lib/client-colors';
import { clientLabel, formatCount } from '../lib/format';
import { LocalTime } from './local-time';

const ROW =
  'grid grid-cols-[8rem_1fr_5rem] items-center gap-4 py-3 text-sm sm:grid-cols-[11rem_1fr_6rem]';

const BADGE = 'rounded-md bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink';

/**
 * Each client on its own row, on one shared time axis.
 *
 * Rows rather than one chart of coloured series. The question is who arrived
 * and who left, and that is a shape: a row that starts halfway across is a
 * client that turned up, one that stops early is a client that went quiet.
 * A stack of colours would make somebody match hues to a legend to see the
 * same thing, and would run out of distinguishable hues at the sixth client.
 *
 * Each row is scaled to its own busiest bucket, so a small client's shape is
 * as readable as a large one's. How much each one sends is the number beside
 * it, not the height of its columns.
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
  const per = perBucket(data.bucketSeconds);
  const middle = data.times[Math.floor(data.times.length / 2)];
  const end = new Date(windowStart + windowMs).toISOString();

  return (
    <>
    <ul className="divide-y divide-border">
      {data.clients.map((client) => {
        const isNew = Date.parse(client.firstSeenAt) >= windowStart;
        const lastSeen = Date.parse(client.lastSeenAt);

        return (
          <li key={client.clientType} className={ROW}>
            <div className="min-w-0">
              <p className="flex items-center gap-2">
                <span className="truncate text-ink">{clientLabel(client.clientType)}</span>
                {isNew ? (
                  <span className={BADGE}>New</span>
                ) : null}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
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
                {/* What the tallest column stands for: every row has a scale of its own. */}
                {` · up to ${formatCount(Math.max(...client.points, 0))} ${per}`}
              </p>
            </div>

            <Sparkline
              points={client.points}
              times={data.times}
              label={clientLabel(client.clientType)}
              // A client the ring folds into its grey is grey here too; with no ring at all, the calls colour.
              color={colors[client.clientType] ?? (Object.keys(colors).length > 0 ? OTHER_CLIENTS : 'var(--color-series-calls)')}
            />

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

    {/* One time axis for every row: where the window starts, its middle and its end. Not on a phone,
        where the rows are too narrow for three times to fit under them. */}
    <div className={`${ROW} hidden pt-1 pb-0 text-[11px] text-ink-muted sm:grid`} aria-hidden>
      <span />
      <span className="flex justify-between gap-2">
        <LocalTime iso={data.times[0] ?? end} />
        {middle === undefined ? null : (
          <span className="hidden sm:inline">
            <LocalTime iso={middle} />
          </span>
        )}
        <LocalTime iso={end} />
      </span>
      <span />
    </div>
    </>
  );
}

/** How long one column is, as said after a count: "an hour", "per 6 hours", "a day". */
export function perBucket(bucketSeconds: number): string {
  if (bucketSeconds === 3600) return 'an hour';
  if (bucketSeconds === 86_400) return 'a day';
  if (bucketSeconds < 3600) return `per ${Math.round(bucketSeconds / 60)} minutes`;

  return `per ${Math.round(bucketSeconds / 3600)} hours`;
}

/** One client's calls per bucket. Hovering a column names its time and count. */
function Sparkline({
  points,
  times,
  label,
  color,
}: {
  points: number[];
  times: string[];
  label: string;
  color: string;
}) {
  const highest = Math.max(1, ...points);
  const step = 10;
  const height = 32;

  return (
    <svg
      viewBox={`0 0 ${points.length * step} ${height}`}
      preserveAspectRatio="none"
      className="h-8 w-full"
      role="img"
      aria-label={`${label}, calls over the window`}
    >
      {/* The baseline, so an empty stretch reads as none rather than as missing. */}
      <line
        x1={0}
        x2={points.length * step}
        y1={height - 0.5}
        y2={height - 0.5}
        stroke="var(--color-border)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {points.map((value, index) =>
        value === 0 ? null : (
          <rect
            key={times[index]}
            x={index * step + 1}
            width={step - 2}
            y={height - Math.max(2, (value / highest) * height)}
            height={Math.max(2, (value / highest) * height)}
            fill={color}
          >
            <title>{describeColumn(times[index], value)}</title>
          </rect>
        ),
      )}
    </svg>
  );
}

/**
 * A column's native tooltip. In UTC and saying so, since this is drawn on
 * the server, which does not know the reader's timezone.
 */
function describeColumn(time: string | undefined, calls: number): string {
  const at = new Date(time ?? '').toISOString().slice(0, 16).replace('T', ' ');

  return `${at} UTC: ${calls} call${calls === 1 ? '' : 's'}`;
}
