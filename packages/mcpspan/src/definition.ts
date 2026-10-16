import { createHash } from 'node:crypto';

/**
 * Tool definitions as the server lists them, fingerprinted (contract, 3.8).
 *
 * Rewording a description can change how agents use a tool more than a change
 * to its code. The fingerprint is taken from the answer to `tools/list`, what
 * an agent actually read, and sent with every call to the tool, so the
 * dashboard can mark when a definition changed. Kept for the process: one
 * process reports to one server, and a listing on one connection describes
 * the same tools as on any other.
 */

const listed = new Map<string, string>();

/** Each tool's input schema as last listed, to tell which arguments a refusal was over (contract, 3.10). */
const schemas = new Map<string, unknown>();

/** The latest fingerprint listed for a tool, if any listing in this process named it. */
export function definitionOf(toolName: string): string | undefined {
  return listed.get(toolName);
}

/** The latest input schema listed for a tool, if any listing in this process named it. */
export function schemaOf(toolName: string): unknown {
  return schemas.get(toolName);
}

/** A tool as an answer to `tools/list` described it (contract, 3.11). */
export interface ListedDefinition {
  name: string;
  definitionHash: string;
  definitionBytes: number;
}

/**
 * Notes every tool in an answer to `tools/list`, and returns them in its
 * order, each with its fingerprint and size. Never throws.
 */
export function noteListing(result: unknown): ListedDefinition[] {
  const found: ListedDefinition[] = [];
  try {
    const tools = (result as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) return found;

    for (const tool of tools) {
      const name = (tool as { name?: unknown } | null)?.name;
      if (typeof name !== 'string') continue;
      const written = fingerprint(tool as Record<string, unknown>);
      if (written !== undefined) {
        listed.set(name, written.hash);
        found.push({ name, definitionHash: written.hash, definitionBytes: written.bytes });
      }
      schemas.set(name, (tool as { inputSchema?: unknown }).inputSchema);
    }
  } catch {
    // A listing that cannot be read leaves the fingerprints as they were.
  }
  return found;
}

/** For tests: forgets every listing. */
export function forgetListings(): void {
  listed.clear();
  schemas.clear();
}

/**
 * The first 16 hex characters of the SHA-256 of the tool's name, title,
 * description and input schema, as canonical JSON. Undefined for a definition
 * that cannot be written so, which is then sent without one.
 */
export function definitionHash(tool: Record<string, unknown>): string | undefined {
  return fingerprint(tool)?.hash;
}

/** The fingerprint, and the size in UTF-8 bytes of the canonical JSON it is taken from (contract, 3.11). */
export function fingerprint(tool: Record<string, unknown>): { hash: string; bytes: number } | undefined {
  const hashed: Record<string, unknown> = {};
  for (const field of ['name', 'title', 'description', 'inputSchema']) {
    if (tool[field] !== undefined) hashed[field] = tool[field];
  }

  try {
    const written = canonical(hashed);
    return {
      hash: createHash('sha256').update(written, 'utf8').digest('hex').slice(0, 16),
      bytes: Buffer.byteLength(written, 'utf8'),
    };
  } catch {
    return undefined;
  }
}

/** Sorted keys, no whitespace, minimal escaping: the same text in every SDK. Throws on what JSON cannot hold. */
export function canonical(value: unknown): string {
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
  throw new TypeError(`cannot fingerprint ${typeof value}`);
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
