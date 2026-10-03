import type { InputHTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/**
 * A labelled input that can explain what is wrong with it.
 *
 * The label is tied to the input and the error is tied to both, so a screen
 * reader announces the problem when focus lands on the field rather than
 * leaving somebody to guess why the form refused. Colour is never the only
 * sign of an error: there is always a sentence.
 */
export function Field({
  id,
  label,
  error,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; error?: string }) {
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>

      <input
        id={id}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={error === undefined ? undefined : errorId}
        className={cn(
          'h-10 rounded-lg border bg-raised px-3 text-sm text-ink',
          'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
          error === undefined ? 'border-border' : 'border-status-critical',
          className,
        )}
        {...props}
      />

      {error === undefined ? null : (
        <p id={errorId} className="text-xs text-status-critical">
          {error}
        </p>
      )}
    </div>
  );
}
