/**
 * Plausibility check for TRUST_PROXY (network.trustProxy in config.json),
 * from the requests the panel actually gets:
 *  - trusted, but a request arrives straight from a client (no
 *    X-Forwarded-For, or the hop in front is a public address): such a client
 *    sets X-Forwarded-For itself and picks the address the login limit and
 *    the audit log see;
 *  - not trusted, but requests come from a host or private address with
 *    X-Forwarded-For: a proxy is in front, and every client shares its
 *    address, and with it one login limit.
 * Each case is logged once; requests are never changed or refused.
 */
import { BlockList, isIPv4, isIPv6 } from 'net';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../utils/logger.js';

export type ProxyMismatch = 'trusted-without-proxy' | 'proxy-not-trusted';

// Loopback and private ranges: where a reverse proxy of the panel sits (same
// host, Docker network, LAN).
const LOCAL = new BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
const NEAR = new BlockList();
NEAR.addSubnet('127.0.0.0', 8, 'ipv4');
NEAR.addSubnet('10.0.0.0', 8, 'ipv4');
NEAR.addSubnet('172.16.0.0', 12, 'ipv4');
NEAR.addSubnet('192.168.0.0', 16, 'ipv4');
NEAR.addSubnet('100.64.0.0', 10, 'ipv4');
NEAR.addSubnet('169.254.0.0', 16, 'ipv4');
NEAR.addSubnet('fc00::', 7, 'ipv6');
NEAR.addSubnet('fe80::', 10, 'ipv6');

/** The address without an IPv4-mapped IPv6 prefix (::ffff:10.0.0.1 → 10.0.0.1). */
function plain(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function inList(list: BlockList, address: string): boolean {
  if (isIPv4(address)) return list.check(address, 'ipv4');
  if (isIPv6(address)) return list.check(address, 'ipv6');
  return false;
}

const isLoopback = (address: string) => address === '::1' || inList(LOCAL, address);
const isNear = (address: string) => address === '::1' || inList(NEAR, address);

/**
 * What does not fit TRUST_PROXY in one request: `peer` is the address the
 * connection comes from, `forwardedFor` its X-Forwarded-For header.
 */
export function proxyMismatch(
  trustProxy: boolean,
  peer: string | undefined,
  forwardedFor: string | undefined,
): ProxyMismatch | null {
  if (!peer) return null;
  const from = plain(peer);
  const hasHeader = typeof forwardedFor === 'string' && forwardedFor.trim() !== '';
  if (trustProxy) {
    // Local requests without the header are the container's own health checks.
    if (!hasHeader) return isLoopback(from) ? null : 'trusted-without-proxy';
    return isNear(from) ? null : 'trusted-without-proxy';
  }
  return hasHeader && isNear(from) ? 'proxy-not-trusted' : null;
}

const MESSAGES: Record<ProxyMismatch, string> = {
  'trusted-without-proxy':
    '[Proxy] TRUST_PROXY is on, but a request reached the panel without passing a reverse proxy ' +
    '(from {peer}). Such clients can set X-Forwarded-For themselves and choose the address the ' +
    'login limit and the audit log use. Turn TRUST_PROXY off unless the panel is only reachable ' +
    'through the proxy.',
  'proxy-not-trusted':
    '[Proxy] Requests arrive through a reverse proxy ({peer} sends X-Forwarded-For), but ' +
    'TRUST_PROXY is off: every user shares the address of the proxy, and with it one login limit ' +
    '(5 failed attempts per 15 minutes for everyone), and the audit log shows the proxy. Set ' +
    'TRUST_PROXY=true when the panel is only reachable through the proxy.',
};

export function createProxyCheck(
  trustProxy: boolean,
  warn: (message: string) => void = (message) => logger.warn(message),
): RequestHandler {
  const reported = new Set<ProxyMismatch>();
  return (req: Request, _res: Response, next: NextFunction) => {
    if (reported.size < 2) {
      const header = req.headers['x-forwarded-for'];
      const mismatch = proxyMismatch(
        trustProxy,
        req.socket?.remoteAddress,
        Array.isArray(header) ? header.join(',') : header,
      );
      if (mismatch && !reported.has(mismatch)) {
        reported.add(mismatch);
        warn(MESSAGES[mismatch].replace('{peer}', plain(req.socket.remoteAddress ?? '')));
      }
    }
    next();
  };
}
