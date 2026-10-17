'use client';

import { useState } from 'react';

import { Button } from './ui/button';

const FIELD =
  'h-10 rounded-lg border border-border bg-raised px-3 text-sm text-ink ' +
  'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink';

const HOUR_MS = 60 * 60 * 1000;

const CHOICES = [
  { value: 'hour', label: 'The last hour', back: HOUR_MS },
  { value: 'day', label: 'The last 24 hours', back: 24 * HOUR_MS },
  { value: 'week', label: 'The last 7 days', back: 7 * 24 * HOUR_MS },
  { value: 'month', label: 'The last 30 days', back: 30 * 24 * HOUR_MS },
  { value: 'dates', label: 'Between two dates' },
  { value: 'all', label: 'Everything' },
] as const;

type Choice = (typeof CHOICES)[number]['value'];

interface Range {
  from: string | null;
  to: string | null;
  /** How the confirmation names the range. */
  said: string;
}

/** The range a choice means, in the reader's own time zone, or why it is not one yet. */
function rangeFor(choice: Choice, fromDay: string, toDay: string): Range | { error: string } {
  if (choice === 'all') return { from: null, to: null, said: '' };

  if (choice === 'dates') {
    if (fromDay === '' || toDay === '') return { error: 'Choose both dates.' };

    // Whole days, the second one included: midnight to midnight where the reader is.
    const from = new Date(`${fromDay}T00:00:00`);
    const to = new Date(`${toDay}T00:00:00`);
    to.setDate(to.getDate() + 1);

    if (to.getTime() <= from.getTime()) return { error: 'The second date cannot be before the first.' };

    const day = (date: Date) => date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      said: fromDay === toDay ? `on ${day(from)}` : `from ${day(from)} to ${day(new Date(`${toDay}T00:00:00`))}`,
    };
  }

  const picked = CHOICES.find((option) => option.value === choice);
  const back = picked !== undefined && 'back' in picked ? picked.back : HOUR_MS;

  // No end: a call stamped a little ahead by a fast clock is still "recent".
  return { from: new Date(Date.now() - back).toISOString(), to: null, said: `in ${picked?.label.toLowerCase() ?? 'that time'}` };
}

/**
 * Deletes part of what one server recorded, keeping the server and its key.
 *
 * Asks the API how many calls the range holds before anything goes, and says
 * that number in the question: "delete 3 calls" and "delete 40,000 calls" are
 * different decisions, and the reader should know which one they are making.
 */
export function DeleteServerData({
  serverId,
  serverName,
  onClose,
  onDeleted,
}: {
  serverId: string;
  serverName: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [choice, setChoice] = useState<Choice>('day');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [pending, setPending] = useState<{ range: Range; calls: number }>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function ask(range: Range, dryRun: boolean): Promise<number | undefined> {
    setBusy(true);
    setNote(undefined);

    try {
      const response = await fetch(`/api/servers/${serverId}/data/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: range.from, to: range.to, dryRun }),
      });
      const body = (await response.json().catch(() => ({}))) as { calls?: number; error?: string };

      if (!response.ok || typeof body.calls !== 'number') {
        setNote(body.error ?? 'That did not work. Try again.');
        return undefined;
      }

      return body.calls;
    } catch {
      setNote('Could not reach the server.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function check(): Promise<void> {
    const range = rangeFor(choice, fromDay, toDay);

    if ('error' in range) {
      setNote(range.error);
      return;
    }

    const calls = await ask(range, true);

    if (calls === undefined) return;
    if (calls === 0) {
      setNote(range.said === '' ? `${serverName} has recorded nothing.` : `${serverName} recorded nothing ${range.said}.`);
      return;
    }

    setPending({ range, calls });
  }

  async function confirm(): Promise<void> {
    if (pending === undefined) return;

    const calls = await ask(pending.range, false);

    setPending(undefined);

    if (calls === undefined) return;

    setNote(`Deleted ${calls.toLocaleString('en-US')} ${calls === 1 ? 'call' : 'calls'}.`);
    onDeleted();
  }

  const count = pending?.calls.toLocaleString('en-US');

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border bg-surface p-3">
      <p className="text-sm text-ink">
        Delete what <strong>{serverName}</strong> recorded, and keep the server and its key.
      </p>

      {pending === undefined ? (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <select
              aria-label="What to delete"
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value as Choice);
                setNote(undefined);
              }}
              className={FIELD}
            >
              {CHOICES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {choice === 'dates' ? (
              <>
                <input
                  type="date"
                  aria-label="First day"
                  value={fromDay}
                  onChange={(event) => setFromDay(event.target.value)}
                  className={FIELD}
                />
                <input
                  type="date"
                  aria-label="Last day"
                  value={toDay}
                  onChange={(event) => setToDay(event.target.value)}
                  className={FIELD}
                />
              </>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void check()} disabled={busy}>
              {busy ? 'Counting...' : 'Continue'}
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Close
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-ink">
            {pending.range.said === ''
              ? `This deletes everything ${serverName} recorded: ${count} ${pending.calls === 1 ? 'call' : 'calls'}`
              : `This deletes ${count} ${pending.calls === 1 ? 'call' : 'calls'} ${serverName} recorded ${pending.range.said}`}
            , and their place in the charts. It cannot be undone.
          </p>
          <div className="flex gap-2">
            <Button onClick={() => void confirm()} disabled={busy} className="bg-status-critical text-white">
              {busy ? 'Deleting...' : `Delete ${count} ${pending.calls === 1 ? 'call' : 'calls'}`}
            </Button>
            <Button variant="secondary" onClick={() => setPending(undefined)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {note === undefined ? null : (
        <p role="status" className="text-sm text-ink-muted">
          {note}
        </p>
      )}
    </div>
  );
}
