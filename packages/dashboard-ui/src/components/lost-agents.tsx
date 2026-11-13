import Link from 'next/link';
import type { ReactNode } from 'react';

import type { LostAgents as LostAgentsData, LostTool, SessionOutcomes, ToolAfterFailure } from '../lib/api';
import { clientLabel, formatCount } from '../lib/format';
import { type Params, withParams } from '../lib/query';
import { BreakableName } from './breakable-name';
import { Card, CardHeader } from './ui/card';

/** The outcomes in the order the bar draws them, best first. */
export const OUTCOMES: { key: keyof SessionOutcomes; label: string; colour: string }[] = [
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

      <OutcomeBar
        segments={OUTCOMES.map((outcome) => ({ ...outcome, count: data.sessions[outcome.key] }))}
        total={total}
        note={`${formatCount(total)} session${total === 1 ? '' : 's'}, each counted once, by the worst that happened in it.`}
      />

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

/** What came of each time stuck at one tool, in the order the bar draws them. */
const AFTER_FAILURE: { key: 'recovered' | 'wentElsewhere' | 'endedOnIt' | 'undecided'; label: string; colour: string }[] =
  [
    { key: 'recovered', label: 'Retried until it worked', colour: 'bg-status-good' },
    { key: 'wentElsewhere', label: 'Tried something else', colour: 'bg-series-calls' },
    { key: 'endedOnIt', label: 'Session stopped here', colour: 'bg-status-critical' },
    { key: 'undecided', label: 'May still be going', colour: 'bg-ink-muted/30' },
  ];

/**
 * After one tool fails: what agents did next, then the same by client.
 *
 * Clients differ more here than anywhere else. One reads the error and fixes
 * its arguments; another sends the same call again, or stops. A tool that
 * only one client gets stuck at usually needs a clearer error message rather
 * than a fix to the tool.
 */
export function AfterItFails({ data, params }: { data: ToolAfterFailure; params: Params }) {
  if (data.tool === null) return null;

  const tool = data.tool;
  const carried = { serverId: params['serverId'], range: params['range'], toolName: params['toolName'] };

  return (
    <Card id="after-failure">
      <CardHeader
        title="After it fails"
        hint={data.sampled ? 'From the newest 100,000 calls' : 'What agents did next'}
      />

      <OutcomeBar
        segments={AFTER_FAILURE.map((outcome) => ({ ...outcome, count: tool[outcome.key] }))}
        total={tool.failures}
        note={`Stuck ${formatCount(tool.failures)} time${tool.failures === 1 ? '' : 's'}: a failure and the retries straight after it count as one.${
          tool.looped > 0
            ? ` ${formatCount(tool.looped)} of them repeated the same call at least once.`
            : ''
        }`}
      />

      {data.clients.length > 1 ? (
        <>
          <p className="mt-5 mb-2 text-sm text-ink-muted">By client, worst first.</p>
          <ul className="divide-y divide-border text-sm">
            {data.clients.map((client) => (
              <li
                key={client.clientType}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
              >
                <span className="min-w-0 break-words">
                  <span className="text-ink">{clientLabel(client.clientType)}</span>
                  <WhatCameOf
                    row={client}
                    endedHref={`/sessions${withParams(carried, { clientType: client.clientType, with: 'failures' })}`}
                  />
                </span>
                <Stuck times={client.failures} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/** Counts by outcome: one bar, then each outcome with its count. */
export function OutcomeBar({
  segments,
  total,
  note,
}: {
  segments: { key: string; label: string; colour: string; count: number }[];
  total: number;
  note: string;
}) {
  const shown = segments.filter((segment) => segment.count > 0);

  return (
    <div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-sm"
        role="img"
        aria-label={shown.map((segment) => `${segment.label}: ${segment.count}`).join(', ')}
      >
        {shown.map((segment) => (
          <span key={segment.key} className={segment.colour} style={{ width: `${(segment.count / total) * 100}%` }} />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-ink-muted">
        {shown.map((segment) => (
          <li key={segment.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={`inline-block size-2 rounded-sm ${segment.colour}`} />
            {segment.label}
            <span className="text-ink tabular-nums">{formatCount(segment.count)}</span>
            <span className="tabular-nums">({percent(segment.count, total)})</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-muted">{note}</p>
    </div>
  );
}

function ToolRow({ tool, params }: { tool: LostTool; params: Params }) {
  const carried = { serverId: params['serverId'], range: params['range'], clientType: params['clientType'] };

  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5">
      <span className="min-w-0 break-words">
        <Link
          href={`/tool${withParams(carried, { toolName: tool.toolName })}`}
          className="font-mono text-xs text-ink underline-offset-2 hover:underline"
        >
          <BreakableName name={tool.toolName} />
        </Link>
        <WhatCameOf
          row={tool}
          endedHref={`/sessions${withParams(carried, { toolName: tool.toolName, with: 'failures' })}`}
        />
      </span>
      <Stuck times={tool.failures} />
    </li>
  );
}

/** One line of what came of the times stuck, leaving out what never happened. */
function WhatCameOf({ row, endedHref }: { row: Omit<LostTool, 'toolName'>; endedHref: string }) {
  const parts: ReactNode[] = [];

  if (row.recovered > 0) {
    parts.push(
      <span key="recovered">
        retried until it worked {formatCount(row.recovered)}×
        {row.meanRetries === null ? null : ` (${formatRetries(row.meanRetries)})`}
      </span>,
    );
  }
  if (row.wentElsewhere > 0) {
    parts.push(
      <span key="elsewhere">
        tried something else {formatCount(row.wentElsewhere)}×
        {row.insteadMostOften === null ? null : (
          <>
            , mostly <span className="font-mono">{row.insteadMostOften.name}</span>
          </>
        )}
      </span>,
    );
  }
  if (row.looped > 0) {
    parts.push(
      <span key="looped" className="text-status-warning-ink">
        repeated the same call {formatCount(row.looped)}×
      </span>,
    );
  }
  if (row.endedOnIt > 0) {
    parts.push(
      <Link key="ended" href={endedHref} className="text-status-critical underline-offset-2 hover:underline">
        session stopped here {formatCount(row.endedOnIt)}×
      </Link>,
    );
  }
  if (row.undecided > 0) parts.push(<span key="undecided">may still be going {formatCount(row.undecided)}×</span>);

  return (
    <span className="mt-0.5 block text-xs text-ink-muted">
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? ' · ' : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function Stuck({ times }: { times: number }) {
  return (
    <span className="text-xs text-ink-muted tabular-nums">
      stuck {formatCount(times)} time{times === 1 ? '' : 's'}
    </span>
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
