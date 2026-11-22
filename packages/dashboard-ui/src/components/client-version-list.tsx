import Link from 'next/link';

import type { ClientVersions } from '../lib/api';
import { formatCount, formatRate } from '../lib/format';
import { type Params, withParams } from '../lib/query';
import { VERDICTS } from './release-verdict';

const BADGE = 'rounded-md px-1.5 py-0.5 text-[11px] font-medium';

/**
 * A client's versions under its row: which ones called, how much, how often
 * they failed, and whether the newest gets its arguments refused more often
 * than the one before it, naming the tools.
 *
 * A client updates itself, and nobody tells the server's author; this is where
 * a new Cursor that sends the wrong arguments shows up as a new Cursor, not as
 * Cursor getting worse. Each version links to its calls.
 */
export function ClientVersionList({
  data,
  carried,
  clientIsNew = false,
}: {
  data: ClientVersions;
  carried: Params;
  /** The client itself is new to the server, which its row says: every version of it would be new too. */
  clientIsNew?: boolean;
}) {
  if (data.versions.length === 0) return null;

  // Names only where a type holds more than one client, each numbering its own versions.
  const named = new Set(data.versions.map((version) => version.clientName)).size > 1;
  const shares = data.versions.length > 1 || data.olderCalls > 0 || data.unversionedCalls > 0;
  const total = data.versions.reduce((sum, version) => sum + version.calls, data.olderCalls + data.unversionedCalls);

  return (
    <ul className="mt-2 space-y-1 pl-[18px] text-xs">
      {data.versions.map((version) => {
        const comparison = version.verdict === 'worse' || version.verdict === 'better' ? version.verdict : null;

        return (
          <li key={`${version.clientName}\u0000${version.version}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/calls${withParams(carried, {
                clientType: data.clientType,
                clientName: version.clientName,
                clientVersion: version.version,
              })}`}
              className="font-mono text-ink underline-offset-2 hover:underline"
            >
              {named ? `${version.clientName} ` : ''}
              {version.version}
            </Link>
            {version.isNew && !clientIsNew ? <span className={`${BADGE} bg-surface text-ink`}>New</span> : null}
            {comparison === null ? null : (
              <span
                className={`${BADGE} ${VERDICTS[comparison].tone}`}
                title={`Compared on server version${version.comparedOn.length === 1 ? '' : 's'} ${version.comparedOn.join(', ')}`}
              >
                {comparison === 'worse' ? 'Worse' : 'Better'} than {version.previous}
              </span>
            )}
            <span className="ml-auto tabular-nums text-ink-muted">
              {formatCount(version.calls)} call{version.calls === 1 ? '' : 's'} ·{' '}
              {shares ? `${Math.round((version.calls / Math.max(total, 1)) * 100)}% · ` : ''}
              {formatRate(version.errorRate)}% errors
              {version.refused > 0 ? `, ${formatRate(version.refused / version.calls)}% refused` : ''}
            </span>
            {comparison === null
              ? null
              : version.changedTools.map((tool) => (
                  <span key={tool.toolName} className="basis-full pl-2 text-ink-muted">
                    <span className="font-mono text-ink">{tool.toolName}</span>: arguments refused{' '}
                    {share(tool.after)} of {formatCount(tool.after.calls)} calls, against {share(tool.before)} on{' '}
                    {version.previous}
                  </span>
                ))}
          </li>
        );
      })}
      {data.olderCalls > 0 ? (
        <li className="text-ink-muted">Older versions: {formatCount(data.olderCalls)} calls</li>
      ) : null}
      {data.unversionedCalls > 0 ? (
        <li className="text-ink-muted">No version given: {formatCount(data.unversionedCalls)} calls</li>
      ) : null}
    </ul>
  );
}

function share({ calls, refused }: { calls: number; refused: number }): string {
  return `${formatRate(calls === 0 ? 0 : refused / calls)}%`;
}
