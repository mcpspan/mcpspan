'use client';

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { clientLabel } from '../lib/format';
import { formatMoment, formatTime } from './calls-chart';
import { ChartData } from './chart-data';
import { LocalTime } from './local-time';

/**
 * Calls per client over the window: one chart, the same axis as the calls
 * above it, each client a layer in its colour from the ring. Hovering a
 * column says who made its calls.
 */
export function ClientsChart({
  times,
  bucketSeconds,
  clients,
  colors,
}: {
  times: string[];
  bucketSeconds: number;
  clients: { clientType: string; points: number[] }[];
  /** Each client's colour, as on the ring. */
  colors: Record<string, string>;
}) {
  const data = times.map((time, index) => ({
    time,
    ...Object.fromEntries(clients.map((client) => [client.clientType, client.points[index] ?? 0])),
  }));
  const format = (value: string): string => formatTime(value, bucketSeconds);

  return (
    <figure className="m-0">
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -16 }} barCategoryGap="15%">
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
              content={<ClientsTooltip format={(value) => formatMoment(value, bucketSeconds)} colors={colors} />}
              cursor={{ fill: 'var(--color-surface)' }}
            />
            {clients.map((client) => (
              <Bar
                key={client.clientType}
                dataKey={client.clientType}
                name={clientLabel(client.clientType)}
                stackId="clients"
                fill={colors[client.clientType]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <ChartData
        caption="Calls per client per bucket"
        columns={['Time', ...clients.map((client) => clientLabel(client.clientType))]}
        rows={times.map((time, index) => [
          <LocalTime key="time" iso={time} />,
          ...clients.map((client) => client.points[index] ?? 0),
        ])}
      />
    </figure>
  );
}

interface TooltipProps {
  active?: boolean;
  label?: string;
  payload?: { dataKey?: string | number; value?: number; name?: string }[];
  format: (value: string) => string;
  colors: Record<string, string>;
}

/** Who made a column's calls, busiest first; clients with none in it are left out. */
function ClientsTooltip({ active, label, payload, format, colors }: TooltipProps) {
  if (active !== true || !payload?.length) return null;

  const rows = payload
    .filter((entry) => (entry.value ?? 0) > 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = rows.reduce((sum, entry) => sum + (entry.value ?? 0), 0);

  return (
    <div className="rounded-lg border border-border bg-raised px-3 py-2 shadow-sm">
      <p className="mb-1 text-xs text-ink-muted">
        {format(label ?? '')} · {total} call{total === 1 ? '' : 's'}
      </p>
      {rows.length === 0 ? <p className="text-xs text-ink-muted">No calls</p> : null}
      {rows.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-2 text-xs text-ink">
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={{ backgroundColor: colors[String(entry.dataKey)] }}
          />
          {entry.name}
          <span className="ml-auto pl-4 font-medium tabular-nums">{entry.value}</span>
        </p>
      ))}
    </div>
  );
}
