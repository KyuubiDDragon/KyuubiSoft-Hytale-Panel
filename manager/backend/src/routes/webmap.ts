/**
 * WebMap (EasyWebMap mod) integration: session minting + sandboxed proxy.
 *
 * The map page is third-party HTML/JS served by the game container. It used
 * to run unauthenticated on the panel origin, where its scripts could read
 * the panel's access token and call the API as the viewing admin. Now:
 *
 *  - POST /api/webmap/session (Bearer auth + players.view) mints a session;
 *    the map is reachable only under /api/webmap/t/<session>/... (HTTP and
 *    WebSocket), and every request re-checks the session's user + right.
 *  - Every proxied response carries `Content-Security-Policy: sandbox
 *    allow-scripts` (no allow-same-origin), so the map always runs with an
 *    opaque origin — framed or opened in its own tab — and gets no access
 *    to panel storage, cookies or authenticated API calls.
 *  - The map uses root-absolute URLs (/api/tiles, /api/worlds, /ws). A small
 *    script injected into its HTML prefixes those with the session path.
 *  - Cookies/Authorization are never forwarded to the game container, and
 *    Set-Cookie from it never reaches the browser.
 */
import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'http';
import type { Duplex } from 'stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'zlib';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import {
  checkWebMapSession,
  createWebMapSession,
  getWebMapSessionStatus,
  isWebMapSessionId,
  revokeWebMapSession,
  trackWebMapSocket,
  WEBMAP_SESSION_IDLE_TTL_MS,
  WEBMAP_SESSION_MAX_TTL_MS,
} from '../services/webMapSessions.js';

/** Public path prefix of the proxied map; followed by `<session>/`. */
export const WEBMAP_PROXY_PREFIX = '/api/webmap/t/';

// Relative to the `/api/webmap` mount: /t/<session>[/rest][?query]
const MOUNTED_PATH = /^\/t\/([a-f0-9]{64})(\/[^?]*)?(\?.*)?$/;
// Full upgrade URL: /api/webmap/t/<session>[/rest][?query]
const UPGRADE_PATH = /^\/api\/webmap\/t\/([a-f0-9]{64})(\/[^?]*)?(\?.*)?$/;

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const WS_RECHECK_INTERVAL_MS = 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 60 * 1000;
const FORWARDED_METHODS = new Set(['GET', 'HEAD', 'POST']);

// Sandbox every proxied response: as a document it gets an opaque origin,
// whether it's framed by the panel or opened directly in a tab.
const SANDBOX_CSP = "sandbox allow-scripts; frame-ancestors 'self'";
// The map page itself needs inline scripts (ours + its own) and pulls Leaflet
// from a CDN. That's acceptable only because of the sandbox above.
const HTML_CSP =
  `${SANDBOX_CSP}; ` +
  "default-src 'self' https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; " +
  "script-src 'self' https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' https: http: 'unsafe-inline'; " +
  "img-src 'self' https: http: data: blob:; " +
  "font-src 'self' https: http: data:; " +
  "connect-src 'self' https: http: ws: wss:; " +
  "object-src 'none'; form-action 'none'";

// Upstream headers that must not reach the browser: they'd weaken our
// policy (CSP/XFO/CORS) or plant cookies on the panel origin.
const STRIPPED_RESPONSE_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
];

/**
 * Injected first into the map's <head>. Derives the session prefix from the
 * page URL and routes root-absolute same-host requests through it, so the
 * map's `/api/tiles`, `/api/worlds` and `/ws` calls reach the proxy.
 */
const PATH_REWRITE_SCRIPT = `<script>
(function () {
  var marker = '${WEBMAP_PROXY_PREFIX}';
  var path = location.pathname;
  if (path.indexOf(marker) !== 0) return;
  var cut = path.indexOf('/', marker.length);
  var prefix = cut === -1 ? path : path.slice(0, cut);
  function rewrite(input) {
    if (input === null || input === undefined) return input;
    var s = String(input);
    if (/^(data|blob|about|javascript):/i.test(s)) return input;
    var url;
    try { url = new URL(s, location.href); } catch (e) { return input; }
    if (url.host !== location.host) return input;
    if (url.pathname === prefix || url.pathname.indexOf(prefix + '/') === 0) return input;
    url.pathname = prefix + url.pathname;
    return url.href;
  }
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        var next = rewrite(input.url);
        if (next !== input.url) input = new Request(next, input);
      } else {
        input = rewrite(input);
      }
      return origFetch.call(window, input, init);
    };
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrite(args[1]);
    return origOpen.apply(this, args);
  };
  function wrapConstructor(name) {
    var Orig = window[name];
    if (!Orig) return;
    var Wrapped = function (url, opts) {
      return opts === undefined ? new Orig(rewrite(url)) : new Orig(rewrite(url), opts);
    };
    Wrapped.prototype = Orig.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      if (k in Orig) Wrapped[k] = Orig[k];
    });
    window[name] = Wrapped;
  }
  wrapConstructor('WebSocket');
  wrapConstructor('EventSource');
  var src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (src && src.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: src.enumerable,
      get: src.get,
      set: function (v) { src.set.call(this, rewrite(v)); }
    });
  }
})();
</script>`;

function withSandboxHeaders(
  upstream: IncomingMessage['headers'],
  isHtml: boolean,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { ...upstream };
  for (const name of STRIPPED_RESPONSE_HEADERS) delete headers[name];
  return {
    ...headers,
    'content-security-policy': isHtml ? HTML_CSP : SANDBOX_CSP,
    'x-frame-options': 'SAMEORIGIN',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // The sandboxed page has an opaque origin, so its fetch()es are CORS
    // requests. Access is carried by the session in the path, never by
    // ambient credentials, so a wildcard is safe here.
    'access-control-allow-origin': '*',
  };
}

function injectRewriteScript(html: string): string {
  // The map's own meta CSP would block our injected inline script.
  const withoutMetaCsp = html.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    '',
  );
  const head = /<head(\s[^>]*)?>/i.exec(withoutMetaCsp);
  if (!head) return PATH_REWRITE_SCRIPT + withoutMetaCsp;
  const at = head.index + head[0].length;
  return withoutMetaCsp.slice(0, at) + PATH_REWRITE_SCRIPT + withoutMetaCsp.slice(at);
}

function decodedBody(proxyRes: IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(proxyRes.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip') return proxyRes.pipe(createGunzip());
  if (encoding === 'deflate') return proxyRes.pipe(createInflate());
  if (encoding === 'br') return proxyRes.pipe(createBrotliDecompress());
  return proxyRes;
}

function sendProxyError(res: ServerResponse, status = 502): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'WebMap unavailable' }));
}

/**
 * Map an upstream redirect back under the session prefix, so a redirect from
 * the map neither leaks the container address nor escapes the prefix.
 * Redirects to other hosts are left alone.
 */
function rewriteLocation(
  location: string,
  target: string,
  upstreamPath: string,
  prefix: string,
): string {
  try {
    const base = new URL(upstreamPath, target);
    const url = new URL(location, base);
    if (url.host !== base.host) return location;
    return prefix + url.pathname.replace(/^\//, '') + url.search + url.hash;
  } catch {
    return location;
  }
}

function handleProxyResponse(proxyRes: IncomingMessage, res: ServerResponse): void {
  const contentType = String(proxyRes.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/html')) {
    res.writeHead(proxyRes.statusCode || 200, withSandboxHeaders(proxyRes.headers, false));
    proxyRes.on('error', () => res.destroy());
    res.on('close', () => proxyRes.destroy());
    proxyRes.pipe(res);
    return;
  }

  // HTML: buffer (bounded), decompress if needed, inject the rewrite script.
  const chunks: Buffer[] = [];
  let size = 0;
  let failed = false;
  const body = decodedBody(proxyRes);
  const fail = (err: Error): void => {
    if (failed) return;
    failed = true;
    console.error('[WebMap Proxy] Failed to process map HTML:', err.message);
    sendProxyError(res);
  };
  body.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_HTML_BYTES) {
      fail(new Error('HTML response too large'));
      proxyRes.destroy();
      return;
    }
    chunks.push(chunk);
  });
  body.on('error', fail);
  body.on('end', () => {
    if (failed) return;
    const html = injectRewriteScript(Buffer.concat(chunks).toString('utf-8'));
    const headers = withSandboxHeaders(proxyRes.headers, true);
    delete headers['content-length'];
    delete headers['content-encoding'];
    delete headers['transfer-encoding'];
    // The body was decoded and is re-sent as UTF-8; say so, since the
    // injected script may push the page's own <meta charset> out of the
    // sniffing window.
    headers['content-type'] = 'text/html; charset=utf-8';
    headers['cache-control'] = 'no-store';
    res.writeHead(proxyRes.statusCode || 200, headers);
    res.end(html);
  });
}

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404): void {
  const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found';
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export interface WebMapProxy {
  /** Mount at `/api/webmap` BEFORE helmet; handles only `/t/<session>/...`. */
  middleware: RequestHandler;
  /** Call from the server 'upgrade' handler for paths under WEBMAP_PROXY_PREFIX. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
}

export function createWebMapProxy(target: string): WebMapProxy {
  // Session prefix of each in-flight request, for redirect rewriting.
  const prefixes = new WeakMap<IncomingMessage, string>();

  const httpForward = createProxyMiddleware<IncomingMessage, ServerResponse>({
    target,
    changeOrigin: true,
    selfHandleResponse: true,
    proxyTimeout: UPSTREAM_TIMEOUT_MS,
    on: {
      proxyReq: (proxyReq) => {
        // Panel credentials are none of the game container's business.
        proxyReq.removeHeader('cookie');
        proxyReq.removeHeader('authorization');
        // Ask for an uncompressed body so the HTML can be rewritten.
        proxyReq.setHeader('Accept-Encoding', 'identity');
      },
      proxyRes: (proxyRes, req, res) => {
        const prefix = prefixes.get(req);
        const location = proxyRes.headers.location;
        if (prefix && typeof location === 'string') {
          proxyRes.headers.location = rewriteLocation(location, target, req.url || '/', prefix);
        }
        handleProxyResponse(proxyRes, res);
      },
      error: (err, _req, res) => {
        console.error('[WebMap Proxy] Error:', err.message);
        if (res && 'writeHead' in res) sendProxyError(res as ServerResponse);
      },
    },
  });

  const wsForward = httpProxy.createProxyServer({ target, ws: true, changeOrigin: true });
  wsForward.on('proxyReqWs', (proxyReq, _req, socket) => {
    // http-proxy only ends the upstream socket when the client socket errors;
    // make every client close (revoke, failed re-check, reset) end it too.
    proxyReq.on('upgrade', (_res, proxySocket) => {
      socket.once('close', () => proxySocket.destroy());
    });
  });
  wsForward.on('error', (err, _req, res) => {
    console.error('[WebMap WS Proxy] Error:', err.message);
    if (res && 'destroy' in res && typeof res.destroy === 'function') res.destroy();
  });

  const middleware: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    const match = MOUNTED_PATH.exec(req.url);
    if (!match) {
      next();
      return;
    }
    const [, sessionId, rest, query = ''] = match;
    try {
      const access = await checkWebMapSession(sessionId);
      if (!access.ok) {
        res.status(access.status).set('Cache-Control', 'no-store').json({ error: access.error });
        return;
      }
      if (rest === undefined) {
        // Without the trailing slash the map's relative URLs would resolve
        // outside the session prefix.
        res.redirect(302, `${WEBMAP_PROXY_PREFIX}${sessionId}/${query}`);
        return;
      }
      if (req.method === 'OPTIONS') {
        // CORS preflight from the sandboxed page (e.g. the JSON tile batch POST).
        res.set({
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        });
        res.status(204).end();
        return;
      }
      // A map viewer only reads (and POSTs tile batches); nothing else is
      // forwarded to the mod's web server.
      if (!FORWARDED_METHODS.has(req.method)) {
        res
          .status(405)
          .set('Allow', 'GET, HEAD, POST, OPTIONS')
          .json({ error: 'Method not allowed' });
        return;
      }
      req.url = rest + query;
      prefixes.set(req, `${WEBMAP_PROXY_PREFIX}${sessionId}/`);
      await httpForward(req, res, next);
    } catch (err) {
      next(err);
    }
  };

  const handleUpgrade = async (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> => {
    // Node drops its own error listener before 'upgrade'; a client reset
    // during the async session check must not become an unhandled error.
    socket.on('error', () => socket.destroy());
    const match = UPGRADE_PATH.exec(req.url || '');
    if (!match) {
      rejectUpgrade(socket, 404);
      return;
    }
    const [, sessionId, rest = '/', query = ''] = match;
    try {
      const access = await checkWebMapSession(sessionId);
      if (!access.ok) {
        rejectUpgrade(socket, access.status);
        return;
      }
    } catch (err) {
      console.error('[WebMap WS Proxy] Session check failed:', err);
      socket.destroy();
      return;
    }

    req.url = rest + query;
    delete req.headers.cookie;
    delete req.headers.authorization;

    // Re-check periodically so logout / revoked rights also end live streams;
    // an explicit revoke closes the socket right away.
    const release = trackWebMapSocket(sessionId, () => socket.destroy());
    const recheck = setInterval(() => {
      checkWebMapSession(sessionId)
        .then((again) => {
          if (!again.ok) socket.destroy();
        })
        .catch(() => socket.destroy());
    }, WS_RECHECK_INTERVAL_MS);
    recheck.unref();
    socket.once('close', () => {
      clearInterval(recheck);
      release();
    });

    wsForward.ws(req, socket, head);
  };

  return { middleware, handleUpgrade };
}

// ---------------------------------------------------------------------------
// Session endpoints (mounted after the JSON parser / CSRF check)
// ---------------------------------------------------------------------------

const router = Router();

const sessionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { detail: 'Too many WebMap session requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/webmap/session — mint a map session for the current user.
router.post(
  '/session',
  authMiddleware,
  sessionLimiter,
  requirePermission('players.view'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const ticket = await createWebMapSession(req.user!);
    res.set('Cache-Control', 'no-store').json({
      ticket,
      path: `${WEBMAP_PROXY_PREFIX}${ticket}/`,
      idleTimeoutSeconds: Math.floor(WEBMAP_SESSION_IDLE_TTL_MS / 1000),
      expiresInSeconds: Math.floor(WEBMAP_SESSION_MAX_TTL_MS / 1000),
    });
  }),
);

// The ticket travels in the body (not the path) so it stays out of request logs.
function ticketFromBody(req: AuthenticatedRequest): string | null {
  const ticket = (req.body as { ticket?: unknown } | undefined)?.ticket;
  return isWebMapSessionId(ticket) ? ticket : null;
}

// POST /api/webmap/session/status — heartbeat for one of the caller's map
// sessions: { valid: true, expiresAt } or { valid: false, reason }.
router.post(
  '/session/status',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const ticket = ticketFromBody(req);
    if (!ticket) {
      res.status(400).json({ error: 'Invalid ticket' });
      return;
    }
    const status = await getWebMapSessionStatus(ticket, req.user!);
    res
      .set('Cache-Control', 'no-store')
      .json(
        status.valid
          ? { valid: true, expiresAt: new Date(status.expiresAt).toISOString() }
          : status,
      );
  }),
);

// POST /api/webmap/session/revoke — end one of the caller's map sessions.
router.post('/session/revoke', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const ticket = ticketFromBody(req);
  if (!ticket) {
    res.status(400).json({ error: 'Invalid ticket' });
    return;
  }
  revokeWebMapSession(ticket, req.user!);
  res.status(204).end();
});

export default router;
