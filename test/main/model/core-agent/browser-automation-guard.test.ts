import { describe, expect, it } from 'vitest';

import {
  browserAutomationHitWaf,
  browserRuntimeInstallRequiresExplicitRequest,
  isBrowserAutomationCommand,
} from '../../../../src/main/model/core-agent/browser-automation-guard';

describe('browser automation guard', () => {
  it('requires explicit intent before installing browser automation runtimes', () => {
    expect(browserRuntimeInstallRequiresExplicitRequest('npm install playwright')).toBe(true);
    expect(browserRuntimeInstallRequiresExplicitRequest('python -m pip install playwright')).toBe(true);
    expect(browserRuntimeInstallRequiresExplicitRequest('npx playwright install chromium')).toBe(true);
    expect(browserRuntimeInstallRequiresExplicitRequest('playwright install chromium')).toBe(true);
    expect(browserRuntimeInstallRequiresExplicitRequest('python -m playwright install chromium')).toBe(true);
    expect(browserRuntimeInstallRequiresExplicitRequest('npx @puppeteer/browsers install chrome@stable')).toBe(true);
    expect(browserRuntimeInstallRequiresExplicitRequest('npm install')).toBe(false);
    expect(browserRuntimeInstallRequiresExplicitRequest('npm install react')).toBe(false);
  });

  it('classifies challenge pages only for browser automation commands', () => {
    const challenge = '<title>Just a moment...</title><div>Enable JavaScript and cookies to continue</div>';
    expect(isBrowserAutomationCommand('node run-playwright.js')).toBe(true);
    expect(browserAutomationHitWaf('node run-playwright.js', challenge)).toBe(true);
    expect(browserAutomationHitWaf('curl https://example.com', challenge)).toBe(false);
    expect(browserAutomationHitWaf('node run-playwright.js', 'Cloudflare CDN asset loaded')).toBe(false);
  });
});
