import { describe, expect, it } from 'vitest';

import {
  browserRuntimeInstallRequiresExplicitRequest,
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

});
