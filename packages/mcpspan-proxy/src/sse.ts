/**
 * Reads the messages out of a server-sent event stream, as Streamable HTTP
 * carries them: each event's `data` lines, joined, are one JSON-RPC message.
 *
 * Only for looking at, as LineSplitter is: the stream itself has already been
 * passed on. Events, comments and ids other than the data are of no interest.
 */

import { LineSplitter, MAX_LINE_BYTES } from './lines.js';

export class EventStreamReader {
  private readonly lines: LineSplitter;
  private data: string[] = [];
  private size = 0;

  constructor(private readonly onData: (data: string) => void) {
    // Blank lines end an event, so they have to reach this.
    this.lines = new LineSplitter((line) => this.line(line), MAX_LINE_BYTES, true);
  }

  push(chunk: Buffer): void {
    this.lines.push(chunk);
  }

  /** The stream ended: an event not closed by a blank line is dropped, as a browser drops it. */
  end(): void {
    this.data = [];
    this.size = 0;
  }

  private line(line: string): void {
    if (line === '') {
      if (this.data.length > 0) this.onData(this.data.join('\n'));
      this.data = [];
      this.size = 0;
      return;
    }
    if (!line.startsWith('data')) return;
    if (line !== 'data' && line[4] !== ':') return;

    let value = line.slice(5);
    if (value.startsWith(' ')) value = value.slice(1);
    this.size += value.length;
    if (this.size > MAX_LINE_BYTES) return;
    this.data.push(value);
  }
}
