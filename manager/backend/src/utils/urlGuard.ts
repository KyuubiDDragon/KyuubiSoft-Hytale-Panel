/**
 * Block obviously dangerous outbound URLs.
 *
 * The webhook engine accepts a user-supplied URL and POSTs to it. Without
 * any validation this is a textbook SSRF: an admin with `webhooks.manage`
 * could point a webhook at http://localhost, the AWS metadata endpoint
 * (169.254.169.254), an internal API, or a file:// URI. Most of these
 * are operator-trusted users, but the panel's threat model treats
 * webhook authors as semi-trusted (you grant a CI bot webhooks.manage
 * via an API key — we shouldn't let that key reach internal services).
 *
 * `assertSafeOutboundUrl()` throws on:
 *   - non-http(s) schemes
 *   - hostnames that resolve syntactically to loopback / link-local /
 *     RFC1918 private ranges (the hostname is checked directly; we
 *     deliberately don't DNS-resolve here because DNS-rebinding makes
 *     that unsound — fetch's connect time is the only honest check,
 *     and we add network-level safeguards via Docker networks)
 *   - the AWS / GCP / Azure metadata service hostnames
 *
 * Operators that need internal webhooks can set ALLOW_INTERNAL_WEBHOOKS=true
 * to bypass the host check (still requires http/https).
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127(?:\.\d{1,3}){3}$/,        // 127.0.0.0/8
  /^10(?:\.\d{1,3}){3}$/,         // 10.0.0.0/8
  /^192\.168(?:\.\d{1,3}){2}$/,   // 192.168.0.0/16
  /^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/, // 172.16.0.0/12
  /^169\.254(?:\.\d{1,3}){2}$/,   // link-local incl. 169.254.169.254
  /^0(?:\.\d{1,3}){3}$/,          // 0.0.0.0/8
  /^::1$/,                        // IPv6 loopback
  /^fe80:/i,                      // IPv6 link-local
  /^fc00:/i, /^fd00:/i,           // IPv6 unique-local
  /\.local$/i,                    // .local mDNS
  /metadata\.google\.internal$/i,
];

import { lookup } from 'dns';
import { promisify } from 'util';

const dnsLookup = promisify(lookup);

export class UnsafeUrlError extends Error {
  constructor(message: string, public reason: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export function assertSafeOutboundUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Malformed URL', 'malformed');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new UnsafeUrlError(`Disallowed protocol: ${u.protocol}`, 'protocol');
  }
  if (process.env.ALLOW_INTERNAL_WEBHOOKS === 'true' || process.env.ALLOW_INTERNAL_WEBHOOKS === '1') {
    return u;
  }
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some(p => p.test(host))) {
    throw new UnsafeUrlError(`Hostname ${host} resolves to a private / loopback range`, 'private-host');
  }
  return u;
}

/**
 * Stronger guard for the moment of delivery: resolve the hostname and reject if
 * ANY resolved address is loopback / link-local / RFC1918. The syntactic check
 * in {@link assertSafeOutboundUrl} only sees the hostname, so a name that was
 * public at create-time but later resolves to 169.254.169.254 / 127.0.0.1
 * (DNS rebinding) would slip through. Call this immediately before `fetch`.
 *
 * Not perfectly TOCTOU-proof (the kernel re-resolves on connect), but it closes
 * the common rebinding case without a custom connect agent. Honors
 * ALLOW_INTERNAL_WEBHOOKS for operators that intentionally target internal hosts.
 */
export async function assertSafeResolvedUrl(raw: string): Promise<URL> {
  const u = assertSafeOutboundUrl(raw);
  if (process.env.ALLOW_INTERNAL_WEBHOOKS === 'true' || process.env.ALLOW_INTERNAL_WEBHOOKS === '1') {
    return u;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(u.hostname, { all: true });
  } catch {
    throw new UnsafeUrlError(`Cannot resolve host ${u.hostname}`, 'dns-failure');
  }
  for (const { address } of addresses) {
    if (PRIVATE_HOST_PATTERNS.some(p => p.test(address))) {
      throw new UnsafeUrlError(`Host ${u.hostname} resolves to private address ${address}`, 'private-ip');
    }
  }
  return u;
}
