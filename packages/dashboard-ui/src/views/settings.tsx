import { installation } from '#installation';
import type { ReactNode } from 'react';

import { ChangePassword } from '../components/change-password';
import { ConnectSnippets } from '../components/connect-snippets';
import { DeleteServerData } from '../components/delete-server-data';
import { ManageAlerts } from '../components/manage-alerts';
import { ManageBadges } from '../components/manage-badges';
import { ManageReadTokens } from '../components/manage-read-tokens';
import { ManageServers } from '../components/manage-servers';
import { OffsetPager } from '../components/pager';
import { PageHeader } from '../components/page-header';
import { Card, CardHeader } from '../components/ui/card';
import { getAlerts, getFilterOptions, getReadTokens, getServers } from '../lib/api';
import { ingestUrl } from '../lib/ingest-url';
import { offsetParam } from '../lib/query';
import { snippets } from '../lib/snippets';
import { currentSession } from '../lib/session';

/** How far back to look for tool names to offer when setting up a rule. */
const TOOL_LOOKBACK_DAYS = 30;

export default async function SettingsPage({
  searchParams,
  first,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
  /** A card of the installation's own, above the shared ones: the hosted service's plan. */
  first?: ReactNode;
}) {
  const params = await searchParams;
  const session = await currentSession();
  const [{ servers, addRefusal }, alerts, readTokens] = await Promise.all([
    getServers(session),
    getAlerts(session, { eventsOffset: offsetParam(params, 'eventsOffset') }),
    getReadTokens(session),
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

      {first}

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

        <ManageServers servers={servers} addRefusal={addRefusal ?? null} />
      </Card>

      <Card id="delete-data">
        <CardHeader title="Delete data" />
        <p className="mb-4 text-sm text-ink-muted">
          Deletes part of what a server recorded, such as an error message that carried something
          it should not have, or a burst of test traffic. The server and its key stay. You are told
          how many calls that is before anything goes.
        </p>
        <DeleteServerData servers={servers.map((server) => ({ id: server.id, name: server.name }))} />
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

      <Card id="badges">
        <CardHeader title="Badges" />
        <p className="mb-4 text-sm text-ink-muted">
          Badges for a server&apos;s README: its calls, success rate and median response time over
          the last week, any or all of them, from what its SDK sent. Off until you switch them on;
          switching them off or moving them stops the old address at once.
        </p>
        <ManageBadges servers={servers} url={ingestUrl()} />
        {installation.badgeNote() ? (
          <p className="mt-4 text-sm text-ink-muted">{installation.badgeNote()}</p>
        ) : null}
      </Card>

      <Card id="read-tokens">
        <CardHeader title="Read tokens" />
        <p className="mb-4 text-sm text-ink-muted">
          Ask an AI agent, such as Claude Code or Cursor, about your servers: which tools failed this
          week, how the last release compares, what clients look for and do not find. A token reads
          what you see here and changes nothing. It is shown once and stored only as a hash.
        </p>
        <ManageReadTokens tokens={readTokens} url={installation.readTokenUrl()} />
        {installation.readTokenNote() ? (
          <p className="mt-4 text-sm text-ink-muted">{installation.readTokenNote()}</p>
        ) : null}
      </Card>

      <Card id="password">
        <CardHeader title="Password" />
        <p className="mb-4 text-sm text-ink-muted">{installation.forgottenPassword}</p>
        <ChangePassword />
      </Card>
    </main>
  );
}
