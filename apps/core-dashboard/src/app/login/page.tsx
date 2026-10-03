import { redirect } from 'next/navigation';

import { SignInForm } from '@/components/sign-in-form';
import { coreApiUrl } from '@/lib/api';
import { currentSession } from '@/lib/session';

/**
 * Asks the Core API whether anybody has signed up yet.
 *
 * Decides whether this page offers to create an account or only to sign in.
 * Getting it from the server rather than guessing means the first person to
 * arrive at a fresh install is told what to do, and the second is not offered
 * a button that will refuse them.
 */
async function registrationOpen(): Promise<boolean | undefined> {
  try {
    const response = await fetch(new URL('/v1/auth/status', coreApiUrl()));

    if (!response.ok) return undefined;

    return ((await response.json()) as { registrationOpen?: boolean }).registrationOpen ?? undefined;
  } catch {
    // The API is unreachable. The form still renders and will say so plainly
    // when somebody tries, which beats an error page that offers nothing.
    return undefined;
  }
}

export default async function LoginPage() {
  // Somebody already signed in has no business here.
  if ((await currentSession()) !== undefined) redirect('/');

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <SignInForm registrationOpen={await registrationOpen()} />
    </main>
  );
}
