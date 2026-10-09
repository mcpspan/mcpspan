import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Copyable } from '@/components/copyable';
import { Facts } from '@/components/facts';
import { LocalTime } from '@/components/local-time';
import { CannotReachApi } from '@/components/notice';
import { OutcomeBadge } from '@/components/outcome-badge';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/ui/card';
import { ApiError, type CallDetail, getCall } from '@/lib/api';
import { formatBytes } from '@/lib/diagnosis';
import { clientLabel, errorSourceInfo, formatDuration, formatSpan, kindLabel } from '@/lib/format';
import { withParams } from '@/lib/query';
import { currentSession } from '@/lib/session';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One call, with everything recorded about it.
 *
 * Which is all mcpspan ever holds: what was called, how it ended, how long it
 * took, who called it and in which session, and the names and types of what
 * was sent. The values are never recorded, so they are never here either.
 */
export default async function CallPage({
  params,
  searchParams,
}: {
  params: Promise<{ callId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { callId } = await params;
  const query = await searchParams;
  const carried = { serverId: query['serverId'], range: query['range'] };

  const call = await getCall(
    await currentSession(),
    callId,
    query['serverId'] === undefined ? {} : { serverId: query['serverId'] },
  ).catch((error: unknown) => {
    if (error instanceof ApiError) return error;

    throw error;
  });

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <Link
        href={`/calls${withParams(carried, {})}`}
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All calls
      </Link>

      {call instanceof ApiError ? (
        call.status === 404 ? (
          <Card>
            <p className="text-sm text-ink-muted">
              No such call on this server. It may be older than the events kept, or belong to another server.
            </p>
          </Card>
        ) : (
          <CannotReachApi reason={call.message} status={call.status} />
        )
      ) : (
        <Detail call={call} carried={carried} />
      )}
    </main>
  );
}

function Detail({ call, carried }: { call: CallDetail; carried: Record<string, string | undefined> }) {
  const duration = formatDuration(call.durationMs);
  const kind = kindLabel(call.kind) ?? 'Tool';
  const explanation = call.errorSource === null ? undefined : errorSourceInfo(call.errorSource, call.kind).explanation;
  const delay = Date.parse(call.receivedAt) - Date.parse(call.occurredAt);
  const occurred = Date.parse(call.occurredAt);

  return (
    <>
      <PageHeader
        title={call.toolName}
        subtitle={
          <>
            {kind} {call.kind === 'tool' ? 'call' : call.kind === 'resource' ? 'read' : 'get'},{' '}
            <LocalTime iso={call.occurredAt} />
          </>
        }
      />

      <Card>
        <CardHeader title="How it ended" />
        <div className="flex flex-wrap items-center gap-2">
          <OutcomeBadge success={call.success} source={call.errorSource} kind={call.kind} />
          {call.errorType === null ? null : <span className="font-mono text-xs text-ink">{call.errorType}</span>}
          <span className="text-sm text-ink-muted tabular-nums">
            in {duration.value}
            {duration.unit}
          </span>
        </div>
        {call.errorMessage !== null ? (
          <p className="mt-3 text-sm break-words text-ink">{call.errorMessage}</p>
        ) : call.success || explanation === undefined ? null : (
          <p className="mt-3 text-sm text-ink-muted">{explanation}</p>
        )}
      </Card>

      <Card>
        <CardHeader title="Recorded" hint="Everything mcpspan holds about this call" />
        <Facts
          rows={[
            ['Kind', kind],
            ['Called', <LocalTime key="at" iso={call.occurredAt} />],
            [
              'Received',
              <>
                <LocalTime iso={call.receivedAt} />
                {/* Clocks on two machines: a small negative gap is skew, not time travel. */}
                {delay > 1_000 ? <span className="text-ink-muted">, {formatSpan(delay)} later</span> : null}
              </>,
            ],
            [
              'Client',
              <>
                {clientLabel(call.clientType)}
                {call.clientName === null ? null : (
                  <span className="text-ink-muted">
                    {' '}
                    ({call.clientName}
                    {call.clientVersion === null ? '' : ` ${call.clientVersion}`})
                  </span>
                )}
              </>,
            ],
            [
              'Server version',
              call.serverVersion === null ? (
                <span className="text-ink-muted">Not reported</span>
              ) : (
                <Link
                  href={`/calls${withParams(carried, { serverVersion: call.serverVersion })}`}
                  className="font-mono text-xs underline underline-offset-2"
                >
                  {call.serverVersion}
                </Link>
              ),
            ],
            [
              'Session',
              call.sessionId === null ? (
                <span className="text-ink-muted">None</span>
              ) : (
                <Link
                  href={`/sessions/${call.sessionId}${withParams(carried, {
                    from: new Date(occurred - DAY_MS).toISOString(),
                    to: new Date(occurred + DAY_MS).toISOString(),
                  })}`}
                  className="underline underline-offset-2"
                >
                  Every call in it
                </Link>
              ),
            ],
            ...(call.repeated
              ? [['Repeated', 'Same arguments as this tool\'s call before it in the session'] as [string, string]]
              : []),
            ...(call.invalidArguments === null
              ? []
              : [['Invalid arguments', <span className="font-mono text-xs">{call.invalidArguments.join(', ')}</span>] as [
                  string,
                  ReactNode,
                ]]),
            [
              'Answer size',
              call.responseBytes === null ? (
                <span className="text-ink-muted">Not measured</span>
              ) : (
                formatBytes(call.responseBytes)
              ),
            ],
            ['SDK', `mcpspan ${call.sdkVersion}`],
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Parameters" hint="Names and types only, never values" />
        {call.parameters === null || Object.keys(call.parameters).length === 0 ? (
          <p className="text-sm text-ink-muted">
            {call.parameters === null
              ? 'Not recorded. Turn on recording parameter names in the SDK to see what agents send.'
              : 'Called with none.'}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-muted">
                <th scope="col" className="pb-2 font-medium">
                  Name
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Sent as
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {Object.entries(call.parameters).map(([name, type]) => (
                <tr key={name}>
                  <td className="py-2 pr-4 font-mono text-xs [overflow-wrap:anywhere]">{name}</td>
                  <td className="py-2 text-xs text-ink-muted">{type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader title="Around it" />
        <ul className="space-y-2 text-sm">
          <li>
            <Link
              href={`/calls${withParams(carried, call.kind === 'tool' ? { toolName: call.toolName } : { kind: call.kind })}`}
              className="underline underline-offset-2"
            >
              {call.kind === 'tool' ? `Every call to ${call.toolName}` : `Every ${kind.toLowerCase()} ${call.kind === 'resource' ? 'read' : 'get'}`}
            </Link>
          </li>
          {call.kind === 'tool' ? (
            <li>
              <Link href={`/tool${withParams(carried, { toolName: call.toolName })}`} className="underline underline-offset-2">
                How {call.toolName} is doing
              </Link>
            </li>
          ) : null}
        </ul>
        <div className="mt-4">
          <p className="mb-1.5 text-xs text-ink-muted">Event id, as the SDK sent it</p>
          <Copyable text={call.id} label="event id" />
        </div>
      </Card>
    </>
  );
}
