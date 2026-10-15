import table from './client-types.json' with { type: 'json' };

/** The rules, in the order they are tried. */
export const CLIENT_TYPE_RULES = table.rules;

/**
 * The type of the client that called itself `clientName`: the first rule that
 * matches, `other` when none does, `unknown` when there is no name.
 */
export function clientTypeOf(clientName) {
  const name = typeof clientName === 'string' ? clientName.trim().toLowerCase() : '';
  if (name === '') return 'unknown';

  const rule = table.rules.find(
    (candidate) =>
      (candidate.startsWith ?? []).some((prefix) => name.startsWith(prefix)) ||
      (candidate.contains ?? []).some((part) => name.includes(part)),
  );

  return rule?.type ?? 'other';
}

/** How a type is shown. A type with no label is shown as it is. */
export function clientLabel(clientType) {
  return table.labels[clientType] ?? clientType;
}
