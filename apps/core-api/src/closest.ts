/**
 * Which of a server's own names a call to a missing one most likely meant.
 *
 * A call to a tool the server does not have is often a near miss rather than
 * a request for something new: a renamed tool a client still holds the old
 * list for, a typo a model made, words in another order, another naming
 * convention. Showing the likely match next to it tells the server's author
 * whether to add a tool or to fix a name or a description.
 *
 * Two measures, either of which is enough:
 * - edit distance over the normalised names, for typos and plurals
 *   (search_flight, search_flights);
 * - the words both names share, for reordering and conventions
 *   (flight_search, searchFlights, search-flights).
 * Nothing is suggested when neither is close: a wrong hint is worse than none.
 */

/** Names are cut to this before comparing, so a pathological name cannot make the comparison slow. */
const MAX_COMPARED_LENGTH = 100;

/** Edit distance allowed, as a share of the longer name. */
const EDIT_SHARE = 0.3;

/** Share of words two names must have in common. */
const WORD_SHARE = 0.6;

export function closestName(asked: string, known: readonly string[]): string | null {
  const askedForm = normalise(asked);
  const askedWords = words(askedForm);
  let best: { name: string; wordShare: number; distance: number } | null = null;

  for (const name of known) {
    if (name === asked) continue;

    const form = normalise(name);
    const distance = editDistance(askedForm, form);
    const wordShare = overlap(askedWords, words(form));
    const allowed = Math.max(1, Math.floor(Math.max(askedForm.length, form.length) * EDIT_SHARE));

    if (distance > allowed && wordShare < WORD_SHARE) continue;

    if (
      best === null ||
      wordShare > best.wordShare ||
      (wordShare === best.wordShare && distance < best.distance) ||
      (wordShare === best.wordShare && distance === best.distance && name < best.name)
    ) {
      best = { name, wordShare, distance };
    }
  }

  return best?.name ?? null;
}

/** Lower case, words joined by single underscores, whatever the convention. */
function normalise(name: string): string {
  return name
    .slice(0, MAX_COMPARED_LENGTH)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** The words of a normalised name, a plural made singular, so flights and flight count as one. */
function words(form: string): Set<string> {
  return new Set(
    form
      .split('_')
      .filter((word) => word.length > 0)
      .map((word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)),
  );
}

/** Shared words over all words, from 0 to 1. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;

  return shared / (a.size + b.size - shared);
}

/** Levenshtein distance, in two rows. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution));
    }
    previous = current;
  }

  return previous[b.length] ?? 0;
}
