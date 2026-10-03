import type { PrimitiveStats, ResourcesAndPrompts as Data } from '@/lib/api';
import { formatCount, formatDuration, formatRate } from '@/lib/format';
import { Card, CardHeader } from './ui/card';

/** Above this, an error rate is called out rather than just reported, as for tools. */
const ELEVATED_ERROR_RATE = 0.05;

/**
 * What agents read and asked for besides tools.
 *
 * Resources by the URI or URI template the server registered them under,
 * prompts by name, each with the numbers the tool table gives. Shown only
 * when there is something to show: most servers offer tools alone, and a card
 * saying so on every visit would be noise. What was asked for and is not on
 * the server is listed with the tools that are not there (unknown-tools.tsx).
 */
/** Whether there is anything for the card to show. */
export function hasResourcesOrPrompts(data: Data): boolean {
  return data.resources.length + data.prompts.length > 0;
}

export function ResourcesAndPrompts({ data }: { data: Data }) {
  if (!hasResourcesOrPrompts(data)) return null;

  return (
    <Card id="resources-and-prompts">
      <CardHeader title="Resources and prompts" hint="Read and got by agents" />

      {/* items-start: stretched to the taller one, the shorter table spread its rows apart. */}
      <div className="grid items-start gap-6 md:grid-cols-2">
        <Ranking label="Resource" empty="No resources were read in this window." items={data.resources} />
        <Ranking label="Prompt" empty="No prompts were got in this window." items={data.prompts} />
      </div>
    </Card>
  );
}

function Ranking({ label, empty, items }: { label: string; empty: string; items: PrimitiveStats[] }) {
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-ink-muted">
          <th scope="col" className="pb-2 text-left font-medium">
            {label}
          </th>
          <th scope="col" className="pb-2 text-right font-medium">
            Calls
          </th>
          <th scope="col" className="pb-2 text-right font-medium">
            Errors
          </th>
          <th scope="col" className="pb-2 text-right font-medium">
            Median
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const median = formatDuration(item.durationMs.p50);

          return (
            <tr key={item.name} className="border-t border-border">
              <th scope="row" className="py-2 pr-2 text-left font-normal [overflow-wrap:anywhere]">
                <span className="font-mono text-xs">{item.name}</span>
              </th>
              <td className="py-2 text-right tabular-nums">{formatCount(item.calls)}</td>
              <td
                className={`py-2 text-right tabular-nums ${
                  item.errorRate > ELEVATED_ERROR_RATE ? 'text-status-critical' : 'text-ink-muted'
                }`}
              >
                {formatRate(item.errorRate)}%
              </td>
              <td className="py-2 text-right tabular-nums text-ink-muted">
                {median.value}
                {median.unit}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
