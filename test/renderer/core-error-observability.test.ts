import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const modulesDir = resolve(__dirname, '../../src/renderer/modules');

describe('open-source core error observability boundary', () => {
  it('keeps resolved IPC failures on the durable local log boundary', () => {
    const ipcSource = readFileSync(resolve(__dirname, '../../src/main/ipc/index.ts'), 'utf8');
    expect(ipcSource).toContain('logInvokeResultFailure(channel, result)');
    expect(ipcSource).toMatch(/result\.ok === false[\s\S]*logInvokeResultFailure\(channel, result\)/);
  });

  it('does not ship internal renderer telemetry error reporters', () => {
    for (const name of ['search.js', 'agents.js', 'skills.js', 'marketplace.js']) {
      const source = readFileSync(resolve(modulesDir, name), 'utf8');
      expect(source).not.toContain(['Monitor', 'error('].join('.'));
    }
  });
});
