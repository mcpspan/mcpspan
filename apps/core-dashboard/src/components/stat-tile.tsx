import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Minus,
  XCircle,
} from 'lucide-react';

import type { Change } from '@/lib/compare';
import { InfoTip } from './info-tip';

type Tone = 'neutral' | 'good' | 'warning' | 'critical';

const BADGE = {
  good: { Icon: CheckCircle2, className: 'text-status-good' },
  warning: { Icon: AlertTriangle, className: 'text-status-warning-ink' },
  critical: { Icon: XCircle, className: 'text-status-critical' },
} as const;

/**
 * One headline number.
 *
 * A number is not a chart, and the four figures a dashboard leads with are
 * better read than plotted: a bar chart of four unrelated measures makes a
 * reader decode a picture to recover something they could have been told.
 *
 * The value itself is always in ink, never in a status colour. Two reasons,
 * and the second only showed up once this was rendered and looked at: text
 * carrying meaning has to clear a contrast floor, and the warning step sits
 * below it on a light surface by design - a yellow headline was legible in
 * dark mode and washed out in light. A state is carried by a word and an icon
 * beside the number, which survives being printed, being read by somebody who
 * cannot separate the hues, and being looked at in either mode.
 */
export function StatTile({
  label,
  value,
  unit,
  note,
  status,
  tone = 'neutral',
  change,
  definition,
}: {
  label: string;
  /** What the number counts, exactly, behind an (i) beside the label. */
  definition?: string;
  value: string;
  unit?: string;
  note?: string;
  /** Short word for the state, shown beside the number. Required by a tone. */
  status?: string;
  tone?: Tone;
  /**
   * Movement against the window before, already worded. Its colour is on the
   * arrow only; the words say the same thing for anybody who cannot see it.
   */
  change?: { change: Change | null; comparedTo: string; showMissing?: boolean };
}) {
  const badge = tone === 'neutral' ? undefined : BADGE[tone];

  return (
    <div className="rounded-xl border border-border bg-raised p-5 shadow-xs">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
        {definition === undefined ? null : (
          <InfoTip id={`about-${label.toLowerCase().replaceAll(' ', '-')}`} about={label.toLowerCase()}>
            {definition}
          </InfoTip>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="flex items-baseline gap-1">
          <span className="text-3xl font-semibold tabular-nums text-ink">{value}</span>
          {unit === undefined ? null : <span className="text-sm text-ink-muted">{unit}</span>}
        </p>

        {badge === undefined || status === undefined ? null : (
          <span className={`flex items-center gap-1 text-xs font-medium ${badge.className}`}>
            <badge.Icon aria-hidden className="size-3.5" />
            {status}
          </span>
        )}
      </div>

      {note === undefined ? null : <p className="mt-1 text-xs text-ink-muted">{note}</p>}

      {change === undefined ? null : <ChangeLine {...change} />}
    </div>
  );
}

const CHANGE_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;

const CHANGE_COLOUR = {
  good: 'text-status-good',
  bad: 'text-status-critical',
  neutral: 'text-ink-muted',
} as const;

function ChangeLine({
  change,
  comparedTo,
  showMissing = false,
}: {
  change: Change | null;
  comparedTo: string;
  showMissing?: boolean;
}) {
  if (change === null) {
    // Said once, on the card where it makes sense, rather than as "no data"
    // under every figure.
    return showMissing ? (
      <p className="mt-1 text-xs text-ink-muted">Nothing to compare with in {comparedTo}</p>
    ) : null;
  }

  const Icon = CHANGE_ICON[change.direction];

  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-ink-muted">
      <Icon aria-hidden className={`size-3.5 shrink-0 ${CHANGE_COLOUR[change.tone]}`} />
      {change.direction === 'flat'
        ? `No change from ${comparedTo}`
        : `${change.text} than ${comparedTo}`}
    </p>
  );
}
