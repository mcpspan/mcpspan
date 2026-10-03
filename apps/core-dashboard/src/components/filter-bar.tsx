'use client';

import { X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import { clientLabel, ERROR_SOURCES, errorSourceInfo } from '@/lib/format';
import { type Params, withoutPaging, withParams } from '@/lib/query';

interface Choice {
  value: string;
  label: string;
}

/**
 * Narrowing the view to part of the data.
 *
 * The selects navigate on change, which needs the browser, but everything
 * they do ends up in the address: the result is a link somebody can send, and
 * the back button steps out of a filter the way it steps out of anything
 * else. The chips below are plain links, so clearing a filter works whether
 * or not any of this ran.
 */
export function FilterBar({
  params,
  tools,
  clients,
  showErrorSource = false,
  actions,
  matching,
}: {
  params: Params;
  tools: string[];
  clients: string[];
  /** Only the failure list has something to say about how a call failed. */
  showErrorSource?: boolean;
  /** Drawn at the far end of the row, such as a way to download what the filters select. */
  actions?: ReactNode;
  /** How many calls the filters select, already worded: "445 tool calls". */
  matching?: string;
}) {
  const router = useRouter();

  function change(key: string, value: string): void {
    router.push(
      withParams(withoutPaging(params), {
        [key]: value === '' ? undefined : value,
      }),
    );
  }

  const applied = [
    params['toolName'] === undefined ? undefined : { key: 'toolName', label: params['toolName'] },
    params['clientType'] === undefined
      ? undefined
      : { key: 'clientType', label: clientLabel(params['clientType']) },
    params['errorSource'] === undefined
      ? undefined
      : {
          key: 'errorSource',
          label: errorSourceInfo(params['errorSource']).label,
        },
    // Set by following a version from the versions table; there is no menu for it.
    params['serverVersion'] === undefined
      ? undefined
      : { key: 'serverVersion', label: `Version ${params['serverVersion']}` },
  ].filter((entry): entry is { key: string; label: string } => entry !== undefined);

  // Every narrowing the page offers, the choice links under it included.
  const narrowed = FILTER_KEYS.some((key) => params[key] !== undefined);

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          label="Tool"
          value={params['toolName'] ?? ''}
          onChange={(value) => change('toolName', value)}
          choices={tools.map((tool) => ({ value: tool, label: tool }))}
          anyLabel="All tools"
        />

        <Select
          label="Client"
          value={params['clientType'] ?? ''}
          onChange={(value) => change('clientType', value)}
          choices={clients.map((client) => ({
            value: client,
            label: clientLabel(client),
          }))}
          anyLabel="All clients"
        />

        {showErrorSource ? (
          <Select
            label="Failure"
            value={params['errorSource'] ?? ''}
            onChange={(value) => change('errorSource', value)}
            choices={ERROR_SOURCES.map(({ value, label }) => ({
              value,
              label,
            }))}
            anyLabel="Any failure"
          />
        ) : null}

        {applied.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {applied.map((filter) => (
              <Link
                key={filter.key}
                href={withParams(withoutPaging(params), {
                  [filter.key]: undefined,
                })}
                className="flex items-center gap-1 rounded-md border border-border bg-raised px-2 py-1 text-xs text-ink-muted outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              >
                {filter.label}
                <X aria-hidden className="size-3" />
                <span className="sr-only">Remove this filter</span>
              </Link>
            ))}
          </div>
        ) : null}
        {actions === undefined ? null : <div className="ml-auto">{actions}</div>}
      </div>

      {matching === undefined && !narrowed ? null : (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-ink-muted">
          {matching === undefined ? null : (
            <span>
              {matching} {narrowed ? 'match these filters' : 'in this window'}
            </span>
          )}
          {narrowed ? (
            <Link
              href={withParams(
                withoutPaging(params),
                Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined])),
              )}
              className="text-ink underline underline-offset-2"
            >
              Reset filters
            </Link>
          ) : null}
        </p>
      )}
    </div>
  );
}

/** What narrows a list, as opposed to where it is (server, window, page). */
const FILTER_KEYS = ['toolName', 'clientType', 'errorSource', 'outcome', 'kind', 'serverVersion'] as const;

function Select({
  label,
  value,
  onChange,
  choices,
  anyLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  choices: Choice[];
  anyLabel: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-ink-muted">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 rounded-lg border border-border bg-raised px-2 text-xs text-ink outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink"
      >
        <option value="">{anyLabel}</option>
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}
