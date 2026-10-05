import { createHash } from 'node:crypto';

/**
 * A tool's fingerprint as the contract defines it (3.8), written here apart
 * from any SDK: the suite checks each SDK against this, and this against the
 * shared cases in definition-hashes.json.
 */
export function definitionHash(tool: Record<string, unknown>): string {
  const hashed: Record<string, unknown> = {};
  for (const field of ['name', 'title', 'description', 'inputSchema']) {
    if (tool[field] !== undefined) hashed[field] = tool[field];
  }

  return createHash('sha256').update(canonical(hashed), 'utf8').digest('hex').slice(0, 16);
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    // Code point order; MCP's keys are ASCII, where it is also UTF-16 order.
    const keys = Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${text(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  throw new TypeError(`cannot fingerprint ${typeof value}`);
}

const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' };

function text(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += ESCAPES[character] ?? (code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character);
  }
  return `${out}"`;
}
