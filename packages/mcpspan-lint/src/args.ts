import { parseArgs } from 'node:util';

/** Where the tools come from: a server started here, one already running, or a listing saved to a file. */
export type Target =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'http'; url: URL; headers: Record<string, string> }
  | { kind: 'file'; path: string };

export interface Options {
  target: Target;
  json: boolean;
  strict: boolean;
  timeoutMs: number;
}

export type Parsed = { ok: true; options: Options } | { ok: false; help: true } | { ok: false; help: false; error: string } | { ok: false; version: true };

export const USAGE = `Usage:
  mcpspan-lint [options] -- <command> [args...]   start a server over stdio and check it
  mcpspan-lint [options] <url>                    check a running server over HTTP
  mcpspan-lint [options] --file <listing.json>    check a saved tools/list answer

Options:
  --header "Name: value"  send this header to an HTTP server, e.g. for a token (repeatable)
  --json                  print the report as JSON
  --strict                fail on warnings too, not only on errors
  --timeout <seconds>     how long to wait for the server (default 30)
  -h, --help              show this
  -v, --version           show the version

Exits 0 when nothing breaks, 1 when the definitions have errors (or, with --strict, warnings),
and 2 when the server could not be checked.`;

/** The command line, split at the first "--": options and a URL before it, the server's command after. */
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
        header: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        strict: { type: 'boolean' },
        timeout: { type: 'string' },
        file: { type: 'string' },
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

  const timeout = values.timeout === undefined ? 30 : Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) return fail(`--timeout takes a number of seconds, not "${values.timeout}".`);

  const given = [command.length > 0, positionals.length > 0, values.file !== undefined].filter(Boolean).length;
  if (given === 0) return fail('Say which server to check: a command after --, a URL, or --file.');
  if (given > 1 || positionals.length > 1) return fail('Check one server at a time: a command after --, a URL, or --file.');

  const headers: Record<string, string> = {};
  for (const header of values.header ?? []) {
    const colon = header.indexOf(':');
    if (colon <= 0) return fail(`--header takes "Name: value", not "${header}".`);
    headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
  }

  let target: Target;
  if (command.length > 0) {
    target = { kind: 'stdio', command: command[0] as string, args: command.slice(1) };
  } else if (values.file !== undefined) {
    target = { kind: 'file', path: values.file };
  } else {
    const url = URL.canParse(positionals[0] as string) ? new URL(positionals[0] as string) : undefined;
    if (url === undefined || !['http:', 'https:'].includes(url.protocol)) {
      return fail(`"${positionals[0]}" is not an http or https URL. To start a server, put its command after --.`);
    }
    target = { kind: 'http', url, headers };
  }

  if (Object.keys(headers).length > 0 && target.kind !== 'http') return fail('--header is only for a server checked over HTTP.');

  return { ok: true, options: { target, json: values.json ?? false, strict: values.strict ?? false, timeoutMs: timeout * 1000 } };
}
