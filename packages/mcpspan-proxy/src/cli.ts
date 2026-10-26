import { parse, USAGE } from './args.js';
import { startReporting } from './reporting.js';
import { runStdio, type StdioIo } from './stdio.js';
import { VERSION } from './version.js';

export interface Io extends StdioIo {
  /** Help and the version: stdout, since no server is running then. */
  out: (text: string) => void;
}

/** How long, after the server has gone, the last events may take to send. */
const FINAL_DELIVERY_MS = 5_000;

/** One run, from the command line to the exit code to leave with. */
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
    io.say(`mcpspan-proxy: ${parsed.error}\n\n${USAGE}`);
    return 2;
  }

  const { options } = parsed;
  const reporting = startReporting({ ...options, env: io.env, say: io.say });
  const code = await runStdio(options.command, options.args, reporting?.observer, io);
  await reporting?.stop(FINAL_DELIVERY_MS);

  return code;
}
