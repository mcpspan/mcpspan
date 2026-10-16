import type { ReactNode } from 'react';

/**
 * What a page is and what it is showing.
 *
 * The same shape on every view, so somebody moving between them reads the
 * title in the same place each time instead of hunting for it.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle === undefined ? null : <p className="text-sm text-ink-muted">{subtitle}</p>}
      </div>

      {actions}
    </header>
  );
}
