/**
 * Outbound HTTP(S) requests with the same checks on every hop.
 *
 * - Only http/https (or https only); every redirect target is checked again,
 *   relative `Location` headers are resolved against the current URL.
 * - The connection resolves the host name itself (`lookup`) and refuses it
 *   when any address is a metadata address, or private while private targets
 *   are not allowed. The checked address is the one connected to, so a name
 *   that changes its answer between a check and the connect cannot slip
 *   through. Literal addresses are checked before connecting.
 * - Optional host list: the first request and (unless `redirectHosts` says
 *   otherwise) every redirect must stay on these hosts or their subdomains.
 * - A time limit for the whole exchange and a size limit for the answer.
 * - Every request opens a connection of its own (no keep-alive pool). A
 *   pooled connection opened by a request that may reach private addresses
 *   would otherwise serve a later request to the same name, which then never
 *   calls `lookup` and skips the address check.
 *
 * `safeDownload` adds the checks of a file download: status 200 and, when the
 * source states them, size and SHA-1/SHA-256. The answer is streamed into the
 * staging folder (utils/staging.ts) and hashed on the way; only a file that
 * passes replaces the destination.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'http';
import https from 'https';
import crypto from 'crypto';
import dns from 'dns';
import path from 'path';
import type { FileHandle } from 'fs/promises';
import type { LookupFunction } from 'net';
import {
  assertAllowedAddress,
  assertAllowedHost,
  parseHttpUrl,
  UnsafeUrlError,
} from './urlGuard.js';
import { replaceFileFromFile } from './noFollowFs.js';
import { createStagedFile, discardStaged } from './staging.js';

export interface OutboundPolicy {
  /** Hosts the request may go to: the name itself or a subdomain. Absent = any host. */
  allowedHosts?: readonly string[];
  /** Hosts a redirect may lead to. Absent = `allowedHosts`, null = any host. */
  redirectHosts?: readonly string[] | null;
  /** Private and loopback addresses are reachable (metadata addresses never are). */
  allowPrivate?: boolean;
  httpsOnly?: boolean;
}

export interface SafeRequestOptions extends OutboundPolicy {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxRedirects?: number;
  /** For the whole exchange, redirects included. */
  timeoutMs?: number;
  /** Longest answer body; a longer one fails, or is cut with `truncate`. */
  maxBytes?: number;
  truncate?: boolean;
}

export interface SafeResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The URL that gave the answer (after redirects). */
  url: string;
  truncated: boolean;
}

export type OutboundFailure =
  'timeout' | 'too-large' | 'redirects' | 'network' | 'status' | 'integrity';

export class OutboundRequestError extends Error {
  constructor(
    message: string,
    readonly reason: OutboundFailure,
  ) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_REDIRECTS = 5;
// Mods and asset packs; streamed to disk, never held in memory.
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function hostMatches(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function checkUrl(url: URL, policy: OutboundPolicy, hosts: readonly string[] | null | undefined) {
  if (policy.httpsOnly && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Disallowed protocol: ${url.protocol}`, 'protocol');
  }
  if (hosts && !hostMatches(url.hostname, hosts)) {
    throw new UnsafeUrlError(`Host ${url.hostname} is not an allowed host`, 'host-not-allowed');
  }
  assertAllowedHost(url.hostname, policy.allowPrivate === true);
}

/**
 * A `lookup` for http(s).request / Agent: resolves like dns.lookup and fails
 * when an address of the name may not be reached.
 */
export function guardedLookup(allowPrivate: boolean): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: LookupCallback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as dns.LookupAddress[];
      try {
        if (list.length === 0)
          throw new UnsafeUrlError(`Cannot resolve host ${hostname}`, 'dns-failure');
        for (const { address } of list) assertAllowedAddress(address, allowPrivate, hostname);
      } catch (guardErr) {
        return callback(guardErr as Error, '', 0);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

type LookupCallback = (
  err: Error | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** Consumes an answer; called from the response callback, so it attaches its listeners at once. */
type BodyReader<T> = (res: IncomingMessage, signal: AbortSignal) => Promise<T>;

type Hop<T> =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'answer'; res: IncomingMessage; body: Promise<T> };

const tooLarge = (maxBytes: number | undefined) =>
  new OutboundRequestError(`The answer is larger than ${maxBytes} bytes`, 'too-large');

const closedEarly = () =>
  new OutboundRequestError('The connection closed before the answer was complete', 'network');

/** Collects the body in memory (API answers; downloads use writeBody). */
function readBody(
  res: IncomingMessage,
  opts: SafeRequestOptions,
  signal: AbortSignal,
): Promise<{ body: Buffer; truncated: boolean }> {
  const { maxBytes, truncate } = opts;
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      res.destroy?.();
      finish(() => reject(new OutboundRequestError('No complete answer in time', 'timeout')));
    };
    signal.addEventListener('abort', onAbort);
    if (maxBytes !== undefined && !truncate && Number(res.headers?.['content-length']) > maxBytes) {
      res.destroy?.();
      finish(() => reject(tooLarge(maxBytes)));
      return;
    }
    res.on('data', (chunk: Buffer) => {
      if (done) return;
      const room = maxBytes === undefined ? Infinity : maxBytes - total;
      if (chunk.length <= room) {
        parts.push(chunk);
        total += chunk.length;
        return;
      }
      res.destroy?.();
      if (!truncate) return finish(() => reject(tooLarge(maxBytes)));
      parts.push(chunk.subarray(0, room));
      total += room;
      finish(() => resolve({ body: Buffer.concat(parts, total), truncated: true }));
    });
    res.on('end', () =>
      finish(() => resolve({ body: Buffer.concat(parts, total), truncated: false })),
    );
    res.on('error', (err: Error) => finish(() => reject(err)));
    res.on('close', () => finish(() => reject(closedEarly())));
  });
}

/** Size and hashes of a file as it was written. */
export interface WrittenFile {
  size: number;
  sha1: string;
  sha256: string;
}

async function writeAll(fh: FileHandle, chunk: Buffer): Promise<void> {
  let written = 0;
  while (written < chunk.length) {
    written += (await fh.write(chunk, written, chunk.length - written)).bytesWritten;
  }
}

/**
 * Streams a download into `fh` and hashes it on the way; only status 200 is
 * taken. The answer pauses while a chunk is written, so only the chunk being
 * written is held in memory.
 */
function writeBody(
  res: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
  fh: FileHandle,
): Promise<WrittenFile> {
  if (res.statusCode !== 200) {
    res.destroy?.();
    return Promise.reject(
      new OutboundRequestError(`Download failed with status ${res.statusCode}`, 'status'),
    );
  }
  return new Promise((resolve, reject) => {
    const sha1 = crypto.createHash('sha1');
    const sha256 = crypto.createHash('sha256');
    let size = 0;
    let ended = false;
    let done = false;
    let writing: Promise<void> = Promise.resolve();
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const fail = (err: Error) => {
      res.destroy?.();
      finish(() => reject(err));
    };
    const onAbort = () => fail(new OutboundRequestError('No complete answer in time', 'timeout'));
    signal.addEventListener('abort', onAbort);
    if (Number(res.headers?.['content-length']) > maxBytes) {
      fail(tooLarge(maxBytes));
      return;
    }
    res.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) return fail(tooLarge(maxBytes));
      sha1.update(chunk);
      sha256.update(chunk);
      res.pause?.();
      writing = writing
        .then(() => writeAll(fh, chunk))
        .then(
          () => {
            if (!done) res.resume?.();
          },
          (err: Error) => fail(err),
        );
    });
    res.on('end', () => {
      ended = true;
      void writing.then(() =>
        finish(() => resolve({ size, sha1: sha1.digest('hex'), sha256: sha256.digest('hex') })),
      );
    });
    res.on('error', (err: Error) => fail(err));
    res.on('close', () => {
      if (!ended) fail(closedEarly());
    });
  });
}

function sendHop<T>(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | Buffer | undefined,
  opts: SafeRequestOptions,
  signal: AbortSignal,
  read: BodyReader<T>,
): Promise<Hop<T>> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const options: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      lookup: guardedLookup(opts.allowPrivate === true),
      // A connection of its own, closed after the answer (see the module comment).
      agent: false,
      signal,
    };
    const onResponse = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      const location = res.headers?.location;
      if (REDIRECT_STATUS.has(status) && location) {
        res.resume?.();
        resolve({ kind: 'redirect', status, location });
        return;
      }
      resolve({ kind: 'answer', res, body: read(res, signal) });
    };
    const req =
      method === 'GET' && body === undefined
        ? transport.get(options, onResponse)
        : transport.request(options, onResponse);
    req.on('error', reject);
    if (method !== 'GET' || body !== undefined) req.end(body);
  });
}

const sameOrigin = (a: URL, b: URL) => a.origin === b.origin;

function withoutHeaders(headers: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !names.includes(k.toLowerCase())),
  );
}

/** Follows the redirects of `raw` and hands the final answer to `read`. */
async function exchange<T>(
  raw: string,
  opts: SafeRequestOptions,
  read: BodyReader<T>,
): Promise<{ res: IncomingMessage; url: URL; body: T }> {
  const { maxRedirects = DEFAULT_MAX_REDIRECTS, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let url = parseHttpUrl(raw, opts.httpsOnly);
  let method: string = opts.method ?? 'GET';
  let body = opts.body;
  let headers = { ...opts.headers };
  let hosts: readonly string[] | null | undefined = opts.allowedHosts;
  try {
    for (let hop = 0; ; hop++) {
      checkUrl(url, opts, hosts);
      const result = await sendHop(url, method, headers, body, opts, controller.signal, read);
      if (result.kind === 'answer') return { res: result.res, url, body: await result.body };
      if (hop >= maxRedirects) {
        throw new OutboundRequestError(`More than ${maxRedirects} redirects`, 'redirects');
      }
      const next = parseHttpUrl(new URL(result.location, url).toString(), opts.httpsOnly);
      if (!sameOrigin(url, next)) headers = withoutHeaders(headers, ['authorization', 'cookie']);
      if (result.status === 303 || (method === 'POST' && result.status <= 302)) {
        method = 'GET';
        body = undefined;
        headers = withoutHeaders(headers, ['content-type', 'content-length']);
      }
      hosts = opts.redirectHosts === undefined ? opts.allowedHosts : opts.redirectHosts;
      url = next;
    }
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof OutboundRequestError)) {
      throw new OutboundRequestError(`No answer within ${timeoutMs} ms`, 'timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** One request; see the module comment for the checks. */
export async function safeRequest(
  raw: string,
  opts: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const { res, url, body } = await exchange(raw, opts, (answer, signal) =>
    readBody(answer, opts, signal),
  );
  return {
    status: res.statusCode ?? 0,
    headers: res.headers ?? {},
    body: body.body,
    url: url.toString(),
    truncated: body.truncated,
  };
}

/** What the source states about a file; unknown fields are not checked. */
export interface ExpectedFile {
  size?: number;
  sha1?: string;
  sha256?: string;
}

/** Why the written file does not match `expected`, or null when it does. */
export function integrityProblem(file: WrittenFile, expected: ExpectedFile = {}): string | null {
  if (expected.size !== undefined && file.size !== expected.size) {
    return `size ${file.size} bytes, the source states ${expected.size}`;
  }
  for (const algo of ['sha1', 'sha256'] as const) {
    const want = expected[algo]?.trim().toLowerCase();
    if (want && file[algo] !== want) {
      return `${algo.toUpperCase()} ${file[algo]}, the source states ${want}`;
    }
  }
  return null;
}

export interface DownloadOptions extends SafeRequestOptions {
  /**
   * Where the file goes. It is replaced like replaceFileContent does it (a
   * new file next to it, renamed over it), never written through a link
   * planted under its name; its folder is the root the file must stay in.
   */
  saveTo: string;
  expected?: ExpectedFile;
}

/**
 * A file download into `saveTo`: status 200, size limit, and the integrity
 * the source states. Nothing at `saveTo` changes unless all checks pass.
 */
export async function safeDownload(raw: string, opts: DownloadOptions): Promise<{ size: number }> {
  const { expected, saveTo, ...request } = opts;
  const maxBytes = request.maxBytes ?? MAX_DOWNLOAD_BYTES;
  const staged = await createStagedFile('download');
  try {
    let written: WrittenFile;
    try {
      ({ body: written } = await exchange(
        raw,
        { timeoutMs: DOWNLOAD_TIMEOUT_MS, ...request, method: 'GET' },
        (res, signal) => writeBody(res, maxBytes, signal, staged.fh),
      ));
    } finally {
      await staged.fh.close();
    }
    const problem = integrityProblem(written, expected);
    if (problem) {
      throw new OutboundRequestError(`The downloaded file does not match: ${problem}`, 'integrity');
    }
    await replaceFileFromFile(saveTo, staged.path, [path.dirname(saveTo)]);
    return { size: written.size };
  } finally {
    await discardStaged(staged.path);
  }
}

/** Short reason for logs and API answers. */
export function outboundErrorMessage(err: unknown): string {
  if (err instanceof UnsafeUrlError) return `blocked (${err.reason}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
