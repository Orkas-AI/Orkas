import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function memoryContext() {
  const context = vm.createContext({
    console, Date, Map, Set, TextDecoder, Uint8Array,
    createLogger: () => ({
      info() { throw new Error('logger unavailable'); },
      warn() { throw new Error('logger unavailable'); },
    }),
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById() { return null; }, querySelector() { return null; },
    },
    window: { addEventListener() {}, orkas: { invoke: async () => ({ ok: true }) } },
    setTimeout, clearTimeout,
    t: (key: string) => key,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/memory.js'), 'utf8'), context);
  return context;
}

describe('public memory failure boundaries', () => {
  it('normalizes unknown targets and classifies raw failures with stable codes', () => {
    const context = memoryContext();
    expect(vm.runInContext("_memTarget('private-value')", context)).toBe('shared');
    expect(vm.runInContext("_memTarget('user')", context)).toBe('user');
    expect(vm.runInContext("_memFailureDetails({ error: 'blocked: /private/user text' }).error_code", context))
      .toBe('memory_content_blocked');
    expect(vm.runInContext("_memFailureDetails({ error: '/private/user/path' }).error_code", context))
      .toBe('memory_operation_failed');
  });

  it('does not let a diagnostic logger failure interrupt the caller', () => {
    const context = memoryContext();
    expect(() => vm.runInContext("_memLogSafe('warn', 'synthetic warning', {})", context)).not.toThrow();
  });
});
