import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/user-error.js'), 'utf8');

function loadUserError() {
  const context: any = {
    window: {},
    t: (key: string) => ({
      'marketplace.action_failed_retry_later': 'Marketplace is temporarily unavailable. Please try again later.',
    } as Record<string, string>)[key] || key,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'user-error.js' });
  return context;
}

describe('renderer user-error mapping', () => {
  it('maps technical errors through action-specific fallback copy', () => {
    const ctx = loadUserError();
    expect(ctx.window.USER_ERROR_CODE.NETWORK_TIMEOUT).toBe('E_NETWORK_TIMEOUT');

    expect(ctx.userErrorMessage({
      code: ctx.window.USER_ERROR_CODE.NETWORK_TIMEOUT,
      error: 'marketplace:/marketplace/projects/list timed out after 60s',
    }, { fallbackKey: 'marketplace.action_failed_retry_later' })).toBe(
      'Marketplace is temporarily unavailable. Please try again later.',
    );

    expect(ctx.userErrorMessage({
      code: ctx.window.USER_ERROR_CODE.AUTH_REQUIRED,
      error: 'not logged in',
    }, { fallbackKey: 'marketplace.action_failed_retry_later' })).toBe(
      'Marketplace is temporarily unavailable. Please try again later.',
    );

    expect(ctx.userErrorMessage({
      code: 50001,
      error: 'login required',
    }, { fallbackKey: 'marketplace.action_failed_retry_later' })).toBe(
      'Marketplace is temporarily unavailable. Please try again later.',
    );

    expect(ctx.userErrorMessage({ error: 'invalid category' }, {
      fallbackKey: 'marketplace.action_failed_retry_later',
    })).toBe('invalid category');
  });
});
