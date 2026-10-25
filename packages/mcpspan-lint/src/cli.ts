import { parse, USAGE } from './args.js';
import { fetchListing, ListingError } from './listing.js';
import { formatJson, formatText } from './output.js';
import { lint } from './rules.js';
import { VERSION } from './version.js';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Whether the report may be coloured: a terminal, and NO_COLOR not set. */
  color: boolean;
}

/** One run, from the command line to the exit code: 0 nothing breaks, 1 something to fix, 2 nothing could be checked. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parse(argv);

  if (!parsed.ok) {
    if ('version' in parsed) {
      io.out(`${VERSION}\n`);
      return 0;
    }
    if (parsed.help) {
      io.out(`${USAGE}\n`);
      return 0;
    }
    io.err(`mcpspan-lint: ${parsed.error}\n\n${USAGE}\n`);
    return 2;
  }

  const { options } = parsed;
  let listing;
  try {
    listing = await fetchListing(options.target, options.timeoutMs);
  } catch (error) {
    if (!(error instanceof ListingError)) throw error;
    io.err(`mcpspan-lint: ${error.message}\n`);
    if (error.stderr !== undefined) io.err(`\nThe server wrote:\n${error.stderr}\n`);
    return 2;
  }

  const report = lint(listing.tools);
  io.out(options.json ? formatJson(listing, report) : formatText(listing, report, { color: io.color }));

  return report.errors > 0 || (options.strict && report.warnings > 0) ? 1 : 0;
}
