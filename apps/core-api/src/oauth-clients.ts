import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import {
  CLIENT_DOCUMENT_HOURS,
  type OAuthClient,
  type OAuthFailure,
  isFailure,
  parseClientMetadata,
  rememberClientDocument,
  storedClient,
} from './oauth.ts';

/**
 * Finding the app behind a client_id: one registered here, or one known by the
 * address of its own metadata document (Client ID Metadata Documents, the way
 * the MCP authorization spec prefers since 2025-11-25).
 *
 * A document is fetched from wherever the client_id says, which makes this
 * server send a request somebody else chose. So only over https, only to
 * public addresses (checked on the address actually connected to, so a name
 * that resolves elsewhere a second time gets nowhere), without following
 * redirects, briefly and small.
 */

/** Fetches a client's document; replaced in tests. */
export type FetchClientDocument = (url: URL) => Promise<unknown>;

const DOCUMENT_TIMEOUT_MS = 5_000;
const DOCUMENT_MAX_BYTES = 64 * 1024;

export async function findClient(
  clientId: string | undefined,
  fetchDocument: FetchClientDocument = fetchPublicJson,
): Promise<OAuthClient | OAuthFailure> {
  const unknown: OAuthFailure = { error: 'invalid_client', description: 'This app is not known here. Add the connector again.' };

  if (clientId === undefined || clientId === '' || clientId.length > 2000) return unknown;

  if (!clientId.startsWith('https://')) return (await storedClient(clientId)) ?? unknown;

  const address = documentAddress(clientId);

  if (address === undefined) {
    return { error: 'invalid_client', description: 'A client_id that is a URL must be https, with a path, and nothing else.' };
  }

  const stored = await storedClient(clientId);
  const fresh = stored?.fetchedAt != null && Date.now() - stored.fetchedAt.getTime() < CLIENT_DOCUMENT_HOURS * 3600 * 1000;

  if (stored !== undefined && fresh) return stored;

  let document: unknown;

  try {
    document = await fetchDocument(address);
  } catch {
    // Unreachable today, known yesterday: better the copy than a person who
    // cannot sign in because the app's website is down.
    return stored ?? { error: 'invalid_client', description: `The app's metadata at ${clientId} could not be fetched.` };
  }

  if (typeof document !== 'object' || document === null || (document as Record<string, unknown>)['client_id'] !== clientId) {
    return { error: 'invalid_client', description: `The document at ${clientId} does not name itself as that client_id.` };
  }

  const metadata = parseClientMetadata(document, { forDocument: true });

  if (isFailure(metadata)) {
    // Said in the log too: an app that cannot sign in is worth knowing about.
    console.warn(`mcpspan core-api: client document ${clientId} refused: ${metadata.description}`);

    return { error: 'invalid_client', description: metadata.description };
  }

  return rememberClientDocument(clientId, metadata);
}

/** The address a client_id URL may be fetched from, if it is one this server will fetch. */
function documentAddress(clientId: string): URL | undefined {
  try {
    const url = new URL(clientId);

    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return undefined;
    if (url.pathname === '/' || url.href !== clientId) return undefined;

    return url;
  } catch {
    return undefined;
  }
}

/** Addresses that are not the public internet: this machine, its networks, and what is reserved. */
const PRIVATE = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 0) return false;

  // An IPv4 address written as IPv6 (::ffff:127.0.0.1) is judged as the IPv4
  // one. Not a subnet in the list: BlockList would then match every IPv4
  // address against it.
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];

  if (mapped !== undefined) return isPublicAddress(mapped);
  if (family === 6 && /^::ffff:/i.test(address)) return false;

  return !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves as usual, then refuses any answer that is not public. */
const publicOnly: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0);

    const usable = addresses.filter(({ address }) => isPublicAddress(address));
    const first = usable[0];

    if (first === undefined) return callback(new Error(`${hostname} is not a public address`), '', 0);

    if ((options as { all?: boolean }).all === true) {
      return (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, usable);
    }

    return callback(null, first.address, first.family);
  });
};

export function fetchPublicJson(url: URL): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 && !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      reject(new Error('not a public address'));

      return;
    }

    const request = httpsRequest(
      url,
      { method: 'GET', headers: { accept: 'application/json' }, lookup: publicOnly, timeout: DOCUMENT_TIMEOUT_MS },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`answered ${response.statusCode}`));

          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        response.on('data', (chunk: Buffer) => {
          size += chunk.length;

          if (size > DOCUMENT_MAX_BYTES) {
            request.destroy(new Error('document too large'));

            return;
          }

          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error as Error);
          }
        });
        response.on('error', reject);
      },
    );

    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end();
  });
}
