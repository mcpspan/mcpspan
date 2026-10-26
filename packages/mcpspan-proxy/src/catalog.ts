/**
 * What the server said it has, from its answers to the list requests.
 *
 * An SDK inside the server looks a call up in the server's own registry. The
 * proxy has only the wire, so it learns the registry the way a client does:
 * from `tools/list`, `resources/list`, `resources/templates/list` and
 * `prompts/list`. Until a list has been answered nothing is known about that
 * kind, and nothing is called unknown for want of it.
 *
 * Kept for the process, as the SDKs keep definitions (contract, 3.8): one
 * proxy stands in front of one server.
 */

/** Names kept per kind at most; past this a list is not learnt any further. */
const MAX_NAMES = 10_000;

/**
 * One kind of thing the server lists, by name. A list answered in pages is
 * taken up when its last page arrives, so a client part way through it never
 * makes the rest look unknown.
 */
class Listed<T = string> {
  private items: T[] | undefined;
  private incoming: T[] = [];

  /** Learns one page of a list. The first page starts the list over. */
  learn(items: Iterable<T>, firstPage: boolean, lastPage: boolean): void {
    if (firstPage) this.incoming = [];
    for (const item of items) {
      if (this.incoming.length >= MAX_NAMES) break;
      this.incoming.push(item);
    }
    if (lastPage) {
      this.items = this.incoming;
      this.incoming = [];
    }
  }

  /** Whether a whole list of this kind has been answered yet. */
  get known(): boolean {
    return this.items !== undefined;
  }

  get all(): readonly T[] {
    return this.items ?? [];
  }

  has(item: T): boolean {
    return this.items?.includes(item) === true;
  }
}

/** A resource template as listed, ready to match addresses against. */
interface Template {
  template: string;
  pattern: RegExp;
  variables: string[];
}

export class Catalog {
  readonly tools = new Listed();
  readonly prompts = new Listed();
  readonly resources = new Listed();
  private readonly templates = new Listed<Template>();

  /** Learns a page of `resources/templates/list`. */
  learnTemplates(templates: Iterable<string>, firstPage: boolean, lastPage: boolean): void {
    const compiled = [...templates].flatMap((template) => compileTemplate(template) ?? []);
    this.templates.learn(compiled, firstPage, lastPage);
  }

  /**
   * What a read of this address is named (contract, 3.5), and whether the
   * server is known to have it: a fixed resource by its address, one under a
   * template by the template, with the template's variables as its
   * parameters, anything else by its scheme alone. `exists` is undefined
   * while neither list has been answered.
   */
  resolveResource(uri: string): { name: string; exists: boolean | undefined; variables?: Record<string, string> } {
    if (this.resources.has(uri)) return { name: uri, exists: true };

    for (const template of this.templates.all) {
      if (!template.pattern.test(uri)) continue;
      // Names only: every variable of a template is a string (contract, 3.5), and no value is kept.
      const variables = Object.fromEntries(template.variables.map((name) => [name, '']));
      return { name: template.template, exists: true, variables };
    }

    const known = this.resources.known || this.templates.known;
    return { name: schemeOf(uri), exists: known ? false : undefined };
  }
}

/** The scheme of an address, which is all of an unknown one that may be kept: `db://`. */
export function schemeOf(uri: string): string {
  const colon = uri.indexOf(':');
  const scheme = colon > 0 ? uri.slice(0, colon) : '';

  return /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? `${scheme}://` : 'unknown://';
}

/**
 * A URI template (RFC 6570) as a pattern over addresses. Each expression
 * matches what its operator could have expanded to: a simple `{id}` stops at
 * a slash, `{+path}` and `{#part}` take the rest, `{/a}`, `{.a}` and `{;a}`
 * a segment with their prefix, `{?a}` and `{&a}` the query. Undefined for a
 * template it cannot read, which then matches nothing.
 */
function compileTemplate(template: string): Template | undefined {
  if (template.length > 1_000) return undefined;

  const variables: string[] = [];
  let source = '^';
  let rest = template;

  while (rest.length > 0) {
    const open = rest.indexOf('{');
    if (open === -1) {
      source += escape(rest);
      break;
    }
    const close = rest.indexOf('}', open);
    if (close === -1) return undefined;

    source += escape(rest.slice(0, open));
    const expression = rest.slice(open + 1, close);
    rest = rest.slice(close + 1);

    const operator = /^[+#./;?&]/.test(expression) ? expression[0] : '';
    const names = expression
      .slice(operator === '' ? 0 : 1)
      .split(',')
      .map((name) => name.replace(/(\*|:\d+)$/, ''))
      .filter((name) => /^[\w.%]+$/.test(name));
    if (names.length === 0) return undefined;

    switch (operator) {
      case '?':
      case '&':
        // The query is taken whole; its variables are named, not split out.
        source += `(?:${operator === '?' ? '\\?' : '&'}[^#]*)?`;
        break;
      case '+':
      case '#':
        source += `${operator === '#' ? '#' : ''}.*`;
        break;
      case '/':
      case '.':
      case ';':
        source += `(?:${escape(operator)}[^/?#]*)?`;
        break;
      default:
        source += names.length === 1 ? '[^/?#]+' : '[^/?#]*';
    }
    variables.push(...names);
  }

  try {
    return { template, pattern: new RegExp(`${source}$`), variables };
  } catch {
    return undefined;
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
