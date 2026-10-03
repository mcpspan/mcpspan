/**
 * Narrowing a question down to part of the data.
 *
 * The same names on every endpoint, so a filter picked on one view carries to
 * the next without translation: somebody who narrowed the overview to one
 * tool expects the error list to follow them there.
 */
export interface Filters {
  toolName?: string;
  clientType?: string;
  /** Only meaningful where failures are listed. */
  errorSource?: string;
}

/**
 * The error source of a call to a tool the server does not have.
 *
 * Such a call names no real tool, so it is kept out of every figure about
 * tools: the ranking, the count of tools, the totals they add up to. It is
 * shown on its own instead, as a list of what agents asked for.
 */
export const UNKNOWN_TOOL = 'unknown_tool';

/** What an SDK records when a client asks for a resource or a prompt the server does not have. */
export const UNKNOWN_RESOURCE = 'unknown_resource';
export const UNKNOWN_PROMPT = 'unknown_prompt';

/** Longest a filter value may be, matching what the events table stores. */
const MAX_VALUE_LENGTH = 200;

/**
 * Reads filters from a query string, ignoring what it cannot use.
 *
 * A value nothing matches returns an empty result rather than an error, which
 * is the honest answer: asking about a tool that was never called is a
 * reasonable question with a boring reply. Only lengths are enforced, to keep
 * a hostile caller from sending a megabyte to compare against.
 */
export function parseFilters(query: {
  toolName?: string | undefined;
  clientType?: string | undefined;
  errorSource?: string | undefined;
}): Filters | { error: string } {
  const filters: Filters = {};

  for (const name of ['toolName', 'clientType', 'errorSource'] as const) {
    const value = query[name]?.trim();

    if (value === undefined || value.length === 0) continue;

    if (value.length > MAX_VALUE_LENGTH) {
      return { error: `'${name}' is too long, at most ${MAX_VALUE_LENGTH} characters` };
    }

    filters[name] = value;
  }

  return filters;
}

/**
 * Turns filters into SQL, appending to an existing parameter list.
 *
 * Values go in as parameters rather than into the text, which is the only
 * reason a tool name typed by somebody else is safe to put in a query at all.
 */
export function filterClause(
  filters: Filters,
  params: unknown[],
  options: {
    includeErrorSource?: boolean;
    includeUnknownTools?: boolean;
    /** The column holding the name: tool_name for tools, name for resources and prompts. */
    nameColumn?: string;
    /** What a call to a name the server lacks records, left out of the numbers unless asked for. */
    unknownSource?: string;
  } = {},
): string {
  const conditions: string[] = [];

  if (options.includeUnknownTools !== true) {
    // IS DISTINCT FROM, because a successful call has no error source at all
    // and a plain <> would drop every one of them.
    params.push(options.unknownSource ?? UNKNOWN_TOOL);
    conditions.push(`AND error_source IS DISTINCT FROM $${params.length}`);
  }

  if (filters.toolName !== undefined) {
    params.push(filters.toolName);
    conditions.push(`AND ${options.nameColumn ?? 'tool_name'} = $${params.length}`);
  }

  if (filters.clientType !== undefined) {
    params.push(filters.clientType);
    conditions.push(`AND client_type = $${params.length}`);
  }

  if (options.includeErrorSource === true && filters.errorSource !== undefined) {
    params.push(filters.errorSource);
    conditions.push(`AND error_source = $${params.length}`);
  }

  return conditions.join('\n       ');
}
