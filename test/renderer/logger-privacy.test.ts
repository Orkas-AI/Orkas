import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const loggerSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/logger.js'),
  'utf8',
);

describe('renderer logger privacy boundary', () => {
  it('sanitizes messages and structured data before forwarding either log stream', () => {
    const forwarded = vi.fn();
    const consoleCalls: unknown[][] = [];
    const sandbox: any = {
      Error,
      WeakSet,
      Object,
      String,
      Array,
      console: {
        error: (...args: unknown[]) => consoleCalls.push(args),
        warn: (...args: unknown[]) => consoleCalls.push(args),
        info: (...args: unknown[]) => consoleCalls.push(args),
        debug: (...args: unknown[]) => consoleCalls.push(args),
        log: (...args: unknown[]) => consoleCalls.push(args),
      },
      window: {
        orkas: { log: forwarded },
        addEventListener: vi.fn(),
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(loggerSource, sandbox, { filename: 'logger.js' });
    vm.runInContext("testLogger = createLogger('privacy')", sandbox);

    sandbox.testLogger.error(
      'failed /Users/test/Private Project/customer-plan.md',
      {
        filename: 'customer-plan.md',
        path: '/Users/test/Private Project/customer-plan.md',
        nested: {
          detail: 'file:///Users/test/Private%20Project/customer-plan.md',
          cloudRef: 'cloud/contexts/private/customer-plan.md',
        },
      },
      new Error('C:\\Users\\test\\Private Project\\customer-plan.md'),
    );

    expect(forwarded).toHaveBeenCalledOnce();
    const output = JSON.stringify([forwarded.mock.calls, consoleCalls]);
    expect(output).not.toContain('/Users/test');
    expect(output).not.toContain('C:\\\\Users\\\\test');
    expect(output).not.toContain('customer-plan.md');
    expect(output).not.toContain('Private Project');
    expect(output).toContain('***REDACTED_PATH***');
    expect(output).toContain('<local_path>');
  });
});
