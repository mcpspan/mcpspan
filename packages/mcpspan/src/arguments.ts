import { canonical } from './definition.js';

/**
 * Which top-level arguments of a refused call did not match the tool's input
 * schema (contract, 3.10).
 *
 * The server's own refusal is not read: each validation library words it
 * differently, and some quote the value the agent sent. The arguments are
 * checked here instead, against the schema the server listed, by a small set
 * of rules that never fail what they do not understand. Only names the schema
 * declares come out, so nothing the client made up, and no value, is sent.
 */

/** Names sent at most, per call. */
const MAX_NAMES = 20;

type Schema = Record<string, unknown>;

/** The declared names whose arguments fail the schema, sorted, at most twenty. Never throws. */
export function invalidArguments(schema: unknown, args: unknown): string[] {
  try {
    if (!isObject(schema)) return [];
    const values = args ?? {};
    if (!isObject(values)) return [];

    const names = new Set<string>();
    if (Array.isArray(schema['required'])) {
      for (const name of schema['required']) {
        if (typeof name === 'string' && !Object.hasOwn(values, name)) names.add(name);
      }
    }
    const properties = schema['properties'];
    if (isObject(properties)) {
      for (const [name, property] of Object.entries(properties)) {
        if (Object.hasOwn(values, name) && !matches(property, values[name])) names.add(name);
      }
    }

    return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_NAMES);
  } catch {
    return [];
  }
}

/** Whether a value passes a schema under the checks the contract lists, and only those. */
function matches(schema: unknown, value: unknown): boolean {
  if (schema === false) return false;
  if (!isObject(schema)) return true;

  const type = schema['type'];
  if (typeof type === 'string' && !isType(type, value)) return false;
  if (Array.isArray(type) && type.every((name) => typeof name === 'string') && !type.some((name) => isType(name as string, value))) {
    return false;
  }

  if (Array.isArray(schema['enum'])) {
    const sent = canonical(value);
    if (!schema['enum'].some((allowed) => canonical(allowed) === sent)) return false;
  }
  if (Object.hasOwn(schema, 'const') && canonical(schema['const']) !== canonical(value)) return false;

  if (typeof value === 'number') {
    if (isNumber(schema['minimum']) && value < schema['minimum']) return false;
    if (isNumber(schema['maximum']) && value > schema['maximum']) return false;
    if (isNumber(schema['exclusiveMinimum']) && value <= schema['exclusiveMinimum']) return false;
    if (isNumber(schema['exclusiveMaximum']) && value >= schema['exclusiveMaximum']) return false;
  }

  if (typeof value === 'string') {
    // Code points, not UTF-16 units: a character outside the BMP is one.
    const length = [...value].length;
    if (isNumber(schema['minLength']) && length < schema['minLength']) return false;
    if (isNumber(schema['maxLength']) && length > schema['maxLength']) return false;
  }

  if (Array.isArray(value)) {
    if (isNumber(schema['minItems']) && value.length < schema['minItems']) return false;
    if (isNumber(schema['maxItems']) && value.length > schema['maxItems']) return false;
    const items = schema['items'];
    if (isObject(items) || typeof items === 'boolean') {
      if (!value.every((item) => matches(items, item))) return false;
    }
  }

  if (isObject(value)) {
    if (Array.isArray(schema['required'])) {
      for (const name of schema['required']) {
        if (typeof name === 'string' && !Object.hasOwn(value, name)) return false;
      }
    }
    const properties = schema['properties'];
    if (isObject(properties)) {
      for (const [name, property] of Object.entries(properties)) {
        if (Object.hasOwn(value, name) && !matches(property, value[name])) return false;
      }
    }
  }

  return true;
}

function isType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // A type this list does not know is not checked.
      return true;
  }
}

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
