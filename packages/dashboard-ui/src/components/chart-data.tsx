import type { ReactNode } from 'react';

/**
 * The numbers behind a chart, folded away under it.
 *
 * For whoever needs a value exactly, cannot read a chart, or reads the page
 * with a screen reader: the chart is a picture of this table, never the only
 * place the numbers are.
 */
export function ChartData({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: ReactNode[][];
}) {
  return (
    <details className="group mt-3 text-xs">
      <summary className="w-fit cursor-pointer text-ink-muted outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink">
        Show the numbers
      </summary>
      <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-border">
        <table className="w-full">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface">
            <tr>
              {columns.map((column, index) => (
                <th
                  key={column}
                  scope="col"
                  className={`px-3 py-1.5 font-medium text-ink-muted ${index === 0 ? 'text-left' : 'text-right'}`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, rowIndex) => (
              // By position: a label can repeat, the hour of yesterday and of today.
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td
                    key={index}
                    className={`px-3 py-1 tabular-nums ${index === 0 ? 'text-left text-ink-muted' : 'text-right text-ink'}`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
