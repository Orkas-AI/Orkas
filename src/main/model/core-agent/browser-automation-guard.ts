const BROWSER_RUNTIME_INSTALL_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b[^\r\n;&|]*\b(?:playwright|puppeteer(?:-core)?)\b/i,
  /\b(?:npx|pnpm\s+dlx|bunx)\s+(?:playwright|puppeteer)\s+install\b/i,
  /(?:^|[;&|]\s*|\s)(?:[^\s;&|]*[\\/]playwright|playwright)\s+install\b/i,
  /\b(?:npx|pnpm\s+dlx|bunx)\s+@puppeteer\/browsers\s+install\b/i,
  /\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b[^\r\n;&|]*\bplaywright\b/i,
  /\bpython3?\s+-m\s+playwright\s+install\b/i,
];

export function browserRuntimeInstallRequiresExplicitRequest(command: string): boolean {
  const raw = String(command || '');
  return BROWSER_RUNTIME_INSTALL_PATTERNS.some((pattern) => pattern.test(raw));
}
