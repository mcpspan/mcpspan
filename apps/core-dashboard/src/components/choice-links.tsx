import Link from 'next/link';

import { cn } from '@/lib/cn';
import { type Params, withoutPaging, withParams } from '@/lib/query';

/**
 * A few mutually exclusive choices kept in the address, drawn like the range
 * picker: links rather than buttons, so a choice survives a reload and the
 * back button undoes it.
 */
export function ChoiceLinks({
  label,
  name,
  choices,
  params,
}: {
  /** What the choice is about, for a screen reader. */
  label: string;
  /** The query parameter it sets; the first choice leaves it out. */
  name: string;
  choices: { value: string | undefined; text: string }[];
  params: Params;
}) {
  const current = params[name];

  return (
    <nav aria-label={label} className="flex w-fit flex-wrap gap-1 rounded-lg border border-border bg-raised p-1">
      {choices.map((choice) => {
        const active = choice.value === current;

        return (
          <Link
            key={choice.text}
            // A different choice is a different list, so it starts from its first page.
            href={withParams(withoutPaging(params), { [name]: choice.value })}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium',
              'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
              active ? 'bg-surface text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {choice.text}
          </Link>
        );
      })}
    </nav>
  );
}
