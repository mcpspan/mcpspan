import Link from 'next/link';

import { formatCount } from '@/lib/format';
import { type Params, type PAGING_PARAMS, withParams } from '@/lib/query';

type PagingParam = (typeof PAGING_PARAMS)[number];

const LINK = 'text-ink underline underline-offset-2';

/**
 * Previous and next for a ranked list, kept in the address.
 *
 * In the address so a page can be linked to and survives a refresh, and so
 * the back button goes back a page. Hidden entirely when the list fits.
 */
export function OffsetPager({
  params,
  name,
  offset,
  limit,
  hasMore,
  total,
  hash,
}: {
  params: Params;
  /** Which list this is, so paging it leaves the others where they are. */
  name: PagingParam;
  offset: number;
  limit: number;
  hasMore: boolean;
  /** Shown as "11 to 20 of 57" when the list's length is known. */
  total?: number;
  /** Keeps the view on this list after the page loads. */
  hash?: string;
}) {
  if (offset === 0 && !hasMore) return null;

  const link = (to: number) =>
    `${withParams(params, { [name]: to === 0 ? undefined : String(to) })}${hash ?? ''}`;
  const last = offset + limit;

  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
      {offset > 0 ? (
        <Link href={link(Math.max(0, offset - limit))} className={LINK}>
          Previous
        </Link>
      ) : null}
      {hasMore ? (
        <Link href={link(offset + limit)} className={LINK}>
          Next
        </Link>
      ) : null}
      <span className="text-ink-muted">{describePosition(offset, last, total)}</span>
    </nav>
  );
}

function describePosition(offset: number, last: number, total: number | undefined): string {
  const first = formatCount(offset + 1);

  if (total === undefined) return `From ${first}`;

  return `${first} to ${formatCount(Math.min(last, total))} of ${formatCount(total)}`;
}

/**
 * Onwards through a list that only grows, by a marker the API handed back.
 *
 * No numbered pages and no way to step back one: a cursor says where to
 * carry on from, not where page three starts. "Back to the start" covers
 * what stepping back is usually for.
 */
export function CursorPager({
  params,
  name,
  cursor,
  onwardLabel,
  startLabel,
}: {
  params: Params;
  name: 'before' | 'after';
  /** From the API; null when there is nothing further. */
  cursor: string | null;
  onwardLabel: string;
  startLabel: string;
}) {
  const started = params[name] !== undefined;

  if (!started && cursor === null) return null;

  return (
    <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-x-4 text-xs">
      {started ? (
        <Link href={withParams(params, { [name]: undefined })} className={LINK}>
          {startLabel}
        </Link>
      ) : null}
      {cursor === null ? (
        <span className="text-ink-muted">That is all of them.</span>
      ) : (
        <Link href={withParams(params, { [name]: cursor })} className={LINK}>
          {onwardLabel}
        </Link>
      )}
    </nav>
  );
}
