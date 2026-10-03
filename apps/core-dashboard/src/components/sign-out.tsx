'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Ending a session.
 *
 * Goes through the server so the session is deleted there too. Clearing the
 * cookie alone would leave a copied token working until it expired, which is
 * the opposite of what somebody clicking this expects.
 */
export function SignOut() {
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function signOut(): Promise<void> {
    setWorking(true);

    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={working}
      className="rounded-lg px-3 py-1.5 text-sm text-ink-muted outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-60"
    >
      {working ? 'Signing out...' : 'Sign out'}
    </button>
  );
}
