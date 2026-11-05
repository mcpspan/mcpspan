import Link from 'next/link';
import type { ReactNode } from 'react';

import type { LostAgents as LostAgentsData, LostTool, SessionOutcomes } from '../lib/api';
import { formatCount } from '../lib/format';
import { type Params, withParams } from '../lib/query';
import { BreakableName } from './breakable-name';
import { Card, CardHeader } from './ui/card';

/** The outcomes in the order the bar draws them, best first. */
const OUTCOMES: { key: keyof SessionOutcomes; label: string; colour: string }[] = [
  { key: 'clean', label: 'No failures', colour: 'bg-border' },
  { key: 'recovered', label: 'Retried until it worked', colour: 'bg-status-good' },
  { key: 'wentElsewhere', label: 'Tried something else', colour: 'bg-series-calls' },
  { key: 'looped', label: 'Repeated the same call', colour: 'bg-status-warning' },
  { key: 'endedOnFailure', label: 'Stopped on a failure', colour: 'bg-status-critical' },
  { key: 'undecided', label: 'May still be going', colour: 'bg-ink-muted/30' },
];

/**
 * Where agents get lost: what became of each session, and the tools they got
 * stuck at, worst first.
 *
 * A tool's error rate says how often it fails; this says what that cost the
 * agent. A failure retried until it worked is a hiccup. One the agent
 * retried with the same arguments, or stopped on, is a description, a schema
 * or an error message that did not tell it what to do. That is the part a
 * server's author can fix, so it is what the list is ordered by.
 *
 * Shown only once a session has been read: a server reporting without
 * sessions has nothing to say here.
 */
export function LostAgents({ data, params, pager }: { data: LostAgentsData; params: Params; pager?: ReactNode }) {
  const total = Object.values(data.sessions).reduce((sum, count) => sum + count, 0);

  if (total === 0) return null;

  return (
    <Card id="lost">
      <CardHeader
        title="Where agents get lost"
        hint={data.sampled ? 'From the newest 100,000 calls' : 'What came of each session'}
      />

      <OutcomeBar outcomes={data.sessions} total={total} />

      {data.tools.length === 0 ? (
        <p className="mt-5 text-sm text-ink-muted">No tool failed an agent in this window.</p>
      ) : (
        <>
          <p className="mt-5 mb-2 text-sm text-ink-muted">
            The tools agents got stuck at, worst first. A failure and the retries straight after it count as one
            time stuck.
          </p>
          <ul className="divide-y divide-border text-sm">
            {data.tools.map((tool) => (
              <ToolRow key={tool.toolName} tool={tool} params={params} />
            ))}
          </ul>
        </>
      )}

      {pager}
    </Card>
  );
}

/** Sessions by outcome: one bar, then each outcome with its count. */
function OutcomeBar({ outcomes, total }: { outcomes: SessionOutcomes; total: number }) {
  const shown = OUTCOMES.filter((outcome) => outcomes[outcome.key] > 0);

  return (
    <div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-sm"
        role="img"
        aria-label={shown.map((outcome) => `${outcome.label}: ${outcomes[outcome.key]}`).join(', ')}
      >
        {shown.map((outcome) => (
          <span
            key={outcome.key}
            className={outcome.colour}
            style={{ width: `${(outcomes[outcome.key] / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-muted">
        {shown.map((outcome) => (
          <li key={outcome.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block size-2 rounded-sm ${outcome.colour}`} />
            {outcome.label}
            <span className="text-ink tabular-nums">{formatCount(outcomes[outcome.key])}</span>
            <span className="tabular-nums">({percent(outcomes[outcome.key], total)})</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-muted">
        {formatCount(total)} session{total === 1 ? '' : 's'}, each counted once, by the worst that happened in it.
      </p>
    </div>
  );
}

function ToolRow({ tool, params }: { tool: LostTool; params: Params }) {
  const carried = { serverId: params['serverId'], range: params['range'], clientType: params['clientType'] };
  const parts: ReactNode[] = [];

  if (tool.recovered > 0) {
    parts.push(
      <span key="recovered">
        retried until it worked {formatCount(tool.recovered)}×
        {tool.meanRetries === null ? null : ` (${formatRetries(tool.meanRetries)})`}
      </span>,
    );
  }
  if (tool.wentElsewhere > 0) {
    parts.push(
      <span key="elsewhere">
        tried something else {formatCount(tool.wentElsewhere)}×
        {tool.insteadMostOften === null ? null : (
          <>
            , mostly <span className="font-mono">{tool.insteadMostOften.name}</span>
          </>
        )}
      </span>,
    );
  }
  if (tool.looped > 0) {
    parts.push(
      <span key="looped" className="text-status-warning-ink">
        repeated the same call {formatCount(tool.looped)}×
      </span>,
    );
  }
  if (tool.endedOnIt > 0) {
    parts.push(
      <Link
        key="ended"
        href={`/sessions${withParams(carried, { toolName: tool.toolName, with: 'failures' })}`}
        className="text-status-critical underline-offset-2 hover:underline"
      >
        session stopped here {formatCount(tool.endedOnIt)}×
      </Link>,
    );
  }
  if (tool.undecided > 0) parts.push(<span key="undecided">may still be going {formatCount(tool.undecided)}×</span>);

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <span className="min-w-0 break-words">
        <Link
          href={`/tool${withParams(carried, { toolName: tool.toolName })}`}
          className="font-mono text-xs text-ink underline-offset-2 hover:underline"
        >
          <BreakableName name={tool.toolName} />
        </Link>
        <span className="mt-0.5 block text-xs text-ink-muted">
          {parts.map((part, i) => (
            <span key={i}>
              {i > 0 ? ' · ' : null}
              {part}
            </span>
          ))}
        </span>
      </span>
      <span className="text-xs text-ink-muted tabular-nums">
        stuck {formatCount(tool.failures)} time{tool.failures === 1 ? '' : 's'}
      </span>
    </li>
  );
}

function percent(count: number, total: number): string {
  const value = (count / total) * 100;

  if (value > 0 && value < 1) return '<1%';

  return `${Math.round(value)}%`;
}

/** "1 retry", "2.4 retries". */
function formatRetries(mean: number): string {
  const rounded = Math.round(mean * 10) / 10;

  return `${rounded} ${rounded === 1 ? 'retry' : 'retries'} on average`;
}
