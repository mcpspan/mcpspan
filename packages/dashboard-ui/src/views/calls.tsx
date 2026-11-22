import Link from 'next/link';

import { CallList } from '../components/call-list';
import { ChoiceLinks } from '../components/choice-links';
import { DownloadLinks } from '../components/download-links';
import { FilterBar } from '../components/filter-bar';
import { CannotReachApi, NothingConnectedYet } from '../components/notice';
import { PageHeader } from '../components/page-header';
import { CursorPager } from '../components/pager';
import { RangeLabel, RangePicker } from '../components/range-picker';
import { Card, CardHeader } from '../components/ui/card';
import { ApiError, getCalls, getFilterOptions } from '../lib/api';
import { withParams } from '../lib/query';
import { resolveRange } from '../lib/range';
import { currentSession } from '../lib/session';

/** Keeps a refusal as a value to render, and lets anything else through. */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  throw error;
}

/**
 * Every call, one by one, newest first: tools, resources and prompts,
 * successful or not.
 *
 * The overview counts; this is where somebody goes to see the calls behind a
 * count, and from any one of them to everything recorded about it.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const range = resolveRange(params['range']);
  const session = await currentSession();

  const carried = (keys: string[]): Record<string, string> => {
    const picked: Record<string, string> = {};
    for (const key of keys) {
      const value = params[key];
      if (value !== undefined) picked[key] = value;
    }
    return picked;
  };

  const [calls, options] = await Promise.all([
    getCalls(session, {
      ...range.window,
      ...carried([
        'serverId',
        'toolName',
        'clientType',
        'outcome',
        'kind',
        'serverVersion',
        'clientName',
        'clientVersion',
        'before',
      ]),
    }).catch(asApiError),
    getFilterOptions(session, { ...range.window, ...carried(['serverId']) }).catch(asApiError),
  ]);

  const exportLinks = [
    {
      text: 'CSV',
      kind: 'calls' as const,
      params: {
        ...range.window,
        format: 'csv',
        ...carried(['serverId', 'toolName', 'clientType']),
        ...(params['outcome'] === 'failed' ? { failedOnly: 'true' } : {}),
      },
    },
  ];

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        title="Calls"
        subtitle={<RangeLabel range={range} />}
        actions={<RangePicker current={range.key} params={params} />}
      />

      {calls instanceof ApiError ? (
        calls.status === 400 ? (
          <NothingConnectedYet />
        ) : (
          <CannotReachApi reason={calls.message} status={calls.status} />
        )
      ) : (
        <>
          {options instanceof ApiError ? null : (
            <FilterBar
              params={params}
              tools={options.tools}
              clients={options.clients}
              actions={<DownloadLinks label="Export" links={exportLinks} />}
            />
          )}

          <VersionNotice params={params} />

          <div className="mb-4 flex flex-wrap gap-2">
            <ChoiceLinks
              label="Outcome"
              name="outcome"
              params={params}
              choices={[
                { value: undefined, text: 'Every outcome' },
                { value: 'succeeded', text: 'Succeeded' },
                { value: 'failed', text: 'Failed' },
              ]}
            />
            {/* A tool filter already means tools, so the kinds would only offer an empty list. */}
            {params['toolName'] === undefined ? (
              <ChoiceLinks
                label="Kind"
                name="kind"
                params={params}
                choices={[
                  { value: undefined, text: 'Every kind' },
                  { value: 'tool', text: 'Tools' },
                  { value: 'resource', text: 'Resources' },
                  { value: 'prompt', text: 'Prompts' },
                ]}
              />
            ) : null}
          </div>

          <Card>
            <CardHeader
              title="Calls"
              hint={params['before'] === undefined ? 'Newest first, select one for its details' : 'Older calls'}
            />
            <CallList
              calls={calls.calls}
              empty="No calls match in this window."
              carried={carried(['serverId', 'range'])}
            />
            <CursorPager
              params={params}
              name="before"
              cursor={calls.nextCursor}
              onwardLabel="Older calls"
              startLabel="Back to the newest"
            />
          </Card>

          {calls.calls.length === 0 ? null : (
            <div className="mt-6">
              <DownloadLinks label="Every call in this window and filter" links={exportLinks} />
            </div>
          )}
        </>
      )}
    </main>
  );
}

/**
 * Says when the list is narrowed to one version, of the server or of a client,
 * which the filters above do not show: those links come from the versions
 * table and the clients card. With the way back to every version.
 */
function VersionNotice({ params }: { params: Record<string, string | undefined> }) {
  const client =
    params['clientName'] !== undefined && params['clientVersion'] !== undefined
      ? `${params['clientName']} ${params['clientVersion']}`
      : undefined;
  const server = params['serverVersion'];
  if (client === undefined && server === undefined) return null;

  const parts = [
    ...(client === undefined ? [] : [`from ${client}`]),
    ...(server === undefined ? [] : [`answered by server version ${server}`]),
  ];

  return (
    <p className="mb-4 text-sm text-ink-muted">
      Only calls {parts.join(', ')}.{' '}
      <Link
        href={`/calls${withParams(params, { clientName: undefined, clientVersion: undefined, serverVersion: undefined, before: undefined })}`}
        className="text-ink underline underline-offset-2"
      >
        Every version
      </Link>
    </p>
  );
}
