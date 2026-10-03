import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { Logo } from '@/components/logo';
import { MobileMenu, Nav } from '@/components/nav';
import { ServerSwitcher } from '@/components/server-switcher';
import { SignOut } from '@/components/sign-out';
import { getServers } from '@/lib/api';
import { currentSession } from '@/lib/session';

/**
 * The shell every dashboard page sits in.
 *
 * A route group rather than a path segment, so these pages keep their plain
 * addresses: the overview lives at the root, where somebody typing the host
 * name expects to land. Sign-in stays outside this group, since a shell with
 * links into the dashboard is no use to anybody who cannot open it yet.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Checked once here rather than on every page. Somebody without a session
  // sees the sign-in form, not a shell full of views that will all refuse
  // them one by one.
  const session = await currentSession();

  if (session === undefined) redirect('/login');

  // Drawn here so the choice is in the same place on every page. Failing to
  // read it must not take the shell down with it: a dashboard that cannot
  // list servers can still show the one it was asked about.
  const servers = await getServers(session)
    .then((body) => body.servers)
    .catch(() => []);

  return (
    <div className="min-h-screen">
      <header className="relative border-b border-border bg-raised">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-x-6 px-6 py-3">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Logo size={22} />
            mcpspan
          </span>

          <div className="hidden items-center gap-2 md:flex">
            <ServerSwitcher servers={servers} />
            <Nav />
            <SignOut />
          </div>

          <MobileMenu>
            <ServerSwitcher servers={servers} />
            <SignOut />
          </MobileMenu>
        </div>
      </header>

      {children}
    </div>
  );
}
