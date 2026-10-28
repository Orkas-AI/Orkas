/** Shared policy for OfficeCLI HTML; the screenshot session separately
 * restricts file access to its temporary render root and denies permissions. */
export const OFFICE_RENDER_ASSET_HOSTS: readonly string[] = Object.freeze([
  'd.officecli.ai',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

export function hardenOfficeHtml(source: string, allowRenderAssets = false): string {
  const assets = allowRenderAssets
    ? ` 'self' ${OFFICE_RENDER_ASSET_HOSTS.map(host => `https://${host}`).join(' ')}`
    : '';
  const csp = [
    "default-src 'none'",
    `img-src data: blob:${assets}`,
    `media-src data: blob:${assets}`,
    `font-src data:${assets}`,
    `style-src 'unsafe-inline' data:${assets}`,
    `script-src 'unsafe-inline'${assets}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const withoutBase = source
    .replace(/<base\b[^>]*>/gi, '')
    .replace(
      /\b(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi,
      (_match, attribute: string, quote: string) => `${attribute}=${quote}#${quote}`,
    );
  if (/<head\b[^>]*>/i.test(withoutBase)) {
    return withoutBase.replace(/<head\b[^>]*>/i, head => `${head}\n${meta}`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${withoutBase}</body></html>`;
}
