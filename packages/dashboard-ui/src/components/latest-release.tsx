import Link from 'next/link';

import type { ReleaseReport } from '../lib/api';
import { formatCount, formatRate } from '../lib/format';
import { type Params, withParams } from '../lib/query';
import { BreakableName } from './breakable-name';
import { LocalTime } from './local-time';
import { VerdictBadge, verdictSentence } from './release-verdict';
import { Card } from './ui/card';

/** How long a release stays on the overview: about as long as somebody is still asking what it did. */
export const RECENT_RELEASE_DAYS = 14;

/** Tools named on the card; the report has the rest. */
const NAMED_TOOLS = 3;

/**
 * The newest release, briefly, while it is new: the verdict, why, and the
 * tools that got worse, with the way to the whole report.
 *
 * Above the charts because it answers the question somebody opens the
 * dashboard with after shipping, and gone after two weeks, when the versions
 * table is enough.
 */
export function LatestRelease({ report, carried }: { report: ReleaseReport; carried: Params }) {
  const worse = report.tools.filter((tool) => tool.verdict === 'worse').slice(0, NAMED_TOOLS);

  return (
    <Card id="latest-release">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium text-ink">
          Latest release <span className="font-mono text-xs">{report.version}</span>
        </h2>
        <span className="text-xs text-ink-muted">
          {report.previous === null ? 'First call ' : `Against ${report.previous}, first call `}
          <LocalTime iso={report.releasedAt} />
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <VerdictBadge verdict={report.verdict} small />
        <p className="text-sm text-ink">{verdictSentence(report)}</p>
      </div>

      {worse.length === 0 && report.newFailures.length === 0 ? null : (
        <ul className="mt-3 space-y-1 text-xs text-ink-muted">
          {worse.map((tool) => (
            <li key={tool.toolName}>
              <span className="font-mono text-ink">
                <BreakableName name={tool.toolName} />
              </span>{' '}
              errors {formatRate(tool.before?.errorRate ?? 0)}% → {formatRate(tool.after?.errorRate ?? 0)}%
            </li>
          ))}
          {report.newFailures.length === 0 ? null : (
            <li>
              {formatCount(report.newFailures.length)} new kind{report.newFailures.length === 1 ? '' : 's'} of failure
            </li>
          )}
        </ul>
      )}

      <p className="mt-3 text-sm">
        <Link
          href={`/release${withParams(carried, { version: report.version })}`}
          className="text-ink underline underline-offset-2"
        >
          Full report
        </Link>
      </p>
    </Card>
  );
}

/** Whether a release is new enough for the overview. */
export function isRecentRelease(report: ReleaseReport): boolean {
  return Date.now() - new Date(report.releasedAt).getTime() < RECENT_RELEASE_DAYS * 24 * 60 * 60 * 1000;
}
