import Link from 'next/link';

import { LocalTime } from '@/components/local-time';
import { CannotReachApi, Notice, NothingConnectedYet } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { OffsetPager } from '@/components/pager';
import { RangePicker } from '@/components/range-picker';
import { Card, CardHeader } from '@/components/ui/card';
import {
  ApiError,
  getSessions,
  getTransitions,
  type SessionSummary,
  type Transition,
} from '@/lib/api';
import { clientLabel, formatCount, kindLabel } from '@/lib/format';
import { offsetParam, withParams } from '@/lib/query';
import { resolveRange } from '@/lib/range';
import { currentSession } from '@/lib/session';

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  throw error;
}

/**
 * How agents move through the server, rather than what each call did.
 *
 * The order of calls is where the questions worth asking live: whether an
 * agent always searches before it books, pages through a list again and
 * again, or repeats a call after it failed. The first card answers those for
 * every session at once; the list below opens any one of them.
 */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const range = resolveRange(params['range']);
  const session = await currentSession();
  const query = {
    from: range.from,
    ...(params['serverId'] === undefined ? {} : { serverId: params['serverId'] }),
  };

  const [transitions, sessions] = await Promise.all([
    getTransitions(session, {
      ...query,
      offset: offsetParam(params, 'transitionsOffset'),
    }).catch(asApiError),
    getSessions(session, { ...query, offset: offsetParam(params, 'sessionsOffset') }).catch(
      asApiError,
    ),
  ]);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-6 py-10">
      <PageHeader
        title="Sessions"
        subtitle={range.label}
        actions={<RangePicker current={range.key} params={params} />}
      />

      {sessions instanceof ApiError ? (
        sessions.status === 400 ? (
          <NothingConnectedYet />
        ) : (
          <CannotReachApi reason={sessions.message} status={sessions.status} />
        )
      ) : sessions.sessions.length === 0 ? (
        <Notice title="No sessions in this window">
          <p>
            A session is one connection from a client, and it is recorded for servers set up with{' '}
            <code className="font-mono text-xs">instrument()</code>. Calls recorded through{' '}
            <code className="font-mono text-xs">track()</code> alone cannot see the connection they
            arrived on.
          </p>
          <p>
            Servers over HTTP without transport sessions record none either: a stateless endpoint,
            and any client on the 2026-07-28 protocol, which has no sessions.
          </p>
        </Notice>
      ) : (
        <>
          {transitions instanceof ApiError ? null : (
            <Card id="transitions">
              <CardHeader
                title="What follows what"
                hint={transitions.sampled ? 'From the newest 100,000 calls' : 'Most common first'}
              />
              <p className="mb-4 text-sm text-ink-muted">
                Each row is one step an agent took, from one call to the next within a session. A
                tool following itself is paging or retrying; after a failure, it usually means the
                error did not tell the agent what to change.
              </p>
              <TransitionTable transitions={transitions.transitions} />
              <OffsetPager
                params={params}
                name="transitionsOffset"
                offset={transitions.offset}
                limit={transitions.limit}
                hasMore={transitions.hasMore}
                hash="#transitions"
              />
            </Card>
          )}

          <Card id="sessions">
            <CardHeader
              title="Recent sessions"
              hint={sessions.sampled ? 'From the newest 100,000 calls' : 'Newest first'}
            />
            <SessionList sessions={sessions.sessions} params={params} />
            <OffsetPager
              params={params}
              name="sessionsOffset"
              offset={sessions.offset}
              limit={sessions.limit}
              hasMore={sessions.hasMore}
              hash="#sessions"
            />
          </Card>
        </>
      )}
    </main>
  );
}

/** What an agent called, with its kind said when it was a resource or a prompt. */
/**
 * What was called, kept whole: a step wraps between its two ends, never
 * inside a name, unless one name alone is wider than the column.
 */
function Called({
  kind,
  name,
  muted = false,
  arrow = false,
}: {
  kind: string | null;
  name: string;
  muted?: boolean;
  /** Leads with the arrow, so it wraps together with what it points at. */
  arrow?: boolean;
}) {
  const label = kindLabel(kind);

  return (
    <span className="inline-block max-w-full [overflow-wrap:anywhere]">
      {arrow ? (
        <>
          <span aria-hidden className="pr-1.5 text-ink-muted">
            →
          </span>
          <span className="sr-only">then </span>
        </>
      ) : null}
      {label === null ? null : <span className="mr-1 text-xs text-ink-muted">{label}</span>}
      <span className={`font-mono text-xs ${muted ? 'text-ink-muted' : 'text-ink'}`}>{name}</span>
    </span>
  );
}

function TransitionTable({ transitions }: { transitions: Transition[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-muted">
            <th scope="col" className="pb-2 font-medium">
              Step
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Times
            </th>
            <th scope="col" className="pb-2 pl-4 text-right font-medium">
              After a failure
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {transitions.map((transition) => (
            <tr key={`${transition.fromKind ?? ''}:${transition.from ?? ''}>${transition.toKind}:${transition.to}`}>
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                <Called kind={transition.fromKind} name={transition.from ?? 'start'} muted />{' '}
                <Called kind={transition.toKind} name={transition.to} arrow />
              </th>
              <td className="py-2 text-right tabular-nums">{formatCount(transition.calls)}</td>
              <td
                className={`py-2 pl-4 text-right tabular-nums ${
                  transition.afterFailure > 0 ? 'text-status-critical' : 'text-ink-muted'
                }`}
              >
                {transition.afterFailure > 0 ? formatCount(transition.afterFailure) : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionList({
  sessions,
  params,
}: {
  sessions: SessionSummary[];
  params: Record<string, string | undefined>;
}) {
  return (
    <ul className="divide-y divide-border">
      {sessions.map((session) => {
        // The session's own span, so the API reads only those rows. A
        // millisecond past the end, because the window excludes its end.
        const href = `/sessions/${session.sessionId}${withParams(
          { serverId: params['serverId'], range: params['range'] },
          {
            from: session.startedAt,
            to: new Date(Date.parse(session.endedAt) + 1).toISOString(),
          },
        )}`;

        return (
          <li key={session.sessionId} className="py-3 text-sm first:pt-0 last:pb-0">
            <Link href={href} className="group block">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-ink group-hover:underline">
                  {formatCount(session.calls)} call{session.calls === 1 ? '' : 's'},{' '}
                  {formatCount(session.tools)} tool{session.tools === 1 ? '' : 's'}
                </span>
                {session.failures > 0 ? (
                  <span className="text-xs text-status-critical">
                    {formatCount(session.failures)} failed
                  </span>
                ) : null}
                {session.repeated > 0 ? (
                  <span className="text-xs text-status-warning-ink">
                    {formatCount(session.repeated)} repeated
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                {clientLabel(session.clientType)}
                {session.clientName === null ? '' : ` (${session.clientName})`}, started{' '}
                <LocalTime iso={session.startedAt} />
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
