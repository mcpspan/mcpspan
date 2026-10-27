import { installation } from '#installation';
import { redirect } from 'next/navigation';

import { Logo } from '../components/logo';
import { OAuthConsent } from '../components/oauth-consent';
import { ApiError, checkAuthorization } from '../lib/api';
import { currentSession } from '../lib/session';

/**
 * Where an MCP client (claude.ai, ChatGPT, Claude Code...) sends somebody to
 * let it read their mcpspan data: the authorization endpoint the API's OAuth
 * metadata names (apps/core-api, routes/oauth.ts). Signed out, they sign in
 * first and come back here.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = Object.fromEntries(
    Object.entries(await searchParams).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const query = new URLSearchParams(params);
  const toSignIn = `/login?next=${encodeURIComponent(`/oauth/authorize?${query.toString()}`)}`;
  const session = await currentSession();

  if (session === undefined) redirect(toSignIn);

  let checked;

  try {
    checked = await checkAuthorization(session, query);
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthenticated) redirect(toSignIn);

    throw error;
  }

  if ('failure' in checked) {
    // Once the app and its address are known, it is the app that is told.
    if (checked.failure.redirect !== undefined) redirect(checked.failure.redirect);

    return (
      <Frame>
        <h1 className="text-lg font-semibold tracking-tight">This app cannot connect</h1>
        <p className="mt-2 text-sm text-ink-muted">{checked.failure.description}</p>
        <p className="mt-4 text-sm text-ink-muted">
          Nothing was shared. Close this page and start connecting mcpspan again from the app.
        </p>
      </Frame>
    );
  }

  const { client, account } = checked;

  return (
    <Frame>
      <h1 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">
        Allow {client.name} to read your mcpspan data?
      </h1>

      <ul className="mt-4 list-disc space-y-2 pl-5 text-sm text-ink-muted">
        <li>
          It can read what you see in mcpspan: your servers&apos; calls, errors, response times, clients and
          sessions.
        </li>
        <li>{installation.consentLimits}</li>
        <li>You can disconnect it at any time in Settings, under Connected apps.</li>
      </ul>

      <p className="mt-4 rounded-lg border border-border bg-surface p-3 text-sm text-ink-muted">
        You go back to <strong className="font-medium text-ink [overflow-wrap:anywhere]">{client.redirectHost}</strong>{' '}
        after you answer. Allow it only if you started connecting mcpspan there just now: an app can call itself
        anything.
      </p>

      <div className="mt-5">
        <OAuthConsent params={params} name={client.name} />
      </div>

      <p className="mt-4 text-xs text-ink-muted [overflow-wrap:anywhere]">Signed in as {account.email}.</p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <p className="mb-6 flex items-center gap-2.5 text-base font-semibold tracking-tight">
        <Logo size={28} />
        mcpspan
      </p>
      <section className="rounded-xl border border-border bg-raised p-5 shadow-xs">{children}</section>
    </main>
  );
}
