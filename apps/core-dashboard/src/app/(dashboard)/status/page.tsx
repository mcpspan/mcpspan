import { AlertTriangle, CheckCircle2, Circle, XCircle } from 'lucide-react';

import { Facts } from '@/components/facts';
import { LocalTime } from '@/components/local-time';
import { CannotReachApi, Notice } from '@/components/notice';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/ui/card';
import { ApiError, type Diagnostics, getDiagnostics } from '@/lib/api';
import { diagnose, formatBytes, reasonInfo, type Tone } from '@/lib/diagnosis';
import { formatCount } from '@/lib/format';
import { ingestUrl } from '@/lib/ingest-url';
import { currentSession } from '@/lib/session';
import { DASHBOARD_VERSION } from '@/lib/version';

const TONE = {
  good: { Icon: CheckCircle2, className: 'text-status-good', label: 'OK' },
  warning: { Icon: AlertTriangle, className: 'text-status-warning-ink', label: 'Warning' },
  critical: { Icon: XCircle, className: 'text-status-critical', label: 'Problem' },
  neutral: { Icon: Circle, className: 'text-ink-muted', label: 'Note' },
} as const satisfies Record<Tone, unknown>;

/**
 * Why the dashboard shows what it shows.
 *
 * A self-hoster has nobody to ask whether their installation works. An empty
 * overview looks the same when nothing has called a tool, when the SDK points
 * somewhere else, when its key is refused and when the database is down, and
 * each of those has a different fix. This page tells them apart as far as the
 * installation can see, and says plainly where it cannot.
 *
 * The database being down is shown by this page failing to load, with the API
 * saying why, since everything else here is read from the database.
 */
export default async function StatusPage() {
  const diagnostics = await getDiagnostics(await currentSession()).catch((error: unknown) => {
    if (error instanceof ApiError) return error;

    throw error;
  });

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <PageHeader title="Status" subtitle="Whether data is arriving, and if not, why" />

      {diagnostics instanceof ApiError ? (
        <CannotReachApi reason={diagnostics.message} status={diagnostics.status} />
      ) : (
        <StatusReport diagnostics={diagnostics} />
      )}
    </main>
  );
}

function StatusReport({ diagnostics }: { diagnostics: Diagnostics }) {
  const endpoint = ingestUrl();
  const serverNames = new Map(diagnostics.servers.map((server) => [server.id, server.name]));
  // The contact first: the SDK announces itself on start, so after a redeploy
  // it carries the new version before any tool call does.
  const sdkVersions = [
    ...new Set(
      diagnostics.servers.flatMap(
        (server) => server.lastContact?.sdkVersion ?? server.lastEvent?.sdkVersion ?? [],
      ),
    ),
  ];
  const staleServers = diagnostics.signingSecret?.staleServerIds.length ?? 0;

  return (
    <>
      {diagnostics.signingSecret !== null && staleServers > 0 ? (
        <Notice title="API_KEY_SECRET has changed">
          <p>
            It changed on <LocalTime iso={diagnostics.signingSecret.changedAt} />, after{' '}
            {staleServers === 1 ? 'one server was' : `${staleServers} servers were`} given a key.
            Keys are stored as hashes made with that secret, so those keys can no longer be
            verified. If this followed a restore, put back the .env that came with the backup.
            If it was deliberate, generate new keys in Settings.
          </p>
        </Notice>
      ) : null}

      <Card>
        <CardHeader title="Servers" hint={`SDK endpoint: ${endpoint}`} />

        <ul className="divide-y divide-border">
          {diagnostics.servers.map((server) => {
            const verdict = diagnose(server, diagnostics, endpoint);
            const { Icon, className, label } = TONE[verdict.tone];

            return (
              <li key={server.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${className}`} />
                <div className="min-w-0 text-sm">
                  <p>
                    <span className="font-medium text-ink">{server.name}</span>
                    <span className="sr-only"> ({label})</span>
                    <span className="text-ink-muted"> - {verdict.title}</span>
                  </p>
                  <p className="mt-1 text-ink-muted">{verdict.detail}</p>
                  {server.lastEvent === null ? null : (
                    <p className="mt-1 text-xs text-ink-muted">
                      SDK {server.lastEvent.sdkVersion}, last call{' '}
                      <LocalTime iso={server.lastEvent.receivedAt} />
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Refused requests" hint="Kept across restarts" />

        {diagnostics.refusals.length === 0 ? (
          <p className="text-sm text-ink-muted">The API has not refused anything.</p>
        ) : (
          // A list rather than a table. Each entry carries a sentence of
          // explanation, and four columns beside it cut the date off on a phone.
          <ul className="divide-y divide-border">
            {diagnostics.refusals.map((refusal) => {
              const info = reasonInfo(refusal.reason);

              return (
                <li
                  key={`${refusal.serverId ?? ''}:${refusal.reason}`}
                  className="py-3 text-sm first:pt-0 last:pb-0"
                >
                  <p>
                    <span className="font-medium text-ink">{info.label}</span>
                    <span
                      className={`ml-2 text-xs ${info.lost ? 'text-status-critical' : 'text-ink-muted'}`}
                    >
                      {info.lost ? 'Events lost' : 'Sent again'}
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    {refusal.serverId === null
                      ? 'Server not identified'
                      : (serverNames.get(refusal.serverId) ?? 'Unknown server')}
                    , {formatCount(refusal.requests)} request{refusal.requests === 1 ? '' : 's'},
                    last <LocalTime iso={refusal.lastAt} />
                  </p>
                  <p className="mt-1 text-ink-muted">{info.explanation}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader title="Storage" />
          <Facts
            rows={[
              ['Database size', formatBytes(diagnostics.storage.databaseBytes)],
              [
                'Oldest event',
                diagnostics.storage.oldestEventAt === null ? (
                  'None yet'
                ) : (
                  <LocalTime iso={diagnostics.storage.oldestEventAt} />
                ),
              ],
              ['Events kept for', days(diagnostics.storage.retentionDays)],
              ['Hourly summaries kept for', days(diagnostics.storage.rollupRetentionDays)],
              [
                'Forwarded to OpenTelemetry',
                // Absent from an older Core API, which this page must still render for:
                // telling versions apart is one of the things it is for.
                (diagnostics.storage.openTelemetry ?? null) === null ? (
                  'Off'
                ) : (
                  <span className="[overflow-wrap:anywhere]">{diagnostics.storage.openTelemetry?.join(', ')}</span>
                ),
              ],
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Versions" />
          <Facts
            rows={[
              ['Dashboard', DASHBOARD_VERSION],
              ['Core API', diagnostics.versions.api],
              ['PostgreSQL', diagnostics.versions.postgres],
              ['TimescaleDB', diagnostics.versions.timescaledb ?? 'Not installed'],
              ['SDK in use', sdkVersions.length === 0 ? 'None seen yet' : sdkVersions.join(', ')],
            ]}
          />
          {/* The two are released together, so a difference means only one
              image was rebuilt, which is worth knowing before anything else
              on this page is trusted. */}
          {diagnostics.versions.api === DASHBOARD_VERSION ? null : (
            <p className="mt-3 text-xs text-status-warning-ink">
              The dashboard and the Core API are different versions. Rebuild both, for example
              with docker compose up -d --build.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}

function days(count: number | null): string {
  if (count === null) return 'Forever';

  return `${count} day${count === 1 ? '' : 's'}`;
}
