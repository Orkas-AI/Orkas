import { isIP } from 'node:net';

/** Screen IP literals at public-only entry points. Callers own hostname and URL rules. */
export function isRestrictedNetworkAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [first, second] = address.split('.').map(Number);
    return isRestrictedIpv4(first, second);
  }
  if (version !== 6) return false;

  const words = parseIpv6Words(address);
  if (!words) return true;
  const [w0, w1, w2, w3, w4, w5, w6] = words;
  if ((w0 & 0xfe00) === 0xfc00 || (w0 & 0xffc0) === 0xfe80 || (w0 & 0xff00) === 0xff00) return true;

  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0
    && ((w4 === 0 && (w5 === 0 || w5 === 0xffff)) || (w4 === 0xffff && w5 === 0))) {
    // IPv4-compatible, mapped and translated forms. :: and ::1 also fail the IPv4 check.
    return isRestrictedIpv4Word(w6);
  }
  if (w0 === 0x0064 && w1 === 0xff9b) {
    // RFC 8215 reserves this /48 for local use and leaves the IPv4 layout to the deployment.
    if (w2 === 1) return true;
    if (w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) return isRestrictedIpv4Word(w6);
  }
  // Screen the 6to4 router and Teredo mapped client IPv4 addresses.
  if (w0 === 0x2002) return isRestrictedIpv4Word(w1);
  if (w0 === 0x2001 && w1 === 0) return isRestrictedIpv4Word(w6 ^ 0xffff);
  return false;
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address;
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon >= 0 && normalized.includes('.', lastColon)) {
    const ipv4Part = normalized.slice(lastColon + 1);
    if (isIP(ipv4Part) !== 4) return null;
    const [a, b, c, d] = ipv4Part.split('.').map(Number);
    normalized = `${normalized.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!words.every(word => /^[0-9a-f]{1,4}$/i.test(word))) return null;
  return words.map(word => Number.parseInt(word, 16));
}

function isRestrictedIpv4Word(word: number): boolean {
  return isRestrictedIpv4(word >>> 8, word & 255);
}

function isRestrictedIpv4(first: number, second: number): boolean {
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}
