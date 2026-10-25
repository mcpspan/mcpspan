/**
 * How much of an agent's context a tool's definition takes: its name, title,
 * description and input schema as canonical JSON, in UTF-8 bytes, the way
 * every mcpspan SDK measures it (contract, 3.11), so the numbers here are the
 * ones the dashboard shows. A copy of the TypeScript SDK's, which keeps this
 * package free of it; the shared cases in the tests hold the two together.
 */
export function definitionBytes(tool: Record<string, unknown>): number | undefined {
  const measured: Record<string, unknown> = {};
  for (const field of ['name', 'title', 'description', 'inputSchema']) {
    if (tool[field] !== undefined) measured[field] = tool[field];
  }

  try {
    return Buffer.byteLength(canonical(measured), 'utf8');
  } catch {
    return undefined;
  }
}

/** Tokens from bytes, at four a token: the dashboard's estimate. */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

/** Sorted keys, no whitespace, minimal escaping. Throws on what JSON cannot hold. */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not a JSON number');
    return String(value);
  }
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${text(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  throw new TypeError(`cannot measure ${typeof value}`);
}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function text(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += ESCAPES[character] ?? (code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : character);
  }
  return `${out}"`;
}
