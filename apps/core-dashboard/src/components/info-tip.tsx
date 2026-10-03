import { Info } from 'lucide-react';

/**
 * A definition behind a small (i), for a number whose meaning is not obvious
 * from its label.
 *
 * Shown on hover and on focus, which is also what a tap on a phone gives, so
 * it needs no script. The text is tied to the button for a screen reader, so
 * the definition is announced rather than only drawn.
 */
export function InfoTip({ id, about, children }: { id: string; about: string; children: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`What ${about} means`}
        aria-describedby={id}
        className="rounded-full text-ink-muted outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        <Info aria-hidden className="size-3.5" />
      </button>
      <span
        role="tooltip"
        id={id}
        className="invisible absolute top-5 right-0 z-20 w-64 max-w-[calc(100vw-3rem)] rounded-lg border border-border bg-raised p-2.5 text-xs font-normal tracking-normal text-ink normal-case opacity-0 shadow-md transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        {children}
      </span>
    </span>
  );
}
