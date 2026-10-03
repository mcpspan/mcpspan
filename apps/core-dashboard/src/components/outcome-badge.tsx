import { errorSourceInfo } from '@/lib/format';

/**
 * How a call ended, as a coloured label.
 *
 * The colours carry the distinction that matters. MCP asks tools to answer
 * with an error rather than throw, so a reported failure is usually the tool
 * working as written - "no flights found" is not a bug - and is marked amber.
 * An exception is the handler falling over, nearly always something to fix,
 * and is red. Invalid arguments, and tools, resources or prompts the server
 * does not have, are the agent getting the server wrong, which is about
 * descriptions, not code: neutral. The word is always there too, so colour is
 * never the only sign.
 */
export function OutcomeBadge({
  success,
  source,
  kind,
}: {
  success: boolean;
  source: string | null;
  kind?: string;
}) {
  const [label, tone] = success
    ? ['Succeeded', 'bg-status-good/10 text-status-good']
    : source === 'exception'
      ? [errorSourceInfo(source, kind).label, 'bg-status-critical/10 text-status-critical']
      : source === 'result'
        ? [errorSourceInfo(source, kind).label, 'bg-status-warning/15 text-status-warning-ink']
        : [source === null ? 'Failed' : errorSourceInfo(source, kind).label, 'bg-surface text-ink-muted'];

  return (
    <span className={`inline-block rounded-md px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}>
      {label}
    </span>
  );
}
