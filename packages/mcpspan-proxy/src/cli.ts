import { parse, USAGE } from './args.js';
import { startHttp } from './http.js';
import { startReporting } from './reporting.js';
import { runStdio, type StdioIo } from './stdio.js';
import { VERSION } from './version.js';

export interface Io extends StdioIo {
  /** Help and the version: stdout, since no server is running then. */
  out: (text: string) => void;
  /** Over HTTP, resolves when the proxy should stop: on SIGINT or SIGTERM, from the command line. */
  stopped?: Promise<void>;
}

/** How long, after the server has gone, the last events may take to send. */
const FINAL_DELIVERY_MS = 5_000;

/** One run, from the command line to the exit code to leave with. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const parsed = parse(argv, io.env);

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
  const { target } = options;
  const reporting = startReporting({ ...options, env: io.env, say: io.say });

  if (target.kind === 'stdio') {
    const code = await runStdio(target.command, target.args, reporting?.observer, io);
    await reporting?.stop(FINAL_DELIVERY_MS);
    return code;
  }

  let proxy;
  try {
    proxy = await startHttp(target, reporting?.observer, io.say);
  } catch (error) {
    io.say(`mcpspan-proxy: could not listen on ${target.host}:${target.port}: ${error instanceof Error ? error.message : String(error)}`);
    await reporting?.stop(FINAL_DELIVERY_MS);
    return 1;
  }

  io.say(
    `mcpspan-proxy ${VERSION}: listening on ${proxy.url}, passing to ${target.upstream.origin}` +
      (reporting === undefined ? '. No MCPSPAN_API_KEY, so nothing is reported.' : '.'),
  );
  await (io.stopped ?? new Promise<never>(() => undefined));
  await proxy.close();
  await reporting?.stop(FINAL_DELIVERY_MS);
  return 0;
}
