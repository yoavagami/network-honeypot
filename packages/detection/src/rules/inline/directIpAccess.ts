/**
 * Detects a request addressed directly by IP (the HTTP `Host` header is a raw IPv4/IPv6
 * address) rather than by a real hostname. A weak but real signal: mass scanners sweep IP
 * ranges and have no reason to know your domain, while an organic or targeted visitor almost
 * always arrives via DNS. Never alone treated as proof — see docs/DETECTION.md §2, §4, same
 * spirit as matchesScannerUa.
 */

function stripPort(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    // Bracketed IPv6, optionally with a port: "[::1]" or "[::1]:8080".
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(1, end);
  }
  const colonCount = (hostHeader.match(/:/g) || []).length;
  // Exactly one colon is unambiguous — "1.2.3.4:8080" or "example.com:8080". Zero colons (no
  // port) or 2+ colons (unbracketed IPv6, no port) are used as-is.
  if (colonCount === 1) return hostHeader.slice(0, hostHeader.indexOf(":"));
  return hostHeader;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

export function matchesDirectIpAccess(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const host = stripPort(hostHeader.trim());

  const ipv4Match = host.match(IPV4_RE);
  if (ipv4Match) return ipv4Match.slice(1).every((octet) => Number(octet) <= 255);

  return host.includes(":") && IPV6_RE.test(host);
}
