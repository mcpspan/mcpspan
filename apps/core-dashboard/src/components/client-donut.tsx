'use client';

import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';

import { clientLabel, formatCount } from '@/lib/format';

/** Distinguishable hues, in order of share. Past these, clients are folded into the grey. */
const HUES = ['#2a78d6', '#1f9d8a', '#d9a441', '#8a63d2', '#d0668f'];
const REST = 'var(--color-border)';

/**
 * Who calls, as shares of one ring: the answer at a glance, where the rows
 * beside it answer when.
 *
 * Five clients at most get a colour of their own; any more is one grey slice,
 * since a sixth hue is where a reader starts matching colours to a legend
 * instead of reading. The legend always carries the name and the share, so the
 * colour is never the only way to tell slices apart.
 */
export function ClientDonut({ clients, total }: { clients: { clientType: string; calls: number }[]; total: number }) {
  if (total === 0 || clients.length === 0) return null;

  const named = clients.slice(0, HUES.length);
  const restCalls = clients.slice(HUES.length).reduce((sum, client) => sum + client.calls, 0);
  const slices = [
    ...named.map((client, index) => ({
      name: clientLabel(client.clientType),
      calls: client.calls,
      color: HUES[index] ?? REST,
    })),
    ...(restCalls > 0 ? [{ name: 'Everyone else', calls: restCalls, color: REST }] : []),
  ];

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="relative size-36 shrink-0" aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="calls"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={slices.length > 1 ? 1.5 : 0}
              stroke="none"
              isAnimationActive={false}
            >
              {slices.map((slice) => (
                <Cell key={slice.name} fill={slice.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-ink">{formatCount(total)}</span>
          <span className="text-[11px] text-ink-muted">calls</span>
        </div>
      </div>

      <ul className="w-full space-y-1.5 text-sm sm:w-auto sm:min-w-56">
        {slices.map((slice) => (
          <li key={slice.name} className="flex items-center gap-2">
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
            <span className="text-ink">{slice.name}</span>
            <span className="ml-auto pl-4 text-xs tabular-nums text-ink-muted">
              {formatCount(slice.calls)} · {((slice.calls / total) * 100).toFixed(slice.calls / total < 0.1 ? 1 : 0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
