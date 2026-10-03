import type { Diagnostics, RefusalCount, ServerHealth } from './api';

export type Tone = 'good' | 'warning' | 'critical' | 'neutral';

/** One server's state, in the words somebody needs to act on it. */
export interface Verdict {
  tone: Tone;
  title: string;
  detail: string;
}

/** Past this, a server that used to report is called quiet rather than fine. */
const QUIET_AFTER_MS = 24 * 60 * 60 * 1000;

interface ReasonInfo {
  label: string;
  /** False when the SDK keeps the batch and sends it again, so nothing is lost. */
  lost: boolean;
  explanation: string;
}

/**
 * What each refusal means and whether anything was lost.
 *
 * The second half matters as much as the first. A rate limit and a refused key
 * both show up as refusals, and one of them is the API doing its job while the
 * other is a server whose data is going nowhere.
 */
const REASONS: Record<string, ReasonInfo> = {
  missing_key: {
    label: 'No API key',
    lost: true,
    explanation:
      'The request carried no key. The SDK sends nothing without one, so this was something else calling the endpoint.',
  },
  unknown_key: {
    label: 'Unrecognised key',
    lost: true,
    explanation:
      'A key this installation has no record of: mistyped, from another installation, or issued under a different API_KEY_SECRET.',
  },
  revoked_key: {
    label: 'Replaced key',
    lost: true,
    explanation:
      'A key that has since been replaced. Something is still running with the old one, and the SDK stops sending after the first refusal until its process restarts.',
  },
  too_large: {
    label: 'Batch too large',
    lost: true,
    explanation: 'More than one batch may carry. The SDK never sends one this large.',
  },
  invalid_batch: {
    label: 'Malformed batch',
    lost: true,
    explanation:
      'Not a batch this API understands. Usually an SDK much newer or older than this installation.',
  },
  rate_limited: {
    label: 'Rate limited',
    lost: false,
    explanation:
      'Sent faster than MCPSPAN_INGEST_EVENTS_PER_SECOND allows. The SDK keeps these and sends them again.',
  },
  storage_failed: {
    label: 'Not stored',
    lost: false,
    explanation:
      'Accepted but not written, usually because the database was unavailable. The SDK keeps these and sends them again.',
  },
};

export function reasonInfo(reason: string): ReasonInfo {
  return (
    REASONS[reason] ?? {
      label: reason,
      lost: true,
      explanation: 'A reason this dashboard does not know yet, from a newer Core API.',
    }
  );
}

/**
 * Works out what is going on with one server.
 *
 * The order is the order of what to fix first. A refusal only counts if it came
 * after the last event that got through: a key replaced last month and then
 * redeployed correctly left refusals behind, and those are history, not a
 * current problem.
 */
export function diagnose(
  server: ServerHealth,
  diagnostics: Pick<Diagnostics, 'refusals' | 'signingSecret'>,
  ingestUrl: string,
  now: number = Date.now(),
): Verdict {
  const lastReceived =
    server.lastEvent === null ? undefined : Date.parse(server.lastEvent.receivedAt);

  const current = (reason: string): RefusalCount | undefined =>
    diagnostics.refusals.find(
      (refusal) =>
        refusal.serverId === server.id &&
        refusal.reason === reason &&
        (lastReceived === undefined || Date.parse(refusal.lastAt) > lastReceived),
    );

  if (!server.hasActiveKey) {
    return {
      tone: 'critical',
      title: 'No working key',
      detail:
        'Its key was revoked and never replaced, so nothing can write to it. Generate a new one in Settings.',
    };
  }

  if (diagnostics.signingSecret?.staleServerIds.includes(server.id) === true) {
    return {
      tone: 'critical',
      title: 'Key issued under an old API_KEY_SECRET',
      detail:
        'API_KEY_SECRET changed after this key was created, so the key can no longer be verified. Restore the previous .env, or generate a new key in Settings.',
    };
  }

  const replaced = current('revoked_key');

  if (replaced !== undefined) {
    return {
      tone: 'critical',
      title: 'Still sending with a replaced key',
      detail: `Something is running with this server's old key, most recently at ${clock(replaced.lastAt)}. Give it the current key and restart it.`,
    };
  }

  const malformed = current('invalid_batch') ?? current('too_large');

  if (malformed !== undefined) {
    return {
      tone: 'critical',
      title: 'Its batches are being refused',
      detail: `${reasonInfo(malformed.reason).explanation} Most recently at ${clock(malformed.lastAt)}.`,
    };
  }

  if (server.lastEvent === null) {
    // Told apart by the announcement the SDK sends when it starts. Before it
    // existed, an unused server and a wrong address looked identical here.
    if (server.lastContact !== null) {
      return {
        tone: 'good',
        title: 'Connected, no calls yet',
        detail: `The SDK reached this installation at ${clock(server.lastContact.at)}, so the key and address are right. No tool has been called since.`,
      };
    }

    return {
      tone: 'neutral',
      title: 'Never heard from',
      detail: `Nothing from the SDK has reached this installation with this server's key. The SDK announces itself when it starts, so check that the server is running with this key and sends to ${ingestUrl}, then restart it. A refused key would show up on this page.`,
    };
  }

  const slowed = current('rate_limited');

  if (slowed !== undefined) {
    return {
      tone: 'warning',
      title: 'Being slowed down',
      detail: `Sending faster than its limit allows, most recently at ${clock(slowed.lastAt)}. Nothing is lost: the SDK keeps what was refused and sends it again.`,
    };
  }

  const unstored = current('storage_failed');

  if (unstored !== undefined) {
    return {
      tone: 'warning',
      title: 'Some batches were not stored',
      detail: `The database could not write them, most recently at ${clock(unstored.lastAt)}. The SDK keeps these and sends them again.`,
    };
  }

  const since = now - (lastReceived ?? now);

  if (since > QUIET_AFTER_MS) {
    return {
      tone: 'neutral',
      title: `Quiet for ${ago(since)}`,
      detail:
        'It has reported before, so the key and address worked then. Either nothing has called a tool since, or its deployment changed.',
    };
  }

  return {
    tone: 'good',
    title: 'Reporting',
    detail: `Last call received ${ago(since)} ago, and nothing refused since.`,
  };
}

/** A span of time in the largest unit that fits, rounded down. */
export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return plural(minutes, 'minute');

  const hours = Math.floor(minutes / 60);

  if (hours < 48) return plural(hours, 'hour');

  return plural(Math.floor(hours / 24), 'day');
}

/** Bytes in the unit that suits their size. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * A moment inside a sentence, in UTC and said so.
 *
 * These sentences are built on the server, which does not know the reader's
 * timezone, and a bare time would be read as local and be off by hours. The
 * tables on the page show the same moments in local time.
 */
function clock(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}
