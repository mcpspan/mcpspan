import { parseArgs } from 'node:util';

export interface Options {
  /** The server, started here and spoken to over stdio. */
  command: string;
  args: string[];
  /** Tools left out of the numbers (contract, 3.3). */
  exclude: string[];
  captureParameterNames: boolean;
  captureErrorMessages: boolean;
  debug: boolean;
}

export type Parsed =
  | { ok: true; options: Options }
  | { ok: false; help: true }
  | { ok: false; version: true }
  | { ok: false; help: false; error: string };

export const USAGE = `Usage:
  mcpspan-proxy [options] -- <command> [args...]   run a stdio MCP server and report its calls to mcpspan

Reads MCPSPAN_API_KEY, MCPSPAN_ENDPOINT and, if set, MCPSPAN_SERVER_VERSION from the environment.
Without an API key it passes everything through and reports nothing.

Options:
  --exclude <tool>       leave this tool out of the numbers (repeatable)
  --parameter-names      record the names and types of arguments, never their values
  --no-error-messages    leave out the text of failures
  --debug                write delivery diagnostics to stderr
  -h, --help             show this
  -v, --version          show the version`;

/** The command line, split at the first "--": the proxy's options before it, the server's command after. */
export function parse(argv: readonly string[]): Parsed {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);

  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: [...own],
      allowPositionals: true,
      options: {
        exclude: { type: 'string', multiple: true },
        'parameter-names': { type: 'boolean' },
        'no-error-messages': { type: 'boolean' },
        debug: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (error) {
    return { ok: false, help: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (values.help) return { ok: false, help: true };
  if (values.version) return { ok: false, version: true };

  const fail = (error: string): Parsed => ({ ok: false, help: false, error });

  if (positionals.length > 0) return fail(`Put the server's command after --, as in: mcpspan-proxy -- ${positionals.join(' ')}`);
  const [program, ...args] = command;
  if (program === undefined) return fail("Say which server to run: its command after --.");

  return {
    ok: true,
    options: {
      command: program,
      args,
      exclude: values.exclude ?? [],
      captureParameterNames: values['parameter-names'] === true,
      captureErrorMessages: values['no-error-messages'] !== true,
      debug: values.debug === true,
    },
  };
}
