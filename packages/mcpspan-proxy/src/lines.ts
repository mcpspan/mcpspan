/**
 * Splits a stream of bytes into the lines of a stdio MCP connection: one
 * JSON-RPC message per line, as the specification has it.
 *
 * Only for looking at: the bytes themselves are passed on untouched before
 * this sees them. A line longer than the limit is skipped rather than held,
 * so one huge answer cannot grow the proxy's memory without bound; it goes
 * past unrecorded.
 */

/** The longest line read, in bytes. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

export class LineSplitter {
  private parts: Buffer[] = [];
  private length = 0;
  /** In a line over the limit, skipping to its end. */
  private skipping = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly maxBytes = MAX_LINE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0x0a, start);
      const piece = chunk.subarray(start, end === -1 ? chunk.length : end);

      if (!this.skipping) {
        if (this.length + piece.length > this.maxBytes) {
          this.skipping = true;
          this.parts = [];
          this.length = 0;
        } else if (piece.length > 0) {
          this.parts.push(piece);
          this.length += piece.length;
        }
      }

      if (end === -1) return;

      if (!this.skipping) this.emit();
      this.skipping = false;
      this.parts = [];
      this.length = 0;
      start = end + 1;
    }
  }

  private emit(): void {
    const line = Buffer.concat(this.parts, this.length).toString('utf8').trim();
    if (line.length > 0) this.onLine(line);
  }
}

/** A line as a message, or undefined when it is not JSON. */
export function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
