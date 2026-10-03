import { Download } from 'lucide-react';

import { type Params, withParams } from '@/lib/query';

/**
 * Links that download what a view shows, in the same window and filters.
 *
 * Plain anchors rather than client-side navigation: these are files, and the
 * browser has to be the one to fetch and save them.
 */
export function DownloadLinks({
  label,
  links,
}: {
  label: string;
  links: { text: string; kind: 'calls' | 'tools'; params: Params }[];
}) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
      <Download aria-hidden className="size-3.5" />
      <span>{label}</span>
      {links.map((link) => (
        <a
          key={link.text}
          href={`/api/export/${link.kind}${withParams(link.params, {})}`}
          download
          className="text-ink underline underline-offset-2"
        >
          {link.text}
        </a>
      ))}
    </p>
  );
}
