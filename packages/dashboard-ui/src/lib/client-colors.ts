/** Distinguishable hues, in order of share. Past these, clients are grey. */
export const CLIENT_HUES = ['#2a78d6', '#1f9d8a', '#d9a441', '#8a63d2', '#d0668f'];

/** The grey for every client past the hues, as the ring's last slice. */
export const OTHER_CLIENTS = '#9aa1ab';

/** Two greys in turn, so clients past the hues stay apart where they are stacked on each other. */
const GREYS = [OTHER_CLIENTS, '#c4c9d0'];

/**
 * Each client's colour: a hue by its rank in the window's shares, the same on
 * the ring and on the chart, and a grey for every one past them.
 */
export function clientColors(
  ranked: { clientType: string }[],
  /** Clients that may not be among the ranked ones, which get a grey. */
  others: { clientType: string }[] = [],
): Record<string, string> {
  const colors: Record<string, string> = {};

  ranked.slice(0, CLIENT_HUES.length).forEach((client, index) => {
    colors[client.clientType] = CLIENT_HUES[index] as string;
  });

  let grey = 0;
  for (const client of [...ranked, ...others]) {
    if (colors[client.clientType] === undefined) colors[client.clientType] = GREYS[grey++ % GREYS.length] as string;
  }

  return colors;
}
