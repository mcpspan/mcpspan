import { parseArgs } from 'node:util';

/** The server: one started here and spoken to over stdio, or one already listening over HTTP. */
export type Target =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'http'; upstream: URL; host: string; port: number };

export interface Options {
  target: Target;
  /** Tools left out of the numbers (contract, 3.3). */
  exclude: string[];
  captureParameterNames: boolean;
  captureErrorMessages: boolean;
  /** How long a partly filled batch waits before it is sent anyway; the SDK's default when absent. */
  flushIntervalMs?: number;
  debug: boolean;
}

export type Parsed =
  | { ok: true; options: Options }
  | { ok: false; help: true }
  | { ok: false; version: true }
  | { ok: false; help: false; error: string };

/** Where the HTTP proxy listens when not told: 6270 is the dashboard, 6271 the API, 6272 the database. */
export const DEFAULT_PORT = 6273;

export const USAGE = `Usage:
  mcpspan-proxy [options] -- <command> [args...]   run a stdio MCP server and report its calls to mcpspan
  mcpspan-proxy [options] <url>                    stand in front of an MCP server over HTTP and report its calls

Reads MCPSPAN_API_KEY, MCPSPAN_ENDPOINT and, if set, MCPSPAN_SERVER_VERSION from the environment.
Without an API key it passes everything through and reports nothing.

Options:
  --port <port>          HTTP: where to listen (default ${DEFAULT_PORT})
  --host <address>       HTTP: which address to listen on (default 127.0.0.1, or MCPSPAN_PROXY_HOST)
  --exclude <tool>       leave this tool out of the numbers (repeatable)
  --parameter-names      record the names and types of arguments, never their values
  --no-error-messages    leave out the text of failures
  --flush-interval <s>   how long a partly filled batch waits before it is sent (default 5)
  --debug                write delivery diagnostics to stderr
  -h, --help             show this
  -v, --version          show the version`;

/** The command line, split at the first "--": the proxy's options before it, the server's command after. */
export function parse(argv: readonly string[], env: NodeJS.ProcessEnv = {}): Parsed {
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
        port: { type: 'string' },
        host: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        'parameter-names': { type: 'boolean' },
        'no-error-messages': { type: 'boolean' },
        'flush-interval': { type: 'string' },
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

  const flush = values['flush-interval'] === undefined ? undefined : Number(values['flush-interval']);
  if (flush !== undefined && !(Number.isFinite(flush) && flush > 0)) {
    return fail(`--flush-interval takes a number of seconds, not "${values['flush-interval']}".`);
  }

  const [program, ...args] = command;
  // A command given without the --: say how to give it.
  if (positionals.some((positional) => !URL.canParse(positional))) {
    return fail(`A server over stdio goes after --, as in: mcpspan-proxy -- ${positionals.join(' ')}`);
  }
  if (program !== undefined && positionals.length > 0) return fail('Proxy one server at a time: a command after --, or a URL.');
  if (positionals.length > 1) return fail('Proxy one server at a time: a command after --, or a URL.');

  let target: Target;
  const [url] = positionals;
  if (url !== undefined) {
    const upstream = new URL(url);
    if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') return fail(`"${url}" is not an http or https URL.`);

    const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) return fail(`--port takes a port number, not "${values.port}".`);
    const host = values.host ?? (env['MCPSPAN_PROXY_HOST']?.trim() || '127.0.0.1');

    target = { kind: 'http', upstream, host, port };
  } else if (program !== undefined) {
    if (values.port !== undefined || values.host !== undefined) return fail('--port and --host are for a server over HTTP, not one run over stdio.');
    target = { kind: 'stdio', command: program, args };
  } else {
    return fail('Say which server to proxy: its command after --, or its URL.');
  }

  return {
    ok: true,
    options: {
      target,
      exclude: values.exclude ?? [],
      captureParameterNames: values['parameter-names'] === true,
      captureErrorMessages: values['no-error-messages'] !== true,
      ...(flush !== undefined && { flushIntervalMs: Math.max(1, Math.round(flush * 1000)) }),
      debug: values.debug === true,
    },
  };
}
