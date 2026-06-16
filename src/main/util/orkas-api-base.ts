export function normalizeOrkasApiBase(raw: string): string {
  const trimmed = String(raw || '').replace(/\/+$/, '');
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      url.hostname = 'localhost';
    } else if (host.indexOf('www.') === 0 && (host.slice(4) === 'orkas.ai' || host.slice(4) === 'orkas.work')) {
      url.hostname = host.slice(4);
    }
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}
