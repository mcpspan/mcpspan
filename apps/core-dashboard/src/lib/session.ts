import { cookies } from 'next/headers';

import type { Session } from './api';

/** The cookie the Core API issues when somebody signs in. */
const SESSION_COOKIE = 'mcpspan_session';

/**
 * The reader's session, ready to pass on to the Core API.
 *
 * This app holds no credential of its own. Every request it makes on
 * somebody's behalf carries that person's own session, so the dashboard can
 * never see more than they are entitled to - and there is no shared secret
 * sitting in its environment waiting to be leaked.
 */
export async function currentSession(): Promise<Session> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  return token === undefined ? undefined : `${SESSION_COOKIE}=${token}`;
}
