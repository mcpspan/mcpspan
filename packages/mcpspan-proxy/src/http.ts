import { randomUUID } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

import { parseLine } from './lines.js';
import type { Connection, Observer } from './observer.js';
import { EventStreamReader } from './sse.js';

/**
 * A reverse proxy in front of an MCP server over Streamable HTTP.
 *
 * Every request goes to the same path on the server, and every answer comes
 * back, as they are: status, headers and body, streamed, never held. The
 * observer reads copies: the JSON-RPC in a POST, and what comes back as JSON
 * or as an event stream. Anything else, the OAuth endpoints a server may
 * have among them, passes through unread.
 *
 * Sessions (contract, 8) follow the server's `Mcp-Session-Id`: each session
 * it hands out is one connection, under an identifier of the proxy's own,
 * never the header's value. A server that hands out none (stateless, and
 * every server on the 2026-07-28 protocol) has calls without a session, as
 * the SDKs record them.
 */

export interface HttpProxy {
  /** Where it listens, as a URL. */
  url: string;
  /** Stops taking requests and ends those in flight. */
  close(): Promise<void>;
}

/** The longest body read for observing, in bytes; a longer one goes past unread. */
const MAX_OBSERVED_BYTES = 64 * 1024 * 1024;

/** Sessions remembered; past this the one idle longest is forgotten. */
const MAX_SESSIONS = 10_000;

/** Headers that belong to one hop, not to the request or answer being passed on (RFC 9110, 7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function startHttp(
  options: { upstream: URL; host: string; port: number },
  observer: Observer | undefined,
  say: (message: string) => void,
): Promise<HttpProxy> {
  const { upstream } = options;
  const client = upstream.protocol === 'https:' ? https : http;
  const agent = new client.Agent({ keepAlive: true });
  const sessions = new Map<string, Connection>();

  /** The connection a request belongs to: its session's, or one of its own. */
  const connectionFor = (header: string | undefined): Connection | undefined => {
    if (observer === undefined) return undefined;
    if (header === undefined) return observer.connection(undefined);

    let connection = sessions.get(header);
    if (connection === undefined) {
      // A session that began before this proxy started: one connection from here on.
      connection = observer.connection(randomUUID());
    }
    remember(header, connection);
    return connection;
  };

  const remember = (header: string, connection: Connection): void => {
    sessions.delete(header);
    sessions.set(header, connection);
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.get(oldest)?.close();
      if (oldest !== undefined) sessions.delete(oldest);
    }
  };

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const sessionHeader = single(request.headers['mcp-session-id']);
    const connection = request.method === 'POST' || request.method === 'GET' ? connectionFor(sessionHeader) : undefined;

    if (connection !== undefined && request.method === 'POST' && isJson(request.headers) && request.headers['content-encoding'] === undefined) {
      collect(request, (body) => connection.fromClient(parseLine(body)));
    }

    const outgoing = client.request(new URL(request.url ?? '/', upstream.origin), {
      method: request.method,
      headers: forwardedRequestHeaders(request, upstream),
      agent,
    });

    outgoing.on('response', (answer) => {
      const handedOut = single(answer.headers['mcp-session-id']);
      if (connection !== undefined && sessionHeader === undefined && handedOut !== undefined) {
        connection.sessionId = randomUUID();
        remember(handedOut, connection);
      }
      if (request.method === 'DELETE' && sessionHeader !== undefined && (answer.statusCode ?? 500) < 300) {
        sessions.get(sessionHeader)?.close();
        sessions.delete(sessionHeader);
      }

      if (connection !== undefined) observeAnswer(answer, connection);

      response.writeHead(answer.statusCode ?? 502, answer.statusMessage, withoutHopByHop(answer.headers));
      // Flushed at once, so an event stream reaches the client as it is written.
      response.flushHeaders();
      answer.pipe(response);
    });

    outgoing.on('error', (error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      say(`mcpspan-proxy: could not reach the server at ${upstream.origin}: ${error.message}`);
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`mcpspan-proxy could not reach the MCP server at ${upstream.origin}.\n`);
    });

    // A client that leaves takes its request to the server with it.
    response.on('close', () => {
      if (!response.writableFinished) outgoing.destroy();
    });

    request.pipe(outgoing);
  };

  const server = http.createServer(handle);
  // An event stream can stay open for as long as the session does.
  server.requestTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
      resolve({
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
            agent.destroy();
            for (const connection of sessions.values()) connection.close();
            sessions.clear();
          }),
      });
    });
  });
}

/** Reads a copy of what the server answered: one JSON message, or an event stream of them. */
function observeAnswer(answer: IncomingMessage, connection: Connection): void {
  const type = String(answer.headers['content-type'] ?? '').toLowerCase();

  if (type.startsWith('text/event-stream')) {
    const reader = new EventStreamReader((data) => connection.fromServer(parseLine(data)));
    decoded(answer, (chunk) => reader.push(chunk), () => reader.end());
  } else if (isJson(answer.headers)) {
    const parts: Buffer[] = [];
    let size = 0;
    decoded(
      answer,
      (chunk) => {
        size += chunk.length;
        if (size <= MAX_OBSERVED_BYTES) parts.push(chunk);
      },
      () => {
        if (size <= MAX_OBSERVED_BYTES) connection.fromServer(parseLine(Buffer.concat(parts).toString('utf8')));
      },
    );
  }
}

/**
 * Hands over a body's bytes as they arrive, uncompressed. Reads alongside
 * whoever else reads the stream, so the body still goes on as it came.
 */
function decoded(stream: IncomingMessage, onChunk: (chunk: Buffer) => void, onEnd: () => void): void {
  const encoding = String(stream.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
  const decoder =
    encoding === 'gzip' || encoding === 'x-gzip'
      ? zlib.createGunzip()
      : encoding === 'deflate'
        ? zlib.createInflate()
        : encoding === 'br'
          ? zlib.createBrotliDecompress()
          : undefined;

  if (encoding !== 'identity' && decoder === undefined) return;

  if (decoder === undefined) {
    stream.on('data', onChunk);
    stream.on('end', onEnd);
    return;
  }

  decoder.on('data', onChunk);
  decoder.on('end', onEnd);
  // A body that will not decode is not read; it still reaches the client as it came.
  decoder.on('error', () => undefined);
  stream.on('data', (chunk: Buffer) => decoder.write(chunk));
  stream.on('end', () => decoder.end());
}

/** A copy of a request's body, whole, when it ends; nothing when it is over the limit. */
function collect(request: IncomingMessage, onBody: (body: string) => void): void {
  const parts: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_OBSERVED_BYTES) parts.push(chunk);
  });
  request.on('end', () => {
    if (size <= MAX_OBSERVED_BYTES) onBody(Buffer.concat(parts).toString('utf8'));
  });
}

/**
 * The request's headers as the server should see them: the hop's own left
 * out, `Host` the server's (an MCP server guarding against DNS rebinding
 * checks it), and where the request came from in the usual forwarded headers.
 */
function forwardedRequestHeaders(request: IncomingMessage, upstream: URL): OutgoingHttpHeaders {
  const headers = withoutHopByHop(request.headers);
  delete headers['host'];
  headers['host'] = upstream.host;

  const from = request.socket.remoteAddress;
  const before = single(request.headers['x-forwarded-for']);
  if (from !== undefined) headers['x-forwarded-for'] = before === undefined ? from : `${before}, ${from}`;
  if (request.headers.host !== undefined) headers['x-forwarded-host'] ??= request.headers.host;
  headers['x-forwarded-proto'] ??= 'http';

  return headers;
}

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  // And any the sender named in its Connection header as its own.
  const named = new Set(
    String(headers['connection'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    kept[name] = value;
  }
  return kept;
}

function isJson(headers: IncomingHttpHeaders): boolean {
  const type = String(headers['content-type'] ?? '').toLowerCase();
  return type.startsWith('application/json') || /^application\/[\w.+-]*\+json/.test(type);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
