import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { type Finding, lint, RULES } from '../src/rules.js';
import { definitionBytes } from '../src/size.js';

const shared = JSON.parse(readFileSync(new URL('../../../conformance/definition-hashes.json', import.meta.url), 'utf8')) as {
  cases: { case: string; tool: Record<string, unknown>; bytes: number }[];
};

/** A tool with nothing to say about it, to change one thing at a time. */
function tool(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'search_flights',
    description: 'Finds flights between two airports on a day, cheapest first.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'IATA code of the departure airport.' },
        to: { type: 'string', description: 'IATA code of the arrival airport.' },
      },
      required: ['from', 'to'],
    },
    ...overrides,
  };
}

const rules = (findings: Finding[]) => findings.map((f) => f.rule);

describe('definitionBytes', () => {
  it.each(shared.cases.map((entry) => [entry.case, entry.tool, entry.bytes] as const))(
    'sizes %s as every SDK does (contract, 3.11)',
    (_name, definition, bytes) => {
      expect(definitionBytes(definition)).toBe(bytes);
    },
  );
});

describe('lint', () => {
  it('finds nothing in a well described tool, and sizes the listing', () => {
    const report = lint([tool()]);

    expect(report.findings).toEqual([]);
    expect(report).toMatchObject({ tools: 1, errors: 0, warnings: 0 });
    expect(report.bytes).toBe(definitionBytes(tool()));
    expect(report.tokens).toBe(Math.round(report.bytes / 4));
  });

  it('gives every rule a severity, and counts each', () => {
    const report = lint([tool({ name: 'has space' }), tool({ name: 'other', description: undefined })]);

    expect(report.findings.every((f) => f.severity === RULES[f.rule])).toBe(true);
    expect(report.errors).toBe(1);
    expect(report.warnings).toBe(1);
  });

  describe('names', () => {
    it('calls a tool without a name, or one that is not an object, an error', () => {
      expect(rules(lint([tool({ name: undefined }), tool({ name: '' }), 'search', null]).findings)).toEqual([
        'name-missing',
        'name-missing',
        'name-missing',
        'name-missing',
      ]);
    });

    it.each(['has space', 'comma,name', 'ünïcode', 'x'.repeat(129)])('refuses %s, outside the specification', (name) => {
      expect(rules(lint([tool({ name })]).findings)).toEqual(['name-invalid']);
    });

    it('warns of dots and of names past 64, which the specification allows and some clients do not', () => {
      expect(rules(lint([tool({ name: 'flights.search' })]).findings)).toEqual(['name-not-portable']);
      expect(lint([tool({ name: 'x'.repeat(65) })]).findings[0]?.message).toContain('65 characters');
      expect(lint([tool({ name: 'x'.repeat(64) })]).findings).toEqual([]);
    });

    it('calls two tools of one name an error, once', () => {
      const report = lint([tool(), tool({ description: 'Another one, doing something else entirely.' })]);

      expect(rules(report.findings)).toEqual(['name-duplicate']);
      expect(report.findings[0]).toMatchObject({ tool: 'search_flights' });
    });

    it('warns of names that differ only in case or separators', () => {
      const report = lint([
        tool({ name: 'getUser', description: 'Reads one user by id.' }),
        tool({ name: 'get_user', description: 'Reads one user by email.' }),
        tool({ name: 'get_users', description: 'Lists every user on a page.' }),
      ]);

      expect(rules(report.findings)).toEqual(['names-alike']);
      expect(report.findings[0]?.message).toContain('getUser, get_user');
    });
  });

  describe('descriptions', () => {
    it.each([undefined, '', '   ', 42])('warns of a missing description (%s)', (description) => {
      expect(rules(lint([tool({ description })]).findings)).toEqual(['description-missing']);
    });

    it.each(['Search.', 'Search flights', 'search-flights things now', 'Search Flights Things Now'])(
      'warns of a description that says no more than the name or title (%s)',
      (description) => {
        const report = lint([tool({ name: 'search_flights_things_now', title: 'Search Flights Things Now', description })]);

        expect(rules(report.findings)).toEqual(['description-short']);
      },
    );

    it('warns of a description past 1,200 characters', () => {
      const report = lint([tool({ description: 'Finds flights. '.repeat(90) })]);

      expect(rules(report.findings)).toEqual(['description-long']);
      expect(report.findings[0]?.message).toContain('1,349 characters');
    });

    it('warns of two tools with the same description, naming the others', () => {
      const report = lint([tool(), tool({ name: 'find_flights' }), tool({ name: 'book_flight', description: 'Books a flight found by search_flights.' })]);

      expect(rules(report.findings)).toEqual(['description-duplicate']);
      expect(report.findings[0]).toMatchObject({ tool: 'search_flights' });
      expect(report.findings[0]?.message).toContain('find_flights');
    });
  });

  describe('input schema', () => {
    it('calls a missing schema an error, and takes an empty object for a tool with no arguments', () => {
      expect(rules(lint([tool({ inputSchema: undefined })]).findings)).toEqual(['schema-missing']);
      expect(lint([tool({ inputSchema: { type: 'object' } })]).findings).toEqual([]);
    });

    it('calls a schema that is not an object, or not of type object, an error', () => {
      expect(rules(lint([tool({ inputSchema: 'object' })]).findings)).toEqual(['schema-invalid']);
      expect(rules(lint([tool({ inputSchema: { type: 'string' } })]).findings)).toEqual(['schema-not-object']);
      expect(rules(lint([tool({ inputSchema: { properties: {} } })]).findings)).toEqual(['schema-not-object']);
    });

    it('calls a required argument that does not exist an error', () => {
      const report = lint([tool({ inputSchema: { type: 'object', properties: {}, required: ['date'] } })]);

      expect(rules(report.findings)).toEqual(['required-unknown']);
      expect(report.findings[0]?.message).toContain('"date"');
    });

    it('calls malformed properties, required, types and argument schemas errors', () => {
      const schemas = [
        { type: 'object', properties: [] },
        { type: 'object', properties: {}, required: 'date' },
        { type: 'object', properties: { date: { type: 'date', description: 'The day.' } } },
        { type: 'object', properties: { date: 'string' } },
      ];

      for (const inputSchema of schemas) {
        expect(rules(lint([tool({ inputSchema })]).findings)).toEqual(['schema-invalid']);
      }
    });

    it('takes true and false as argument schemas, and a list of types', () => {
      const inputSchema = {
        type: 'object',
        properties: { anything: true, nothing: false, maybe: { type: ['string', 'null'], description: 'Or nothing.' } },
      };

      expect(lint([tool({ inputSchema })]).findings).toEqual([]);
    });

    it('warns of arguments without a description or type, saying which', () => {
      const inputSchema = { type: 'object', properties: { from: { type: 'string' }, to: { description: 'Arrival airport.' } } };
      const report = lint([tool({ inputSchema })]);

      expect(report.findings.map((f) => [f.rule, f.argument])).toEqual([
        ['argument-description-missing', 'from'],
        ['argument-type-missing', 'to'],
      ]);
    });

    it('takes enum, const, $ref and combinations in place of a type', () => {
      const properties = Object.fromEntries(
        [{ enum: ['a'] }, { const: 1 }, { $ref: '#/$defs/x' }, { anyOf: [] }, { oneOf: [] }, { allOf: [] }].map((s, i) => [
          `a${i}`,
          { ...s, description: 'Something.' },
        ]),
      );

      expect(lint([tool({ inputSchema: { type: 'object', properties } })]).findings).toEqual([]);
    });

    it('goes into nested objects and lists of objects, with the path to each argument', () => {
      const inputSchema = {
        type: 'object',
        properties: {
          passenger: {
            type: 'object',
            description: 'Who flies.',
            properties: { name: { type: 'string' } },
            required: ['name', 'age'],
          },
          legs: {
            type: 'array',
            description: 'Each flight.',
            items: { type: 'object', properties: { date: { description: 'The day.' } } },
          },
        },
      };

      expect(lint([tool({ inputSchema })]).findings.map((f) => [f.rule, f.argument])).toEqual([
        ['required-unknown', 'passenger'],
        ['argument-description-missing', 'passenger.name'],
        ['argument-type-missing', 'legs[].date'],
      ]);
    });

    it('warns of an object argument that takes anything, but not of one that says what its keys hold', () => {
      const open = { type: 'object', description: 'Extra options.' };
      const closed = [
        { ...open, additionalProperties: { type: 'string' } },
        { ...open, additionalProperties: false },
        { ...open, patternProperties: { '^x-': { type: 'string' } } },
      ];

      expect(rules(lint([tool({ inputSchema: { type: 'object', properties: { options: open } } })]).findings)).toEqual([
        'argument-open-object',
      ]);
      for (const options of closed) {
        expect(lint([tool({ inputSchema: { type: 'object', properties: { options } } })]).findings).toEqual([]);
      }
    });
  });

  describe('the listing', () => {
    const many = (count: number, description = 'Does one particular thing for the agent.') =>
      Array.from({ length: count }, (_, i) => tool({ name: `tool_${i}`, description: `${description} Number ${i}.` }));

    it('warns past 40 tools', () => {
      expect(lint(many(40)).findings).toEqual([]);
      expect(rules(lint(many(41)).findings)).toEqual(['too-many-tools']);
    });

    it('warns when the definitions pass 10,000 tokens', () => {
      const report = lint(many(30, 'Finds flights. '.repeat(75)));

      expect(report.tokens).toBeGreaterThan(10_000);
      expect(rules(report.findings)).toEqual(['listing-large']);
    });
  });
});
