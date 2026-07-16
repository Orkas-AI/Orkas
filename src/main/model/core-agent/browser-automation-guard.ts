const BROWSER_AUTOMATION_RE = /\b(?:playwright|puppeteer(?:-core)?|chromium|chrome|google-chrome)\b/i;

const BROWSER_RUNTIME_INSTALL_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b[^\r\n;&|]*\b(?:playwright|puppeteer(?:-core)?)\b/i,
  /\b(?:npx|pnpm\s+dlx|bunx)\s+(?:playwright|puppeteer)\s+install\b/i,
  /(?:^|[;&|]\s*|\s)(?:[^\s;&|]*[\\/]playwright|playwright)\s+install\b/i,
  /\b(?:npx|pnpm\s+dlx|bunx)\s+@puppeteer\/browsers\s+install\b/i,
  /\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b[^\r\n;&|]*\bplaywright\b/i,
  /\bpython3?\s+-m\s+playwright\s+install\b/i,
];

const WAF_CHALLENGE_RE = /_waf_[a-z0-9]+|cf-browser-verification|__cf_chl|cf_chl_opt|Attention Required!\s*\|\s*Cloudflare|Cloudflare Ray ID|Checking your browser before access|Just a moment\.\.\.|Enable JavaScript and cookies to continue|Verify (?:you are|you're)(?: a)? human|complete the security check|you don'?t have permission to access|人机(?:身份)?验证|安全验证|访问验证|滑动验证|请完成验证|反爬/i;

export function isBrowserAutomationCommand(command: string): boolean {
  return BROWSER_AUTOMATION_RE.test(String(command || ''));
}

export function browserRuntimeInstallRequiresExplicitRequest(command: string): boolean {
  const raw = String(command || '');
  return BROWSER_RUNTIME_INSTALL_PATTERNS.some((pattern) => pattern.test(raw));
}

export function browserAutomationHitWaf(command: string, output: string): boolean {
  return isBrowserAutomationCommand(command) && WAF_CHALLENGE_RE.test(String(output || '').slice(0, 256 * 1024));
}
