import { type NextRequest, NextResponse } from 'next/server';

import { coreApiUrl } from '@/lib/api';

/** What an export may be, so this route cannot be turned into a way to reach any API path. */
const EXPORTS = new Set(['calls', 'tools']);

/**
 * Hands a download from the Core API to the browser, as it arrives.
 *
 * Not the JSON proxy the other routes use: an export can be large, and
 * reading it whole here to pass it on would hold all of it in this process.
 * The body is passed through as a stream, with the headers that make the
 * browser save it under the name the API chose.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const cookie = request.headers.get('cookie');

  if (cookie === null) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const [kind, ...rest] = (await context.params).path;

  if (kind === undefined || rest.length > 0 || !EXPORTS.has(kind)) {
    return NextResponse.json({ error: 'No such export' }, { status: 404 });
  }

  const target = new URL(`/v1/dashboard/export/${kind}`, coreApiUrl());
  target.search = request.nextUrl.search;

  try {
    let upstream = await fetch(target, { headers: { cookie } });

    // Several servers and none named: the one the switcher shows as chosen,
    // as every page does (lib/api.ts).
    if (upstream.status === 400 && !target.searchParams.has('serverId')) {
      const listing = await fetch(new URL('/v1/servers', coreApiUrl()), { headers: { cookie } });
      const first = listing.ok
        ? ((await listing.json()) as { servers: { id: string }[] }).servers[0]?.id
        : undefined;
      if (first !== undefined) {
        await upstream.text();
        target.searchParams.set('serverId', first);
        upstream = await fetch(target, { headers: { cookie } });
      }
    }

    if (!upstream.ok || upstream.body === null) {
      return NextResponse.json(await upstream.json().catch(() => ({})), {
        status: upstream.status,
      });
    }

    const headers = new Headers();

    for (const name of ['content-type', 'content-disposition', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }

    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return NextResponse.json({ error: 'Could not reach the server' }, { status: 503 });
  }
}
