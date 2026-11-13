import type { ReleaseReport, ReleaseVerdict } from '../lib/api';
import { formatCount, formatDuration, formatRate } from '../lib/format';

/** The verdict in words, and the colour it is said in. */
export const VERDICTS: Record<ReleaseVerdict, { label: string; tone: string }> = {
  worse: { label: 'Worse', tone: 'bg-status-critical/10 text-status-critical' },
  better: { label: 'Better', tone: 'bg-status-good/10 text-status-good' },
  same: { label: 'About the same', tone: 'bg-border/60 text-ink' },
  'too-early': { label: 'Too early to tell', tone: 'bg-border/60 text-ink-muted' },
  first: { label: 'First version', tone: 'bg-border/60 text-ink-muted' },
};

/** The verdict as a label in its colour. */
export function VerdictBadge({ verdict, small = false }: { verdict: ReleaseVerdict; small?: boolean }) {
  return (
    <span
      className={`shrink-0 rounded-md font-semibold ${small ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'} ${VERDICTS[verdict].tone}`}
    >
      {VERDICTS[verdict].label}
    </span>
  );
}

/** Why: whichever of errors and the slowest calls decided the verdict, said first. */
export function verdictSentence(report: ReleaseReport): string {
  const { before, after } = report.overall;

  if (before === null) {
    return `Nothing to compare it with: no earlier version was seen. ${formatCount(after.calls)} calls so far.`;
  }

  if (report.verdict === 'too-early') {
    return `${formatCount(after.calls)} call${after.calls === 1 ? '' : 's'} so far against ${formatCount(before.calls)} before; a verdict needs 50 on each side.`;
  }

  const errors = `errors ${formatRate(before.errorRate)}% → ${formatRate(after.errorRate)}%`;
  const slowest = `slowest calls (p95) ${duration(before.durationMs.p95)} → ${duration(after.durationMs.p95)}`;
  const errorsMoved = Math.abs(after.errorRate - before.errorRate) >= 0.01;

  // The reason first: whichever of the two decided the verdict.
  if (report.verdict === 'same') return `No clear change: ${errors}, ${slowest}.`;

  return errorsMoved && Math.sign(after.errorRate - before.errorRate) === (report.verdict === 'worse' ? 1 : -1)
    ? `${capitalise(errors)}; ${slowest}.`
    : `${capitalise(slowest)}; ${errors}.`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function duration(ms: number | null): string {
  const { value, unit } = formatDuration(ms);

  return `${value}${unit}`;
}

