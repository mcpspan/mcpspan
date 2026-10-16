import { Info } from 'lucide-react';

/**
 * A definition behind a small (i), for a number whose meaning is not obvious
 * from its label.
 *
 * Shown on hover and on focus, which is also what a tap on a phone gives, so
 * it needs no script. The text is tied to the button for a screen reader, so
 * the definition is announced rather than only drawn.
 */
export function InfoTip({
  id,
  about,
  children,
  align = 'end',
}: {
  id: string;
  about: string;
  children: string;
  /** Which way the text opens on a wide screen: toward the left from its end, or toward the right from its start. */
  align?: 'start' | 'end';
}) {
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
        // On a phone, a strip along the bottom of the screen: fixed, so no table that scrolls sideways cuts it off.
        className={`invisible absolute top-5 ${align === 'start' ? 'left-0' : 'right-0'} z-20 w-64 max-w-[calc(100vw-3rem)] max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:bottom-4 max-sm:w-auto max-sm:max-w-none rounded-lg border border-border bg-raised p-2.5 text-left text-xs font-normal tracking-normal text-ink normal-case opacity-0 shadow-md transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100`}
      >
        {children}
      </span>
    </span>
  );
}
