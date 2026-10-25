import type { Listing } from './listing.js';
import type { Finding, Report } from './rules.js';

export interface Style {
  color: boolean;
}

const paint = (style: Style, code: number, text: string) => (style.color ? `\u001b[${code}m${text}\u001b[0m` : text);
const red = (style: Style, text: string) => paint(style, 31, text);
const yellow = (style: Style, text: string) => paint(style, 33, text);
const dim = (style: Style, text: string) => paint(style, 2, text);
const bold = (style: Style, text: string) => paint(style, 1, text);

const plural = (count: number, one: string) => `${count.toLocaleString('en')} ${one}${count === 1 ? '' : 's'}`;

/**
 * The report for a person: what was checked, then the findings under each
 * tool in the order the server listed them, then the ones about the whole
 * listing, then the count.
 */
export function formatText(listing: Listing, report: Report, style: Style): string {
  const lines: string[] = [];
  const server = listing.server === undefined ? 'The listing' : `${listing.server.name} ${listing.server.version}`;

  lines.push(`${bold(style, server)}: ${plural(report.tools, 'tool')}, about ${plural(report.tokens, 'token')} of definitions in every session`);

  if (report.tools === 0) {
    lines.push('', 'The server offers no tools, so there is nothing to check.');
    return `${lines.join('\n')}\n`;
  }

  const byTool = new Map<string | undefined, Finding[]>();
  for (const finding of report.findings) byTool.set(finding.tool, [...(byTool.get(finding.tool) ?? []), finding]);

  const width = Math.max(0, ...report.findings.map((f) => f.rule.length));
  const line = (finding: Finding) => {
    const severity = finding.severity === 'error' ? red(style, 'error  ') : yellow(style, 'warning');
    const where = finding.argument === undefined ? '' : `${bold(style, finding.argument)}: `;

    return `  ${severity}  ${dim(style, finding.rule.padEnd(width))}  ${where}${finding.message}`;
  };

  for (const [tool, findings] of byTool) {
    if (tool === undefined) continue;
    lines.push('', bold(style, tool), ...findings.map(line));
  }

  const general = byTool.get(undefined);
  if (general !== undefined) lines.push('', bold(style, 'The listing'), ...general.map(line));

  lines.push('');
  if (report.findings.length === 0) {
    lines.push('Nothing to fix.');
  } else {
    const errors = report.errors === 0 ? plural(0, 'error') : red(style, plural(report.errors, 'error'));
    const warnings = report.warnings === 0 ? plural(0, 'warning') : yellow(style, plural(report.warnings, 'warning'));
    lines.push(`${errors}, ${warnings}`);
  }

  return `${lines.join('\n')}\n`;
}

/** The report for a machine: the same, with the server it came from. */
export function formatJson(listing: Listing, report: Report): string {
  return `${JSON.stringify({ ...(listing.server === undefined ? {} : { server: listing.server }), ...report }, null, 2)}\n`;
}
