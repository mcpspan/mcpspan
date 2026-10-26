import { EventReporter } from '../../mcpspan/src/reporter.js';

import { Observer } from './observer.js';
import { VERSION } from './version.js';

export interface ReportingOptions {
  exclude: readonly string[];
  captureParameterNames: boolean;
  captureErrorMessages: boolean;
  flushIntervalMs?: number | undefined;
  debug: boolean;
  env: NodeJS.ProcessEnv;
  /** Where diagnostics go: stderr, never stdout, which carries the protocol. */
  say: (message: string) => void;
}

export interface Reporting {
  observer: Observer;
  /** Sends what is still queued, waiting at most `timeoutMs`. */
  stop(timeoutMs: number): Promise<void>;
}

/**
 * The observer and where its events go, set up as the SDKs set themselves up
 * (contract, 2): from MCPSPAN_API_KEY and MCPSPAN_ENDPOINT, doing nothing at
 * all without a key, and saying once that nothing is collected when there is
 * a key and no endpoint.
 */
export function startReporting(options: ReportingOptions): Reporting | undefined {
  const apiKey = nonEmpty(options.env['MCPSPAN_API_KEY']);
  if (apiKey === undefined) return undefined;

  const endpoint = nonEmpty(options.env['MCPSPAN_ENDPOINT']);
  if (endpoint === undefined) {
    options.say(
      'mcpspan-proxy: an API key is set but no endpoint, so nothing is collected. Set MCPSPAN_ENDPOINT to your mcpspan installation, for example http://localhost:6271.',
    );
    return undefined;
  }

  const reporter = new EventReporter({
    apiKey,
    endpoint,
    debug: options.debug,
    onDiagnostic: options.say,
    userAgent: `mcpspan/${VERSION} (proxy)`,
    ...(options.flushIntervalMs !== undefined && { flushIntervalMs: options.flushIntervalMs }),
  });
  const observer = new Observer({
    record: (event) => reporter.record(event),
    serverVersion: nonEmpty(options.env['MCPSPAN_SERVER_VERSION']),
    exclude: options.exclude,
    captureParameterNames: options.captureParameterNames,
    captureErrorMessages: options.captureErrorMessages,
  });

  // In the background: the server starts without waiting for the network.
  void reporter.announce();

  return {
    observer,
    stop: (timeoutMs) =>
      new Promise<void>((done) => {
        const timer = setTimeout(done, timeoutMs);
        void reporter.stop().finally(() => {
          clearTimeout(timer);
          done();
        });
      }),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
