import { redirect } from 'next/navigation';

import { SignInForm } from '../components/sign-in-form';
import { coreApiUrl } from '../lib/api';
import { currentSession } from '../lib/session';

/**
 * Asks the Core API whether anybody has signed up yet, and whether the
 * reader's session is still good.
 *
 * Decides whether this page offers to create an account or only to sign in.
 * Getting it from the server rather than guessing means the first person to
 * arrive at a fresh install is told what to do, and the second is not offered
 * a button that will refuse them.
 */
async function authStatus(
  session: string | undefined,
): Promise<{ registrationOpen: boolean | undefined; signedIn: boolean }> {
  try {
    const response = await fetch(new URL('/v1/auth/status', coreApiUrl()), {
      ...(session === undefined ? {} : { headers: { cookie: session } }),
      cache: 'no-store',
    });

    if (!response.ok) return { registrationOpen: undefined, signedIn: false };

    const body = (await response.json()) as { registrationOpen?: boolean; signedIn?: boolean };

    return { registrationOpen: body.registrationOpen ?? undefined, signedIn: body.signedIn === true };
  } catch {
    // The API is unreachable. The form still renders and will say so plainly
    // when somebody tries, which beats an error page that offers nothing.
    return { registrationOpen: undefined, signedIn: false };
  }
}

export default async function LoginPage() {
  const status = await authStatus(await currentSession());

  // Somebody already signed in has no business here. Asked of the API rather
  // than read from the cookie: an expired session still leaves its cookie,
  // and sending its holder back to the dashboard would loop.
  if (status.signedIn) redirect('/');

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <SignInForm registrationOpen={status.registrationOpen} />
    </main>
  );
}
