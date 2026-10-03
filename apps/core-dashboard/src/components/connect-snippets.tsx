'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import type { SnippetLanguage } from '@/lib/snippets';
import { Copyable } from './copyable';

/** Where the last choice is kept, so the page opens on the reader's language. */
const STORAGE_KEY = 'mcpspan.connect';

interface Choice {
  language: string;
  /** The MCP SDK chosen within each language that has more than one. */
  variants: Record<string, string>;
}

/**
 * The line that connects a server, one language at a time, and within a
 * language one MCP SDK at a time.
 *
 * Nine blocks of code one under the other asked everybody to find theirs;
 * tabs show the one they came for. The choice is remembered in this browser
 * only, as a convenience: nothing depends on it, and a browser that keeps
 * nothing opens on TypeScript.
 */
export function ConnectSnippets({ languages }: { languages: SnippetLanguage[] }) {
  const [choice, setChoice] = useState<Choice>({ language: languages[0]?.id ?? '', variants: {} });

  // Read after the first render, so the page the server sent and the one
  // the browser shows first are the same.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Choice | null;
      if (saved && languages.some((language) => language.id === saved.language)) {
        setChoice({ language: saved.language, variants: saved.variants ?? {} });
      }
    } catch {
      // Storage can be refused or hold something else; the default stands.
    }
  }, [languages]);

  function choose(next: Choice): void {
    setChoice(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; nothing else changes.
    }
  }

  const language = languages.find((candidate) => candidate.id === choice.language) ?? languages[0];
  if (!language) return null;
  const variant =
    language.variants.find((candidate) => candidate.id === choice.variants[language.id]) ?? language.variants[0];
  if (!variant) return null;

  const snippet = (
    <Snippet language={language} variant={variant.id} code={variant.code} note={variant.note} />
  );

  return (
    <Tabs
      label="Language"
      options={languages.map(({ id, label }) => ({ id, label }))}
      selected={language.id}
      onSelect={(id) => choose({ ...choice, language: id })}
    >
      {language.variants.length > 1 ? (
        <Tabs
          label={`${language.label} MCP SDK`}
          size="small"
          options={language.variants.map(({ id, label }) => ({ id, label }))}
          selected={variant.id}
          onSelect={(id) => choose({ ...choice, variants: { ...choice.variants, [language.id]: id } })}
        >
          {snippet}
        </Tabs>
      ) : (
        snippet
      )}
    </Tabs>
  );
}

function Snippet({
  language,
  variant,
  code,
  note,
}: {
  language: SnippetLanguage;
  variant: string;
  code: string;
  note: string | undefined;
}) {
  const named = language.variants.find((candidate) => candidate.id === variant)?.label;

  return (
    <>
      <Copyable text={code} label={named ? `${language.label} snippet for ${named}` : `${language.label} snippet`} />
      {note ? <p className="mt-2 text-xs text-ink-muted">{note}</p> : null}
    </>
  );
}

/**
 * A row of tabs, as the WAI-ARIA tabs pattern has them: one tab in the tab
 * order, arrow keys, Home and End to move between them, and choosing as the
 * focus moves.
 */
function Tabs({
  label,
  options,
  selected,
  onSelect,
  children,
  size = 'normal',
}: {
  label: string;
  options: { id: string; label: string }[];
  selected: string;
  onSelect: (id: string) => void;
  children: ReactNode;
  size?: 'normal' | 'small';
}) {
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const index = options.findIndex((option) => option.id === selected);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % options.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + options.length) % options.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : -1;
    const target = options[next];
    if (!target) return;
    event.preventDefault();
    onSelect(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn(
          'flex flex-wrap gap-1 rounded-lg border border-border bg-raised p-1',
          size === 'small' && 'inline-flex',
        )}
      >
        {options.map((option) => {
          const active = option.id === selected;
          return (
            <button
              key={option.id}
              ref={(element) => {
                refs.current[option.id] = element;
              }}
              id={tabId(option.id)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(option.id)}
              className={cn(
                'rounded-md font-medium outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink',
                size === 'small' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs',
                active ? 'bg-surface text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" aria-labelledby={tabId(selected)} id={panelId} className="mt-3">
        {children}
      </div>
    </>
  );
}
