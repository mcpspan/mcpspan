'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/**
 * A block of text with a button that copies it.
 *
 * Worth the interactivity: the alternative is somebody selecting four lines of
 * code with a mouse and missing the last character, then spending a while
 * finding out why their key is refused.
 */
export function Copyable({
  text,
  label,
  wrap = false,
}: {
  text: string;
  label: string;
  /** Breaks anywhere instead of scrolling: for a key, which has no line to keep whole and is read to the end. */
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access can be refused, and there is nothing useful to say
      // about it: the text is on screen and can still be selected.
    }
  }

  return (
    // The button beside the code rather than over it: a long line scrolls
    // sideways, and on a phone it used to slide under the button.
    <div className="flex items-start rounded-lg bg-surface">
      <pre
        className={`min-w-0 flex-1 p-3 font-mono text-xs text-ink ${wrap ? 'break-all whitespace-pre-wrap' : 'overflow-x-auto'}`}
      >
        {text}
      </pre>

      <button
        type="button"
        onClick={copy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        className="m-2 shrink-0 rounded-md border border-border bg-raised p-1.5 text-ink-muted outline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
      >
        {copied ? (
          <Check aria-hidden className="size-3.5 text-status-good" />
        ) : (
          <Copy aria-hidden className="size-3.5" />
        )}
      </button>
    </div>
  );
}
