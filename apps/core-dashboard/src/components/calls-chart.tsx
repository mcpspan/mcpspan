'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ChartData } from './chart-data';
import { LocalTime } from './local-time';

export interface ChartPoint {
  time: string;
  calls: number;
  errors: number;
}

const SERIES = [
  { key: 'calls', label: 'Calls', color: 'var(--color-series-calls)' },
  { key: 'errors', label: 'Errors', color: 'var(--color-series-errors)' },
] as const;

/**
 * Calls and failures over the selected window.
 *
 * Both series share one axis. They are both counts, so a second scale would be
 * inventing a relationship: a chart where the error line is stretched to fill
 * the same height as the call line says errors are as common as calls, which is
 * the opposite of the truth and the single most misleading thing a chart of two
 * measures can do.
 *
 * Errors staying near the floor is the information, not a rendering problem.
 */
export function CallsChart({
  points,
  bucketSeconds,
  versions = [],
}: {
  points: ChartPoint[];
  /** How wide each point is, which decides what the axis labels say. */
  bucketSeconds: number;
  /** Server versions first seen in this window, to mark where each began. */
  versions?: { version: string; firstSeenAt: string }[];
}) {
  const format = (value: string): string => formatTime(value, bucketSeconds);

  return (
    <figure className="m-0">
      <Legend />

      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
            {/* A fill fading to nothing under each line: the volume reads as an
                amount at a glance, and the line stays the exact value. */}
            <defs>
              {SERIES.map((series) => (
                <linearGradient key={series.key} id={`fill-${series.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={series.color} stopOpacity={series.key === 'calls' ? 0.22 : 0.16} />
                  <stop offset="100%" stopColor={series.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>

            {/* Recessive: the grid orients the eye and then gets out of the way. */}
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />

            <XAxis
              dataKey="time"
              tickFormatter={format}
              tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              minTickGap={32}
            />
            <YAxis
              tick={{ fill: 'var(--color-ink-muted)', fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={48}
              allowDecimals={false}
            />

            <Tooltip
              content={<ChartTooltip format={format} />}
              cursor={{ stroke: 'var(--color-border)' }}
            />

            {/* Where a version began: a deploy explains a step in the line
                better than anything else on the page. Placed on the bucket the
                version's first call fell in. */}
            {markersFor(points, bucketSeconds, versions).map((marker) => (
              <ReferenceLine
                key={marker.version}
                x={marker.time}
                stroke="var(--color-ink-muted)"
                strokeDasharray="4 3"
                label={{
                  value: marker.version,
                  position: 'insideTopLeft',
                  fill: 'var(--color-ink-muted)',
                  fontSize: 11,
                }}
              />
            ))}

            {SERIES.map((series) => (
              <Area
                key={series.key}
                type="monotone"
                dataKey={series.key}
                stroke={series.color}
                strokeWidth={2}
                fill={`url(#fill-${series.key})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-raised)' }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <ChartData
        caption="Calls and errors per bucket"
        columns={['Time', 'Calls', 'Errors']}
        rows={points.map((point) => [<LocalTime key="time" iso={point.time} />, point.calls, point.errors])}
      />
    </figure>
  );
}

/**
 * Names the series.
 *
 * Present whenever there are two of them, so identity never rests on colour
 * alone and the chart stays readable printed, or to somebody who cannot tell
 * the two hues apart.
 */
function Legend() {
  return (
    <figcaption className="mb-3 flex items-center gap-4">
      {SERIES.map((series) => (
        <span key={series.key} className="flex items-center gap-1.5 text-xs text-ink-muted">
          <span
            aria-hidden
            className="size-2.5 rounded-full"
            style={{ backgroundColor: series.color }}
          />
          {series.label}
        </span>
      ))}
    </figcaption>
  );
}

interface TooltipProps {
  active?: boolean;
  label?: string;
  payload?: { dataKey?: string | number; value?: number }[];
  format?: (value: string) => string;
}

/** What a point is worth, shown where the reader is already looking. */
function ChartTooltip({ active, label, payload, format }: TooltipProps) {
  if (active !== true || !payload?.length) return null;

  const valueOf = (key: string): number =>
    payload.find((entry) => entry.dataKey === key)?.value ?? 0;

  return (
    <div className="rounded-lg border border-border bg-raised px-3 py-2 shadow-sm">
      <p className="mb-1 text-xs text-ink-muted">{format?.(label ?? '') ?? label}</p>
      {SERIES.map((series) => (
        <p key={series.key} className="flex items-center gap-2 text-xs text-ink">
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ backgroundColor: series.color }}
          />
          {series.label}
          <span className="ml-auto font-medium tabular-nums">{valueOf(series.key)}</span>
        </p>
      ))}
    </div>
  );
}

/** Each version on the bucket its first call fell in; one first seen before the chart starts has no mark. */
function markersFor(
  points: ChartPoint[],
  bucketSeconds: number,
  versions: { version: string; firstSeenAt: string }[],
): { version: string; time: string }[] {
  const first = points[0];
  if (first === undefined) return [];
  const start = Date.parse(first.time);
  const end = start + points.length * bucketSeconds * 1000;

  return versions.flatMap((version) => {
    const at = Date.parse(version.firstSeenAt);
    if (Number.isNaN(at) || at < start || at >= end) return [];
    const bucket = points[Math.floor((at - start) / (bucketSeconds * 1000))];

    return bucket === undefined ? [] : [{ version: version.version, time: bucket.time }];
  });
}

const HOUR = 3_600;
const DAY = 24 * HOUR;

/**
 * Labels a point according to how much time it covers.
 *
 * A clock time on a chart of daily buckets reads as midnight on every tick,
 * which says nothing and looks broken; a date on a chart of minutes repeats
 * itself for the whole axis. The bucket width is the only thing that decides
 * which is right.
 */
function formatTime(value: string, bucketSeconds: number): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  if (bucketSeconds >= DAY) {
    return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  if (bucketSeconds >= 6 * HOUR) {
    return parsed.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit' });
  }

  return parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
