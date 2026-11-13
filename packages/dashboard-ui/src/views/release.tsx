import Link from 'next/link';

import { BreakableName } from '../components/breakable-name';
import { OutcomeBar, OUTCOMES } from '../components/lost-agents';
import { LocalTime } from '../components/local-time';
import { CannotReachApi } from '../components/notice';
import { PageHeader } from '../components/page-header';
import { duration, VerdictBadge, verdictSentence } from '../components/release-verdict';
import { ParamSelect } from '../components/param-select';
import { Card, CardHeader } from '../components/ui/card';
import {
  ApiError,
  getReleaseReport,
  getVersions,
  type ReleaseReport,
  type ReleaseTool,
  type SessionOutcomes,
} from '../lib/api';
import { clientLabel, errorSourceInfo, formatCount, formatRate } from '../lib/format';
import { type Params, withParams } from '../lib/query';
import { customRangeValue } from '../lib/range';
import { currentSession } from '../lib/session';

/** As far back as a version is offered in the picker: raw retention, at most. */
const PICKER_DAYS = 90;

/**
 * Did a release make things worse: one server version against the one before
 * it, over periods as long as each other either side of its first call.
 *
 * The versions table says how each version did; this says what changed
 * between two of them, which is the question somebody who just shipped has:
 * which tools fail more, which kinds of failure are new, and whether agents
 * now get stuck where they did not.
 */
export default async function ReleasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const session = await currentSession();
  const server = params['serverId'] === undefined ? {} : { serverId: params['serverId'] };

  const [report, versions] = await Promise.all([
    getReleaseReport(session, {
      ...server,
      ...(params['version'] === undefined ? {} : { version: params['version'] }),
      ...(params['clientType'] === undefined ? {} : { clientType: params['clientType'] }),
    }).catch((error: unknown) => {
      if (error instanceof ApiError) return error;
      throw error;
    }),
    getVersions(session, {
      ...server,
      from: new Date(Date.now() - PICKER_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    }).catch(() => undefined),
  ]);

  const versionChoices = (versions?.versions ?? []).map((version) => ({ value: version.version, label: version.version }));

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-10">
      <PageHeader
        title={report instanceof ApiError ? 'Release' : `Release ${report.version}`}
        subtitle={report instanceof ApiError ? undefined : <Subtitle report={report} />}
        actions={
          versionChoices.length === 0 ? undefined : (
            <div className="flex flex-wrap items-center gap-3">
              <ParamSelect
                params={params}
                name="version"
                label="Version"
                choices={versionChoices}
              />
              {report instanceof ApiError || report.clients.length < 2 ? null : (
                <ParamSelect
                  params={params}
                  name="clientType"
                  label="Client"
                  anyLabel="All clients"
                  choices={report.clients.map((client) => ({
                    value: client.clientType,
                    label: clientLabel(client.clientType),
                  }))}
                />
              )}
            </div>
          )
        }
      />

      {report instanceof ApiError ? (
        report.status === 404 ? (
          <Card>
            <p className="text-sm text-ink-muted">
              No version to report on yet. A report starts once the server says which version it is: most SDKs
              send it with every call, read from the server&apos;s own name and version.
            </p>
          </Card>
        ) : (
          <CannotReachApi reason={report.message} status={report.status} />
        )
      ) : (
        <Report report={report} params={params} />
      )}
    </main>
  );
}

function Subtitle({ report }: { report: ReleaseReport }) {
  return (
    <>
      {report.previous === null ? 'The first version seen' : `Against ${report.previous}`}, first call{' '}
      <LocalTime iso={report.releasedAt} />
    </>
  );
}

function Report({ report, params }: { report: ReleaseReport; params: Params }) {
  const carried = { serverId: params['serverId'] };
  const afterRange = customRangeValue(new Date(report.after.from), new Date(report.after.to));
  const span = new Date(report.after.to).getTime() - new Date(report.after.from).getTime();

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <VerdictBadge verdict={report.verdict} />
          <p className="text-sm text-ink">{verdictSentence(report)}</p>
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          {report.previous === null
            ? `${report.version}'s calls in the ${lengthText(span)} it ran.`
            : `${report.version}'s calls in the ${lengthText(span)} after its first one, against ${report.previous}'s in the ${lengthText(span)} before it.`}{' '}
          Worse means errors rose by more than a point and more than chance, or the slowest calls (p95) slowed by a
          quarter.
        </p>
        {report.otherVersionCalls === 0 ? null : (
          <p className="mt-2 text-xs text-ink-muted">
            {formatCount(report.otherVersionCalls)} call{report.otherVersionCalls === 1 ? '' : 's'} after the
            release came from another version, left out of the numbers: some of the server may not be upgraded.
          </p>
        )}
        {report.clientsShifted ? (
          <p className="mt-2 text-xs text-status-warning">
            The clients changed too: a different mix of agents can move these numbers as much as the release.
          </p>
        ) : null}
      </Card>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Compared label="Calls" before={report.overall.before?.calls} after={report.overall.after.calls} format={formatCount} />
        <Compared
          label="Errors"
          before={report.overall.before?.errorRate}
          after={report.overall.after.errorRate}
          format={(rate) => `${formatRate(rate)}%`}
          worseWhenHigher
        />
        <Compared
          label="Median"
          before={report.overall.before?.durationMs.p50}
          after={report.overall.after.durationMs.p50}
          format={duration}
          worseWhenHigher
        />
        <Compared
          label="p95"
          before={report.overall.before?.durationMs.p95}
          after={report.overall.after.durationMs.p95}
          format={duration}
          worseWhenHigher
        />
      </div>

      {report.previous === null ? null : (
        <Card>
          <CardHeader title="Tools" hint="Worst change first" />
          {report.tools.length === 0 ? (
            <p className="text-sm text-ink-muted">No tool calls on either side.</p>
          ) : (
            <ToolsTable tools={report.tools} carried={carried} />
          )}
        </Card>
      )}

      {report.previous === null ? null : (
        <Card>
          <CardHeader title="New kinds of failure" hint={`Not seen from ${report.previous}`} />
          {report.newFailures.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing failed in a way it did not fail before.</p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {report.newFailures.map((failure) => (
                <li
                  key={`${failure.toolName}\u0000${failure.errorSource ?? ''}\u0000${failure.errorType ?? ''}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5"
                >
                  <span className="min-w-0 break-words">
                    <Link
                      href={`/calls${withParams(carried, {
                        range: afterRange,
                        serverVersion: report.version,
                        toolName: failure.toolName,
                        outcome: 'failed',
                        clientType: params['clientType'],
                      })}`}
                      className="font-mono text-xs text-ink underline-offset-2 hover:underline"
                    >
                      <BreakableName name={failure.toolName} />
                    </Link>{' '}
                    <span className="text-ink-muted">
                      {failure.errorSource === null ? 'Failed' : errorSourceInfo(failure.errorSource).label}
                      {failure.errorType === null ? null : (
                        <>
                          {' · '}
                          <span className="font-mono text-xs">{failure.errorType}</span>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="text-xs text-ink-muted">
                    <span className="text-ink tabular-nums">{formatCount(failure.calls)}×</span>, first{' '}
                    <LocalTime iso={failure.firstAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <CardHeader title="What came of sessions" hint="Each counted once, by the worst that happened in it" />
        <div className="space-y-6">
          {report.agents.before === null || report.previous === null ? null : (
            <Sessions label={`Before, ${report.previous}`} outcomes={report.agents.before} />
          )}
          <Sessions label={`After, ${report.version}`} outcomes={report.agents.after} />
        </div>
      </Card>

      {report.previous === null || report.clients.length === 0 ? null : (
        <Card>
          <CardHeader title="Clients" hint="Share of calls either side" />
          <ul className="divide-y divide-border text-sm">
            {report.clients.map((client) => (
              <li key={client.clientType} className="flex items-baseline justify-between gap-4 py-2">
                <span>{clientLabel(client.clientType)}</span>
                <span className="text-xs text-ink-muted tabular-nums">
                  {Math.round(client.before * 100)}% → <span className="text-ink">{Math.round(client.after * 100)}%</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function Compared({
  label,
  before,
  after,
  format,
  worseWhenHigher = false,
}: {
  label: string;
  before: number | null | undefined;
  after: number | null;
  format: (value: number) => string;
  worseWhenHigher?: boolean;
}) {
  const rose = before !== undefined && before !== null && after !== null && after > before;
  const fell = before !== undefined && before !== null && after !== null && after < before;

  return (
    <div className="rounded-xl border border-border bg-raised p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{after === null ? '-' : format(after)}</p>
      <p className="text-xs text-ink-muted tabular-nums">
        {before === undefined ? (
          'Nothing to compare'
        ) : (
          <>
            was {before === null ? '-' : format(before)}
            {worseWhenHigher && rose ? <span className="text-status-critical"> ↑</span> : null}
            {worseWhenHigher && fell ? <span className="text-status-good"> ↓</span> : null}
          </>
        )}
      </p>
    </div>
  );
}

function ToolsTable({ tools, carried }: { tools: ReleaseTool[]; carried: Params }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-ink-muted">
            <th scope="col" className="pb-2 text-left font-medium">
              Tool
            </th>
            <th scope="col" className="pb-2 pl-4 text-right font-medium">
              Errors
            </th>
            <th scope="col" className="pb-2 pl-4 text-right font-medium">
              Refused arguments
            </th>
            <th scope="col" className="pb-2 pl-4 text-right font-medium">
              Median
            </th>
            <th scope="col" className="pb-2 pl-4 text-right font-medium">
              Calls
            </th>
          </tr>
        </thead>
        <tbody>
          {tools.map((tool) => (
            <tr key={tool.toolName} className="border-t border-border align-baseline">
              <th scope="row" className="py-2 text-left font-normal">
                <Link
                  href={`/tool${withParams(carried, { toolName: tool.toolName })}`}
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  <BreakableName name={tool.toolName} />
                </Link>
                <span className="mt-1 flex flex-wrap gap-1.5">
                  <ToolBadge tool={tool} />
                  {tool.definitionChanged ? (
                    <span className="rounded px-1.5 py-0.5 text-[11px] bg-status-warning/10 text-status-warning">
                      Definition changed
                    </span>
                  ) : null}
                </span>
              </th>
              <BeforeAfter
                before={tool.before === null ? null : tool.before.errorRate}
                after={tool.after === null ? null : tool.after.errorRate}
                format={(rate) => `${formatRate(rate)}%`}
              />
              {/* A share rather than a count, so more traffic alone does not read as worse. */}
              <BeforeAfter
                before={tool.before === null ? null : share(tool.before.refused, tool.before.calls)}
                after={tool.after === null ? null : share(tool.after.refused, tool.after.calls)}
                format={(rate) => `${formatRate(rate)}%`}
              />
              <BeforeAfter
                before={tool.before?.durationMs.p50 ?? null}
                after={tool.after?.durationMs.p50 ?? null}
                format={duration}
              />
              <BeforeAfter
                before={tool.before === null ? null : tool.before.calls}
                after={tool.after === null ? null : tool.after.calls}
                format={formatCount}
                plain
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToolBadge({ tool }: { tool: ReleaseTool }) {
  const [label, tone] =
    tool.before === null
      ? ['New', 'bg-series-calls/10 text-series-calls']
      : tool.after === null
        ? ['No calls now', 'bg-border/60 text-ink-muted']
        : tool.verdict === 'worse'
          ? ['Worse', 'bg-status-critical/10 text-status-critical']
          : tool.verdict === 'better'
            ? ['Better', 'bg-status-good/10 text-status-good']
            : [null, ''];

  if (label === null) return null;

  return <span className={`rounded px-1.5 py-0.5 text-[11px] ${tone}`}>{label}</span>;
}

function BeforeAfter({
  before,
  after,
  format,
  plain = false,
}: {
  before: number | null;
  after: number | null;
  format: (value: number) => string;
  /** Not better or worse when it rises: a count of calls. */
  plain?: boolean;
}) {
  // Equal as shown is no change, whatever the digits past rounding.
  const tone =
    plain || before === null || after === null || format(after) === format(before)
      ? 'text-ink'
      : after > before
        ? 'text-status-critical'
        : 'text-status-good';

  return (
    <td className="py-2 pl-4 text-right text-xs whitespace-nowrap tabular-nums">
      <span className="text-ink-muted">{before === null ? '-' : format(before)}</span>
      <span className="text-ink-muted"> → </span>
      <span className={tone}>{after === null ? '-' : format(after)}</span>
    </td>
  );
}

function Sessions({ label, outcomes }: { label: string; outcomes: SessionOutcomes }) {
  const total = Object.values(outcomes).reduce((sum, count) => sum + count, 0);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-ink">{label}</p>
      {total === 0 ? (
        <p className="text-sm text-ink-muted">No sessions.</p>
      ) : (
        <OutcomeBar
          segments={OUTCOMES.map((outcome) => ({ ...outcome, count: outcomes[outcome.key] }))}
          total={total}
          note={`${formatCount(total)} session${total === 1 ? '' : 's'}.`}
        />
      )}
    </div>
  );
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/** "7 days", "20 hours", "45 minutes": the length of the periods compared. */
function lengthText(ms: number): string {
  const hours = ms / (60 * 60 * 1000);

  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 2) return `${Math.round(hours)} hours`;

  const minutes = Math.max(1, Math.round(ms / 60_000));

  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
