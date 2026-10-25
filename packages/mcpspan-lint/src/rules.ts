import { definitionBytes, estimateTokens } from './size.js';

/**
 * An error breaks something: a client refuses the listing or the tool, or an
 * agent cannot call it as described. A warning makes the agent pick the wrong
 * tool, guess its arguments, or pay for words it does not need.
 */
export type Severity = 'error' | 'warning';

export interface Finding {
  severity: Severity;
  rule: RuleId;
  /** The tool it is about; left out for what is about the listing as a whole. */
  tool?: string;
  /** Where in the tool's input schema, as a dotted path of argument names, when it is about one argument. */
  argument?: string;
  message: string;
}

export interface Report {
  tools: number;
  /** What the definitions take in every session's context together, in canonical JSON bytes (contract, 3.11). */
  bytes: number;
  tokens: number;
  errors: number;
  warnings: number;
  findings: Finding[];
}

export const RULES = {
  'name-missing': 'error',
  'name-invalid': 'error',
  'name-duplicate': 'error',
  'name-not-portable': 'warning',
  'names-alike': 'warning',
  'schema-missing': 'error',
  'schema-not-object': 'error',
  'schema-invalid': 'error',
  'required-unknown': 'error',
  'description-missing': 'warning',
  'description-short': 'warning',
  'description-long': 'warning',
  'description-duplicate': 'warning',
  'argument-description-missing': 'warning',
  'argument-type-missing': 'warning',
  'argument-open-object': 'warning',
  'too-many-tools': 'warning',
  'listing-large': 'warning',
} as const satisfies Record<string, Severity>;

export type RuleId = keyof typeof RULES;

/** The specification's characters and length for a tool name (2025-11-25, Tool names). */
const SPEC_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
/** What the model APIs behind most clients take as a function name. Narrower than the specification: no dots, 64 at most. */
const PORTABLE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const SHORT_DESCRIPTION_WORDS = 3;
/** About 300 tokens: past this a description is more often a manual than a hint. */
const LONG_DESCRIPTION_CHARS = 1_200;
const MANY_TOOLS = 40;
const LARGE_LISTING_TOKENS = 10_000;

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
/** Keywords that say what a value is without a type. */
const TYPE_LIKE = ['enum', 'const', '$ref', 'anyOf', 'oneOf', 'allOf'];

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Everything found in a server's tools/list answer, from its tools as they came. */
export function lint(tools: readonly unknown[]): Report {
  const findings: Finding[] = [];
  const add = (rule: RuleId, message: string, where: { tool?: string; argument?: string } = {}) =>
    findings.push({ severity: RULES[rule], rule, ...where, message });

  let bytes = 0;
  const named: { name: string; description?: string }[] = [];

  tools.forEach((tool, index) => {
    if (!isObject(tool)) {
      add('name-missing', `Tool ${index + 1} in the listing is not an object.`);
      return;
    }

    bytes += definitionBytes(tool) ?? 0;

    const name = typeof tool['name'] === 'string' && tool['name'] !== '' ? tool['name'] : undefined;
    if (name === undefined) {
      add('name-missing', `Tool ${index + 1} in the listing has no name, so no agent can call it.`);
      return;
    }

    checkName(name, add);
    const description = checkDescription(name, tool, add);
    named.push({ name, ...(description === undefined ? {} : { description }) });
    checkSchema(name, tool['inputSchema'], add);
  });

  checkListing(named, add);

  if (named.length > MANY_TOOLS) {
    add(
      'too-many-tools',
      `${named.length} tools. With this many, agents choose among them less well; consider fewer, broader tools.`,
    );
  }

  const tokens = estimateTokens(bytes);
  if (tokens > LARGE_LISTING_TOKENS) {
    add(
      'listing-large',
      `The definitions take about ${tokens.toLocaleString('en')} tokens of every session's context, before the agent does anything.`,
    );
  }

  return {
    tools: tools.length,
    bytes,
    tokens,
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    findings,
  };
}

type Add = (rule: RuleId, message: string, where?: { tool?: string; argument?: string }) => void;

function checkName(name: string, add: Add): void {
  if (!SPEC_NAME.test(name)) {
    add(
      'name-invalid',
      'The name must be 1 to 128 letters, digits, underscores, hyphens or dots, with no spaces.',
      { tool: name },
    );
  } else if (!PORTABLE_NAME.test(name)) {
    add(
      'name-not-portable',
      name.length > 64
        ? `The name is ${name.length} characters; some clients refuse tool names over 64.`
        : 'Some clients refuse dots in tool names; underscores or hyphens work everywhere.',
      { tool: name },
    );
  }
}

/** The description, trimmed, when there is one worth comparing with the others. */
function checkDescription(name: string, tool: Json, add: Add): string | undefined {
  const raw = tool['description'];
  const description = typeof raw === 'string' ? raw.trim() : '';

  if (description === '') {
    add('description-missing', 'No description: the agent has only the name to tell what the tool does.', { tool: name });
    return undefined;
  }

  const title = typeof tool['title'] === 'string' ? tool['title'] : '';
  const words = description.split(/\s+/).length;

  if (words < SHORT_DESCRIPTION_WORDS || [name, title].some((same) => loose(same) === loose(description))) {
    add(
      'description-short',
      'The description says little more than the name. Say what the tool does, what it returns, and when to use it.',
      { tool: name },
    );
  } else if (description.length > LONG_DESCRIPTION_CHARS) {
    add(
      'description-long',
      `The description is ${description.length.toLocaleString('en')} characters, read in every session. Keep what helps choose the tool; move the rest to the argument descriptions.`,
      { tool: name },
    );
  }

  return description;
}

function checkSchema(name: string, schema: unknown, add: Add): void {
  if (schema === undefined) {
    add('schema-missing', 'No input schema. Every tool needs one, even with no arguments: {"type": "object"}.', { tool: name });
    return;
  }

  if (!isObject(schema)) {
    add('schema-invalid', 'The input schema is not a JSON Schema object.', { tool: name });
    return;
  }

  if (schema['type'] !== 'object') {
    add('schema-not-object', 'The input schema must have "type": "object": arguments are always named.', { tool: name });
    return;
  }

  checkObject(name, schema, undefined, add);
}

/** An object schema's own properties and required list, then each property's, all the way down. */
function checkObject(name: string, schema: Json, path: string | undefined, add: Add): void {
  const where = (argument: string) => ({ tool: name, argument: path === undefined ? argument : `${path}.${argument}` });
  const self = path === undefined ? { tool: name } : { tool: name, argument: path };
  const properties = schema['properties'];

  if (properties !== undefined && !isObject(properties)) {
    add('schema-invalid', '"properties" must be an object of argument schemas.', self);
    return;
  }

  const required = schema['required'];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
      add('schema-invalid', '"required" must be a list of argument names.', self);
    } else if (properties !== undefined) {
      for (const argument of required as string[]) {
        if (!Object.hasOwn(properties, argument)) {
          add('required-unknown', `"${argument}" is required but not among the arguments, so no call can satisfy it.`, self);
        }
      }
    }
  }

  if (path !== undefined && properties === undefined && isOpen(schema)) {
    add('argument-open-object', 'An object with no properties: the agent has to guess what goes in it.', self);
  }

  for (const [argument, child] of Object.entries(properties ?? {})) {
    checkArgument(child, where(argument), add);
  }
}

function checkArgument(schema: unknown, where: { tool: string; argument: string }, add: Add): void {
  // true and false are schemas too: anything, and nothing.
  if (typeof schema === 'boolean') return;

  if (!isObject(schema)) {
    add('schema-invalid', 'The argument\'s schema is not a JSON Schema object.', where);
    return;
  }

  const type = schema['type'];
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];

  if (types.some((entry) => typeof entry !== 'string' || !JSON_TYPES.has(entry))) {
    add('schema-invalid', `"type" must be one of ${[...JSON_TYPES].join(', ')}.`, where);
    return;
  }

  const description = typeof schema['description'] === 'string' ? schema['description'].trim() : '';
  if (description === '') {
    add('argument-description-missing', 'No description: the agent guesses what this argument means from its name.', where);
  }

  if (types.length === 0 && !TYPE_LIKE.some((keyword) => schema[keyword] !== undefined)) {
    add('argument-type-missing', 'No type: the agent may send a string where a number or list is meant.', where);
  }

  if (types.includes('object')) checkObject(where.tool, schema, where.argument, add);

  const items = schema['items'];
  if (types.includes('array') && isObject(items) && items['type'] === 'object') {
    checkObject(where.tool, items, `${where.argument}[]`, add);
  }
}

/** An object that takes any keys: nothing closes it, and nothing describes what its keys hold. */
function isOpen(schema: Json): boolean {
  const additional = schema['additionalProperties'];

  return schema['patternProperties'] === undefined && (additional === undefined || additional === true);
}

/** Tools an agent can mistake for one another: the same name but for case and separators, or the same description. */
function checkListing(tools: { name: string; description?: string }[], add: Add): void {
  const byName = new Map<string, number>();
  for (const { name } of tools) byName.set(name, (byName.get(name) ?? 0) + 1);
  for (const [name, count] of byName) {
    if (count > 1) add('name-duplicate', `${count} tools share this name; clients keep only one of them.`, { tool: name });
  }

  const unique = [...byName.keys()];
  const bySpelling = group(unique, (name) => name.toLowerCase().replace(/[-_.]/g, ''));
  for (const names of bySpelling) {
    add('names-alike', `Named alike: ${names.join(', ')}. An agent can easily call one for the other.`, { tool: names[0] });
  }

  const described = tools.filter((tool): tool is { name: string; description: string } => tool.description !== undefined);
  const byDescription = group(
    [...new Map(described.map((tool) => [tool.name, tool.description])).entries()],
    ([, description]) => loose(description),
  );
  for (const same of byDescription) {
    const names = same.map(([name]) => name);
    add('description-duplicate', `The same description as ${names.slice(1).join(', ')}: nothing tells the agent which to use.`, {
      tool: names[0],
    });
  }
}

/** The groups of two or more items with the same key, in the order they came. */
function group<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }

  return [...groups.values()].filter((members) => members.length > 1);
}

/** Text compared without case, punctuation or separators. */
function loose(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}
