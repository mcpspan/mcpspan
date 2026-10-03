import { CallList } from '@/components/call-list';
import { ChoiceLinks } from '@/components/choice-links';
import { DownloadLinks } from '@/components/download-links';
import { FilterBar } from '@/components/filter-bar';
import { CannotReachApi, NothingConnectedYet } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { CursorPager } from '@/components/pager';
import { RangePicker } from '@/components/range-picker';
import { Card, CardHeader } from '@/components/ui/card';
import { ApiError, getCalls, getFilterOptions } from '@/lib/api';
import { resolveRange } from '@/lib/range';
import { currentSession } from '@/lib/session';

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
      from: range.from,
      ...carried(['serverId', 'toolName', 'clientType', 'outcome', 'kind', 'serverVersion', 'before']),
    }).catch(asApiError),
    getFilterOptions(session, { from: range.from, ...carried(['serverId']) }).catch(asApiError),
  ]);

  const exportLinks = [
    {
      text: 'CSV',
      kind: 'calls' as const,
      params: {
        from: range.from,
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
        subtitle={range.label}
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
