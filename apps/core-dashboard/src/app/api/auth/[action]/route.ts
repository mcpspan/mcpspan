import { type NextRequest, NextResponse } from 'next/server';

import { coreApiUrl } from '@/lib/api';

/**
 * What a browser may ask this app to do on its behalf.
 *
 * A fixed list rather than whatever is in the address: without it the path
 * would be a way to reach any route on the Core API through a host that the
 * browser is already trusted by.
 */
const ALLOWED = new Set(['register', 'login', 'logout', 'password']);

/**
 * Passes sign-in through to the Core API.
 *
 * The browser talks to this app and this app talks to the API, so the session
 * cookie is set by the API and handed onwards unchanged. Letting the browser
 * call the API directly would work, but only by exposing it to the network and
 * arranging cross-origin cookies, which is a lot of moving parts to add for no
 * gain on a self-hosted install.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const { action } = await params;

  if (!ALLOWED.has(action)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`/v1/auth/${action}`, coreApiUrl()), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Signing out needs the session it is ending, and changing the
        // password the session of whoever is changing it.
        ...(request.headers.get('cookie') === null
          ? {}
          : { cookie: request.headers.get('cookie') as string }),
      },
      body,
    });
  } catch {
    return NextResponse.json(
      { error: 'Could not reach the server. Is the Core API running?' },
      { status: 503 },
    );
  }

  const response = NextResponse.json(await upstream.json().catch(() => ({})), {
    status: upstream.status,
  });

  // The whole point of the hop: whatever the API decided about the session
  // reaches the browser, and nothing else does.
  const cookie = upstream.headers.get('set-cookie');
  if (cookie !== null) response.headers.set('set-cookie', cookie);

  return response;
}
