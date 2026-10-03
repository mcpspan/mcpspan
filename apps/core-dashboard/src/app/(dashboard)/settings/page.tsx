import { ChangePassword } from '@/components/change-password';
import { ConnectSnippets } from '@/components/connect-snippets';
import { ManageAlerts } from '@/components/manage-alerts';
import { ManageServers } from '@/components/manage-servers';
import { OffsetPager } from '@/components/pager';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader } from '@/components/ui/card';
import { getAlerts, getFilterOptions, getServers } from '@/lib/api';
import { ingestUrl } from '@/lib/ingest-url';
import { offsetParam } from '@/lib/query';
import { snippets } from '@/lib/snippets';
import { currentSession } from '@/lib/session';

/** How far back to look for tool names to offer when setting up a rule. */
const TOOL_LOOKBACK_DAYS = 30;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const session = await currentSession();
  const [{ servers }, alerts] = await Promise.all([
    getServers(session),
    getAlerts(session, { eventsOffset: offsetParam(params, 'eventsOffset') }),
  ]);

  // The tools each server has been called with lately, to pick one for a
  // rule. A failure here costs the list, not the page: a rule can still be
  // set up for the whole server.
  const from = new Date(Date.now() - TOOL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const toolsByServer = Object.fromEntries(
    await Promise.all(
      servers.map(async (server) => [
        server.id,
        await getFilterOptions(session, { serverId: server.id, from })
          .then((options) => options.tools)
          .catch(() => []),
      ]),
    ),
  ) as Record<string, string[]>;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <PageHeader title="Settings" />

      <Card>
        <CardHeader title="Connecting a server" />
        <p className="mb-3 text-sm text-ink-muted">
          One line at startup, in the language the server is written in. Nothing about how its
          tools are written changes.
        </p>
        <ConnectSnippets languages={snippets(ingestUrl())} />
      </Card>

      <Card>
        <CardHeader title="Servers" />

        <p className="mb-4 text-sm text-ink-muted">
          {/* Said plainly rather than shown as a masked field somebody would
              try to reveal. A key is stored as a hash, so nothing here can
              produce it again - which is also why a leaked copy of this
              database is not a set of working keys. */}
          One key per server, shown once when it is created and stored only as a hash. Nothing
          here can read a key back, us included. If one has been lost or seen by somebody it
          should not have been, generate a new one: the old one stops working immediately.
        </p>

        <ManageServers servers={servers} />
      </Card>

      <Card id="notifications">
        <CardHeader title="Notifications" />
        <p className="mb-4 text-sm text-ink-muted">
          Choose exactly what you are told about: which server, what condition, and whether you
          hear when it ends as well as when it starts. Rules are checked every minute, and each
          alert is sent once when it starts, however long it lasts.
        </p>
        <ManageAlerts
          alerts={alerts}
          servers={servers}
          toolsByServer={toolsByServer}
          // Arrived here from a tool's page: the new-rule form starts on it.
          preset={{ serverId: params['alertServer'], toolName: params['alertTool'] }}
        />
        <OffsetPager
          params={params}
          name="eventsOffset"
          offset={alerts.eventsOffset}
          limit={20}
          hasMore={alerts.eventsHaveMore}
          hash="#notifications"
        />
      </Card>

      <Card id="password">
        <CardHeader title="Password" />
        <p className="mb-4 text-sm text-ink-muted">
          Forgotten, rather than changed? On the machine running mcpspan,{' '}
          <code className="font-mono text-xs [overflow-wrap:anywhere]">
            docker compose exec api node scripts/reset-password.ts
          </code>{' '}
          prints a new one.
        </p>
        <ChangePassword />
      </Card>
    </main>
  );
}
