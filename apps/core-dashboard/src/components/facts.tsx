import type { ReactNode } from 'react';

import { InfoTip } from './info-tip';

/**
 * Labelled values, one a line: the label to the left, the value to the right. A third entry explains the label,
 * behind an (i) beside it, for a number whose meaning is not obvious from its name.
 */
export function Facts({ rows }: { rows: ([string, ReactNode] | [string, ReactNode, string])[] }) {
  return (
    <dl className="space-y-2 text-sm">
      {rows.map(([term, value, about]) => (
        <div key={term} className="flex justify-between gap-4">
          <dt className="flex shrink-0 items-center gap-1 text-ink-muted">
            {term}
            {about === undefined ? null : (
              <InfoTip
                id={`fact-${term.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`}
                about={term.toLowerCase()}
                align="start"
              >
                {about}
              </InfoTip>
            )}
          </dt>
          <dd className="min-w-0 text-right text-ink tabular-nums [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
