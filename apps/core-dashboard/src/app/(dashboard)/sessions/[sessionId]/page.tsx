import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { LocalTime } from '@/components/local-time';
import { CannotReachApi } from '@/components/notice';
import { OutcomeBadge } from '@/components/outcome-badge';
import { PageHeader } from '@/components/page-header';
import { CursorPager } from '@/components/pager';
import { Card, CardHeader } from '@/components/ui/card';
import { ApiError, getSessionCalls, type SessionCall } from '@/lib/api';
import { clientLabel, formatCount, formatDuration, formatSpan, kindLabel } from '@/lib/format';
import { withParams } from '@/lib/query';
import { currentSession } from '@/lib/session';

/**
 * One session, call by call, in the order the agent made them.
 *
 * Reached from the session list, which passes the session's own start and
 * end, so only that span is read. Opened without them, it looks at the last
 * day, which is where a session somebody is asking about usually is.
 */
export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { sessionId } = await params;
  const query = await searchParams;

  const result = await getSessionCalls(await currentSession(), sessionId, {
    from: query['from'] ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ...(query['to'] === undefined ? {} : { to: query['to'] }),
    ...(query['serverId'] === undefined ? {} : { serverId: query['serverId'] }),
    ...(query['after'] === undefined ? {} : { after: query['after'] }),
  }).catch((error: unknown) => {
    if (error instanceof ApiError) return error;

    throw error;
  });

  const back = `/sessions${withParams({ serverId: query['serverId'], range: query['range'] }, {})}`;
  const calls = result instanceof ApiError ? [] : result.calls;
  const first = calls[0];
  const last = calls.at(-1);
  const failed = calls.filter((call) => !call.success).length;

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <Link
        href={back}
        className="inline-flex items-center gap-1.5 text-sm text-ink-muted underline-offset-2 hover:text-ink hover:underline"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All sessions
      </Link>

      <PageHeader
        title="Session"
        subtitle={
          first === undefined || last === undefined ? (
            sessionId
          ) : (
            <>
              {clientLabel(first.clientType)}
              {first.clientName === null ? null : ` (${first.clientName})`}, started{' '}
              <LocalTime iso={first.occurredAt} />
              {calls.length > 1
                ? `, lasted ${formatSpan(Date.parse(last.occurredAt) - Date.parse(first.occurredAt))}`
                : null}
              {failed > 0 ? `, ${formatCount(failed)} failed` : null}
            </>
          )
        }
      />

      {result instanceof ApiError ? (
        <CannotReachApi reason={result.message} status={result.status} />
      ) : (
        <Card>
          <CardHeader
            title="Calls in order"
            hint={`${formatCount(result.calls.length)} call${
              result.calls.length === 1 ? '' : 's'
            }${result.nextCursor === null ? '' : ' on this page'}`}
          />
          {result.calls.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No calls from this session in the window asked about.
            </p>
          ) : (
            <CallList
              calls={result.calls}
              startAt={query['after'] === undefined ? 1 : undefined}
              since={query['after'] === undefined ? first?.occurredAt : undefined}
              carried={{ serverId: query['serverId'], range: query['range'] }}
            />
          )}
          <CursorPager
            params={query}
            name="after"
            cursor={result.nextCursor}
            onwardLabel="Later calls"
            startLabel="From the first call"
          />
        </Card>
      )}
    </main>
  );
}

function CallList({
  calls,
  startAt,
  since,
  carried,
}: {
  calls: SessionCall[];
  /** The server and window, kept on the way to a call. */
  carried: Record<string, string | undefined>;
  /** Numbers the calls from here; left off on a later page, where the count is unknown. */
  startAt: number | undefined;
  /** The session's first call, to show each one as time since; unknown on a later page. */
  since: string | undefined;
}) {
  return (
    <ol className="divide-y divide-border">
      {calls.map((call, index) => {
        const duration = formatDuration(call.durationMs);

        return (
          <li key={call.id} className="flex items-baseline gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
            {startAt === undefined ? null : (
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-ink-muted">
                {startAt + index}
              </span>
            )}
            {/* Two lines rather than columns: a name keeps the whole width and
                is broken only when it alone is wider than that. */}
            <div className="min-w-0 flex-1">
              <p className="[overflow-wrap:anywhere]">
                {kindLabel(call.kind) === null ? null : (
                  <span className="mr-1.5 text-xs text-ink-muted">{kindLabel(call.kind)}</span>
                )}
                <Link
                  href={`/calls/${call.id}${withParams(carried, {})}`}
                  className="font-mono text-xs text-ink underline-offset-2 hover:underline"
                >
                  {call.toolName}
                </Link>
              </p>
              <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-muted">
                {call.success ? null : (
                  <span className="flex items-center gap-1.5">
                    <OutcomeBadge success={false} source={call.errorSource} kind={call.kind} />
                    {call.errorType}
                  </span>
                )}
                {call.repeated ? (
                  <span className="text-status-warning-ink" title="The same arguments as this tool's call before it">
                    Repeated
                  </span>
                ) : null}
                <span className="tabular-nums">
                  {duration.value}
                  {duration.unit}
                </span>
                {since === undefined ? (
                  <LocalTime iso={call.occurredAt} />
                ) : (
                  <span className="tabular-nums">
                    +{formatSpan(Date.parse(call.occurredAt) - Date.parse(since))}
                  </span>
                )}
              </p>
              {call.errorMessage === null ? null : (
                <p className="mt-0.5 text-xs break-words text-ink">{call.errorMessage}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
