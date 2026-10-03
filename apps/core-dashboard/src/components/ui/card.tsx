import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** A raised surface holding one idea. */
export function Card({
  className,
  children,
  id,
}: {
  className?: string;
  children: ReactNode;
  /** For linking to this card from another page. */
  id?: string;
}) {
  return (
    <section
      id={id}
      className={cn(
        'scroll-mt-6 rounded-xl border border-border bg-raised p-5 shadow-xs',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    // Side by side where there is room; on a phone the hint goes under the
    // title rather than squeezing both into two cramped columns.
    <header className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <h2 className="text-sm font-medium text-ink">{title}</h2>
      {hint === undefined ? null : <p className="text-xs text-ink-muted">{hint}</p>}
    </header>
  );
}
