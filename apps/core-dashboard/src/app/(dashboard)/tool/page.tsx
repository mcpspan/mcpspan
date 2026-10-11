import Link from 'next/link';
import { redirect } from 'next/navigation';

import { CallsChart } from '@/components/calls-chart';
import { Facts } from '@/components/facts';
import { LatencyChart } from '@/components/latency-chart';
import { LocalTime } from '@/components/local-time';
import { CannotReachApi } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { ParamSelect } from '@/components/param-select';
import { OffsetPager } from '@/components/pager';
import { RangePicker } from '@/components/range-picker';
import { SummaryCards } from '@/components/summary-cards';
import { Card, CardHeader } from '@/components/ui/card';
import { VersionsTable } from '@/components/versions-table';
import {
  ApiError,
  getFilterOptions,
  getLatency,
  getSummary,
  getTimeseries,
  getToolDetails,
  getVersions,
  type Summary,
  type ToolDetails,
} from '@/lib/api';
import { formatBytes } from '@/lib/diagnosis';
import { clientLabel, errorSourceInfo, formatCount, kindLabel } from '@/lib/format';
import { offsetParam, type Params, withParams } from '@/lib/query';
import { resolveRange } from '@/lib/range';
import { currentSession } from '@/lib/session';

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  throw error;
}

/**
 * One tool: how much it is used, how it fails, and how agents call it.
 *
 * The headline numbers and the chart are the overview's own queries narrowed
 * to this tool, so they cannot disagree with its row in the tool table. The
 * rest is what only makes sense for a single tool: the ways it fails, what it
 * said when it did, and the parameter names agents actually send.
 *
 * The tool is named in the query rather than the path. It is the same filter
 * every other view reads, so the address carries over as it is.
 */
export default async function ToolPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const toolName = params['toolName'];

  if (toolName === undefined || toolName.length === 0) redirect('/');

  const range = resolveRange(params['range']);
  const session = await currentSession();
  const query = {
    from: range.from,
    toolName,
    ...(params['serverId'] === undefined ? {} : { serverId: params['serverId'] }),
  };

  const [summary, previous, timeseries, details, latency, versions, options] = await Promise.all([
    getSummary(session, query).catch(asApiError),
    getSummary(session, { ...query, ...range.previous }).catch(() => undefined),
    getTimeseries(session, query).catch(asApiError),
    getToolDetails(session, {
      ...query,
      messagesOffset: offsetParam(params, 'messagesOffset'),
      parametersOffset: offsetParam(params, 'parametersOffset'),
      beforeOffset: offsetParam(params, 'beforeOffset'),
      ...(params['beforeSort'] === undefined ? {} : { beforeSort: params['beforeSort'] }),
      ...(params['beforeClient'] === undefined ? {} : { beforeClient: params['beforeClient'] }),
    }).catch(asApiError),
    getLatency(session, query).catch(asApiError),
    getVersions(session, query).catch(() => undefined),
    getFilterOptions(session, { from: range.from, ...(params['serverId'] === undefined ? {} : { serverId: params['serverId'] }) }).catch(
      () => undefined,
    ),
  ]);

  const carried = { serverId: params['serverId'], range: params['range'] };

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-10">
      <PageHeader
        title={toolName}
        subtitle={range.label}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/settings${withParams(
                { alertServer: params['serverId'], alertTool: toolName },
                {},
              )}#notifications`}
              className="text-sm text-ink-muted underline underline-offset-2 hover:text-ink"
            >
              Get notified about this tool
            </Link>
            <RangePicker current={range.key} params={params} />
          </div>
        }
      />

      {summary instanceof ApiError ? (
        <CannotReachApi reason={summary.message} status={summary.status} />
      ) : (
        <>
          <SummaryCards
            summary={summary}
            {...(previous === undefined ? {} : { previous })}
            comparedTo={range.previousLabel}
          />

          <Card>
            <CardHeader title="Calls over time" />
            {timeseries instanceof ApiError ? (
              <p className="text-sm text-ink-muted">{timeseries.message}</p>
            ) : (
              <CallsChart
                points={timeseries.points}
                bucketSeconds={timeseries.bucketSeconds}
                versions={versions?.versions ?? []}
                definitionChanges={details instanceof ApiError ? [] : details.definitionChanges}
              />
            )}
          </Card>

          {versions === undefined || versions.versions.length === 0 ? null : (
            <Card>
              <CardHeader title="Versions" hint="This tool's calls by the server version that answered them" />
              <VersionsTable data={versions} carried={carried} />
            </Card>
          )}

          <Card>
            <CardHeader title="Response times" hint="Calls by how long they took" />
            {latency instanceof ApiError ? (
              <p className="text-sm text-ink-muted">{latency.message}</p>
            ) : (
              <LatencyChart buckets={latency.buckets} totalCalls={latency.totalCalls} />
            )}
          </Card>

          {details instanceof ApiError || details.repeats.repeated === 0 ? null : (
            <Card>
              <CardHeader title="Repeated calls" hint="Same arguments as the call before, in the same session" />
              <p className="text-sm text-ink">
                <span className="text-2xl font-semibold tabular-nums">{formatCount(details.repeats.repeated)}</span>{' '}
                <span className="text-ink-muted">
                  of {formatCount(details.repeats.of)} calls (
                  {Math.round((100 * details.repeats.repeated) / Math.max(details.repeats.of, 1))}%)
                </span>
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                An agent sending the same call again usually did not get what it needed from the answer: an error it
                could not act on, or a result it did not recognise as complete.{' '}
                <Link
                  href={`/sessions${withParams(carried, {})}`}
                  className="underline underline-offset-2"
                >
                  Sessions
                </Link>{' '}
                show where it happened.
              </p>
            </Card>
          )}

          {details instanceof ApiError || (details.before.problems === 0 && details.beforeClient === null) ? null : (
            <Card id="before">
              <CardHeader
                title="Right before it went wrong"
                hint={`Before ${formatCount(details.before.problems)} repeated or failed calls, in their sessions`}
              />
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <ParamSelect
                  params={params}
                  name="beforeClient"
                  label="Client"
                  anyLabel="All clients"
                  choices={(options?.clients ?? []).map((client) => ({ value: client, label: clientLabel(client) }))}
                  resets={['beforeOffset']}
                  hash="#before"
                />
                <ParamSelect
                  params={params}
                  name="beforeSort"
                  label="Order"
                  choices={[
                    { value: 'all', label: 'Most repeated or failed' },
                    { value: 'repeats', label: 'Most repeated' },
                    { value: 'failures', label: 'Most failed' },
                  ]}
                  resets={['beforeOffset']}
                  hash="#before"
                />
              </div>
              {details.before.problems === 0 ? (
                <p className="text-sm text-ink-muted">Nothing repeated or failed for this client in this window.</p>
              ) : (
                <Predecessors toolName={toolName} before={details.before} />
              )}
              <OffsetPager
                params={params}
                name="beforeOffset"
                offset={details.beforeOffset}
                limit={20}
                hasMore={details.before.hasMore}
                hash="#before"
              />
            </Card>
          )}

          {details instanceof ApiError || details.responseSizes === null ? null : (
            <Card>
              <CardHeader
                title="Response size"
                hint={`Over ${formatCount(details.responseSizes.measured)} answers; what the client's context takes in`}
              />
              <Facts
                rows={[
                  ['Typical (median)', formatBytes(details.responseSizes.medianBytes)],
                  ['Large (95th percentile)', formatBytes(details.responseSizes.p95Bytes)],
                  ['Largest', formatBytes(details.responseSizes.maxBytes)],
                ]}
              />
            </Card>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card id="failures">
              <CardHeader
                title="How it fails"
                hint={
                  summary.failedCalls === 0
                    ? undefined
                    : `${formatCount(summary.failedCalls)} failed`
                }
              />
              {details instanceof ApiError ? (
                <p className="text-sm text-ink-muted">{details.message}</p>
              ) : (
                <Failures
                  details={details}
                  params={params}
                  errorsHref={`/errors${withParams(carried, { toolName })}`}
                />
              )}
            </Card>

            <Card>
              <CardHeader title="Called from" />
              <Clients summary={summary} />
            </Card>
          </div>

          {details instanceof ApiError || details.refusedArguments.refused === 0 ? null : (
            <Card id="invalid-arguments">
              <CardHeader
                title="Which arguments were invalid"
                hint={`${formatCount(details.refusedArguments.refused)} calls refused before the tool ran`}
              />
              <InvalidArguments refused={details.refusedArguments} />
            </Card>
          )}

          <Card id="parameters">
            <CardHeader
              title="Parameters agents send"
              hint={
                details instanceof ApiError || !details.sampled
                  ? 'Names and types only'
                  : 'From the newest 100,000 calls'
              }
            />
            {details instanceof ApiError ? (
              <p className="text-sm text-ink-muted">{details.message}</p>
            ) : (
              <>
                <Parameters details={details} />
                <OffsetPager
                  params={params}
                  name="parametersOffset"
                  offset={details.parametersOffset}
                  limit={50}
                  hasMore={details.parametersHaveMore}
                  hash="#parameters"
                />
              </>
            )}
          </Card>
        </>
      )}
    </main>
  );
}

function Predecessors({ toolName, before }: { toolName: string; before: ToolDetails['before'] }) {
  return (
    <>
      <p className="mb-3 text-sm text-ink-muted">
        What the agent called just before <span className="font-mono text-xs">{toolName}</span> repeated itself or
        failed. One call standing out usually did not do what the agent expected: a click that did not land, a
        search that came back empty.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-muted">
            <th scope="col" className="pb-2 font-medium">
              Called before
            </th>
            <th scope="col" className="pb-2 font-medium">
              Client
            </th>
            <th scope="col" className="pb-2 pr-4 text-right font-medium">
              Repeated
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Failed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {before.predecessors.map((row) => (
            <tr key={`${row.beforeKind ?? ''}:${row.before ?? ''}:${row.clientType}`}>
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink [overflow-wrap:anywhere]">
                {row.before === null ? (
                  <span className="text-ink-muted">Nothing before it</span>
                ) : (
                  <>
                    {kindLabel(row.beforeKind) === null ? null : (
                      <span className="text-ink-muted">{kindLabel(row.beforeKind)} </span>
                    )}
                    <span className="font-mono text-xs">{row.before}</span>
                  </>
                )}
              </th>
              <td className="py-2 pr-4 text-ink-muted">{clientLabel(row.clientType)}</td>
              <td className="py-2 pr-4 text-right tabular-nums text-ink">{formatCount(row.repeats)}</td>
              <td className="py-2 text-right tabular-nums text-ink">{formatCount(row.failures)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function InvalidArguments({ refused }: { refused: ToolDetails['refusedArguments'] }) {
  return (
    <>
      {refused.arguments.length === 0 ? null : (
        <Facts
          rows={refused.arguments.map(({ name, calls }) => [
            name,
            `${formatCount(calls)} ${calls === 1 ? 'call' : 'calls'}`,
          ])}
        />
      )}
      <p className="mt-3 text-sm text-ink-muted">
        {refused.arguments.length === 0
          ? 'None of these refusals named an argument. '
          : 'The argument agents get wrong most is usually one whose description leaves room for the wrong shape. '}
        {refused.unnamed === 0
          ? null
          : `${formatCount(refused.unnamed)} ${refused.unnamed === 1 ? 'refusal' : 'refusals'} named none: refused for a rule the SDK does not check, such as a pattern, or sent by an SDK before 0.5.0.`}
      </p>
    </>
  );
}

function Failures({
  details,
  params,
  errorsHref,
}: {
  details: ToolDetails;
  params: Params;
  errorsHref: string;
}) {
  if (details.failures.length === 0) {
    return <p className="text-sm text-ink-muted">Nothing failed in this window.</p>;
  }

  return (
    <>
      <dl className="space-y-2 text-sm">
        {details.failures.map((share) => (
          <div key={share.errorSource} className="flex justify-between gap-4">
            <dt className={share.errorSource === 'exception' ? 'text-status-critical' : 'text-ink'}>
              {errorSourceInfo(share.errorSource).label}
            </dt>
            <dd className="tabular-nums text-ink">{formatCount(share.calls)}</dd>
          </div>
        ))}
      </dl>

      {details.messages.length === 0 ? null : (
        <>
          <h3 className="mt-5 mb-2 text-xs font-medium text-ink-muted">What it said, most often</h3>
          <ul className="divide-y divide-border text-sm">
            {details.messages.map((message) => (
              <li key={`${message.errorSource ?? ''}:${message.message}`} className="py-2">
                <p className="break-words text-ink">{message.message}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {formatCount(message.calls)} time{message.calls === 1 ? '' : 's'},{' '}
                  {message.errorSource === null
                    ? 'failed'
                    : errorSourceInfo(message.errorSource).label.toLowerCase()}
                  , last <LocalTime iso={message.lastAt} />
                </p>
              </li>
            ))}
          </ul>
          <OffsetPager
            params={params}
            name="messagesOffset"
            offset={details.messagesOffset}
            limit={10}
            hasMore={details.messagesHaveMore}
            hash="#failures"
          />
        </>
      )}

      <Link
        href={errorsHref}
        className="mt-4 inline-block text-sm text-ink underline underline-offset-2"
      >
        Every failed call
      </Link>
    </>
  );
}

function Clients({ summary }: { summary: Summary }) {
  if (summary.clients.length === 0) {
    return <p className="text-sm text-ink-muted">Not called in this window.</p>;
  }

  return (
    <dl className="space-y-2 text-sm">
      {summary.clients.map((client) => (
        <div key={client.clientType} className="flex justify-between gap-4">
          <dt className="text-ink">{clientLabel(client.clientType)}</dt>
          <dd className="tabular-nums text-ink-muted">
            {formatCount(client.calls)}{' '}
            <span className="text-xs">
              ({Math.round((client.calls / Math.max(summary.totalCalls, 1)) * 100)}%)
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Parameters({ details }: { details: ToolDetails }) {
  if (details.callsWithParameters === 0) {
    return (
      <p className="text-sm text-ink-muted">
        Not recorded for this tool. Turn on{' '}
        <code className="font-mono text-xs">captureParameterNames</code> in the SDK to see which
        parameter names agents send and as what types. Values are never recorded.
      </p>
    );
  }

  return (
    <>
      <p className="mb-3 text-sm text-ink-muted">
        A name the schema does not have, or one that arrives as more than one type, is usually a
        description the agent is misreading.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-muted">
            <th scope="col" className="pb-2 font-medium">
              Name
            </th>
            <th scope="col" className="pb-2 font-medium">
              Sent as
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              In calls
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {details.parameters.map((parameter) => (
            <tr key={parameter.name}>
              <th
                scope="row"
                className="py-2 pr-4 text-left font-mono text-xs font-normal text-ink"
              >
                {parameter.name}
              </th>
              <td
                className={`py-2 pr-4 text-xs ${
                  parameter.types.length > 1 ? 'text-status-warning-ink' : 'text-ink-muted'
                }`}
              >
                {parameter.types.join(', ')}
              </td>
              <td className="py-2 text-right tabular-nums text-ink-muted">
                {Math.round((parameter.calls / details.callsWithParameters) * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
