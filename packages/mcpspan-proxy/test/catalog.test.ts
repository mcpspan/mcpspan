import { describe, expect, it } from 'vitest';

import { Catalog } from '../src/catalog.js';

function withTemplates(...templates: string[]): Catalog {
  const catalog = new Catalog();
  catalog.learnTemplates(templates, true, true);
  return catalog;
}

describe('resource templates', () => {
  it.each([
    ['users://{id}/profile', 'users://4412/profile', { id: '' }],
    ['users://{id}/profile', 'users://44/12/profile', undefined],
    ['file:///{+path}', 'file:///home/ada/a.pdf', { path: '' }],
    ['search://items{?q,page}', 'search://items?q=shoes&page=2', { q: '', page: '' }],
    ['search://items{?q,page}', 'search://items', { q: '', page: '' }],
    ['repo://{owner}/{repo}{/path*}', 'repo://mcpspan/mcpspan/src', { owner: '', repo: '', path: '' }],
    ['docs://{name}.{ext}', 'docs://guide.md', { name: '', ext: '' }],
  ])('%s against %s', (template, uri, variables) => {
    const resolved = withTemplates(template).resolveResource(uri);

    if (variables === undefined) {
      expect(resolved).toEqual({ name: 'users://', exists: false });
    } else {
      expect(resolved).toEqual({ name: template, exists: true, variables });
    }
  });

  it('matches nothing with a template it cannot read', () => {
    expect(withTemplates('broken://{id', 'odd://{}').resolveResource('broken://1')).toEqual({ name: 'broken://', exists: false });
  });

  it('knows nothing until a whole list has come', () => {
    const catalog = new Catalog();
    expect(catalog.resolveResource('a://b')).toEqual({ name: 'a://', exists: undefined });

    catalog.learnTemplates(['a://{x}'], true, false);
    expect(catalog.resolveResource('b://c').exists).toBeUndefined();
    catalog.learnTemplates(['b://{x}'], false, true);
    expect(catalog.resolveResource('b://c')).toMatchObject({ name: 'b://{x}', exists: true });
  });

  it('takes an address of no recognisable scheme as unknown://', () => {
    expect(withTemplates().resolveResource('/etc/passwd').name).toBe('unknown://');
  });
});
