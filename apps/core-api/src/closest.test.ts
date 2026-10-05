import { describe, expect, it } from 'vitest';

import { closestName } from './closest.ts';

const TOOLS = ['search_flights', 'book_flight', 'get_flight_status', 'cancel_booking', 'get_weather', 'list_airports'];

describe('closestName', () => {
  it.each([
    ['a missing letter', 'search_flight', 'search_flights'],
    ['a typo', 'serach_flights', 'search_flights'],
    ['words in another order', 'flight_search', 'search_flights'],
    ['another naming convention', 'searchFlights', 'search_flights'],
    ['dashes for underscores', 'cancel-booking', 'cancel_booking'],
    ['the start of a longer name', 'get_flight', 'get_flight_status'],
    ['an older name with a word dropped', 'flight_status', 'get_flight_status'],
  ])('finds the likely name for %s', (_label, asked, expected) => {
    expect(closestName(asked, TOOLS)).toBe(expected);
  });

  it.each([
    ['something new', 'find_hotel'],
    ['something unrelated', 'rent_car'],
    ['one shared common word only', 'get_visa_requirements'],
  ])('suggests nothing for %s', (_label, asked) => {
    expect(closestName(asked, TOOLS)).toBeNull();
  });

  it('prefers the name sharing more words over a shorter edit', () => {
    expect(closestName('flight_book', ['book_flight', 'flight_boo'])).toBe('book_flight');
  });

  it('never suggests the name itself, and copes with nothing to compare', () => {
    expect(closestName('book_flight', ['book_flight'])).toBeNull();
    expect(closestName('book_flight', [])).toBeNull();
    expect(closestName('', TOOLS)).toBeNull();
  });

  it('stays quick on a pathological name', () => {
    const started = performance.now();
    closestName('x'.repeat(5000), Array.from({ length: 500 }, (_, i) => `tool_${i}_${'y'.repeat(150)}`));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
