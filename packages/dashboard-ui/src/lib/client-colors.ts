/** Distinguishable hues, in order of share. Past these, clients share one grey. */
export const CLIENT_HUES = ['#2a78d6', '#1f9d8a', '#d9a441', '#8a63d2', '#d0668f'];

/** The grey for every client past the hues: on the ring, and on its row of columns. */
export const OTHER_CLIENTS = '#9aa1ab';

/**
 * Each client's colour, by its rank in the window's shares: the same on the
 * ring and on the rows under it, so a row is matched to its slice at a glance.
 */
export function clientColors(clients: { clientType: string }[]): Record<string, string> {
  return Object.fromEntries(clients.map((client, index) => [client.clientType, CLIENT_HUES[index] ?? OTHER_CLIENTS]));
}
