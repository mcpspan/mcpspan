import type { ReactNode } from 'react';

/** Labelled values, one a line: the label to the left, the value to the right. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="space-y-2 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="flex justify-between gap-4">
          <dt className="shrink-0 text-ink-muted">{term}</dt>
          <dd className="min-w-0 text-right text-ink tabular-nums [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
