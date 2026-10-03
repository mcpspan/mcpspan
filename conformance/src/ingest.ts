import { createServer, type IncomingMessage, type Server } from 'node:http';

/** One request the SDK made, as the fake ingest API received it. */
export interface Received {
  at: number;
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  /** The raw body, for checks that no value appears anywhere in it. */
  raw: string;
  events: Record<string, unknown>[];
  /** What the fake answered. */
  status: number;
}

export interface Answer {
  status: number;
  headers?: Record<string, string>;
}

/**
 * Stands in for the ingest API.
 *
 * Records every request and answers each however the case under test needs:
 * accepted by default, or a refusal chosen by the request's position.
 */
export class FakeIngest {
  readonly requests: Received[] = [];

  private server: Server | undefined;

  private answer: (index: number, received: Received) => Answer = () => ({ status: 202 });

  /** Decides the answer to each request, by its position and content. */
  answerWith(answer: (index: number, received: Received) => Answer): void {
    this.answer = answer;
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      request.on('end', () => {
        let events: Record<string, unknown>[] = [];

        try {
          const parsed = JSON.parse(raw) as { events?: Record<string, unknown>[] };
          events = parsed.events ?? [];
        } catch {
          // Recorded as received; a case can assert on the raw body.
        }

        const received: Received = {
          at: Date.now(),
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          raw,
          events,
          status: 0,
        };
        const answer = this.answer(this.requests.length, received);
        received.status = answer.status;
        this.requests.push(received);

        response.writeHead(answer.status, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        response.end(
          JSON.stringify(
            answer.status === 202 ? { accepted: events.length, stored: events.length } : {},
          ),
        );
      });
    });

    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));

    const address = this.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server === undefined) return resolve();
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  /** Every event in requests the fake accepted, in the order they arrived. */
  get accepted(): Record<string, unknown>[] {
    return this.requests.flatMap((request) => (request.status === 202 ? request.events : []));
  }

  /** Every event in every request, accepted or not. */
  get sent(): Record<string, unknown>[] {
    return this.requests.flatMap((request) => request.events);
  }
}
