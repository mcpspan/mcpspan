import { CallsChart } from '@/components/calls-chart';
import { ClientDonut } from '@/components/client-donut';
import { ClientsOverTime } from '@/components/clients-over-time';
import { DownloadLinks } from '@/components/download-links';
import { FilterBar } from '@/components/filter-bar';
import { LatencyChart } from '@/components/latency-chart';
import { CannotReachApi, NothingConnectedYet } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { OffsetPager } from '@/components/pager';
import { RangePicker } from '@/components/range-picker';
import { SummaryCards } from '@/components/summary-cards';
import { ToolsTable } from '@/components/tools-table';
import { hasResourcesOrPrompts, ResourcesAndPrompts } from '@/components/resources-and-prompts';
import { UnknownTools } from '@/components/unknown-tools';
import { VersionsTable } from '@/components/versions-table';
import { Card, CardHeader } from '@/components/ui/card';
import {
  ApiError,
  getClients,
  getFilterOptions,
  getLatency,
  getSummary,
  getTimeseries,
  getTools,
  getResourcesAndPrompts,
  getUnknownTools,
  getVersions,
} from '@/lib/api';
import { formatCount } from '@/lib/format';
import { offsetParam } from '@/lib/query';
import { resolveRange } from '@/lib/range';
import { currentSession } from '@/lib/session';

/**
 * Keeps a refusal as a value to render, and lets anything else through.
 *
 * An API that said no is a state this page knows how to show. A failure it has
 * no answer for should reach the error boundary rather than be flattened into
 * the same message.
 */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  throw error;
}

/** Copies only the parameters the API knows what to do with. */
function pick(
  params: Record<string, string | undefined>,
  keys: string[],
): Record<string, string> {
  const picked: Record<string, string> = {};

  for (const key of keys) {
    const value = params[key];
    if (value !== undefined) picked[key] = value;
  }

  return picked;
}

/** Names a bucket width in words, for the caption above the chart. */
function describeBucket(seconds: number): string {
  if (seconds >= 24 * 3_600) return `${seconds / (24 * 3_600)}-day steps`;
  if (seconds >= 3_600) return `${seconds / 3_600}-hour steps`;

  return `${seconds / 60}-minute steps`;
}

/**
 * Rows on one page of the tool table. It sits beside the chart, and a longer
 * page stretched the chart's card into a column of empty space.
 */
const TOOLS_PER_PAGE = 10;

/** Names on one page of the tools that do not exist. */
const UNKNOWN_PER_PAGE = 10;

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const range = resolveRange(params['range']);
  const session = await currentSession();

  // Everything the address says, passed straight through. The API and the
  // address use the same names for these, so there is nothing to translate and
  // nothing to forget to translate.
  const query = {
    from: range.from,
    ...pick(params, ['serverId', 'toolName', 'clientType', 'sort']),
  };

  // All at once. They answer about the same window and none depends on
  // another, so asking in turn would treble the time somebody spends looking
  // at an empty page for no reason at all.
  // The window and server alone, for the lists that must not narrow with the
  // filters they offer or that do not describe any one tool.
  const serverWide = { from: range.from, ...pick(params, ['serverId']) };

  // Every call the page is about, tools, resources and prompts alike.
  const exportLinks = [
    { text: 'CSV', kind: 'calls' as const, params: { ...query, format: 'csv' } },
    { text: 'NDJSON', kind: 'calls' as const, params: { ...query, format: 'ndjson' } },
  ];

  const [summary, previous, timeseries, tools, options, unknownTools, latency, clients, primitives, versions] =
    await Promise.all([
      getSummary(session, query).catch(asApiError),
      // The same question about the window before, for the cards to compare
      // against. Losing it loses the comparison, not the page.
      getSummary(session, { ...query, ...range.previous }).catch(() => undefined),
      getTimeseries(session, query).catch(asApiError),
      getTools(session, {
        ...query,
        offset: offsetParam(params, 'toolsOffset'),
        limit: TOOLS_PER_PAGE,
      }).catch(asApiError),
      getFilterOptions(session, serverWide).catch(asApiError),
      // Not narrowed by tool or client: none of these is a tool, and the list is
      // short enough to read whole.
      getUnknownTools(session, {
        ...serverWide,
        offset: offsetParam(params, 'unknownOffset'),
        limit: UNKNOWN_PER_PAGE,
      }).catch(asApiError),
      getLatency(session, query).catch(asApiError),
      getClients(session, { ...query, offset: offsetParam(params, 'clientsOffset') }).catch(
        asApiError,
      ),
      // Narrowed by client only: a tool filter names nothing here. Losing it
      // loses the card, not the page.
      getResourcesAndPrompts(session, {
        ...serverWide,
        ...pick(params, ['clientType']),
      }).catch(() => undefined),
      // Losing it loses the version marks and card, not the page.
      getVersions(session, query).catch(() => undefined),
    ]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        title="Overview"
        subtitle={range.label}
        actions={<RangePicker current={range.key} params={params} />}
      />

      {summary instanceof ApiError ? (
        // A refusal because nothing has reported yet is not a failure, it is
        // the first thing a new installation says.
        summary.status === 400 ? (
          <NothingConnectedYet />
        ) : (
          <CannotReachApi reason={summary.message} status={summary.status} />
        )
      ) : (
        <>
          {options instanceof ApiError ? null : (
            <FilterBar
              params={params}
              tools={options.tools}
              clients={options.clients}
              actions={<DownloadLinks label="Export" links={exportLinks} />}
              matching={`${formatCount(summary.totalCalls)} tool call${summary.totalCalls === 1 ? '' : 's'}`}
            />
          )}

          <div className="mb-6">
            <SummaryCards
              summary={summary}
              {...(previous === undefined ? {} : { previous })}
              comparedTo={range.previousLabel}
            />
          </div>

          {summary.totalCalls === 0 ? (
            // A brand new account has a server and a key but nothing has used
            // them yet, so the numbers are all zero and read as a broken
            // setup. The instructions sit under the cards rather than instead
            // of them, because a quiet window on a busy server looks the same
            // from here and that person should still see their range picker.
            <div className="mb-6">
              <NothingConnectedYet />
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              {timeseries instanceof ApiError ? (
                <>
                  <CardHeader title="Calls over time" />
                  <p className="text-sm text-ink-muted">{timeseries.message}</p>
                </>
              ) : (
                <>
                  <CardHeader
                    title="Calls over time"
                    hint={describeBucket(timeseries.bucketSeconds)}
                  />
                  <CallsChart
                    points={timeseries.points}
                    bucketSeconds={timeseries.bucketSeconds}
                    versions={versions?.versions ?? []}
                  />
                </>
              )}
            </Card>

            <Card id="tools">
              <CardHeader title="Tools" hint="By calls" />
              {tools instanceof ApiError ? (
                <p className="text-sm text-ink-muted">{tools.message}</p>
              ) : (
                <>
                  <ToolsTable tools={tools.tools} params={params} sort={tools.sort} />
                  <OffsetPager
                    params={params}
                    name="toolsOffset"
                    offset={tools.offset}
                    limit={tools.limit}
                    hasMore={tools.hasMore}
                    total={tools.total}
                    hash="#tools"
                  />
                  <div className="mt-4">
                    <DownloadLinks
                      label="This table"
                      links={[{ text: 'CSV', kind: 'tools', params: query }]}
                    />
                  </div>
                </>
              )}
            </Card>
          </div>

          {versions === undefined || versions.versions.length === 0 ? null : (
            <Card className="mt-6" id="versions">
              <CardHeader title="Versions" hint="Tool calls by the server version that answered them" />
              <VersionsTable data={versions} carried={pick(params, ['serverId', 'range'])} />
            </Card>
          )}

          <Card className="mt-6">
            <CardHeader title="Response times" hint="Calls by how long they took" />
            {latency instanceof ApiError ? (
              <p className="text-sm text-ink-muted">{latency.message}</p>
            ) : (
              <LatencyChart buckets={latency.buckets} totalCalls={latency.totalCalls} />
            )}
          </Card>

          <Card className="mt-6" id="clients">
            <CardHeader title="Clients" hint="Shares of the window, then each client over time" />
            {clients instanceof ApiError ? (
              <p className="text-sm text-ink-muted">{clients.message}</p>
            ) : (
              <>
                <div className="mb-6 border-b border-border pb-6">
                  <ClientDonut clients={summary.clients} total={summary.totalCalls} />
                </div>
                <p className="mb-1 text-xs text-ink-muted">Over time, each row scaled to its own busiest hour</p>
                <ClientsOverTime data={clients} totalCalls={summary.totalCalls} />
                <OffsetPager
                  params={params}
                  name="clientsOffset"
                  offset={clients.offset}
                  limit={clients.limit}
                  hasMore={clients.hasMore}
                  total={clients.total}
                  hash="#clients"
                />
              </>
            )}
          </Card>

          {primitives === undefined || !hasResourcesOrPrompts(primitives) ? null : (
            <div className="mt-6">
              <ResourcesAndPrompts data={primitives} />
            </div>
          )}

          {unknownTools instanceof ApiError ? null : (
            <div className="mt-6">
              <UnknownTools
                tools={unknownTools.tools}
                resources={primitives?.unknownResources ?? []}
                prompts={primitives?.unknownPrompts ?? []}
                params={params}
                pager={
                  <OffsetPager
                    params={params}
                    name="unknownOffset"
                    offset={unknownTools.offset}
                    limit={unknownTools.limit}
                    hasMore={unknownTools.hasMore}
                    hash="#unknown-tools"
                  />
                }
              />
            </div>
          )}

          {/* Again at the end, where somebody who has read the whole page arrives. */}
          <div className="mt-6">
            <DownloadLinks label="Every call in this window and filter" links={exportLinks} />
          </div>
        </>
      )}
    </main>
  );
}
