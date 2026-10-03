import { DownloadLinks } from '@/components/download-links';
import { CallList } from '@/components/call-list';
import { FilterBar } from '@/components/filter-bar';
import { CannotReachApi, NothingConnectedYet } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { CursorPager } from '@/components/pager';
import { RangePicker } from '@/components/range-picker';
import { Card, CardHeader } from '@/components/ui/card';
import { ApiError, getFailures, getFilterOptions } from '@/lib/api';
import { resolveRange } from '@/lib/range';
import { currentSession } from '@/lib/session';

/**
 * Keeps a refusal as a value to render, and lets anything else through.
 */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  throw error;
}

export default async function ErrorsPage({
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

  const [failures, options] = await Promise.all([
    getFailures(session, {
      from: range.from,
      ...carried(['serverId', 'toolName', 'clientType', 'errorSource', 'before']),
    }).catch(asApiError),
    getFilterOptions(session, { from: range.from, ...carried(['serverId']) }).catch(asApiError),
  ]);

  // Every failure in the window, where the list stops at the newest few dozen.
  const exportLinks = [
    {
      text: 'CSV',
      kind: 'calls' as const,
      params: {
        from: range.from,
        ...carried(['serverId', 'toolName', 'clientType', 'errorSource']),
        failedOnly: 'true',
      },
    },
  ];

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        title="Errors"
        subtitle={range.label}
        actions={<RangePicker current={range.key} params={params} />}
      />

      {failures instanceof ApiError ? (
        failures.status === 400 ? (
          <NothingConnectedYet />
        ) : (
          <CannotReachApi reason={failures.message} status={failures.status} />
        )
      ) : (
        <>
          {options instanceof ApiError ? null : (
            <FilterBar
              params={params}
              tools={options.tools}
              clients={options.clients}
              showErrorSource
              actions={<DownloadLinks label="Export" links={exportLinks} />}
            />
          )}

          <Card>
            <CardHeader
              title="Failed calls"
              // The list goes back as far as the window does, a page at a
              // time, so the overview's count and this list always agree.
              hint={params['before'] === undefined ? 'Newest first' : 'Older failures'}
            />
            <CallList
              calls={failures.failures}
              empty="Nothing failed in this window. That is the answer you want."
              carried={carried(['serverId', 'range'])}
            />
            <CursorPager
              params={params}
              name="before"
              cursor={failures.nextCursor}
              onwardLabel="Older failures"
              startLabel="Back to the newest"
            />

            {failures.failures.length === 0 ? null : (
              <div className="mt-4">
                {/* Every failure in the window, where the list above stops at
                    the newest few dozen. */}
                <DownloadLinks label="Every failed call in this window and filter" links={exportLinks} />
              </div>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
