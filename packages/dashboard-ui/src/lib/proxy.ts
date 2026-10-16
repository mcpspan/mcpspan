import { type NextRequest, NextResponse } from 'next/server';

import { coreApiUrl } from './api';

/**
 * Passes a browser's request through to the Core API.
 *
 * The browser holds a session cookie for this app and the API wants the same
 * one. Forwarding it here keeps the API off the public network and keeps
 * cross-origin cookie handling out of the picture entirely.
 *
 * Shared by every catch-all route that manages something, since each is the
 * same request with a different method and path.
 */
async function proxyToApi(
  request: NextRequest,
  /** Where under the API this route lives, for example `/v1/servers`. */
  base: string,
  path: string[] | undefined,
): Promise<NextResponse> {
  const cookie = request.headers.get('cookie');

  if (cookie === null) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const suffix = (path ?? []).map(encodeURIComponent).join('/');
  const target = new URL(`${base}${suffix === '' ? '' : `/${suffix}`}`, coreApiUrl());

  const body =
    request.method === 'GET' || request.method === 'DELETE' ? undefined : await request.text();

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body }),
    });

    // A 204 carries nothing, and asking it for JSON would throw where the
    // request in fact succeeded.
    if (upstream.status === 204) return new NextResponse(null, { status: 204 });

    return NextResponse.json(await upstream.json().catch(() => ({})), { status: upstream.status });
  } catch {
    return NextResponse.json({ error: 'Could not reach the server' }, { status: 503 });
  }
}

/** The handlers a catch-all route exports, all passing through to one base path. */
export function proxyHandlers(base: string) {
  type Context = { params: Promise<{ path?: string[] }> };

  const handle = async (request: NextRequest, context: Context): Promise<NextResponse> =>
    proxyToApi(request, base, (await context.params).path);

  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}
