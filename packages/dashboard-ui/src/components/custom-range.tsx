'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { cn } from '../lib/cn';
import { customRangeValue, parseCustomRange } from '../lib/range';
import { Button } from './ui/button';

const FIELD =
  'h-10 rounded-lg border border-border bg-raised px-3 text-sm text-ink ' +
  'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink';

/** A day as a date input holds it, in the reader's own time zone: "2026-10-05". */
function dayValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

function isMidnight(date: Date): boolean {
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
}

/**
 * Choosing a window by its dates.
 *
 * Whole days in the reader's own time zone, the last one included: what
 * "from the 1st to the 5th" means to whoever picks it. The address carries
 * the two instants that works out to, so a link sent to somebody elsewhere
 * shows them the same window, labelled in their own hours.
 */
export function CustomRange({
  active,
  value,
  params,
}: {
  active: boolean;
  /** The current `range`, to start from the window already shown. */
  value: string | undefined;
  /** Everything else in the address, kept as it is. */
  params: Record<string, string>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [problem, setProblem] = useState<string>();

  /** Opens on the window already shown, or on the last seven days. */
  function toggle(): void {
    if (open) {
      setOpen(false);
      return;
    }

    const current = parseCustomRange(value);
    const today = new Date();

    if (current === undefined) {
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 6);
      setFirst(dayValue(weekAgo));
      setLast(dayValue(today));
    } else {
      setFirst(dayValue(current.from));
      // The end is the midnight after the last day; the last day is the one before it.
      setLast(dayValue(new Date(current.to.getTime() - 1)));
    }

    setProblem(undefined);
    setOpen(true);
  }

  function apply(): void {
    if (first === '' || last === '') {
      setProblem('Choose both days.');
      return;
    }

    const from = new Date(`${first}T00:00:00`);
    const to = new Date(`${last}T00:00:00`);
    to.setDate(to.getDate() + 1);

    if (to.getTime() <= from.getTime()) {
      setProblem('The last day cannot be before the first.');
      return;
    }

    const query = new URLSearchParams(params);
    query.set('range', customRangeValue(from, to));
    setOpen(false);
    setProblem(undefined);
    router.push(`?${query.toString()}`);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'rounded-md px-2.5 py-1 text-xs font-medium',
          'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
          active ? 'bg-surface text-ink' : 'text-ink-muted hover:text-ink',
        )}
      >
        Custom
      </button>

      {open ? (
        // On a phone the picker sits wherever the row wrapped it, so it spans
        // the screen inside the usual gutter rather than hanging off an edge.
        <div className="fixed inset-x-4 z-20 mt-2 space-y-3 rounded-lg border border-border bg-raised p-3 shadow-lg sm:absolute sm:inset-x-auto sm:right-0 sm:w-72">
          <label className="flex flex-col gap-1 text-sm text-ink">
            First day
            <input type="date" value={first} onChange={(event) => setFirst(event.target.value)} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-ink">
            Last day
            <input type="date" value={last} onChange={(event) => setLast(event.target.value)} className={FIELD} />
          </label>
          {problem === undefined ? null : (
            <p role="alert" className="text-sm text-status-critical">
              {problem}
            </p>
          )}
          <div className="flex gap-2">
            <Button onClick={apply}>Show</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A custom window's dates, in the reader's own time zone.
 *
 * Whole days read as days, "1 Oct - 5 Oct", the last one included; a window
 * that does not start and end at midnight here (a link from another time
 * zone) shows its hours too, rather than rounding to days it does not cover.
 */
export function LocalRange({ from, to }: { from: string; to: string }) {
  const [text, setText] = useState<string>();

  useEffect(() => {
    const start = new Date(from);
    const end = new Date(to);

    if (isMidnight(start) && isMidnight(end)) {
      const lastDay = new Date(end.getTime() - 1);
      const day = (date: Date) => date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

      setText(dayValue(start) === dayValue(lastDay) ? day(start) : `${day(start)} – ${day(lastDay)}`);
      return;
    }

    const moment = (date: Date) =>
      date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

    setText(`${moment(start)} – ${moment(end)}`);
  }, [from, to]);

  return <span title={`${from} – ${to}`}>{text ?? `${from.slice(0, 16)} – ${to.slice(0, 16)} UTC`}</span>;
}
