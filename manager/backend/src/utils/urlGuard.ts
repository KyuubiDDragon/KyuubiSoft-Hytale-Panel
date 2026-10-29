/**
 * Block obviously dangerous outbound URLs and addresses.
 *
 * The webhook engine accepts a user-supplied URL and POSTs to it. Without
 * any validation this is a textbook SSRF: an admin with `webhooks.manage`
 * could point a webhook at http://localhost, the AWS metadata endpoint
 * (169.254.169.254), an internal API, or a file:// URI. Most of these
 * are operator-trusted users, but the panel's threat model treats
 * webhook authors as semi-trusted (you grant a CI bot webhooks.manage
 * via an API key — we shouldn't let that key reach internal services).
 *
 * Addresses fall into three classes (`classifyAddress`):
 *   - metadata: IPv4 link-local (169.254/16, where every cloud serves its
 *     instance metadata) and the other known metadata addresses. Never
 *     reachable, whatever the configuration says.
 *   - private: loopback, RFC1918, IPv6 unique-local and link-local,
 *     multicast and reserved ranges, also as IPv4-mapped IPv6 (`::ffff:…`).
 *   - public: everything else.
 * An IPv6 transition address that carries an IPv4 address (NAT64
 * 64:ff9b::/96, 6to4 2002::/16, Teredo 2001:0::/32) has the class of that
 * IPv4 address: a host with such routing reaches it. Local-use NAT64
 * (64:ff9b:1::/48) is private, the position of its IPv4 address depends on
 * the network.
 *
 * `assertSafeOutboundUrl()` is the check when a URL is saved: only http(s),
 * and a host name or literal address that is not private. The address a name
 * resolves to is checked when the request is made (utils/safeFetch.ts: on
 * every redirect hop, on the address the connection really uses).
 *
 * Operators that need internal webhooks can set ALLOW_INTERNAL_WEBHOOKS=true
 * to allow private addresses (still http/https, never metadata).
 */
import { BlockList, isIP } from 'net';

export type AddressClass = 'metadata' | 'private' | 'public';

const METADATA = new BlockList();
METADATA.addSubnet('169.254.0.0', 16, 'ipv4'); // AWS, GCP, Azure, Oracle, OpenStack, ECS (169.254.170.2)
METADATA.addAddress('100.100.100.200', 'ipv4'); // Alibaba Cloud
METADATA.addAddress('fd00:ec2::254', 'ipv6'); // AWS over IPv6

const PRIVATE = new BlockList();
PRIVATE.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.0.0.0', 24, 'ipv4'); // IETF protocol assignments
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('198.18.0.0', 15, 'ipv4'); // benchmarking
PRIVATE.addSubnet('224.0.0.0', 3, 'ipv4'); // multicast, reserved, broadcast
PRIVATE.addSubnet('::', 96, 'ipv6'); // unspecified, loopback, IPv4-compatible
PRIVATE.addSubnet('64:ff9b:1::', 48, 'ipv6'); // local-use NAT64
PRIVATE.addSubnet('fc00::', 7, 'ipv6'); // unique-local
PRIVATE.addSubnet('fe80::', 10, 'ipv6'); // link-local
PRIVATE.addSubnet('ff00::', 8, 'ipv6'); // multicast

const PRIVATE_HOST_NAMES = [/^localhost$/i, /\.localhost$/i, /\.local$/i];
const METADATA_HOST_NAMES = [/^metadata\.google\.internal$/i, /^metadata\.goog$/i];

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    public reason: string,
  ) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/** The eight 16-bit groups of an IPv6 address; null for one with a zone id. */
function ipv6Groups(address: string): number[] | null {
  if (address.includes('%')) return null;
  let text = address.toLowerCase();
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const groups = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const [head, tail] = text.split('::');
  if (tail === undefined) return groups(head);
  const front = groups(head);
  const back = groups(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/** The IPv4 address an IPv6 transition address carries, or null. */
function embeddedIPv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (!g || g.length !== 8) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  // NAT64 64:ff9b::/96: the last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return v4(g[6], g[7]);
  }
  // 6to4 2002::/16: bits 16 to 47.
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  // Teredo 2001:0::/32: the client's address, inverted, in the last 32 bits.
  if (g[0] === 0x2001 && g[1] === 0) return v4(g[6] ^ 0xffff, g[7] ^ 0xffff);
  return null;
}

/**
 * Class of an IP address; IPv4-mapped IPv6 and the IPv6 transition addresses
 * count as the IPv4 address they carry.
 */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 0) return 'private'; // not an address: fail closed
  const carried = family === 6 ? embeddedIPv4(address) : null;
  if (carried) return classifyAddress(carried);
  const type = family === 6 ? 'ipv6' : 'ipv4';
  try {
    if (METADATA.check(address, type)) return 'metadata';
    if (PRIVATE.check(address, type)) return 'private';
  } catch {
    return 'private'; // e.g. an IPv6 zone id the list cannot parse
  }
  return 'public';
}

/** Is the panel configured to reach private addresses (internal webhooks)? */
export function internalTargetsAllowed(): boolean {
  return (
    process.env.ALLOW_INTERNAL_WEBHOOKS === 'true' || process.env.ALLOW_INTERNAL_WEBHOOKS === '1'
  );
}

/** Throws when `address` may not be reached under the given rule. */
export function assertAllowedAddress(address: string, allowPrivate: boolean, host = address): void {
  const kind = classifyAddress(address);
  if (kind === 'metadata') {
    throw new UnsafeUrlError(`Host ${host} is a cloud metadata address`, 'metadata');
  }
  if (kind === 'private' && !allowPrivate) {
    throw new UnsafeUrlError(
      host === address
        ? `Address ${address} is in a private / loopback range`
        : `Host ${host} resolves to private address ${address}`,
      'private-ip',
    );
  }
}

/**
 * Checks the host part of a URL without DNS: a literal address by its class,
 * a name against the local and metadata names.
 */
export function assertAllowedHost(hostname: string, allowPrivate: boolean): void {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIP(host)) {
    assertAllowedAddress(host, allowPrivate);
    return;
  }
  if (METADATA_HOST_NAMES.some((p) => p.test(host))) {
    throw new UnsafeUrlError(`Host ${host} is a cloud metadata service`, 'metadata');
  }
  if (!allowPrivate && PRIVATE_HOST_NAMES.some((p) => p.test(host))) {
    throw new UnsafeUrlError(
      `Hostname ${host} resolves to a private / loopback range`,
      'private-host',
    );
  }
}

/** Parses `raw` and checks it is an http(s) URL. */
export function parseHttpUrl(raw: string, httpsOnly = false): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Malformed URL', 'malformed');
  }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) {
    throw new UnsafeUrlError(`Disallowed protocol: ${u.protocol}`, 'protocol');
  }
  return u;
}

export function assertSafeOutboundUrl(raw: string): URL {
  const u = parseHttpUrl(raw);
  assertAllowedHost(u.hostname, internalTargetsAllowed());
  return u;
}
