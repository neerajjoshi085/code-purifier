/**
 * Network guard for the site fetcher: decides which addresses a user-supplied URL may
 * reach. A fetch endpoint that accepts arbitrary URLs is an SSRF primitive, so anything
 * that is not a public internet address is refused — including addresses that only
 * *resolve* to private ranges (checked at connect time, see `pinnedLookup`).
 */
import dns from 'node:dns';
import net from 'node:net';

export class SiteError extends Error {
  /** @param {string} code short machine-readable reason  @param {string} message shown to the user */
  constructor(code, message) {
    super(message);
    this.name = 'SiteError';
    this.code = code;
  }
}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible range
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['64:ff9b::', 96], // NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

/** Expands an IPv6 literal into eight 16-bit groups (handles `::` and a dotted IPv4 tail). */
function ipv6Groups(address) {
  let text = address.split('%')[0].toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(Math.max(0, fill)).fill('0'), ...right].map((g) => parseInt(g, 16));
}

/** True when `address` is anything but a public, globally routable IP. Unparseable input counts as blocked. */
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  const g = ipv6Groups(address);
  if (g.length !== 8 || g.some(Number.isNaN)) return true;
  // IPv4-mapped (::ffff:a.b.c.d): judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return blocked.check(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`, 'ipv4');
  }
  return blocked.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

const PRIVATE_MESSAGE = 'That address points to a private or internal network, so it can’t be fetched.';

/** Validates a URL before any request is made (scheme, credentials, IP-literal hosts). */
export function assertUrlAllowed(url, allowPrivate) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SiteError('bad-url', 'Only http:// and https:// addresses can be fetched.');
  if (url.username || url.password) throw new SiteError('bad-url', 'Addresses with a username or password are not supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SiteError('bad-url', 'That address has no host name.');
  if (net.isIP(host) && !allowPrivate && isBlockedAddress(host)) throw new SiteError('blocked', PRIVATE_MESSAGE);
}

/**
 * A `dns.lookup` replacement for http(s).request. The address that was validated is the
 * address that gets connected to, which defeats DNS-rebinding tricks. If ANY record is
 * private the host is refused, so a mixed public/private answer cannot slip through.
 */
export function pinnedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) return callback(new SiteError('blocked', PRIVATE_MESSAGE));
      if (options && options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
