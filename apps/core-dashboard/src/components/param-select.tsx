'use client';

import { useRouter } from 'next/navigation';

import { type Params, withParams } from '@/lib/query';

/**
 * One choice kept in the address, for a control that belongs to a single card
 * rather than the whole page: a card's own client, or its order.
 *
 * Choosing sends the page back to the first page of that card's list, the
 * same way the page's filters drop every list's paging.
 */
export function ParamSelect({
  params,
  name,
  label,
  choices,
  anyLabel,
  resets = [],
  hash,
}: {
  params: Params;
  name: string;
  /** For screen readers; the selected option says the rest. */
  label: string;
  choices: { value: string; label: string }[];
  /** The option meaning "not set"; leave it out when one of the choices is the default. */
  anyLabel?: string;
  /** Parameters a new choice clears, such as the list's offset. */
  resets?: string[];
  /** Where the page lands, so a choice low on the page keeps it in view. */
  hash?: string;
}) {
  const router = useRouter();
  const value = params[name] ?? (anyLabel === undefined ? (choices[0]?.value ?? '') : '');

  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          const cleared = Object.fromEntries(resets.map((key) => [key, undefined]));
          router.push(
            `${withParams(params, { ...cleared, [name]: next === '' ? undefined : next })}${hash ?? ''}`,
            { scroll: hash === undefined },
          );
        }}
        className="h-8 rounded-lg border border-border bg-raised px-2 text-xs text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink"
      >
        {anyLabel === undefined ? null : <option value="">{anyLabel}</option>}
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}
