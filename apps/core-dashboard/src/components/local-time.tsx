'use client';

import { useEffect, useState } from 'react';

/**
 * A timestamp in the reader's own timezone.
 *
 * Formatted in the browser rather than on the server, because the server's
 * clock settings are its own: a self-hoster running the stack in a container
 * set to UTC while sitting in Warsaw would otherwise read every failure as
 * having happened two hours before it did, and have no way to tell.
 *
 * The machine-readable value goes out first and is replaced once the browser
 * has it, so the page still says something useful before any script runs and
 * the two renders never disagree.
 */
export function LocalTime({ iso }: { iso: string }) {
  const [formatted, setFormatted] = useState<string>();

  useEffect(() => {
    const parsed = new Date(iso);

    setFormatted(
      parsed.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  }, [iso]);

  return (
    <time dateTime={iso} title={iso}>
      {formatted ?? iso.replace('T', ' ').slice(0, 16) + ' UTC'}
    </time>
  );
}
