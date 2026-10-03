'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { LatencyBucket } from '@/lib/api';
import { ChartData } from './chart-data';

interface Column {
  label: string;
  range: string;
  calls: number;
  share: number;
}

/**
 * How call durations are spread.
 *
 * Columns rather than a smooth curve: each one is a counted bucket, and a
 * curve drawn through them would claim a shape between the buckets that
 * nobody measured. The buckets grow by about half again each step, so the
 * axis is effectively logarithmic and a hump at 15 ms looks the same as one
 * at 400 ms - which is what lets two of them show up as two.
 *
 * Empty buckets at either end are left off. A tool that always answers in
 * 20 to 60 ms would otherwise be a thin spike in a wide empty chart.
 */
export function LatencyChart({
  buckets,
  totalCalls,
}: {
  buckets: LatencyBucket[];
  totalCalls: number;
}) {
  const first = buckets.findIndex((bucket) => bucket.calls > 0);
  const last = buckets.findLastIndex((bucket) => bucket.calls > 0);

  if (first === -1 || totalCalls === 0) {
    return <p className="text-sm text-ink-muted">No calls in this window.</p>;
  }

  // One empty bucket either side, so the outermost column has a neighbour and
  // does not look cut off.
  const shown = buckets.slice(Math.max(0, first - 1), Math.min(buckets.length, last + 2));
  const columns: Column[] = shown.map((bucket) => ({
    label: upperLabel(bucket),
    range: rangeLabel(bucket),
    calls: bucket.calls,
    share: bucket.calls / totalCalls,
  }));

  return (
    <figure className="m-0">
      <div className="h-56 w-full" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={columns}
            margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
            barCategoryGap={2}
          >
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />

            <XAxis
              dataKey="label"
              tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={8}
            />
            <YAxis
              tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={48}
              allowDecimals={false}
            />

            <Tooltip content={<ColumnTooltip />} cursor={{ fill: 'var(--color-surface)' }} />

            <Bar
              dataKey="calls"
              fill="var(--color-series-calls)"
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <figcaption className="mt-2 text-xs text-ink-muted">
        Each column counts calls up to the time under it. Two humps mean two kinds of call, such as
        a cache hit and a network round trip, which a single median hides.
      </figcaption>

      <ChartData
        caption="Calls by response time"
        columns={['Response time', 'Calls', 'Share']}
        rows={columns.map((column) => [column.range, column.calls, `${(column.share * 100).toFixed(1)}%`])}
      />
    </figure>
  );
}

interface TooltipProps {
  active?: boolean;
  payload?: { payload?: Column }[];
}

function ColumnTooltip({ active, payload }: TooltipProps) {
  const column = payload?.[0]?.payload;

  if (active !== true || column === undefined) return null;

  return (
    <div className="rounded-lg border border-border bg-raised px-3 py-2 shadow-sm">
      <p className="mb-1 text-xs text-ink-muted">{column.range}</p>
      <p className="text-xs text-ink">
        <span className="font-medium tabular-nums">{column.calls.toLocaleString('en-US')}</span>{' '}
        call{column.calls === 1 ? '' : 's'}
        <span className="text-ink-muted"> ({formatShare(column.share)})</span>
      </p>
    </div>
  );
}

function upperLabel(bucket: LatencyBucket): string {
  return bucket.toMs === null ? `>${duration(bucket.fromMs)}` : duration(bucket.toMs);
}

function rangeLabel(bucket: LatencyBucket): string {
  if (bucket.toMs === null) return `Over ${duration(bucket.fromMs)}`;
  if (bucket.fromMs === 0) return `Up to ${duration(bucket.toMs)}`;

  return `${duration(bucket.fromMs)} to ${duration(bucket.toMs)}`;
}

function duration(ms: number): string {
  return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
}

function formatShare(share: number): string {
  const percent = share * 100;

  if (percent > 0 && percent < 1) return '<1%';

  return `${Math.round(percent)}%`;
}
